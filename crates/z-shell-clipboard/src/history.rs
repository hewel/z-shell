//! Bounded clipboard history with pinning, deduplication, and revocable image blobs.

use crate::crypto::{CryptoStore, KeyProvider, SecretServiceKeyProvider};
use crate::{MAX_IMAGE_BYTES, MAX_TEXT_BYTES, Payload};
use getrandom::fill;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use thiserror::Error;
use z_shell_config::ShellPaths;
use z_shell_protocol::MediaRef;
use zeroize::Zeroizing;

/// Maximum number of retained entries, including pinned entries.
pub const MAX_HISTORY_ENTRIES: usize = 100;
/// Maximum combined original payload bytes, including pinned entries.
pub const MAX_HISTORY_BYTES: usize = 256 * 1024 * 1024;

/// Current durable-history behavior; there is deliberately no plaintext mode.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum PersistenceMode {
    /// Authenticated encrypted snapshots are being written.
    Encrypted,
    /// History remains in memory because encrypted persistence is unavailable.
    MemoryOnly {
        /// Visible diagnostic suitable for the clipboard topic.
        reason: String,
    },
}

/// One immutable history entry.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    /// Stable monotonically allocated entry identifier.
    pub id: u64,
    /// Original MIME-labelled bytes.
    pub payload: Payload,
    /// Whether automatic eviction is forbidden for this entry.
    pub pinned: bool,
}

/// Out-of-band image bytes resolved from a session-scoped media token.
#[derive(Clone, Debug)]
pub struct Blob {
    entry_id: u64,
    mime: String,
    bytes: Arc<[u8]>,
}

impl Blob {
    /// Returns the owning entry identifier.
    #[must_use]
    pub fn entry_id(&self) -> u64 {
        self.entry_id
    }

    /// Returns the original encoded image MIME type.
    #[must_use]
    pub fn mime(&self) -> &str {
        &self.mime
    }

    /// Returns the exact original encoded image bytes.
    #[must_use]
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
}

/// History mutation failure without any plaintext fallback.
#[derive(Clone, Debug, PartialEq, Eq, Error)]
#[non_exhaustive]
pub enum HistoryError {
    /// All retention capacity is occupied by pinned entries.
    #[error("clipboard history capacity is occupied by pinned entries")]
    PinnedCapacity,
    /// The entry identifier space is exhausted.
    #[error("clipboard history identifier space is exhausted")]
    IdExhausted,
    /// A cryptographically secure blob token could not be generated.
    #[error("secure randomness is unavailable for clipboard media")]
    Randomness,
}

/// In-memory clipboard state and optional encrypted persistence.
#[derive(Debug)]
pub struct History {
    entries: Vec<Entry>,
    next_id: u64,
    persistence: PersistenceMode,
    store: Option<CryptoStore>,
    blobs: HashMap<String, Blob>,
    tokens: HashMap<u64, String>,
}

impl Default for History {
    fn default() -> Self {
        Self::memory()
    }
}

impl History {
    /// Creates an isolated memory-only history without touching the filesystem.
    #[must_use]
    pub fn memory() -> Self {
        Self {
            entries: Vec::new(),
            next_id: 1,
            persistence: PersistenceMode::MemoryOnly {
                reason: "encrypted persistence is not configured".to_owned(),
            },
            store: None,
            blobs: HashMap::new(),
            tokens: HashMap::new(),
        }
    }

    /// Opens encrypted history under `$XDG_STATE_HOME/z-shell/clipboard/history.enc`.
    ///
    /// Any path, keyring, or authentication failure returns a usable memory-only history.
    pub async fn open() -> Self {
        match ShellPaths::from_env() {
            Ok(paths) => {
                Self::open_with_key_provider(
                    paths.state_dir().join("clipboard").join("history.enc"),
                    &SecretServiceKeyProvider,
                )
                .await
            }
            Err(error) => {
                let mut history = Self::memory();
                history.persistence = PersistenceMode::MemoryOnly {
                    reason: format!("clipboard state path is unavailable: {error}"),
                };
                history
            }
        }
    }

