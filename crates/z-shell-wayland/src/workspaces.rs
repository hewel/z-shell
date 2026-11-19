use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Value, json};
use wayland_client::protocol::wl_registry::WlRegistry;
use wayland_client::{Connection, Dispatch, Proxy, QueueHandle, event_created_child};
use wayland_protocols::ext::workspace::v1::client::{
    ext_workspace_group_handle_v1 as group, ext_workspace_handle_v1 as workspace,
    ext_workspace_manager_v1 as manager,
};
use z_shell_protocol::{ErrorCode, RpcError};

use crate::CapabilityState;
use crate::state::{Pending, State, Topic, decode_array, next_id, topic_data};

#[derive(Clone, Default, PartialEq, Eq)]
struct WorkspaceData {
    group_id: Option<u64>,
    name: Option<String>,
    id_str: Option<String>,
    coordinates: Vec<u32>,
    state: u32,
    capabilities: u32,
}

impl WorkspaceData {
    fn can_activate(&self) -> bool {
        self.capabilities & workspace::WorkspaceCapabilities::Activate.bits() != 0
    }

    fn data(&self, id: u64) -> Value {
        use workspace::{State, WorkspaceCapabilities as Caps};
        let mut capabilities = [""; 4];
        let mut count = 0;
        for (name, capability) in [
            ("activate", Caps::Activate),
            ("deactivate", Caps::Deactivate),
            ("remove", Caps::Remove),
            ("assign", Caps::Assign),
        ] {
            if self.capabilities & capability.bits() != 0 {
                capabilities[count] = name;
                count += 1;
            }
        }
        json!({
            "workspace_id": id,
            "group_id": self.group_id,
            "name": self.name,
            "id_str": self.id_str,
            "coordinates": self.coordinates,
            "active": self.state & State::Active.bits() != 0,
            "urgent": self.state & State::Urgent.bits() != 0,
            "hidden": self.state & State::Hidden.bits() != 0,
            "capabilities": capabilities[..count],
        })
    }
}

struct Workspace {
    proxy: Option<workspace::ExtWorkspaceHandleV1>,
    data: Pending<WorkspaceData>,
}

struct Group {
    proxy: Option<group::ExtWorkspaceGroupHandleV1>,
    outputs: Pending<BTreeSet<u64>>,
}

#[derive(Default)]
pub(crate) struct Workspaces {
    manager: Option<(u32, manager::ExtWorkspaceManagerV1)>,
    groups: BTreeMap<u64, Group>,
    items: BTreeMap<u64, Workspace>,
}

impl Workspaces {
    pub(crate) fn bind(
        &mut self,
        registry: &WlRegistry,
        global: u32,
        qh: &QueueHandle<State>,
    ) -> bool {
        if self.manager.is_some() {
            return false;
        }
        self.manager = Some((global, registry.bind(global, 1, qh, ())));
        true
    }

    pub(crate) fn remove(&mut self, global: u32) -> bool {
        let Some((_, manager)) = self.manager.take_if(|(name, _)| *name == global) else {
            return false;
        };
        manager.stop();
        self.clear();
        true
    }

    fn clear(&mut self) {
        for group in std::mem::take(&mut self.groups).into_values() {
            if let Some(proxy) = group.proxy {
                proxy.destroy();
            }
        }
        for workspace in std::mem::take(&mut self.items).into_values() {
            if let Some(proxy) = workspace.proxy {
                proxy.destroy();
            }
        }
    }

    pub(crate) fn remove_output(&mut self, id: u64) -> bool {
        let mut changed = false;
        for group in self.groups.values_mut() {
            changed |= group.outputs.scrub(|outputs| outputs.remove(&id));
        }
        changed
    }

    fn commit(&mut self) -> bool {
        let mut changed = false;
        self.groups.retain(|_, group| {
            if group.proxy.is_some() {
                changed |= group.outputs.commit();
                true
            } else {
                changed |= group.outputs.current.is_some();
                false
            }
        });
        self.items.retain(|_, workspace| {
            if workspace.proxy.is_some() {
                changed |= workspace.data.commit();
                true
            } else {
                changed |= workspace.data.current.is_some();
                false
            }
        });
        changed
    }

    pub(crate) fn data(&self) -> Value {
        let committed = self
            .items
            .iter()
            .filter_map(|(&id, workspace)| workspace.data.current.as_ref().map(|data| (id, data)));
        let capability = if self.manager.is_none() {
            CapabilityState::Unsupported
        } else if committed.clone().any(|(_, data)| data.can_activate()) {
            CapabilityState::Controllable
        } else {
            CapabilityState::Readable
        };
        let groups = self.groups.iter().filter_map(|(&id, group)| {
            group
                .outputs
                .current
                .as_ref()
                .map(|outputs| json!({"group_id": id, "output_instance_ids": outputs}))
        });
        topic_data(
            capability,
            [
                ("groups", Value::Array(groups.collect())),
                (
                    "workspaces",
                    Value::Array(committed.map(|(id, data)| data.data(id)).collect()),
                ),
            ],
        )
    }

