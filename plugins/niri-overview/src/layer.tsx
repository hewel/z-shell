import {
  Button, For, LayerSurface, Show, createMemo, createSignal, focus, useMonitors,
  type Accessor, type Monitor, type NativeChild,
} from "@hewel/zgui";
import type { ZShellClient } from "@z-shell/sdk";
import { createPresence, useGlobalMotionScheme, useTopic, type M3Spring } from "@z-shell/sdk/zgui";
import type { NiriOverviewSnapshot, WorkspaceViewportLayout } from "./service.ts";

const primary = "var(--color-primary)";
const onPrimary = "var(--color-on-primary)";
const primaryContainer = "var(--color-primary-container)";
const onPrimaryContainer = "var(--color-on-primary-container)";
const onSurface = "var(--color-on-surface)";
const muted = "var(--color-on-surface-variant)";
const outline = "var(--color-outline)";
const container = "var(--color-surface-container)";
const containerHigh = "var(--color-surface-container-high)";
const containerHighest = "var(--color-surface-container-highest)";
const canvasGradient = "linear-gradient(145deg, var(--color-surface) 0%, color-mix(in srgb, var(--color-primary-container) 34%, var(--color-surface)) 100%)";
const clipped = { minWidth: "0px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } as const;

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
    <Button testId={`niri-ws-${ws().workspaceId}`} selected={active()} onClick={props.close} style={{
      display: "flex", flexDirection: "column", alignItems: "stretch", justifyContent: "flex-start",
      flexGrow: 1, flexBasis: "0px", minWidth: "0px", maxWidth: "316px",
      padding: "16px", gap: "10px", borderRadius: "22px",
      backgroundColor: containerHigh, color: onSurface,
      border: active()
        ? `1.5px solid ${primary}`
        : "1.5px solid color-mix(in srgb, var(--color-outline-variant) 65%, transparent)",
    }}>
      <row style={{ alignItems: "center", justifyContent: "space-between", gap: "8px", width: "100%" }}>
        <row style={{ alignItems: "center", gap: "8px", minWidth: "0px", flexGrow: 1 }}>
          <box style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            height: "20px", minWidth: "24px", padding: "0 8px", borderRadius: "10px", flexShrink: 0,
            backgroundColor: active() ? primary : containerHighest,
            color: active() ? onPrimary : muted,
          }}>
            <text data-tabular="true" style={{
              fontFamily: "var(--font-mono)", fontSize: "12px", fontWeight: 600, lineHeight: "16px",
              fontVariantNumeric: "tabular-nums",
            }}>
              {ws().index}
            </text>
          </box>
          <text style={{
            ...clipped, fontSize: "14px", lineHeight: "20px",
            fontWeight: active() ? 600 : 500,
            color: active() ? onSurface : muted,
          }}>
            {`Workspace ${ws().index}`}
          </text>
        </row>
        <text data-tabular="true" style={{
          fontSize: "12px", lineHeight: "16px", fontVariantNumeric: "tabular-nums",
          color: active() ? primary : windows().length === 0 ? outline : muted,
        }}>
          {`${windows().length} ${windows().length === 1 ? "window" : "windows"}`}
        </text>
      </row>

      <box style={{
        position: "relative", display: "flex", width: "100%", height: "158px",
        overflow: "hidden", borderRadius: "16px", background: canvasGradient,
        alignItems: "center", justifyContent: "center",
      }}>
        <Show when={windows().length > 0} fallback={
          <column style={{ alignItems: "center", justifyContent: "center", gap: "6px" }}>
            <vector ariaHidden viewBox="0 0 24 24" d={"M12 5l0 14\nM5 12l14 0"}
              style={{
                width: "24px",
                height: "24px",
                "--zgui-fill": "transparent",
                "--zgui-stroke": outline,
                "--zgui-stroke-width": "2px",
                "--zgui-stroke-linecap": "round",
                "--zgui-stroke-linejoin": "round",
              }} />
            <text style={{ fontSize: "12px", lineHeight: "16px", color: outline }}>Empty workspace</text>
          </column>
        }>
          <For each={windows()} keyed={win => win.id}>
            {win => (
              <box testId={`niri-win-${win().id}`} style={{
                position: "absolute", display: "flex", flexDirection: "column",
                borderRadius: "10px", padding: "6px", gap: "5px", overflow: "hidden",
                // The service publishes output-canvas coordinates; rebase to this workspace's viewport.
                left: percent((win().x - ws().x) / ws().width), top: percent((win().y - ws().y) / ws().height),
                width: percent(win().width / ws().width), height: percent(win().height / ws().height),
                backgroundColor: container,
                border: win().focused
                  ? `1px solid ${primary}`
                  : "1px solid color-mix(in srgb, var(--color-outline-variant) 65%, transparent)",
              }}>
                <row style={{ alignItems: "center", justifyContent: "space-between", gap: "4px", width: "100%" }}>
                  <text style={{
                    ...clipped, fontSize: "10px", lineHeight: "12px",
                    fontWeight: win().focused ? 600 : 500,
                    color: win().focused ? onSurface : muted,
                  }}>
                    {formatNiriWindowName(win().appId, win().title)}
                  </text>
                  <Show when={win().focused}>
                    <box ariaHidden style={{ width: "6px", height: "6px", borderRadius: "3px", flexShrink: 0, backgroundColor: primary }} />
                  </Show>
                </row>
                <box ariaHidden style={{ width: "80%", height: "6px", borderRadius: "3px", flexShrink: 0, backgroundColor: win().focused ? primaryContainer : containerHighest }} />
                <box ariaHidden style={{ width: "62%", height: "6px", borderRadius: "3px", flexShrink: 0, backgroundColor: containerHighest }} />
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
    <box testId="niri-overview-backdrop" onClick={close} style={{
      position: "fixed", left: "0px", top: "0px", width: "100%", height: "100%",
      display: "flex", alignItems: "center", justifyContent: "center", padding: "14px",
      backgroundColor: `color-mix(in srgb, var(--color-scrim) ${(48 * Math.max(0, Math.min(1, props.opacity()))).toFixed(1)}%, transparent)`,
    }}>
      <column testId="niri-overview-card" role="dialog" ariaLabel="Workspace overview" ariaModal
        onClick={event => event.stopPropagation()} onKeyDown={event => {
          if (event.key === "Escape" && !event.repeat) {
            event.preventDefault();
            close();
          }
        }} style={{
          width: "684px", maxWidth: "100%", maxHeight: "760px", padding: "18px", gap: "16px", borderRadius: "22px",
          backgroundColor: container, color: onSurface, fontFamily: "var(--font-sans)",
          border: "1px solid color-mix(in srgb, var(--color-outline-variant) 65%, transparent)",
          boxShadow: "var(--shadow-level-3)",
          opacity: Math.max(0, Math.min(1, props.opacity())),
          transform: reduced() ? "none" : `scale(${cardScale().toFixed(4)})`,
          transformOrigin: "center",
        }}>
        <row style={{ alignItems: "center", flexShrink: 0, gap: "12px", width: "100%" }}>
          <box ariaHidden style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            width: "40px", height: "40px", borderRadius: "14px", flexShrink: 0,
            backgroundColor: primaryContainer,
          }}>
            <vector ariaHidden viewBox="0 0 24 24"
              d={"M9 3a2 2 0 0 1 2 2v6a2 2 0 0 1 -2 2h-4a2 2 0 0 1 -2 -2v-6a2 2 0 0 1 2 -2zm0 12a2 2 0 0 1 2 2v2a2 2 0 0 1 -2 2h-4a2 2 0 0 1 -2 -2v-2a2 2 0 0 1 2 -2zm10 -4a2 2 0 0 1 2 2v6a2 2 0 0 1 -2 2h-4a2 2 0 0 1 -2 -2v-6a2 2 0 0 1 2 -2zm0 -8a2 2 0 0 1 2 2v2a2 2 0 0 1 -2 2h-4a2 2 0 0 1 -2 -2v-2a2 2 0 0 1 2 -2z"}
              style={{ width: "22px", height: "22px", "--zgui-fill": onPrimaryContainer }} />
          </box>
          <column style={{ flexGrow: 1, flexBasis: "0px", minWidth: "0px", gap: "2px" }}>
            <text role="heading" style={{ fontSize: "22px", fontWeight: 600, lineHeight: "28px", letterSpacing: "-0.015em" }}>
              Workspace overview
            </text>
            <text style={{ fontSize: "12px", lineHeight: "16px", color: muted }}>
              {`${props.monitor.name} · ${workspaces().length} ${workspaces().length === 1 ? "workspace" : "workspaces"}`}
            </text>
          </column>
          <row style={{ alignItems: "center", gap: "8px", flexShrink: 0 }}>
            <Button testId="niri-overview-refresh" ariaLabel="Refresh overview"
              onClick={() => void invoke("refresh")} style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: "36px", height: "36px", borderRadius: "999px", "--zgui-corner-shape": "none",
                backgroundColor: containerHigh, color: onSurface,
              }}>
              <vector ariaHidden viewBox="0 0 24 24"
                d={"M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4\nM4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4"}
                style={{
                  width: "18px",
                  height: "18px",
                  "--zgui-fill": "transparent",
                  "--zgui-stroke": onSurface,
                  "--zgui-stroke-width": "2px",
                  "--zgui-stroke-linecap": "round",
                  "--zgui-stroke-linejoin": "round",
                }} />
            </Button>
            <Button testId="niri-overview-close" ariaLabel="Close overview" ref={node => focus(node)}
              onClick={close} style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: "36px", height: "36px", borderRadius: "999px", "--zgui-corner-shape": "none",
                backgroundColor: containerHigh, color: onSurface,
              }}>
              <vector ariaHidden viewBox="0 0 24 24"
                d={"M18 6l-12 12\nM6 6l12 12"}
                style={{
                  width: "18px",
                  height: "18px",
                  "--zgui-fill": "transparent",
                  "--zgui-stroke": onSurface,
                  "--zgui-stroke-width": "2px",
                  "--zgui-stroke-linecap": "round",
                  "--zgui-stroke-linejoin": "round",
                }} />
            </Button>
          </row>
        </row>
        <Show when={commandError()} fallback={<box style={{ display: "none" }} />}>
          {message => <text role="alert" style={{ color: "var(--color-error)" }}>{message()}</text>}
        </Show>
        <Show when={workspaceRows().length > 0} fallback={
          <box style={{
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
            width: "100%", height: "158px", borderRadius: "16px", gap: "6px", backgroundColor: containerHigh,
          }}>
            <text style={{ fontSize: "12px", lineHeight: "16px", color: outline }}>No workspaces available</text>
          </box>
        }>
          <scroll style={{ width: "100%", maxHeight: "520px", overflow: "hidden auto" }}>
            <column style={{ gap: "16px", width: "100%" }}>
              <For each={workspaceRows()} keyed={row => row.key}>
                {row => (
                  <row style={{ gap: "16px", width: "100%" }}>
                    <For each={row().items} keyed={ws => ws.workspaceId}>
                      {ws => <WorkspaceCard workspace={ws()} close={close} />}
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
