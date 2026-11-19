use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::oneshot;
use tokio::time::Instant;
use z_shell_bus::{BusHub, CommandCall, UpdateKind};
use z_shell_config::{ConfigStore, ShellPaths};
use z_shell_protocol::{
    ClientMessage, ClientRole, CommandInvokeResult, ErrorCode, MAX_SAFE_JS_INT, MediaRef,
    PluginEntryId, RequestId, RpcError, ServerMessage,
};

use crate::apps::{self, Catalog, MAX_ACTIONS};
use crate::{data, disabled, failed, invalid, not_found, ok, payload, publish, register};

const APPS_TOPIC: &str = "desktop.apps";
const APPS: &str = "desktop";
const QUERY_BYTES: usize = 256;
const MAX_ITEMS: usize = 48;
const MAX_PENDING: usize = 512;
const MAX_PROVIDERS_PER_CLIENT: usize = 8;
const QUERY_TIMEOUT: Duration = Duration::from_millis(750);
const ACTIVATION_TIMEOUT: Duration = Duration::from_secs(2);
const REAP_INTERVAL: Duration = Duration::from_secs(1);

/// Installed app catalog and authenticated launcher sessions.
#[derive(Debug)]
pub(crate) struct Launcher {
    state: Mutex<State>,
    pin_write: Mutex<()>,
    store: ConfigStore,
    children: Arc<Mutex<Vec<Child>>>,
}

#[derive(Debug, Default)]
struct State {
    disconnected: bool,
    apps: Option<Catalog>,
    pinned_apps: Vec<String>,
    providers: BTreeMap<String, Provider>,
    queries: HashMap<u64, QuerySlot>,
    pending: HashMap<u64, PendingReply>,
    last_request_id: u64,
}

#[derive(Serialize)]
struct AppStatus<'a> {
    available: bool,
    count: usize,
    pinned_apps: &'a [String],
}

#[derive(Debug)]
struct Provider {
    owner: u64,
    entry: PluginEntryId,
    prefix: String,
}

#[derive(Debug)]
struct QuerySlot {
    id: u64,
    cancel: Option<oneshot::Sender<()>>,
    targets: Vec<Target>,
}

#[derive(Debug)]
struct Target {
    provider: String,
    item: String,
    actions: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Action {
    action_id: String,
    title: String,
}

#[derive(Debug, Serialize)]
struct Item {
    provider_id: String,
    item_id: String,
    title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    subtitle: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    icon: Option<MediaRef>,
    actions: Vec<Action>,
    score: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pinned: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct ProviderItem {
    item_id: String,
    title: String,
    subtitle: Option<String>,
    #[serde(default)]
    actions: Vec<Action>,
    #[serde(default)]
    score: u32,
}

#[derive(Debug, Clone, Copy)]
enum Scope {
    Query(u64),
    Activation,
}

#[derive(Debug)]
struct PendingReply {
    owner: u64,
    provider: String,
    scope: Scope,
    reply: oneshot::Sender<Reply>,
}

#[derive(Debug)]
enum Reply {
    Items(Vec<ProviderItem>),
    Activation(bool),
}

struct Request<'a> {
    id: u64,
    rx: oneshot::Receiver<Reply>,
    state: &'a Mutex<State>,
}

impl Drop for Request<'_> {
    fn drop(&mut self) {
        self.state
            .lock()
            .expect("launcher state lock poisoned")
            .pending
            .remove(&self.id);
    }
}

impl Request<'_> {
    async fn until(&mut self, until: Instant) -> Result<Reply, RpcError> {
        // Other requests waited against the same deadline, but an already queued reply is ready.
        if let Ok(reply) = self.rx.try_recv() {
            return Ok(reply);
        }
        tokio::time::timeout_at(until, &mut self.rx)
            .await
            .map_err(|_| RpcError::new(ErrorCode::Timeout, "launcher provider did not reply"))?
            .map_err(|_| not_found("launcher provider or request is no longer active"))
    }
}

#[derive(Deserialize)]
struct List {
    #[serde(default)]
    offset: usize,
    limit: Option<usize>,
}

#[derive(Deserialize)]
struct PinApp {
    id: String,
    pinned: bool,
}

#[derive(Deserialize)]
struct Query {
    #[serde(default)]
    query: String,
    query_id: Option<u64>,
    limit: Option<usize>,
}

