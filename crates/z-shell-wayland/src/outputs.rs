use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::{Value, json};
use wayland_client::protocol::{wl_output, wl_registry::WlRegistry};
use wayland_client::{Connection, Dispatch, Proxy, QueueHandle, WEnum, delegate_noop};
use wayland_protocols::xdg::xdg_output::zv1::client::{
    zxdg_output_manager_v1::ZxdgOutputManagerV1, zxdg_output_v1,
};
use wayland_protocols_wlr::output_power_management::v1::client::{
    zwlr_output_power_manager_v1::ZwlrOutputPowerManagerV1, zwlr_output_power_v1 as power,
};
use z_shell_protocol::{ErrorCode, RpcError};

use crate::CapabilityState;
use crate::state::{Pending, State, Topic, next_id, topic_data};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum PowerMode {
    On,
    Off,
    #[default]
    Unknown,
}

pub(crate) enum PowerTarget {
    Output(u64),
    All,
}

#[derive(Clone, Default, PartialEq, Eq)]
struct Core {
    name: Option<String>,
    description: Option<String>,
    geometry: Option<Geometry>,
    mode: Option<Mode>,
    scale: Option<i32>,
}

#[derive(Clone, PartialEq, Eq)]
struct Geometry {
    x: i32,
    y: i32,
    physical_width: i32,
    physical_height: i32,
    make: String,
    model: String,
    axes_swapped: bool,
}

#[derive(Clone, PartialEq, Eq)]
struct Mode {
    width: i32,
    height: i32,
    refresh: i32,
}

#[derive(Clone, Default, PartialEq, Eq)]
struct Logical {
    position: Option<(i32, i32)>,
    size: Option<(i32, i32)>,
    name: Option<String>,
    description: Option<String>,
}

struct Output {
    global: u32,
    proxy: wl_output::WlOutput,
    core: Pending<Core>,
    xdg: Option<zxdg_output_v1::ZxdgOutputV1>,
    logical: Pending<Logical>,
    ready: bool,
    power: Option<power::ZwlrOutputPowerV1>,
    mode: PowerMode,
}

impl Output {
    fn attach_xdg(&mut self, id: u64, manager: &ZxdgOutputManagerV1, qh: &QueueHandle<State>) {
        // A v1 wl_output hotplug cannot delimit a v3 xdg-output transaction.
        if self.proxy.version() >= 2 || manager.version() < 3 {
            self.xdg = Some(manager.get_xdg_output(&self.proxy, qh, id));
        }
    }

    fn attach_power(
        &mut self,
        id: u64,
        manager: &ZwlrOutputPowerManagerV1,
        qh: &QueueHandle<State>,
    ) {
        self.power = Some(manager.get_output_power(&self.proxy, qh, id));
    }

    fn release(self) {
        if let Some(power) = self.power {
            power.destroy();
        }
        if let Some(xdg) = self.xdg {
            xdg.destroy();
        }
        if self.proxy.version() >= 3 {
            self.proxy.release();
        }
    }

    // Once visible, keep the core fallback while a newly announced xdg-output
    // manager sends its initial logical fields.
    fn check_ready(&mut self) -> bool {
        if self.ready
            || self.core.current.is_none()
            || (self.xdg.is_some() && self.logical.current.is_none())
        {
            return false;
        }
        self.ready = true;
        true
    }

    fn data(&self, id: u64) -> Option<Value> {
        let core = self.core.current.as_ref().filter(|_| self.ready)?;
        let logical = self.logical.current.as_ref();
        let geometry = core.geometry.as_ref();
        let mode = core.mode.as_ref();
        let scale = core.scale.unwrap_or(1);
        let position = logical
            .and_then(|xdg| xdg.position)
            .or_else(|| geometry.map(|core| (core.x, core.y)));
        let size = logical.and_then(|xdg| xdg.size).or_else(|| {
            mode.map(|mode| {
                let (mut width, mut height) = (mode.width / scale, mode.height / scale);
                if geometry.is_some_and(|geometry| geometry.axes_swapped) {
                    std::mem::swap(&mut width, &mut height);
                }
                (width, height)
            })
        });
        Some(json!({
            "output_instance_id": id,
            "name": core.name.as_deref().or_else(|| logical.and_then(|xdg| xdg.name.as_deref())),
            "description": core.description.as_deref().or_else(|| logical.and_then(|xdg| xdg.description.as_deref())),
            "make": geometry.map(|g| g.make.as_str()),
            "model": geometry.map(|g| g.model.as_str()),
            "x": position.map(|(x, _)| x),
            "y": position.map(|(_, y)| y),
            "width": size.map(|(width, _)| width),
            "height": size.map(|(_, height)| height),
            "mode_width": mode.map(|m| m.width),
            "mode_height": mode.map(|m| m.height),
            "refresh_mhz": mode.map(|m| m.refresh),
            "scale": scale,
            "physical_width_mm": geometry.map(|g| g.physical_width),
            "physical_height_mm": geometry.map(|g| g.physical_height),
        }))
    }
}

