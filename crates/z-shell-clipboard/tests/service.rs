use image::{DynamicImage, ImageFormat};
use serde_json::{Value, json};
use std::io::Cursor;
use std::path::PathBuf;
use std::sync::Arc;
use z_shell_bus::{BusHub, CallerContext};
use z_shell_clipboard::{ClipboardService, History, LockedState, Payload};
use z_shell_protocol::{ClientRole, CommandInvokeParams, CommandName, ErrorCode, MediaRef};

fn hub() -> BusHub {
    BusHub::new("test", PathBuf::from("/tmp/z-shell-clipboard-test-media"))
}

fn caller(role: ClientRole) -> CallerContext {
    CallerContext { client_id: 1, role }
}

async fn invoke(
    hub: &BusHub,
    role: ClientRole,
    name: &str,
    payload: Value,
) -> Result<Value, z_shell_protocol::RpcError> {
    hub.invoke_command(
        caller(role),
        CommandInvokeParams {
            name: CommandName::try_new(name).expect("command name"),
            args: Vec::new(),
            payload: Some(payload),
        },
    )
    .await
    .map(|result| result.data.unwrap_or(Value::Null))
}

fn png() -> Payload {
    let mut output = Cursor::new(Vec::new());
    DynamicImage::new_rgb8(1, 1)
        .write_to(&mut output, ImageFormat::Png)
        .expect("PNG encodes");
    Payload::new("image/png", output.into_inner()).expect("valid PNG")
}

fn service_with_history() -> (Arc<ClipboardService>, u64, u64, Vec<u8>) {
    let mut history = History::memory();
    let text = history
        .capture(Payload::new("STRING", b"caf\xe9".as_slice()).expect("Latin-1"))
        .expect("capture text");
    let image_payload = png();
    let original = image_payload.bytes().to_vec();
    let image = history.capture(image_payload).expect("capture image");
    (
        Arc::new(ClipboardService::new(history)),
        text,
        image,
        original,
    )
}

#[tokio::test]
async fn topic_and_list_are_paginated_metadata_with_searchable_latin1() {
    let (service, text, image, _) = service_with_history();
    let hub = hub();
    service.install_on_bus(&hub);

    let snapshot = service.snapshot();
    assert_eq!(snapshot.entry_count, 2);
    assert_eq!(snapshot.entries[0].id, image);
    assert!(matches!(
        snapshot.entries[0].media,
        Some(MediaRef::BlobHandle { .. })
    ));
    let topic_json = serde_json::to_string(&snapshot).expect("snapshot JSON");
    assert!(!topic_json.contains("base64"));

    let found = invoke(
        &hub,
        ClientRole::Public,
        "clipboard.list",
        json!({"query": "CAFÉ"}),
    )
    .await
    .expect("Latin-1 search");
    assert_eq!(found["total"], 1);
    assert_eq!(found["entries"][0]["id"], text);
    assert_eq!(found["entries"][0]["preview"], "café");

    let images = invoke(
        &hub,
        ClientRole::Public,
        "clipboard.list",
        json!({"query": "png"}),
    )
    .await
    .expect("image search");
    assert_eq!(images["total"], 1);
    assert_eq!(images["entries"][0]["id"], image);
    assert!(images["entries"][0].get("bytes").is_none());
}

#[tokio::test]
async fn fetch_blob_requires_privileged_host_and_returns_exact_bounded_bytes() {
    let (service, _, _, original) = service_with_history();
    let hub = hub();
    service.install_on_bus(&hub);
    let token = match service.snapshot().entries[0].media.as_ref().expect("media") {
        MediaRef::BlobHandle { token, .. } => token.clone(),
        other => panic!("unexpected media ref: {other:?}"),
    };

    let denied = invoke(
        &hub,
        ClientRole::Public,
        "clipboard.fetch-blob",
        json!({"token": token}),
    )
    .await
    .expect_err("public caller is denied");
    assert_eq!(denied.code, ErrorCode::PermissionDenied);

    let fetched = invoke(
        &hub,
        ClientRole::PrivilegedHost,
        "clipboard.fetch-blob",
        json!({"token": token}),
    )
    .await
    .expect("host fetch");
    let bytes = fetched["bytes"]
        .as_array()
        .expect("byte array")
        .iter()
        .map(|byte| u8::try_from(byte.as_u64().expect("integer byte")).expect("byte range"))
        .collect::<Vec<_>>();
    assert_eq!(bytes, original);
    assert_eq!(fetched["mime"], "image/png");
}

#[tokio::test]
async fn locked_screen_denies_public_list_and_copy_and_hides_topic_entries() {
    let (service, text, _, _) = service_with_history();
    let hub = hub();
    service.install_on_bus(&hub);
    service.set_locked(LockedState::Locked);

    for command in ["clipboard.list", "clipboard.copy"] {
        let denied = invoke(&hub, ClientRole::Public, command, json!({"id": text}))
            .await
            .expect_err("public locked-screen access is denied");
        assert_eq!(denied.code, ErrorCode::PermissionDenied);
    }
    assert!(service.snapshot().entries.is_empty());

    service.set_locked(LockedState::Unlocked);
    let listed = invoke(&hub, ClientRole::Public, "clipboard.list", json!({}))
        .await
        .expect("unlocked list");
    assert_eq!(listed["total"], 2);
}

#[tokio::test]
async fn pin_forget_and_clear_commands_update_topic_state() {
    let (service, text, image, _) = service_with_history();
    let hub = hub();
    service.install_on_bus(&hub);
    invoke(
        &hub,
        ClientRole::Public,
        "clipboard.pin",
        json!({"id": text}),
    )
    .await
    .expect("pin");
    assert_eq!(service.snapshot().entries[0].id, text);
    invoke(
        &hub,
        ClientRole::Public,
        "clipboard.unpin",
        json!({"id": text}),
    )
    .await
    .expect("unpin");
    invoke(
        &hub,
        ClientRole::Public,
        "clipboard.forget",
        json!({"id": image}),
    )
    .await
    .expect("forget");
    assert_eq!(service.snapshot().entry_count, 1);
    invoke(&hub, ClientRole::Public, "clipboard.clear", json!({}))
        .await
        .expect("clear");
    assert_eq!(service.snapshot().entry_count, 0);
}
