import {
  Button, For, LayerSurface, Show, createMemo, createSignal, focus, useMonitors,
  type Accessor, type Monitor, type NativeChild,
} from "@hewel/zgui";
import type { ZShellClient } from "@z-shell/sdk";
import { createPresence, useGlobalMotionScheme, useTopic, type M3Spring } from "@z-shell/sdk/zgui";
import styles from "./layer.module.css";
import type { NiriOverviewSnapshot, WorkspaceViewportLayout } from "./service.ts";

function formatNiriWindowName(appId: string | undefined, title: string | undefined): string {
  const raw = appId?.trim();
  if (raw) {
    const tail = raw.includes(".") ? raw.slice(raw.lastIndexOf(".") + 1) : raw;
    return tail.length > 0 ? tail[0]!.toUpperCase() + tail.slice(1) : raw;
  }
  return title?.trim() || "Window";
}

function WorkspaceCard(props: {
  readonly workspace: WorkspaceViewportLayout;
  readonly close: () => void;
}): NativeChild {
  const ws = () => props.workspace;
  const windows = createMemo(() => ws().windows.filter(win => win.width > 0 && win.height > 0));
  const percent = (fraction: number) => `${(Math.max(0, Math.min(1, fraction)) * 100).toFixed(2)}%`;
  const active = () => ws().focused || ws().active;

  return (
    <Button
      testId={`niri-ws-${ws().workspaceId}`}
      selected={active()}
      data-active={active() ? "true" : null}
      onClick={props.close}
      class={styles.workspaceCard}
    >
      <row class={styles.wsHeader}>
        <row class={styles.wsTitleGroup}>
          <box class={styles.wsIndexBadge} data-active={active() ? "true" : null}>
            <text data-tabular="true" class={styles.wsIndexText}>
              {ws().index}
            </text>
          </box>
          <text class={styles.wsName} data-active={active() ? "true" : null}>
            {`Workspace ${ws().index}`}
          </text>
        </row>
        <text
          data-tabular="true"
          class={styles.wsCount}
          data-active={active() ? "true" : null}
          data-empty={windows().length === 0 ? "true" : null}
        >
          {`${windows().length} ${windows().length === 1 ? "window" : "windows"}`}
        </text>
      </row>

      <box class={styles.wsCanvas}>
        <Show when={windows().length > 0} fallback={
          <column class={styles.wsEmptyCol}>
            <vector ariaHidden viewBox="0 0 24 24" d={"M12 5l0 14\nM5 12l14 0"} class={styles.wsEmptyIcon} />
            <text class={styles.wsEmptyText}>Empty workspace</text>
          </column>
        }>
          <For each={windows()} keyed={win => win.id}>
            {win => (
              <box
                testId={`niri-win-${win().id}`}
                class={styles.wsWindow}
                data-focused={win().focused ? "true" : null}
                style={{
                  // The service publishes output-canvas coordinates; rebase to this workspace's viewport.
                  left: percent((win().x - ws().x) / ws().width),
                  top: percent((win().y - ws().y) / ws().height),
                  width: percent(win().width / ws().width),
                  height: percent(win().height / ws().height),
                }}
              >
                <row class={styles.wsWindowHeader}>
                  <text class={styles.wsWindowTitle} data-focused={win().focused ? "true" : null}>
                    {formatNiriWindowName(win().appId, win().title)}
                  </text>
                  <Show when={win().focused}>
                    <box ariaHidden class={styles.wsWindowDot} />
                  </Show>
                </row>
                <box ariaHidden class={styles.wsWindowBarLong} data-focused={win().focused ? "true" : null} />
                <box ariaHidden class={styles.wsWindowBarShort} />
              </box>
            )}
          </For>
        </Show>
      </box>
    </Button>
  );
}

