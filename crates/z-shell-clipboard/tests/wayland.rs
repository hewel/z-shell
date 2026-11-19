use rustix::event::{PollFd, PollFlags, poll};
use rustix::io::{Errno, read};
use serde_json::json;
use std::collections::HashMap;
use std::io::Write as _;
use std::os::fd::{AsFd, OwnedFd};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use wayland_protocols::ext::data_control::v1::server::{
    ext_data_control_device_v1 as device, ext_data_control_manager_v1 as manager,
    ext_data_control_offer_v1 as offer, ext_data_control_source_v1 as source,
};
use wayland_server::protocol::wl_seat;
use wayland_server::{
    Client, DataInit, Dispatch, Display, DisplayHandle, GlobalDispatch, New, Resource,
};
use z_shell_bus::{BusHub, CallerContext};
use z_shell_clipboard::ClipboardService;
use z_shell_protocol::{ClientRole, CommandInvokeParams, CommandName};

#[derive(Default)]
struct PeerState {
    device: Option<device::ExtDataControlDeviceV1>,
    receives: Vec<(String, OwnedFd)>,
    sources: Vec<source::ExtDataControlSourceV1>,
    mimes: HashMap<wayland_server::backend::ObjectId, Vec<String>>,
}

struct Peer {
    display: Display<PeerState>,
    state: PeerState,
    client: Client,
}

impl Peer {
    fn new() -> (Self, UnixStream) {
        let display = Display::<PeerState>::new().expect("Wayland display");
        let mut handle = display.handle();
        handle.create_global::<PeerState, wl_seat::WlSeat, _>(2, ());
        handle.create_global::<PeerState, manager::ExtDataControlManagerV1, _>(1, ());
        let (client_socket, server_socket) = UnixStream::pair().expect("socket pair");
        let client = handle
            .insert_client(server_socket, Arc::new(()))
            .expect("insert client");
        (
            Self {
                display,
                client,
                state: PeerState::default(),
            },
            client_socket,
        )
    }

    fn pump_until(&mut self, predicate: impl Fn(&Self) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            self.display
                .dispatch_clients(&mut self.state)
                .expect("dispatch");
            self.display.flush_clients().expect("flush");
            if predicate(self) {
                return;
            }
            assert!(Instant::now() < deadline, "Wayland peer stalled");
            let timeout = rustix::event::Timespec {
                tv_sec: 0,
                tv_nsec: 10_000_000,
            };
            let _ = poll(
                &mut [PollFd::new(&self.display, PollFlags::IN)],
                Some(&timeout),
            );
        }
    }

    fn offer(&mut self, mimes: &[&str]) {
        let handle = self.display.handle();
        let device = self.state.device.as_ref().expect("bound device").clone();
        let offer = self
            .client
            .create_resource::<offer::ExtDataControlOfferV1, _, PeerState>(&handle, 1, 7)
            .expect("offer resource");
        device.data_offer(&offer);
        for mime in mimes {
            offer.offer((*mime).to_owned());
        }
        device.selection(Some(&offer));
        self.display.flush_clients().expect("flush offer");
    }

    fn receive(&mut self) -> OwnedFd {
        self.pump_until(|peer| !peer.state.receives.is_empty());
        self.state.receives.remove(0).1
    }

    fn paste(&mut self, source: &source::ExtDataControlSourceV1, mime: &str) -> Vec<u8> {
        let (reader, writer) = UnixStream::pair().expect("paste socket");
        let reader = OwnedFd::from(reader);
        let writer = OwnedFd::from(writer);
        let flags = rustix::fs::fcntl_getfl(&reader).expect("reader flags");
        rustix::fs::fcntl_setfl(&reader, flags | rustix::fs::OFlags::NONBLOCK)
            .expect("nonblocking reader");
        source.send(mime.to_owned(), writer.as_fd());
        drop(writer);
        self.display.flush_clients().expect("flush send");
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut bytes = Vec::new();
        let mut buffer = [0_u8; 16 * 1024];
        loop {
            match read(&reader, &mut buffer) {
                Ok(0) => return bytes,
                Ok(count) => bytes.extend_from_slice(&buffer[..count]),
                Err(Errno::INTR) => {}
                Err(Errno::AGAIN) => {
                    assert!(Instant::now() < deadline, "paste timed out");
                    let timeout = rustix::event::Timespec {
                        tv_sec: 0,
                        tv_nsec: 10_000_000,
                    };
                    let _ = poll(&mut [PollFd::new(&reader, PollFlags::IN)], Some(&timeout));
                }
                Err(error) => panic!("paste read failed: {error}"),
            }
        }
    }
}

