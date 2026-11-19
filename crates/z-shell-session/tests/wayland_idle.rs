use std::os::unix::net::UnixStream;
use std::sync::Arc;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;
use wayland_protocols::ext::idle_notify::v1::server::{
    ext_idle_notification_v1 as notification, ext_idle_notifier_v1 as notifier,
};
use wayland_server::protocol::wl_seat;
use wayland_server::{Client, DataInit, Dispatch, Display, DisplayHandle, GlobalDispatch, New};
use z_shell_session::wayland_idle::{WaylandIdle, WaylandIdleEvent};

#[derive(Default)]
struct ServerState {
    notifications: Vec<notification::ExtIdleNotificationV1>,
}

enum Command {
    Act(Box<dyn FnOnce(&mut ServerState) + Send>),
    Stop,
}

struct Peer {
    commands: mpsc::Sender<Command>,
    thread: Option<thread::JoinHandle<()>>,
}

impl Peer {
    fn new() -> (Self, UnixStream) {
        let (client_socket, server_socket) = UnixStream::pair().expect("socket pair");
        let mut display = Display::<ServerState>::new().expect("Wayland display");
        let mut handle = display.handle();
        handle.create_global::<ServerState, wl_seat::WlSeat, _>(7, ());
        handle.create_global::<ServerState, notifier::ExtIdleNotifierV1, _>(1, ());
        handle
            .insert_client(server_socket, Arc::new(()))
            .expect("insert client");
        let (commands, receiver) = mpsc::channel::<Command>();
        let thread = thread::spawn(move || {
            let mut state = ServerState::default();
            loop {
                display
                    .dispatch_clients(&mut state)
                    .expect("dispatch clients");
                while let Ok(command) = receiver.try_recv() {
                    match command {
                        Command::Act(action) => action(&mut state),
                        Command::Stop => return,
                    }
                }
                display.flush_clients().expect("flush clients");
                thread::sleep(Duration::from_millis(1));
            }
        });
        (
            Self {
                commands,
                thread: Some(thread),
            },
            client_socket,
        )
    }

    fn act(&self, action: impl FnOnce(&mut ServerState) + Send + 'static) {
        self.commands
            .send(Command::Act(Box::new(action)))
            .expect("server action");
    }
}

impl Drop for Peer {
    fn drop(&mut self) {
        let _ = self.commands.send(Command::Stop);
        if let Some(thread) = self.thread.take() {
            thread.join().expect("Wayland server thread");
        }
    }
}

impl GlobalDispatch<wl_seat::WlSeat, ()> for ServerState {
    fn bind(
        _state: &mut Self,
        _handle: &DisplayHandle,
        _client: &Client,
        resource: New<wl_seat::WlSeat>,
        _data: &(),
        init: &mut DataInit<'_, Self>,
    ) {
        init.init(resource, ());
    }
}

impl Dispatch<wl_seat::WlSeat, ()> for ServerState {
    fn request(
        _state: &mut Self,
        _client: &Client,
        _resource: &wl_seat::WlSeat,
        _request: wl_seat::Request,
        _data: &(),
        _handle: &DisplayHandle,
        _init: &mut DataInit<'_, Self>,
    ) {
    }
}

impl GlobalDispatch<notifier::ExtIdleNotifierV1, ()> for ServerState {
    fn bind(
        _state: &mut Self,
        _handle: &DisplayHandle,
        _client: &Client,
        resource: New<notifier::ExtIdleNotifierV1>,
        _data: &(),
        init: &mut DataInit<'_, Self>,
    ) {
        init.init(resource, ());
    }
}

impl Dispatch<notifier::ExtIdleNotifierV1, ()> for ServerState {
    fn request(
        state: &mut Self,
        _client: &Client,
        _resource: &notifier::ExtIdleNotifierV1,
        request: notifier::Request,
        _data: &(),
        _handle: &DisplayHandle,
        init: &mut DataInit<'_, Self>,
    ) {
        if let notifier::Request::GetIdleNotification { id, .. } = request {
            state.notifications.push(init.init(id, ()));
        }
    }
}

impl Dispatch<notification::ExtIdleNotificationV1, ()> for ServerState {
    fn request(
        _state: &mut Self,
        _client: &Client,
        _resource: &notification::ExtIdleNotificationV1,
        _request: notification::Request,
        _data: &(),
        _handle: &DisplayHandle,
        _init: &mut DataInit<'_, Self>,
    ) {
    }
}

#[test]
fn ext_idle_notify_delivers_idle_and_resumed_events_with_watch_tokens() {
    let (peer, socket) = Peer::new();
    let mut idle = WaylandIdle::connect_stream(socket).expect("connect Wayland idle client");
    idle.watch(2, 44, 1).expect("create idle notification");
    assert!(idle.roundtrip().expect("initial roundtrip").is_empty());

    peer.act(|state| {
        state.notifications[0].idled();
    });
    assert_eq!(
        idle.roundtrip().expect("idle event roundtrip"),
        [WaylandIdleEvent::Idled {
            rule_index: 2,
            token: 44,
        }]
    );
    peer.act(|state| {
        state.notifications[0].resumed();
    });
    assert_eq!(
        idle.roundtrip().expect("resume event roundtrip"),
        [WaylandIdleEvent::Resumed {
            rule_index: 2,
            token: 44,
        }]
    );
    idle.cancel(44);
    idle.roundtrip().expect("destroy notification");
}
