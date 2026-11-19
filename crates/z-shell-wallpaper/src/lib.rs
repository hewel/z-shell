//! Desktop wallpaper catalog, media caching, multi-output persistence, and slideshow service.

mod cache;
mod catalog;
mod service;

pub use catalog::CatalogEntry;
pub use service::{
    ActiveWallpaper, WallpaperError, WallpaperLockState, WallpaperService, WallpaperSleepState,
    WallpaperSnapshot,
};

/// Core topic carrying committed wallpaper assignments and picker status.
pub const WALLPAPER_TOPIC: &str = "wallpaper";
