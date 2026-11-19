//! Fcitx5 status and composition. The panel and its privacy gate share one lock.

mod panel;

use std::collections::HashMap;
use std::future::{pending, poll_fn};
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::{Notify, watch};
use tokio::time::sleep;
use z_shell_bus::{BusHub, CommandCall, UpdateKind};
use z_shell_config::{ImeMode, ImeSettings};
use z_shell_protocol::{ClientRole, CommandInvokeResult, ErrorCode, RpcError};
use zbus::export::futures_core::Stream;
use zbus::fdo::{DBusProxy, RequestNameFlags, RequestNameReply};
use zbus::message::{Sequence, Type};
use zbus::names::OwnedUniqueName;
use zbus::zvariant::{DynamicType, OwnedValue};
use zbus::{Connection, MatchRule, Message, MessageStream};

use crate::{SessionBusAddress, connect, disabled, ok, payload, publish, register};
use panel::{Composition, Event, ImeProperty, Panel};

const STATUS: &str = "desktop.ime";
const PANEL: &str = "desktop.ime.panel";
const FCITX: &str = "org.fcitx.Fcitx5";
const CONTROLLER: &str = "org.fcitx.Fcitx.Controller1";
const CONTROLLER_PATH: &str = "/controller";
const GROUP_CHANGED: &str = "InputMethodGroupsChanged";
const DBUS: &str = "org.freedesktop.DBus";
const DBUS_PATH: &str = "/org/freedesktop/DBus";
const OWNER_CHANGED: &str = "NameOwnerChanged";
const IM_PROPERTY: &str = "/Fcitx/im";
const RETRY: Duration = Duration::from_secs(2);

/// Whether the session may expose live input composition to subscribers.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum ImeLockState {
    /// Allow composition and public IME commands.
    #[default]
    Unlocked,
    /// Redact composition and restrict IME commands to the trusted host.
    Locked,
}

pub(crate) struct Ime {
    hub: BusHub,
    state: Mutex<State>,
    mode: watch::Sender<ImeMode>,
    refresh: Arc<Notify>,
}

struct State {
    settings: ImeSettings,
    lock: ImeLockState,
    generation: u64,
    connection: Option<Connection>,
    controller: Option<OwnedUniqueName>,
    panel_sender: Option<OwnedUniqueName>,
    panel_claimed: bool,
    panel_registered: bool,
    panel_enabled: Option<bool>,
    controller_enabled: Option<bool>,
    status: Status,
    panel: Panel,
    menu_revision: u64,
}

#[derive(Default, Serialize)]
struct Status {
    available: bool,
    enabled: bool,
    active_im: Option<ActiveInputMethod>,
    properties: Vec<ImeProperty>,
    group_ims: Vec<GroupInputMethod>,
    exec_menu: Option<ImeMenu>,
}

#[derive(PartialEq, Eq, Serialize)]
struct ActiveInputMethod {
    unique_name: Option<String>,
    label: String,
    short_label: String,
    icon: Option<String>,
    text: String,
}

#[derive(PartialEq, Eq, Serialize)]
struct GroupInputMethod {
    unique_name: String,
    label: String,
    layout: String,
}

#[derive(Serialize)]
struct ImeMenu {
    revision: u64,
    items: Vec<ImeProperty>,
}

