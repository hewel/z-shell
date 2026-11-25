//! Prepare a pinned, metadata-free export from a Git source.

use std::borrow::Cow;
use std::env;
use std::ffi::OsStr;
use std::fs::{self, File, Permissions};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

use rustix::fs::{Mode, OFlags, ResolveFlags, openat2};
use sha2::{Digest, Sha256};
use tempfile::tempdir_in;
use thiserror::Error;
use z_shell_protocol::PluginId;

use super::bundle::{BundleError, materialize_bundle};
use super::digest::{DigestError, content_digest};
use super::manifest::{Manifest, ManifestError};
use super::registry::OfflinePolicy;

const FETCHED_COMMIT: &str = "refs/z-shell/fetched^{commit}";
const FETCHED_REF: &str = "refs/z-shell/fetched";
const GIT_SHA1_HEX_LEN: usize = 40;
const MAX_SYMLINK_BYTES: usize = 4095;

/// Error returned when fetching, resolving, or exporting a Git plugin source.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum GitError {
    /// Remote Git fetch attempted while offline mode is active.
    #[error("git sources cannot be fetched in offline mode")]
    Offline,
    /// Remote URL failed scheme or syntax validation.
    #[error("invalid or unsupported git remote URL")]
    InvalidUrl,
    /// Git reference string contains forbidden characters or traversal components.
    #[error("invalid git ref {0:?}")]
    InvalidRef(String),
    /// Remote repository did not advertise the requested branch or tag.
    #[error("git remote does not advertise ref {0:?}")]
    MissingRef(String),
    /// Invoked `git` subprocess failed.
    #[error("git {operation} failed: {message}")]
    Command {
        /// Git subcommand name.
        operation: &'static str,
        /// Captured stderr or exit status.
        message: String,
    },
    /// Git emitted unexpected output while listing or reading objects.
    #[error("git returned malformed {0}")]
    InvalidOutput(&'static str),
    /// Tree contained an unsupported POSIX mode (such as gitlink/submodule).
    #[error("unsupported git tree entry mode {0}")]
    UnsupportedMode(String),
    /// Monorepo `--subdir` path is empty, absolute, or contains traversal segments.
    #[error("invalid git subdir {0:?}")]
    InvalidSubdir(String),
    /// Exported manifest `id` differed from the expected plugin identifier.
    #[error("git source changed plugin id: expected {expected}, got {actual}")]
    IdChanged {
        /// Expected plugin identifier.
        expected: PluginId,
        /// Observed plugin identifier in updated tree.
        actual: PluginId,
    },
    /// Cache or target directory is not a plain directory.
    #[error("expected a real directory at {0}")]
    InvalidDirectory(PathBuf),
    /// Symlink resolved outside the exported plugin subtree or bundle root.
    #[error("cannot resolve git symlink within its export: {path}")]
    UnsafeSymlink {
        /// Offending relative symlink path.
        path: PathBuf,
        /// Kernel `openat2` errno.
        #[source]
        source: rustix::io::Errno,
    },
    /// Filesystem I/O failure during Git preparation or export.
    #[error("git export I/O failed: {0}")]
    Io(#[from] io::Error),
    /// Manifest validation or `.qjsb` tree check failed.
    #[error(transparent)]
    Manifest(#[from] ManifestError),
    /// Bundle content digest calculation failed.
    #[error(transparent)]
    Digest(#[from] DigestError),
    /// Immutable bundle materialization failed.
    #[error(transparent)]
    Bundle(#[from] BundleError),
}

pub(super) struct GitWorkspace<'a> {
    pub(super) plugins_dir: &'a Path,
    pub(super) bundles_dir: &'a Path,
    pub(super) staging_dir: &'a Path,
}

pub(super) struct PreparedGit {
    pub(super) url: String,
    pub(super) root: PathBuf,
    pub(super) rev: String,
    pub(super) subdir: Option<String>,
    pub(super) manifest: Manifest,
    pub(super) content_digest: String,
}

pub(super) fn prepare_bundle(
    workspace: GitWorkspace<'_>,
    url: &str,
    ref_name: &str,
    subdir: Option<&str>,
    policy: OfflinePolicy,
    expected_id: Option<&PluginId>,
) -> Result<PreparedGit, GitError> {
    let subdir = subdir.map(validate_subdir).transpose()?;
    let url = normalize_url(url)?;
    let rev = ensure_fetched_rev(workspace.plugins_dir, &url, ref_name, policy)?;
    let cache = workspace
        .plugins_dir
        .join("git-cache")
        .join(format!("{:x}", Sha256::digest(url.as_bytes())));

    ensure_directory(workspace.staging_dir)?;
    let staging = tempdir_in(workspace.staging_dir)?;
    let candidate = staging.path().join(&rev);
    create_export_dir(&candidate)?;
    export_tree(&cache, &rev, subdir.as_deref(), &candidate)?;
    let manifest = Manifest::load(&candidate)?;
    if let Some(expected) = expected_id
        && expected != &manifest.id
    {
        return Err(GitError::IdChanged {
            expected: expected.clone(),
            actual: manifest.id,
        });
    }
    let content_digest = content_digest(&candidate)?;
    let bundle_root = materialize_bundle(
        workspace.bundles_dir,
        &manifest.id,
        &candidate,
        &content_digest,
    )?;
    Ok(PreparedGit {
        url,
        root: bundle_root,
        rev,
        subdir,
        manifest,
        content_digest,
    })
}

pub(crate) fn read_file_at_ref(
    plugins_dir: &Path,
    url: &str,
    ref_name: &str,
    rel_path: &str,
    policy: OfflinePolicy,
) -> Result<Vec<u8>, GitError> {
    let rel_path = validate_subdir(rel_path)?;
    let url = normalize_url(url)?;
    let rev = ensure_fetched_rev(plugins_dir, &url, ref_name, policy)?;
    let cache = plugins_dir
        .join("git-cache")
        .join(format!("{:x}", Sha256::digest(url.as_bytes())));
    let spec = format!("{rev}:{rel_path}");
    let output = run(git_in(&cache).args(["cat-file", "blob", &spec]), "cat-file")?;
    Ok(output.stdout)
}

pub(crate) fn normalize_url(url: &str) -> Result<String, GitError> {
    // The protocol allowlist also covers redirects. Reject Git's explicit remote-helper
    // syntax, even when it names an otherwise allowed protocol.
    let helper = url.split_once("::").is_some_and(|(prefix, _)| {
        prefix
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'.' | b'-' | b'_'))
    });
    if url.is_empty() || url.starts_with('-') || url.chars().any(char::is_control) || helper {
        return Err(GitError::InvalidUrl);
    }
    // Git treats a colon before the first slash as an SSH shorthand. Other paths
    // must become absolute so a later sync is independent of the caller's cwd.
    if url
        .split_once(':')
        .is_some_and(|(prefix, _)| !prefix.contains('/'))
    {
        return Ok(url.to_owned());
    }
    fs::canonicalize(url)?
        .into_os_string()
        .into_string()
        .map_err(|_| GitError::InvalidUrl)
}

pub(crate) fn validate_subdir(raw: &str) -> Result<String, GitError> {
    if raw.is_empty()
        || raw.starts_with('/')
        || raw.ends_with('/')
        || raw.contains('\\')
        || raw.chars().any(char::is_control)
    {
        return Err(GitError::InvalidSubdir(raw.to_owned()));
    }
    for seg in raw.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." || seg.eq_ignore_ascii_case(".git") {
            return Err(GitError::InvalidSubdir(raw.to_owned()));
        }
    }
    Ok(raw.to_owned())
}

