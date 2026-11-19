//! Clipboard MIME selection, byte-preserving encoding policy, and admission validation.

use image::ImageFormat;
use std::io::Cursor;
use std::sync::Arc;
use thiserror::Error;

/// Maximum admitted UTF-8, legacy text, or Latin-1 payload size.
pub const MAX_TEXT_BYTES: usize = 4 * 1024 * 1024;
/// Maximum admitted encoded image payload size.
pub const MAX_IMAGE_BYTES: usize = 32 * 1024 * 1024;
/// MIME marker used by password managers to identify sensitive offers.
pub const PASSWORD_MANAGER_HINT: &str = "x-kde-passwordManagerHint";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Encoding {
    Utf8,
    LegacyText,
    Latin1,
    Image(ImageFormat),
}

// This is receive priority. It must not be used to infer encoding from aliases.
const MIME_TYPES: &[(&str, Encoding)] = &[
    ("text/plain;charset=utf-8", Encoding::Utf8),
    ("text/plain; charset=utf-8", Encoding::Utf8),
    ("text/plain", Encoding::Utf8),
    ("UTF8_STRING", Encoding::Utf8),
    ("TEXT", Encoding::LegacyText),
    ("STRING", Encoding::Latin1),
    ("image/png", Encoding::Image(ImageFormat::Png)),
    ("image/jpeg", Encoding::Image(ImageFormat::Jpeg)),
    ("image/webp", Encoding::Image(ImageFormat::WebP)),
    ("image/gif", Encoding::Image(ImageFormat::Gif)),
    ("image/bmp", Encoding::Image(ImageFormat::Bmp)),
    ("image/tiff", Encoding::Image(ImageFormat::Tiff)),
];

/// Broad payload classification exposed in clipboard summaries.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PayloadKind {
    /// UTF-8, legacy text, or Latin-1 bytes.
    Text,
    /// An encoded image in one of the supported formats.
    Image,
}

/// Validated encoded image dimensions.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
pub struct ImageDimensions {
    /// Width in pixels.
    pub width: u32,
    /// Height in pixels.
    pub height: u32,
}

/// An immutable clipboard payload with its original MIME label and bytes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Payload {
    pub(crate) mime: String,
    pub(crate) bytes: Arc<[u8]>,
    dimensions: Option<ImageDimensions>,
}

/// Reasons a clipboard payload cannot enter history or be re-offered.
#[derive(Clone, Debug, PartialEq, Eq, Error)]
#[non_exhaustive]
pub enum PayloadError {
    /// The MIME type has no defined lossless clipboard policy.
    #[error("unsupported clipboard MIME type: {0}")]
    UnsupportedMime(String),
    /// The payload exceeds the limit for its MIME family.
    #[error("clipboard payload exceeds {maximum} bytes")]
    TooLarge {
        /// Applicable size limit.
        maximum: usize,
    },
    /// Empty or whitespace-only text is not useful history.
    #[error("clipboard text is empty or blank")]
    BlankText,
    /// UTF-8 and legacy text offers must contain valid UTF-8.
    #[error("clipboard text is not valid UTF-8")]
    InvalidUtf8,
    /// The encoded image failed bounded decoding.
    #[error("invalid or excessive clipboard image")]
    InvalidImage,
}

impl Payload {
    /// Validates and preserves an offered payload without transcoding it.
    ///
    /// # Errors
    ///
    /// Returns [`PayloadError`] for unsupported types, excess size, blank or invalid text,
    /// and images that fail decoding under the 16384×16384 / 128 MiB limits.
    pub fn new(mime: impl Into<String>, bytes: impl Into<Arc<[u8]>>) -> Result<Self, PayloadError> {
        let mime = mime.into();
        let bytes = bytes.into();
        let encoding =
            encoding(&mime).ok_or_else(|| PayloadError::UnsupportedMime(mime.clone()))?;
        let maximum = match encoding {
            Encoding::Image(_) => MAX_IMAGE_BYTES,
            _ => MAX_TEXT_BYTES,
        };
        if bytes.len() > maximum {
            return Err(PayloadError::TooLarge { maximum });
        }
        let dimensions = match encoding {
            Encoding::Latin1 => {
                if !bytes.iter().any(|byte| !char::from(*byte).is_whitespace()) {
                    return Err(PayloadError::BlankText);
                }
                None
            }
            Encoding::Utf8 | Encoding::LegacyText => {
                let text = std::str::from_utf8(&bytes).map_err(|_| PayloadError::InvalidUtf8)?;
                if text.trim().is_empty() {
                    return Err(PayloadError::BlankText);
                }
                None
            }
            Encoding::Image(format) => {
                if bytes.is_empty() {
                    return Err(PayloadError::InvalidImage);
                }
                let mut reader = image::ImageReader::with_format(Cursor::new(&bytes), format);
                let mut limits = image::Limits::default();
                limits.max_image_width = Some(16_384);
                limits.max_image_height = Some(16_384);
                limits.max_alloc = Some(128 * 1024 * 1024);
                reader.limits(limits);
                let image = reader.decode().map_err(|_| PayloadError::InvalidImage)?;
                let (width, height) = (image.width(), image.height());
                if width == 0 || height == 0 {
                    return Err(PayloadError::InvalidImage);
                }
                Some(ImageDimensions { width, height })
            }
        };
        Ok(Self {
            mime,
            bytes,
            dimensions,
        })
    }