#[derive(Deserialize)]
struct Activate {
    query_id: Option<u64>,
    provider_id: String,
    item_id: String,
    action_id: Option<String>,
}

#[derive(Deserialize)]
struct RegisterProvider {
    entry: PluginEntryId,
    #[serde(default)]
    prefix: String,
}

#[derive(Deserialize)]
struct UnregisterProvider {
    provider_id: String,
}

#[derive(Deserialize)]
struct ProviderReply {
    request_id: u64,
    items: Option<Vec<ProviderItem>>,
    activated: Option<bool>,
}

impl State {
    fn ensure_connected(&self) -> Result<(), RpcError> {
        if self.disconnected {
            Err(disabled("launcher is disconnected"))
        } else {
            Ok(())
        }
    }

    fn status(&self) -> AppStatus<'_> {
        AppStatus {
            available: self.apps.is_some(),
            count: self.apps.as_ref().map_or(0, Catalog::len),
            pinned_apps: &self.pinned_apps,
        }
    }

    fn next_request_id(&mut self) -> Result<u64, RpcError> {
        if self.last_request_id == MAX_SAFE_JS_INT {
            return Err(exhausted("launcher request identifiers exhausted"));
        }
        self.last_request_id += 1;
        Ok(self.last_request_id)
    }

    fn collect_retired(&mut self, hub: &BusHub) {
        self.queries.retain(|&client, _| active_client(hub, client));
        self.providers
            .retain(|_, provider| active_client(hub, provider.owner));
        self.pending.retain(|_, entry| {
            self.providers.contains_key(&entry.provider)
                && match entry.scope {
                    Scope::Query(client) => self.queries.contains_key(&client),
                    Scope::Activation => true,
                }
        });
    }

    fn command(&self, id: &str, action: Option<&str>) -> Result<Command, RpcError> {
        self.ensure_connected()?;
        let apps = self
            .apps
            .as_ref()
            .ok_or_else(|| disabled("app catalog is still loading"))?;
        apps.get(id)
            .and_then(|app| app.command(action))
            .ok_or_else(|| not_found("app or desktop action not found"))
    }

    fn app_items(&self, terms: &[&str], offset: usize, limit: usize) -> Vec<Item> {
        let Some(apps) = &self.apps else {
            return Vec::new();
        };
        if offset >= apps.len() || limit == 0 {
            return Vec::new();
        }
        let pins: HashMap<_, _> = self
            .pinned_apps
            .iter()
            .enumerate()
            .map(|(index, id)| (id.as_str(), index))
            .collect();
        let mut ranked: Vec<_> = apps
            .iter()
            .filter_map(|(id, app)| {
                let score = app.score(terms)?;
                let pinned = pins.get(id.as_str()).copied().unwrap_or(usize::MAX);
                Some((id, app, score, pinned))
            })
            .collect();
        ranked.sort_unstable_by(|left, right| {
            right
                .2
                .cmp(&left.2)
                .then_with(|| left.3.cmp(&right.3))
                .then_with(|| left.1.title.cmp(&right.1.title))
                .then_with(|| left.0.cmp(right.0))
        });
        ranked
            .into_iter()
            .skip(offset)
            .take(limit)
            .map(|(id, app, score, pinned)| Item {
                provider_id: APPS.to_owned(),
                item_id: id.clone(),
                title: app.title.clone(),
                subtitle: app.subtitle.clone(),
                icon: app.icon.clone(),
                actions: app
                    .actions
                    .iter()
                    .map(|action| Action {
                        action_id: action.id.clone(),
                        title: action.title.clone(),
                    })
                    .collect(),
                score,
                pinned: Some(pinned != usize::MAX),
            })
            .collect()
    }
}

