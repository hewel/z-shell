use thiserror::Error;

/// Failures produced while generating or exporting a theme.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum ThemeError {
    /// A seed was not an opaque six-digit RGB color.
    #[error("invalid seed color `{0}`; expected #rrggbb")]
    InvalidSeed(String),
    /// A generated palette omitted or malformed a required role.
    #[error("invalid color scheme: {0}")]
    InvalidPalette(String),
    /// An encoded wallpaper could not be decoded.
    #[error("could not decode wallpaper: {0}")]
    WallpaperDecode(#[from] image::ImageError),
    /// Every wallpaper pixel was transparent.
    #[error("wallpaper has no visible pixels")]
    EmptyWallpaper,
    /// The optional Matugen executable was not found.
    #[error("optional `matugen` executable is unavailable")]
    MatugenUnavailable,
    /// Matugen exited unsuccessfully or returned an invalid palette.
    #[error("matugen generation failed: {0}")]
    MatugenFailed(String),
    /// A filesystem operation failed.
    #[error("could not {operation} `{}`: {source}", path.display())]
    Io {
        /// Attempted operation.
        operation: &'static str,
        /// Affected path.
        path: std::path::PathBuf,
        /// Underlying filesystem error.
        #[source]
        source: std::io::Error,
    },
    /// Palette generation was cancelled by the async executor.
    #[error("palette generation task failed: {0}")]
    GenerationTask(String),
    /// A recovery record was malformed or unsupported.
    #[error("invalid GTK recovery record `{}`: {message}", path.display())]
    Recovery {
        /// Recovery record path.
        path: std::path::PathBuf,
        /// Validation diagnostic.
        message: String,
    },
}
