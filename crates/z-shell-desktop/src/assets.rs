use std::collections::HashMap;
use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Cursor, Read, Write};
use std::os::unix::ffi::OsStringExt;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use image::{
    ExtendedColorType, ImageEncoder, ImageFormat, ImageReader, Limits, codecs::png::PngEncoder,
};
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use z_shell_bus::CommandCall;
use z_shell_protocol::{
    ClientRole, CommandInvokeResult, ErrorCode, MAX_SAFE_JS_INT, MediaRef, RpcError,
};

use crate::{data, not_found, payload};

pub(crate) const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;
const MAX_IMAGE_DIMENSION: u32 = 4096;
// JSON octets use at most four bytes each; leave room for the RPC envelope.
const MAX_BLOB_BYTES: usize = 200_000;

pub(crate) fn local_path(value: &str) -> Option<PathBuf> {
    let Some(uri) = value.strip_prefix("file://") else {
        return Path::new(value).is_absolute().then(|| PathBuf::from(value));
    };
    let path = uri.strip_prefix("localhost").unwrap_or(uri);
    if !path.starts_with('/') || path.contains(['?', '#']) {
        return None;
    }
    let mut decoded = Vec::with_capacity(path.len());
    let mut bytes = path.bytes();
    while let Some(byte) = bytes.next() {
        decoded.push(if byte == b'%' {
            let hi = char::from(bytes.next()?).to_digit(16)?;
            let lo = char::from(bytes.next()?).to_digit(16)?;
            u8::try_from(hi * 16 + lo).ok()?
        } else {
            byte
        });
    }
    (!decoded.contains(&0)).then(|| PathBuf::from(OsString::from_vec(decoded)))
}

pub(crate) fn read_bounded(path: &Path, max: usize) -> Option<Vec<u8>> {
    let before = fs::metadata(path).ok()?;
    if !before.is_file() || before.len() > max as u64 {
        return None;
    }
    let file = File::open(path).ok()?;
    let metadata = file.metadata().ok()?;
    if !metadata.is_file() || metadata.len() > max as u64 {
        return None;
    }
    let mut bytes = Vec::with_capacity(usize::try_from(metadata.len()).ok()?);
    file.take(max as u64 + 1).read_to_end(&mut bytes).ok()?;
    (bytes.len() <= max).then_some(bytes)
}

pub(crate) fn cache_image(dir: &Path, bytes: &[u8]) -> Option<MediaRef> {
    let format = image::guess_format(bytes).ok()?;
    let (extension, mime) = match format {
        ImageFormat::Png => ("png", "image/png"),
        ImageFormat::Jpeg => ("jpg", "image/jpeg"),
        ImageFormat::WebP => ("webp", "image/webp"),
        _ => return None,
    };
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_IMAGE_DIMENSION);
    limits.max_image_height = Some(MAX_IMAGE_DIMENSION);
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits);
    reader.decode().ok()?;
    cache(dir, bytes, extension, mime)
}

pub(crate) fn cache_icon(dir: &Path, path: &Path) -> Option<MediaRef> {
    let bytes = read_bounded(path, MAX_IMAGE_BYTES)?;
    if path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("svg"))
    {
        let mut svg = std::str::from_utf8(&bytes)
            .ok()?
            .trim_start_matches('\u{feff}')
            .trim_start();
        for _ in 0..32 {
            if let Some(rest) = svg.strip_prefix("<?").and_then(|s| s.split_once("?>")) {
                svg = rest.1.trim_start();
            } else if let Some(rest) = svg.strip_prefix("<!--").and_then(|s| s.split_once("-->")) {
                svg = rest.1.trim_start();
            } else if let Some(rest) = svg
                .strip_prefix("<!DOCTYPE")
                .and_then(|s| s.split_once('>'))
            {
                svg = rest.1.trim_start();
            } else {
                break;
            }
        }
        if svg.starts_with("<svg")
            && svg[4..].starts_with(|c: char| c.is_ascii_whitespace() || matches!(c, '>' | '/'))
        {
            return cache(dir, &bytes, "svg", "image/svg+xml");
        }
        return None;
    }
    cache_image(dir, &bytes)
}

fn cache(dir: &Path, bytes: &[u8], extension: &str, mime: &str) -> Option<MediaRef> {
    let digest = Sha256::digest(bytes);
    let revision = u64::from_be_bytes(digest[..8].try_into().ok()?) & MAX_SAFE_JS_INT;
    let path = dir.join(format!("{digest:x}.{extension}"));
    if !path
        .symlink_metadata()
        .is_ok_and(|metadata| metadata.is_file())
    {
        let temporary = dir.join(format!(".{}", random_token()?));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)
            .ok()?;
        if file
            .write_all(bytes)
            .and_then(|()| fs::rename(&temporary, &path))
            .is_err()
        {
            let _ = fs::remove_file(&temporary);
            return None;
        }
    }
    Some(MediaRef::RuntimePath {
        path,
        mime: mime.to_owned(),
        revision,
    })
}

fn random_token() -> Option<String> {
    let mut bytes = [0; 16];
    getrandom::fill(&mut bytes).ok()?;
    Some(format!("{:032x}", u128::from_be_bytes(bytes)))
}

pub(crate) fn png_rgba(width: u32, height: u32, pixels: &[u8]) -> Option<Vec<u8>> {
    if width == 0
        || height == 0
        || width > MAX_IMAGE_DIMENSION
        || height > MAX_IMAGE_DIMENSION
        || (width as usize) * (height as usize) * 4 != pixels.len()
        || pixels.len() > MAX_IMAGE_BYTES
    {
        return None;
    }
    let mut png = BlobWriter(Vec::new());
    PngEncoder::new(&mut png)
        .write_image(pixels, width, height, ExtendedColorType::Rgba8)
        .ok()?;
    Some(png.0)
}

struct BlobWriter(Vec<u8>);

impl Write for BlobWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > MAX_BLOB_BYTES - self.0.len() {
            return Err(io::Error::other("PNG exceeds blob byte budget"));
        }
        self.0.write(bytes)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[derive(Debug, Default)]
pub(crate) struct Blobs(HashMap<String, Vec<u8>>);

impl Blobs {
    pub(crate) fn insert_png(&mut self, bytes: Vec<u8>) -> Option<MediaRef> {
        if bytes.len() > MAX_BLOB_BYTES {
            return None;
        }
        let token = random_token()?;
        let byte_len = bytes.len() as u64;
        self.0.insert(token.clone(), bytes);
        Some(MediaRef::BlobHandle {
            token,
            mime: "image/png".to_owned(),
            byte_len,
        })
    }

    pub(crate) fn revoke(&mut self, media: Option<&MediaRef>) {
        if let Some(MediaRef::BlobHandle { token, .. }) = media {
            self.0.remove(token);
        }
    }

    pub(crate) fn fetch(&self, call: &CommandCall) -> Result<CommandInvokeResult, RpcError> {
        if call.caller.role != ClientRole::PrivilegedHost {
            return Err(RpcError::new(
                ErrorCode::PermissionDenied,
                "blob fetch requires the privileged host channel",
            ));
        }
        #[derive(Deserialize)]
        struct Token<'a> {
            token: &'a str,
        }
        let token: Token<'_> = payload(call)?;
        let bytes = self
            .0
            .get(token.token)
            .ok_or_else(|| not_found("blob token is unknown or revoked"))?;
        Ok(data(
            json!({"mime":"image/png", "byte_len":bytes.len(), "bytes":bytes}),
        ))
    }
}
