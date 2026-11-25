use std::ffi::OsStr;
use std::fs;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::Value;
use tempfile::{TempDir, tempdir};
use z_shell_config::ShellPaths;
use z_shell_plugins::registry::{OfflinePolicy, PluginManager};

const PLUGIN_ID: &str = "example/git-plugin";
const MANIFEST: &str = r#"
id = "example/git-plugin"
name = "Git Plugin"
version = "1.0.0"
plugin_api = 1

[[service]]
id = "worker"
entry = "src/worker.ts"
"#;
const FIRST_WORKER: &str = "// $Format:%H$\n";
const SECOND_WORKER: &str = "export const worker = 2;\n";

fn git<I, S>(cwd: &Path, args: I) -> String
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let output = Command::new("git")
        .current_dir(cwd)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .args([
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "commit.gpgSign=false",
        ])
        .args(args)
        .output()
        .expect("run git against test fixture");
    assert!(
        output.status.success(),
        "git failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout)
        .expect("UTF-8 git output")
        .trim()
        .to_owned()
}

struct Fixture {
    temp: TempDir,
    work: PathBuf,
    url: String,
    manager: PluginManager,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempdir().expect("create test directory");
        let canonical_root = fs::canonicalize(temp.path()).expect("resolve test directory");
        let root = canonical_root.as_path();
        let url = root
            .join("remote.git")
            .into_os_string()
            .into_string()
            .expect("UTF-8 remote path");
        git(
            root,
            [
                "init",
                "--bare",
                "--template=",
                "--initial-branch=main",
                &url,
            ],
        );
        let work = root.join("work");
        git(
            root,
            ["init", "--template=", "--initial-branch=main", "work"],
        );
        git(&work, ["config", "user.name", "Plugin Test"]);
        git(&work, ["config", "user.email", "plugin@example.invalid"]);
        git(&work, ["remote", "add", "origin", &url]);
        fs::create_dir(work.join("src")).expect("create source directory");
        fs::write(work.join("plugin.toml"), MANIFEST).expect("write manifest");
        fs::write(work.join("src/worker.ts"), FIRST_WORKER).expect("write worker");
        symlink("src/worker.ts", work.join("alias.ts")).expect("add internal link");
        fs::write(
            work.join(".gitattributes"),
            "plugin.toml export-ignore\nsrc/worker.ts export-subst\n",
        )
        .expect("write attributes");
        let paths = ShellPaths::from_roots(
            root.join("config"),
            root.join("state"),
            root.join("runtime"),
            root.join("runtime/bus.sock"),
        );
        let manager = PluginManager::new(paths);
        Self {
            temp,
            work,
            url,
            manager,
        }
    }

    fn commit(&self) -> String {
        git(&self.work, ["add", "--all"]);
        git(&self.work, ["commit", "-m", "plugin revision"]);
        git(&self.work, ["push", "origin", "main"]);
        git(&self.work, ["rev-parse", "HEAD"])
    }

    fn plugins_dir(&self) -> PathBuf {
        self.work
            .parent()
            .expect("fixture root")
            .join("state/plugins")
    }

    fn source(&self) -> Value {
        let file = fs::read(self.plugins_dir().join("registry.json")).expect("read registry");
        let registry: Value = serde_json::from_slice(&file).expect("parse registry");
        registry["plugins"][PLUGIN_ID]["source"].clone()
    }

    fn assert_source(
        &self,
        ref_name: &str,
        rev: &str,
        subdir: Option<&str>,
        digest: &str,
    ) -> PathBuf {
        let bundle_path = self
            .plugins_dir()
            .join("bundles/example__git-plugin")
            .join(digest.replace(':', "_"));
        let mut expected = serde_json::json!({
            "kind": "git",
            "url": self.url,
            "ref_name": ref_name,
            "rev": rev,
            "bundle_path": bundle_path,
        });
        if let Some(sub) = subdir {
            expected["subdir"] = serde_json::json!(sub);
        }
        assert_eq!(self.source(), expected);
        assert!(
            !bundle_path.join(".git").exists(),
            "bundle must not be a checkout"
        );
        assert_eq!(
            fs::metadata(&bundle_path).unwrap().permissions().mode() & 0o777,
            0o500
        );
        bundle_path
    }
}