#[derive(Default)]
pub(crate) struct Outputs {
    items: BTreeMap<u64, Output>,
    xdg_manager: Option<(u32, ZxdgOutputManagerV1)>,
    power_manager: Option<(u32, ZwlrOutputPowerManagerV1)>,
}

impl Outputs {
    pub(crate) fn bind(
        &mut self,
        registry: &WlRegistry,
        global: u32,
        version: u32,
        qh: &QueueHandle<State>,
    ) {
        let id = next_id();
        let mut output = Output {
            global,
            proxy: registry.bind(global, version.min(4), qh, id),
            core: Pending::default(),
            xdg: None,
            logical: Pending::default(),
            ready: false,
            power: None,
            mode: PowerMode::Unknown,
        };
        if let Some((_, manager)) = &self.xdg_manager {
            output.attach_xdg(id, manager, qh);
        }
        if let Some((_, manager)) = &self.power_manager {
            output.attach_power(id, manager, qh);
        }
        self.items.insert(id, output);
    }

    pub(crate) fn bind_xdg(
        &mut self,
        registry: &WlRegistry,
        global: u32,
        version: u32,
        qh: &QueueHandle<State>,
    ) {
        if self.xdg_manager.is_some() {
            return;
        }
        // v3 uses wl_output.done, which doesn't exist on a v1 output. Bind the
        // old xdg version if one of the current outputs needs its own done event.
        let max = if self
            .items
            .values()
            .any(|output| output.proxy.version() == 1)
        {
            2
        } else {
            3
        };
        let manager = registry.bind(global, version.min(max), qh, ());
        for (&id, output) in &mut self.items {
            output.attach_xdg(id, &manager, qh);
        }
        self.xdg_manager = Some((global, manager));
    }

    pub(crate) fn bind_power(
        &mut self,
        registry: &WlRegistry,
        global: u32,
        qh: &QueueHandle<State>,
    ) -> bool {
        if self.power_manager.is_some() {
            return false;
        }
        let manager = registry.bind(global, 1, qh, ());
        for (&id, output) in &mut self.items {
            output.attach_power(id, &manager, qh);
        }
        self.power_manager = Some((global, manager));
        true
    }

    pub(crate) fn remove(&mut self, global: u32) -> Option<u64> {
        let id = self
            .items
            .iter()
            .find_map(|(&id, output)| (output.global == global).then_some(id))?;
        if let Some(output) = self.items.remove(&id) {
            output.release();
        }
        Some(id)
    }

    pub(crate) fn remove_xdg(&mut self, global: u32) -> (bool, bool) {
        let Some((_, manager)) = self.xdg_manager.take_if(|(name, _)| *name == global) else {
            return (false, false);
        };
        let mut output_changed = false;
        let mut output_added = false;
        for output in self.items.values_mut() {
            if let Some(xdg) = output.xdg.take() {
                xdg.destroy();
                output_changed |= output.logical.current.is_some() && output.ready;
                output.logical = Pending::default();
                output_added |= output.check_ready();
            }
        }
        manager.destroy();
        (output_changed || output_added, output_added)
    }

    pub(crate) fn remove_power(&mut self, global: u32) -> bool {
        let Some((_, manager)) = self.power_manager.take_if(|(name, _)| *name == global) else {
            return false;
        };
        for output in self.items.values_mut() {
            if let Some(power) = output.power.take() {
                power.destroy();
            }
            output.mode = PowerMode::Unknown;
        }
        manager.destroy();
        true
    }

    pub(crate) fn instance_id(&self, proxy: &wl_output::WlOutput) -> Option<u64> {
        proxy
            .data::<u64>()
            .copied()
            .filter(|id| self.items.contains_key(id))
    }

    pub(crate) fn data(&self) -> Value {
        let capability = if self.items.values().any(|output| output.ready) {
            CapabilityState::Readable
        } else {
            CapabilityState::Unsupported
        };
        topic_data(
            capability,
            [(
                "outputs",
                Value::Array(
                    self.items
                        .iter()
                        .filter_map(|(&id, o)| o.data(id))
                        .collect(),
                ),
            )],
        )
    }

    pub(crate) fn power_data(&self) -> Value {
        let capability = if self.power_manager.is_none() {
            CapabilityState::Unsupported
        } else if self
            .items
            .values()
            .any(|output| output.ready && output.power.is_some())
        {
            CapabilityState::Controllable
        } else {
            CapabilityState::Readable
        };
        let modes = self
            .items
            .iter()
            .filter(|(_, o)| o.ready)
            .map(|(&id, o)| json!({"output_instance_id": id, "mode": o.mode}));
        topic_data(capability, [("outputs", Value::Array(modes.collect()))])
    }

