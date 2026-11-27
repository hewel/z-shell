import { Show, TextField, createEffect, createSignal, cx, type NativeChild } from "@hewel/zgui";
import { M3Button, M3Switch } from "@z-shell/sdk/primitives";
import { useTopic, type PluginSettingsProps } from "@z-shell/sdk/zgui";
import type { BridgeTargetStatus, ThemeBridgesStatus } from "./service.ts";
import styles from "./settings-page.module.css";

function BridgeTargetCard(props: {
  readonly name: string;
  readonly testId: string;
  readonly enabled: boolean;
  readonly pathValue: string;
  readonly pathPlaceholder: string;
  readonly status?: BridgeTargetStatus | undefined;
  readonly onToggle: () => void;
  readonly onPathChange: (next: string) => void;
  readonly onPathSave: () => void;
}): NativeChild {
  const [pathFocused, setPathFocused] = createSignal(false);
  const state = () => props.status?.state ?? (props.enabled ? "pending" : "disabled");
  const failed = () => state() === "conflict" || state() === "error";
  const applied = () => state() === "applied";

  return (
    <column class={styles.targetCard}>
      <row class={styles.targetHeader}>
        <text class={styles.targetName}>{props.name}</text>
        <row class={styles.targetControls}>
          <text
            testId={props.testId}
            class={styles.statusBadge}
            data-state={failed() ? "failed" : applied() ? "applied" : null}
          >
            {state()}
          </text>
          <M3Switch
            ariaLabel={`Enable ${props.name} bridge`}
            checked={props.enabled}
            onToggle={props.onToggle}
          />
        </row>
      </row>
      <text class={styles.targetPath}>
        {props.status?.target ?? "No target configured"}
      </text>
      <row
        data-composite-input="true"
        data-focused={pathFocused() ? "true" : null}
        class={styles.compositeInput}
      >
        <TextField
          class={cx("shell-composite-field", styles.pathInput)}
          ariaLabel={`${props.name} path`}
          placeholder={props.pathPlaceholder}
          value={props.pathValue}
          onFocus={() => setPathFocused(true)}
          onBlur={() => setPathFocused(false)}
          onInput={ev => props.onPathChange(ev.value)}
        />
        <M3Button variant="neutral-tonal" size="sm" onClick={props.onPathSave} class={styles.saveBtn}>
          <text>Save</text>
        </M3Button>
      </row>
      <Show when={props.status?.message} fallback={<box class={styles.hidden} />}>
        {message => <text class={styles.statusMessage}>{message()}</text>}
      </Show>
    </column>
  );
}

export default function ThemeBridgesSettingsPage(props: PluginSettingsProps): NativeChild {
  const { data: status } = useTopic<ThemeBridgesStatus>(() => props.client(), "plugin.z-shell.theme-bridges.status");
  const [commandError, setCommandError] = createSignal<string>();
  const [enableShoji, setEnableShoji] = createSignal(false);
  const [enableZen, setEnableZen] = createSignal(false);
  const [shojiSocket, setShojiSocket] = createSignal("");
  const [zenDir, setZenDir] = createSignal("");

  createEffect(() => props.readSettings, reader => {
    if (!reader) return;
    void reader().then(values => {
      if (typeof values.enable_shojiwm === "boolean") setEnableShoji(values.enable_shojiwm);
      if (typeof values.enable_zen_browser === "boolean") setEnableZen(values.enable_zen_browser);
      if (typeof values.shojiwm_socket === "string") setShojiSocket(values.shojiwm_socket);
      if (typeof values.zen_chrome_dir === "string") setZenDir(values.zen_chrome_dir);
    });
  });

  async function invoke(action: "reapply" | "revert"): Promise<void> {
    const client = props.client();
    if (!client) return;
    setCommandError(undefined);
    try {
      await client.invokeCommand(`plugin.z-shell.theme-bridges.${action}`);
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <column testId="plugin-theme-bridges-settings" class={styles.page}>
      <row class={styles.headerCard}>
        <column class={styles.growCol}>
          <text class={styles.cardTitle}>Palette engine & bridge sync</text>
          <text class={styles.headerSubtitle}>
            {`Syncs active z-shell Material 3 palette to enabled external targets`}
          </text>
        </column>
        <row class={styles.headerActions}>
          <M3Button testId="theme-bridges-reapply" variant="accent-tonal" size="sm"
            disabled={!props.client()} onClick={() => void invoke("reapply")}>
            <text>Reapply all</text>
          </M3Button>
          <M3Button testId="theme-bridges-revert" variant="neutral-tonal" size="sm"
            disabled={!props.client()} onClick={() => void invoke("revert")}>
            <text>Revert</text>
          </M3Button>
        </row>
      </row>

      <Show when={commandError()} fallback={<box class={styles.hidden} />}>
        {message => <text role="alert" class={styles.errorText}>{message()}</text>}
      </Show>

      <column class={styles.targetsCard}>
        <text class={styles.cardTitle}>Target bridges</text>
        <row class={styles.targetsRow}>
          <BridgeTargetCard
            name="ShojiWM"
            testId="bridge-shojiwm-state"
            enabled={enableShoji()}
            pathValue={shojiSocket()}
            pathPlaceholder="$XDG_RUNTIME_DIR/shojiwm-wayland-1.sock"
            status={status()?.shojiwm}
            onToggle={() => {
              const next = !enableShoji();
              setEnableShoji(next);
              void props.patchSettings?.({ enable_shojiwm: next });
            }}
            onPathChange={setShojiSocket}
            onPathSave={() => void props.patchSettings?.({ shojiwm_socket: shojiSocket().trim() })}
          />
          <BridgeTargetCard
            name="Zen Browser"
            testId="bridge-zen-state"
            enabled={enableZen()}
            pathValue={zenDir()}
            pathPlaceholder="~/.zen/<profile>/chrome"
            status={status()?.zenBrowser}
            onToggle={() => {
              const next = !enableZen();
              setEnableZen(next);
              void props.patchSettings?.({ enable_zen_browser: next });
            }}
            onPathChange={setZenDir}
            onPathSave={() => void props.patchSettings?.({ zen_chrome_dir: zenDir().trim() })}
          />
        </row>
      </column>
    </column>
  );
}
