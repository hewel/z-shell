//! Bounded decoding and atomic, content-addressed runtime media.

use image::{DynamicImage, GenericImageView, ImageFormat, ImageReader, Limits};
use rustix::fs::{self as rfs, FlockOperation, Mode, OFlags};
use sha2::{Digest, Sha256};
use std::fs::{self, DirBuilder, File};
use std::io::{self, Cursor, Read, Write};
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::{Path, PathBuf};
use tempfile::NamedTempFile;
use thiserror::Error;
use z_shell_protocol::MediaRef;

const MAX_IMAGE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_DECODE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_IMAGE_EDGE: u32 = 8192;
const THUMBNAIL_EDGE: u32 = 320;

#[derive(Debug, Error)]
pub(crate) enum ImageError {
    #[error("could not read source: {0}")]
    Read(#[from] io::Error),
    #[error("source is not a regular file")]
    NotRegular,
    #[error("source exceeds the {MAX_IMAGE_BYTES}-byte wallpaper limit")]
    TooLarge,
    #[error("expected a PNG, JPEG, or WebP image")]
    Format,
    #[error("could not decode image: {0}")]
    Decode(#[from] image::ImageError),
    #[error("wallpaper source path is not valid UTF-8")]
    NonUtf8,
}

#[derive(Debug, Error)]
pub(crate) enum CacheError {
    #[error("wallpaper cache I/O error: {0}")]
    Io(#[from] io::Error),
    #[error("insecure wallpaper cache directory or file: {0}")]
    Insecure(PathBuf),
    #[error("could not encode thumbnail: {0}")]
    Encode(#[from] image::ImageError),
}

#[derive(Debug)]
pub(crate) struct Cache {
    root: PathBuf,
}

pub(crate) struct CachedImage {
    pub(crate) media: MediaRef,
    pub(crate) width: u32,
    pub(crate) height: u32,
}

impl Cache {
    pub(crate) fn new(media_dir: &Path) -> Self {
        Self {
            root: media_dir.join("wallpapers"),
        }
    }

    pub(crate) fn resolve_source(&self, path: &Path) -> Result<PathBuf, ImageError> {
        // Catalog aliases are allowed, but a symlink in the private media cache is not a source.
        if fs::symlink_metadata(path)?.is_symlink()
            && let Some(parent) = path.parent()
            && let Ok(parent) = fs::canonicalize(parent)
            && fs::canonicalize(&self.root).is_ok_and(|cache| parent == cache)
        {
            return Err(ImageError::NotRegular);
        }
        let path = fs::canonicalize(path)?;
        if path.to_str().is_none() {
            return Err(ImageError::NonUtf8);
        }
        Ok(path)
    }

    pub(crate) fn stage(&self, source: &Path) -> Result<(CachedImage, File), StageError> {
        let image = EncodedImage::read(source)?;
        let (width, height) = image.decode()?.dimensions();
        let name = format!("active-{}.{}", short_hash(&image.bytes), image.extension);
        let dir = self.directory()?;
        let file = match dir.open(&name)? {
            Some(file) => file,
            None => dir.write(&name, |temp| Ok(temp.write_all(&image.bytes)?))?,
        };
        // The runtime directory can be shared by multiple daemon instances. Hold a lease for
        // as long as any assignment in this process points at this inode.
        rfs::flock(&file, FlockOperation::LockShared)
            .map_err(io::Error::from)
            .map_err(CacheError::from)?;
        Ok((dir.image(&name, image.mime, width, height), file))
    }

    pub(crate) fn thumbnail(&self, source: &Path) -> Result<CachedImage, StageError> {
        let image = EncodedImage::read(source)?;
        let decoded = image.decode()?;
        let (width, height) = decoded.dimensions();
        let name = format!("thumb-{}.png", short_hash(&image.bytes));
        let dir = self.directory()?;
        if dir.open(&name)?.is_none() {
            let thumbnail = if width > THUMBNAIL_EDGE || height > THUMBNAIL_EDGE {
                decoded.thumbnail(THUMBNAIL_EDGE, THUMBNAIL_EDGE)
            } else {
                decoded
            };
            dir.write(
                &name,
                |temp| Ok(thumbnail.write_to(temp, ImageFormat::Png)?),
            )?;
        }
        Ok(dir.image(&name, "image/png", width, height))
    }

    pub(crate) fn collect(&self) -> Result<(), CacheError> {
        let dir = self.directory()?;
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            let name = entry.file_name();
            let Some(name) = name.to_str().filter(|name| is_active_name(name)) else {
                continue;
            };
            match dir.open(name) {
                Ok(Some(file))
                    if rfs::flock(&file, FlockOperation::NonBlockingLockExclusive).is_ok() =>
                {
                    rfs::unlinkat(&dir.file, name, rfs::AtFlags::empty())
                        .map_err(io::Error::from)?;
                }
                // An active assignment still owns the file, or the entry is not one of ours.
                Ok(_) | Err(CacheError::Insecure(_)) => {}
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }

    fn directory(&self) -> Result<CacheDirectory<'_>, CacheError> {
        match DirBuilder::new().mode(0o700).create(&self.root) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
        let file = File::from(
            rfs::open(
                &self.root,
                OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::empty(),
            )
            .map_err(io::Error::from)?,
        );
        if file.metadata()?.permissions().mode() & 0o777 != 0o700 {
            return Err(CacheError::Insecure(self.root.clone()));
        }
        // Serializes handoff of newly staged files to lease holders against garbage collection.
        rfs::flock(&file, FlockOperation::LockExclusive).map_err(io::Error::from)?;
        Ok(CacheDirectory {
            path: &self.root,
            file,
        })
    }
}

struct CacheDirectory<'a> {
    path: &'a Path,
    file: File,
}

impl CacheDirectory<'_> {
    fn open(&self, name: &str) -> Result<Option<File>, CacheError> {
        let file = match rfs::openat(
            &self.file,
            name,
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
            Mode::empty(),
        ) {
            Ok(fd) => File::from(fd),
            Err(rustix::io::Errno::NOENT) => return Ok(None),
            Err(rustix::io::Errno::LOOP) => return Err(CacheError::Insecure(self.path.join(name))),
            Err(error) => return Err(io::Error::from(error).into()),
        };
        let metadata = file.metadata()?;
        if !metadata.is_file() || metadata.permissions().mode() & 0o777 != 0o600 {
            return Err(CacheError::Insecure(self.path.join(name)));
        }
        Ok(Some(file))
    }

    fn write(
        &self,
        name: &str,
        write: impl FnOnce(&mut File) -> Result<(), CacheError>,
    ) -> Result<File, CacheError> {
        let mut temp = NamedTempFile::new_in(self.path)?;
        write(temp.as_file_mut())?;
        // The cache is recoverable; the rename is for atomic visibility, not crash durability.
        temp.persist(self.path.join(name))
            .map_err(|error| error.error.into())
    }

    fn image(&self, name: &str, mime: &str, width: u32, height: u32) -> CachedImage {
        CachedImage {
            media: MediaRef::RuntimePath {
                path: self.path.join(name),
                mime: mime.to_owned(),
                revision: 1, // Content changes always get a different path.
            },
            width,
            height,
        }
    }
}

#[derive(Debug, Error)]
pub(crate) enum StageError {
    #[error(transparent)]
    Image(#[from] ImageError),
    #[error(transparent)]
    Cache(#[from] CacheError),
}

struct EncodedImage {
    bytes: Vec<u8>,
    format: ImageFormat,
    extension: &'static str,
    mime: &'static str,
}

impl EncodedImage {
    fn read(path: &Path) -> Result<Self, ImageError> {
        let file = File::from(
            rfs::open(
                path,
                OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
                Mode::empty(),
            )
            .map_err(io::Error::from)?,
        );
        let metadata = file.metadata()?;
        if !metadata.is_file() {
            return Err(ImageError::NotRegular);
        }
        if metadata.len() > MAX_IMAGE_BYTES {
            return Err(ImageError::TooLarge);
        }
        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        file.take(MAX_IMAGE_BYTES + 1).read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MAX_IMAGE_BYTES {
            return Err(ImageError::TooLarge);
        }
        let format = image::guess_format(&bytes).map_err(|_| ImageError::Format)?;
        let (extension, mime) = match format {
            ImageFormat::Png => ("png", "image/png"),
            ImageFormat::Jpeg => ("jpg", "image/jpeg"),
            ImageFormat::WebP => ("webp", "image/webp"),
            _ => return Err(ImageError::Format),
        };
        Ok(Self {
            bytes,
            format,
            extension,
            mime,
        })
    }

    fn decode(&self) -> Result<DynamicImage, ImageError> {
        let mut reader = ImageReader::with_format(Cursor::new(&self.bytes), self.format);
        let mut limits = Limits::default();
        limits.max_image_width = Some(MAX_IMAGE_EDGE);
        limits.max_image_height = Some(MAX_IMAGE_EDGE);
        limits.max_alloc = Some(MAX_DECODE_BYTES);
        reader.limits(limits);
        Ok(reader.decode()?)
    }
}

pub(crate) fn short_hash(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut prefix = [0; 8];
    prefix.copy_from_slice(&digest[..8]);
    format!("{:016x}", u64::from_be_bytes(prefix))
}

fn is_active_name(name: &str) -> bool {
    name.strip_prefix("active-")
        .and_then(|name| name.split_once('.'))
        .is_some_and(|(hash, extension)| {
            hash.len() == 16
                && hash.bytes().all(|b| b.is_ascii_hexdigit())
                && matches!(extension, "png" | "jpg" | "webp")
        })
}