    /// Opens encrypted history with an explicit path and key provider.
    ///
    /// No directory is created until key acquisition succeeds. Authentication failures leave
    /// the original encrypted snapshot untouched and disable all subsequent disk writes.
    pub async fn open_with_key_provider(
        path: impl AsRef<Path>,
        provider: &dyn KeyProvider,
    ) -> Self {
        let mut history = Self::memory();
        match CryptoStore::open(path.as_ref(), provider).await {
            Ok((store, snapshot)) => {
                let restored = match snapshot {
                    Some(snapshot) => decode_snapshot(&snapshot).map(Some),
                    None => Ok(None),
                };
                match restored {
                    Ok(Some((entries, next_id))) => {
                        history.entries = entries;
                        history.next_id = next_id;
                        history.persistence = PersistenceMode::Encrypted;
                        history.store = Some(store);
                        if let Err(error) = history.restore_blobs() {
                            history = Self::memory();
                            history.persistence = PersistenceMode::MemoryOnly { reason: error };
                        }
                    }
                    Ok(None) => {
                        history.persistence = PersistenceMode::Encrypted;
                        history.store = Some(store);
                    }
                    Err(reason) => {
                        history.persistence = PersistenceMode::MemoryOnly { reason };
                    }
                }
            }
            Err(reason) => history.persistence = PersistenceMode::MemoryOnly { reason },
        }
        history
    }

    /// Returns entries in pinned-first, most-recent-first order.
    #[must_use]
    pub fn entries(&self) -> &[Entry] {
        &self.entries
    }

    /// Returns one entry by identifier.
    #[must_use]
    pub fn entry(&self, id: u64) -> Option<&Entry> {
        self.entries.iter().find(|entry| entry.id == id)
    }

    /// Returns the visible persistence state.
    #[must_use]
    pub fn persistence(&self) -> &PersistenceMode {
        &self.persistence
    }

    /// Captures or deduplicates a validated payload and returns its entry identifier.
    ///
    /// # Errors
    ///
    /// Returns [`HistoryError::PinnedCapacity`] when admission would evict a pinned entry,
    /// or a secure-randomness/identifier error without changing history.
    pub fn capture(&mut self, payload: Payload) -> Result<u64, HistoryError> {
        if let Some(position) = self
            .entries
            .iter()
            .position(|entry| entry.payload.same_content(&payload))
        {
            let id = self.entries[position].id;
            let pinned = self.entries[position].pinned;
            let target = if pinned {
                0
            } else {
                self.entries.partition_point(|entry| entry.pinned)
            };
            if position != target {
                let entry = self.entries.remove(position);
                self.entries.insert(target, entry);
                self.persist();
            }
            return Ok(id);
        }

        let pinned_count = self.entries.partition_point(|entry| entry.pinned);
        let pinned_bytes = self.entries[..pinned_count]
            .iter()
            .map(|entry| entry.payload.bytes.len())
            .sum::<usize>();
        if pinned_count >= MAX_HISTORY_ENTRIES
            || pinned_bytes.saturating_add(payload.bytes.len()) > MAX_HISTORY_BYTES
        {
            return Err(HistoryError::PinnedCapacity);
        }
        let id = self.next_id;
        let next_id = id.checked_add(1).ok_or(HistoryError::IdExhausted)?;
        let token = if payload.dimensions().is_some() {
            Some(self.create_blob(id, &payload)?)
        } else {
            None
        };

        let mut total_bytes = self
            .entries
            .iter()
            .map(|entry| entry.payload.bytes.len())
            .sum::<usize>();
        while self.entries.len() >= MAX_HISTORY_ENTRIES
            || total_bytes.saturating_add(payload.bytes.len()) > MAX_HISTORY_BYTES
        {
            let removed = self
                .entries
                .pop()
                .expect("unpinned eviction candidate exists");
            total_bytes = total_bytes.saturating_sub(removed.payload.bytes.len());
            self.revoke_blob(removed.id);
        }
        self.entries.insert(
            pinned_count,
            Entry {
                id,
                payload,
                pinned: false,
            },
        );
        self.next_id = next_id;
        if let Some(token) = token {
            self.tokens.insert(id, token);
        }
        self.persist();
        Ok(id)
    }

