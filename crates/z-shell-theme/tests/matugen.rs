#![cfg(unix)]

use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs;
use std::os::unix::fs::PermissionsExt as _;
use tempfile::TempDir;
use z_shell_config::{ThemeBackend, ThemeMode, ThemeVariant};
use z_shell_theme::{
    ColorScheme, GenerationOutcome, GenerationRequest, GtkLinker, ThemeEngine, ThemeSource,
    parse_seed,
};

#[tokio::test]
async fn matugen_backend_uses_strict_argv_and_validates_json_roles() {
    let temp = TempDir::new().unwrap();
    let expected =
        ColorScheme::generate(parse_seed("#006e1c").unwrap(), ThemeVariant::Vibrant, false);
    let colors: BTreeMap<String, Value> = expected
        .to_map()
        .into_iter()
        .map(|(role, color)| {
            (
                role.to_owned(),
                json!({
                    "default": { "color": color },
                    "dark": { "color": color },
                    "light": { "color": color }
                }),
            )
        })
        .collect();
    let output = json!({ "mode": "light", "is_dark_mode": false, "colors": colors });
    let arguments = temp.path().join("arguments");
    let program = temp.path().join("matugen-test");
    fs::write(
        &program,
        format!(
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\ncat <<'JSON'\n{}\nJSON\n",
            arguments.display(),
            serde_json::to_string(&output).unwrap()
        ),
    )
    .unwrap();
    let mut permissions = fs::metadata(&program).unwrap().permissions();
    permissions.set_mode(0o700);
    fs::set_permissions(&program, permissions).unwrap();

    let engine = ThemeEngine::with_gtk(GtkLinker::new(
        temp.path().join("config"),
        temp.path().join("state"),
    ))
    .with_matugen_program(program);
    let snapshot = match engine
        .generate(GenerationRequest {
            request_seq: 1,
            source: ThemeSource::Seed("#006e1c".to_owned()),
            mode: ThemeMode::Light,
            variant: ThemeVariant::Vibrant,
            backend: ThemeBackend::Matugen,
            gtk_linking: false,
            local_hour: 12,
        })
        .await
        .unwrap()
    {
        GenerationOutcome::Committed(snapshot) => snapshot,
        GenerationOutcome::Superseded => unreachable!(),
    };
    assert_eq!(snapshot.scheme, expected);
    let argv = fs::read_to_string(arguments).unwrap();
    let argv: Vec<&str> = argv.lines().collect();
    assert_eq!(
        argv,
        [
            "--mode",
            "light",
            "--type",
            "scheme-vibrant",
            "--source-color-index",
            "0",
            "--json",
            "hex",
            "--quiet",
            "--include-image-in-json",
            "false",
            "color",
            "hex",
            "#006e1c",
        ]
    );
}
