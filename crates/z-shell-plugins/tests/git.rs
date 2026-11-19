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

    fn assert_source(&self, ref_name: &str, rev: &str) -> PathBuf {
        let root = self
            .plugins_dir()
            .join("exports/example__git-plugin")
            .join(rev);
        assert_eq!(
            self.source(),
            serde_json::json!({
                "kind": "git",
                "url": self.url,
                "ref_name": ref_name,
                "rev": rev,
                "root": root,
            })
        );
        assert!(!root.join(".git").exists(), "export must not be a checkout");
        root
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
    let first_root = fixture.assert_source("HEAD", &first);
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

    fs::write(first_root.join("untracked"), "tampered").expect("tamper with export");
    fs::set_permissions(
        first_root.join("src/worker.ts"),
        fs::Permissions::from_mode(0o755),
    )
    .expect("tamper with tracked mode");
    let repaired = fixture
        .manager
        .sync(&installed.id, OfflinePolicy::Online)
        .expect("re-export the same commit rather than reuse a mutated export");
    assert_eq!(repaired.content_digest, installed.content_digest);
    assert!(!first_root.join("untracked").exists());
    assert_eq!(
        fs::metadata(first_root.join("src/worker.ts"))
            .expect("stat repaired worker")
            .permissions()
            .mode()
            & 0o111,
        0
    );

    fs::write(fixture.work.join("src/worker.ts"), SECOND_WORKER).expect("update worker");
    let second = fixture.commit();
    assert!(
        fixture
            .manager
            .sync(&installed.id, OfflinePolicy::Offline)
            .is_err(),
        "offline sync must not fetch a reachable remote"
    );
    assert_eq!(fixture.assert_source("HEAD", &first), first_root);
    let synced = fixture
        .manager
        .sync(&installed.id, OfflinePolicy::Online)
        .expect("sync changed remote HEAD");
    assert_ne!(synced.content_digest, installed.content_digest);
    let second_root = fixture.assert_source("HEAD", &second);
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
    let unsafe_rev = fixture.commit();
    assert!(
        fixture
            .manager
            .sync(&installed.id, OfflinePolicy::Online)
            .is_err()
    );
    assert_eq!(fixture.assert_source("HEAD", &second), second_root);
    assert!(!second_root.with_file_name(unsafe_rev).exists());

    fs::remove_file(fixture.work.join("src/unsafe-link")).expect("remove escaping link");
    fs::write(
        fixture.work.join("plugin.toml"),
        MANIFEST.replace(PLUGIN_ID, "example/renamed"),
    )
    .expect("change plugin identity");
    let renamed_rev = fixture.commit();
    assert!(
        fixture
            .manager
            .sync(&installed.id, OfflinePolicy::Online)
            .is_err()
    );
    assert_eq!(fixture.assert_source("HEAD", &second), second_root);
    assert!(
        !fixture
            .plugins_dir()
            .join("exports/example__renamed")
            .join(renamed_rev)
            .exists()
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