impl Ime {
    pub(crate) fn install(hub: &BusHub, settings: ImeSettings, refresh: Arc<Notify>) -> Arc<Self> {
        let (mode, _) = watch::channel(settings.mode);
        let service = Arc::new(Self {
            hub: hub.clone(),
            mode,
            refresh,
            state: Mutex::new(State {
                settings,
                lock: ImeLockState::Unlocked,
                generation: 0,
                connection: None,
                controller: None,
                panel_sender: None,
                panel_claimed: false,
                panel_registered: false,
                panel_enabled: None,
                controller_enabled: None,
                status: Status::default(),
                panel: Panel::default(),
                menu_revision: 0,
            }),
        });
        {
            let state = service.state();
            service.publish_status(&state, UpdateKind::SourceBaseline);
            service.publish_panel(&state, UpdateKind::SourceBaseline);
        }
        for (control, name, description) in [
            (Control::Toggle, "ime.toggle", "Toggle the input method"),
            (Control::SetIm, "ime.set-im", "Select an input method"),
            (
                Control::TriggerProperty,
                "ime.trigger-property",
                "Activate an input method property",
            ),
            (
                Control::SelectCandidate,
                "ime.select-candidate",
                "Select a composition candidate",
            ),
            (
                Control::PageUp,
                "ime.page-up",
                "Show the previous candidate page",
            ),
            (
                Control::PageDown,
                "ime.page-down",
                "Show the next candidate page",
            ),
            (
                Control::MoveCaret,
                "ime.move-caret",
                "Move the preedit caret",
            ),
            (
                Control::ReloadConfig,
                "ime.reload-config",
                "Reload Fcitx5 configuration",
            ),
            (
                Control::Configure,
                "ime.configure",
                "Open Fcitx5 configuration",
            ),
        ] {
            register(
                hub,
                &service,
                name,
                description,
                move |ime, call| async move { ime.control(control, &call).await },
            );
        }
        service
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().expect("input method state lock poisoned")
    }

