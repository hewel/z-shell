//! Pure-Rust Material 3 HCT palettes, optional Matugen, and reversible GTK linking.

mod engine;
mod error;
mod gtk;
mod hct;
mod palette;
mod service;
mod wallpaper;

pub use engine::{GenerationOutcome, GenerationRequest, ThemeEngine, ThemeSnapshot, ThemeSource};

pub use error::ThemeError;
pub use gtk::{GtkLinkStatus, GtkLinker};
pub use hct::{Hct, Rgb};
pub use palette::{ColorScheme, TonalPalette, TonalScale, is_dark_at, parse_seed};
pub use wallpaper::{dominant_color, dominant_color_from_path};
