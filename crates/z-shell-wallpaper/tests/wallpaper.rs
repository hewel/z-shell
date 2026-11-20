//! Wallpaper behavior through the bus, durable state, and confined media files.

use image::{ImageFormat, Rgb, RgbImage};
use serde_json::{Value, json};
use std::fs;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tempfile::TempDir;
use tokio::time::timeout;
use z_shell_bus::{BusHub, CallerContext};
use z_shell_config::{ConfigStore, ShellPaths, WallpaperFit, WallpaperSettings};
use z_shell_protocol::{
    ClientMessage, ClientRole, CommandInvokeParams, CommandName, ErrorCode, RequestId, RpcError,
    ServerMessage, TopicUpdate, decode_server_line, methods,
};
use z_shell_wallpaper::{
    WALLPAPER_TOPIC, WallpaperLockState, WallpaperService, WallpaperSleepState,
};

struct Fixture {
    dir: TempDir,
    store: ConfigStore,
    settings: WallpaperSettings,
}

impl Fixture {
    fn new() -> Self {
        let dir = TempDir::new().unwrap();
        let root = dir.path();
        let paths = ShellPaths::from_roots(
            root.join("config"),
            root.join("state"),
            root.join("runtime"),
            root.join("runtime/bus.sock"),
        );
        paths.ensure_dirs().unwrap();
        let images = root.join("images");
        fs::create_dir(&images).unwrap();
        Self {
            settings: WallpaperSettings {
                directories: vec![images.to_str().unwrap().to_owned()],
                ..WallpaperSettings::default()
            },
            dir,
            store: ConfigStore::new(paths),
        }
    }

    fn image(&self, name: &str, format: ImageFormat, color: [u8; 3]) -> PathBuf {
        let path = self.dir.path().join("images").join(name);
        RgbImage::from_pixel(640, 360, Rgb(color))
            .save_with_format(&path, format)
            .unwrap();
        path
    }

    fn service(&self, settings: &WallpaperSettings) -> WallpaperService {
        WallpaperService::new(
            self.store.clone(),
            settings,
            &self.store.load_state().unwrap(),
        )
    }

    fn hub(&self) -> BusHub {
        BusHub::new("test", self.store.paths().media_dir())
    }

    fn media(&self) -> PathBuf {
        self.store.paths().media_dir().join("wallpapers")
    }
}

async fn call(hub: &BusHub, command: &str, payload: Value) -> Result<Value, RpcError> {
    hub.invoke_command(
        CallerContext {
            client_id: 1,
            role: ClientRole::Public,
        },
        CommandInvokeParams {
            name: CommandName::try_new(command).unwrap(),
            args: vec![],
            payload: Some(payload),
        },
    )
    .await
    .map(|result| result.data.unwrap_or(Value::Null))
}

fn assert_media(media: &Value, cache: &Path, prefix: &str, mime: &str) -> PathBuf {
    assert_eq!(media["kind"], "runtime_path");
    assert_eq!(media["mime"], mime);
    let path = PathBuf::from(media["path"].as_str().unwrap());
    assert_eq!(path.parent().unwrap(), cache);
    let metadata = fs::symlink_metadata(&path).unwrap();
    assert!(metadata.is_file(), "not a regular cache file: {path:?}");
    assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
    let stem = path.file_stem().unwrap().to_str().unwrap();
    let digest = stem.strip_prefix(prefix).unwrap();
    assert_eq!(digest.len(), 16);
    assert!(digest.bytes().all(|b| b.is_ascii_hexdigit()));
    path
}

