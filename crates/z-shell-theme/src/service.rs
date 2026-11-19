//! Theme topic publication and `theme.*` core control commands.

use crate::engine::WeakThemeEngine;
use crate::{GenerationOutcome, ThemeEngine, ThemeError, ThemeSnapshot, ThemeSource};
use serde::Deserialize;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;
use z_shell_bus::{BusHub, CommandCall, CommandHandler, UpdateKind};
use z_shell_config::{ThemeBackend, ThemeMode, ThemeVariant};
use z_shell_protocol::{CommandInvokeResult, CommandName, ErrorCode, RpcError};

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct ThemeSetParams {
    mode: Option<ThemeMode>,
    variant: Option<ThemeVariant>,
    seed: Option<String>,
    wallpaper: Option<PathBuf>,
    backend: Option<ThemeBackend>,
    gtk_linking: Option<bool>,
    local_hour: Option<u8>,
}

impl ThemeEngine {
    /// Publishes the current theme baseline and registers core theme commands.
    pub async fn register_bus(&self, hub: &BusHub) {
        self.attach_hub(hub.clone());
        self.publish(&self.snapshot().await, UpdateKind::SourceBaseline);
        let weak = self.downgrade();
        register_get(hub, weak.clone());
        register_set(hub, weak.clone());
        register_retry(hub, weak);
    }

    /// Synchronously installs a freshly constructed [`ThemeEngine`] onto `hub` before serving clients.
    pub fn install_on_bus(&self, hub: &BusHub) {
        self.attach_hub(hub.clone());
        if let Some(snapshot) = self.try_snapshot() {
            self.publish(&snapshot, UpdateKind::SourceBaseline);
        }
        let weak = self.downgrade();
        register_get(hub, weak.clone());
        register_set(hub, weak.clone());
        register_retry(hub, weak);
    }
}

fn register_get(hub: &BusHub, engine: WeakThemeEngine) {
    let handler: CommandHandler = Arc::new(move |_call: CommandCall| {
        let engine = engine.clone();
        Box::pin(async move {
            let engine = upgrade(&engine)?;
            result(snapshot_json(engine.snapshot().await)?)
        })
    });
    hub.register_core_command(
        command("theme.get"),
        "Return the last committed Material color scheme",
        handler,
    );
}

fn register_set(hub: &BusHub, engine: WeakThemeEngine) {
    let handler: CommandHandler = Arc::new(move |call: CommandCall| {
        let engine = engine.clone();
        Box::pin(async move {
            let engine = upgrade(&engine)?;
            let params: ThemeSetParams = parse_params(call.params.payload)?;
            if params.seed.is_some() && params.wallpaper.is_some() {
                return Err(RpcError::new(
                    ErrorCode::InvalidParams,
                    "theme.set accepts either seed or wallpaper, not both",
                ));
            }
            if params
                .wallpaper
                .as_ref()
                .is_some_and(|path| path.as_os_str().is_empty())
            {
                return Err(RpcError::new(
                    ErrorCode::InvalidParams,
                    "theme.set wallpaper must not be empty",
                ));
            }
            let request = engine
                .successor(|request| {
                    if let Some(mode) = params.mode {
                        request.mode = mode;
                    }
                    if let Some(variant) = params.variant {
                        request.variant = variant;
                    }
                    if let Some(backend) = params.backend {
                        request.backend = backend;
                    }
                    if let Some(gtk_linking) = params.gtk_linking {
                        request.gtk_linking = gtk_linking;
                    }
                    if let Some(local_hour) = params.local_hour {
                        request.local_hour = local_hour;
                    }
                    if let Some(seed) = params.seed {
                        request.source = ThemeSource::Seed(seed);
                    } else if let Some(wallpaper) = params.wallpaper {
                        request.source = ThemeSource::WallpaperPath(wallpaper);
                    }
                })
                .await;
            let snapshot = generate(engine, request).await?;
            result(snapshot_json(snapshot)?)
        })
    });
    hub.register_core_command(
        command("theme.set"),
        "Generate a theme from updated mode, variant, source, backend, or GTK settings",
        handler,
    );
}

fn register_retry(hub: &BusHub, engine: WeakThemeEngine) {
    let handler: CommandHandler = Arc::new(move |_call: CommandCall| {
        let engine = engine.clone();
        Box::pin(async move {
            let engine = upgrade(&engine)?;
            let request = engine.successor(|_| {}).await;
            let snapshot = generate(engine, request).await?;
            result(snapshot_json(snapshot)?)
        })
    });
    hub.register_core_command(
        command("theme.retry"),
        "Retry the latest generation request with a new sequence number",
        handler,
    );
}

fn upgrade(engine: &WeakThemeEngine) -> Result<ThemeEngine, RpcError> {
    engine
        .upgrade()
        .ok_or_else(|| RpcError::new(ErrorCode::Internal, "theme engine has been shut down"))
}

async fn generate(
    engine: ThemeEngine,
    request: crate::GenerationRequest,
) -> Result<ThemeSnapshot, RpcError> {
    match engine.generate(request).await.map_err(theme_rpc_error)? {
        GenerationOutcome::Committed(snapshot) => Ok(snapshot),
        GenerationOutcome::Superseded => Ok(engine.snapshot().await),
    }
}

fn parse_params<T: serde::de::DeserializeOwned>(payload: Option<Value>) -> Result<T, RpcError> {
    serde_json::from_value(payload.unwrap_or_else(|| Value::Object(Default::default()))).map_err(
        |error| {
            RpcError::new(
                ErrorCode::InvalidParams,
                format!("invalid theme parameters: {error}"),
            )
        },
    )
}

fn theme_rpc_error(error: ThemeError) -> RpcError {
    let code = match &error {
        ThemeError::InvalidSeed(_) | ThemeError::InvalidPalette(_) => ErrorCode::InvalidParams,
        ThemeError::MatugenUnavailable => ErrorCode::Disabled,
        _ => ErrorCode::Internal,
    };
    RpcError::new(code, error.to_string())
}

fn snapshot_json(snapshot: ThemeSnapshot) -> Result<Value, RpcError> {
    serde_json::to_value(snapshot).map_err(|error| {
        RpcError::new(
            ErrorCode::Internal,
            format!("could not serialize theme snapshot: {error}"),
        )
    })
}

fn result(data: Value) -> Result<CommandInvokeResult, RpcError> {
    Ok(CommandInvokeResult {
        message: None,
        data: Some(data),
    })
}

fn command(name: &str) -> CommandName {
    CommandName::try_new(name).expect("static theme command name is valid")
}
