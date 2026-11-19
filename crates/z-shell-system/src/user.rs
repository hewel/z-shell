//! Effective-user identity and restricted runtime avatar references.

use crate::{SystemBus, Topic};
use rustix::fs::{
    AtFlags, Mode, OFlags, RenameFlags, fchmod, open, openat, renameat_with, unlinkat,
};
use rustix::io::Errno;
use rustix::process::geteuid;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::ffi::OsStr;
use std::fs::{File, Metadata};
use std::io::{self, Read, Write};
use std::os::unix::{ffi::OsStrExt, fs::MetadataExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use thiserror::Error;
use tokio::task::{self, JoinHandle};
use tokio::time::{self, MissedTickBehavior};
use z_shell_bus::BusHub;
use z_shell_config::{PathError, ShellPaths};
use z_shell_protocol::MediaRef;
use zbus::zvariant::OwnedObjectPath;
use zbus::{Connection, Proxy};

const ACCOUNTS: &str = "org.freedesktop.Accounts";
const ACCOUNTS_PATH: &str = "/org/freedesktop/Accounts";
const POLL_INTERVAL: Duration = Duration::from_secs(5);
const LOOKUP_TIMEOUT: Duration = Duration::from_secs(2);
const PASSWD_LIMIT: u64 = 1024 * 1024;
const AVATAR_LIMIT: u64 = 8 * 1024 * 1024;
const READ_FLAGS: OFlags = OFlags::RDONLY
    .union(OFlags::CLOEXEC)
    .union(OFlags::NONBLOCK);
const DIRECTORY_FLAGS: OFlags = READ_FLAGS.union(OFlags::DIRECTORY).union(OFlags::NOFOLLOW);

/// Identity settings in a local passwd row.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct Account {
    /// Account login name.
    pub username: String,
    /// First GECOS field, or the login name if it is empty.
    pub display_name: String,
    /// Absolute home directory, if one is specified.
    pub home: Option<PathBuf>,
}

impl Account {
    /// Finds an account in an injected passwd file by numeric UID, without querying NSS or D-Bus.
    ///
    /// # Errors
    ///
    /// Returns an I/O error if the file is unreadable, is not regular, or exceeds 1 MiB.
    pub fn from_passwd(path: &Path, uid: u32) -> io::Result<Option<Self>> {
        let bytes = read_regular(path, PASSWD_LIMIT)?;
        for line in bytes.split(|byte| *byte == b'\n') {
            let mut fields = line.split(|byte| *byte == b':');
            let (Some(login), Some(id), Some(gecos), Some(home), Some(_shell)) = (
                fields.next(),
                fields.nth(1),
                fields.nth(1),
                fields.next(),
                fields.next(),
            ) else {
                continue;
            };
            if login.is_empty()
                || std::str::from_utf8(id).ok().and_then(|id| id.parse().ok()) != Some(uid)
            {
                continue;
            }
            let display_name = gecos.split(|byte| *byte == b',').next().unwrap_or_default();
            let display_name = String::from_utf8_lossy(display_name);
            let display_name = display_name.trim();
            let username = String::from_utf8_lossy(login).into_owned();
            let display_name = if display_name.is_empty() {
                username.clone()
            } else {
                display_name.to_owned()
            };
            let home = Path::new(OsStr::from_bytes(home));
            return Ok(Some(Self {
                username,
                display_name,
                home: home.is_absolute().then(|| home.to_owned()),
            }));
        }
        Ok(None)
    }
}