#[tokio::test]
async fn scans_deduplicates_and_paginates_bounded_png_thumbnails() {
    let mut fixture = Fixture::new();
    let png = fixture.image("a.PNG", ImageFormat::Png, [255, 0, 0]);
    fixture.image("b.JpEg", ImageFormat::Jpeg, [0, 255, 0]);
    fixture.image("c.webp", ImageFormat::WebP, [0, 0, 255]);
    symlink(&png, png.with_file_name("duplicate.png")).unwrap();
    symlink(
        png.with_file_name("missing"),
        png.with_file_name("dangling.png"),
    )
    .unwrap();
    fs::write(png.with_file_name("invalid.png"), b"not an image").unwrap();
    let oversized = fs::File::create(png.with_file_name("oversized.png")).unwrap();
    oversized.set_len(64 * 1024 * 1024 + 1).unwrap();
    let too_wide = png.with_file_name("too-wide.png");
    RgbImage::from_pixel(8193, 1, Rgb([1, 2, 3]))
        .save(&too_wide)
        .unwrap();
    fixture.settings.directories.push(
        fixture
            .dir
            .path()
            .join("missing")
            .to_str()
            .unwrap()
            .to_owned(),
    );

    let hub = fixture.hub();
    let service = fixture.service(&fixture.settings);
    service.install_on_bus(&hub);
    assert_eq!(
        fs::metadata(fixture.media()).unwrap().permissions().mode() & 0o777,
        0o700
    );
    let all = call(&hub, "wallpaper.list", json!({})).await.unwrap();
    assert_eq!(all["total"], 3);
    let rejected = call(&hub, "wallpaper.set", json!({"path": too_wide}))
        .await
        .unwrap_err();
    assert_eq!(rejected.code, ErrorCode::InvalidParams);
    assert!(fixture.store.load_state().unwrap().last_wallpaper.is_none());
    assert_eq!(all["items"][0]["source_path"], json!(png));
    assert_eq!(all["items"][1]["name"], "b");
    for entry in all["items"].as_array().unwrap() {
        assert_eq!(
            (entry["width"].as_u64(), entry["height"].as_u64()),
            (Some(640), Some(360))
        );
        let thumbnail = assert_media(&entry["thumbnail"], &fixture.media(), "thumb-", "image/png");
        assert_eq!(image::image_dimensions(thumbnail).unwrap(), (320, 180));
    }
    let page = call(&hub, "wallpaper.list", json!({"offset": 1, "limit": 1}))
        .await
        .unwrap();
    assert_eq!(page, json!({"items": [all["items"][1]], "total": 3}));
    let past_end = call(&hub, "wallpaper.list", json!({"offset": 99}))
        .await
        .unwrap();
    assert_eq!(past_end, json!({"items": [], "total": 3}));
    fs::remove_file(png.with_file_name("b.JpEg")).unwrap();
    let rescanned = call(&hub, "wallpaper.rescan", json!({})).await.unwrap();
    assert_eq!(rescanned["catalog_count"], 2);
    let fresh = call(&hub, "wallpaper.list", json!({})).await.unwrap();
    assert_eq!(fresh["items"][0]["id"], all["items"][0]["id"]);
}

#[tokio::test]
async fn stages_persists_and_restores_global_and_output_wallpapers_with_theme_linkage() {
    let fixture = Fixture::new();
    let global = fixture.image("global.png", ImageFormat::Png, [255, 0, 0]);
    let output = fixture.image("output.webp", ImageFormat::WebP, [0, 0, 255]);
    let themes = Arc::new(Mutex::new(Vec::new()));
    let record_theme = {
        let themes = Arc::clone(&themes);
        move |path| themes.lock().unwrap().push(path)
    };
    let hub = fixture.hub();
    let service = fixture
        .service(&fixture.settings)
        .with_theme_sync(record_theme.clone());
    service.install_on_bus(&hub);
    let first = call(&hub, "wallpaper.set", json!({"path": global}))
        .await
        .unwrap();
    let staged = assert_media(
        &first["current"]["media"],
        &fixture.media(),
        "active-",
        "image/png",
    );
    assert_eq!(fs::read(staged).unwrap(), fs::read(&global).unwrap());
    let second = call(
        &hub,
        "wallpaper.set",
        json!({"path": output, "output": "DP-1", "fit": "contain"}),
    )
    .await
    .unwrap();
    assert_media(
        &second["per_output"]["DP-1"]["media"],
        &fixture.media(),
        "active-",
        "image/webp",
    );
    assert_eq!(second["per_output"]["DP-1"]["fit"], "contain");
    call(&hub, "wallpaper.set", json!({"path": global}))
        .await
        .unwrap();
    assert_eq!(
        themes.lock().unwrap().as_slice(),
        std::slice::from_ref(&global)
    );
    let durable = fixture.store.load_state().unwrap();
    assert_eq!(durable.last_wallpaper.as_ref(), Some(&global));
    assert_eq!(durable.output_wallpapers["DP-1"], output);
    drop(service);

    let recovered = fixture
        .service(&fixture.settings)
        .with_theme_sync(record_theme.clone());
    let restored_hub = fixture.hub();
    recovered.install_on_bus(&restored_hub);
    let restored = recovered.snapshot();
    assert_eq!(restored.current.unwrap().source_path, global);
    assert_eq!(restored.per_output["DP-1"].source_path, output);
    assert_eq!(*themes.lock().unwrap(), [global.clone(), global.clone()]);
    drop(recovered);

    fs::remove_file(&output).unwrap();
    let mut settings = fixture.settings.clone();
    settings.sync_theme = false;
    let recovered = fixture.service(&settings).with_theme_sync(record_theme);
    recovered.install_on_bus(&hub);
    let snapshot = recovered.snapshot();
    assert!(snapshot.available);
    assert!(snapshot.per_output.is_empty());
    assert!(snapshot.last_error.unwrap().contains("output.webp"));
    assert_eq!(snapshot.current.unwrap().source_path, global);
    let new = fixture.image("new.jpg", ImageFormat::Jpeg, [0, 255, 0]);
    call(&hub, "wallpaper.set", json!({"path": new}))
        .await
        .unwrap();
    assert_eq!(*themes.lock().unwrap(), [global.clone(), global]);
}