    /// Pins an entry and moves it to the front of the pinned prefix.
    #[must_use]
    pub fn pin(&mut self, id: u64) -> bool {
        self.set_pinned(id, true)
    }

    /// Unpins an entry and moves it to the front of recent unpinned history.
    #[must_use]
    pub fn unpin(&mut self, id: u64) -> bool {
        self.set_pinned(id, false)
    }

    /// Forgets an entry and immediately revokes its image blob token.
    #[must_use]
    pub fn forget(&mut self, id: u64) -> bool {
        let Some(position) = self.entries.iter().position(|entry| entry.id == id) else {
            return false;
        };
        self.entries.remove(position);
        self.revoke_blob(id);
        self.persist();
        true
    }

    /// Clears all entries, including pinned entries, and revokes every blob token.
    pub fn clear(&mut self) {
        self.entries.clear();
        self.tokens.clear();
        self.blobs.clear();
        self.persist();
    }

    /// Returns an out-of-band media token for an image entry.
    #[must_use]
    pub fn media_ref(&self, id: u64) -> Option<MediaRef> {
        let entry = self.entry(id)?;
        let token = self.tokens.get(&id)?.clone();
        Some(MediaRef::BlobHandle {
            token,
            mime: entry.payload.mime.clone(),
            byte_len: entry.payload.bytes.len() as u64,
        })
    }

    /// Resolves a live media token without writing image bytes to disk.
    #[must_use]
    pub fn fetch_blob(&self, token: &str) -> Option<&Blob> {
        self.blobs.get(token)
    }

    fn set_pinned(&mut self, id: u64, pinned: bool) -> bool {
        let Some(position) = self.entries.iter().position(|entry| entry.id == id) else {
            return false;
        };
        let mut entry = self.entries.remove(position);
        entry.pinned = pinned;
        let target = if pinned {
            0
        } else {
            self.entries.partition_point(|entry| entry.pinned)
        };
        self.entries.insert(target, entry);
        self.persist();
        true
    }

    fn persist(&mut self) {
        let Some(store) = &self.store else {
            return;
        };
        let snapshot = encode_snapshot(&self.entries, self.next_id);
        if let Err(reason) = store.save(&snapshot) {
            tracing::warn!(%reason, "clipboard history is memory-only after persistence failure");
            self.persistence = PersistenceMode::MemoryOnly { reason };
            self.store = None;
        }
    }

    fn restore_blobs(&mut self) -> Result<(), String> {
        let images = self
            .entries
            .iter()
            .filter(|entry| entry.payload.dimensions().is_some())
            .map(|entry| (entry.id, entry.payload.clone()))
            .collect::<Vec<_>>();
        for (id, payload) in images {
            let token = self
                .create_blob(id, &payload)
                .map_err(|error| error.to_string())?;
            self.tokens.insert(id, token);
        }
        Ok(())
    }

    fn create_blob(&mut self, entry_id: u64, payload: &Payload) -> Result<String, HistoryError> {
        loop {
            let mut random = [0_u8; 32];
            fill(&mut random).map_err(|_| HistoryError::Randomness)?;
            let digest = Sha256::digest(random);
            let token = format!("{digest:x}");
            if self.blobs.contains_key(&token) {
                continue;
            }
            self.blobs.insert(
                token.clone(),
                Blob {
                    entry_id,
                    mime: payload.mime.clone(),
                    bytes: Arc::clone(&payload.bytes),
                },
            );
            return Ok(token);
        }
    }

    fn revoke_blob(&mut self, id: u64) {
        if let Some(token) = self.tokens.remove(&id) {
            self.blobs.remove(&token);
        }
    }
}

