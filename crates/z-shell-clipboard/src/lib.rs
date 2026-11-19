//! Encrypted native Wayland clipboard history, media tokens, and bus integration.

mod crypto;
mod history;
mod payload;
mod service;
mod transport;

pub use crypto::{KeyError, KeyProvider, MockKeyProvider, SecretServiceKeyProvider};
pub use history::{
    Blob, Entry, History, HistoryError, MAX_HISTORY_BYTES, MAX_HISTORY_ENTRIES, PersistenceMode,
};
pub use payload::{
    ImageDimensions, MAX_IMAGE_BYTES, MAX_TEXT_BYTES, PASSWORD_MANAGER_HINT, Payload, PayloadError,
    PayloadKind, choose_mime, offer_is_sensitive,
};
pub use service::{
    ClipboardEntrySummary, ClipboardService, ClipboardSnapshot, LockedState,
    MAX_BLOB_RESPONSE_BYTES, TransportStatus,
};
pub use transport::{Event as TransportEvent, Transport, TransportError};
