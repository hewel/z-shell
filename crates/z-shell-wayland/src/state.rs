use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{Value, json};
use wayland_client::protocol::{wl_callback, wl_output::WlOutput, wl_registry, wl_seat::WlSeat};
use wayland_client::{Connection, Dispatch, Proxy, QueueHandle};
use wayland_protocols::ext::workspace::v1::client::ext_workspace_manager_v1::ExtWorkspaceManagerV1;
use wayland_protocols::xdg::xdg_output::zv1::client::zxdg_output_manager_v1::ZxdgOutputManagerV1;
use wayland_protocols_wlr::foreign_toplevel::v1::client::zwlr_foreign_toplevel_manager_v1::ZwlrForeignToplevelManagerV1;
use wayland_protocols_wlr::output_power_management::v1::client::zwlr_output_power_manager_v1::ZwlrOutputPowerManagerV1;
use z_shell_bus::{BusHub, UpdateKind};
use z_shell_protocol::{MAX_SAFE_JS_INT, TopicName};

use crate::CapabilityState;
use crate::outputs::Outputs;
use crate::windows::Windows;
use crate::workspaces::Workspaces;

pub(crate) fn next_id() -> u64 {
    // A new connection in the same daemon must not reuse an old bus ID.
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    assert!(id <= MAX_SAFE_JS_INT, "exhausted Wayland instance IDs");
    id
}

pub(crate) fn decode_array(bytes: &[u8]) -> impl Iterator<Item = u32> + '_ {
    bytes
        .as_chunks::<4>()
        .0
        .iter()
        .copied()
        .map(u32::from_ne_bytes)
}

// For protocols with a done event, stage fields until the corresponding transaction commits.
pub(crate) struct Pending<T> {
    pub(crate) current: Option<T>,
    next: Option<T>,
}

impl<T> Default for Pending<T> {
    fn default() -> Self {
        Self {
            current: None,
            next: None,
        }
    }
}

impl<T: Clone + Default + PartialEq> Pending<T> {
    pub(crate) fn edit(&mut self) -> &mut T {
        self.next
            .get_or_insert_with(|| self.current.clone().unwrap_or_default())
    }

    pub(crate) fn commit(&mut self) -> bool {
        if let Some(next) = self
            .next
            .take()
            .filter(|next| Some(next) != self.current.as_ref())
        {
            self.current = Some(next);
            true
        } else {
            false
        }
    }

    pub(crate) fn scrub(&mut self, remove: impl Fn(&mut T) -> bool) -> bool {
        if let Some(next) = &mut self.next {
            remove(next);
        }
        self.current.as_mut().is_some_and(remove)
    }
}

#[derive(Clone, Copy)]
pub(crate) enum Topic {
    Outputs,
    Workspaces,
    Windows,
    Power,
}

impl Topic {
    const ALL: [Self; 4] = [Self::Outputs, Self::Workspaces, Self::Windows, Self::Power];

    fn name(self) -> &'static str {
        match self {
            Self::Outputs => "wayland.outputs",
            Self::Workspaces => "wayland.workspaces",
            Self::Windows => "wayland.windows",
            Self::Power => "wayland.display_power",
        }
    }

    fn publish(self, hub: &BusHub, kind: UpdateKind, data: Value) {
        let topic = TopicName::try_new(self.name()).expect("static Wayland topic name is valid");
        hub.publish_core_topic(topic, data, kind);
    }

    fn flag(self) -> u8 {
        1 << self as u8
    }
}

pub(crate) fn topic_data<const N: usize>(
    capability: CapabilityState,
    fields: [(&str, Value); N],
) -> Value {
    let mut data = serde_json::Map::new();
    data.insert("capability".into(), json!(capability));
    data.extend(fields.into_iter().map(|(key, value)| (key.into(), value)));
    Value::Object(data)
}

pub(crate) fn publish_disconnected(hub: &BusHub, kind: UpdateKind) {
    for topic in Topic::ALL {
        let empty = Value::Array(Vec::new());
        let data = match topic {
            Topic::Outputs | Topic::Power => {
                topic_data(CapabilityState::Disconnected, [("outputs", empty)])
            }
            Topic::Workspaces => topic_data(
                CapabilityState::Disconnected,
                [("groups", Value::Array(Vec::new())), ("workspaces", empty)],
            ),
            Topic::Windows => topic_data(CapabilityState::Disconnected, [("windows", empty)]),
        };
        topic.publish(hub, kind, data);
    }
}

#[derive(Default)]
pub(crate) struct State {
    pub(crate) outputs: Outputs,
    pub(crate) workspaces: Workspaces,
    pub(crate) windows: Windows,
    // Output bindings must precede manager bindings so the compositor can send
    // the initial workspace and window associations regardless of registry order.
    initial_managers: Option<Vec<(u32, u32, Manager)>>,
    pub(crate) settled: bool,
    pub(crate) published: bool,
    dirty: u8,
}

