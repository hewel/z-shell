//! Deterministic Material 3 tonal palettes and color schemes.

use crate::{Hct, Rgb, ThemeError};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use z_shell_config::{ThemeMode, ThemeVariant};

/// Parses an opaque `#rrggbb` seed color.
///
/// # Errors
///
/// Returns [`ThemeError::InvalidSeed`] unless `value` contains exactly six hexadecimal digits.
pub fn parse_seed(value: &str) -> Result<Rgb, ThemeError> {
    let valid = value.len() == 7
        && value.starts_with('#')
        && value[1..].bytes().all(|byte| byte.is_ascii_hexdigit());
    if !valid {
        return Err(ThemeError::InvalidSeed(value.to_owned()));
    }
    let packed = u32::from_str_radix(&value[1..], 16)
        .map_err(|_| ThemeError::InvalidSeed(value.to_owned()))?;
    Ok(Rgb::new(
        ((packed >> 16) & 0xff) as u8,
        ((packed >> 8) & 0xff) as u8,
        (packed & 0xff) as u8,
    ))
}

/// Resolves a theme mode using an injected local hour.
#[must_use]
pub fn is_dark_at(mode: ThemeMode, local_hour: u8) -> bool {
    match mode {
        ThemeMode::Dark => true,
        ThemeMode::Light => false,
        ThemeMode::Auto => !(7..19).contains(&local_hour),
        _ => true,
    }
}

/// One Material hue/chroma scale addressable by CIE L* tone.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct TonalScale {
    /// CAM16 hue shared by every tone.
    pub hue: f64,
    /// Requested CAM16 chroma, gamut-clipped at each tone.
    pub chroma: f64,
}

impl TonalScale {
    /// Creates a tonal scale.
    #[must_use]
    pub const fn new(hue: f64, chroma: f64) -> Self {
        Self { hue, chroma }
    }

    /// Resolves a tone to an opaque `#rrggbb` sRGB color.
    #[must_use]
    pub fn tone(self, tone: f64) -> String {
        Hct::new(self.hue, self.chroma, tone).to_hex()
    }
}

/// Primary, secondary, tertiary, and neutral scales for one variant.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct TonalPalette {
    /// Main accent scale.
    pub primary: TonalScale,
    /// Supporting accent scale.
    pub secondary: TonalScale,
    /// Contrasting accent scale.
    pub tertiary: TonalScale,
    /// Surface scale.
    pub neutral: TonalScale,
    /// Outline and supporting surface scale.
    pub neutral_variant: TonalScale,
}

