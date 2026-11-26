import { Button, For, Show, TextField, createEffect, createSignal, type NativeChild } from "@hewel/zgui";
import { M3Button, M3DialogShell, M3SegmentedControl, M3Switch } from "@z-shell/sdk/primitives";
import { ShellIcon } from "../../icons.tsx";
import { useShellStore } from "../../store.ts";
import type {
  CapabilityBundle,
  CatalogSourceListItem,
  CatalogSourceSettingsEntry,
  PluginAuditResponse,
  PluginSourceKind,
  StagedInstallResponse,
  StagedUpgradeResponse,
} from "../../topics.ts";
import {
  clipped,
  container,
  containerHigh,
  containerHighest,
  grow,
  muted,
  onPrimary,
  onPrimaryContainer,
  onSurface,
  primary,
} from "./shared.tsx";

const inputStyle = {
  height: "34px",
  borderRadius: "10px",
  padding: "6px 10px",
  backgroundColor: container,
  border: "1px solid color-mix(in srgb, var(--color-outline-variant) 65%, transparent)",
  color: onSurface,
  fontFamily: "var(--font-mono)",
  fontSize: "12px",
} as const;

const backdropStyle = {
  position: "absolute",
  inset: "0px",
  zIndex: 30,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "24px",
  backgroundColor: "color-mix(in srgb, var(--color-scrim) 52%, transparent)",
} as const;

export type ApprovalReviewRequest =
  | { readonly kind: "staged-install"; readonly response: StagedInstallResponse }
  | { readonly kind: "staged-upgrade"; readonly response: StagedUpgradeResponse }
  | { readonly kind: "audit-approve"; readonly audit: PluginAuditResponse };

function CapabilitySummaryBox(props: {
  readonly capabilities: CapabilityBundle;
  readonly netAddedHost?: readonly string[];
}): NativeChild {
  const hostItems = (): readonly string[] => {
    const h = props.capabilities.host;
    const list: string[] = [];
    for (const cmd of h.commands) list.push(`exec:${cmd}`);
    for (const pfx of h.image_prefixes) list.push(`images:${pfx}`);
    for (const sock of h.unix_sockets) list.push(`unix:${sock}`);
    for (const named of h.named_sockets) list.push(`named-socket:${named}`);
    if (h.shell_surfaces) list.push("shell-surfaces");
    if (h.control_channel) list.push("control-channel");
    return list;
  };
  const busItems = (): readonly string[] => {
    const b = props.capabilities.bus;
    const list: string[] = [];
    for (const t of b.topics_read) list.push(`read:${t}`);
    for (const t of b.topics_publish) list.push(`publish:${t}`);
    for (const c of b.commands_register) list.push(`cmd:${c}`);
    if (b.inhibitors) list.push("inhibitors");
    return list;
  };
  return (
    <column style={{ gap: "8px", borderRadius: "12px", backgroundColor: containerHigh, padding: "10px 12px" }}>
      <text style={{ fontSize: "12px", fontWeight: 600 }}>Requested capabilities</text>
      <text style={{ fontFamily: "var(--font-mono)", fontSize: "11px", color: muted }}>
        {`Host (${hostItems().length}): ${hostItems().join(", ") || "none"}`}
      </text>
      <text style={{ fontFamily: "var(--font-mono)", fontSize: "11px", color: muted }}>
        {`Bus (${busItems().length}): ${busItems().join(", ") || "none"}`}
      </text>
      <Show when={(props.netAddedHost?.length ?? 0) > 0}>
        <text style={{ fontFamily: "var(--font-mono)", fontSize: "11px", color: "var(--color-error)" }}>
          {`Net new host permissions: ${props.netAddedHost!.join(", ")}`}
        </text>
      </Show>
    </column>
  );
}

