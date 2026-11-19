use std::os::fd::AsFd;
use std::os::unix::net::UnixStream;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::unix::AsyncFd;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use wayland_protocols::ext::workspace::v1::server::{
    ext_workspace_group_handle_v1 as group, ext_workspace_handle_v1 as workspace,
    ext_workspace_manager_v1 as workspaces,
};
use wayland_protocols::xdg::xdg_output::zv1::server::{
    zxdg_output_manager_v1 as xdg_outputs, zxdg_output_v1 as xdg_output,
};
use wayland_protocols_wlr::foreign_toplevel::v1::server::{
    zwlr_foreign_toplevel_handle_v1 as window, zwlr_foreign_toplevel_manager_v1 as windows,
};
use wayland_protocols_wlr::output_power_management::v1::server::{
    zwlr_output_power_manager_v1 as power_manager, zwlr_output_power_v1 as power,
};
use wayland_server::backend::GlobalId;
use wayland_server::protocol::{wl_output as output, wl_seat as seat};
use wayland_server::{
    Client, DataInit, Dispatch, Display, DisplayHandle, GlobalDispatch, New, Resource,
};

#[derive(Clone, Copy)]
pub enum Protocols {
    Full,
    Partial,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Request {
    ActivateWorkspace,
    CommitWorkspaces,
    ActivateWindow,
    CloseWindow,
    SetPower(u32, power::Mode),
}

type Action = Box<dyn FnOnce(&mut Compositor, &DisplayHandle) + Send>;

pub struct Mock {
    actions: mpsc::UnboundedSender<Action>,
    requests: mpsc::UnboundedReceiver<Request>,
    task: JoinHandle<()>,
}

impl Mock {
    pub fn start(protocols: Protocols) -> (Self, UnixStream) {
        let (client, server) = UnixStream::pair().unwrap();
        let (send_action, mut actions) = mpsc::unbounded_channel::<Action>();
        let (requests, recv_requests) = mpsc::unbounded_channel();
        let mut display = Display::<Compositor>::new().unwrap();
        let mut handle = display.handle();
        handle.insert_client(server, Arc::new(())).unwrap();
        let mut state = Compositor::new(&handle, protocols, requests);
        let fd = display.as_fd().try_clone_to_owned().unwrap();
        // SAFETY: AsyncFd owns the duplicate, which stays open until deregistration.
        let fd = unsafe { AsyncFd::register(fd) }.unwrap();
        let task = tokio::spawn(async move {
            loop {
                tokio::select! {
                    action = actions.recv() => match action {
                        Some(action) => action(&mut state, &handle),
                        None => break,
                    },
                    ready = fd.readable() => {
                        ready.unwrap().clear_ready();
                        display.dispatch_clients(&mut state).unwrap();
                    }
                }
                display.flush_clients().unwrap();
            }
        });
        (
            Self {
                actions: send_action,
                requests: recv_requests,
                task,
            },
            client,
        )
    }

    pub fn act(&self, action: impl FnOnce(&mut Compositor, &DisplayHandle) + Send + 'static) {
        self.actions.send(Box::new(action)).unwrap();
    }

    pub async fn expect(&mut self, request: Request) {
        let observed = tokio::time::timeout(Duration::from_secs(3), self.requests.recv())
            .await
            .unwrap_or_else(|_| panic!("mock did not receive {request:?}"));
        assert_eq!(observed, Some(request));
    }

    pub async fn stop(self) {
        drop(self.actions);
        self.task.await.unwrap();
    }
}

pub struct Compositor {
    first_global: Option<GlobalId>,
    first_output: Option<output::WlOutput>,
    xdg_output: Option<xdg_output::ZxdgOutputV1>,
    group: Option<group::ExtWorkspaceGroupHandleV1>,
    workspace: Option<workspace::ExtWorkspaceHandleV1>,
    workspaces: Option<workspaces::ExtWorkspaceManagerV1>,
    window: Option<window::ZwlrForeignToplevelHandleV1>,
    first_power: Option<power::ZwlrOutputPowerV1>,
    requests: mpsc::UnboundedSender<Request>,
}

impl Compositor {
    fn new(
        handle: &DisplayHandle,
        protocols: Protocols,
        requests: mpsc::UnboundedSender<Request>,
    ) -> Self {
        // Advertise the extensions first: registry order cannot determine output associations.
        if matches!(protocols, Protocols::Full) {
            handle.create_global::<Self, xdg_outputs::ZxdgOutputManagerV1, _>(3, ());
            handle.create_global::<Self, power_manager::ZwlrOutputPowerManagerV1, _>(1, ());
            handle.create_global::<Self, workspaces::ExtWorkspaceManagerV1, _>(1, ());
            handle.create_global::<Self, seat::WlSeat, _>(7, ());
        }
        handle.create_global::<Self, windows::ZwlrForeignToplevelManagerV1, _>(3, ());
        let first_global = handle.create_global::<Self, output::WlOutput, _>(4, 1u32);
        Self {
            first_global: Some(first_global),
            first_output: None,
            xdg_output: None,
            group: None,
            workspace: None,
            workspaces: None,
            window: None,
            first_power: None,
            requests,
        }
    }