#[test]
fn git_source_pins_raw_tree_and_only_advances_on_online_sync() {
    let fixture = Fixture::new();
    let first = fixture.commit();
    assert!(
        fixture
            .manager
            .add_git(&fixture.url, "HEAD", OfflinePolicy::Offline)
            .is_err(),
        "offline add must reject even a reachable local remote"
    );
    assert!(!fixture.plugins_dir().join("git-cache").exists());

    let cwd = std::env::current_dir().expect("resolve test working directory");
    let relative = std::iter::repeat_n("..", cwd.components().count() - 1)
        .collect::<PathBuf>()
        .join(
            Path::new(&fixture.url)
                .strip_prefix("/")
                .expect("absolute remote"),
        );
    let installed = fixture
        .manager
        .add_git(
            relative.to_str().expect("UTF-8 relative remote"),
            "HEAD",
            OfflinePolicy::Online,
        )
        .expect("install default HEAD from bare remote");
    assert_eq!(installed.id.as_str(), PLUGIN_ID);
    let first_root = fixture.assert_source("HEAD", &first, None, &installed.content_digest);
    assert_eq!(
        fs::read_to_string(first_root.join("src/worker.ts")).expect("read tracked source"),
        FIRST_WORKER,
        "export must not apply export-subst"
    );
    assert_eq!(
        fs::read_to_string(first_root.join("plugin.toml")).expect("read tracked manifest"),
        MANIFEST,
        "export must not apply export-ignore"
    );
    assert_eq!(
        fs::read_link(first_root.join("alias.ts")).expect("read tracked symlink"),
        Path::new("src/worker.ts")
    );

    // Syncing same commit repairs a corrupted bundle without fetching? No, bundle is immutable 0o500/0o400
    // and re-syncing re-verifies or recreates the bundle cleanly.
    fs::write(fixture.work.join("src/worker.ts"), SECOND_WORKER).expect("update worker");
    let second = fixture.commit();
    assert!(
        fixture
            .manager
            .sync(&installed.id, OfflinePolicy::Offline)
            .is_err(),
        "offline sync must not fetch a reachable remote"
    );
    assert_eq!(
        fixture.assert_source("HEAD", &first, None, &installed.content_digest),
        first_root
    );
    let synced = fixture
        .manager
        .sync(&installed.id, OfflinePolicy::Online)
        .expect("sync changed remote HEAD");
    assert_ne!(synced.content_digest, installed.content_digest);
    let second_root = fixture.assert_source("HEAD", &second, None, &synced.content_digest);
    assert_eq!(
        fs::read_to_string(second_root.join("src/worker.ts")).expect("read updated source"),
        SECOND_WORKER
    );
    assert_eq!(
        fs::read_to_string(first_root.join("src/worker.ts")).expect("read original pinned source"),
        FIRST_WORKER
    );

    let outside = fixture.temp.path().join("outside.ts");
    fs::write(&outside, "outside plugin").expect("create external file");
    symlink(outside, fixture.work.join("src/unsafe-link")).expect("add escaping link");
    let _unsafe_rev = fixture.commit();
    assert!(
        fixture
            .manager
            .sync(&installed.id, OfflinePolicy::Online)
            .is_err()
    );
    assert_eq!(
        fixture.assert_source("HEAD", &second, None, &synced.content_digest),
        second_root
    );

    fs::remove_file(fixture.work.join("src/unsafe-link")).expect("remove escaping link");
    fs::write(
        fixture.work.join("plugin.toml"),
        MANIFEST.replace(PLUGIN_ID, "example/renamed"),
    )
    .expect("change plugin identity");
    let _renamed_rev = fixture.commit();
    assert!(
        fixture
            .manager
            .sync(&installed.id, OfflinePolicy::Online)
            .is_err()
    );
    assert_eq!(
        fixture.assert_source("HEAD", &second, None, &synced.content_digest),
        second_root
    );
    assert!(
        !fixture
            .plugins_dir()
            .join("bundles/example__renamed")
            .exists()
    );
}