export function ApprovalReviewDialog(props: {
  readonly request: ApprovalReviewRequest;
  readonly onClose: () => void;
  readonly onCompleted: () => void;
}): NativeChild {
  const { invokeHostResult } = useShellStore();
  const [busy, setBusy] = createSignal(false);
  const [errorMsg, setErrorMsg] = createSignal<string | null>(null);
  const [allowUnrevoke, setAllowUnrevoke] = createSignal(false);
  const [approveOnCommit, setApproveOnCommit] = createSignal(true);

  const meta = () => {
    switch (props.request.kind) {
      case "staged-install": {
        const s = props.request.response.staged;
        return {
          title: `Review install · ${s.name}`,
          subtitle: `${s.id} v${s.version}`,
          sourceIdentity: s.source_identity,
          digest: s.content_digest,
          capabilities: s.requested_capabilities,
          netAddedHost: s.net_added_host_capabilities,
          revoked: false,
          confirmLabel: approveOnCommit() ? "Approve & install" : "Install disabled",
        };
      }
      case "staged-upgrade": {
        const s = props.request.response.staged;
        return {
          title: `Review upgrade · ${s.name}`,
          subtitle: `${s.id} ${s.from_version} → ${s.to_version}`,
          sourceIdentity: s.source_identity,
          digest: s.to_digest,
          capabilities: props.request.response.requested_capabilities,
          netAddedHost: s.net_added_host_capabilities,
          revoked: s.was_revoked,
          confirmLabel: "Approve & upgrade",
        };
      }
      case "audit-approve": {
        const a = props.request.audit;
        return {
          title: `Approve permissions · ${a.plugin.name}`,
          subtitle: `${a.plugin.id} v${a.plugin.version}`,
          sourceIdentity: a.plugin.source_identity,
          digest: a.current_content_digest,
          capabilities: a.requested_capabilities,
          netAddedHost: a.net_added_host_capabilities,
          revoked: a.plugin.revoked,
          confirmLabel: "Approve",
        };
      }
    }
  };

  const submit = async () => {
    setBusy(true);
    setErrorMsg(null);
    let res: { readonly ok: boolean; readonly error?: string };
    if (props.request.kind === "staged-install") {
      const r = props.request.response;
      res = await invokeHostResult("plugins.commit-install", {
        stage_token: r.stage_token,
        expected_source_identity: r.staged.source_identity,
        expected_content_digest: r.staged.content_digest,
        expected_capabilities: r.staged.requested_capabilities,
        approve_on_commit: approveOnCommit(),
      });
    } else if (props.request.kind === "staged-upgrade") {
      const r = props.request.response;
      res = await invokeHostResult("plugins.commit-upgrade", {
        stage_token: r.stage_token,
        expected_from_digest: r.staged.from_digest,
        expected_to_digest: r.staged.to_digest,
        expected_capabilities: r.requested_capabilities,
        approval_mode: "approve_expanded",
        allow_unrevoke: allowUnrevoke(),
      });
    } else {
      const a = props.request.audit;
      res = await invokeHostResult("plugins.approve", {
        id: a.plugin.id,
        expected_source_identity: a.plugin.source_identity,
        expected_content_digest: a.current_content_digest,
        expected_capabilities: a.requested_capabilities,
        allow_unrevoke: allowUnrevoke(),
      });
    }
    setBusy(false);
    if (!res.ok) {
      setErrorMsg(res.error ?? "Plugin approval failed");
      return;
    }
    props.onCompleted();
    props.onClose();
  };

  return (
    <box style={backdropStyle} onClick={props.onClose}>
      <M3DialogShell
        testId="plugin-approval-dialog"
        ariaLabel={meta().title}
        error={Boolean(errorMsg())}
        style={{ width: "492px" }}
      >
        <column style={{ gap: "4px" }}>
          <text role="heading" style={{ fontSize: "16px", fontWeight: 600 }}>{meta().title}</text>
          <text style={{ fontFamily: "var(--font-mono)", fontSize: "11px", color: muted }}>{meta().subtitle}</text>
        </column>

        <row style={{
          alignItems: "center", gap: "8px", padding: "8px 10px", borderRadius: "10px",
          backgroundColor: "var(--color-primary-container)",
        }}>
          <ShellIcon name="shield" size={16} color={onPrimaryContainer} />
          <text style={{ ...grow, fontSize: "11px", lineHeight: "15px", color: onPrimaryContainer }}>
            Plugins compose directly into the shared shell bundle and share host trust once enabled and built.
          </text>
        </row>

        <column style={{ gap: "4px", borderRadius: "10px", backgroundColor: containerHigh, padding: "8px 10px" }}>
          <text style={{ ...clipped, fontFamily: "var(--font-mono)", fontSize: "11px", color: muted }}>
            {`Source: ${meta().sourceIdentity}`}
          </text>
          <text style={{ ...clipped, fontFamily: "var(--font-mono)", fontSize: "11px", color: muted }}>
            {`Digest: ${meta().digest}`}
          </text>
        </column>

        <CapabilitySummaryBox capabilities={meta().capabilities} netAddedHost={meta().netAddedHost} />

        <Show when={props.request.kind === "staged-install"}>
          <row style={{ alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
            <text style={{ fontSize: "12px", color: onSurface }}>Approve capabilities immediately</text>
            <M3Switch
              testId="plugin-approve-on-commit-switch"
              ariaLabel="Approve capabilities on commit"
              checked={approveOnCommit()}
              onToggle={() => setApproveOnCommit(v => !v)}
            />
          </row>
        </Show>

        <Show when={meta().revoked}>
          <row style={{ alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
            <text style={{ fontSize: "12px", color: "var(--color-error)" }}>
              Plugin is currently revoked · Explicitly allow un-revoke
            </text>
            <M3Switch
              testId="plugin-allow-unrevoke-switch"
              ariaLabel="Allow unrevoke"
              checked={allowUnrevoke()}
              onToggle={() => setAllowUnrevoke(v => !v)}
            />
          </row>
        </Show>

        <Show when={errorMsg()}>
          {err => <text testId="plugin-approval-error" style={{ fontSize: "12px", color: "var(--color-error)" }}>{err()}</text>}
        </Show>

        <row style={{ justifyContent: "flex-end", gap: "8px" }}>
          <M3Button testId="plugin-approval-cancel" variant="text" size="sm" onClick={props.onClose}>
            <text>Cancel</text>
          </M3Button>
          <M3Button
            testId="plugin-approval-confirm"
            variant="filled"
            size="sm"
            disabled={busy() || (meta().revoked && !allowUnrevoke())}
            onClick={() => void submit()}
          >
            <text style={{ color: onPrimary }}>{busy() ? "Working…" : meta().confirmLabel}</text>
          </M3Button>
        </row>
      </M3DialogShell>
    </box>
  );
}

const CUSTOM_KINDS = [
  { id: "path", label: "Local path", testId: "plugin-install-kind-path" },
  { id: "git", label: "Git URL", testId: "plugin-install-kind-git" },
  { id: "archive", label: "Archive", testId: "plugin-install-kind-archive" },
] as const;

export function InstallCustomDialog(props: {
  readonly onClose: () => void;
  readonly onStaged: (req: ApprovalReviewRequest) => void;
}): NativeChild {
  const { invokeHostResult } = useShellStore();
  const [kind, setKind] = createSignal<"path" | "git" | "archive">("path");
  const [location, setLocation] = createSignal("");
  const [refName, setRefName] = createSignal("");
  const [subdir, setSubdir] = createSignal("");
  const [sha256, setSha256] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [errorMsg, setErrorMsg] = createSignal<string | null>(null);

  const stage = async () => {
    const loc = location().trim();
    if (!loc) {
      setErrorMsg("Enter a path or URL");
      return;
    }
    setBusy(true);
    setErrorMsg(null);
    const payload =
      kind() === "path"
        ? { kind: "path", path: loc }
        : kind() === "git"
          ? {
              kind: "git",
              url: loc,
              ...(refName().trim() ? { ref_name: refName().trim() } : {}),
              ...(subdir().trim() ? { subdir: subdir().trim() } : {}),
            }
          : { kind: "archive", url: loc, sha256: sha256().trim() };
    const res = await invokeHostResult("plugins.stage-install", payload);
    setBusy(false);
    if (!res.ok) {
      setErrorMsg(res.error);
      return;
    }
    const staged = res.result.data as StagedInstallResponse | undefined;
    if (!staged) {
      setErrorMsg("Unexpected empty staging response");
      return;
    }
    props.onStaged({ kind: "staged-install", response: staged });
  };

  return (
    <box style={backdropStyle} onClick={props.onClose}>
      <M3DialogShell testId="plugin-install-custom-dialog" ariaLabel="Install custom plugin" style={{ width: "460px" }}>
        <text role="heading" style={{ fontSize: "16px", fontWeight: 600 }}>Install local or custom plugin</text>
        <M3SegmentedControl ariaLabel="Install source kind" options={CUSTOM_KINDS} value={kind()} onChange={setKind} />

        <column style={{ gap: "4px" }}>
          <text style={{ fontSize: "11px", color: muted }}>
            {kind() === "path" ? "Absolute directory containing plugin.toml" : kind() === "git" ? "Repository URL" : "Archive URL or path (.tar.gz / .tar.zst)"}
          </text>
          <TextField
            testId="plugin-install-location-input"
            ariaLabel="Plugin location"
            placeholder={kind() === "path" ? "/home/user/my-plugin" : "https://example.com/plugin.git"}
            value={location()}
            onInput={ev => setLocation(ev.value)}
            style={inputStyle}
          />
        </column>

        <Show when={kind() === "git"}>
          <row style={{ gap: "8px" }}>
            <column style={{ ...grow, gap: "4px" }}>
              <text style={{ fontSize: "11px", color: muted }}>Ref / Tag (optional)</text>
              <TextField ariaLabel="Git ref" placeholder="main" value={refName()} onInput={ev => setRefName(ev.value)} style={inputStyle} />
            </column>
            <column style={{ ...grow, gap: "4px" }}>
              <text style={{ fontSize: "11px", color: muted }}>Subdir (optional)</text>
              <TextField ariaLabel="Git subdir" placeholder="plugins/demo" value={subdir()} onInput={ev => setSubdir(ev.value)} style={inputStyle} />
            </column>
          </row>
        </Show>

        <Show when={kind() === "archive"}>
          <column style={{ gap: "4px" }}>
            <text style={{ fontSize: "11px", color: muted }}>Expected SHA-256</text>
            <TextField ariaLabel="Archive sha256" placeholder="sha256:..." value={sha256()} onInput={ev => setSha256(ev.value)} style={inputStyle} />
          </column>
        </Show>

        <Show when={errorMsg()}>
          {err => <text style={{ fontSize: "12px", color: "var(--color-error)" }}>{err()}</text>}
        </Show>

        <row style={{ justifyContent: "flex-end", gap: "8px" }}>
          <M3Button testId="plugin-install-custom-cancel" variant="text" size="sm" onClick={props.onClose}>
            <text>Cancel</text>
          </M3Button>
          <M3Button testId="plugin-install-custom-stage" variant="filled" size="sm" disabled={busy()} onClick={() => void stage()}>
            <text style={{ color: onPrimary }}>{busy() ? "Staging…" : "Stage & review"}</text>
          </M3Button>
        </row>
      </M3DialogShell>
    </box>
  );
}

const SOURCE_KINDS: readonly { readonly id: PluginSourceKind; readonly label: string }[] = [
  { id: "https_json", label: "HTTPS JSON" },
  { id: "git_json", label: "Git JSON" },
  { id: "local_file", label: "Local file" },
];

export function SourcesDialog(props: {
  readonly onClose: () => void;
  readonly onUpdated: () => void;
}): NativeChild {
  const { hostClient, invokeHostResult } = useShellStore();
  const [items, setItems] = createSignal<readonly CatalogSourceListItem[]>([]);
  const [errorMsg, setErrorMsg] = createSignal<string | null>(null);
  const [adding, setAdding] = createSignal(false);
  const [newId, setNewId] = createSignal("");
  const [newName, setNewName] = createSignal("");
  const [newKind, setNewKind] = createSignal<PluginSourceKind>("https_json");
  const [newUrl, setNewUrl] = createSignal("");

  const loadSources = async () => {
    const res = await invokeHostResult("plugins.sources.list", {});
    if (!res.ok) {
      setErrorMsg(res.error);
      return;
    }
    const payload = res.result.data as { readonly sources?: readonly CatalogSourceListItem[] } | undefined;
    setItems(payload?.sources ?? []);
  };

  createEffect(() => hostClient(), client => {
    if (client) void loadSources();
  });

  const saveSources = async (sources: readonly CatalogSourceSettingsEntry[]) => {
    setErrorMsg(null);
    const res = await invokeHostResult("settings.patch", { plugins: { sources } });
    if (!res.ok) {
      setErrorMsg(res.error);
      return;
    }
    await loadSources();
    props.onUpdated();
  };

  const toggleSource = (id: string) => {
    const next = items().map(entry => entry.source.id === id ? { ...entry.source, enabled: !entry.source.enabled } : entry.source);
    void saveSources(next);
  };

  const removeSource = (id: string) => {
    const next = items().filter(entry => entry.source.id !== id).map(entry => entry.source);
    void saveSources(next);
  };

  const addSource = () => {
    const id = newId().trim();
    const name = newName().trim() || id;
    const url = newUrl().trim();
    if (!id || !url) {
      setErrorMsg("Source ID and URL/path are required");
      return;
    }
    const entry: CatalogSourceSettingsEntry = {
      id,
      name,
      kind: newKind(),
      url,
      enabled: true,
      priority: 100,
    };
    const next = [...items().map(i => i.source), entry];
    setAdding(false);
    setNewId("");
    setNewName("");
    setNewUrl("");
    void saveSources(next);
  };

  return (
    <box style={backdropStyle} onClick={props.onClose}>
      <M3DialogShell testId="plugin-sources-dialog" ariaLabel="Catalog sources" style={{ width: "520px" }}>
        <row style={{ alignItems: "center", justifyContent: "space-between" }}>
          <text role="heading" style={{ fontSize: "16px", fontWeight: 600 }}>Catalog sources</text>
          <Button
            testId="plugin-sources-add-toggle"
            ariaLabel="Add catalog source"
            onClick={() => setAdding(v => !v)}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center", gap: "4px",
              height: "28px", padding: "0 10px", borderRadius: "8px",
              backgroundColor: containerHighest, color: onSurface, fontSize: "11px", fontWeight: 600,
            }}
          >
            <ShellIcon name="add" size={14} color={primary} />
            <text>Add source</text>
          </Button>
        </row>

        <Show when={adding()}>
          <column style={{ gap: "8px", padding: "10px", borderRadius: "12px", backgroundColor: containerHigh }}>
            <M3SegmentedControl ariaLabel="Source kind" compact options={SOURCE_KINDS} value={newKind()} onChange={setNewKind} />
            <row style={{ gap: "8px" }}>
              <box style={grow}>
                <TextField ariaLabel="Source ID" placeholder="slug-id" value={newId()} onInput={ev => setNewId(ev.value)} style={inputStyle} />
              </box>
              <box style={grow}>
                <TextField ariaLabel="Source Name" placeholder="Display name" value={newName()} onInput={ev => setNewName(ev.value)} style={inputStyle} />
              </box>
            </row>
            <TextField ariaLabel="Source URL" placeholder="https://... or /path/to/catalog-v1.json" value={newUrl()} onInput={ev => setNewUrl(ev.value)} style={inputStyle} />
            <row style={{ justifyContent: "flex-end", gap: "8px" }}>
              <M3Button variant="text" size="sm" onClick={() => setAdding(false)}><text>Cancel</text></M3Button>
              <M3Button variant="filled" size="sm" onClick={addSource}><text style={{ color: onPrimary }}>Save</text></M3Button>
            </row>
          </column>
        </Show>

        <scroll style={{ maxHeight: "260px", width: "100%", overflow: "hidden auto" }}>
          <column style={{ gap: "6px", width: "100%" }}>
            <For
              each={items()}
              keyed={item => item.source.id}
              fallback={<text style={{ fontSize: "12px", color: muted }}>No catalog sources configured in settings.toml</text>}
            >
              {entry => (
                <row testId={`plugin-source-row-${entry().source.id}`} style={{
                  alignItems: "center", justifyContent: "space-between", gap: "8px",
                  padding: "8px 10px", borderRadius: "10px", backgroundColor: containerHigh,
                }}>
                  <column style={{ ...grow, gap: "2px" }}>
                    <row style={{ alignItems: "center", gap: "6px" }}>
                      <text style={{ ...clipped, fontSize: "12px", fontWeight: 600 }}>{entry().source.name}</text>
                      <text style={{ fontFamily: "var(--font-mono)", fontSize: "10px", color: muted }}>
                        {entry().cached ? "Cached" : "Uncached"}
                      </text>
                    </row>
                    <text style={{ ...clipped, fontFamily: "var(--font-mono)", fontSize: "11px", color: muted }}>
                      {entry().source.url}
                    </text>
                  </column>
                  <M3Switch
                    ariaLabel={`Enable source ${entry().source.id}`}
                    checked={entry().source.enabled}
                    onToggle={() => toggleSource(entry().source.id)}
                  />
                  <M3Button variant="text" danger size="sm" onClick={() => removeSource(entry().source.id)}>
                    <text>Remove</text>
                  </M3Button>
                </row>
              )}
            </For>
          </column>
        </scroll>

        <Show when={errorMsg()}>
          {err => <text style={{ fontSize: "12px", color: "var(--color-error)" }}>{err()}</text>}
        </Show>

        <row style={{ justifyContent: "flex-end" }}>
          <M3Button testId="plugin-sources-close" variant="accent-tonal" size="sm" onClick={props.onClose}>
            <text>Done</text>
          </M3Button>
        </row>
      </M3DialogShell>
    </box>
  );
}