fn ensure_fetched_rev(
    plugins_dir: &Path,
    url: &str,
    ref_name: &str,
    policy: OfflinePolicy,
) -> Result<String, GitError> {
    if matches!(policy, OfflinePolicy::Offline) {
        return Err(GitError::Offline);
    }
    ensure_directory(plugins_dir)?;
    let cache_dir = plugins_dir.join("git-cache");
    ensure_directory(&cache_dir)?;
    let cache = cache_dir.join(format!("{:x}", Sha256::digest(url.as_bytes())));
    match fs::symlink_metadata(&cache) {
        Ok(metadata) if metadata.is_dir() => fetch(&cache, url, ref_name),
        Ok(_) => Err(GitError::InvalidDirectory(cache)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let staging = tempdir_in(&cache_dir)?;
            let repo = staging.path().join("repo");
            fs::create_dir(&repo)?;
            run(
                git().current_dir(&repo).args([
                    "init",
                    "--bare",
                    "--template=",
                    "--object-format=sha1",
                    ".",
                ]),
                "init",
            )?;
            let rev = fetch(&repo, url, ref_name)?;
            fs::rename(repo, &cache)?;
            Ok(rev)
        }
        Err(error) => Err(error.into()),
    }
}

fn git() -> Command {
    let mut command = Command::new("git");
    command.env_clear();
    for var in ["PATH", "HOME", "SSH_AUTH_SOCK"] {
        if let Some(val) = env::var_os(var) {
            command.env(var, val);
        }
    }
    command
        .env("LC_ALL", "C")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_ALLOW_PROTOCOL", "file:git:http:https:ssh")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_NO_REPLACE_OBJECTS", "1")
        .env("GIT_NO_LAZY_FETCH", "1")
        .env(
            "GIT_SSH_COMMAND",
            "ssh -oBatchMode=yes -oStrictHostKeyChecking=yes",
        )
        .args([
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "fetch.fsckObjects=true",
        ])
        .stdin(Stdio::null());
    command
}

