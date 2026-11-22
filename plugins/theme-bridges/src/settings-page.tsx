import { Show, TextField, createEffect, createSignal, type NativeChild } from "@hewel/zgui";
import { M3Button, M3Switch } from "@z-shell/sdk/primitives";
import { useTopic, type PluginSettingsProps } from "@z-shell/sdk/zgui";
import type { BridgeTargetStatus, ThemeBridgesStatus } from "./service.ts";

const primary = "var(--color-primary)";
const primaryContainer = "var(--color-primary-container)";
const onPrimaryContainer = "var(--color-on-primary-container)";
const onSurface = "var(--color-on-surface)";
const muted = "var(--color-on-surface-variant)";
const container = "var(--color-surface-container)";
const containerHigh = "var(--color-surface-container-high)";
const containerHighest = "var(--color-surface-container-highest)";
const grow = { flexGrow: 1, flexBasis: "0px", minWidth: "0px" } as const;
const clipped = { minWidth: "0px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } as const;

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
    <column style={{ ...grow, gap: "8px", padding: "12px", borderRadius: "14px", backgroundColor: container }}>
      <row style={{ alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
        <text style={{ fontSize: "13px", fontWeight: 600 }}>{props.name}</text>
        <row style={{ alignItems: "center", gap: "6px", flexShrink: 0 }}>
          <text testId={props.testId} style={{
            padding: "2px 8px", borderRadius: "999px", fontSize: "11px", fontWeight: 600,
            backgroundColor: failed() ? "var(--color-error-container)"
              : applied() ? primaryContainer : containerHighest,
            color: failed() ? "var(--color-on-error-container)"
              : applied() ? onPrimaryContainer : muted,
          }}>{state()}</text>
          <M3Switch
            ariaLabel={`Enable ${props.name} bridge`}
            checked={props.enabled}
            onToggle={props.onToggle}
          />
        </row>
      </row>
      <text style={{ ...clipped, fontFamily: "var(--font-mono)", fontSize: "11px", color: muted }}>
        {props.status?.target ?? "No target configured"}
      </text>
      <row data-composite-input="true" style={{
        gap: "4px", alignItems: "center", height: "34px", borderRadius: "8px", padding: "2px 3px 2px 8px",
        backgroundColor: containerHigh,
        border: pathFocused()
          ? `2px solid ${primary}`
          : "1px solid color-mix(in srgb, var(--color-outline-variant) 55%, transparent)",
      }}>
        <TextField class="shell-composite-field" ariaLabel={`${props.name} path`} placeholder={props.pathPlaceholder} value={props.pathValue}
          onFocus={() => setPathFocused(true)} onBlur={() => setPathFocused(false)}
          onInput={ev => props.onPathChange(ev.value)} style={{
            ...grow, height: "28px", padding: "2px",
            backgroundColor: "transparent", color: onSurface, fontFamily: "var(--font-mono)", fontSize: "11px",
          }} />
        <M3Button variant="neutral-tonal" size="sm" onClick={props.onPathSave} style={{ height: "26px" }}>
          <text>Save</text>
        </M3Button>
      </row>
      <Show when={props.status?.message} fallback={<box style={{ display: "none" }} />}>
        {message => <text style={{ fontSize: "11px", color: muted }}>{message()}</text>}
      </Show>
    </column>
  );
}

export default function ThemeBridgesSettingsPage(props: PluginSettingsProps): NativeChild {
  const { data: status } = useTopic<ThemeBridgesStatus>(props.client, "plugin.z-shell.theme-bridges.status");
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
    <column testId="plugin-theme-bridges-settings" style={{ gap: "12px", width: "100%", color: onSurface, fontFamily: "var(--font-sans)" }}>
      <row style={{
        alignItems: "center", justifyContent: "space-between", gap: "10px",
        borderRadius: "16px", backgroundColor: containerHigh, padding: "14px",
      }}>
        <column style={{ ...grow, gap: "2px" }}>
          <text style={{ fontSize: "13px", fontWeight: 600 }}>Palette engine & bridge sync</text>
          <text style={{ ...clipped, fontFamily: "var(--font-mono)", fontSize: "11px", color: muted }}>
            {`Syncs active z-shell Material 3 palette to enabled external targets`}
          </text>
        </column>
        <row style={{ gap: "6px", flexShrink: 0 }}>
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

      <Show when={commandError()} fallback={<box style={{ display: "none" }} />}>
        {message => <text role="alert" style={{ color: "var(--color-error)", fontSize: "12px" }}>{message()}</text>}
      </Show>

      <column style={{ borderRadius: "16px", backgroundColor: containerHigh, padding: "14px", gap: "10px" }}>
        <text style={{ fontSize: "13px", fontWeight: 600 }}>Target bridges</text>
        <row style={{ gap: "10px", width: "100%" }}>
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