function OverviewCard(props: {
  readonly monitor: Monitor;
  readonly snapshot: Accessor<NiriOverviewSnapshot | undefined>;
  readonly client: Accessor<ZShellClient | undefined>;
  readonly open: Accessor<boolean>;
  readonly progress: M3Spring;
  readonly opacity: M3Spring;
}): NativeChild {
  const workspaces = createMemo(() => {
    const layouts = props.snapshot()?.layouts;
    const name = props.monitor.name;
    const local = layouts?.filter(ws => ws.output === name);
    return local?.length ? local : (layouts ?? []);
  });
  const workspaceRows = createMemo(() => {
    const list = workspaces();
    const pairs: { readonly key: string; readonly items: readonly WorkspaceViewportLayout[] }[] = [];
    for (let i = 0; i < list.length; i += 2) {
      const first = list[i]!;
      const second = list[i + 1];
      pairs.push({
        key: second ? `${first.workspaceId}:${second.workspaceId}` : `${first.workspaceId}`,
        items: second ? [first, second] : [first],
      });
    }
    return pairs;
  });
  const [commandError, setCommandError] = createSignal<string>();

  async function invoke(action: "refresh" | "toggle", payload?: { open: false }): Promise<void> {
    const client = props.client();
    if (!client) return;
    setCommandError(undefined);
    try {
      await client.invokeCommand(`plugin.z-shell.niri-overview.${action}`, [], payload);
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error));
    }
  }

  // Closing must not reopen the overview when two outputs dismiss before receiving the update.
  const close = () => void invoke("toggle", { open: false });
  const scheme = useGlobalMotionScheme();
  const reduced = () => scheme() === "reduced";
  const cardScale = () => (props.open()
    ? 1.06 - props.progress() * 0.06
    : 1.0 + (1 - props.progress()) * 0.04);

  return (
    <box
      testId="niri-overview-backdrop"
      onClick={close}
      class={styles.backdrop}
      style={{
        backgroundColor: `color-mix(in srgb, var(--color-scrim) ${(48 * Math.max(0, Math.min(1, props.opacity()))).toFixed(1)}%, transparent)`,
      }}
    >
      <column
        testId="niri-overview-card"
        role="dialog"
        ariaLabel="Workspace overview"
        ariaModal
        onClick={event => event.stopPropagation()}
        onKeyDown={event => {
          if (event.key === "Escape" && !event.repeat) {
            event.preventDefault();
            close();
          }
        }}
        class={styles.overviewCard}
        style={{
          opacity: Math.max(0, Math.min(1, props.opacity())),
          transform: reduced() ? "none" : `scale(${cardScale().toFixed(4)})`,
        }}
      >
        <row class={styles.cardHeader}>
          <box ariaHidden class={styles.headerBadge}>
            <vector
              ariaHidden
              viewBox="0 0 24 24"
              d={"M5 4h4a1 1 0 0 1 1 1v6a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1v-6a1 1 0 0 1 1 -1\nM5 16h4a1 1 0 0 1 1 1v2a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1v-2a1 1 0 0 1 1 -1\nM15 12h4a1 1 0 0 1 1 1v6a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1v-6a1 1 0 0 1 1 -1\nM15 4h4a1 1 0 0 1 1 1v2a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1v-2a1 1 0 0 1 1 -1"}
              class={styles.headerBadgeIcon}
            />
          </box>
          <column class={styles.headerTitles}>
            <text role="heading" class={styles.headerTitle}>
              Workspace overview
            </text>
            <text class={styles.headerSubtitle}>
              {`${props.monitor.name} · ${workspaces().length} ${workspaces().length === 1 ? "workspace" : "workspaces"}`}
            </text>
          </column>
          <row class={styles.headerActions}>
            <Button
              testId="niri-overview-refresh"
              ariaLabel="Refresh overview"
              onClick={() => void invoke("refresh")}
              class={styles.circleBtn}
            >
              <vector
                ariaHidden
                viewBox="0 0 24 24"
                d={"M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4\nM4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4"}
                class={styles.circleBtnIcon}
              />
            </Button>
            <Button
              testId="niri-overview-close"
              ariaLabel="Close overview"
              ref={node => focus(node)}
              onClick={close}
              class={styles.circleBtn}
            >
              <vector
                ariaHidden
                viewBox="0 0 24 24"
                d={"M18 6l-12 12\nM6 6l12 12"}
                class={styles.circleBtnIcon}
              />
            </Button>
          </row>
        </row>
        <Show when={commandError()} fallback={<box class={styles.hidden} />}>
          {message => <text role="alert" class={styles.errorText}>{message()}</text>}
        </Show>
        <Show when={workspaceRows().length > 0} fallback={
          <box class={styles.emptyCard}>
            <text class={styles.wsEmptyText}>No workspaces available</text>
          </box>
        }>
          <scroll class={styles.wsScroll}>
            <column class={styles.wsGridCol}>
              <For each={workspaceRows()} keyed={row => row.key}>
                {row => (
                  <row class={styles.wsGridRow}>
                    <For each={row().items} keyed={ws => ws.workspaceId}>
                      {ws => <WorkspaceCard workspace={ws()} close={close} />}
                    </For>
                    <Show when={row().items.length === 1}>
                      <box ariaHidden class={styles.wsSpacer} />
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

function formatOverviewSurfaceName(id: string): string {
  const normalized = id.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `niri-overview-${normalized || "default"}`.slice(0, 128);
}

export default function NiriOverviewLayer(props: { readonly client: Accessor<ZShellClient | undefined> }): NativeChild {
  const { data: snapshot } = useTopic<NiriOverviewSnapshot>(() => props.client(), "plugin.z-shell.niri-overview.state");
  const monitors = useMonitors();
  const scheme = useGlobalMotionScheme();
  const open = () => snapshot()?.open === true;
  const presence = createPresence(open, {
    scheme,
    enterRole: "slowSpatial",
    enterOpacityRole: "slowEffects",
    exitRole: "slowEffects",
  });

  return (
    <Show when={presence.mounted()}>
      <For each={monitors()} keyed={m => m.id}>
        {monitor => {
          const size = createMemo(() => {
            const current = monitor();
            const logical = snapshot()?.outputs.find(output => output.name === current.name || output.name === current.id);
            if (logical && logical.width > 0 && logical.height > 0) {
              return { width: logical.width, height: logical.height };
            }
            if (current.logicalWidth > 0 && current.logicalHeight > 0) {
              return { width: current.logicalWidth, height: current.logicalHeight };
            }
            return { width: current.width, height: current.height };
          });
          return (
            <LayerSurface name={formatOverviewSurfaceName(monitor().id)} output={monitor().id} layer="overlay"
              anchor={["top", "bottom", "left", "right"]} width={size().width} height={size().height}
              exclusiveZone={-1} keyboard="exclusive">
              <OverviewCard monitor={monitor()} snapshot={snapshot} client={props.client}
                open={open} progress={presence.progress} opacity={presence.opacity} />
            </LayerSurface>
          );
        }}
      </For>
    </Show>
  );
}