fn encode_snapshot(entries: &[Entry], next_id: u64) -> Zeroizing<Vec<u8>> {
    let payload_bytes = entries
        .iter()
        .map(|entry| entry.payload.bytes.len() + entry.payload.mime.len() + 21)
        .sum::<usize>();
    let mut bytes = Zeroizing::new(Vec::with_capacity(12 + payload_bytes));
    bytes.extend_from_slice(&next_id.to_le_bytes());
    bytes.extend_from_slice(&(entries.len() as u32).to_le_bytes());
    for entry in entries {
        bytes.extend_from_slice(&entry.id.to_le_bytes());
        bytes.push(u8::from(entry.pinned));
        bytes.extend_from_slice(&(entry.payload.mime.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&(entry.payload.bytes.len() as u32).to_le_bytes());
        bytes.extend_from_slice(entry.payload.mime.as_bytes());
        bytes.extend_from_slice(&entry.payload.bytes);
    }
    bytes
}

fn decode_snapshot(bytes: &[u8]) -> Result<(Vec<Entry>, u64), String> {
    let mut reader = SnapshotReader { bytes, offset: 0 };
    let next_id = reader.u64()?;
    let count = reader.u32()? as usize;
    if next_id == 0 || count > MAX_HISTORY_ENTRIES {
        return Err("invalid clipboard history limits".to_owned());
    }
    let mut entries = Vec::with_capacity(count);
    let mut total_bytes = 0_usize;
    let mut unpinned_seen = false;
    for _ in 0..count {
        let id = reader.u64()?;
        let pinned = match reader.byte()? {
            0 => false,
            1 => true,
            _ => return Err("invalid clipboard pin flag".to_owned()),
        };
        let mime_length = reader.u32()? as usize;
        let byte_length = reader.u32()? as usize;
        if mime_length > 64
            || byte_length == 0
            || byte_length > MAX_IMAGE_BYTES
            || id == 0
            || id >= next_id
            || (pinned && unpinned_seen)
            || entries.iter().any(|entry: &Entry| entry.id == id)
        {
            return Err("invalid clipboard history record".to_owned());
        }
        total_bytes = total_bytes
            .checked_add(byte_length)
            .ok_or_else(|| "clipboard history byte total overflow".to_owned())?;
        if total_bytes > MAX_HISTORY_BYTES {
            return Err("clipboard history exceeds its byte budget".to_owned());
        }
        unpinned_seen |= !pinned;
        let mime = std::str::from_utf8(reader.take(mime_length)?)
            .map_err(|_| "invalid clipboard MIME encoding".to_owned())?
            .to_owned();
        let maximum = if mime.starts_with("image/") {
            MAX_IMAGE_BYTES
        } else {
            MAX_TEXT_BYTES
        };
        if byte_length > maximum {
            return Err("clipboard payload exceeds its MIME limit".to_owned());
        }
        let payload = Payload::new(mime, reader.take(byte_length)?.to_vec())
            .map_err(|error| format!("invalid persisted clipboard payload: {error}"))?;
        if entries
            .iter()
            .any(|entry| entry.payload.same_content(&payload))
        {
            return Err("duplicate persisted clipboard payload".to_owned());
        }
        entries.push(Entry {
            id,
            payload,
            pinned,
        });
    }
    if reader.offset != reader.bytes.len() {
        return Err("trailing clipboard history data".to_owned());
    }
    Ok((entries, next_id))
}

struct SnapshotReader<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl SnapshotReader<'_> {
    fn take(&mut self, length: usize) -> Result<&[u8], String> {
        let end = self
            .offset
            .checked_add(length)
            .ok_or_else(|| "clipboard history offset overflow".to_owned())?;
        if end > self.bytes.len() {
            return Err("truncated clipboard history".to_owned());
        }
        let value = &self.bytes[self.offset..end];
        self.offset = end;
        Ok(value)
    }

    fn byte(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }

    fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_le_bytes(
            self.take(4)?.try_into().expect("four bytes"),
        ))
    }

    fn u64(&mut self) -> Result<u64, String> {
        Ok(u64::from_le_bytes(
            self.take(8)?.try_into().expect("eight bytes"),
        ))
    }
}
