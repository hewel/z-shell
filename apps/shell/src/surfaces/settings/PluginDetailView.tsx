import { Button, For, Image, Show, createEffect, createMemo, createSignal, type Accessor, type NativeChild } from "@hewel/zgui";
import { M3Button, M3SegmentedControl } from "@z-shell/sdk/primitives";
import { useDaemonMedia } from "@z-shell/sdk/zgui";
import { ShellIcon } from "../../icons.tsx";
import { useShellStore } from "../../store.ts";
import type { MediaRef } from "@z-shell/sdk";
import type {
  CatalogDetailResponse,
  PluginAuditResponse,
  PublicPluginEntry,
  StagedInstallResponse,
  StagedUpgradeResponse,
} from "../../topics.ts";
import type { ApprovalReviewRequest } from "./PluginDialogs.tsx";
import {
  clipped,
  containerHigh,
  containerHighest,
  grow,
  muted,
  onPrimary,
  onPrimaryContainer,
  onSurface,
  primary,
} from "./shared.tsx";

function PreviewBlobImage(props: {
  readonly media: Accessor<MediaRef | null | undefined>;
  readonly alt: string;
  readonly width: string;
  readonly height: string;
  readonly radius: string;
  readonly testId?: string;
}): NativeChild {
  const { hostClient } = useShellStore();
  const { src } = useDaemonMedia(hostClient, props.media, { fetchCommand: "plugins.catalog.fetch-blob" });
  return (
    <box testId={props.testId ?? null} style={{
      width: props.width, height: props.height, borderRadius: props.radius, overflow: "hidden",
      display: "flex", alignItems: "center", justifyContent: "center",
      backgroundColor: containerHighest, flexShrink: 0,
    }}>
      <Show when={src()} fallback={<ShellIcon name="extension" size={20} color={muted} />}>
        {url => <Image ariaLabel={props.alt} src={url()} style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
      </Show>
    </box>
  );
}

export function PluginDetailView(props: {
  readonly pluginId: string;
  readonly topicEntry: PublicPluginEntry | null;
  readonly runtimeOverlaySupported: boolean;
  readonly appliedDesiredRevision: number | null;
  readonly desiredRevision: number;
  readonly onBack: () => void;
  readonly onRequestApproval: (req: ApprovalReviewRequest) => void;
  readonly onRefreshList: () => void;
}): NativeChild {
  const { publicClient, invokePublic, invokeHostResult } = useShellStore();
  const [detail, setDetail] = createSignal<CatalogDetailResponse | null>(null);
  const [audit, setAudit] = createSignal<PluginAuditResponse | null>(null);
  const [selectedSourceId, setSelectedSourceId] = createSignal<string>("");
  const [busyAction, setBusyAction] = createSignal<string | null>(null);
  const [errorMsg, setErrorMsg] = createSignal<string | null>(null);

  const reload = async () => {
    setErrorMsg(null);
    const id = props.pluginId;
    const catRes = await invokePublic("plugins.catalog.detail", { id });
    if (catRes?.data) {
      const parsed = catRes.data as CatalogDetailResponse;
      setDetail(parsed);
      if (!selectedSourceId() || !parsed.offerings.some(o => o.source_id === selectedSourceId())) {
        setSelectedSourceId(parsed.preferred_source_id || parsed.offerings[0]?.source_id || "");
      }
    } else {
      setDetail(null);
    }
    if (props.topicEntry) {
      const auditRes = await invokePublic("plugins.audit", { id });
      setAudit((auditRes?.data as PluginAuditResponse | undefined) ?? null);
    } else {
      setAudit(null);
    }
  };

  createEffect(() => [publicClient(), props.pluginId, props.desiredRevision] as const, ([client]) => {
    if (client) void reload();
  });

  const activeOffering = createMemo(() => {
    const d = detail();
    if (!d) return null;
    return d.offerings.find(o => o.source_id === selectedSourceId()) ?? d.offerings[0] ?? null;
  });

  const title = () => detail()?.name ?? audit()?.plugin.name ?? props.topicEntry?.name ?? props.pluginId;
  const installed = () => audit()?.plugin ?? detail()?.installed ?? props.topicEntry ?? null;
  const hasMultipleOfferings = () => (detail()?.offerings.length ?? 0) > 1;
  const offeringOptions = createMemo(() =>
    (detail()?.offerings ?? []).map(o => ({
      id: o.source_id,
      label: `${o.source_name} (${o.latest_version})`,
    })),
  );
  const updateAvailable = createMemo(() => {
    const inst = installed();
    const off = activeOffering();
    return Boolean(inst && off && inst.version !== off.latest_version);
  });

  const runHost = async (action: string, cmd: string, payload: unknown, after?: () => void) => {
    setBusyAction(action);
    setErrorMsg(null);
    const res = await invokeHostResult(cmd, payload);
    setBusyAction(null);
    if (!res.ok) {
      setErrorMsg(res.error);
      return;
    }
    after?.();
    await reload();
    props.onRefreshList();
  };

  const stageInstall = async () => {
    const off = activeOffering();
    if (!off) return;
    setBusyAction("install");
    setErrorMsg(null);
    const res = await invokeHostResult("plugins.stage-install", {
      kind: "catalog",
      id: props.pluginId,
      ...(hasMultipleOfferings() ? { source_id: off.source_id } : {}),
    });
    setBusyAction(null);
    if (!res.ok) {
      setErrorMsg(res.error);
      return;
    }
    if (res.result.data) {
      props.onRequestApproval({ kind: "staged-install", response: res.result.data as StagedInstallResponse });
    }
  };

  const stageUpgrade = async () => {
    const off = activeOffering();
    setBusyAction("upgrade");
    setErrorMsg(null);
    const res = await invokeHostResult("plugins.stage-upgrade", {
      id: props.pluginId,
      ...(off && hasMultipleOfferings() ? { source_id: off.source_id } : {}),
    });
    setBusyAction(null);
    if (!res.ok) {
      setErrorMsg(res.error);
      return;
    }
    if (res.result.data) {
      props.onRequestApproval({ kind: "staged-upgrade", response: res.result.data as StagedUpgradeResponse });
    }
  };

  return (
    <column testId="plugin-detail-view" style={{ gap: "12px", width: "100%" }}>
      <row style={{ alignItems: "center", justifyContent: "space-between", gap: "10px", flexShrink: 0 }}>
        <row style={{ alignItems: "center", gap: "10px", minWidth: "0px", flexGrow: 1 }}>
          <Button
            testId="plugin-detail-back"
            ariaLabel="Back to Plugins"
            onClick={props.onBack}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: "32px", height: "32px", borderRadius: "10px", flexShrink: 0,
              backgroundColor: containerHigh,
            }}
          >
            <ShellIcon name="arrowLeft" size={16} color={onSurface} />
          </Button>
          <PreviewBlobImage
            testId="plugin-detail-icon"
            media={() => activeOffering()?.icon ?? null}
            alt={title()}
            width="36px"
            height="36px"
            radius="10px"
          />
          <column style={{ ...grow, gap: "2px" }}>
            <text role="heading" style={{ fontSize: "18px", fontWeight: 600, lineHeight: "24px" }}>{title()}</text>
            <text style={{ ...clipped, fontFamily: "var(--font-mono)", fontSize: "11px", color: muted }}>
              {`${props.pluginId}${installed() ? ` · installed v${installed()!.version}` : ""}${activeOffering() ? ` · catalog v${activeOffering()!.latest_version}` : ""}`}
            </text>
          </column>
        </row>
      </row>

      <column style={{ gap: "12px", width: "100%" }}>
        <row style={{
          alignItems: "center", gap: "8px", padding: "10px 12px", borderRadius: "12px",
          backgroundColor: "var(--color-primary-container)",
        }}>
          <ShellIcon name="shield" size={16} color={onPrimaryContainer} />
          <text style={{ ...grow, fontSize: "11px", lineHeight: "15px", color: onPrimaryContainer }}>
            Enabled plugins compile directly into the host shell bundle (`bun run build:shell`). Review capabilities before approving.
          </text>
        </row>

          <row style={{ flexWrap: "wrap", gap: "8px", paddingTop: "2px" }}>
            <Show when={!installed() && activeOffering()}>
              <M3Button testId="plugin-detail-install" variant="filled" size="sm" disabled={busyAction() !== null} onClick={() => void stageInstall()}>
                <text style={{ color: onPrimary }}>{busyAction() === "install" ? "Staging…" : "Install…"}</text>
              </M3Button>
            </Show>
            <Show when={installed() && audit() && (!installed()!.approved || installed()!.revoked || installed()!.migration_reapproval_required)}>
              <M3Button
                testId="plugin-detail-approve"
                variant="filled"
                size="sm"
                disabled={busyAction() !== null}
                onClick={() => props.onRequestApproval({ kind: "audit-approve", audit: audit()! })}
              >
                <text style={{ color: onPrimary }}>Review & approve…</text>
              </M3Button>
            </Show>
            <Show when={installed() && installed()!.approved && !installed()!.revoked}>
              <M3Button
                testId="plugin-detail-toggle-enable"
                variant="accent-tonal"
                size="sm"
                disabled={busyAction() !== null}
                onClick={() => void runHost(
                  "toggle",
                  installed()!.enabled ? "plugins.disable" : "plugins.enable",
                  { id: props.pluginId },
                )}
              >
                <text>{installed()!.enabled ? "Disable" : "Enable"}</text>
              </M3Button>
            </Show>
            <Show when={updateAvailable()}>
              <M3Button testId="plugin-detail-upgrade" variant="accent-tonal" size="sm" disabled={busyAction() !== null} onClick={() => void stageUpgrade()}>
                <text>{busyAction() === "upgrade" ? "Staging upgrade…" : `Upgrade to v${activeOffering()!.latest_version}`}</text>
              </M3Button>
            </Show>
            <Show when={installed() && !installed()!.revoked}>
              <M3Button
                testId="plugin-detail-revoke"
                variant="text"
                danger
                size="sm"
                disabled={busyAction() !== null}
                onClick={() => void runHost("revoke", "plugins.revoke", { id: props.pluginId })}
              >
                <text>Revoke</text>
              </M3Button>
            </Show>
            <Show when={installed()}>
              <M3Button
                testId="plugin-detail-sync"
                variant="text"
                size="sm"
                disabled={busyAction() !== null}
                onClick={() => void runHost("sync", "plugins.sync", { id: props.pluginId })}
              >
                <text>Sync</text>
              </M3Button>
              <M3Button
                testId="plugin-detail-remove"
                variant="text"
                danger
                size="sm"
                disabled={busyAction() !== null}
                onClick={() => void runHost("remove", "plugins.remove", { id: props.pluginId }, props.onBack)}
              >
                <text>Remove</text>
              </M3Button>
            </Show>
          </row>

          <Show when={errorMsg()}>
            {err => (
              <row style={{
                alignItems: "center", gap: "8px", padding: "10px 12px", borderRadius: "12px",
                backgroundColor: "var(--color-error-container)", color: "var(--color-on-error-container)",
              }}>
                <ShellIcon name="warning" size={16} color="var(--color-on-error-container)" />
                <text style={{ ...grow, fontSize: "12px", lineHeight: "16px" }}>{err()}</text>
              </row>
            )}
          </Show>

          <Show when={hasMultipleOfferings()}>
            <column style={{ borderRadius: "16px", backgroundColor: containerHigh, padding: "12px 14px", gap: "6px" }}>
              <text style={{ fontSize: "12px", fontWeight: 600 }}>Select catalog source</text>
              <M3SegmentedControl
                ariaLabel="Catalog source offering"
                compact
                options={offeringOptions()}
                value={selectedSourceId()}
                onChange={setSelectedSourceId}
              />
            </column>
          </Show>

          <Show when={activeOffering()?.screenshots.length}>
            <row testId="plugin-detail-screenshots" style={{ gap: "10px", flexWrap: "wrap" }}>
              <For each={activeOffering()?.screenshots ?? []} keyed={s => s.media.kind === "blob_handle" ? s.media.token : s.media.path}>
                {shot => (
                  <column style={{ gap: "4px", width: "268px" }}>
                    <PreviewBlobImage
                      testId="plugin-detail-screenshot-img"
                      media={() => shot().media}
                      alt={shot().caption ?? "Plugin screenshot"}
                      width="268px"
                      height="150px"
                      radius="12px"
                    />
                    <Show when={shot().caption}>
                      {cap => <text style={{ ...clipped, fontSize: "11px", color: muted }}>{cap()}</text>}
                    </Show>
                  </column>
                )}
              </For>
            </row>
          </Show>

          <column style={{ borderRadius: "16px", backgroundColor: containerHigh, padding: "14px", gap: "8px" }}>
            <text style={{ fontSize: "13px", fontWeight: 600 }}>Details & provenance</text>
            <Show when={activeOffering()?.summary}>
              {sum => <text style={{ fontSize: "12px", color: onSurface }}>{sum()}</text>}
            </Show>
            <Show when={installed()}>
              {inst => (
                <>
                  <text style={{ ...clipped, fontFamily: "var(--font-mono)", fontSize: "11px", color: muted }}>
                    {`Source: ${inst().source_identity}`}
                  </text>
                  <text style={{ ...clipped, fontFamily: "var(--font-mono)", fontSize: "11px", color: muted }}>
                    {`Digest: ${inst().content_digest}`}
                  </text>
                  <text style={{ fontSize: "11px", color: !props.runtimeOverlaySupported ? primary : muted }}>
                    {!props.runtimeOverlaySupported
                      ? `Desired: ${inst().enabled ? "enabled" : "disabled"} (rev ${props.desiredRevision}) · Runtime: unknown (${props.appliedDesiredRevision == null ? "static build — run bun run build:shell" : `applied rev ${props.appliedDesiredRevision}`})`
                      : `Runtime: ${props.topicEntry?.runtime_state ?? "unknown"}`}
                  </text>
                </>
              )}
            </Show>
          </column>

          <Show when={audit()}>
            {a => (
              <column style={{ borderRadius: "16px", backgroundColor: containerHigh, padding: "14px", gap: "6px" }}>
                <text style={{ fontSize: "13px", fontWeight: 600 }}>Capabilities & audit</text>
                <text style={{ fontFamily: "var(--font-mono)", fontSize: "11px", color: a().digest_matches ? muted : "var(--color-error)" }}>
                  {a().digest_matches ? "Bundle digest verified" : "WARNING: Bundle digest drift detected"}
                </text>
                <Show when={a().net_added_host_capabilities.length > 0}>
                  <text style={{ fontFamily: "var(--font-mono)", fontSize: "11px", color: "var(--color-error)" }}>
                    {`Net added host permissions: ${a().net_added_host_capabilities.join(", ")}`}
                  </text>
                </Show>
                <text style={{ fontFamily: "var(--font-mono)", fontSize: "11px", color: muted }}>
                  {`Host commands: ${a().requested_capabilities.host.commands.join(", ") || "none"} · Bus commands: ${a().requested_capabilities.bus.commands_register.join(", ") || "none"}`}
                </text>
              </column>
            )}
          </Show>
      </column>
    </column>
  );
}