    pub(crate) fn set_power(&self, target: PowerTarget, mode: power::Mode) -> Result<(), RpcError> {
        let available = |output: &Output| output.power.as_ref().is_some_and(Proxy::is_alive);
        let unavailable = || {
            RpcError::new(
                ErrorCode::Disabled,
                "wayland display power is unavailable for the selected outputs",
            )
        };
        match target {
            PowerTarget::Output(id) => {
                let output = self.items.get(&id).ok_or_else(|| {
                    RpcError::new(ErrorCode::NotFound, format!("output_gone: {id}"))
                })?;
                output
                    .power
                    .as_ref()
                    .filter(|proxy| proxy.is_alive())
                    .ok_or_else(unavailable)?
                    .set_mode(mode);
            }
            PowerTarget::All => {
                if self.items.is_empty() || !self.items.values().all(available) {
                    return Err(unavailable());
                }
                for output in self.items.values() {
                    if let Some(power) = &output.power {
                        power.set_mode(mode);
                    }
                }
            }
        }
        Ok(())
    }
}

impl Dispatch<wl_output::WlOutput, u64> for State {
    fn event(
        state: &mut Self,
        proxy: &wl_output::WlOutput,
        event: wl_output::Event,
        id: &u64,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        let Some(output) = state.outputs.items.get_mut(id) else {
            return;
        };
        let mut changed = false;
        match event {
            wl_output::Event::Geometry {
                x,
                y,
                physical_width,
                physical_height,
                make,
                model,
                transform,
                ..
            } => {
                use wl_output::Transform;
                output.core.edit().geometry = Some(Geometry {
                    x,
                    y,
                    physical_width,
                    physical_height,
                    make,
                    model,
                    axes_swapped: matches!(
                        transform,
                        WEnum::Value(
                            Transform::_90
                                | Transform::_270
                                | Transform::Flipped90
                                | Transform::Flipped270
                        )
                    ),
                });
            }
            wl_output::Event::Mode {
                flags,
                width,
                height,
                refresh,
            } if u32::from(flags) & wl_output::Mode::Current.bits() != 0 => {
                output.core.edit().mode = Some(Mode {
                    width,
                    height,
                    refresh,
                });
            }
            wl_output::Event::Scale { factor } if factor > 0 => {
                output.core.edit().scale = Some(factor)
            }
            wl_output::Event::Name { name } => output.core.edit().name = Some(name),
            wl_output::Event::Description { description } => {
                output.core.edit().description = Some(description)
            }
            wl_output::Event::Done => {
                changed = output.core.commit();
                if output.xdg.as_ref().is_some_and(|xdg| xdg.version() >= 3) {
                    changed |= output.logical.commit();
                }
            }
            _ => {}
        }
        if proxy.version() == 1 {
            changed |= output.core.commit();
        }
        mark_output(state, *id, changed);
    }
}

impl Dispatch<zxdg_output_v1::ZxdgOutputV1, u64> for State {
    fn event(
        state: &mut Self,
        proxy: &zxdg_output_v1::ZxdgOutputV1,
        event: zxdg_output_v1::Event,
        id: &u64,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        let Some(output) = state
            .outputs
            .items
            .get_mut(id)
            .filter(|output| output.xdg.as_ref() == Some(proxy))
        else {
            return;
        };
        let mut changed = false;
        match event {
            zxdg_output_v1::Event::LogicalPosition { x, y } => {
                output.logical.edit().position = Some((x, y))
            }
            zxdg_output_v1::Event::LogicalSize { width, height } => {
                output.logical.edit().size = Some((width, height))
            }
            zxdg_output_v1::Event::Name { name } => output.logical.edit().name = Some(name),
            zxdg_output_v1::Event::Description { description } => {
                output.logical.edit().description = Some(description)
            }
            zxdg_output_v1::Event::Done if proxy.version() < 3 => changed = output.logical.commit(),
            _ => {}
        }
        mark_output(state, *id, changed);
    }
}

fn mark_output(state: &mut State, id: u64, changed: bool) {
    let Some(output) = state.outputs.items.get_mut(&id) else {
        return;
    };
    let added = output.check_ready();
    if added || (changed && output.ready) {
        state.mark(Topic::Outputs);
    }
    if added {
        state.mark(Topic::Power);
    }
}

impl Dispatch<power::ZwlrOutputPowerV1, u64> for State {
    fn event(
        state: &mut Self,
        proxy: &power::ZwlrOutputPowerV1,
        event: power::Event,
        id: &u64,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        let Some(output) = state
            .outputs
            .items
            .get_mut(id)
            .filter(|output| output.power.as_ref() == Some(proxy))
        else {
            return;
        };
        let changed = match event {
            power::Event::Mode { mode } => {
                let mode = match mode {
                    WEnum::Value(power::Mode::On) => PowerMode::On,
                    WEnum::Value(power::Mode::Off) => PowerMode::Off,
                    _ => PowerMode::Unknown,
                };
                std::mem::replace(&mut output.mode, mode) != mode
            }
            power::Event::Failed => {
                proxy.destroy();
                output.power = None;
                output.mode = PowerMode::Unknown;
                true
            }
            _ => false,
        };
        if changed && output.ready {
            state.mark(Topic::Power);
        }
    }
}

delegate_noop!(State: ignore ZxdgOutputManagerV1);
delegate_noop!(State: ignore ZwlrOutputPowerManagerV1);