    pub fn stage_changes(&self) {
        self.xdg_output.as_ref().unwrap().logical_position(-500, 70);
        self.workspace
            .as_ref()
            .unwrap()
            .state(workspace::State::Hidden);
        let window = self.window.as_ref().unwrap();
        window.title("Edited document".into());
        window.state(array([window::State::Minimized as u32]));
        // An unrelated event fences the uncommitted changes on the wire.
        self.first_power.as_ref().unwrap().mode(power::Mode::Off);
    }

    pub fn finish_changes(&self) {
        self.first_output.as_ref().unwrap().done();
        self.workspaces.as_ref().unwrap().done();
        self.window.as_ref().unwrap().done();
    }

    pub fn fail_power(&mut self) {
        self.first_power.take().unwrap().failed();
    }

    pub fn add_second_output(&self, handle: &DisplayHandle) {
        handle.create_global::<Self, output::WlOutput, _>(4, 2u32);
    }

    pub fn remove_first_output(&mut self, handle: &DisplayHandle) {
        handle.disable_global::<Self>(self.first_global.take().unwrap());
    }

    pub fn remove_workspace(&mut self) {
        let workspace = self.workspace.take().unwrap();
        self.group.as_ref().unwrap().workspace_leave(&workspace);
        workspace.removed();
        self.group.take().unwrap().removed();
        self.workspaces.as_ref().unwrap().done();
    }
}

fn array(values: impl IntoIterator<Item = u32>) -> Vec<u8> {
    values.into_iter().flat_map(u32::to_ne_bytes).collect()
}

macro_rules! bind {
    ($resource:path, $data:ty, |$state:ident, $client:ident, $handle:ident, $init:ident, $new:ident, $data_ref:ident| $body:block) => {
        impl GlobalDispatch<$resource, $data> for Compositor {
            fn bind(
                $state: &mut Self,
                $handle: &DisplayHandle,
                $client: &Client,
                $new: New<$resource>,
                $data_ref: &$data,
                $init: &mut DataInit<'_, Self>,
            ) $body
        }
    };
}

macro_rules! dispatch {
    ($resource:path, $data:ty, |$state:ident, $client:ident, $obj:ident, $req:ident, $ud:ident, $handle:ident, $init:ident| $body:block) => {
        impl Dispatch<$resource, $data> for Compositor {
            fn request(
                $state: &mut Self,
                $client: &Client,
                $obj: &$resource,
                $req: <$resource as Resource>::Request,
                $ud: &$data,
                $handle: &DisplayHandle,
                $init: &mut DataInit<'_, Self>,
            ) $body
        }
    };
    ($resource:path, $data:ty) => {
        dispatch!($resource, $data, |_state, _client, _obj, _req, _ud, _handle, _init| {});
    };
}

bind!(output::WlOutput, u32, |state,
                              _client,
                              _handle,
                              init,
                              new,
                              id| {
    let output = init.init(new, *id);
    output.geometry(
        10,
        20,
        520,
        290,
        output::Subpixel::Unknown,
        "Mock Make".into(),
        "Mock Model".into(),
        output::Transform::Normal,
    );
    output.mode(output::Mode::Preferred, 3840, 2160, 60_000);
    output.mode(output::Mode::Current, 3200, 1800, 59_950);
    output.scale(2);
    output.name(format!("DP-{id}"));
    output.description(format!("Mock monitor {id}"));
    output.done();
    if *id == 1 {
        state.first_output = Some(output);
    }
});
dispatch!(output::WlOutput, u32);

bind!(
    xdg_outputs::ZxdgOutputManagerV1,
    (),
    |_state, _client, _handle, init, new, _data| {
        init.init(new, ());
    }
);
dispatch!(
    xdg_outputs::ZxdgOutputManagerV1,
    (),
    |state, _client, _obj, req, _ud, _handle, init| {
        if let xdg_outputs::Request::GetXdgOutput { id, output } = req {
            let xdg = init.init(id, ());
            xdg.logical_position(-200, 30);
            xdg.logical_size(1500, 840);
            if xdg.version() < 3 {
                xdg.done();
            } else {
                output.done();
            }
            if output.data::<u32>() == Some(&1) {
                state.xdg_output = Some(xdg);
            }
        }
    }
);
dispatch!(xdg_output::ZxdgOutputV1, ());

bind!(seat::WlSeat, (), |_state,
                         _client,
                         _handle,
                         init,
                         new,
                         _data| {
    let seat = init.init(new, ());
    seat.capabilities(seat::Capability::Keyboard);
    seat.name("seat0".into());
});
dispatch!(seat::WlSeat, ());

bind!(
    workspaces::ExtWorkspaceManagerV1,
    (),
    |state, client, handle, init, new, _data| {
        let manager = init.init(new, ());
        let group = client
            .create_resource::<group::ExtWorkspaceGroupHandleV1, _, Compositor>(handle, 1, ())
            .unwrap();
        manager.workspace_group(&group);
        group.output_enter(state.first_output.as_ref().unwrap());
        let workspace = client
            .create_resource::<workspace::ExtWorkspaceHandleV1, _, Compositor>(handle, 1, ())
            .unwrap();
        manager.workspace(&workspace);
        workspace.id("mock:one".into());
        workspace.name("One".into());
        workspace.coordinates(array([2, 3]));
        workspace.state(workspace::State::Active | workspace::State::Urgent);
        workspace.capabilities(workspace::WorkspaceCapabilities::Activate);
        group.workspace_enter(&workspace);
        manager.done();
        state.group = Some(group);
        state.workspace = Some(workspace);
        state.workspaces = Some(manager);
    }
);
dispatch!(
    workspaces::ExtWorkspaceManagerV1,
    (),
    |state, _client, _obj, req, _ud, _handle, _init| {
        if let workspaces::Request::Commit = req {
            state.requests.send(Request::CommitWorkspaces).unwrap();
        }
    }
);
dispatch!(group::ExtWorkspaceGroupHandleV1, ());
dispatch!(
    workspace::ExtWorkspaceHandleV1,
    (),
    |state, _client, _obj, req, _ud, _handle, _init| {
        if let workspace::Request::Activate = req {
            state.requests.send(Request::ActivateWorkspace).unwrap();
        }
    }
);

bind!(
    windows::ZwlrForeignToplevelManagerV1,
    (),
    |state, client, handle, init, new, _data| {
        let manager = init.init(new, ());
        let window = client
            .create_resource::<window::ZwlrForeignToplevelHandleV1, _, Compositor>(
                handle,
                manager.version(),
                (),
            )
            .unwrap();
        manager.toplevel(&window);
        window.title("Document".into());
        window.app_id("com.example.Editor".into());
        window.state(array([
            window::State::Activated as u32,
            window::State::Maximized as u32,
            window::State::Fullscreen as u32,
        ]));
        window.output_enter(state.first_output.as_ref().unwrap());
        window.done();
        state.window = Some(window);
    }
);
dispatch!(windows::ZwlrForeignToplevelManagerV1, ());
dispatch!(
    window::ZwlrForeignToplevelHandleV1,
    (),
    |state, _client, obj, req, _ud, _handle, _init| {
        match req {
            window::Request::Activate { seat } => {
                assert!(seat.data::<()>().is_some());
                state.requests.send(Request::ActivateWindow).unwrap();
            }
            window::Request::Close => {
                state.requests.send(Request::CloseWindow).unwrap();
                obj.closed();
            }
            _ => {}
        }
    }
);

bind!(
    power_manager::ZwlrOutputPowerManagerV1,
    (),
    |_state, _client, _handle, init, new, _data| {
        init.init(new, ());
    }
);
dispatch!(
    power_manager::ZwlrOutputPowerManagerV1,
    (),
    |state, _client, _obj, req, _ud, _handle, init| {
        if let power_manager::Request::GetOutputPower { id, output } = req {
            let number = *output.data::<u32>().unwrap();
            let power = init.init(id, number);
            power.mode(power::Mode::On);
            if number == 1 {
                state.first_power = Some(power);
            }
        }
    }
);
dispatch!(
    power::ZwlrOutputPowerV1,
    u32,
    |state, _client, obj, req, id, _handle, _init| {
        if let power::Request::SetMode {
            mode: wayland_server::WEnum::Value(mode),
        } = req
        {
            state.requests.send(Request::SetPower(*id, mode)).unwrap();
            obj.mode(mode);
        }
    }
);
