//! `z-shelld` executable entry point with SIGINT and SIGTERM graceful shutdown.

use anyhow::{Context, Result, bail};
use std::path::PathBuf;
use tokio::signal::unix::{SignalKind, signal};
use tracing_subscriber::EnvFilter;
use z_shell_config::ShellPaths;
use z_shelld::DaemonApp;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_target(false)
        .init();

    let paths = parse_args(std::env::args().skip(1))?;
    let app = DaemonApp::bootstrap(paths)?;
    let shutdown = app.shutdown_handle();

    tokio::spawn(async move {
        let mut sigterm = signal(SignalKind::terminate()).ok();
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = async {
                if let Some(ref mut s) = sigterm {
                    s.recv().await;
                } else {
                    std::future::pending::<()>().await;
                }
            } => {}
        }
        shutdown.shutdown();
    });

    app.run().await
}

fn parse_args(mut args: impl Iterator<Item = String>) -> Result<ShellPaths> {
    let mut config_dir: Option<PathBuf> = None;
    let mut state_dir: Option<PathBuf> = None;
    let mut runtime_dir: Option<PathBuf> = None;
    let mut socket_path: Option<PathBuf> = None;
    let mut host_socket_path: Option<PathBuf> = None;

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--config-dir" => config_dir = Some(next_path(&mut args, "--config-dir")?),
            "--state-dir" => state_dir = Some(next_path(&mut args, "--state-dir")?),
            "--runtime-dir" => runtime_dir = Some(next_path(&mut args, "--runtime-dir")?),
            "--socket" => socket_path = Some(next_path(&mut args, "--socket")?),
            "--host-socket" => host_socket_path = Some(next_path(&mut args, "--host-socket")?),
            "--help" | "-h" => {
                println!(
                    "Usage: z-shelld [--socket PATH] [--host-socket PATH] [--config-dir PATH] [--state-dir PATH] [--runtime-dir PATH]"
                );
                std::process::exit(0);
            }
            other => bail!("unknown flag: {other}"),
        }
    }

    // If all roots are supplied explicitly (for tests/containers without XDG_RUNTIME_DIR),
    // skip consulting environment variables.
    if let (Some(cfg), Some(st), Some(rt)) = (&config_dir, &state_dir, &runtime_dir) {
        let sock = socket_path.unwrap_or_else(|| rt.join("bus.sock"));
        let mut paths = ShellPaths::from_roots(cfg.clone(), st.clone(), rt.clone(), sock);
        if let Some(host_sock) = host_socket_path {
            paths = paths.with_host_socket_path(host_sock);
        }
        return Ok(paths);
    }

    let base = ShellPaths::from_env().context("resolving XDG paths (XDG_RUNTIME_DIR required)")?;
    let resolved_runtime = runtime_dir.unwrap_or_else(|| base.runtime_dir().to_path_buf());
    let resolved_socket = socket_path.unwrap_or_else(|| {
        if resolved_runtime == base.runtime_dir() {
            base.socket_path().to_path_buf()
        } else {
            resolved_runtime.join("bus.sock")
        }
    });
    let mut paths = ShellPaths::from_roots(
        config_dir.unwrap_or_else(|| base.config_dir().to_path_buf()),
        state_dir.unwrap_or_else(|| base.state_dir().to_path_buf()),
        resolved_runtime,
        resolved_socket,
    );
    if let Some(host_sock) = host_socket_path {
        paths = paths.with_host_socket_path(host_sock);
    } else if paths.runtime_dir() == base.runtime_dir() {
        paths = paths.with_host_socket_path(base.host_socket_path().to_path_buf());
    }
    Ok(paths)
}

fn next_path(args: &mut impl Iterator<Item = String>, flag: &str) -> Result<PathBuf> {
    args.next()
        .map(PathBuf::from)
        .with_context(|| format!("{flag} requires a path argument"))
}