    /// Returns the original advertised MIME type.
    #[must_use]
    pub fn mime(&self) -> &str {
        &self.mime
    }

    /// Returns the original bytes, never a transcoded representation.
    #[must_use]
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    /// Returns whether this payload is text or an image.
    #[must_use]
    pub fn kind(&self) -> PayloadKind {
        match encoding(&self.mime) {
            Some(Encoding::Image(_)) => PayloadKind::Image,
            _ => PayloadKind::Text,
        }
    }

    /// Returns dimensions established during bounded image validation.
    #[must_use]
    pub fn dimensions(&self) -> Option<ImageDimensions> {
        self.dimensions
    }

    /// Returns compatible MIME aliases that can serve these exact original bytes.
    #[must_use]
    pub fn copy_mimes(&self) -> Vec<String> {
        let mut mimes = vec![self.mime.clone()];
        let Some(source) = encoding(&self.mime) else {
            return mimes;
        };
        if matches!(source, Encoding::Image(_)) {
            return mimes;
        }
        let ascii = self.bytes.is_ascii();
        let utf8 = source == Encoding::Utf8;
        mimes.extend(
            MIME_TYPES
                .iter()
                .filter(|(mime, target)| {
                    **mime != self.mime
                        && !matches!(target, Encoding::Image(_))
                        && (ascii || (utf8 && *target == Encoding::Utf8))
                })
                .map(|(mime, _)| (*mime).to_owned()),
        );
        mimes
    }

    /// Returns a character-bounded text preview, decoding `STRING` as Latin-1.
    #[must_use]
    pub fn text_preview(&self, characters: usize) -> String {
        if encoding(&self.mime) == Some(Encoding::Latin1) {
            self.bytes
                .iter()
                .take(characters)
                .map(|byte| char::from(*byte))
                .collect()
        } else {
            String::from_utf8_lossy(&self.bytes)
                .chars()
                .take(characters)
                .collect()
        }
    }

    /// Tests case-insensitive text, MIME, and image-format search terms.
    #[must_use]
    pub fn matches_query(&self, query: &str) -> bool {
        let query = query.to_lowercase();
        if query.is_empty() || self.mime.to_lowercase().contains(&query) {
            return true;
        }
        if self.kind() == PayloadKind::Image {
            return query == "image"
                || self
                    .mime
                    .strip_prefix("image/")
                    .is_some_and(|format| format.contains(&query));
        }
        self.search_text().contains(&query)
    }

    pub(crate) fn same_content(&self, other: &Self) -> bool {
        self.bytes == other.bytes && mime_family(&self.mime) == mime_family(&other.mime)
    }

    fn search_text(&self) -> String {
        if encoding(&self.mime) == Some(Encoding::Latin1) {
            self.bytes
                .iter()
                .flat_map(|byte| char::from(*byte).to_lowercase())
                .collect()
        } else {
            String::from_utf8_lossy(&self.bytes).to_lowercase()
        }
    }
}

fn encoding(mime: &str) -> Option<Encoding> {
    MIME_TYPES
        .iter()
        .find_map(|(name, encoding)| (*name == mime).then_some(*encoding))
}

fn mime_family(mime: &str) -> Option<Encoding> {
    match encoding(mime) {
        // TEXT has no independent byte encoding once admitted as valid UTF-8.
        Some(Encoding::LegacyText) => Some(Encoding::Utf8),
        other => other,
    }
}

/// Chooses the highest-priority supported MIME from an offer.
#[must_use]
pub fn choose_mime(mimes: &[String]) -> Option<String> {
    MIME_TYPES
        .iter()
        .find_map(|(wanted, _)| mimes.iter().find(|mime| mime.as_str() == *wanted).cloned())
}

/// Returns whether any offered MIME marks the complete selection as sensitive.
#[must_use]
pub fn offer_is_sensitive(mimes: &[String]) -> bool {
    mimes.iter().any(|mime| mime == PASSWORD_MANAGER_HINT)
}

/// Checks image terminators before a complete transfer enters history or backup ownership.
pub(crate) fn looks_complete(mime: &str, bytes: &[u8]) -> bool {
    match encoding(mime) {
        Some(Encoding::Image(ImageFormat::Png)) => {
            bytes.ends_with(&[0, 0, 0, 0, b'I', b'E', b'N', b'D', 0xae, 0x42, 0x60, 0x82])
        }
        Some(Encoding::Image(ImageFormat::Jpeg)) => bytes.ends_with(&[0xff, 0xd9]),
        Some(Encoding::Image(ImageFormat::Gif)) => bytes.ends_with(&[0x3b]),
        Some(Encoding::Image(ImageFormat::WebP)) if bytes.len() >= 12 && &bytes[..4] == b"RIFF" => {
            u32::from_le_bytes(bytes[4..8].try_into().expect("four-byte RIFF length")) as usize
                == bytes.len() - 8
        }
        Some(Encoding::Image(ImageFormat::Bmp)) if bytes.len() >= 6 && &bytes[..2] == b"BM" => {
            u32::from_le_bytes(bytes[2..6].try_into().expect("four-byte BMP length")) as usize
                == bytes.len()
        }
        _ => true,
    }
}