#[tokio::test]
async fn clears_assignments_independently_and_collects_only_unreferenced_media() {
    let fixture = Fixture::new();
    let a = fixture.image("a.png", ImageFormat::Png, [1, 2, 3]);
    let b = fixture.image("b.png", ImageFormat::Png, [3, 2, 1]);
    let hub = fixture.hub();
    let service = fixture.service(&fixture.settings);
    service.install_on_bus(&hub);
    let first = call(&hub, "wallpaper.set", json!({"path": a}))
        .await
        .unwrap();
    let media_a = assert_media(
        &first["current"]["media"],
        &fixture.media(),
        "active-",
        "image/png",
    );
    call(&hub, "wallpaper.set", json!({"path": a, "output": "DP-1"}))
        .await
        .unwrap();
    let other_hub = fixture.hub();
    let other_display = fixture.service(&fixture.settings);
    other_display.install_on_bus(&other_hub);
    let second = call(&hub, "wallpaper.set", json!({"path": b}))
        .await
        .unwrap();
    let media_b = assert_media(
        &second["current"]["media"],
        &fixture.media(),
        "active-",
        "image/png",
    );
    assert!(
        media_a.is_file(),
        "overriding the global must preserve output media"
    );
    let cleared = call(&hub, "wallpaper.clear", json!({"output": "DP-1"}))
        .await
        .unwrap();
    assert!(cleared["per_output"]["DP-1"].is_null());
    assert_eq!(cleared["current"]["source_path"], json!(b));
    assert!(
        media_a.is_file(),
        "another display is still showing this image"
    );
    drop(other_display);
    assert!(
        fixture
            .store
            .load_state()
            .unwrap()
            .output_wallpapers
            .is_empty()
    );
    let cleared = call(&hub, "wallpaper.clear", json!({})).await.unwrap();
    assert!(cleared["current"].is_null());
    assert!(fixture.store.load_state().unwrap().last_wallpaper.is_none());
    assert!(!media_a.exists());
    assert!(!media_b.exists());
}

#[tokio::test]
async fn cycles_wrap_and_random_never_repeats_when_an_alternative_exists() {
    let fixture = Fixture::new();
    let hub = fixture.hub();
    let service = fixture.service(&fixture.settings);
    service.install_on_bus(&hub);
    for name in ["wallpaper.next", "wallpaper.previous", "wallpaper.random"] {
        assert_eq!(
            call(&hub, name, json!({})).await.unwrap_err().code,
            ErrorCode::NotFound
        );
    }
    let a = fixture.image("a.png", ImageFormat::Png, [1, 2, 3]);
    let b = fixture.image("b.png", ImageFormat::Png, [3, 2, 1]);
    call(&hub, "wallpaper.rescan", json!({})).await.unwrap();
    for (name, expected) in [
        ("wallpaper.next", &a),
        ("wallpaper.previous", &b),
        ("wallpaper.next", &a),
        ("wallpaper.random", &b),
        ("wallpaper.random", &a),
    ] {
        let updated = call(&hub, name, json!({"output": "DP-1"})).await.unwrap();
        assert_eq!(
            updated["per_output"]["DP-1"]["source_path"],
            json!(expected)
        );
        assert!(updated["current"].is_null());
    }
    assert_eq!(
        fixture.store.load_state().unwrap().output_wallpapers["DP-1"],
        a
    );
}