impl GlobalDispatch<wl_seat::WlSeat, ()> for PeerState {
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

impl Dispatch<wl_seat::WlSeat, ()> for PeerState {
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

impl GlobalDispatch<manager::ExtDataControlManagerV1, ()> for PeerState {
    fn bind(
        _state: &mut Self,
        _handle: &DisplayHandle,
        _client: &Client,
        resource: New<manager::ExtDataControlManagerV1>,
        _data: &(),
        init: &mut DataInit<'_, Self>,
    ) {
        init.init(resource, ());
    }
}

impl Dispatch<manager::ExtDataControlManagerV1, ()> for PeerState {
    fn request(
        state: &mut Self,
        _client: &Client,
        _resource: &manager::ExtDataControlManagerV1,
        request: manager::Request,
        _data: &(),
        _handle: &DisplayHandle,
        init: &mut DataInit<'_, Self>,
    ) {
        match request {
            manager::Request::GetDataDevice { id, .. } => {
                let device = init.init(id, ());
                device.selection(None);
                state.device = Some(device);
            }
            manager::Request::CreateDataSource { id } => {
                init.init(id, ());
            }
            _ => {}
        }
    }
}

impl Dispatch<device::ExtDataControlDeviceV1, ()> for PeerState {
    fn request(
        state: &mut Self,
        _client: &Client,
        _resource: &device::ExtDataControlDeviceV1,
        request: device::Request,
        _data: &(),
        _handle: &DisplayHandle,
        _init: &mut DataInit<'_, Self>,
    ) {
        if let device::Request::SetSelection {
            source: Some(source),
        } = request
        {
            state.sources.push(source);
        }
    }
}

impl Dispatch<offer::ExtDataControlOfferV1, usize> for PeerState {
    fn request(
        state: &mut Self,
        _client: &Client,
        _resource: &offer::ExtDataControlOfferV1,
        request: offer::Request,
        _data: &usize,
        _handle: &DisplayHandle,
        _init: &mut DataInit<'_, Self>,
    ) {
        if let offer::Request::Receive { mime_type, fd } = request {
            state.receives.push((mime_type, fd));
        }
    }
}

impl Dispatch<source::ExtDataControlSourceV1, ()> for PeerState {
    fn request(
        state: &mut Self,
        _client: &Client,
        resource: &source::ExtDataControlSourceV1,
        request: source::Request,
        _data: &(),
        _handle: &DisplayHandle,
        _init: &mut DataInit<'_, Self>,
    ) {
        if let source::Request::Offer { mime_type } = request {
            state
                .mimes
                .entry(resource.id())
                .or_default()
                .push(mime_type);
        }
    }
}

#[tokio::test]
async fn ext_data_control_captures_and_bus_copy_serves_verbatim_large_bytes() {
    let (mut peer, socket) = Peer::new();
    let service = Arc::new(ClipboardService::default());
    service.connect_stream(socket).expect("connect stream");
    let hub = BusHub::new("test", PathBuf::from("/tmp/z-shell-clipboard-test-media"));
    service.install_on_bus(&hub);
    peer.pump_until(|peer| peer.state.device.is_some());

    let original = (0..512 * 1024)
        .map(|index| b'a' + (index % 26) as u8)
        .collect::<Vec<_>>();
    peer.offer(&["STRING", "text/plain;charset=utf-8"]);
    let writer = peer.receive();
    std::fs::File::from(writer)
        .write_all(&original)
        .expect("write selection");
    peer.pump_until(|_| service.snapshot().entry_count == 1);
    assert_eq!(
        service.snapshot().entries[0].mime,
        "text/plain;charset=utf-8"
    );

    let id = service.snapshot().entries[0].id;
    hub.invoke_command(
        CallerContext {
            client_id: 1,
            role: ClientRole::Public,
        },
        CommandInvokeParams {
            name: CommandName::try_new("clipboard.copy").expect("command"),
            args: Vec::new(),
            payload: Some(json!({"id": id})),
        },
    )
    .await
    .expect("copy command");
    peer.pump_until(|peer| !peer.state.sources.is_empty());
    let source = peer.state.sources.last().expect("source").clone();
    assert_eq!(
        peer.paste(&source, "text/plain;charset=utf-8"),
        original,
        "POLLOUT writes must resume after EAGAIN without losing bytes"
    );
}