    pub(crate) fn activate(&self, id: u64) -> Result<(), RpcError> {
        let Some((_, manager)) = &self.manager else {
            return Err(RpcError::new(
                ErrorCode::Disabled,
                "wayland workspaces are unsupported",
            ));
        };
        let not_found = || RpcError::new(ErrorCode::NotFound, format!("workspace_gone: {id}"));
        let workspace = self.items.get(&id).ok_or_else(not_found)?;
        let proxy = workspace.proxy.as_ref().ok_or_else(not_found)?;
        let data = workspace.data.current.as_ref().ok_or_else(not_found)?;
        if !data.can_activate() {
            return Err(RpcError::new(
                ErrorCode::Disabled,
                format!("workspace {id} cannot be activated"),
            ));
        }
        proxy.activate();
        manager.commit();
        Ok(())
    }
}

impl Dispatch<manager::ExtWorkspaceManagerV1, ()> for State {
    event_created_child!(State, manager::ExtWorkspaceManagerV1, [
        manager::EVT_WORKSPACE_GROUP_OPCODE => (group::ExtWorkspaceGroupHandleV1, next_id()),
        manager::EVT_WORKSPACE_OPCODE => (workspace::ExtWorkspaceHandleV1, next_id()),
    ]);

    fn event(
        state: &mut Self,
        proxy: &manager::ExtWorkspaceManagerV1,
        event: manager::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        let workspaces = &mut state.workspaces;
        let current = workspaces
            .manager
            .as_ref()
            .is_some_and(|(_, manager)| manager == proxy);
        match event {
            manager::Event::WorkspaceGroup { workspace_group } => {
                if let Some(&id) = workspace_group.data::<u64>().filter(|_| current) {
                    let mut outputs = Pending::default();
                    outputs.edit();
                    workspaces.groups.insert(
                        id,
                        Group {
                            proxy: Some(workspace_group),
                            outputs,
                        },
                    );
                } else {
                    workspace_group.destroy();
                }
            }
            manager::Event::Workspace { workspace } => {
                if let Some(&id) = workspace.data::<u64>().filter(|_| current) {
                    let mut data = Pending::default();
                    data.edit();
                    workspaces.items.insert(
                        id,
                        Workspace {
                            proxy: Some(workspace),
                            data,
                        },
                    );
                } else {
                    workspace.destroy();
                }
            }
            manager::Event::Done if current && workspaces.commit() => state.mark(Topic::Workspaces),
            manager::Event::Finished if current => {
                workspaces.manager = None;
                workspaces.clear();
                state.mark(Topic::Workspaces);
            }
            _ => {}
        }
    }
}

impl Dispatch<group::ExtWorkspaceGroupHandleV1, u64> for State {
    fn event(
        state: &mut Self,
        proxy: &group::ExtWorkspaceGroupHandleV1,
        event: group::Event,
        id: &u64,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        let Some(group) = state.workspaces.groups.get_mut(id) else {
            return;
        };
        match event {
            group::Event::OutputEnter { output } => {
                if let Some(output) = state.outputs.instance_id(&output) {
                    group.outputs.edit().insert(output);
                }
            }
            group::Event::OutputLeave { output } => {
                if let Some(output) = state.outputs.instance_id(&output) {
                    group.outputs.edit().remove(&output);
                }
            }
            group::Event::WorkspaceEnter { workspace } => {
                if let Some(workspace) = workspace
                    .data::<u64>()
                    .and_then(|id| state.workspaces.items.get_mut(id))
                {
                    workspace.data.edit().group_id = Some(*id);
                }
            }
            group::Event::WorkspaceLeave { workspace } => {
                if let Some(workspace) = workspace
                    .data::<u64>()
                    .and_then(|id| state.workspaces.items.get_mut(id))
                {
                    let data = workspace.data.edit();
                    if data.group_id == Some(*id) {
                        data.group_id = None;
                    }
                }
            }
            group::Event::Removed => {
                proxy.destroy();
                group.proxy = None;
            }
            _ => {}
        }
    }
}

impl Dispatch<workspace::ExtWorkspaceHandleV1, u64> for State {
    fn event(
        state: &mut Self,
        proxy: &workspace::ExtWorkspaceHandleV1,
        event: workspace::Event,
        id: &u64,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        let Some(workspace) = state.workspaces.items.get_mut(id) else {
            return;
        };
        match event {
            workspace::Event::Id { id } => workspace.data.edit().id_str = Some(id),
            workspace::Event::Name { name } => workspace.data.edit().name = Some(name),
            workspace::Event::Coordinates { coordinates } => {
                workspace.data.edit().coordinates = decode_array(&coordinates).collect()
            }
            workspace::Event::State { state } => workspace.data.edit().state = state.into(),
            workspace::Event::Capabilities { capabilities } => {
                workspace.data.edit().capabilities = capabilities.into()
            }
            workspace::Event::Removed => {
                proxy.destroy();
                workspace.proxy = None;
            }
            _ => {}
        }
    }
}