impl Launcher {
    pub(crate) fn install(
        hub: &BusHub,
        paths: &ShellPaths,
        data_dirs: Vec<PathBuf>,
        icon_theme: String,
    ) -> Arc<Self> {
        let launcher = Arc::new(Self {
            state: Mutex::new(State::default()),
            pin_write: Mutex::new(()),
            store: ConfigStore::new(paths.clone()),
            children: Arc::default(),
        });
        register(
            hub,
            &launcher,
            "apps.list",
            "List a page of installed XDG apps",
            |this, call| async move { this.list(&call) },
        );
        register(
            hub,
            &launcher,
            "apps.pin",
            "Persist a pinned XDG app (host only)",
            Self::pin,
        );
        register(
            hub,
            &launcher,
            "launcher.query",
            "Query installed apps and registered launcher providers",
            |this, call| async move { this.query(&call).await },
        );
        register(
            hub,
            &launcher,
            "launcher.activate",
            "Activate an item from the caller's current query",
            |this, call| async move { this.activate(&call).await },
        );
        register(
            hub,
            &launcher,
            "launcher.register-provider",
            "Register a connection-scoped launcher provider",
            |this, call| async move { this.register_provider(&call) },
        );
        register(
            hub,
            &launcher,
            "launcher.unregister-provider",
            "Release an owned launcher provider",
            |this, call| async move { this.unregister_provider(&call) },
        );
        register(
            hub,
            &launcher,
            "launcher.provider-reply",
            "Reply to a connection-scoped launcher request",
            |this, call| async move { this.provider_reply(&call) },
        );
        publish(
            hub,
            APPS_TOPIC,
            &State::default().status(),
            UpdateKind::SourceBaseline,
        );
        let weak = Arc::downgrade(&launcher);
        let hub = hub.clone();
        let store = launcher.store.clone();
        let cache_dir = paths.media_dir();
        tokio::task::spawn_blocking(move || {
            let apps = apps::scan(&data_dirs, &icon_theme, &cache_dir);
            let pinned_apps = match store.load_state() {
                Ok(state) => state.pinned_apps,
                Err(err) => {
                    tracing::warn!(error = %err, "cannot read pinned apps from durable state");
                    Vec::new()
                }
            };
            let Some(launcher) = weak.upgrade() else {
                return;
            };
            let mut state = launcher.state.lock().expect("launcher state lock poisoned");
            if !state.disconnected {
                state.apps = Some(apps);
                state.pinned_apps = pinned_apps;
                publish(
                    &hub,
                    APPS_TOPIC,
                    &state.status(),
                    UpdateKind::SourceBaseline,
                );
            }
        });
        launcher
    }

    pub(crate) fn disconnected(&self) {
        let mut state = self.state.lock().expect("launcher state lock poisoned");
        state.disconnected = true;
        state.pending.clear();
        state.queries.clear();
        state.providers.clear();
    }

    fn list(&self, call: &CommandCall) -> Result<CommandInvokeResult, RpcError> {
        let list: List = payload(call)?;
        let state = self.state.lock().expect("launcher state lock poisoned");
        state.ensure_connected()?;
        let status = state.status();
        let items = state.app_items(
            &[],
            list.offset,
            list.limit.unwrap_or(MAX_ITEMS).min(MAX_ITEMS),
        );
        Ok(data(json!({"items": items, "total": status.count})))
    }

    async fn pin(self: Arc<Self>, call: CommandCall) -> Result<CommandInvokeResult, RpcError> {
        if call.caller.role != ClientRole::PrivilegedHost {
            return Err(denied(
                "persisting pinned apps requires the host control channel",
            ));
        }
        let pin: PinApp = payload(&call)?;
        tokio::task::spawn_blocking(move || {
            let _write = self
                .pin_write
                .lock()
                .expect("launcher pin write lock poisoned");
            {
                let state = self.state.lock().expect("launcher state lock poisoned");
                state.ensure_connected()?;
                let apps = state
                    .apps
                    .as_ref()
                    .ok_or_else(|| disabled("app catalog is still loading"))?;
                // Removed desktop files may still be unpinned.
                if pin.pinned && !apps.contains_key(&pin.id) {
                    return Err(not_found("only installed desktop IDs can be pinned"));
                }
            }
            let committed = self
                .store
                .update_state(|state| {
                    if pin.pinned {
                        if !state.pinned_apps.contains(&pin.id) {
                            state.pinned_apps.push(pin.id);
                        }
                    } else {
                        state.pinned_apps.retain(|id| *id != pin.id);
                    }
                    Ok(())
                })
                .map_err(|err| {
                    tracing::warn!(error = %err, "cannot persist pinned apps");
                    failed("cannot persist pinned apps")
                })?;
            let mut state = self.state.lock().expect("launcher state lock poisoned");
            if !state.disconnected && state.pinned_apps != committed.pinned_apps {
                state.pinned_apps = committed.pinned_apps;
                publish(&call.hub, APPS_TOPIC, &state.status(), UpdateKind::Live);
            }
            Ok(ok())
        })
        .await
        .map_err(|_| failed("pin write task failed"))?
    }

