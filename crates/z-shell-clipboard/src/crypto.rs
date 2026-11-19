//! Secret Service key acquisition and authenticated atomic history snapshots.

use chacha20poly1305::{
    ChaCha20Poly1305, Nonce,
    aead::{Aead, KeyInit, Payload as AeadPayload},
};
use getrandom::fill;
use secret_service::{EncryptionType, SecretService};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::future::Future;
use std::io::{Read, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::time::Duration;
use thiserror::Error;
use zeroize::Zeroizing;

use crate::MAX_HISTORY_BYTES;

const HEADER: &[u8; 8] = b"ZSCLIP01";
const ENVELOPE_BYTES: usize = HEADER.len() + 12 + 16;
const MAX_SNAPSHOT_BYTES: usize = MAX_HISTORY_BYTES + 64 * 1024 + ENVELOPE_BYTES;

/// Failure to acquire the key required for encrypted persistence.
#[derive(Clone, Debug, PartialEq, Eq, Error)]
#[error("{0}")]
pub struct KeyError(String);

impl KeyError {
    /// Creates a provider diagnostic without exposing clipboard contents.
    #[must_use]
    pub fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

/// Boxed future returned by a [`KeyProvider`].
pub type KeyFuture<'a> =
    Pin<Box<dyn Future<Output = Result<Zeroizing<[u8; 32]>, KeyError>> + Send + 'a>>;

/// Pluggable asynchronous source for the 256-bit history encryption key.
pub trait KeyProvider: Send + Sync {
    /// Acquires an existing key or creates one when no encrypted state exists.
    fn acquire(&self, history_exists: bool) -> KeyFuture<'_>;
}

/// Production key provider backed by the session Secret Service.
#[derive(Clone, Copy, Debug, Default)]
pub struct SecretServiceKeyProvider;

impl KeyProvider for SecretServiceKeyProvider {
    fn acquire(&self, history_exists: bool) -> KeyFuture<'_> {
        Box::pin(async move {
            tokio::time::timeout(Duration::from_secs(3), acquire_secret(history_exists))
                .await
                .map_err(|_| KeyError::new("Secret Service key acquisition timed out"))?
        })
    }
}

async fn acquire_secret(history_exists: bool) -> Result<Zeroizing<[u8; 32]>, KeyError> {
    let service = SecretService::connect(EncryptionType::Dh)
        .await
        .map_err(|error| KeyError::new(format!("Secret Service is unavailable: {error}")))?;
    let attributes = HashMap::from([
        ("application", "z-shell"),
        ("purpose", "clipboard-history-v1"),
    ]);
    let found = service
        .search_items(attributes.clone())
        .await
        .map_err(|error| KeyError::new(format!("Secret Service search failed: {error}")))?;
    if !found.locked.is_empty() {
        return Err(KeyError::new("clipboard encryption key is locked"));
    }
    if found.unlocked.len() > 1 {
        return Err(KeyError::new("multiple clipboard encryption keys found"));
    }
    if let Some(item) = found.unlocked.first() {
        let secret = Zeroizing::new(
            item.get_secret()
                .await
                .map_err(|error| KeyError::new(format!("Secret Service read failed: {error}")))?,
        );
        if secret.len() != 32 {
            return Err(KeyError::new("invalid clipboard encryption key length"));
        }
        let mut key = Zeroizing::new([0_u8; 32]);
        key.copy_from_slice(&secret);
        return Ok(key);
    }
    if history_exists {
        return Err(KeyError::new(
            "encryption key is missing for existing clipboard history",
        ));
    }
    let collection = service
        .get_default_collection()
        .await
        .map_err(|error| KeyError::new(format!("Secret Service collection failed: {error}")))?;
    if collection
        .is_locked()
        .await
        .map_err(|error| KeyError::new(format!("Secret Service lock state failed: {error}")))?
    {
        return Err(KeyError::new("Secret Service collection is locked"));
    }
    let mut key = Zeroizing::new([0_u8; 32]);
    fill(key.as_mut()).map_err(|_| KeyError::new("secure randomness is unavailable"))?;
    collection
        .create_item(
            "z-shell clipboard history encryption key",
            attributes,
            key.as_ref(),
            false,
            "application/octet-stream",
        )
        .await
        .map_err(|error| KeyError::new(format!("Secret Service key creation failed: {error}")))?;
    Ok(key)
}

/// Deterministic key provider for tests and embedders with an explicit key.
#[derive(Clone, Debug)]
pub struct MockKeyProvider {
    key: Option<[u8; 32]>,
    reason: Option<String>,
}

impl MockKeyProvider {
    /// Returns the same supplied key for every acquisition.
    #[must_use]
    pub fn new(key: [u8; 32]) -> Self {
        Self {
            key: Some(key),
            reason: None,
        }
    }

    /// Simulates a locked, missing, or unavailable keyring.
    #[must_use]
    pub fn unavailable(reason: impl Into<String>) -> Self {
        Self {
            key: None,
            reason: Some(reason.into()),
        }
    }
}

impl KeyProvider for MockKeyProvider {
    fn acquire(&self, _history_exists: bool) -> KeyFuture<'_> {
        let result = self.key.map(Zeroizing::new).ok_or_else(|| {
            KeyError::new(
                self.reason
                    .clone()
                    .unwrap_or_else(|| "mock key is unavailable".to_owned()),
            )
        });
        Box::pin(async move { result })
    }
}

#[derive(Debug)]
pub(crate) struct CryptoStore {
    path: PathBuf,
    key: Zeroizing<[u8; 32]>,
}