impl TonalPalette {
    /// Builds all five scales from a seed and Material variant.
    #[must_use]
    pub fn from_seed(seed: Rgb, variant: ThemeVariant) -> Self {
        let source = Hct::from_rgb(seed);
        let hue = source.hue;
        match variant {
            ThemeVariant::Tonal => Self::new(hue, 36.0, hue, 16.0, hue + 60.0, 24.0, 6.0, 8.0),
            ThemeVariant::Vibrant => Self::new(
                hue,
                200.0,
                rotated_hue(
                    hue,
                    &[0.0, 41.0, 61.0, 101.0, 131.0, 181.0, 251.0, 301.0, 360.0],
                    &[18.0, 15.0, 10.0, 12.0, 15.0, 18.0, 15.0, 12.0, 12.0],
                ),
                24.0,
                rotated_hue(
                    hue,
                    &[0.0, 41.0, 61.0, 101.0, 131.0, 181.0, 251.0, 301.0, 360.0],
                    &[35.0, 30.0, 20.0, 25.0, 30.0, 35.0, 30.0, 25.0, 25.0],
                ),
                32.0,
                10.0,
                12.0,
            ),
            ThemeVariant::Expressive => {
                let mut palette = Self::new(
                    hue + 240.0,
                    40.0,
                    rotated_hue(
                        hue,
                        &[0.0, 21.0, 51.0, 121.0, 151.0, 191.0, 271.0, 321.0, 360.0],
                        &[45.0, 95.0, 45.0, 20.0, 45.0, 90.0, 45.0, 45.0, 45.0],
                    ),
                    24.0,
                    rotated_hue(
                        hue,
                        &[0.0, 21.0, 51.0, 121.0, 151.0, 191.0, 271.0, 321.0, 360.0],
                        &[120.0, 120.0, 20.0, 45.0, 20.0, 15.0, 20.0, 120.0, 120.0],
                    ),
                    32.0,
                    8.0,
                    12.0,
                );
                palette.neutral = TonalScale::new(hue + 15.0, 8.0);
                palette.neutral_variant = TonalScale::new(hue + 15.0, 12.0);
                palette
            }
            ThemeVariant::Fidelity => Self::new(
                hue,
                source.chroma,
                hue,
                (source.chroma * 0.5).max(source.chroma - 32.0),
                hue + 180.0,
                source.chroma,
                source.chroma / 8.0,
                source.chroma / 8.0 + 4.0,
            ),
            ThemeVariant::Neutral => Self::new(hue, 12.0, hue, 8.0, hue + 60.0, 16.0, 2.0, 2.0),
            ThemeVariant::Mono => Self::new(hue, 0.0, hue, 0.0, hue, 0.0, 0.0, 0.0),
            _ => Self::from_seed(seed, ThemeVariant::Tonal),
        }
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "three accent scales each require independent hue and chroma"
    )]
    const fn new(
        primary_hue: f64,
        primary_chroma: f64,
        secondary_hue: f64,
        secondary_chroma: f64,
        tertiary_hue: f64,
        tertiary_chroma: f64,
        neutral_chroma: f64,
        neutral_variant_chroma: f64,
    ) -> Self {
        let neutral_hue = primary_hue;
        Self {
            primary: TonalScale::new(primary_hue, primary_chroma),
            secondary: TonalScale::new(secondary_hue, secondary_chroma),
            tertiary: TonalScale::new(tertiary_hue, tertiary_chroma),
            neutral: TonalScale::new(neutral_hue, neutral_chroma),
            neutral_variant: TonalScale::new(neutral_hue, neutral_variant_chroma),
        }
    }
}

fn rotated_hue(source: f64, breaks: &[f64; 9], rotations: &[f64; 9]) -> f64 {
    let index = (0..breaks.len() - 1)
        .find(|&index| source >= breaks[index] && source < breaks[index + 1])
        .unwrap_or(0);
    (source + rotations[index]).rem_euclid(360.0)
}

/// All Material 3 shell color roles as lowercase `#rrggbb` strings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ColorScheme {
    pub primary: String,
    pub on_primary: String,
    pub primary_container: String,
    pub on_primary_container: String,
    pub secondary: String,
    pub on_secondary: String,
    pub secondary_container: String,
    pub on_secondary_container: String,
    pub tertiary: String,
    pub on_tertiary: String,
    pub tertiary_container: String,
    pub on_tertiary_container: String,
    pub error: String,
    pub on_error: String,
    pub error_container: String,
    pub on_error_container: String,
    pub surface: String,
    pub surface_dim: String,
    pub surface_bright: String,
    pub surface_container_lowest: String,
    pub surface_container_low: String,
    pub surface_container: String,
    pub surface_container_high: String,
    pub surface_container_highest: String,
    pub on_surface: String,
    pub on_surface_variant: String,
    pub inverse_surface: String,
    pub inverse_on_surface: String,
    pub outline: String,
    pub outline_variant: String,
    pub scrim: String,
}