#[tokio::test]
async fn rejects_cache_symlinks_and_failed_persistence_preserves_active_assignment() {
    let fixture = Fixture::new();
    let a = fixture.image("a.png", ImageFormat::Png, [1, 2, 3]);
    let b = fixture.image("b.png", ImageFormat::Png, [3, 2, 1]);
    let hub = fixture.hub();
    let service = fixture.service(&fixture.settings);
    service.install_on_bus(&hub);
    let first = call(&hub, "wallpaper.set", json!({"path": a}))
        .await
        .unwrap();
    let path = assert_media(
        &first["current"]["media"],
        &fixture.media(),
        "active-",
        "image/png",
    );
    call(&hub, "wallpaper.clear", json!({})).await.unwrap();
    symlink(&b, &path).unwrap();
    assert!(
        call(&hub, "wallpaper.set", json!({"path": a}))
            .await
            .is_err()
    );
    assert!(fs::symlink_metadata(&path).unwrap().is_symlink());
    assert!(fixture.store.load_state().unwrap().last_wallpaper.is_none());
    fs::remove_file(path).unwrap();
    call(&hub, "wallpaper.set", json!({"path": a}))
        .await
        .unwrap();
    let before = service.snapshot();
    fs::write(fixture.store.paths().state_file(), "[invalid").unwrap();
    assert_eq!(
        call(&hub, "wallpaper.set", json!({"path": b}))
            .await
            .unwrap_err()
            .code,
        ErrorCode::Internal
    );
    assert_eq!(service.snapshot(), before);
}

#[tokio::test]
async fn refuses_to_stage_through_a_symlinked_cache_directory() {
    let fixture = Fixture::new();
    let a = fixture.image("a.png", ImageFormat::Png, [1, 2, 3]);
    let other = fixture.dir.path().join("outside");
    fs::create_dir(&other).unwrap();
    symlink(&other, fixture.media()).unwrap();
    let hub = fixture.hub();
    let service = fixture.service(&fixture.settings);
    service.install_on_bus(&hub);
    assert!(service.snapshot().last_error.is_some());
    assert!(
        call(&hub, "wallpaper.set", json!({"path": a}))
            .await
            .is_err()
    );
    assert!(fs::read_dir(other).unwrap().next().is_none());
    assert!(fixture.store.load_state().unwrap().last_wallpaper.is_none());
}

#[tokio::test]
async fn slideshow_rearms_and_pauses_while_locked_or_sleeping() {
    let fixture = Fixture::new();
    let a = fixture.image("a.png", ImageFormat::Png, [1, 2, 3]);
    let b = fixture.image("b.png", ImageFormat::Png, [3, 2, 1]);
    let hub = fixture.hub();
    let service = fixture.service(&fixture.settings);
    service.install_on_bus(&hub);
    let (id, outbound) = hub.register_client(ClientRole::Public).unwrap();
    for (id_num, method, params) in [
        (
            1,
            methods::BUS_HELLO,
            json!({"protocol_version": z_shell_protocol::PROTOCOL_VERSION}),
        ),
        (
            2,
            methods::TOPIC_SUBSCRIBE,
            json!({"topic": WALLPAPER_TOPIC}),
        ),
    ] {
        hub.handle_inline_message(
            id,
            ClientMessage::request(RequestId::Number(id_num), method, Some(params)),
        );
    }
    outbound.next_line().await.unwrap();
    outbound.next_line().await.unwrap();
    let next_wallpaper = || async {
        let line = outbound.next_line().await.unwrap();
        let ServerMessage::Notification { method, params } = decode_server_line(&line).unwrap()
        else {
            panic!("expected a wallpaper topic update");
        };
        assert_eq!(method, methods::TOPIC_UPDATE);
        let update: TopicUpdate = serde_json::from_value(params).unwrap();
        assert!(!update.source_baseline);
        update.data
    };

    service.set_locked(WallpaperLockState::Locked);
    let mut enabled = fixture.settings.clone();
    enabled.slideshow_seconds = 1;
    enabled.fit = WallpaperFit::Fill;
    service.apply_settings(&enabled).await.unwrap();
    assert_eq!(next_wallpaper().await["slideshow_seconds"], 1);
    for name in ["set", "clear", "next", "previous", "random", "rescan"] {
        let error = call(&hub, &format!("wallpaper.{name}"), json!({"path": a}))
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::PermissionDenied, "{name}: {error:?}");
    }
    assert_eq!(
        call(&hub, "wallpaper.list", json!({})).await.unwrap()["total"],
        2
    );
    let window = Duration::from_millis(1200);
    assert!(timeout(window, next_wallpaper()).await.is_err());
    assert!(service.snapshot().current.is_none());

    service.set_locked(WallpaperLockState::Unlocked);
    let first = timeout(Duration::from_secs(4), next_wallpaper())
        .await
        .unwrap();
    assert_eq!(first["current"]["source_path"], json!(a));
    service.set_sleeping(WallpaperSleepState::Sleeping);
    assert!(timeout(window, next_wallpaper()).await.is_err());
    assert_eq!(fixture.store.load_state().unwrap().last_wallpaper, Some(a));
    service.set_sleeping(WallpaperSleepState::Awake);
    let second = timeout(Duration::from_secs(4), next_wallpaper())
        .await
        .unwrap();
    assert_eq!(second["current"]["source_path"], json!(b));
    service.apply_settings(&fixture.settings).await.unwrap();
    assert_eq!(next_wallpaper().await["slideshow_seconds"], 0);
    assert!(timeout(window, next_wallpaper()).await.is_err());
}

