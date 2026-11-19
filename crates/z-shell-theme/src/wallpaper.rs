//! Bounded wallpaper decoding and deterministic dominant-seed extraction.

use crate::{Rgb, ThemeError};
use image::GenericImageView as _;
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

const MAX_SAMPLE_EDGE: u32 = 128;
const MIN_CHROMATIC_RANGE: u8 = 16;

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
    let decoded = image::load_from_memory(bytes)?;
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
    let bytes = fs::read(path).map_err(|source| ThemeError::Io {
        operation: "read wallpaper",
        path: path.to_owned(),
        source,
    })?;
    dominant_color(&bytes)
}