impl ColorScheme {
    /// Generates a complete light or dark Material 3 scheme.
    #[must_use]
    pub fn generate(seed: Rgb, variant: ThemeVariant, dark: bool) -> Self {
        let palette = TonalPalette::from_seed(seed, variant);
        let error = if variant == ThemeVariant::Mono {
            palette.neutral
        } else {
            TonalScale::new(25.0, 84.0)
        };
        let tones = |dark_tone, light_tone| if dark { dark_tone } else { light_tone };
        let accent = |scale: TonalScale| {
            (
                scale.tone(tones(80.0, 40.0)),
                scale.tone(tones(20.0, 100.0)),
                scale.tone(tones(30.0, 90.0)),
                scale.tone(tones(90.0, 30.0)),
            )
        };
        let (mut primary, mut on_primary, mut primary_container, mut on_primary_container) =
            accent(palette.primary);
        let (secondary, on_secondary, mut secondary_container, mut on_secondary_container) =
            accent(palette.secondary);
        let (tertiary, on_tertiary, mut tertiary_container, mut on_tertiary_container) =
            accent(palette.tertiary);
        if variant == ThemeVariant::Mono {
            primary = palette.primary.tone(tones(100.0, 0.0));
            on_primary = palette.primary.tone(tones(10.0, 90.0));
            primary_container = palette.primary.tone(tones(85.0, 25.0));
            on_primary_container = palette.primary.tone(tones(0.0, 100.0));
            secondary_container = palette.secondary.tone(tones(30.0, 85.0));
            on_secondary_container = palette.secondary.tone(tones(90.0, 10.0));
            tertiary_container = palette.tertiary.tone(tones(60.0, 40.0));
            on_tertiary_container = palette.tertiary.tone(tones(10.0, 100.0));
        } else if variant == ThemeVariant::Fidelity {
            let source_tone = Hct::from_rgb(seed).tone;
            primary_container = palette.primary.tone(source_tone);
            on_primary_container = foreground_tone(palette.primary, source_tone);
            let container_tone = tones(30.0, 90.0);
            secondary_container = palette.secondary.tone(container_tone);
            on_secondary_container = foreground_tone(palette.secondary, container_tone);
            tertiary_container = palette.tertiary.tone(tones(30.0, 90.0));
            on_tertiary_container = foreground_tone(palette.tertiary, tones(30.0, 90.0));
        }
        let (error_color, on_error, error_container, on_error_container) = accent(error);
        Self {
            primary,
            on_primary,
            primary_container,
            on_primary_container,
            secondary,
            on_secondary,
            secondary_container,
            on_secondary_container,
            tertiary,
            on_tertiary,
            tertiary_container,
            on_tertiary_container,
            error: error_color,
            on_error,
            error_container,
            on_error_container,
            surface: palette.neutral.tone(tones(6.0, 98.0)),
            surface_dim: palette.neutral.tone(tones(6.0, 87.0)),
            surface_bright: palette.neutral.tone(tones(24.0, 98.0)),
            surface_container_lowest: palette.neutral.tone(tones(4.0, 100.0)),
            surface_container_low: palette.neutral.tone(tones(10.0, 96.0)),
            surface_container: palette.neutral.tone(tones(12.0, 94.0)),
            surface_container_high: palette.neutral.tone(tones(17.0, 92.0)),
            surface_container_highest: palette.neutral.tone(tones(22.0, 90.0)),
            on_surface: palette.neutral.tone(tones(90.0, 10.0)),
            on_surface_variant: palette.neutral_variant.tone(tones(80.0, 30.0)),
            inverse_surface: palette.neutral.tone(tones(90.0, 20.0)),
            inverse_on_surface: palette.neutral.tone(tones(20.0, 95.0)),
            outline: palette.neutral_variant.tone(tones(60.0, 50.0)),
            outline_variant: palette.neutral_variant.tone(tones(30.0, 80.0)),
            scrim: palette.neutral.tone(0.0),
        }
    }

    pub(crate) fn from_map(roles: &BTreeMap<String, String>) -> Result<Self, ThemeError> {
        let role = |name: &str| {
            let value = roles
                .get(name)
                .ok_or_else(|| ThemeError::InvalidPalette(format!("missing `{name}`")))?;
            parse_seed(value)
                .map(Rgb::to_hex)
                .map_err(|_| ThemeError::InvalidPalette(format!("`{name}` is not #rrggbb")))
        };
        Ok(Self {
            primary: role("primary")?,
            on_primary: role("on_primary")?,
            primary_container: role("primary_container")?,
            on_primary_container: role("on_primary_container")?,
            secondary: role("secondary")?,
            on_secondary: role("on_secondary")?,
            secondary_container: role("secondary_container")?,
            on_secondary_container: role("on_secondary_container")?,
            tertiary: role("tertiary")?,
            on_tertiary: role("on_tertiary")?,
            tertiary_container: role("tertiary_container")?,
            on_tertiary_container: role("on_tertiary_container")?,
            error: role("error")?,
            on_error: role("on_error")?,
            error_container: role("error_container")?,
            on_error_container: role("on_error_container")?,
            surface: role("surface")?,
            surface_dim: role("surface_dim")?,
            surface_bright: role("surface_bright")?,
            surface_container_lowest: role("surface_container_lowest")?,
            surface_container_low: role("surface_container_low")?,
            surface_container: role("surface_container")?,
            surface_container_high: role("surface_container_high")?,
            surface_container_highest: role("surface_container_highest")?,
            on_surface: role("on_surface")?,
            on_surface_variant: role("on_surface_variant")?,
            inverse_surface: role("inverse_surface")?,
            inverse_on_surface: role("inverse_on_surface")?,
            outline: role("outline")?,
            outline_variant: role("outline_variant")?,
            scrim: role("scrim")?,
        })
    }