/// Failure to verify or publish an avatar in the restricted runtime cache.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum AvatarError {
    /// The configured shell directories could not be prepared safely.
    #[error(transparent)]
    Paths(#[from] PathError),
    /// A runtime cache operation failed or a cache entry was insecure.
    #[error("avatar cache: {0}")]
    Io(#[from] io::Error),
}

/// Projects avatar files into SHA-256-addressed runtime media tokens.
///
/// Revisions increase when the selected bytes change or an avatar reappears after absence.
/// A revision sequence belongs to one cache instance. Digest-named files are shared by daemon
/// instances using the same runtime directory, so existing tokens stay valid until runtime cleanup.
#[derive(Debug)]
pub struct AvatarCache {
    paths: ShellPaths,
    current: Option<CachedAvatar>,
    revision: u64,
}

#[derive(Debug)]
struct CachedAvatar {
    digest: [u8; 32],
    stamp: FileStamp,
}

impl AvatarCache {
    /// Creates a cache using explicit shell paths; does not read the environment or touch disk.
    #[must_use]
    pub fn new(paths: ShellPaths) -> Self {
        Self {
            paths,
            current: None,
            revision: 0,
        }
    }

    /// Checks the state override, `.face.icon`, `.face`, and AccountsService icon in order.
    ///
    /// Skips unreadable, non-regular, oversized (over 8 MiB), or unrecognized inputs. Recognizes
    /// PNG, JPEG, GIF, and WebP by signature. The supplied home and icon paths are optional.
    ///
    /// # Errors
    ///
    /// Returns an error if a selected avatar cannot be safely published in the runtime cache.
    pub fn refresh(
        &mut self,
        home: Option<&Path>,
        accounts_icon: Option<&Path>,
    ) -> Result<Option<MediaRef>, AvatarError> {
        let input = read_avatar(&self.paths.state_dir().join("avatar"))
            .or_else(|| {
                home.and_then(|home| {
                    read_avatar(&home.join(".face.icon"))
                        .or_else(|| read_avatar(&home.join(".face")))
                })
            })
            .or_else(|| accounts_icon.and_then(read_avatar));
        let Some((bytes, mime)) = input else {
            self.current = None;
            return Ok(None);
        };
        let digest = Sha256::digest(&bytes);
        let name = format!("avatar-{digest:x}");
        let digest = digest.into();
        let same_content = self
            .current
            .as_ref()
            .filter(|current| current.digest == digest);
        let dir = self.media_dir()?;
        let stamp = publish_avatar(
            &dir,
            &name,
            &bytes,
            same_content.map(|current| &current.stamp),
        )?;
        if same_content.is_none() {
            self.revision = self
                .revision
                .checked_add(1)
                .ok_or_else(|| io::Error::other("avatar revision exhausted"))?;
        }
        self.current = Some(CachedAvatar { digest, stamp });
        Ok(Some(MediaRef::RuntimePath {
            path: self.paths.media_dir().join(name),
            mime: mime.to_owned(),
            revision: self.revision,
        }))
    }

    fn media_dir(&self) -> Result<File, AvatarError> {
        if !self.paths.runtime_dir().is_absolute() {
            return Err(insecure_io().into());
        }
        match open_media_dir(&self.paths) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                self.paths.ensure_dirs()?;
                Ok(open_media_dir(&self.paths)?)
            }
            result => Ok(result?),
        }
    }
}

fn read_regular(path: &Path, limit: u64) -> io::Result<Vec<u8>> {
    let file = File::from(open(path, READ_FLAGS, Mode::empty())?);
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() > limit {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "not a bounded regular file",
        ));
    }
    let mut bytes = Vec::with_capacity(usize::try_from(metadata.len()).unwrap_or_default());
    file.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "file exceeds read limit",
        ));
    }
    Ok(bytes)
}

fn read_avatar(path: &Path) -> Option<(Vec<u8>, &'static str)> {
    let bytes = read_regular(path, AVATAR_LIMIT).ok()?;
    let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        "image/jpeg"
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        "image/gif"
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        "image/webp"
    } else {
        return None;
    };
    Some((bytes, mime))
}

fn open_media_dir(paths: &ShellPaths) -> io::Result<File> {
    let runtime = File::from(open(paths.runtime_dir(), DIRECTORY_FLAGS, Mode::empty())?);
    check_private_dir(&runtime)?;
    let media = File::from(openat(&runtime, "media", DIRECTORY_FLAGS, Mode::empty())?);
    check_private_dir(&media)?;
    Ok(media)
}

