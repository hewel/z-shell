use serde_json::json;
use std::fs;
use tempfile::TempDir;
use z_shell_bus::{BusHub, CallerContext};
use z_shell_config::{ThemeBackend, ThemeMode, ThemeVariant};
use z_shell_protocol::{ClientRole, CommandInvokeParams, CommandName};
use z_shell_theme::{
    GenerationOutcome, GenerationRequest, GtkLinkStatus, GtkLinker, ThemeEngine, ThemeError,
    ThemeSource,
};

fn request(seq: u64, seed: &str) -> GenerationRequest {
    GenerationRequest {
        request_seq: seq,
        source: ThemeSource::Seed(seed.to_owned()),
        mode: ThemeMode::Dark,
        variant: ThemeVariant::Tonal,
        backend: ThemeBackend::Builtin,
        gtk_linking: false,
        local_hour: 12,
    }
}

#[tokio::test(flavor = "current_thread")]
async fn stale_generation_cannot_replace_newer_committed_palette() {
    let engine = ThemeEngine::with_gtk(GtkLinker::new(
        TempDir::new().unwrap().path().join("config"),
        TempDir::new().unwrap().path().join("state"),
    ));
    let old_engine = engine.clone();
    let old = tokio::spawn(async move { old_engine.generate(request(1, "#ff0000")).await });
    tokio::task::yield_now().await;
    let new_scheme = match engine.generate(request(2, "#0000ff")).await.unwrap() {
        GenerationOutcome::Committed(snapshot) => snapshot.scheme,
        GenerationOutcome::Superseded => panic!("newest request was superseded"),
    };
    assert!(matches!(
        old.await.unwrap().unwrap(),
        GenerationOutcome::Superseded
    ));
    assert_eq!(engine.snapshot().await.scheme, new_scheme);
}

#[tokio::test]
async fn failed_generation_preserves_commit_and_gtk_failure_does_not_roll_back() {
    let temp = TempDir::new().unwrap();
    let blocked = temp.path().join("blocked");
    fs::write(&blocked, "file, not a directory").unwrap();
    let engine = ThemeEngine::with_gtk(GtkLinker::new(blocked, temp.path().join("state")));
    let committed = match engine.generate(request(1, "#006e1c")).await.unwrap() {
        GenerationOutcome::Committed(snapshot) => snapshot,
        GenerationOutcome::Superseded => unreachable!(),
    };

    let failing = engine
        .clone()
        .with_matugen_program(temp.path().join("missing-matugen"));
    let mut failed_request = request(2, "#ff0000");
    failed_request.backend = ThemeBackend::Matugen;
    let error = failing.generate(failed_request).await.unwrap_err();
    assert!(matches!(error, ThemeError::MatugenUnavailable));
    let after_failure = engine.snapshot().await;
    assert_eq!(after_failure.scheme, committed.scheme);
    assert!(after_failure.last_error.is_some());

    let mut gtk_request = request(3, "#984061");
    gtk_request.gtk_linking = true;
    let after_gtk = match engine.generate(gtk_request).await.unwrap() {
        GenerationOutcome::Committed(snapshot) => snapshot,
        GenerationOutcome::Superseded => unreachable!(),
    };
    assert_ne!(after_gtk.scheme, committed.scheme);
    assert!(matches!(after_gtk.gtk_status, GtkLinkStatus::Error { .. }));
    assert_eq!(after_gtk.last_error, None);
}

#[tokio::test]
async fn bus_commands_get_set_and_retry_publish_only_current_state() {
    let temp = TempDir::new().unwrap();
    let hub = BusHub::new("test", temp.path().join("media"));
    let engine = ThemeEngine::with_gtk(GtkLinker::new(
        temp.path().join("config"),
        temp.path().join("state"),
    ));
    engine.register_bus(&hub).await;
    let commands: Vec<String> = hub
        .list_commands()
        .into_iter()
        .map(|command| command.name.as_str().to_owned())
        .collect();
    for name in ["theme.get", "theme.set", "theme.retry"] {
        assert!(commands.contains(&name.to_owned()), "{commands:?}");
    }
    assert!(
        hub.list_topics()
            .iter()
            .any(|topic| topic.topic.as_str() == "theme")
    );

    let caller = CallerContext {
        client_id: 1,
        role: ClientRole::Public,
    };
    let set = hub
        .invoke_command(
            caller,
            CommandInvokeParams {
                name: CommandName::try_new("theme.set").unwrap(),
                args: vec![],
                payload: Some(json!({
                    "mode": "light",
                    "variant": "neutral",
                    "seed": "#006e1c",
                    "backend": "builtin",
                    "gtk_linking": false,
                    "local_hour": 12
                })),
            },
        )
        .await
        .unwrap();
    assert_eq!(set.data.unwrap()["dark"], false);
    let retried = hub
        .invoke_command(
            caller,
            CommandInvokeParams {
                name: CommandName::try_new("theme.retry").unwrap(),
                args: vec![],
                payload: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(retried.data.unwrap()["source"]["kind"], "seed");
    let got = hub
        .invoke_command(
            caller,
            CommandInvokeParams {
                name: CommandName::try_new("theme.get").unwrap(),
                args: vec![],
                payload: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(got.data.unwrap()["variant"], "neutral");
}
