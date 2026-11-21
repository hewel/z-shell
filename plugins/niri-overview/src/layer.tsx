import {
  Button, For, LayerSurface, Show, createMemo, createSignal, focus, useMonitors,
  type Accessor, type Monitor, type NativeChild, type NativeStyle,
} from "@hewel/zgui";
import type { ZShellClient } from "@z-shell/sdk";
import { createPresence, useGlobalMotionScheme, useTopic, type M3Spring } from "@z-shell/sdk/zgui";
import type { NiriOverviewSnapshot, WorkspaceViewportLayout } from "./service.ts";

const actionStyle: NativeStyle = {
  padding: "6px 12px", borderRadius: "10px", minHeight: "34px", fontSize: "12px", fontWeight: 500,
  backgroundColor: "var(--color-secondary-container)", color: "var(--color-on-secondary-container)",
};

function WorkspaceCard(props: {
  readonly workspace: WorkspaceViewportLayout;
  readonly close: () => void;
}): NativeChild {
  const ws = () => props.workspace;
  const windows = createMemo(() => ws().windows.filter(win => win.width > 0 && win.height > 0));
  const percent = (fraction: number) => `${fraction * 100}%`;

  return (
    <Button testId={`niri-ws-${ws().workspaceId}`} onClick={props.close} style={{
      display: "flex", flexDirection: "column", alignItems: "stretch", gap: "10px", padding: "12px",
      width: "316px", maxWidth: "100%", borderRadius: "16px",
      backgroundColor: ws().focused ? "var(--color-primary-container)" : "var(--color-surface-container-high)",
      border: ws().focused
        ? "1px solid color-mix(in srgb, var(--color-primary) 35%, transparent)"
        : "1px solid color-mix(in srgb, var(--color-outline-variant) 45%, transparent)",
      color: ws().focused ? "var(--color-on-primary-container)" : "var(--color-on-surface)",
    }}>
      <row style={{ alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
        <text style={{ fontSize: "14px", fontWeight: 600 }}>Workspace {ws().index}</text>
        <text data-tabular="true" style={{
          fontFamily: "var(--font-mono)", fontSize: "11px", fontVariantNumeric: "tabular-nums",
          color: ws().focused ? "var(--color-on-primary-container)" : "var(--color-on-surface-variant)",
        }}>
          {`${windows().length} ${windows().length === 1 ? "win" : "wins"}`}
        </text>
      </row>
      <box style={{
        position: "relative", height: "164px", overflow: "hidden", borderRadius: "10px",
        backgroundColor: "var(--color-surface-container-lowest)",
      }}>
        <For each={windows()} keyed={win => win.id}>
          {win => <box testId={`niri-win-${win().id}`} style={{
            position: "absolute", borderRadius: "6px",
            // The service publishes output-canvas coordinates; rebase to this workspace's viewport.
            left: percent((win().x - ws().x) / ws().width), top: percent((win().y - ws().y) / ws().height),
            width: percent(win().width / ws().width), height: percent(win().height / ws().height),
            backgroundColor: win().focused ? "var(--color-primary)" : "var(--color-surface-container-highest)",
          }} />}
        </For>
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
    return local?.length ? local : layouts;
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
    <box testId="niri-overview-backdrop" onClick={close} style={{
      position: "fixed", left: "0px", top: "0px", width: "100%", height: "100%",
      display: "flex", alignItems: "center", justifyContent: "center", padding: "14px",
      backgroundColor: `color-mix(in srgb, var(--color-scrim) ${(55 * Math.max(0, Math.min(1, props.opacity()))).toFixed(1)}%, transparent)`,
    }}>
      <column testId="niri-overview-card" role="dialog" ariaLabel="Workspace Overview" ariaModal tabIndex={-1}
        ref={node => focus(node)} onClick={event => event.stopPropagation()} onKeyDown={event => {
          if (event.key === "Escape" && !event.repeat) {
            event.preventDefault();
            close();
          }
        }} style={{
          width: "684px", maxWidth: "100%", maxHeight: "100%", padding: "18px", gap: "14px", borderRadius: "22px",
          backgroundColor: "var(--color-surface-container)", color: "var(--color-on-surface)",
          border: "1px solid color-mix(in srgb, var(--color-outline-variant) 55%, transparent)",
          boxShadow: "0 20px 56px rgba(0, 0, 0, 0.60)",
          opacity: Math.max(0, Math.min(1, props.opacity())),
          transform: reduced() ? "none" : `scale(${cardScale().toFixed(4)})`,
          transformOrigin: "center",
        }}>
        <row style={{ alignItems: "center", flexShrink: 0, gap: "10px" }}>
          <column style={{ flexGrow: 1, minWidth: "0px", gap: "2px" }}>
            <row style={{ alignItems: "center", gap: "8px" }}>
              <text role="heading" style={{ fontSize: "20px", fontWeight: 600 }}>Workspace Overview</text>
              <text style={{
                padding: "3px 8px", fontSize: "11px", borderRadius: "999px", fontFamily: "var(--font-mono)",
                backgroundColor: "var(--color-surface-container-highest)", color: "var(--color-on-surface-variant)",
              }}>{props.monitor.name}</text>
            </row>
          </column>
          <Button testId="niri-overview-refresh" style={actionStyle} onClick={() => void invoke("refresh")}>Refresh</Button>
          <Button testId="niri-overview-close" style={actionStyle} onClick={close}>Close</Button>
        </row>
        <Show when={commandError()} fallback={<box style={{ display: "none" }} />}>
          {message => <text role="alert" style={{ color: "var(--color-error)" }}>{message()}</text>}
        </Show>
        <Show when={workspaces()?.length} fallback={<text style={{ color: "var(--color-on-surface-variant)" }}>No workspaces available</text>}>
          <scroll style={{ minHeight: "0px", flexShrink: 1 }}>
            <row style={{ flexWrap: "wrap", gap: "14px" }}>
              <For each={workspaces()} keyed={ws => ws.workspaceId}>
                {ws => <WorkspaceCard workspace={ws()} close={close} />}
              </For>
            </row>
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
  const { data: snapshot } = useTopic<NiriOverviewSnapshot>(props.client, "plugin.z-shell.niri-overview.state");
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