fn git_in(repo: &Path) -> Command {
    let mut command = git();
    command.arg("--git-dir").arg(repo);
    command
}

fn run(command: &mut Command, operation: &'static str) -> Result<Output, GitError> {
    let output = command.output()?;
    if output.status.success() {
        Ok(output)
    } else {
        Err(GitError::Command {
            operation,
            message: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        })
    }
}

fn is_sha1(bytes: &[u8]) -> bool {
    bytes.len() == GIT_SHA1_HEX_LEN && bytes.iter().all(u8::is_ascii_hexdigit)
}

fn fetch(repo: &Path, url: &str, ref_name: &str) -> Result<String, GitError> {
    let source = resolve_ref(repo, url, ref_name)?;
    let spec = format!("+{source}:{FETCHED_REF}");
    run(
        git_in(repo).args([
            "fetch",
            "--atomic",
            "--no-tags",
            "--no-auto-maintenance",
            "--no-recurse-submodules",
            "--no-write-fetch-head",
            "--",
            url,
            &spec,
        ]),
        "fetch",
    )?;
    let mut rev = run(
        git_in(repo).args(["rev-parse", "--verify", "--end-of-options", FETCHED_COMMIT]),
        "rev-parse",
    )?
    .stdout;
    if rev.last() == Some(&b'\n') {
        rev.pop();
    }
    if !is_sha1(&rev) || rev.iter().any(u8::is_ascii_uppercase) {
        return Err(GitError::InvalidOutput("commit id"));
    }
    String::from_utf8(rev).map_err(|_| GitError::InvalidOutput("commit id"))
}

fn resolve_ref<'a>(repo: &Path, url: &str, name: &'a str) -> Result<Cow<'a, str>, GitError> {
    if name == "HEAD" || is_sha1(name.as_bytes()) {
        return Ok(name.into());
    }
    let full = name.starts_with("refs/");
    let branch = if full {
        Cow::Borrowed(name)
    } else {
        format!("refs/heads/{name}").into()
    };
    if !git_in(repo)
        .args(["check-ref-format", branch.as_ref()])
        .stderr(Stdio::null())
        .status()?
        .success()
    {
        return Err(GitError::InvalidRef(name.to_owned()));
    }
    if full {
        return Ok(branch);
    }
    let tag = format!("refs/tags/{name}");
    let output = run(
        git_in(repo).args(["ls-remote", "--refs", "--", url, branch.as_ref(), &tag]),
        "ls-remote",
    )?;
    let advertised = |reference: &str| {
        output.stdout.split(|&b| b == b'\n').any(|line| {
            split_at_byte(line, b'\t')
                .is_some_and(|(oid, name)| is_sha1(oid) && name == reference.as_bytes())
        })
    };
    if advertised(&branch) {
        Ok(branch)
    } else if advertised(&tag) {
        Ok(tag.into())
    } else {
        Err(GitError::MissingRef(name.to_owned()))
    }
}

fn split_at_byte(bytes: &[u8], separator: u8) -> Option<(&[u8], &[u8])> {
    let pos = bytes.iter().position(|&b| b == separator)?;
    Some((&bytes[..pos], &bytes[pos + 1..]))
}

fn ensure_directory(path: &Path) -> Result<(), GitError> {
    match fs::create_dir(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            if fs::symlink_metadata(path)?.is_dir() {
                Ok(())
            } else {
                Err(GitError::InvalidDirectory(path.to_owned()))
            }
        }
        Err(error) => Err(error.into()),
    }
}

fn create_export_dir(path: &Path) -> io::Result<()> {
    fs::create_dir(path)?;
    fs::set_permissions(path, Permissions::from_mode(0o755))
}