    fn publish_status(&self, state: &State, kind: UpdateKind) {
        #[derive(Serialize)]
        struct Snapshot<'a> {
            #[serde(flatten)]
            settings: &'a ImeSettings,
            #[serde(flatten)]
            status: &'a Status,
        }
        publish(
            &self.hub,
            STATUS,
            &Snapshot {
                settings: &state.settings,
                status: &state.status,
            },
            kind,
        );
    }

    fn publish_panel(&self, state: &State, kind: UpdateKind) {
        publish(&self.hub, PANEL, &state.panel, kind);
    }

    fn reset_source(&self, state: &mut State) {
        state.panel_registered = false;
        state.panel_enabled = None;
        state.controller_enabled = None;
        state.status = Status::default();
        state.panel = Panel::default();
        self.publish_status(state, UpdateKind::SourceBaseline);
        self.publish_panel(state, UpdateKind::SourceBaseline);
    }

    pub(crate) fn set_settings(&self, settings: ImeSettings) {
        let mut state = self.state();
        if state.settings == settings {
            return;
        }
        let old_mode = state.settings.mode;
        state.settings = settings;
        let mode = state.settings.mode;
        if old_mode != mode {
            state.generation += 1;
            state.connection = None;
            state.controller = None;
            state.panel_sender = None;
            state.panel_claimed = false;
            self.reset_source(&mut state);
            self.mode.send_replace(mode);
        } else {
            self.publish_status(&state, UpdateKind::SourceBaseline);
            let preferred = state.settings.candidate_layout;
            if state.lock == ImeLockState::Unlocked
                && state.panel_claimed
                && state.panel.set_layout(preferred)
            {
                self.publish_panel(&state, UpdateKind::SourceBaseline);
            }
        }
    }

    pub(crate) fn set_locked(&self, lock: ImeLockState) {
        let mut state = self.state();
        if state.lock != lock {
            state.lock = lock;
            if lock == ImeLockState::Locked {
                state.panel = Panel::default();
                self.publish_panel(&state, UpdateKind::SourceBaseline);
            }
        }
    }

    fn accepts_panel(state: &State, generation: u64, sender: &str) -> bool {
        state.generation == generation
            && state.panel_claimed
            && state
                .panel_sender
                .as_ref()
                .is_some_and(|owner| owner.as_str() == sender)
    }

    fn update_panel(&self, generation: u64, sender: &str, update: Composition) {
        let mut state = self.state();
        if state.lock == ImeLockState::Unlocked && Self::accepts_panel(&state, generation, sender) {
            let preferred = state.settings.candidate_layout;
            if state.panel.apply(update, preferred) {
                self.publish_panel(&state, UpdateKind::Live);
            }
        }
    }

    // Returns whether Controller1 metadata may have changed, not whether the panel changed.
    fn panel_event(&self, generation: u64, sender: &str, event: Event) -> bool {
        if let Event::Composition(update) = event {
            self.update_panel(generation, sender, update);
            return false;
        }
        let mut state = self.state();
        if !Self::accepts_panel(&state, generation, sender) {
            return false;
        }
        let mut baseline = !state.status.available;
        let (changed, refresh) = match event {
            Event::RegisterProperties(properties) => {
                baseline |= !state.panel_registered;
                state.panel_registered = true;
                let im_changed = im_property(&state.status.properties) != im_property(&properties);
                (
                    replace(&mut state.status.properties, properties),
                    im_changed,
                )
            }
            Event::UpdateProperty(property) => {
                let is_im = property.key == IM_PROPERTY;
                let properties = &mut state.status.properties;
                let changed =
                    if let Some(previous) = properties.iter_mut().find(|p| p.key == property.key) {
                        replace(previous, property)
                    } else {
                        properties.push(property);
                        true
                    };
                (changed, is_im)
            }
            Event::RemoveProperty(key) => {
                let is_im = key == IM_PROPERTY;
                let properties = &mut state.status.properties;
                let len = properties.len();
                properties.retain(|p| p.key != key);
                (len != properties.len(), is_im)
            }
            Event::ExecMenu(items) => {
                state.menu_revision += 1;
                state.status.exec_menu = Some(ImeMenu {
                    revision: state.menu_revision,
                    items,
                });
                (true, false)
            }
            Event::Enable(enabled) => {
                state.panel_enabled = Some(enabled);
                (false, false)
            }
            Event::Composition(_) => {
                unreachable!("composition was handled before taking the status lock")
            }
        };
        if changed && refresh {
            state.status.active_im =
                im_property(&state.status.properties).map(|im| ActiveInputMethod {
                    unique_name: None, // Kimpanel properties don't carry the engine ID.
                    label: im.label.clone(),
                    short_label: short_label(
                        im.hints
                            .iter()
                            .filter_map(|hint| hint.strip_prefix("label="))
                            .find(|label| !label.is_empty())
                            .unwrap_or(&im.label),
                    ),
                    icon: (!im.icon.is_empty()).then(|| im.icon.clone()),
                    text: im.text.clone(),
                });
        }
        let enabled = state.is_panel_enabled();
        let status_changed = changed
            | replace(&mut state.status.available, true)
            | replace(&mut state.status.enabled, enabled);
        if status_changed {
            self.publish_status(
                &state,
                if baseline {
                    UpdateKind::SourceBaseline
                } else {
                    UpdateKind::Live
                },
            );
        }
        refresh
    }

    fn update_controller(&self, generation: u64, result: Option<ControllerStatus>) {
        let mut state = self.state();
        if state.generation != generation {
            return;
        }
        match state.settings.mode {
            ImeMode::IndicatorOnly => {
                let baseline = !state.status.available || result.is_none();
                let changed = if let Some(result) = result {
                    replace(&mut state.status.available, true)
                        | replace(&mut state.status.enabled, result.enabled)
                        | replace(&mut state.status.active_im, result.active_im)
                        | replace(&mut state.status.group_ims, result.group_ims)
                } else if state.status.available {
                    state.status = Status::default();
                    true
                } else {
                    false
                };
                if changed {
                    self.publish_status(
                        &state,
                        if baseline {
                            UpdateKind::SourceBaseline
                        } else {
                            UpdateKind::Live
                        },
                    );
                }
            }
            ImeMode::Kimpanel => {
                let baseline = state.controller_enabled.is_none();
                let (controller_enabled, group_ims) = match result {
                    Some(result) => (Some(result.enabled), result.group_ims),
                    None => (None, Vec::new()),
                };
                state.controller_enabled = controller_enabled;
                let enabled = state.is_panel_enabled();
                let changed = replace(&mut state.status.enabled, enabled)
                    | replace(&mut state.status.group_ims, group_ims);
                if state.status.available && changed {
                    self.publish_status(
                        &state,
                        if baseline {
                            UpdateKind::SourceBaseline
                        } else {
                            UpdateKind::Live
                        },
                    );
                }
            }
            _ => {}
        }
    }

    pub(crate) async fn run(
        self: Arc<Self>,
        address: SessionBusAddress,
        mut stop: watch::Receiver<()>,
    ) {
        let mut mode = self.mode.subscribe();
        loop {
            let selected = *mode.borrow_and_update();
            if !matches!(selected, ImeMode::IndicatorOnly | ImeMode::Kimpanel) {
                tokio::select! {
                    biased;
                    _ = stop.changed() => break,
                    _ = mode.changed() => continue,
                }
            }
            let connection = tokio::select! {
                biased;
                _ = stop.changed() => break,
                _ = mode.changed() => continue,
                connection = connect(&address) => connection,
            };
            if let Some(connection) = connection {
                let generation = {
                    let mut state = self.state();
                    if state.settings.mode != selected || mode.has_changed().unwrap_or(true) {
                        continue;
                    }
                    state.generation += 1;
                    state.connection = Some(connection.clone());
                    state.generation
                };
                let exit = tokio::select! {
                    biased;
                    _ = stop.changed() => MonitorExit::Stop,
                    _ = mode.changed() => MonitorExit::ModeChanged,
                    _ = connection.closed() => MonitorExit::Disconnected,
                    result = self.monitor(&connection, selected, generation) => {
                        if let Err(error) = result {
                            tracing::debug!(%error, "input method D-Bus source unavailable");
                        }
                        MonitorExit::Disconnected
                    }
                };
                {
                    let mut state = self.state();
                    if state.generation == generation {
                        state.connection = None;
                        state.controller = None;
                        state.panel_sender = None;
                        state.panel_claimed = false;
                        self.reset_source(&mut state);
                    }
                }
                if selected == ImeMode::Kimpanel && !connection.is_closed() {
                    let _ = connection.release_name(panel::NAME).await;
                }
                let _ = connection.close().await;
                match exit {
                    MonitorExit::Stop => break,
                    MonitorExit::ModeChanged => continue,
                    MonitorExit::Disconnected => {}
                }
            }
            // Retry a lost broker, not Controller1 state or an occupied kimpanel name.
            tokio::select! {
                biased;
                _ = stop.changed() => break,
                _ = mode.changed() => {},
                _ = sleep(RETRY) => {},
            }
        }
    }

    async fn monitor(
        self: &Arc<Self>,
        connection: &Connection,
        mode: ImeMode,
        generation: u64,
    ) -> zbus::Result<()> {
        let dbus = DBusProxy::new(connection).await?;
        let mut messages = MessageStream::from(connection);
        let signal = || MatchRule::builder().msg_type(Type::Signal);
        let names = if mode == ImeMode::Kimpanel {
            &[FCITX, panel::INPUT_METHOD, panel::NAME][..]
        } else {
            &[FCITX][..]
        };
        for name in names {
            dbus.add_match_rule(
                signal()
                    .sender(DBUS)?
                    .interface(DBUS)?
                    .path(DBUS_PATH)?
                    .member(OWNER_CHANGED)?
                    .arg(0, *name)?
                    .build(),
            )
            .await?;
        }
        dbus.add_match_rule(
            signal()
                .interface(CONTROLLER)?
                .path(CONTROLLER_PATH)?
                .member(GROUP_CHANGED)?
                .build(),
        )
        .await?;
        let mut input_method = Owner::default();
        if mode == ImeMode::Kimpanel {
            dbus.add_match_rule(signal().interface(panel::INPUT_METHOD)?.build())
                .await?;
            panel::export(connection, self, generation).await?;
            input_method = Owner::read(connection, panel::INPUT_METHOD).await?;
        }
        let mut controller = Owner::read(connection, FCITX).await?;
        self.set_owners(generation, &controller, &input_method);
        let mut claimed =
            mode == ImeMode::Kimpanel && self.claim_panel(connection, generation).await?;

        let mut request = None;
        let mut refresh = true;
        loop {
            if refresh && request.is_none() && (mode == ImeMode::IndicatorOnly || claimed) {
                refresh = false;
                if let Some(owner) = &controller.name {
                    request = Some(Box::pin(read_controller(connection, owner.clone(), mode)));
                }
            }
            let next_message = poll_fn(|cx| Pin::new(&mut messages).poll_next(cx));
            tokio::select! {
                message = next_message => {
                    let Some(message) = message else { return Ok(()) };
                    let message = message?;
                    let header = message.header();
                    if header.message_type() != Type::Signal { continue; }
                    let (Some(sender), Some(interface), Some(member)) = (header.sender(), header.interface(), header.member()) else { continue };
                    let sender = sender.as_str();
                    match (interface.as_str(), member.as_str()) {
                        (DBUS, OWNER_CHANGED) if sender == DBUS => {
                            let body = message.body();
                            let Ok((name, previous, next)) = body.deserialize::<(&str, &str, &str)>() else { continue };
                            let position = message.recv_position();
                            if name == FCITX && controller.change(next, position) {
                                // If Controller1 and kimpanel were the same process, do not keep
                                // accepting the old sender while its other name-loss signal is pending.
                                if input_method.is(previous) && input_method.position < position {
                                    input_method.name = None;
                                }
                                self.set_owners(generation, &controller, &input_method);
                                request = None;
                                refresh = true;
                            } else if name == panel::INPUT_METHOD && input_method.change(next, position) {
                                self.set_owners(generation, &controller, &input_method);
                                refresh = true;
                            } else if name == panel::NAME && !claimed && next.is_empty() {
                                claimed = self.claim_panel(connection, generation).await?;
                                refresh |= claimed;
                            }
                        }
                        (CONTROLLER, GROUP_CHANGED) if controller.is(sender) && header.path().is_some_and(|path| path.as_str() == CONTROLLER_PATH) => {
                            refresh = true;
                        }
                        (panel::INPUT_METHOD, _) if claimed && input_method.panel_sender(&controller).is_some_and(|name| name.as_str() == sender) => {
                            if let Some(event) = panel::parse_signal(&message) {
                                refresh |= self.panel_event(generation, sender, event);
                            }
                        }
                        _ => {}
                    }
                }
                _ = self.refresh.notified(), if mode == ImeMode::IndicatorOnly => {
                    refresh = true;
                }
                result = async {
                    match request.as_mut() {
                        Some(request) => request.await,
                        None => pending().await,
                    }
                } => {
                    request = None;
                    self.update_controller(generation, result);
                }
            }
        }
    }

    fn set_owners(&self, generation: u64, controller: &Owner, input_method: &Owner) {
        let mut state = self.state();
        if state.generation != generation {
            return;
        }
        let panel_sender = if state.settings.mode == ImeMode::Kimpanel {
            input_method.panel_sender(controller)
        } else {
            None
        };
        let controller_changed = state.controller.as_ref() != controller.name.as_ref();
        let panel_changed = state.panel_sender.as_ref() != panel_sender;
        if controller_changed {
            state.controller.clone_from(&controller.name);
        }
        if panel_changed {
            state.panel_sender = panel_sender.cloned();
        }
        if (panel_changed && state.panel_claimed)
            || (controller_changed
                && state.settings.mode == ImeMode::IndicatorOnly
                && state.status.available)
        {
            self.reset_source(&mut state);
        }
    }

    async fn claim_panel(&self, connection: &Connection, generation: u64) -> zbus::Result<bool> {
        match connection
            .request_name_with_flags(panel::NAME, RequestNameFlags::DoNotQueue.into())
            .await
        {
            Ok(RequestNameReply::PrimaryOwner | RequestNameReply::AlreadyOwner) => {}
            Ok(_) | Err(zbus::Error::NameTaken) => return Ok(false),
            Err(error) => return Err(error),
        }
        {
            let mut state = self.state();
            if state.generation != generation {
                return Ok(false);
            }
            state.panel_claimed = true;
        }
        panel::announce(connection).await?;
        Ok(true)
    }

    async fn control(
        &self,
        control: Control,
        call: &CommandCall,
    ) -> Result<CommandInvokeResult, RpcError> {
        let (connection, destination, panel_revision) = {
            let state = self.state();
            if state.lock == ImeLockState::Locked && call.caller.role != ClientRole::PrivilegedHost
            {
                return Err(ControlError::Locked.into());
            }
            let mode = state.settings.mode;
            if !matches!(mode, ImeMode::IndicatorOnly | ImeMode::Kimpanel) {
                return Err(ControlError::Disabled.into());
            }
            let via_panel = match control {
                Control::Toggle | Control::SetIm => false,
                Control::ReloadConfig | Control::Configure => mode == ImeMode::Kimpanel,
                _ if mode == ImeMode::Kimpanel => true,
                _ => return Err(ControlError::Disabled.into()),
            };
            let connection = state.connection.as_ref().ok_or(ControlError::Unavailable)?;
            let destination = if via_panel {
                if !state.panel_claimed || state.panel_sender.is_none() {
                    return Err(ControlError::Unavailable.into());
                }
                None
            } else {
                Some(state.controller.clone().ok_or(ControlError::Unavailable)?)
            };
            (
                connection.clone(),
                destination,
                state.status.exec_menu.as_ref().map(|menu| menu.revision),
            )
        };
        let menu_key = match (destination.as_ref(), control) {
            (Some(owner), control) => {
                let owner = owner.as_str();
                match control {
                    Control::Toggle => controller_call(&connection, owner, "Toggle", &()).await,
                    Control::SetIm => {
                        let input: SetIm<'_> = payload(call)?;
                        controller_call(&connection, owner, "SetCurrentIM", &(input.unique_name,))
                            .await
                    }
                    Control::ReloadConfig => {
                        controller_call(&connection, owner, "ReloadConfig", &()).await
                    }
                    Control::Configure => {
                        controller_call(&connection, owner, "Configure", &()).await
                    }
                    _ => return Err(ControlError::Disabled.into()),
                }
                .map_err(ControlError::from)?;
                if matches!(control, Control::Toggle | Control::SetIm) {
                    self.refresh.notify_one();
                }
                None
            }
            (None, Control::TriggerProperty) => {
                let input: TriggerProperty<'_> = payload(call)?;
                panel_signal(&connection, "TriggerProperty", &(input.key,))
                    .await
                    .map_err(ControlError::from)?;
                Some(input.key)
            }
            (None, control) => {
                match control {
                    Control::SelectCandidate => {
                        let input: SelectCandidate = payload(call)?;
                        panel_signal(&connection, "SelectCandidate", &(input.index,)).await
                    }
                    Control::MoveCaret => {
                        let input: MoveCaret = payload(call)?;
                        panel_signal(&connection, "MovePreeditCaret", &(input.position,)).await
                    }
                    Control::PageUp => panel_signal(&connection, "LookupTablePageUp", &()).await,
                    Control::PageDown => {
                        panel_signal(&connection, "LookupTablePageDown", &()).await
                    }
                    Control::ReloadConfig => panel_signal(&connection, "ReloadConfig", &()).await,
                    Control::Configure => panel_signal(&connection, "Configure", &()).await,
                    _ => return Err(ControlError::Disabled.into()),
                }
                .map_err(ControlError::from)?;
                None
            }
        };
        if let Some(key) = menu_key {
            let mut state = self.state();
            if state.status.exec_menu.as_ref().is_some_and(|menu| {
                Some(menu.revision) == panel_revision
                    && menu.items.iter().any(|item| item.key == key)
            }) {
                state.status.exec_menu = None;
                self.publish_status(&state, UpdateKind::Live);
            }
        }
        Ok(ok())
    }
}

