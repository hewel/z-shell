use std::fs::{self, OpenOptions};
use std::os::unix::fs::PermissionsExt;
use tempfile::TempDir;
use z_shell_clipboard::{History, MockKeyProvider, Payload, PersistenceMode};

fn text(value: &str) -> Payload {
    Payload::new("text/plain;charset=utf-8", value.as_bytes()).expect("valid text")
}

fn snapshot_path(directory: &TempDir) -> std::path::PathBuf {
    directory.path().join("clipboard").join("history.enc")
}

#[tokio::test]
async fn encrypted_history_round_trips_and_never_writes_plaintext() {
    let directory = TempDir::new().expect("temporary directory");
    let path = snapshot_path(&directory);
    let provider = MockKeyProvider::new([7_u8; 32]);
    let mut history = History::open_with_key_provider(&path, &provider).await;
    assert_eq!(history.persistence(), &PersistenceMode::Encrypted);
    let id = history
        .capture(text("sensitive clipboard contents"))
        .expect("capture");
    assert!(history.pin(id));

    let encrypted = fs::read(&path).expect("encrypted snapshot");
    assert!(
        !encrypted
            .windows(b"sensitive clipboard contents".len())
            .any(|window| window == b"sensitive clipboard contents")
    );
    let mode = fs::metadata(&path)
        .expect("snapshot metadata")
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, 0o600);

    let reloaded = History::open_with_key_provider(&path, &provider).await;
    assert_eq!(reloaded.persistence(), &PersistenceMode::Encrypted);
    assert_eq!(reloaded.entries().len(), 1);
    assert_eq!(reloaded.entries()[0].id, id);
    assert!(reloaded.entries()[0].pinned);
    assert_eq!(
        reloaded.entries()[0].payload.bytes(),
        b"sensitive clipboard contents"
    );
}

#[tokio::test]
async fn authentication_tamper_degrades_to_memory_without_overwriting_evidence() {
    let directory = TempDir::new().expect("temporary directory");
    let path = snapshot_path(&directory);
    let provider = MockKeyProvider::new([9_u8; 32]);
    let mut history = History::open_with_key_provider(&path, &provider).await;
    history.capture(text("authenticated")).expect("capture");

    let mut encrypted = fs::read(&path).expect("snapshot");
    let last = encrypted.last_mut().expect("ciphertext");
    *last ^= 1;
    fs::write(&path, &encrypted).expect("tamper snapshot");

    let mut reloaded = History::open_with_key_provider(&path, &provider).await;
    assert!(matches!(
        reloaded.persistence(),
        PersistenceMode::MemoryOnly { .. }
    ));
    assert!(reloaded.entries().is_empty());
    reloaded
        .capture(text("memory only"))
        .expect("memory capture");
    assert_eq!(fs::read(&path).expect("preserved snapshot"), encrypted);
}

#[tokio::test]
async fn locked_keyring_creates_no_files_or_directories() {
    let directory = TempDir::new().expect("temporary directory");
    let path = snapshot_path(&directory);
    let provider = MockKeyProvider::unavailable("keyring is locked");
    let mut history = History::open_with_key_provider(&path, &provider).await;
    assert_eq!(
        history.persistence(),
        &PersistenceMode::MemoryOnly {
            reason: "keyring is locked".to_owned(),
        }
    );
    history.capture(text("ephemeral")).expect("memory capture");
    assert_eq!(
        fs::read_dir(directory.path()).expect("directory").count(),
        0
    );
    assert!(!path.exists());
}

#[tokio::test]
async fn missing_key_for_existing_history_never_rotates_or_replaces_it() {
    let directory = TempDir::new().expect("temporary directory");
    let path = snapshot_path(&directory);
    let provider = MockKeyProvider::new([3_u8; 32]);
    let mut history = History::open_with_key_provider(&path, &provider).await;
    history.capture(text("keep encrypted")).expect("capture");
    let original = fs::read(&path).expect("snapshot");

    let missing = MockKeyProvider::unavailable("encryption key is missing");
    let history = History::open_with_key_provider(&path, &missing).await;
    assert!(matches!(
        history.persistence(),
        PersistenceMode::MemoryOnly { .. }
    ));
    assert_eq!(fs::read(&path).expect("untouched snapshot"), original);
    let metadata = OpenOptions::new()
        .read(true)
        .open(&path)
        .expect("open")
        .metadata();
    assert!(metadata.is_ok());
}
