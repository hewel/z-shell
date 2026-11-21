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
  resolveMonitorWallpaper,
  type DesktopAppSummary,
  type WaylandWindow,
  type WaylandWorkspace,
} from "../topics.ts";

const primary = "var(--color-primary)";
const onPrimary = "var(--color-on-primary)";
const primaryContainer = "var(--color-primary-container)";
const onPrimaryContainer = "var(--color-on-primary-container)";
const error = "var(--color-error)";
const errorContainer = "var(--color-error-container)";
const onErrorContainer = "var(--color-on-error-container)";
const onSurface = "var(--color-on-surface)";
const muted = "var(--color-on-surface-variant)";
const outline = "var(--color-outline)";
const container = "var(--color-surface-container)";
const containerHigh = "var(--color-surface-container-high)";
const containerHighest = "var(--color-surface-container-highest)";
const canvasGradient = "linear-gradient(145deg, var(--color-surface) 0%, color-mix(in srgb, var(--color-primary-container) 34%, var(--color-surface)) 100%)";
const clipped = { minWidth: "0px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } as const;

function workspaceIndexLabel(workspace: WaylandWorkspace, index: number): string {
  const coord = workspace.coordinates[0];
  return coord !== undefined ? String(coord) : String(index + 1);
}

function workspaceTitle(workspace: WaylandWorkspace, index: number): string {
  const idx = workspaceIndexLabel(workspace, index);
  const raw = workspace.name?.trim();
  if (raw && raw.length > 0 && raw !== idx) return raw;
  return `Workspace ${idx}`;
}

function formatWindowLabel(win: WaylandWindow, app: DesktopAppSummary | undefined): string {
  if (app?.title) return app.title;
  const appId = win.app_id?.trim();
  if (appId) {
    const tail = appId.includes(".") ? appId.slice(appId.lastIndexOf(".") + 1) : appId;
    return tail.length > 0 ? tail[0]!.toUpperCase() + tail.slice(1) : appId;
  }
  return win.title?.trim() || "Window";
}

function MiniWindowTile(props: {
  readonly window: WaylandWindow;
  readonly app: DesktopAppSummary | undefined;
  readonly urgent: boolean;
  readonly onActivate: () => void;
}): NativeChild {
  const focused = () => props.window.activated;
  const label = () => formatWindowLabel(props.window, props.app);
  const barTint = () => (props.urgent ? errorContainer : focused() ? primaryContainer : containerHighest);
  const borderColor = () => (
    props.urgent
      ? error
      : focused()
        ? primary
        : "color-mix(in srgb, var(--color-outline-variant) 65%, transparent)"
  );

  return (
    <Button testId={`overview-window-${props.window.window_id}`}
      ariaLabel={`Focus ${props.window.title?.trim() || label()}`}
      onClick={event => {
        event.stopPropagation();
        props.onActivate();
      }}
      style={{
        display: "flex", flexDirection: "column", alignItems: "stretch", justifyContent: "flex-start",
        flexGrow: 1, flexBasis: "0px", minWidth: "48px", height: "100%",
        padding: "8px", gap: "6px", borderRadius: "10px",
        backgroundColor: container, color: focused() || props.urgent ? onSurface : muted,
        border: `1px solid ${borderColor()}`,
      }}>
      <row style={{ alignItems: "center", justifyContent: "space-between", gap: "4px", width: "100%" }}>
        <text style={{
          ...clipped, fontSize: "10px", lineHeight: "12px",
          fontWeight: focused() || props.urgent ? 600 : 500,
          color: focused() || props.urgent ? onSurface : muted,
        }}>
          {label()}
        </text>
        <Show when={focused()}>
          <box ariaHidden style={{ width: "6px", height: "6px", borderRadius: "3px", flexShrink: 0, backgroundColor: primary }} />
        </Show>
      </row>
      <box ariaHidden style={{ width: "82%", height: "6px", borderRadius: "3px", flexShrink: 0, backgroundColor: barTint() }} />
      <box ariaHidden style={{ width: "66%", height: "6px", borderRadius: "3px", flexShrink: 0, backgroundColor: containerHighest }} />
      <box ariaHidden style={{ width: "74%", height: "6px", borderRadius: "3px", flexShrink: 0, backgroundColor: containerHighest }} />
    </Button>
  );
}

function WorkspacePreviewCard(props: {
  readonly workspace: WaylandWorkspace;
  readonly index: number;
  readonly windows: readonly WaylandWindow[];
  readonly catalog: readonly DesktopAppSummary[] | undefined;
  readonly wallpaperSrc: string | undefined;
  readonly onActivateWorkspace: () => void;
  readonly onActivateWindow: (windowId: number) => void;
}): NativeChild {
  const ws = () => props.workspace;
  const active = () => ws().active;
  const urgent = () => ws().urgent;
  const idxLabel = () => workspaceIndexLabel(ws(), props.index);
  const title = () => workspaceTitle(ws(), props.index);
  // Standard Wayland ext-workspace-v1 + wlr-foreign-toplevel do not expose per-workspace
  // membership for inactive workspaces, so show live tiled windows on the active workspace.
  const cardWindows = () => (active() ? props.windows : []);
  const visibleTiles = () => cardWindows().slice(0, 3);
  const overflowCount = () => Math.max(0, cardWindows().length - visibleTiles().length);
  const isEmpty = () => cardWindows().length === 0;

  const cardBorder = () => (
    urgent()
      ? `1.5px solid ${error}`
      : active()
        ? `1.5px solid ${primary}`
        : "1.5px solid color-mix(in srgb, var(--color-outline-variant) 65%, transparent)"
  );
  const badgeBg = () => (urgent() ? errorContainer : active() ? primary : containerHighest);
  const badgeFg = () => (urgent() ? onErrorContainer : active() ? onPrimary : muted);
  const statusText = () => {
    if (active()) {
      const count = cardWindows().length;
      return `${count} ${count === 1 ? "window" : "windows"}`;
    }
    if (urgent()) return "Urgent";
    return "Switch";
  };
  const statusColor = () => (urgent() ? error : active() ? primary : outline);

  return (
    <Button testId={`overview-ws-${ws().workspace_id}`} selected={active()}
      ariaLabel={`Switch to ${title()}`}
      onClick={props.onActivateWorkspace}
      style={{
        display: "flex", flexDirection: "column", alignItems: "stretch", justifyContent: "flex-start",
        flexGrow: 1, flexBasis: "0px", minWidth: "0px", maxWidth: "316px",
        padding: "16px", gap: "10px", borderRadius: "22px",
        backgroundColor: containerHigh, color: onSurface, border: cardBorder(),
      }}>
      <row style={{ alignItems: "center", justifyContent: "space-between", gap: "8px", width: "100%" }}>
        <row style={{ alignItems: "center", gap: "8px", minWidth: "0px", flexGrow: 1 }}>
          <box style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            height: "20px", minWidth: "24px", padding: "0 8px", borderRadius: "10px", flexShrink: 0,
            backgroundColor: badgeBg(), color: badgeFg(),
          }}>
            <text data-tabular="true" style={{
              fontFamily: "var(--font-mono)", fontSize: "12px", fontWeight: 600, lineHeight: "16px",
              fontVariantNumeric: "tabular-nums",
            }}>
              {idxLabel()}
            </text>
          </box>
          <text style={{
            ...clipped, fontSize: "14px", lineHeight: "20px",
            fontWeight: active() || urgent() ? 600 : 500,
            color: active() || urgent() ? onSurface : muted,
          }}>
            {title()}
          </text>
        </row>
        <row style={{ alignItems: "center", gap: "6px", flexShrink: 0 }}>
          <Show when={urgent()}>
            <box ariaHidden style={{ width: "6px", height: "6px", borderRadius: "3px", flexShrink: 0, backgroundColor: error }} />
          </Show>
          <text data-tabular="true" style={{
            fontSize: "12px", lineHeight: "16px", color: statusColor(), fontVariantNumeric: "tabular-nums",
          }}>
            {statusText()}
          </text>
        </row>
      </row>

      <box style={{
        position: "relative", display: "flex", width: "100%", height: "158px",
        borderRadius: "16px", overflow: "hidden", padding: "10px", gap: "8px",
        background: canvasGradient,
        alignItems: isEmpty() ? "center" : "stretch",
        justifyContent: isEmpty() ? "center" : "flex-start",
      }}>
        <Show when={props.wallpaperSrc}>
          {src => (
            <Image ariaHidden src={src()} style={{
              position: "absolute", left: "0px", top: "0px", width: "100%", height: "100%",
              objectFit: "cover", opacity: 0.28,
            }} />
          )}
        </Show>
        <Show when={!isEmpty()} fallback={
          <column style={{ alignItems: "center", justifyContent: "center", gap: "6px" }}>
            <ShellIcon name="add" size={24} color={urgent() ? error : outline} />
            <text style={{ fontSize: "12px", lineHeight: "16px", color: urgent() ? error : outline }}>
              {active() ? "Empty workspace" : urgent() ? "Attention requested" : "Open workspace"}
            </text>
          </column>
        }>
          <For each={visibleTiles()} keyed={win => win.window_id}>
            {win => (
              <MiniWindowTile
                window={win()}
                app={resolveDesktopApp(props.catalog, win().app_id)}
                urgent={urgent()}
                onActivate={() => props.onActivateWindow(win().window_id)}
              />
            )}
          </For>
          <Show when={overflowCount() > 0}>
            <box style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: "40px", height: "100%", borderRadius: "10px", flexShrink: 0,
              backgroundColor: container, color: muted,
              border: "1px solid color-mix(in srgb, var(--color-outline-variant) 65%, transparent)",
            }}>
              <text data-tabular="true" style={{ fontFamily: "var(--font-mono)", fontSize: "11px", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
                {`+${overflowCount()}`}
              </text>
            </box>
          </Show>
        </Show>
      </box>
    </Button>
  );
}

