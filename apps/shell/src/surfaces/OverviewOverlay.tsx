import { Button, For, Image, LayerSurface, Show, createMemo, focus, type Accessor, type Monitor, type NativeChild, type NativeKeyEvent } from "@hewel/zgui";
import { useDaemonMedia } from "@z-shell/sdk/zgui";
import { ShellIcon } from "../icons.tsx";
import { createRetainedPresence, dialogMotionStyle, scrimBackdrop, useMotionScheme, type M3Spring } from "../motion.ts";
import { useShellStore } from "../store.ts";
import {
  filterWorkspacesForMonitor,
  resolveActiveMonitor,
  resolveDesktopApp,
  resolveMonitorLogicalSize,
  type DesktopAppSummary,
  type WaylandWindow,
  type WaylandWorkspace,
} from "../topics.ts";

const primary = "var(--color-primary)";
const primaryContainer = "var(--color-primary-container)";
const onPrimaryContainer = "var(--color-on-primary-container)";
const secondaryContainer = "var(--color-secondary-container)";
const onSecondaryContainer = "var(--color-on-secondary-container)";
const errorContainer = "var(--color-error-container)";
const onErrorContainer = "var(--color-on-error-container)";
const onSurface = "var(--color-on-surface)";
const muted = "var(--color-on-surface-variant)";
const container = "var(--color-surface-container)";
const containerHigh = "var(--color-surface-container-high)";
const containerHighest = "var(--color-surface-container-highest)";
const clipped = { minWidth: "0px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } as const;
const iconTints = ["primary", "secondary", "tertiary"] as const;

function workspaceDisplayName(workspace: WaylandWorkspace, index: number): string {
  const raw = workspace.name?.trim();
  if (raw && raw.length > 0) return raw;
  const coord = workspace.coordinates[0];
  return coord !== undefined ? String(coord) : String(index + 1);
}

function OverviewWindowRow(props: {
  readonly window: Accessor<WaylandWindow>;
  readonly app: DesktopAppSummary | undefined;
  readonly onActivate: () => void;
  readonly onClose: () => void;
}): NativeChild {
  const { hostClient } = useShellStore();
  const { src } = useDaemonMedia(hostClient, () => props.app?.icon, { fetchCommand: "launcher.fetch-blob" });
  const title = () => props.window().title?.trim() || props.app?.title || props.window().app_id || "Untitled window";
  const subtitle = () => props.app?.title ?? props.window().app_id ?? "";
  const letter = () => subtitle().trim().codePointAt(0) ?? title().trim().codePointAt(0);
  const initial = () => {
    const code = letter();
    return code === undefined ? "?" : String.fromCodePoint(code).toUpperCase();
  };
  const tint = () => iconTints[(letter() ?? 0) % iconTints.length];
  const active = () => props.window().activated;
  const statusLabel = () => {
    const win = props.window();
    if (win.fullscreen) return "Fullscreen";
    if (win.minimized) return "Minimized";
    if (win.activated) return "Active";
    return null;
  };

  return (
    <row testId={`overview-window-${props.window().window_id}`} style={{
      alignItems: "center", gap: "8px", width: "100%", borderRadius: "14px", padding: "6px 8px",
      backgroundColor: active() ? primaryContainer : containerHigh,
      border: active()
        ? "1px solid color-mix(in srgb, var(--color-primary) 35%, transparent)"
        : "1px solid color-mix(in srgb, var(--color-outline-variant) 45%, transparent)",
      color: active() ? onPrimaryContainer : onSurface,
    }}>
      <Button testId={`overview-window-focus-${props.window().window_id}`}
        ariaLabel={`Focus ${title()}`}
        onClick={props.onActivate}
        style={{
          display: "flex", alignItems: "center", gap: "10px", flexGrow: 1, flexBasis: "0px", minWidth: "0px",
          minHeight: "34px", padding: "2px 4px", borderRadius: "10px",
          backgroundColor: "transparent", color: active() ? onPrimaryContainer : onSurface,
        }}>
        <Show when={src()} fallback={
          <box ariaHidden style={{
            width: "28px", height: "28px", borderRadius: "8px", flexShrink: 0,
            display: "flex", alignItems: "center", justifyContent: "center",
            backgroundColor: `var(--color-${tint()}-container)`, color: `var(--color-on-${tint()}-container)`,
          }}>
            <text style={{ fontSize: "13px", fontWeight: 600 }}>{initial()}</text>
          </box>
        }>
          {image => <Image ariaHidden src={image()} style={{ width: "28px", height: "28px", borderRadius: "8px", flexShrink: 0, objectFit: "contain" }} />}
        </Show>
        <column style={{ flexGrow: 1, flexBasis: "0px", minWidth: "0px", gap: "1px" }}>
          <text style={{ ...clipped, fontSize: "13px", fontWeight: active() ? 600 : 500, lineHeight: "18px" }}>
            {title()}
          </text>
          <Show when={subtitle().length > 0 && subtitle() !== title()}>
            <text style={{
              ...clipped, fontFamily: "var(--font-mono)", fontSize: "11px", lineHeight: "14px",
              color: active() ? onPrimaryContainer : muted,
            }}>
              {subtitle()}
            </text>
          </Show>
        </column>
        <Show when={statusLabel()}>
          {label => (
            <box style={{
              padding: "2px 8px", borderRadius: "999px", flexShrink: 0,
              backgroundColor: active() ? container : containerHighest,
              color: active() ? onSurface : muted,
              fontSize: "11px", fontWeight: 500,
            }}>
              <text>{label()}</text>
            </box>
          )}
        </Show>
      </Button>
      <Button testId={`overview-window-close-${props.window().window_id}`}
        ariaLabel={`Close ${title()}`}
        onClick={event => {
          event.stopPropagation();
          props.onClose();
        }}
        style={{
          display: "flex", width: "28px", height: "28px", borderRadius: "8px", flexShrink: 0,
          alignItems: "center", justifyContent: "center",
          backgroundColor: active() ? "color-mix(in srgb, var(--color-on-primary-container) 12%, transparent)" : containerHighest,
          color: active() ? onPrimaryContainer : muted,
        }}>
        <ShellIcon name="close" size={14} color={active() ? onPrimaryContainer : muted} />
      </Button>
    </row>
  );
}

function OverviewContent(props: {
  readonly monitor: Accessor<Monitor | undefined>;
  readonly spatial: M3Spring;
  readonly opacity: M3Spring;
}): NativeChild {
  const { workspaces, windows, outputs, apps, invokePublic, closePanels } = useShellStore();
  const scheme = useMotionScheme();
  const monitorName = () => props.monitor()?.name ?? props.monitor()?.id ?? "Display";
  const monitorWorkspaces = createMemo(() => filterWorkspacesForMonitor(workspaces.data(), outputs.data(), monitorName()));
  const monitorWindows = createMemo(() => {
    const all = windows.data()?.windows ?? [];
    const output = outputs.data()?.outputs.find(candidate => candidate.name === monitorName());
    if (!output) return all;
    const local = all.filter(win =>
      win.output_instance_ids.length === 0 || win.output_instance_ids.includes(output.output_instance_id),
    );
    return local.length > 0 ? local : all;
  });

  function activateWorkspace(workspaceId: number): void {
    void invokePublic("wayland.workspace.activate", { workspace_id: workspaceId });
    closePanels();
  }

  function activateWindow(windowId: number): void {
    void invokePublic("wayland.window.activate", { window_id: windowId });
    closePanels();
  }

  function closeWindow(windowId: number): void {
    void invokePublic("wayland.window.close", { window_id: windowId });
  }

  function handleKeyDown(event: NativeKeyEvent): void {
    const key = event.key;
    if (!key) return;
    if (key === "Escape" && !event.repeat) {
      event.preventDefault();
      closePanels();
      return;
    }
    if (!event.repeat && key.length === 1 && key >= "1" && key <= "9") {
      const target = monitorWorkspaces()[Number(key) - 1];
      if (target) {
        event.preventDefault();
        activateWorkspace(target.workspace_id);
      }
    }
  }

  return (
    <box testId="overview-backdrop" onClick={closePanels} style={{
      position: "fixed", left: "0px", top: "0px", width: "100%", height: "100%",
      display: "flex", alignItems: "center", justifyContent: "center", padding: "14px",
      backgroundColor: scrimBackdrop(50, props.opacity()),
    }}>
      <column testId="overview-card" role="dialog" ariaLabel="Workspace Overview" ariaModal
        onClick={event => event.stopPropagation()} onKeyDown={handleKeyDown}
        style={{
          width: "684px", maxWidth: "100%", maxHeight: "760px", padding: "18px", gap: "14px", borderRadius: "22px",
          backgroundColor: container, color: onSurface, fontFamily: "var(--font-sans)",
          border: "1px solid color-mix(in srgb, var(--color-outline-variant) 55%, transparent)",
          boxShadow: "0 20px 56px rgba(0, 0, 0, 0.60)",
          ...dialogMotionStyle(props.spatial(), { opacity: props.opacity(), reduced: scheme() === "reduced", fromScale: 0.96, fromY: 8 }),
        }}>
        <row style={{ alignItems: "center", justifyContent: "space-between", gap: "10px", flexShrink: 0 }}>
          <row style={{ alignItems: "center", gap: "8px", minWidth: "0px" }}>
            <ShellIcon name="overview" size={20} color={primary} />
            <text role="heading" style={{ fontSize: "20px", fontWeight: 600, lineHeight: "26px" }}>Workspace Overview</text>
            <box style={{
              padding: "3px 8px", borderRadius: "999px", backgroundColor: containerHighest,
              color: muted, fontFamily: "var(--font-mono)", fontSize: "11px",
            }}>
              <text>{monitorName()}</text>
            </box>
          </row>
          <Button testId="overview-close" ariaLabel="Close overview" ref={node => focus(node)} onClick={closePanels} style={{
            display: "flex", alignItems: "center", justifyContent: "center", minHeight: "32px",
            padding: "6px 12px", borderRadius: "10px", backgroundColor: secondaryContainer,
            color: onSecondaryContainer, fontSize: "12px", fontWeight: 500, flexShrink: 0,
          }}>
            <text>Close</text>
          </Button>
        </row>

        <column style={{ gap: "8px", flexShrink: 0 }}>
          <row style={{ alignItems: "center", justifyContent: "space-between" }}>
            <text style={{ fontSize: "12px", fontWeight: 600, color: muted }}>Workspaces</text>
            <text data-tabular="true" style={{ fontFamily: "var(--font-mono)", fontSize: "11px", color: muted, fontVariantNumeric: "tabular-nums" }}>
              {`${monitorWorkspaces().length} total · 1–9 switch`}
            </text>
          </row>
          <Show when={monitorWorkspaces().length > 0} fallback={
            <box style={{ borderRadius: "14px", backgroundColor: containerHigh, padding: "14px", color: muted, fontSize: "12px" }}>
              <text>No workspaces reported by compositor</text>
            </box>
          }>
            <row style={{ flexWrap: "wrap", gap: "8px", width: "100%" }}>
              <For each={monitorWorkspaces()} keyed={ws => ws.workspace_id}>
                {(ws, index) => {
                  const active = () => ws().active;
                  const urgent = () => ws().urgent;
                  const label = () => workspaceDisplayName(ws(), index());
                  return (
                    <Button testId={`overview-ws-${ws().workspace_id}`} selected={active()}
                      onClick={() => activateWorkspace(ws().workspace_id)}
                      style={{
                        display: "flex", flexDirection: "column", alignItems: "flex-start", justifyContent: "space-between",
                        width: "122px", minHeight: "64px", padding: "10px 12px", gap: "6px", borderRadius: "14px",
                        backgroundColor: urgent() ? errorContainer : active() ? primaryContainer : containerHigh,
                        border: active()
                          ? "1px solid color-mix(in srgb, var(--color-primary) 40%, transparent)"
                          : "1px solid color-mix(in srgb, var(--color-outline-variant) 45%, transparent)",
                        color: urgent() ? onErrorContainer : active() ? onPrimaryContainer : onSurface,
                      }}>
                      <row style={{ alignItems: "center", justifyContent: "space-between", width: "100%", gap: "6px" }}>
                        <text data-tabular="true" style={{
                          fontFamily: "var(--font-mono)", fontSize: "15px", fontWeight: 600, fontVariantNumeric: "tabular-nums",
                        }}>
                          {label()}
                        </text>
                        <Show when={active() || urgent()}>
                          <box style={{
                            width: "8px", height: "8px", borderRadius: "999px",
                            backgroundColor: urgent() ? "var(--color-error)" : primary,
                          }} />
                        </Show>
                      </row>
                      <text style={{
                        fontSize: "11px", fontWeight: 500,
                        color: urgent() ? onErrorContainer : active() ? onPrimaryContainer : muted,
                      }}>
                        {urgent() ? "Urgent" : active() ? "Active" : "Switch"}
                      </text>
                    </Button>
                  );
                }}
              </For>
            </row>
          </Show>
        </column>

        <column style={{ gap: "8px", minHeight: "0px", flexGrow: 1, flexShrink: 1 }}>
          <row style={{ alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
            <text style={{ fontSize: "12px", fontWeight: 600, color: muted }}>Open Windows</text>
            <text data-tabular="true" style={{ fontFamily: "var(--font-mono)", fontSize: "11px", color: muted, fontVariantNumeric: "tabular-nums" }}>
              {`${monitorWindows().length} ${monitorWindows().length === 1 ? "window" : "windows"}`}
            </text>
          </row>
          <Show when={monitorWindows().length > 0} fallback={
            <box style={{ borderRadius: "14px", backgroundColor: containerHigh, padding: "18px 14px", color: muted, fontSize: "12px" }}>
              <text>No open windows on this display</text>
            </box>
          }>
            <scroll style={{ minHeight: "0px", maxHeight: "340px", width: "100%", overflow: "hidden auto" }}>
              <column style={{ gap: "6px", width: "100%" }}>
                <For each={monitorWindows()} keyed={win => win.window_id}>
                  {win => (
                    <OverviewWindowRow
                      window={win}
                      app={resolveDesktopApp(apps.data()?.apps, win().app_id)}
                      onActivate={() => activateWindow(win().window_id)}
                      onClose={() => closeWindow(win().window_id)}
                    />
                  )}
                </For>
              </column>
            </scroll>
          </Show>
        </column>
      </column>
    </box>
  );
}

export function OverviewOverlay(): NativeChild {
  const { activePanel, activePanelTarget, activeMonitor, monitors, outputs, windows } = useShellStore();
  const scheme = useMotionScheme();
  const targetOutputId = () => {
    if (activePanel() !== "overview") return null;
    return resolveActiveMonitor(monitors(), {
      preferredMonitorId: activePanelTarget()?.monitorId,
      windows: windows.data(),
      outputs: outputs.data(),
      lastMonitorId: activeMonitor()?.id,
    })?.id ?? null;
  };
  const presence = createRetainedPresence(targetOutputId, {
    scheme,
    enterRole: "slowSpatial",
    enterOpacityRole: "slowEffects",
    exitRole: "slowEffects",
  });

  return (
    <Show when={presence.value()} keyed>
      {output => {
        const monitor = () => monitors().find(candidate => candidate.id === output);
        const size = () => {
          const current = monitor();
          return current ? resolveMonitorLogicalSize(current, outputs.data()) : { width: 1280, height: 720 };
        };
        return (
          <LayerSurface name="overview-overlay" output={output} layer="overlay"
            anchor={["top", "bottom", "left", "right"]} width={size().width} height={size().height}
            exclusiveZone={-1} keyboard="exclusive">
            <OverviewContent monitor={monitor} spatial={presence.progress} opacity={presence.opacity} />
          </LayerSurface>
        );
      }}
    </Show>
  );
}
