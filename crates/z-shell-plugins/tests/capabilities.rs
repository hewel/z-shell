use std::collections::BTreeSet;
use z_shell_plugins::capabilities::{
    BusPermissions, CapabilityBundle, CapabilityMergeError, ClipboardCapabilities,
    FilesCapabilities, HostCapabilities, NetworkOriginRule, SqliteCapabilities,
    merge_host_capabilities, net_added_host_capabilities,
};

#[test]
fn empty_extended_capabilities_preserve_legacy_six_field_json_shape() {
    let caps = HostCapabilities {
        commands: BTreeSet::from(["ai-usagebar".to_owned()]),
        control_channel: true,
        ..HostCapabilities::default()
    };
    let json = serde_json::to_value(&caps).unwrap();
    let obj = json.as_object().unwrap();
    assert_eq!(obj.len(), 6);
    assert!(obj.contains_key("commands"));
    assert!(obj.contains_key("imagePrefixes"));
    assert!(obj.contains_key("unixSockets"));
    assert!(obj.contains_key("namedSockets"));
    assert!(obj.contains_key("shellSurfaces"));
    assert!(obj.contains_key("controlChannel"));
    assert!(!obj.contains_key("clipboard"));
    assert!(!obj.contains_key("sqlite"));
    assert!(!obj.contains_key("files"));
    assert!(!obj.contains_key("networkOrigins"));
}

#[test]
fn coverage_diff_and_net_added_track_extended_capabilities() {
    let baseline = HostCapabilities {
        commands: BTreeSet::from(["existing-cmd".to_owned()]),
        files: FilesCapabilities {
            directories: BTreeSet::from(["$HOME/.config/zen".to_owned()]),
        },
        network_origins: BTreeSet::from([NetworkOriginRule {
            origin: "https://api.open-meteo.com".to_owned(),
            allow_insecure_http: false,
            allow_private_networks: false,
        }]),
        ..HostCapabilities::default()
    };
    let requested = HostCapabilities {
        commands: BTreeSet::from(["existing-cmd".to_owned(), "new-cmd".to_owned()]),
        clipboard: ClipboardCapabilities {
            read_outside_gesture: true,
        },
        sqlite: SqliteCapabilities {
            databases: BTreeSet::from(["weather-cache".to_owned()]),
        },
        files: FilesCapabilities {
            directories: BTreeSet::from(["$HOME/.config/zen".to_owned()]),
        },
        network_origins: BTreeSet::from([
            NetworkOriginRule {
                origin: "https://api.open-meteo.com".to_owned(),
                allow_insecure_http: false,
                allow_private_networks: false,
            },
            NetworkOriginRule {
                origin: "https://api.github.com".to_owned(),
                allow_insecure_http: false,
                allow_private_networks: false,
            },
        ]),
        ..HostCapabilities::default()
    };

    let net = net_added_host_capabilities(&baseline, &requested);
    assert_eq!(net.commands, BTreeSet::from(["new-cmd".to_owned()]));
    assert!(net.clipboard.read_outside_gesture);
    assert_eq!(
        net.sqlite.databases,
        BTreeSet::from(["weather-cache".to_owned()])
    );
    assert!(net.files.directories.is_empty());
    assert_eq!(net.network_origins.len(), 1);
    assert!(
        net.network_origins
            .iter()
            .any(|r| r.origin == "https://api.github.com")
    );

    let base_bundle = CapabilityBundle {
        host: baseline,
        bus: BusPermissions::default(),
    };
    let req_bundle = CapabilityBundle {
        host: requested,
        bus: BusPermissions::default(),
    };
    assert!(!req_bundle.is_covered_by(&base_bundle));
    assert!(req_bundle.diff(Some(&base_bundle)).requires_approval());
}

#[test]
fn per_origin_merge_is_lossless_and_rejects_conflicting_same_origin_policies() {
    let public_plugin = HostCapabilities {
        network_origins: BTreeSet::from([NetworkOriginRule {
            origin: "https://public.example".to_owned(),
            allow_insecure_http: false,
            allow_private_networks: false,
        }]),
        ..HostCapabilities::default()
    };
    let local_plugin = HostCapabilities {
        network_origins: BTreeSet::from([NetworkOriginRule {
            origin: "http://127.0.0.1:8080".to_owned(),
            allow_insecure_http: true,
            allow_private_networks: true,
        }]),
        ..HostCapabilities::default()
    };

    let merged = merge_host_capabilities(&[public_plugin.clone(), local_plugin]).unwrap();
    assert_eq!(merged.network_origins.len(), 2);
    let public_rule = merged
        .network_origins
        .iter()
        .find(|r| r.origin == "https://public.example")
        .unwrap();
    assert!(!public_rule.allow_insecure_http);
    assert!(!public_rule.allow_private_networks);

    let conflicting_public = HostCapabilities {
        network_origins: BTreeSet::from([NetworkOriginRule {
            origin: "https://public.example".to_owned(),
            allow_insecure_http: false,
            allow_private_networks: true,
        }]),
        ..HostCapabilities::default()
    };
    let err = merge_host_capabilities(&[public_plugin, conflicting_public]).unwrap_err();
    assert!(matches!(
        err,
        CapabilityMergeError::ConflictingOriginPolicy { ref origin } if origin == "https://public.example"
    ));
}