impl State {
    fn is_panel_enabled(&self) -> bool {
        self.panel_enabled != Some(false)
            && self
                .controller_enabled
                .or(self.panel_enabled)
                .unwrap_or(self.status.active_im.is_some())
    }
}

fn im_property(properties: &[ImeProperty]) -> Option<&ImeProperty> {
    properties
        .iter()
        .find(|property| property.key == IM_PROPERTY)
}

enum MonitorExit {
    Stop,
    ModeChanged,
    Disconnected,
}

#[derive(Default)]
struct Owner {
    name: Option<OwnedUniqueName>,
    observed_owner: bool,
    position: Sequence,
}

impl Owner {
    async fn read(connection: &Connection, name: &str) -> zbus::Result<Self> {
        match connection
            .call_method(Some(DBUS), DBUS_PATH, Some(DBUS), "GetNameOwner", &(name,))
            .await
        {
            Ok(message) => Ok(Self {
                name: Some(message.body().deserialize()?),
                observed_owner: true,
                position: message.recv_position(),
            }),
            Err(zbus::Error::MethodError(name, _, message))
                if name.as_str() == "org.freedesktop.DBus.Error.NameHasNoOwner" =>
            {
                Ok(Self {
                    name: None,
                    observed_owner: false,
                    position: message.recv_position(),
                })
            }
            Err(error) => Err(error),
        }
    }