fn check_private_dir(dir: &File) -> io::Result<()> {
    let stat = dir.metadata()?;
    if stat.uid() != geteuid().as_raw() || stat.mode() & 0o7777 != 0o700 {
        return Err(insecure_io());
    }
    Ok(())
}

fn insecure_io() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "insecure runtime avatar cache path",
    )
}

#[derive(Debug, PartialEq, Eq)]
struct FileStamp {
    device: u64,
    inode: u64,
    changed: (i64, i64),
    modified: (i64, i64),
}

impl From<Metadata> for FileStamp {
    fn from(stat: Metadata) -> Self {
        Self {
            device: stat.dev(),
            inode: stat.ino(),
            changed: (stat.ctime(), stat.ctime_nsec()),
            modified: (stat.mtime(), stat.mtime_nsec()),
        }
    }
}

fn publish_avatar(
    dir: &File,
    name: &str,
    bytes: &[u8],
    previous: Option<&FileStamp>,
) -> io::Result<FileStamp> {
    let flags = READ_FLAGS | OFlags::NOFOLLOW;
    match openat(dir, name, flags, Mode::empty()) {
        Ok(file) => return verify_avatar(File::from(file), bytes, previous),
        Err(Errno::NOENT) => {}
        Err(error) => return Err(error.into()),
    }
    let mut temp = TemporaryAvatar::create(dir)?;
    temp.file.write_all(bytes)?;
    match renameat_with(dir, temp.name.as_str(), dir, name, RenameFlags::NOREPLACE) {
        Ok(()) => {
            temp.published = true;
            Ok(temp.file.metadata()?.into())
        }
        Err(Errno::EXIST) => verify_avatar(
            File::from(openat(dir, name, flags, Mode::empty())?),
            bytes,
            previous,
        ),
        Err(error) => Err(error.into()),
    }
}

fn verify_avatar(
    mut file: File,
    bytes: &[u8],
    previous: Option<&FileStamp>,
) -> io::Result<FileStamp> {
    let stat = file.metadata()?;
    if !stat.is_file()
        || stat.uid() != geteuid().as_raw()
        || stat.mode() & 0o7777 != 0o600
        || stat.nlink() != 1
        || stat.len() != bytes.len() as u64
    {
        return Err(insecure_io());
    }
    let stamp = FileStamp::from(stat);
    if previous != Some(&stamp) {
        let mut buffer = [0; 8192];
        for expected in bytes.chunks(buffer.len()) {
            let actual = &mut buffer[..expected.len()];
            file.read_exact(actual)?;
            if actual != expected {
                return Err(insecure_io());
            }
        }
        if FileStamp::from(file.metadata()?) != stamp {
            return Err(insecure_io());
        }
    }
    Ok(stamp)
}

struct TemporaryAvatar<'dir> {
    dir: &'dir File,
    name: String,
    file: File,
    published: bool,
}

impl<'dir> TemporaryAvatar<'dir> {
    fn create(dir: &'dir File) -> io::Result<Self> {
        static NEXT_FILE: AtomicU64 = AtomicU64::new(0);
        let flags = OFlags::WRONLY | OFlags::CLOEXEC | OFlags::CREATE | OFlags::EXCL;
        let mode = Mode::RUSR | Mode::WUSR;
        loop {
            let counter = NEXT_FILE.fetch_add(1, Ordering::Relaxed);
            let name = format!(".avatar-{}-{counter}.tmp", std::process::id());
            match openat(dir, name.as_str(), flags, mode) {
                Ok(fd) => {
                    let temp = Self {
                        dir,
                        name,
                        file: File::from(fd),
                        published: false,
                    };
                    fchmod(&temp.file, mode)?;
                    return Ok(temp);
                }
                Err(Errno::EXIST) => {}
                Err(error) => return Err(error.into()),
            }
        }
    }
}