fn export_tree(repo: &Path, rev: &str, subdir: Option<&str>, root: &Path) -> Result<(), GitError> {
    let tree_spec = match subdir {
        Some(sub) => format!("{rev}:{sub}"),
        None => rev.to_owned(),
    };
    // Plumbing commands preserve the raw blobs, unlike checkout (filters) or archive (attributes).
    let output = run(
        git_in(repo).args(["ls-tree", "-rzt", "--full-tree", &tree_spec]),
        "ls-tree",
    )?;
    let mut child = git_in(repo)
        .args(["cat-file", "--batch"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let result = (|| {
        let request = child
            .stdin
            .take()
            .ok_or(GitError::InvalidOutput("blob pipe"))?;
        let reply = child
            .stdout
            .take()
            .ok_or(GitError::InvalidOutput("blob pipe"))?;
        let mut blobs = Blobs {
            request,
            reply: BufReader::new(reply),
            header: String::new(),
        };
        write_tree(root, &output.stdout, &mut blobs)
    })();
    if result.is_err() {
        // Close and reap the batch process even if a malformed tree aborts the export.
        let _ = child.kill();
    }
    let status = child.wait();
    result?;
    let status = status?;
    if !status.success() {
        return Err(GitError::Command {
            operation: "cat-file",
            message: status.to_string(),
        });
    }
    Ok(())
}

struct Blobs {
    request: std::process::ChildStdin,
    reply: BufReader<std::process::ChildStdout>,
    header: String,
}

impl Blobs {
    fn start(&mut self, oid: &[u8]) -> Result<u64, GitError> {
        let mut query = [b'\n'; 41];
        query[..40].copy_from_slice(oid);
        self.request.write_all(&query)?;
        self.header.clear();
        self.reply.read_line(&mut self.header)?;
        let Some((id, size)) = self.header.trim_end().split_once(" blob ") else {
            return Err(GitError::InvalidOutput("blob header"));
        };
        if id.as_bytes() != oid {
            return Err(GitError::InvalidOutput("blob id"));
        }
        size.parse()
            .map_err(|_| GitError::InvalidOutput("blob size"))
    }

    fn copy(&mut self, size: u64, output: &mut impl Write) -> Result<(), GitError> {
        if io::copy(&mut (&mut self.reply).take(size), output)? != size {
            return Err(GitError::InvalidOutput("blob body"));
        }
        let mut end = [0];
        self.reply.read_exact(&mut end)?;
        if end != *b"\n" {
            return Err(GitError::InvalidOutput("blob terminator"));
        }
        Ok(())
    }
}

fn write_tree(root: &Path, listing: &[u8], blobs: &mut Blobs) -> Result<(), GitError> {
    let mut links = Vec::new();
    let listing = if listing.is_empty() {
        listing
    } else {
        listing
            .strip_suffix(b"\0")
            .ok_or(GitError::InvalidOutput("tree terminator"))?
    };
    for record in listing.split(|&b| b == 0).filter(|part| !part.is_empty()) {
        let Some((header, name)) = split_at_byte(record, b'\t') else {
            return Err(GitError::InvalidOutput("tree entry"));
        };
        let mut fields = header.split(|&b| b == b' ');
        let (Some(mode), Some(kind), Some(oid), None) =
            (fields.next(), fields.next(), fields.next(), fields.next())
        else {
            return Err(GitError::InvalidOutput("tree entry header"));
        };
        if !is_sha1(oid)
            || name.split(|&b| b == b'/').any(|part| {
                part.is_empty()
                    || part == b"."
                    || part == b".."
                    || part.eq_ignore_ascii_case(b".git")
            })
        {
            return Err(GitError::InvalidOutput("tree path or object id"));
        }
        let relative = Path::new(OsStr::from_bytes(name));
        let path = root.join(relative);
        match (mode, kind) {
            (b"040000", b"tree") => create_export_dir(&path)?,
            (b"100644" | b"100755", b"blob") => {
                let size = blobs.start(oid)?;
                let mut file = File::create_new(&path)?;
                blobs.copy(size, &mut file)?;
                let mode = if mode == b"100755" { 0o755 } else { 0o644 };
                file.set_permissions(Permissions::from_mode(mode))?;
            }
            (b"120000", b"blob") => {
                // No link exists yet, so a malformed tree cannot create a link
                // below a parent that wasn't materialized as a real directory.
                if !path.parent().is_some_and(Path::is_dir) {
                    return Err(GitError::InvalidOutput("symlink parent directory"));
                }
                let size = blobs.start(oid)?;
                // Linux symlink targets must fit in a single path buffer, including the NUL.
                if size > MAX_SYMLINK_BYTES as u64 {
                    return Err(GitError::InvalidOutput("symlink target size"));
                }
                let mut target = Vec::new();
                blobs.copy(size, &mut target)?;
                links.push((relative, target));
            }
            _ => {
                return Err(GitError::UnsupportedMode(
                    String::from_utf8_lossy(mode).into_owned(),
                ));
            }
        }
    }

    // Populate links last so Git tree entries cannot write through them. Verify every
    // resolution stays beneath the root even across chained links or `..` components.
    if !links.is_empty() {
        let dir = File::open(root)?;
        for (relative, target) in &links {
            // Every ancestor was created as a real directory while materializing the tree.
            symlink(OsStr::from_bytes(target), root.join(relative))?;
        }
        for (relative, _) in links {
            openat2(
                &dir,
                relative,
                OFlags::PATH | OFlags::CLOEXEC,
                Mode::empty(),
                ResolveFlags::BENEATH | ResolveFlags::NO_MAGICLINKS,
            )
            .map_err(|source| GitError::UnsafeSymlink {
                path: relative.to_owned(),
                source,
            })?;
        }
    }
    Ok(())
}
