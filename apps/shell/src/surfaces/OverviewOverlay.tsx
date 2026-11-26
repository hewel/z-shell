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
import styles from "./OverviewOverlay.module.css";

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
  const barState = () => (props.urgent ? "urgent" : focused() ? "focused" : "idle");

  return (
    <Button
      testId={`overview-window-${props.window.window_id}`}
      ariaLabel={`Focus ${props.window.title?.trim() || label()}`}
      onClick={event => {
        event.stopPropagation();
        props.onActivate();
      }}
      data-focused={focused() ? "true" : "false"}
      data-urgent={props.urgent ? "true" : "false"}
      class={styles.miniWindowTile}
    >
      <row class={styles.miniWindowHeader}>
        <text data-active={focused() || props.urgent ? "true" : "false"} class={styles.miniWindowTitle}>
          {label()}
        </text>
        <Show when={focused()}>
          <box ariaHidden class={styles.miniFocusDot} />
        </Show>
      </row>
      <box ariaHidden data-state={barState()} class={styles.miniBar1} />
      <box ariaHidden class={styles.miniBar2} />
      <box ariaHidden class={styles.miniBar3} />
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
  const state = () => (urgent() ? "urgent" : active() ? "active" : "idle");
  const statusText = () => {
    if (active()) {
      const count = cardWindows().length;
      return `${count} ${count === 1 ? "window" : "windows"}`;
    }
    if (urgent()) return "Urgent";
    return "Switch";
  };

  return (
    <Button
      testId={`overview-ws-${ws().workspace_id}`}
      selected={active()}
      ariaLabel={`Switch to ${title()}`}
      onClick={props.onActivateWorkspace}
      data-active={active() ? "true" : "false"}
      data-urgent={urgent() ? "true" : "false"}
      class={styles.workspaceCard}
    >
      <row class={styles.workspaceHeader}>
        <row class={styles.workspaceTitleGroup}>
          <box data-state={state()} class={styles.workspaceBadge}>
            <text data-tabular="true" class={styles.workspaceBadgeText}>
              {idxLabel()}
            </text>
          </box>
          <text data-emphasized={active() || urgent() ? "true" : "false"} class={styles.workspaceTitle}>
            {title()}
          </text>
        </row>
        <row class={styles.workspaceStatusRow}>
          <Show when={urgent()}>
            <box ariaHidden class={styles.urgentDot} />
          </Show>
          <text data-tabular="true" data-state={state()} class={styles.workspaceStatusText}>
            {statusText()}
          </text>
        </row>
      </row>

      <box data-empty={isEmpty() ? "true" : "false"} class={styles.previewCanvas}>
        <Show when={props.wallpaperSrc}>
          {src => <Image ariaHidden src={src()} class={styles.previewWallpaper} />}
        </Show>
        <Show when={!isEmpty()} fallback={
          <column class={styles.emptyWorkspace}>
            <ShellIcon name="add" size={24} color={urgent() ? "var(--color-error)" : "var(--color-outline)"} />
            <text data-urgent={urgent() ? "true" : "false"} class={styles.emptyWorkspaceText}>
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
            <box class={styles.overflowBadge}>
              <text data-tabular="true" class={styles.overflowBadgeText}>
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
  readonly inert: boolean;
  readonly spatial: M3Spring;
  readonly opacity: M3Spring;
}): NativeChild {
  const { hostClient, workspaces, windows, outputs, apps, wallpaper, theme, invokePublic, closePanels } = useShellStore();
  const dark = () => theme.data()?.dark ?? true;
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
    <box
      testId="overview-backdrop"
      inert={props.inert}
      onClick={closePanels}
      class={styles.backdrop}
      style={{ backgroundColor: scrimBackdrop(48, props.opacity(), dark()) }}
    >
      <column
        testId="overview-card"
        role="dialog"
        ariaLabel="Workspace overview"
        ariaModal
        onClick={event => event.stopPropagation()}
        onKeyDown={handleKeyDown}
        class={styles.card}
        style={{ ...dialogMotionStyle(props.spatial(), { opacity: props.opacity(), reduced: scheme() === "reduced", fromScale: 0.96, fromY: 8 }) }}
      >
        <row class={styles.headerRow}>
          <box ariaHidden class={styles.headerBadge}>
            <ShellIcon name="overview" filled size={22} color="var(--color-on-primary-container)" />
          </box>
          <column class={styles.headerText}>
            <text role="heading" class={styles.headerTitle}>
              Workspace overview
            </text>
            <text class={styles.headerSubtitle}>
              {`${monitorName()} · ${wsCount()} ${wsCount() === 1 ? "workspace" : "workspaces"}`}
            </text>
          </column>
          <Button
            testId="overview-close"
            ariaLabel="Close overview"
            ref={node => focus(node)}
            onClick={closePanels}
            class={styles.closeButton}
          >
            <ShellIcon name="close" size={18} color="var(--color-on-surface)" />
          </Button>
        </row>

        <Show when={workspaceRows().length > 0} fallback={
          <box class={styles.emptyWorkspaces}>
            <ShellIcon name="overview" size={24} color="var(--color-outline)" />
            <text class={styles.emptyWorkspacesText}>
              No workspaces reported by compositor
            </text>
          </box>
        }>
          <scroll class={styles.gridScroll}>
            <column class={styles.gridRows}>
              <For each={workspaceRows()} keyed={row => row.key}>
                {row => (
                  <row class={styles.gridRow}>
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
                      <box ariaHidden class={styles.rowSpacer} />
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
            <OverviewContent monitor={monitor} inert={!presence.present()} spatial={presence.progress} opacity={presence.opacity} />
          </LayerSurface>
        );
      }}
    </Show>
  );
}