#[derive(Clone, Copy)]
enum Manager {
    XdgOutput,
    Power,
    Workspace,
    Toplevel,
}

impl State {
    pub(crate) fn new() -> Self {
        Self {
            initial_managers: Some(Vec::new()),
            ..Self::default()
        }
    }

    pub(crate) fn mark(&mut self, topic: Topic) {
        self.dirty |= topic.flag();
    }

    pub(crate) fn publish(&mut self, hub: &BusHub) {
        if !self.settled {
            return;
        }
        let kind = if self.published {
            UpdateKind::Live
        } else {
            UpdateKind::SourceBaseline
        };
        for topic in Topic::ALL {
            if self.published && self.dirty & topic.flag() == 0 {
                continue;
            }
            let data = match topic {
                Topic::Outputs => self.outputs.data(),
                Topic::Workspaces => self.workspaces.data(),
                Topic::Windows => self.windows.data(),
                Topic::Power => self.outputs.power_data(),
            };
            topic.publish(hub, kind, data);
        }
        self.published = true;
        self.dirty = 0;
    }

    fn bind_manager(
        &mut self,
        registry: &wl_registry::WlRegistry,
        global: u32,
        version: u32,
        manager: Manager,
        qh: &QueueHandle<Self>,
    ) {
        match manager {
            Manager::XdgOutput => self.outputs.bind_xdg(registry, global, version, qh),
            Manager::Power => {
                if self.outputs.bind_power(registry, global, qh) {
                    self.mark(Topic::Power);
                }
            }
            Manager::Workspace => {
                if self.workspaces.bind(registry, global, qh) {
                    self.mark(Topic::Workspaces);
                }
            }
            Manager::Toplevel => {
                if self.windows.bind(registry, global, version, qh) {
                    self.mark(Topic::Windows);
                }
            }
        }
    }
}

impl Dispatch<wl_registry::WlRegistry, ()> for State {
    fn event(
        state: &mut Self,
        registry: &wl_registry::WlRegistry,
        event: wl_registry::Event,
        _: &(),
        _: &Connection,
        qh: &QueueHandle<Self>,
    ) {
        match event {
            wl_registry::Event::Global {
                name,
                interface,
                version,
            } => {
                let manager = if interface == WlOutput::interface().name {
                    state.outputs.bind(registry, name, version, qh);
                    return;
                } else if interface == WlSeat::interface().name {
                    state.windows.bind_seat(registry, name, version, qh);
                    return;
                } else if interface == ZxdgOutputManagerV1::interface().name {
                    Manager::XdgOutput
                } else if interface == ZwlrOutputPowerManagerV1::interface().name {
                    Manager::Power
                } else if interface == ExtWorkspaceManagerV1::interface().name {
                    Manager::Workspace
                } else if interface == ZwlrForeignToplevelManagerV1::interface().name {
                    Manager::Toplevel
                } else {
                    return;
                };
                if let Some(initial) = &mut state.initial_managers {
                    initial.push((name, version, manager));
                } else {
                    state.bind_manager(registry, name, version, manager, qh);
                }
            }
            wl_registry::Event::GlobalRemove { name } => {
                if let Some(initial) = &mut state.initial_managers {
                    initial.retain(|(global, _, _)| *global != name);
                }
                if let Some(id) = state.outputs.remove(name) {
                    state.mark(Topic::Outputs);
                    state.mark(Topic::Power);
                    if state.workspaces.remove_output(id) {
                        state.mark(Topic::Workspaces);
                    }
                    if state.windows.remove_output(id) {
                        state.mark(Topic::Windows);
                    }
                }
                let (output_changed, output_added) = state.outputs.remove_xdg(name);
                if output_changed {
                    state.mark(Topic::Outputs);
                }
                if output_added || state.outputs.remove_power(name) {
                    state.mark(Topic::Power);
                }
                if state.workspaces.remove(name) {
                    state.mark(Topic::Workspaces);
                }
                if state.windows.remove(name) {
                    state.mark(Topic::Windows);
                }
            }
            _ => {}
        }
    }
}

pub(crate) enum Barrier {
    Registry(wl_registry::WlRegistry),
    InitialState,
}

impl Dispatch<wl_callback::WlCallback, Barrier> for State {
    fn event(
        state: &mut Self,
        _: &wl_callback::WlCallback,
        _: wl_callback::Event,
        barrier: &Barrier,
        conn: &Connection,
        qh: &QueueHandle<Self>,
    ) {
        match barrier {
            Barrier::Registry(registry) => {
                for (global, version, manager) in state.initial_managers.take().unwrap_or_default()
                {
                    state.bind_manager(registry, global, version, manager, qh);
                }
                conn.display().sync(qh, Barrier::InitialState);
            }
            Barrier::InitialState => state.settled = true,
        }
    }
}