function OverviewContent(props: {
  readonly monitor: Accessor<Monitor | undefined>;
  readonly spatial: M3Spring;
  readonly opacity: M3Spring;
}): NativeChild {
  const { hostClient, workspaces, windows, outputs, apps, wallpaper, invokePublic, closePanels } = useShellStore();
  const scheme = useMotionScheme();
  const monitorName = () => props.monitor()?.name ?? props.monitor()?.id ?? "Display";
  const monitorWorkspaces = createMemo(() => filterWorkspacesForMonitor(workspaces.data(), outputs.data(), monitorName()));
  const monitorWindows = createMemo(() => {
    const all = (windows.data()?.windows ?? []).filter(win => !win.minimized);
    const output = outputs.data()?.outputs.find(candidate => candidate.name === monitorName());
    if (!output) return all;
    const local = all.filter(win =>
      win.output_instance_ids.length === 0 || win.output_instance_ids.includes(output.output_instance_id),
    );
    return local.length > 0 ? local : all;
  });
  const workspaceRows = createMemo(() => {
    const list = monitorWorkspaces();
    const pairs: { readonly key: string; readonly items: readonly { readonly workspace: WaylandWorkspace; readonly index: number }[] }[] = [];
    for (let i = 0; i < list.length; i += 2) {
      const first = list[i]!;
      const second = list[i + 1];
      const items = second
        ? [{ workspace: first, index: i }, { workspace: second, index: i + 1 }]
        : [{ workspace: first, index: i }];
      pairs.push({ key: second ? `${first.workspace_id}:${second.workspace_id}` : `${first.workspace_id}`, items });
    }
    return pairs;
  });
  const activeWallpaper = () => resolveMonitorWallpaper(wallpaper.data(), monitorName());
  const { src: wallpaperSrc } = useDaemonMedia(hostClient, () => activeWallpaper()?.media, { fetchCommand: "wallpaper.fetch-blob" });

  function activateWorkspace(workspaceId: number): void {
    void invokePublic("wayland.workspace.activate", { workspace_id: workspaceId });
    closePanels();
  }

  function activateWindow(windowId: number): void {
    void invokePublic("wayland.window.activate", { window_id: windowId });
    closePanels();
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

  const wsCount = () => monitorWorkspaces().length;

  return (
    <box testId="overview-backdrop" onClick={closePanels} style={{
      position: "fixed", left: "0px", top: "0px", width: "100%", height: "100%",
      display: "flex", alignItems: "center", justifyContent: "center", padding: "14px",
      backgroundColor: scrimBackdrop(48, props.opacity()),
    }}>
      <column testId="overview-card" role="dialog" ariaLabel="Workspace overview" ariaModal
        onClick={event => event.stopPropagation()} onKeyDown={handleKeyDown}
        style={{
          width: "684px", maxWidth: "100%", maxHeight: "760px", padding: "18px", gap: "16px", borderRadius: "22px",
          backgroundColor: container, color: onSurface, fontFamily: "var(--font-sans)",
          border: "1px solid color-mix(in srgb, var(--color-outline-variant) 65%, transparent)",
          boxShadow: "0 20px 56px rgba(0, 0, 0, 0.60)",
          ...dialogMotionStyle(props.spatial(), { opacity: props.opacity(), reduced: scheme() === "reduced", fromScale: 0.96, fromY: 8 }),
        }}>
        <row style={{ alignItems: "center", gap: "12px", width: "100%", flexShrink: 0 }}>
          <box ariaHidden style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            width: "40px", height: "40px", borderRadius: "14px", flexShrink: 0,
            backgroundColor: primaryContainer,
          }}>
            <ShellIcon name="overview" size={22} color={onPrimaryContainer} />
          </box>
          <column style={{ flexGrow: 1, flexBasis: "0px", minWidth: "0px", gap: "2px" }}>
            <text role="heading" style={{
              fontSize: "22px", fontWeight: 600, lineHeight: "28px", letterSpacing: "-0.015em", color: onSurface,
            }}>
              Workspace overview
            </text>
            <text style={{ fontSize: "12px", lineHeight: "16px", color: muted }}>
              {`${monitorName()} · ${wsCount()} ${wsCount() === 1 ? "workspace" : "workspaces"}`}
            </text>
          </column>
          <Button testId="overview-close" ariaLabel="Close overview" ref={node => focus(node)} onClick={closePanels} style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            width: "36px", height: "36px", borderRadius: "999px", flexShrink: 0,
            backgroundColor: containerHigh, color: onSurface,
          }}>
            <ShellIcon name="close" size={18} color={onSurface} />
          </Button>
        </row>

        <Show when={workspaceRows().length > 0} fallback={
          <box style={{
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
            width: "100%", height: "158px", borderRadius: "16px", gap: "6px", backgroundColor: containerHigh,
          }}>
            <ShellIcon name="overview" size={24} color={outline} />
            <text style={{ fontSize: "12px", lineHeight: "16px", color: outline }}>
              No workspaces reported by compositor
            </text>
          </box>
        }>
          <scroll style={{ width: "100%", maxHeight: "520px", overflow: "hidden auto" }}>
            <column style={{ gap: "16px", width: "100%" }}>
              <For each={workspaceRows()} keyed={row => row.key}>
                {row => (
                  <row style={{ gap: "16px", width: "100%" }}>
                    <For each={row().items} keyed={entry => entry.workspace.workspace_id}>
                      {entry => (
                        <WorkspacePreviewCard
                          workspace={entry().workspace}
                          index={entry().index}
                          windows={monitorWindows()}
                          catalog={apps.data()?.apps}
                          wallpaperSrc={wallpaperSrc()}
                          onActivateWorkspace={() => activateWorkspace(entry().workspace.workspace_id)}
                          onActivateWindow={activateWindow}
                        />
                      )}
                    </For>
                    <Show when={row().items.length === 1}>
                      <box ariaHidden style={{ flexGrow: 1, flexBasis: "0px", minWidth: "0px" }} />
                    </Show>
                  </row>
                )}
              </For>
            </column>
          </scroll>
        </Show>
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