#[test]
fn git_monorepo_subdir_exports_only_subtree_and_blocks_escape_symlinks() {
    let fixture = Fixture::new();
    let mono_work = fixture.temp.path().join("mono");
    let mono_url = fixture
        .temp
        .path()
        .join("mono-remote.git")
        .into_os_string()
        .into_string()
        .unwrap();
    git(
        fixture.temp.path(),
        [
            "init",
            "--bare",
            "--template=",
            "--initial-branch=main",
            &mono_url,
        ],
    );
    git(
        fixture.temp.path(),
        ["init", "--template=", "--initial-branch=main", "mono"],
    );
    git(&mono_work, ["config", "user.name", "Plugin Test"]);
    git(
        &mono_work,
        ["config", "user.email", "plugin@example.invalid"],
    );
    git(&mono_work, ["remote", "add", "origin", &mono_url]);
    fs::create_dir_all(mono_work.join("plugins/demo/src")).unwrap();
    fs::write(mono_work.join("README.md"), "repo root secret").unwrap();
    fs::write(
        mono_work.join("plugins/demo/plugin.toml"),
        MANIFEST.replace("example/git-plugin", "example/mono-demo"),
    )
    .unwrap();
    fs::write(mono_work.join("plugins/demo/src/worker.ts"), FIRST_WORKER).unwrap();
    git(&mono_work, ["add", "--all"]);
    git(&mono_work, ["commit", "-m", "mono init"]);
    git(&mono_work, ["push", "origin", "main"]);
    let rev = git(&mono_work, ["rev-parse", "HEAD"]);

    // Reject invalid subdirs.
    for bad in ["../escape", "/abs", ".git", "plugins//demo"] {
        assert!(
            fixture
                .manager
                .add_git_subdir(&mono_url, "main", bad, OfflinePolicy::Online)
                .is_err(),
            "expected invalid subdir error for {bad:?}"
        );
    }

    let summary = fixture
        .manager
        .add_git_subdir(&mono_url, "main", "plugins/demo", OfflinePolicy::Online)
        .unwrap();
    assert_eq!(summary.id.as_str(), "example/mono-demo");
    let bundle = fixture
        .plugins_dir()
        .join("bundles/example__mono-demo")
        .join(summary.content_digest.replace(':', "_"));
    assert!(bundle.join("plugin.toml").is_file());
    assert!(!bundle.join("README.md").exists());

    // Symlink inside subdir escaping to repo-level sibling must be rejected.
    fs::write(mono_work.join("sibling.ts"), "outside subtree").unwrap();
    symlink("../../sibling.ts", mono_work.join("plugins/demo/escape.ts")).unwrap();
    git(&mono_work, ["add", "--all"]);
    git(&mono_work, ["commit", "-m", "escape symlink"]);
    git(&mono_work, ["push", "origin", "main"]);
    assert!(
        fixture
            .manager
            .sync(&summary.id, OfflinePolicy::Online)
            .is_err()
    );

    let registry: Value = serde_json::from_reader(
        fs::File::open(fixture.plugins_dir().join("registry.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        registry["plugins"]["example/mono-demo"]["source"]["rev"],
        rev
    );
    assert_eq!(
        registry["plugins"]["example/mono-demo"]["source"]["subdir"],
        "plugins/demo"
    );
}

#[test]
fn git_source_resolves_branches_annotated_tags_full_refs_and_commit_ids() {
    let fixture = Fixture::new();
    let first = fixture.commit();
    git(
        &fixture.work,
        ["tag", "-a", "fixture", "-m", "annotated tag"],
    );
    git(&fixture.work, ["push", "origin", "refs/tags/fixture"]);
    fs::write(fixture.work.join("src/worker.ts"), SECOND_WORKER).expect("update worker");
    let second = fixture.commit();

    for (i, (ref_name, rev)) in [
        ("main", second.as_str()),
        ("refs/heads/main", second.as_str()),
        ("fixture", first.as_str()),
        ("refs/tags/fixture", first.as_str()),
        (first.as_str(), first.as_str()),
    ]
    .into_iter()
    .enumerate()
    {
        let state = fixture.temp.path().join(format!("ref-{i}"));
        let paths = ShellPaths::from_roots(
            state.join("config"),
            state.clone(),
            state.join("runtime"),
            state.join("runtime/bus.sock"),
        );
        let manager = PluginManager::new(paths);
        let summary = manager
            .add_git(&fixture.url, ref_name, OfflinePolicy::Online)
            .unwrap_or_else(|error| panic!("install {ref_name}: {error}"));
        assert_eq!(summary.id.as_str(), PLUGIN_ID);
        let registry: Value = serde_json::from_reader(
            fs::File::open(state.join("plugins/registry.json")).expect("open registry"),
        )
        .expect("parse registry");
        assert_eq!(registry["plugins"][PLUGIN_ID]["source"]["rev"], rev);
    }
}