    async fn execute(&self, mut command: Command) -> Result<CommandInvokeResult, RpcError> {
        let children = Arc::clone(&self.children);
        tokio::task::spawn_blocking(move || {
            let child = command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|err| {
                tracing::warn!(error = %err, program = ?command.get_program(), "cannot launch desktop entry");
                failed("could not launch desktop entry")
            })?;
            let mut active = children.lock().expect("desktop children lock poisoned");
            let start_reaper = active.is_empty();
            active.push(child);
            drop(active);
            if start_reaper {
                tokio::spawn(reap(children));
            }
            Ok(ok())
        }).await.map_err(|_| failed("desktop launch task failed"))?
    }

    fn register_provider(&self, call: &CommandCall) -> Result<CommandInvokeResult, RpcError> {
        let registration: RegisterProvider = payload(call)?;
        if registration.prefix.len() > QUERY_BYTES
            || registration.prefix.chars().any(char::is_control)
        {
            return Err(invalid(
                "provider prefix is too long or contains control characters",
            ));
        }
        let client = call.caller.client_id;
        require_active(&call.hub, client)?;
        let mut state = self.state.lock().expect("launcher state lock poisoned");
        state.ensure_connected()?;
        state.collect_retired(&call.hub);
        let owned = state
            .providers
            .values()
            .filter(|provider| provider.owner == client);
        if owned
            .clone()
            .any(|provider| provider.entry == registration.entry)
        {
            return Err(RpcError::new(
                ErrorCode::AlreadyExists,
                "connection has already registered this launcher entry",
            ));
        }
        if owned.count() >= MAX_PROVIDERS_PER_CLIENT {
            return Err(exhausted("too many launcher providers on this connection"));
        }
        let id = format!("provider-{}", state.next_request_id()?);
        state.providers.insert(
            id.clone(),
            Provider {
                owner: client,
                entry: registration.entry,
                prefix: registration.prefix,
            },
        );
        Ok(data(json!({"provider_id": id})))
    }

    fn unregister_provider(&self, call: &CommandCall) -> Result<CommandInvokeResult, RpcError> {
        let request: UnregisterProvider = payload(call)?;
        let mut state = self.state.lock().expect("launcher state lock poisoned");
        state.ensure_connected()?;
        let entry = state
            .providers
            .get(&request.provider_id)
            .ok_or_else(|| not_found("launcher provider not found"))?;
        if entry.owner != call.caller.client_id {
            return Err(denied("launcher provider belongs to another connection"));
        }
        state.providers.remove(&request.provider_id);
        state
            .pending
            .retain(|_, pending| pending.provider != request.provider_id);
        Ok(ok())
    }

    fn provider_reply(&self, call: &CommandCall) -> Result<CommandInvokeResult, RpcError> {
        let reply: ProviderReply = payload(call)?;
        require_active(&call.hub, call.caller.client_id)?;
        let mut state = self.state.lock().expect("launcher state lock poisoned");
        state.ensure_connected()?;
        let entry = state
            .pending
            .get(&reply.request_id)
            .ok_or_else(|| not_found("launcher request is no longer pending"))?;
        if entry.owner != call.caller.client_id {
            return Err(denied("launcher request belongs to another connection"));
        }
        let reply_value = match (entry.scope, reply.items, reply.activated) {
            (Scope::Query(_), Some(items), None) if valid_items(&items) => Reply::Items(items),
            (Scope::Activation, None, Some(activated)) => Reply::Activation(activated),
            _ => {
                return Err(invalid(
                    "reply shape or items do not match the launcher request",
                ));
            }
        };
        if let Some(entry) = state.pending.remove(&reply.request_id)
            && entry.reply.send(reply_value).is_ok()
        {
            return Ok(ok());
        }
        Err(not_found("launcher request is no longer pending"))
    }

    async fn query(&self, call: &CommandCall) -> Result<CommandInvokeResult, RpcError> {
        let request: Query = payload(call)?;
        if request.query.len() > QUERY_BYTES {
            return Err(invalid("launcher query is too long"));
        }
        let limit = request.limit.unwrap_or(MAX_ITEMS).min(MAX_ITEMS);
        let client = call.caller.client_id;
        require_active(&call.hub, client)?;
        let (cancel, mut canceled) = oneshot::channel();
        let lower = request.query.to_lowercase();
        let terms: Vec<_> = lower.split_whitespace().collect();
        let (query_id, mut items, mut requests) = {
            let mut state = self.state.lock().expect("launcher state lock poisoned");
            state.ensure_connected()?;
            state.collect_retired(&call.hub);
            let latest = state.queries.get(&client).map_or(0, |slot| slot.id);
            let query_id = request.query_id.unwrap_or(latest + 1);
            if query_id <= latest {
                return Err(stale_query());
            }
            if query_id > MAX_SAFE_JS_INT {
                return Err(invalid(
                    "launcher query id is not a safe JavaScript integer",
                ));
            }
            state.queries.insert(
                client,
                QuerySlot {
                    id: query_id,
                    cancel: Some(cancel),
                    targets: Vec::new(),
                },
            );
            state
                .pending
                .retain(|_, entry| !matches!(entry.scope, Scope::Query(owner) if owner == client));
            let items = state.app_items(&terms, 0, limit);
            let mut requests = Vec::new();
            if limit != 0 {
                let providers: Vec<_> = state
                    .providers
                    .iter()
                    .filter_map(|(id, provider)| {
                        request
                            .query
                            .strip_prefix(&provider.prefix)
                            .map(|suffix| (id.clone(), provider.owner, suffix.trim_start()))
                    })
                    .collect();
                requests.reserve(providers.len());
                for (id, owner, query) in providers {
                    if let Ok(pending) = self.dispatch(&mut state, &call.hub, owner, &id, Scope::Query(client), |request_id| {
                        ServerMessage::notification("launcher.provider-query", json!({"request_id": request_id, "query_id": query_id, "provider_id": id, "query": query, "limit": limit}))
                    }) {
                        requests.push((id, pending));
                    } else {
                        break;
                    }
                }
            }
            (query_id, items, requests)
        };
        let deadline = Instant::now() + QUERY_TIMEOUT;
        let gather = async {
            for (provider, request) in &mut requests {
                if let Ok(Reply::Items(received)) = request.until(deadline).await {
                    items.extend(received.into_iter().map(|item| Item {
                        provider_id: provider.clone(),
                        item_id: item.item_id,
                        title: item.title,
                        subtitle: item.subtitle,
                        actions: item.actions,
                        score: item.score,
                        icon: None,
                        pinned: None,
                    }));
                }
            }
        };
        tokio::select! {
            biased;
            _ = &mut canceled => return Err(stale_query()),
            () = gather => {}
        }
        drop(requests);
        // Stable sorting preserves pin order and the provider's tie order.
        items.sort_by_key(|item| std::cmp::Reverse(item.score));
        {
            let mut state = self.state.lock().expect("launcher state lock poisoned");
            state.ensure_connected()?;
            items.retain(|item| {
                item.provider_id == APPS || state.providers.contains_key(&item.provider_id)
            });
            items.truncate(limit);
            let slot = state
                .queries
                .get_mut(&client)
                .filter(|slot| slot.id == query_id)
                .ok_or_else(stale_query)?;
            slot.cancel = None;
            slot.targets = items
                .iter()
                .map(|item| Target {
                    provider: item.provider_id.clone(),
                    item: item.item_id.clone(),
                    actions: item
                        .actions
                        .iter()
                        .map(|action| action.action_id.clone())
                        .collect(),
                })
                .collect();
        }
        Ok(data(json!({"query_id": query_id, "items": items})))
    }

    async fn activate(&self, call: &CommandCall) -> Result<CommandInvokeResult, RpcError> {
        let request: Activate = payload(call)?;
        let client = call.caller.client_id;
        require_active(&call.hub, client)?;
        enum Execute<'a> {
            App(Command),
            Provider(Request<'a>),
        }
        let execute = {
            let mut state = self.state.lock().expect("launcher state lock poisoned");
            state.ensure_connected()?;
            let slot = state
                .queries
                .get(&client)
                .filter(|slot| request.query_id.is_none_or(|id| id == slot.id))
                .ok_or_else(stale_query)?;
            let query_id = slot.id;
            if !slot.targets.iter().any(|target| {
                target.provider == request.provider_id
                    && target.item == request.item_id
                    && request
                        .action_id
                        .as_ref()
                        .is_none_or(|action| target.actions.contains(action))
            }) {
                return Err(not_found(
                    "action does not belong to a result of the current launcher query",
                ));
            }
            if request.provider_id == APPS {
                Execute::App(state.command(&request.item_id, request.action_id.as_deref())?)
            } else {
                let owner = state
                    .providers
                    .get(&request.provider_id)
                    .map(|provider| provider.owner)
                    .filter(|&owner| active_client(&call.hub, owner))
                    .ok_or_else(|| not_found("launcher provider is not active"))?;
                let pending = self.dispatch(&mut state, &call.hub, owner, &request.provider_id, Scope::Activation, |request_id| {
                    ServerMessage::notification("launcher.provider-activate", json!({
                        "request_id": request_id, "query_id": query_id, "provider_id": request.provider_id, "item_id": request.item_id, "action_id": request.action_id,
                    }))
                })?;
                Execute::Provider(pending)
            }
        };
        match execute {
            Execute::App(command) => self.execute(command).await,
            Execute::Provider(mut pending) => {
                match pending.until(Instant::now() + ACTIVATION_TIMEOUT).await? {
                    Reply::Activation(true) => Ok(ok()),
                    _ => Err(failed("launcher provider declined activation")),
                }
            }
        }
    }

    fn dispatch(
        &self,
        state: &mut State,
        hub: &BusHub,
        owner: u64,
        provider: &str,
        scope: Scope,
        event: impl FnOnce(u64) -> ServerMessage,
    ) -> Result<Request<'_>, RpcError> {
        if state.pending.len() >= MAX_PENDING {
            return Err(exhausted("too many pending launcher requests"));
        }
        let id = state.next_request_id()?;
        let (reply, rx) = oneshot::channel();
        state.pending.insert(
            id,
            PendingReply {
                owner,
                provider: provider.to_owned(),
                scope,
                reply,
            },
        );
        hub.enqueue_control(owner, &event(id));
        Ok(Request {
            id,
            rx,
            state: &self.state,
        })
    }
}

