import { Button, For, Show, createEffect, createSignal, focus, getWindowRect, type NativeChild } from "@hewel/zgui";
import { useTopic, type PluginSettingsProps } from "@z-shell/sdk/zgui";
import type { NiriOverviewSnapshot } from "./service.ts";

const primary = "var(--color-primary)";
const primaryContainer = "var(--color-primary-container)";
const onPrimaryContainer = "var(--color-on-primary-container)";
const onSurface = "var(--color-on-surface)";
const muted = "var(--color-on-surface-variant)";
const container = "var(--color-surface-container)";
const containerHigh = "var(--color-surface-container-high)";
const containerHighest = "var(--color-surface-container-highest)";
const grow = { flexGrow: 1, flexBasis: "0px", minWidth: "0px" } as const;

const ZOOM_PRESETS = [0.25, 0.35, 0.5, 0.72, 0.85, 1.0] as const;
const QUEUE_PRESETS = [16, 32, 64, 128] as const;

export default function NiriOverviewSettingsPage(props: PluginSettingsProps): NativeChild {
  const { data: snapshot } = useTopic<NiriOverviewSnapshot>(props.client, "plugin.z-shell.niri-overview.state");
  const [zoomScale, setZoomScale] = createSignal(0.5);
  const [queueDepth, setQueueDepth] = createSignal(64);
  const [savedNotice, setSavedNotice] = createSignal<string | null>(null);

  createEffect(() => props.readSettings, reader => {
    if (!reader) return;
    void reader().then(values => {
      if (typeof values.zoom_scale === "number") setZoomScale(values.zoom_scale);
      if (typeof values.max_queue_depth === "number") setQueueDepth(values.max_queue_depth);
    });
  });

  async function save(patch: Record<string, unknown>, label: string): Promise<void> {
    if (!props.patchSettings) return;
    const committed = await props.patchSettings(patch);
    if (committed) setSavedNotice(label);
  }

  const connected = () => snapshot()?.capability === "available";
  const statusLabel = () => {
    const cap = snapshot()?.capability;
    if (cap === "available") return "Connected";
    if (cap === "unsupported") return "Unsupported";
    return "Disconnected";
  };

  return (
    <column testId="plugin-niri-overview-settings" style={{ gap: "12px", width: "100%", color: onSurface, fontFamily: "var(--font-sans)" }}>
      <row style={{
        alignItems: "center", justifyContent: "space-between", gap: "10px",
        borderRadius: "16px", backgroundColor: containerHigh, padding: "14px",
      }}>
        <column style={{ ...grow, gap: "2px" }}>
          <text style={{ fontSize: "13px", fontWeight: 600 }}>Compositor IPC bridge</text>
          <text style={{ fontFamily: "var(--font-mono)", fontSize: "11px", color: muted }}>
            {`$NIRI_SOCKET · ${snapshot()?.layouts.length ?? 0} workspaces indexed`}
          </text>
        </column>
        <row style={{ alignItems: "center", gap: "6px", flexShrink: 0 }}>
          <row style={{
            alignItems: "center", gap: "5px", padding: "4px 10px", borderRadius: "999px",
            backgroundColor: connected() ? primaryContainer : containerHighest,
            color: connected() ? onPrimaryContainer : muted, fontSize: "11px", fontWeight: 600,
          }}>
            <box ariaHidden style={{ width: "6px", height: "6px", borderRadius: "3px", backgroundColor: connected() ? primary : muted }} />
            <text>{statusLabel()}</text>
          </row>
          <Button testId="niri-settings-refresh"
            onClick={() => void props.client()?.invokeCommand("plugin.z-shell.niri-overview.refresh").catch(() => undefined)}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center", minHeight: "28px",
              padding: "4px 10px", borderRadius: "8px", backgroundColor: containerHighest, color: onSurface,
              fontSize: "12px", fontWeight: 500,
            }}>
            <text>Refresh</text>
          </Button>
        </row>
      </row>

      <column style={{ borderRadius: "16px", backgroundColor: containerHigh, padding: "14px", gap: "12px" }}>
        <text style={{ fontSize: "13px", fontWeight: 600 }}>Grid & visual layout</text>

        <column style={{ gap: "8px" }}>
          <row style={{ alignItems: "center", justifyContent: "space-between" }}>
            <text style={{ fontSize: "12px", fontWeight: 500 }}>Workspace zoom scale</text>
            <text data-tabular="true" style={{ fontFamily: "var(--font-mono)", fontSize: "12px", color: primary, fontVariantNumeric: "tabular-nums" }}>
              {`${Math.round(zoomScale() * 100)}%`}
            </text>
          </row>
          <box role="slider" tabIndex={0} ariaLabel="Workspace zoom scale" ariaValueMin={25} ariaValueMax={100}
            ariaValueNow={Math.round(zoomScale() * 100)} ariaValueStep={5}
            onPointerDown={event => {
              if (!event.primary) return;
              const rect = getWindowRect(event.currentTarget);
              if (!rect || rect.width <= 0) return;
              focus(event.currentTarget);
              const ratio = Math.max(0, Math.min(1, (event.position.x - rect.x) / rect.width));
              const next = Math.round((0.25 + ratio * 0.75) * 20) / 20;
              setZoomScale(next);
              void save({ zoom_scale: next }, `Zoom set to ${Math.round(next * 100)}%`);
            }}
            onKeyDown={event => {
              const step = event.key === "ArrowRight" || event.key === "ArrowUp" ? 0.05
                : event.key === "ArrowLeft" || event.key === "ArrowDown" ? -0.05 : 0;
              if (!step) return;
              event.preventDefault();
              const next = Math.max(0.25, Math.min(1.0, Math.round((zoomScale() + step) * 20) / 20));
              setZoomScale(next);
              void save({ zoom_scale: next }, `Zoom set to ${Math.round(next * 100)}%`);
            }}
            style={{ width: "100%", height: "24px", display: "flex", alignItems: "center", position: "relative" }}>
            <box ariaHidden style={{ width: "100%", height: "6px", borderRadius: "3px", backgroundColor: containerHighest, overflow: "hidden" }}>
              <box data-percent-fill="true" style={{
                width: `${(((zoomScale() - 0.25) / 0.75) * 100).toFixed(1)}%`, height: "100%", borderRadius: "3px", backgroundColor: primary,
              }} />
            </box>
            <box ariaHidden style={{
              position: "absolute", left: `${Math.max(0, Math.min(94, ((zoomScale() - 0.25) / 0.75) * 100 - 3)).toFixed(1)}%`,
              width: "14px", height: "14px", borderRadius: "999px", backgroundColor: primary, border: `2px solid ${containerHigh}`,
            }} />
          </box>
          <row style={{ gap: "6px" }}>
            <For each={ZOOM_PRESETS} keyed={v => v}>
              {preset => {
                const active = () => Math.abs(zoomScale() - preset()) < 0.01;
                return (
                  <Button selected={active()} onClick={() => { setZoomScale(preset()); void save({ zoom_scale: preset() }, `Zoom set to ${Math.round(preset() * 100)}%`); }}
                    style={{
                      ...grow, display: "flex", height: "30px", borderRadius: "8px", alignItems: "center", justifyContent: "center",
                      backgroundColor: active() ? primaryContainer : container,
                      color: active() ? onPrimaryContainer : muted,
                      fontFamily: "var(--font-mono)", fontSize: "11px", fontWeight: active() ? 600 : 500,
                    }}>
                    <text>{`${Math.round(preset() * 100)}%`}</text>
                  </Button>
                );
              }}
            </For>
          </row>
        </column>

        <box ariaHidden style={{ width: "100%", height: "1px", backgroundColor: "color-mix(in srgb, var(--color-outline-variant) 45%, transparent)" }} />

        <row style={{ alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
          <text style={{ fontSize: "12px", fontWeight: 500 }}>IPC queue depth</text>
          <row style={{ gap: "4px" }}>
            <For each={QUEUE_PRESETS} keyed={depth => depth}>
              {depth => {
                const active = () => queueDepth() === depth();
                return (
                  <Button selected={active()} onClick={() => { setQueueDepth(depth()); void save({ max_queue_depth: depth() }, `Queue depth set to ${depth()}`); }}
                    style={{
                      display: "flex", minHeight: "26px", padding: "2px 10px", borderRadius: "8px", alignItems: "center", justifyContent: "center",
                      backgroundColor: active() ? primaryContainer : container,
                      color: active() ? onPrimaryContainer : muted,
                      fontFamily: "var(--font-mono)", fontSize: "11px", fontWeight: 500,
                    }}>
                    <text>{`${depth()}`}</text>
                  </Button>
                );
              }}
            </For>
          </row>
        </row>

        <Show when={savedNotice()}>
          {notice => <text style={{ fontSize: "11px", color: primary }}>{notice()}</text>}
        </Show>
      </column>
    </column>
  );
}