#[tokio::test]
async fn deferred_startup_populates_catalog_and_restores_assignments_asynchronously() {
    let fixture = Fixture::new();
    let global = fixture.image("global.png", ImageFormat::Png, [255, 0, 0]);
    let output = fixture.image("output.png", ImageFormat::Png, [0, 0, 255]);
    fixture
        .store
        .update_state(|state| {
            state.last_wallpaper = Some(global.clone());
            state
                .output_wallpapers
                .insert("DP-1".into(), output.clone());
            Ok(())
        })
        .unwrap();
    let themes = Arc::new(Mutex::new(Vec::new()));
    let record_theme = {
        let themes = Arc::clone(&themes);
        move |path| themes.lock().unwrap().push(path)
    };

    let service = WallpaperService::new_deferred(
        fixture.store.clone(),
        &fixture.settings,
        &fixture.store.load_state().unwrap(),
    )
    .with_theme_sync(record_theme);
    let initial = service.snapshot();
    assert!(!initial.available);
    assert_eq!(initial.catalog_count, 0);
    assert!(initial.current.is_none());

    let hub = fixture.hub();
    let (id, outbound) = hub.register_client(ClientRole::Public).unwrap();
    service.install_on_bus(&hub);
    for (id_num, method, params) in [
        (
            1,
            methods::BUS_HELLO,
            json!({"protocol_version": z_shell_protocol::PROTOCOL_VERSION}),
        ),
        (
            2,
            methods::TOPIC_SUBSCRIBE,
            json!({"topic": WALLPAPER_TOPIC}),
        ),
    ] {
        hub.handle_inline_message(
            id,
            ClientMessage::request(RequestId::Number(id_num), method, Some(params)),
        );
    }
    outbound.next_line().await.unwrap();
    let subscribed_line = outbound.next_line().await.unwrap();
    let ServerMessage::Ok { result, .. } = decode_server_line(&subscribed_line).unwrap() else {
        panic!("expected subscribe response");
    };
    let ready = if result["data"]["available"] == true {
        result["data"].clone()
    } else {
        timeout(Duration::from_secs(5), async {
            loop {
                let line = outbound.next_line().await.unwrap();
                let ServerMessage::Notification { method, params } =
                    decode_server_line(&line).unwrap()
                else {
                    continue;
                };
                if method == methods::TOPIC_UPDATE {
                    let update: TopicUpdate = serde_json::from_value(params).unwrap();
                    if update.data["available"] == true {
                        assert!(update.source_baseline);
                        break update.data;
                    }
                }
            }
        })
        .await
        .expect("deferred init should publish an available baseline")
    };
    assert_eq!(ready["catalog_count"], 2);
    assert_eq!(ready["current"]["source_path"], json!(global));
    assert_eq!(ready["per_output"]["DP-1"]["source_path"], json!(output));
    assert_eq!(*themes.lock().unwrap(), [global]);
}