impl Drop for TemporaryAvatar<'_> {
    fn drop(&mut self) {
        if !self.published {
            let _ = unlinkat(self.dir, self.name.as_str(), AtFlags::empty());
        }
    }
}

#[derive(Default)]
struct RemoteAccount {
    username: Option<String>,
    display_name: Option<String>,
    home: Option<PathBuf>,
    icon_file: Option<PathBuf>,
}

async fn accounts_service(connection: &Connection, uid: u32) -> Option<RemoteAccount> {
    let manager = Proxy::new(connection, ACCOUNTS, ACCOUNTS_PATH, ACCOUNTS)
        .await
        .ok()?;
    let path: OwnedObjectPath = manager
        .call("FindUserById", &(i64::from(uid),))
        .await
        .ok()?;
    let user = Proxy::new(
        connection,
        ACCOUNTS,
        path.as_str(),
        "org.freedesktop.Accounts.User",
    )
    .await
    .ok()?;
    let (username, display_name, home, icon_file) = tokio::join!(
        user.get_property::<String>("UserName"),
        user.get_property::<String>("RealName"),
        user.get_property::<String>("HomeDirectory"),
        user.get_property::<String>("IconFile"),
    );
    Some(RemoteAccount {
        username: username.ok().filter(|value| !value.is_empty()),
        display_name: display_name.ok().filter(|value| !value.trim().is_empty()),
        home: absolute_path(home.ok()),
        icon_file: absolute_path(icon_file.ok()),
    })
}

fn absolute_path(raw: Option<String>) -> Option<PathBuf> {
    raw.map(PathBuf::from).filter(|path| path.is_absolute())
}

#[derive(PartialEq, Serialize)]
struct Snapshot {
    uid: u32,
    username: Option<String>,
    display_name: Option<String>,
    avatar: Option<MediaRef>,
}

fn snapshot(uid: u32, remote: Option<RemoteAccount>, cache: &mut AvatarCache) -> Snapshot {
    let remote = remote.unwrap_or_default();
    let local =
        if remote.username.is_none() || remote.display_name.is_none() || remote.home.is_none() {
            Account::from_passwd(Path::new("/etc/passwd"), uid)
                .ok()
                .flatten()
        } else {
            None
        };
    let (username, display_name, home) = local.map_or((None, None, None), |local| {
        (Some(local.username), Some(local.display_name), local.home)
    });
    let username = remote.username.or(username);
    let display_name = remote
        .display_name
        .or(display_name)
        .or_else(|| username.clone());
    let home = remote.home.or(home);
    let avatar = cache
        .refresh(home.as_deref(), remote.icon_file.as_deref())
        .ok()
        .flatten();
    Snapshot {
        uid,
        username,
        display_name,
        avatar,
    }
}

pub(crate) fn install(hub: &BusHub, paths: &ShellPaths, bus: SystemBus) -> JoinHandle<()> {
    let uid = geteuid().as_raw();
    let mut cache = AvatarCache::new(paths.clone());
    let initial = Snapshot {
        uid,
        username: None,
        display_name: None,
        avatar: None,
    };
    let mut topic = Topic::new(hub, "system.user", initial);
    topic.resync();
    tokio::spawn(async move {
        let mut interval = time::interval(POLL_INTERVAL);
        interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            let remote = if let Some(connection) = bus.connection().await {
                time::timeout(LOOKUP_TIMEOUT, accounts_service(&connection, uid))
                    .await
                    .ok()
                    .flatten()
            } else {
                None
            };
            let accounts_available = remote.is_some();
            let Ok((next_cache, next)) = task::spawn_blocking(move || {
                let next = snapshot(uid, remote, &mut cache);
                (cache, next)
            })
            .await
            else {
                break;
            };
            cache = next_cache;
            topic.update(next, accounts_available);
        }
    })
}
