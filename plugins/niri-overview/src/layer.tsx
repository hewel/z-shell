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
            <vector ariaHidden viewBox="0 0 24 24" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"
              style={{ width: "24px", height: "24px", "--zgui-fill": outline }} />
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
          boxShadow: "0 20px 56px rgba(0, 0, 0, 0.60)",
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
              d="M4 5a1 1 0 011-1h5a1 1 0 011 1v5a1 1 0 01-1 1H5a1 1 0 01-1-1V5zm9 0a1 1 0 011-1h5a1 1 0 011 1v5a1 1 0 01-1 1h-5a1 1 0 01-1-1V5zM4 14a1 1 0 011-1h5a1 1 0 011 1v5a1 1 0 01-1 1H5a1 1 0 01-1-1v-5zm9 0a1 1 0 011-1h5a1 1 0 011 1v5a1 1 0 01-1 1h-5a1 1 0 01-1-1v-5z"
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
                width: "36px", height: "36px", borderRadius: "999px",
                backgroundColor: containerHigh, color: onSurface,
              }}>
              <vector ariaHidden viewBox="0 0 24 24"
                d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"
                style={{ width: "18px", height: "18px", "--zgui-fill": onSurface }} />
            </Button>
            <Button testId="niri-overview-close" ariaLabel="Close overview" ref={node => focus(node)}
              onClick={close} style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: "36px", height: "36px", borderRadius: "999px",
                backgroundColor: containerHigh, color: onSurface,
              }}>
              <vector ariaHidden viewBox="0 0 24 24"
                d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"
                style={{ width: "18px", height: "18px", "--zgui-fill": onSurface }} />
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
