import { Button, For, Show, createEffect, createSignal, type NativeChild } from "@hewel/zgui";
import { M3Button, M3Slider } from "@z-shell/sdk/primitives";
import { useTopic, type PluginSettingsProps } from "@z-shell/sdk/zgui";
import type { NiriOverviewSnapshot } from "./service.ts";
import styles from "./settings-page.module.css";

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
    <column testId="plugin-niri-overview-settings" class={styles.page}>
      <row class={styles.headerCard}>
        <column class={styles.growCol}>
          <text class={styles.cardTitle}>Compositor IPC bridge</text>
          <text class={styles.ipcPath}>
            {`$NIRI_SOCKET · ${snapshot()?.layouts.length ?? 0} workspaces indexed`}
          </text>
        </column>
        <row class={styles.headerControls}>
          <row class={styles.statusPill} data-connected={connected() ? "true" : null}>
            <box ariaHidden class={styles.statusDot} data-connected={connected() ? "true" : null} />
            <text>{statusLabel()}</text>
          </row>
          <M3Button
            testId="niri-settings-refresh"
            variant="neutral-tonal"
            size="sm"
            onClick={() => void props.client()?.invokeCommand("plugin.z-shell.niri-overview.refresh").catch(() => undefined)}
          >
            <text>Refresh</text>
          </M3Button>
        </row>
      </row>

      <column class={styles.settingsCard}>
        <text class={styles.cardTitle}>Grid & visual layout</text>

        <column class={styles.zoomSection}>
          <row class={styles.rowBetween}>
            <text class={styles.settingLabel}>Workspace zoom scale</text>
            <text data-tabular="true" class={styles.zoomReadout}>
              {`${Math.round(zoomScale() * 100)}%`}
            </text>
          </row>
          <M3Slider
            label="Workspace zoom scale"
            value={Math.round(((zoomScale() - 0.25) / 0.75) * 100)}
            step={5}
            onChange={pct => {
              const next = Math.max(0.25, Math.min(1.0, Math.round((0.25 + (pct / 100) * 0.75) * 20) / 20));
              setZoomScale(next);
              void save({ zoom_scale: next }, `Zoom set to ${Math.round(next * 100)}%`);
            }}
          />
          <row class={styles.zoomPresetsRow}>
            <For each={ZOOM_PRESETS} keyed={v => v}>
              {preset => {
                const active = () => Math.abs(zoomScale() - preset()) < 0.01;
                return (
                  <Button
                    selected={active()}
                    data-active={active() ? "true" : null}
                    onClick={() => { setZoomScale(preset()); void save({ zoom_scale: preset() }, `Zoom set to ${Math.round(preset() * 100)}%`); }}
                    class={styles.zoomPresetBtn}
                  >
                    <text>{`${Math.round(preset() * 100)}%`}</text>
                  </Button>
                );
              }}
            </For>
          </row>
        </column>

        <box ariaHidden class={styles.divider} />

        <row class={styles.rowBetweenGap}>
          <text class={styles.settingLabel}>IPC queue depth</text>
          <row class={styles.queuePresetsRow}>
            <For each={QUEUE_PRESETS} keyed={depth => depth}>
              {depth => {
                const active = () => queueDepth() === depth();
                return (
                  <Button
                    selected={active()}
                    data-active={active() ? "true" : null}
                    onClick={() => { setQueueDepth(depth()); void save({ max_queue_depth: depth() }, `Queue depth set to ${depth()}`); }}
                    class={styles.queuePresetBtn}
                  >
                    <text>{`${depth()}`}</text>
                  </Button>
                );
              }}
            </For>
          </row>
        </row>

        <Show when={savedNotice()}>
          {notice => <text class={styles.savedNotice}>{notice()}</text>}
        </Show>
      </column>
    </column>
  );
}