async fn reap(children: Arc<Mutex<Vec<Child>>>) {
    loop {
        tokio::time::sleep(REAP_INTERVAL).await;
        let mut active = children.lock().expect("desktop children lock poisoned");
        active.retain_mut(|child| matches!(child.try_wait(), Ok(None)));
        if active.is_empty() {
            break;
        }
    }
}

fn valid_items(items: &[ProviderItem]) -> bool {
    let mut ids = HashSet::with_capacity(items.len().min(MAX_ITEMS));
    items.len() <= MAX_ITEMS
        && items.iter().all(|item| {
            valid_text(&item.item_id, 256)
                && ids.insert(item.item_id.as_str())
                && valid_text(&item.title, 200)
                && item
                    .subtitle
                    .as_ref()
                    .is_none_or(|subtitle| valid_text(subtitle, 300))
                && item.score <= 1000
                && item.actions.len() <= MAX_ACTIONS
                && item.actions.iter().enumerate().all(|(position, action)| {
                    valid_text(&action.action_id, 100)
                        && valid_text(&action.title, 100)
                        && !item.actions[..position]
                            .iter()
                            .any(|previous| previous.action_id == action.action_id)
                })
        })
}

fn valid_text(text: &str, max: usize) -> bool {
    text.len() <= max && !text.trim().is_empty() && !text.chars().any(char::is_control)
}

fn active_client(hub: &BusHub, client: u64) -> bool {
    // A valid inline command request is a read-only probe for a previously authenticated caller:
    // the hub returns CallerContext for a handshaken connection and never invokes the command here.
    // This retains a caller's monotonic watermark until that exact connection is retired.
    hub.handle_inline_message(
        client,
        ClientMessage::request(
            RequestId::Number(0),
            "command.invoke",
            Some(json!({"name": "launcher.query"})),
        ),
    )
    .is_some()
}

fn require_active(hub: &BusHub, client: u64) -> Result<(), RpcError> {
    if active_client(hub, client) {
        Ok(())
    } else {
        Err(not_found("launcher connection is not active"))
    }
}

fn stale_query() -> RpcError {
    invalid("launcher query id is stale or superseded")
}

fn denied(message: &'static str) -> RpcError {
    RpcError::new(ErrorCode::PermissionDenied, message)
}

fn exhausted(message: &'static str) -> RpcError {
    RpcError::new(ErrorCode::ResourceExhausted, message)
}