impl CryptoStore {
    pub(crate) async fn open(
        path: &Path,
        provider: &dyn KeyProvider,
    ) -> Result<(Self, Option<Zeroizing<Vec<u8>>>), String> {
        let history_exists = encrypted_state_exists(path)?;
        let key = provider
            .acquire(history_exists)
            .await
            .map_err(|error| error.to_string())?;
        let store = Self {
            path: path.to_path_buf(),
            key,
        };
        let snapshot = if path.exists() {
            Some(store.read()?)
        } else {
            None
        };
        Ok((store, snapshot))
    }

    pub(crate) fn save(&self, plaintext: &[u8]) -> Result<(), String> {
        let directory = self
            .path
            .parent()
            .ok_or_else(|| "clipboard history path has no parent".to_owned())?;
        private_directory(directory)?;
        let mut nonce = [0_u8; 12];
        fill(&mut nonce).map_err(|_| "secure randomness is unavailable".to_owned())?;
        let cipher = ChaCha20Poly1305::new_from_slice(self.key.as_ref())
            .expect("a 32-byte key initializes ChaCha20Poly1305");
        let ciphertext = cipher
            .encrypt(
                &Nonce::from(nonce),
                AeadPayload {
                    msg: plaintext,
                    aad: HEADER,
                },
            )
            .map_err(|_| "clipboard history encryption failed".to_owned())?;
        let temporary = directory.join(format!(".history-{}.tmp", random_suffix()?));
        let result = write_atomic(&self.path, &temporary, HEADER, &nonce, &ciphertext);
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }

    fn read(&self) -> Result<Zeroizing<Vec<u8>>, String> {
        let mut file = OpenOptions::new()
            .read(true)
            .custom_flags(
                (rustix::fs::OFlags::NOFOLLOW | rustix::fs::OFlags::NONBLOCK).bits() as i32,
            )
            .open(&self.path)
            .map_err(storage_error)?;
        let metadata = file.metadata().map_err(storage_error)?;
        if !metadata.is_file()
            || metadata.uid() != rustix::process::geteuid().as_raw()
            || metadata.nlink() != 1
        {
            return Err("unsafe clipboard history ownership or file type".to_owned());
        }
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(storage_error)?;
        let length = usize::try_from(metadata.len())
            .map_err(|_| "clipboard history snapshot is too large".to_owned())?;
        if !(ENVELOPE_BYTES..=MAX_SNAPSHOT_BYTES).contains(&length) {
            return Err("invalid encrypted clipboard history length".to_owned());
        }
        let mut envelope = vec![0_u8; length];
        file.read_exact(&mut envelope).map_err(storage_error)?;
        if envelope.get(..HEADER.len()) != Some(HEADER) {
            return Err("invalid encrypted clipboard history header".to_owned());
        }
        let nonce = Nonce::from_slice(&envelope[HEADER.len()..HEADER.len() + 12]);
        let cipher = ChaCha20Poly1305::new_from_slice(self.key.as_ref())
            .expect("a 32-byte key initializes ChaCha20Poly1305");
        cipher
            .decrypt(
                nonce,
                AeadPayload {
                    msg: &envelope[HEADER.len() + 12..],
                    aad: HEADER,
                },
            )
            .map(Zeroizing::new)
            .map_err(|_| "clipboard history authentication failed".to_owned())
    }
}

fn encrypted_state_exists(path: &Path) -> Result<bool, String> {
    if path.exists() {
        return Ok(true);
    }
    let Some(directory) = path.parent() else {
        return Ok(false);
    };
    match fs::read_dir(directory) {
        Ok(mut entries) => entries
            .next()
            .transpose()
            .map(|entry| entry.is_some())
            .map_err(storage_error),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(storage_error(error)),
    }
}

fn private_directory(path: &Path) -> Result<File, String> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true).mode(0o700);
    builder.create(path).map_err(storage_error)?;
    let directory = OpenOptions::new()
        .read(true)
        .custom_flags((rustix::fs::OFlags::NOFOLLOW | rustix::fs::OFlags::DIRECTORY).bits() as i32)
        .open(path)
        .map_err(storage_error)?;
    let metadata = directory.metadata().map_err(storage_error)?;
    if metadata.uid() != rustix::process::geteuid().as_raw() {
        return Err("clipboard history directory has another owner".to_owned());
    }
    directory
        .set_permissions(fs::Permissions::from_mode(0o700))
        .map_err(storage_error)?;
    Ok(directory)
}

fn write_atomic(
    destination: &Path,
    temporary: &Path,
    header: &[u8],
    nonce: &[u8],
    ciphertext: &[u8],
) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(rustix::fs::OFlags::NOFOLLOW.bits() as i32)
        .open(temporary)
        .map_err(storage_error)?;
    file.write_all(header).map_err(storage_error)?;
    file.write_all(nonce).map_err(storage_error)?;
    file.write_all(ciphertext).map_err(storage_error)?;
    file.sync_all().map_err(storage_error)?;
    drop(file);
    fs::rename(temporary, destination).map_err(storage_error)?;
    let directory = destination
        .parent()
        .ok_or_else(|| "clipboard history path has no parent".to_owned())?;
    OpenOptions::new()
        .read(true)
        .open(directory)
        .and_then(|directory| directory.sync_all())
        .map_err(storage_error)
}

fn random_suffix() -> Result<String, String> {
    let mut random = [0_u8; 16];
    fill(&mut random).map_err(|_| "secure randomness is unavailable".to_owned())?;
    let mut suffix = String::with_capacity(random.len() * 2);
    for byte in random {
        use std::fmt::Write as _;
        write!(&mut suffix, "{byte:02x}").expect("writing to a string cannot fail");
    }
    Ok(suffix)
}

fn storage_error(error: std::io::Error) -> String {
    format!("clipboard storage failed: {error}")
}
