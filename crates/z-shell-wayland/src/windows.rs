use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;
use serde_json::{Value, json};
use wayland_client::protocol::{wl_registry::WlRegistry, wl_seat::WlSeat};
use wayland_client::{
    Connection, Dispatch, Proxy, QueueHandle, delegate_noop, event_created_child,
};
use wayland_protocols_wlr::foreign_toplevel::v1::client::{
    zwlr_foreign_toplevel_handle_v1 as window, zwlr_foreign_toplevel_manager_v1 as manager,
};
use z_shell_protocol::{ErrorCode, RpcError};

use crate::CapabilityState;
use crate::state::{Pending, State, Topic, decode_array, next_id, topic_data};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
struct Flags {
    activated: bool,
    minimized: bool,
    maximized: bool,
    fullscreen: bool,
}

impl Flags {
    fn decode(bytes: &[u8]) -> Self {
        let mut flags = Self::default();
        for state in decode_array(bytes).filter_map(|state| window::State::try_from(state).ok()) {
            match state {
                window::State::Activated => flags.activated = true,
                window::State::Minimized => flags.minimized = true,
                window::State::Maximized => flags.maximized = true,
                window::State::Fullscreen => flags.fullscreen = true,
                _ => {}
            }
        }
        flags
    }
}

#[derive(Clone, Default, PartialEq, Eq)]
struct WindowData {
    title: Option<String>,
    app_id: Option<String>,
    flags: Flags,
    outputs: BTreeSet<u64>,
}

impl WindowData {
    fn data(&self, id: u64) -> Value {
        json!({
            "window_id": id,
            "title": self.title,
            "app_id": self.app_id,
            "activated": self.flags.activated,
            "minimized": self.flags.minimized,
            "maximized": self.flags.maximized,
            "fullscreen": self.flags.fullscreen,
            "output_instance_ids": self.outputs,
        })
    }
}

struct Window {
    proxy: window::ZwlrForeignToplevelHandleV1,
    data: Pending<WindowData>,
}

#[derive(Default)]
pub(crate) struct Windows {
    manager: Option<(u32, manager::ZwlrForeignToplevelManagerV1)>,
    items: BTreeMap<u64, Window>,
    seats: BTreeMap<u32, WlSeat>,
}

impl Windows {
    pub(crate) fn bind(
        &mut self,
        registry: &WlRegistry,
        global: u32,
        version: u32,
        qh: &QueueHandle<State>,
    ) -> bool {
        if self.manager.is_some() {
            return false;
        }
        self.manager = Some((global, registry.bind(global, version.min(3), qh, ())));
        true
    }

    pub(crate) fn bind_seat(
        &mut self,
        registry: &WlRegistry,
        global: u32,
        version: u32,
        qh: &QueueHandle<State>,
    ) {
        self.seats
            .insert(global, registry.bind(global, version.min(5), qh, ()));
    }

    pub(crate) fn remove(&mut self, global: u32) -> bool {
        if let Some(seat) = self.seats.remove(&global)
            && seat.version() >= 5
        {
            seat.release();
        }
        let Some((_, manager)) = self.manager.take_if(|(name, _)| *name == global) else {
            return false;
        };
        manager.stop();
        self.clear();
        true
    }

    fn clear(&mut self) {
        for window in std::mem::take(&mut self.items).into_values() {
            window.proxy.destroy();
        }
    }

    pub(crate) fn remove_output(&mut self, id: u64) -> bool {
        let mut changed = false;
        for window in self.items.values_mut() {
            changed |= window.data.scrub(|data| data.outputs.remove(&id));
        }
        changed
    }

    pub(crate) fn data(&self) -> Value {
        let capability = if self.manager.is_some() {
            // Close remains available even if no seat can be used to activate.
            CapabilityState::Controllable
        } else {
            CapabilityState::Unsupported
        };
        let windows = self
            .items
            .iter()
            .filter_map(|(&id, window)| window.data.current.as_ref().map(|data| data.data(id)));
        topic_data(capability, [("windows", Value::Array(windows.collect()))])
    }

    fn handle(&self, id: u64) -> Result<&window::ZwlrForeignToplevelHandleV1, RpcError> {
        if self.manager.is_none() {
            return Err(RpcError::new(
                ErrorCode::Disabled,
                "wayland windows are unsupported",
            ));
        }
        self.items
            .get(&id)
            .filter(|window| window.data.current.is_some())
            .map(|window| &window.proxy)
            .ok_or_else(|| RpcError::new(ErrorCode::NotFound, format!("window_gone: {id}")))
    }

    pub(crate) fn activate(&self, id: u64) -> Result<(), RpcError> {
        let window = self.handle(id)?;
        let seat = self.seats.values().next().ok_or_else(|| {
            RpcError::new(
                ErrorCode::Disabled,
                "window activation requires a bound Wayland seat",
            )
        })?;
        window.activate(seat);
        Ok(())
    }

    pub(crate) fn close(&self, id: u64) -> Result<(), RpcError> {
        self.handle(id)?.close();
        Ok(())
    }
}

impl Dispatch<manager::ZwlrForeignToplevelManagerV1, ()> for State {
    event_created_child!(State, manager::ZwlrForeignToplevelManagerV1, [
        manager::EVT_TOPLEVEL_OPCODE => (window::ZwlrForeignToplevelHandleV1, next_id()),
    ]);

    fn event(
        state: &mut Self,
        proxy: &manager::ZwlrForeignToplevelManagerV1,
        event: manager::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        let windows = &mut state.windows;
        let current = windows
            .manager
            .as_ref()
            .is_some_and(|(_, manager)| manager == proxy);
        match event {
            manager::Event::Toplevel { toplevel } => {
                if let Some(&id) = toplevel.data::<u64>().filter(|_| current) {
                    let mut data = Pending::default();
                    data.edit();
                    windows.items.insert(
                        id,
                        Window {
                            proxy: toplevel,
                            data,
                        },
                    );
                } else {
                    toplevel.destroy();
                }
            }
            manager::Event::Finished if current => {
                windows.manager = None;
                windows.clear();
                state.mark(Topic::Windows);
            }
            _ => {}
        }
    }
}

impl Dispatch<window::ZwlrForeignToplevelHandleV1, u64> for State {
    fn event(
        state: &mut Self,
        proxy: &window::ZwlrForeignToplevelHandleV1,
        event: window::Event,
        id: &u64,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        let Some(window) = state.windows.items.get_mut(id) else {
            return;
        };
        match event {
            window::Event::Title { title } => window.data.edit().title = Some(title),
            window::Event::AppId { app_id } => window.data.edit().app_id = Some(app_id),
            window::Event::State { state } => window.data.edit().flags = Flags::decode(&state),
            window::Event::OutputEnter { output } => {
                if let Some(output) = state.outputs.instance_id(&output) {
                    window.data.edit().outputs.insert(output);
                }
            }
            window::Event::OutputLeave { output } => {
                if let Some(output) = state.outputs.instance_id(&output) {
                    window.data.edit().outputs.remove(&output);
                }
            }
            window::Event::Done => {
                if window.data.commit() {
                    state.mark(Topic::Windows);
                }
            }
            window::Event::Closed => {
                let published = window.data.current.is_some();
                proxy.destroy();
                state.windows.items.remove(id);
                if published {
                    state.mark(Topic::Windows);
                }
            }
            _ => {}
        }
    }
}

delegate_noop!(State: ignore WlSeat);
