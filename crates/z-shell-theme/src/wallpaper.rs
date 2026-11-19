//! Bounded wallpaper decoding and deterministic dominant-seed extraction.

use crate::{Rgb, ThemeError};
use image::{GenericImageView as _, ImageReader, Limits};
use rustix::fs::{self, Mode, OFlags};
use std::collections::BTreeMap;
use std::fs::File;
use std::io::{self, Cursor, Read};
use std::path::Path;

const MAX_SAMPLE_EDGE: u32 = 128;
const MIN_CHROMATIC_RANGE: u8 = 16;
const MAX_IMAGE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_DECODE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_IMAGE_EDGE: u32 = 8192;

#[derive(Debug, Default)]
struct Bin {
    count: u64,
    red: u64,
    green: u64,
    blue: u64,
}

impl Bin {
    fn average(&self) -> Rgb {
        Rgb::new(
            (self.red / self.count) as u8,
            (self.green / self.count) as u8,
            (self.blue / self.count) as u8,
        )
    }
}

/// Extracts a representative seed from encoded PNG, JPEG, or WebP bytes.
///
/// Images are bounded to 128×128 before quantization. Chromatic bins outrank
/// near-gray, black, and white bins unless the visible image is monochrome.
///
/// # Errors
///
/// Returns an error for unsupported image data or an entirely transparent image.
pub fn dominant_color(bytes: &[u8]) -> Result<Rgb, ThemeError> {
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err(ThemeError::WallpaperTooLarge);
    }
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(image::ImageError::from)?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_IMAGE_EDGE);
    limits.max_image_height = Some(MAX_IMAGE_EDGE);
    limits.max_alloc = Some(MAX_DECODE_BYTES);
    reader.limits(limits);
    let decoded = reader.decode()?;
    let sampled = decoded.thumbnail(MAX_SAMPLE_EDGE, MAX_SAMPLE_EDGE);
    let mut bins: BTreeMap<(u8, u8, u8), Bin> = BTreeMap::new();
    for (_, _, pixel) in sampled.pixels() {
        if pixel[3] < 128 {
            continue;
        }
        let key = (pixel[0] >> 4, pixel[1] >> 4, pixel[2] >> 4);
        let bin = bins.entry(key).or_default();
        bin.count += 1;
        bin.red += u64::from(pixel[0]);
        bin.green += u64::from(pixel[1]);
        bin.blue += u64::from(pixel[2]);
    }
    if bins.is_empty() {
        return Err(ThemeError::EmptyWallpaper);
    }
    let has_chromatic = bins.values().any(|bin| {
        let color = bin.average();
        color.red.max(color.green).max(color.blue) - color.red.min(color.green).min(color.blue)
            >= MIN_CHROMATIC_RANGE
    });
    bins.iter()
        .filter(|(_, bin)| {
            if !has_chromatic {
                return true;
            }
            let color = bin.average();
            color.red.max(color.green).max(color.blue) - color.red.min(color.green).min(color.blue)
                >= MIN_CHROMATIC_RANGE
        })
        .map(|(key, bin)| {
            let color = bin.average();
            let chroma = color.red.max(color.green).max(color.blue)
                - color.red.min(color.green).min(color.blue);
            let score = bin.count as f64 * (1.0 + f64::from(chroma) / 255.0);
            (key, color, score)
        })
        .max_by(|(a_key, _, a_score), (b_key, _, b_score)| {
            a_score.total_cmp(b_score).then_with(|| b_key.cmp(a_key))
        })
        .map(|(_, color, _)| color)
        .ok_or(ThemeError::EmptyWallpaper)
}

/// Reads and extracts a representative seed from a wallpaper file.
///
/// # Errors
///
/// Returns an error when reading or decoding fails, or the image is transparent.
pub fn dominant_color_from_path(path: &Path) -> Result<Rgb, ThemeError> {
    let io_error = |source| ThemeError::Io {
        operation: "read wallpaper",
        path: path.to_owned(),
        source,
    };
    // The source can have changed since wallpaper staging. Do not block on a FIFO or
    // trust the size reported by metadata alone.
    let file = File::from(
        fs::open(
            path,
            OFlags::RDONLY | OFlags::NONBLOCK | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|error| io_error(error.into()))?,
    );
    let metadata = file.metadata().map_err(io_error)?;
    if !metadata.is_file() {
        return Err(io_error(io::Error::new(
            io::ErrorKind::InvalidInput,
            "not a regular file",
        )));
    }
    if metadata.len() > MAX_IMAGE_BYTES {
        return Err(ThemeError::WallpaperTooLarge);
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_IMAGE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    dominant_color(&bytes)
}
