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

#[tokio::test]
async fn wayland_idle_driver_arms_settings_rules_and_delivers_idled_to_session_service() {
    use std::sync::Arc;
    use tokio::time::{Duration, sleep};
    use z_shell_config::{IdleRuleAction, IdleRuleSettings, IdleSettings};
    use z_shell_session::coordinator::{InhibitorFuture, SleepInhibitor};
    use z_shell_session::pam::MockAuthenticator;
    use z_shell_session::service::SessionService;
    use z_shell_session::wayland_idle::WaylandIdleDriver;

    #[derive(Debug)]
    struct NoopSleepInhibitor;
    impl SleepInhibitor for NoopSleepInhibitor {
        fn acquire(&self) -> InhibitorFuture<'_> {
            Box::pin(async { Ok(()) })
        }
        fn release(&self) {}
        fn is_held(&self) -> bool {
            false
        }
    }

    let (peer, socket) = Peer::new();
    let idle = WaylandIdle::connect_stream(socket).expect("connect mock compositor");

    let settings = IdleSettings {
        pre_action_fade_seconds: 0,
        fallback_locker: None,
        rules: vec![IdleRuleSettings {
            name: "screen-off".to_owned(),
            enabled: true,
            timeout_seconds: 15,
            locked_timeout_seconds: None,
            action: IdleRuleAction::ScreenOff,
            resume_command: None,
            pre_action_fade_seconds: Some(0),
        }],
    };
    let service = Arc::new(SessionService::new(
        "daemon-idle-driver",
        Arc::new(MockAuthenticator::new([])),
        Arc::new(NoopSleepInhibitor),
        &settings,
    ));
    let mut effects = service.subscribe_idle_effects();

    let driver = WaylandIdleDriver::spawn(
        idle,
        Arc::clone(&service),
        tokio::runtime::Handle::current(),
    )
    .expect("spawn wayland idle driver");

    // Wait for the driver to arm the enabled rule watch on the mock compositor.
    let seen = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    loop {
        let seen_clone = Arc::clone(&seen);
        peer.act(move |state| {
            seen_clone.store(
                state.notifications.len(),
                std::sync::atomic::Ordering::SeqCst,
            );
        });
        if seen.load(std::sync::atomic::Ordering::SeqCst) == 1 {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for WaylandIdleDriver to register initial watch"
        );
        sleep(Duration::from_millis(10)).await;
    }

    peer.act(|state| {
        state.notifications[0].idled();
    });

    // SessionService must receive Idled and emit RunAction(ScreenOff).
    let (action_id, effect) = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if let Ok(z_shell_session::idle::IdleEffect::RunAction {
                action_id, action, ..
            }) = effects.recv().await
            {
                return (action_id, action);
            }
        }
    })
    .await
    .expect("expected RunAction effect from SessionService");
    assert_eq!(effect, z_shell_session::idle::IdleAction::ScreenOff);

    // Completing ScreenOff as Succeeded (even when a sibling Wayland output failed) marks
    // ScreenOff applied and causes compositor resumed() to emit ResumeAction(ScreenOff).
    service
        .complete_idle_action(
            action_id,
            z_shell_session::idle::ActionCompletion::Succeeded,
        )
        .await;
    assert!(service.is_screen_off_applied());

    peer.act(|state| {
        state.notifications[0].resumed();
    });

    let resumed_action = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if let Ok(z_shell_session::idle::IdleEffect::ResumeAction { action, .. }) =
                effects.recv().await
            {
                return action;
            }
        }
    })
    .await
    .expect("expected ResumeAction effect on compositor resume");
    assert_eq!(resumed_action, z_shell_session::idle::IdleAction::ScreenOff);
    assert!(!service.is_screen_off_applied());

    drop(driver);
}