    /// Returns all roles keyed by their stable Material names.
    #[must_use]
    pub fn to_map(&self) -> BTreeMap<&'static str, &str> {
        BTreeMap::from([
            ("primary", self.primary.as_str()),
            ("on_primary", self.on_primary.as_str()),
            ("primary_container", self.primary_container.as_str()),
            ("on_primary_container", self.on_primary_container.as_str()),
            ("secondary", self.secondary.as_str()),
            ("on_secondary", self.on_secondary.as_str()),
            ("secondary_container", self.secondary_container.as_str()),
            (
                "on_secondary_container",
                self.on_secondary_container.as_str(),
            ),
            ("tertiary", self.tertiary.as_str()),
            ("on_tertiary", self.on_tertiary.as_str()),
            ("tertiary_container", self.tertiary_container.as_str()),
            ("on_tertiary_container", self.on_tertiary_container.as_str()),
            ("error", self.error.as_str()),
            ("on_error", self.on_error.as_str()),
            ("error_container", self.error_container.as_str()),
            ("on_error_container", self.on_error_container.as_str()),
            ("surface", self.surface.as_str()),
            ("surface_dim", self.surface_dim.as_str()),
            ("surface_bright", self.surface_bright.as_str()),
            (
                "surface_container_lowest",
                self.surface_container_lowest.as_str(),
            ),
            ("surface_container_low", self.surface_container_low.as_str()),
            ("surface_container", self.surface_container.as_str()),
            (
                "surface_container_high",
                self.surface_container_high.as_str(),
            ),
            (
                "surface_container_highest",
                self.surface_container_highest.as_str(),
            ),
            ("on_surface", self.on_surface.as_str()),
            ("on_surface_variant", self.on_surface_variant.as_str()),
            ("inverse_surface", self.inverse_surface.as_str()),
            ("inverse_on_surface", self.inverse_on_surface.as_str()),
            ("outline", self.outline.as_str()),
            ("outline_variant", self.outline_variant.as_str()),
            ("scrim", self.scrim.as_str()),
        ])
    }
}

fn foreground_tone(scale: TonalScale, background_tone: f64) -> String {
    let background = parse_seed(&scale.tone(background_tone)).unwrap_or_default();
    let candidate = (0..=100)
        .map(|tone| {
            let color = parse_seed(&scale.tone(f64::from(tone))).unwrap_or_default();
            let score = contrast(background, color);
            (tone, color, score)
        })
        .filter(|(_, _, ratio)| *ratio >= 4.5)
        .min_by(|(a_tone, _, a_ratio), (b_tone, _, b_ratio)| {
            let a_distance = (f64::from(*a_tone) - background_tone).abs();
            let b_distance = (f64::from(*b_tone) - background_tone).abs();
            a_distance
                .total_cmp(&b_distance)
                .then_with(|| b_ratio.total_cmp(a_ratio))
                .then_with(|| a_tone.cmp(b_tone))
        })
        .map(|(_, color, _)| color)
        .unwrap_or(if background_tone < 50.0 {
            Rgb::new(255, 255, 255)
        } else {
            Rgb::default()
        });
    candidate.to_hex()
}

fn contrast(a: Rgb, b: Rgb) -> f64 {
    let (a, b) = (relative_luminance(a), relative_luminance(b));
    (a.max(b) + 0.05) / (a.min(b) + 0.05)
}

fn relative_luminance(color: Rgb) -> f64 {
    fn channel(value: u8) -> f64 {
        let value = f64::from(value) / 255.0;
        if value <= 0.04045 {
            value / 12.92
        } else {
            ((value + 0.055) / 1.055).powf(2.4)
        }
    }
    0.2126 * channel(color.red) + 0.7152 * channel(color.green) + 0.0722 * channel(color.blue)
}