    fn change(&mut self, next: &str, position: Sequence) -> bool {
        if self.position >= position {
            return false;
        }
        self.position = position;
        let next = OwnedUniqueName::try_from(next).ok();
        self.observed_owner |= next.is_some();
        replace(&mut self.name, next)
    }

    fn is(&self, sender: &str) -> bool {
        self.name
            .as_ref()
            .is_some_and(|name| name.as_str() == sender)
    }

    fn panel_sender<'a>(&'a self, controller: &'a Self) -> Option<&'a OwnedUniqueName> {
        // Some versions or peers emit kimpanel signals from the controller name
        // alone. Once the addon advertises its own name, its loss ends the source
        // even if the controller is still running on the same connection.
        if self.observed_owner {
            self.name.as_ref()
        } else {
            controller.name.as_ref()
        }
    }
}

#[derive(Clone, Copy)]
enum Control {
    Toggle,
    SetIm,
    TriggerProperty,
    SelectCandidate,
    PageUp,
    PageDown,
    MoveCaret,
    ReloadConfig,
    Configure,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SetIm<'a> {
    unique_name: &'a str,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TriggerProperty<'a> {
    key: &'a str,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SelectCandidate {
    index: i32,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MoveCaret {
    position: i32,
}

#[derive(Debug, thiserror::Error)]
enum ControlError {
    #[error("public input method commands are denied while the session is locked")]
    Locked,
    #[error("input method command is disabled in this mode")]
    Disabled,
    #[error("input method backend is unavailable")]
    Unavailable,
    #[error("input method D-Bus command failed")]
    Transport(#[from] zbus::Error),
}

impl From<ControlError> for RpcError {
    fn from(error: ControlError) -> Self {
        match &error {
            ControlError::Locked => Self::new(ErrorCode::PermissionDenied, error.to_string()),
            ControlError::Disabled => disabled("input method command is disabled in this mode"),
            ControlError::Unavailable => disabled("input method backend is unavailable"),
            ControlError::Transport(source) => {
                tracing::debug!(%source, "input method command failed");
                Self::new(ErrorCode::Internal, error.to_string())
            }
        }
    }
}

async fn panel_signal<T: Serialize + DynamicType>(
    connection: &Connection,
    name: &str,
    body: &T,
) -> zbus::Result<()> {
    connection
        .emit_signal(None::<&str>, panel::PATH, panel::NAME, name, body)
        .await
}

async fn controller_call<T: Serialize + DynamicType>(
    connection: &Connection,
    owner: &str,
    name: &str,
    body: &T,
) -> zbus::Result<Message> {
    connection
        .call_method(Some(owner), CONTROLLER_PATH, Some(CONTROLLER), name, body)
        .await
}

struct ControllerStatus {
    enabled: bool,
    active_im: Option<ActiveInputMethod>,
    group_ims: Vec<GroupInputMethod>,
}

type LegacyImInfo = (String, String, String, String, String, String, bool);
type ImInfo = (
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    bool,
    String,
    HashMap<String, OwnedValue>,
);

async fn read_controller(
    connection: &Connection,
    owner: OwnedUniqueName,
    mode: ImeMode,
) -> Option<ControllerStatus> {
    let owner = owner.as_str();
    let state = controller_call(connection, owner, "State", &());
    let active = async {
        if mode != ImeMode::IndicatorOnly {
            return None;
        }
        let (current, info) = tokio::join!(
            controller_call(connection, owner, "CurrentInputMethod", &()),
            controller_call(connection, owner, "CurrentInputMethodInfo", &()),
        );
        let current = current
            .ok()
            .and_then(|message| message.body().deserialize::<String>().ok())
            .filter(|id| !id.is_empty());
        let info = info.ok().and_then(|message| {
            let body = message.body();
            // Fcitx 5.1+ has additional metadata; older daemons either return
            // the shorter entry format or omit CurrentInputMethodInfo entirely.
            body.deserialize::<ImInfo>()
                .ok()
                .map(|(id, name, native, icon, label, _, _, _, _, _)| {
                    (id, name, native, icon, label)
                })
                .or_else(|| {
                    body.deserialize::<LegacyImInfo>().ok().map(
                        |(id, name, native, icon, label, _, _)| (id, name, native, icon, label),
                    )
                })
        });
        if let Some((id, name, native, icon, short)) = info
            && !id.is_empty()
            && current.as_ref().is_none_or(|current| *current == id)
        {
            let label = if name.is_empty() { id.clone() } else { name };
            return Some(ActiveInputMethod {
                unique_name: Some(id),
                short_label: short_label(if short.is_empty() { &label } else { &short }),
                label,
                icon: (!icon.is_empty()).then_some(icon),
                text: native,
            });
        }
        current.map(|id| ActiveInputMethod {
            short_label: short_label(&id),
            label: id.clone(),
            unique_name: Some(id),
            icon: None,
            text: String::new(),
        })
    };
    let group = async {
        let message = controller_call(connection, owner, "CurrentInputMethodGroup", &())
            .await
            .ok()?;
        let body = message.body();
        let group = body.deserialize::<&str>().ok()?;
        if group.is_empty() {
            return None;
        }
        let args = (group,);
        let (entries, all) = tokio::join!(
            controller_call(connection, owner, "InputMethodGroupInfo", &args),
            controller_call(connection, owner, "AvailableInputMethods", &()),
        );
        let (_, entries) = entries
            .ok()?
            .body()
            .deserialize::<(String, Vec<(String, String)>)>()
            .ok()?;
        let mut labels: HashMap<_, _> = all
            .ok()
            .and_then(|message| message.body().deserialize::<Vec<LegacyImInfo>>().ok())
            .into_iter()
            .flatten()
            .filter_map(|(id, label, _, _, _, _, _)| (!label.is_empty()).then_some((id, label)))
            .collect();
        Some(
            entries
                .into_iter()
                .map(|(unique_name, layout)| GroupInputMethod {
                    label: labels
                        .remove(&unique_name)
                        .unwrap_or_else(|| unique_name.clone()),
                    unique_name,
                    layout,
                })
                .collect(),
        )
    };
    let (state, active_im, group_ims) = tokio::join!(state, active, group);
    Some(ControllerStatus {
        enabled: state.ok()?.body().deserialize::<i32>().ok()? == 2,
        active_im,
        group_ims: group_ims.unwrap_or_default(),
    })
}

fn short_label(label: &str) -> String {
    let mut chars = label.char_indices();
    let Some((_, first)) = chars.next() else {
        return String::new();
    };
    let end = match chars.next() {
        Some((_, second)) if first < '\u{7f}' && second < '\u{7f}' => 2,
        _ => first.len_utf8(),
    };
    label[..end].to_owned()
}

fn replace<T: PartialEq>(current: &mut T, next: T) -> bool {
    if *current == next {
        return false;
    }
    *current = next;
    true
}
