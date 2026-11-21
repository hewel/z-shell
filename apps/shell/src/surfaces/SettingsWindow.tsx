import {
  Button, For, Image, Match, Show, Switch, TextField, WindowSurface,
  createEffect, createMemo, createSignal, flush,
  type Accessor, type NativeChild,
} from "@hewel/zgui";
import { useDaemonMedia } from "@z-shell/sdk/zgui";
import { ShellIcon, type ShellIconName } from "../icons.tsx";
import { createEnterProgress, createOpacityEnter, useMotionScheme } from "../motion.ts";
import { SystemTelemetryCards } from "../panels/BatteryPanel.tsx";
import { PrecisionSliderRow } from "../panels/QuickSettingsPanel.tsx";
import { useShellStore } from "../store.ts";
import { THEME_SEED_SWATCHES, useShellTheme } from "../theme.ts";
import {
  resolveMonitorWallpaper,
  type BarPosition,
  type BarStyle,
  type CatalogEntry,
  type IdleAction,
  type MotionScheme,
  type WallpaperListResponse,
} from "../topics.ts";

const primary = "var(--color-primary)";
const onPrimary = "var(--color-on-primary)";
const primaryContainer = "var(--color-primary-container)";
const onPrimaryContainer = "var(--color-on-primary-container)";
const onSurface = "var(--color-on-surface)";
const muted = "var(--color-on-surface-variant)";
const outline = "var(--color-outline)";
const surface = "var(--color-surface)";
const container = "var(--color-surface-container)";
const containerHigh = "var(--color-surface-container-high)";
const containerHighest = "var(--color-surface-container-highest)";
const grow = { flexGrow: 1, flexBasis: "0px", minWidth: "0px" } as const;
const clipped = { minWidth: "0px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } as const;
const hiddenSection = { display: "none" } as const;

type ShellNavTab = {
  readonly id: "appearance" | "bar" | "idle" | "power";
  readonly label: string;
  readonly subtitle: string;
  readonly icon: ShellIconName;
};

const SHELL_NAV_TABS: readonly ShellNavTab[] = [
  { id: "appearance", label: "Appearance", subtitle: "Dynamic Material 3 HCT palette & motion physics synced to settings.toml", icon: "palette" },
  { id: "bar", label: "Bar & layout", subtitle: "Wayland layer-shell edge strut, spacing rhythm, and visible modules", icon: "overview" },
  { id: "idle", label: "Idle & sleep", subtitle: "Automatic actions pause while media is playing · Declarative rules", icon: "sleep" },
  { id: "power", label: "Power & battery", subtitle: "UPower telemetry, power-profiles-daemon switching, and system load", icon: "batteryCharging" },
];

const VARIANTS = [
  { id: "tonal", label: "Tonal" },
  { id: "vibrant", label: "Vibrant" },
  { id: "expressive", label: "Expressive" },
  { id: "fidelity", label: "Fidelity" },
  { id: "neutral", label: "Neutral" },
  { id: "mono", label: "Mono" },
] as const;

const THEME_MODES = [
  { id: "light", label: "Light" },
  { id: "auto", label: "Auto" },
  { id: "dark", label: "Dark" },
] as const;

const MOTION_SCHEMES: readonly { readonly id: MotionScheme; readonly label: string }[] = [
  { id: "standard", label: "Standard" },
  { id: "expressive", label: "Expressive" },
  { id: "reduced", label: "Reduced" },
];

const BAR_STYLES: readonly { readonly id: BarStyle; readonly label: string }[] = [
  { id: "floating", label: "Floating" },
  { id: "docked", label: "Docked" },
];

const BAR_POSITIONS: readonly { readonly id: BarPosition; readonly label: string }[] = [
  { id: "top", label: "Top" },
  { id: "left", label: "Left" },
  { id: "right", label: "Right" },
];

const GAP_PRESETS = [0, 8, 14, 20] as const;

const IDLE_ACTIONS = {
  lock: "Lock",
  screen_off: "Screen off",
  suspend: "Suspend",
  lock_and_suspend: "Lock + sleep",
} as const;

const IDLE_ACTION_KINDS = [
  { id: "lock", label: "Lock" },
  { id: "screen_off", label: "Screen off" },
  { id: "suspend", label: "Suspend" },
  { id: "lock_and_suspend", label: "Lock + sleep" },
  { id: "custom_command", label: "Command" },
] as const;

const PROFILE_META: Readonly<Record<string, { readonly label: string; readonly detail: string; readonly icon: ShellIconName }>> = {
  performance: { label: "Performance", detail: "Max boost clocks", icon: "cpu" },
  balanced: { label: "Balanced", detail: "Recommended", icon: "battery" },
  "power-saver": { label: "Power saver", detail: "Quiet & cool", icon: "batteryCharging" },
};

function SettingsSwitch(props: {
  label: string;
  detail?: string;
  checked: boolean;
  disabled?: boolean;
  testId?: string;
  onToggle: () => void;
}): NativeChild {
  return (
    <row style={{
      ...grow, alignItems: "center", justifyContent: "space-between", gap: "10px",
      padding: "10px 12px", borderRadius: "14px", backgroundColor: container,
    }}>
      <column style={{ ...grow, gap: "1px" }}>
        <text style={{ ...clipped, fontSize: "12px", fontWeight: 500 }}>{props.label}</text>
        <Show when={props.detail} fallback={<box style={hiddenSection} />}>
          <text style={{ ...clipped, fontSize: "11px", color: muted }}>{props.detail}</text>
        </Show>
      </column>
      <Button testId={props.testId ?? null} data-switch-root="true"
        ariaLabel={props.label} checked={props.checked} disabled={props.disabled ?? false}
        onClick={props.onToggle} style={{
          display: "flex", width: "42px", height: "24px", borderRadius: "999px", padding: "3px", flexShrink: 0,
          alignItems: "center", justifyContent: props.checked ? "flex-end" : "flex-start",
          backgroundColor: props.checked ? primary : containerHighest,
          opacity: props.disabled ? 0.45 : 1,
        }}>
        <box ariaHidden data-switch-thumb="true" style={{
          width: "18px", height: "18px", borderRadius: "999px",
          backgroundColor: props.checked ? onPrimary : muted,
        }} />
      </Button>
    </row>
  );
}

function WallpaperCardTile(props: { item: Accessor<CatalogEntry>; active: boolean; onClick: () => void }): NativeChild {
  const { hostClient } = useShellStore();
  const image = useDaemonMedia(hostClient, () => props.item().thumbnail, { fetchCommand: "wallpaper.fetch-blob" });
  return (
    <Button testId={`settings-wp-${props.item().id}`} ariaLabel={props.item().name} selected={props.active}
      onClick={props.onClick} style={{
        ...grow, display: "flex", height: "82px", borderRadius: "10px", position: "relative", overflow: "hidden",
        alignItems: "center", justifyContent: "center", backgroundColor: containerHighest,
        border: props.active ? `2px solid ${primary}` : "1px solid color-mix(in srgb, var(--color-outline-variant) 45%, transparent)",
      }}>
      <Show when={image.src()} fallback={<ShellIcon name="image" size={20} color={muted} />}>
        {src => <Image ariaHidden src={src()} style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
      </Show>
      <Show when={props.active}>
        <box ariaHidden style={{
          position: "absolute", right: "6px", bottom: "6px", width: "18px", height: "18px", borderRadius: "999px",
          display: "flex", alignItems: "center", justifyContent: "center", backgroundColor: primary,
        }}>
          <ShellIcon name="check" size={11} color={onPrimary} />
        </box>
      </Show>
    </Button>
  );
}

function AppearancePane(): NativeChild {
  const { publicClient, hostClient, monitors, wallpaper, theme, settings, invokePublic, invokeHost } = useShellStore();
  const [catalog, setCatalog] = createSignal<WallpaperListResponse>();
  const [scanRevision, setScanRevision] = createSignal(0);
  const [outputIndex, setOutputIndex] = createSignal(0);

  const outputChoices = createMemo(() => [null, ...monitors().map(monitor => monitor.name)] as const);
  const selectedOutput = () => outputChoices()[outputIndex() % outputChoices().length] ?? null;
  const activeWallpaper = () => {
    const name = selectedOutput();
    const snapshot = wallpaper.data();
    return name === null ? snapshot?.current : resolveMonitorWallpaper(snapshot, name);
  };

  createEffect(() => [publicClient(), scanRevision(), wallpaper.data()?.available, wallpaper.data()?.catalog_count] as const, ([client]) => {
    if (!client) return;
    let live = true;
    void invokePublic("wallpaper.list", { offset: 0, limit: 16 }).then(result => {
      if (!live) return;
      const data = result?.data as WallpaperListResponse | undefined;
      if (data) setCatalog(data);
    });
    return () => { live = false; };
  });

  function patchTheme(patch: Record<string, unknown>, runtimeFallback?: Record<string, unknown>): void {
    if (hostClient()) {
      void invokeHost("settings.patch", { theme: patch });
    } else if (runtimeFallback) {
      void invokePublic("theme.set", runtimeFallback);
    }
  }

  const visibleItems = () => catalog()?.items.slice(0, 7) ?? [];
  const remainingCount = () => Math.max(0, (catalog()?.total ?? wallpaper.data()?.catalog_count ?? 0) - visibleItems().length);
  const activeFileName = () => {
    const path = activeWallpaper()?.source_path;
    if (!path) return "No wallpaper";
    const slash = path.lastIndexOf("/");
    return slash >= 0 ? path.slice(slash + 1) : path;
  };
  const currentMode = () => settings.data()?.theme.mode ?? (theme.data()?.dark === false ? "light" : "dark");
  const currentVariant = () => theme.data()?.variant ?? settings.data()?.theme.variant ?? "tonal";
  const currentMotion = (): MotionScheme => settings.data()?.theme.motion_scheme ?? "standard";

  return (
    <column testId="settings-appearance-pane" style={{ gap: "12px", width: "100%" }}>
      <column style={{ borderRadius: "16px", backgroundColor: containerHigh, padding: "14px", gap: "10px" }}>
        <row style={{ alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
          <row style={{ alignItems: "baseline", gap: "8px", minWidth: "0px" }}>
            <text style={{ fontSize: "13px", fontWeight: 600 }}>Wallpaper</text>
            <text style={{ ...clipped, fontFamily: "var(--font-mono)", fontSize: "11px", color: muted }}>
              {`${activeFileName()} · ${wallpaper.data()?.catalog_count ?? 0} files`}
            </text>
          </row>
          <row style={{ gap: "6px", flexShrink: 0 }}>
            <Button ariaLabel="Cycle target output" onClick={() => setOutputIndex(index => index + 1)} style={{
              display: "flex", alignItems: "center", justifyContent: "center", minHeight: "26px",
              padding: "4px 10px", borderRadius: "8px", backgroundColor: containerHighest, color: muted, fontSize: "11px", fontWeight: 500,
            }}>
              <text>{selectedOutput() ? `Output (${selectedOutput()})` : `All outputs (${monitors()[0]?.name ?? "default"})`}</text>
            </Button>
            <Button testId="settings-wp-rescan" onClick={() => {
              void invokePublic("wallpaper.rescan", {}).then(result => { if (result) setScanRevision(revision => revision + 1); });
            }} style={{
              display: "flex", alignItems: "center", justifyContent: "center", minHeight: "26px",
              padding: "4px 10px", borderRadius: "8px", backgroundColor: containerHighest, color: onSurface, fontSize: "11px", fontWeight: 500,
            }}>
              <text>Rescan</text>
            </Button>
          </row>
        </row>
        <row style={{ gap: "10px", width: "100%" }}>
          <For each={visibleItems().slice(0, 4)} keyed={item => item.id} fallback={
            <text style={{ fontSize: "12px", color: muted }}>No wallpapers indexed</text>
          }>
            {item => (
              <WallpaperCardTile item={item} active={item().source_path === activeWallpaper()?.source_path}
                onClick={() => void invokePublic("wallpaper.set", { path: item().source_path, output: selectedOutput(), fit: wallpaper.data()?.fit ?? "cover" })} />
            )}
          </For>
        </row>
        <Show when={visibleItems().length > 4 || remainingCount() > 0}>
          <row style={{ gap: "10px", width: "100%" }}>
            <For each={visibleItems().slice(4, 7)} keyed={item => item.id}>
              {item => (
                <WallpaperCardTile item={item} active={item().source_path === activeWallpaper()?.source_path}
                  onClick={() => void invokePublic("wallpaper.set", { path: item().source_path, output: selectedOutput(), fit: wallpaper.data()?.fit ?? "cover" })} />
              )}
            </For>
            <Button onClick={() => void invokePublic("wallpaper.random", { output: selectedOutput() })} style={{
              ...grow, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "4px",
              height: "82px", borderRadius: "10px", backgroundColor: containerHighest,
              border: "1px dashed var(--color-outline-variant)", color: onSurface,
            }}>
              <text style={{ fontSize: "12px", fontWeight: 600 }}>{remainingCount() > 0 ? `+${remainingCount()} more` : "Random"}</text>
              <text style={{ fontSize: "11px", color: muted }}>Pick wallpaper</text>
            </Button>
          </row>
        </Show>
      </column>

      <row style={{ gap: "12px", width: "100%" }}>
        <column style={{ ...grow, borderRadius: "16px", backgroundColor: containerHigh, padding: "14px", gap: "10px" }}>
          <row style={{ alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
            <text style={{ fontSize: "13px", fontWeight: 600 }}>Color seed</text>
            <Button onClick={() => {
              if (settings.data()?.theme.seed_color) patchTheme({ seed_color: null });
              else void invokePublic("theme.retry", {});
            }} style={{
              display: "flex", alignItems: "center", justifyContent: "center", minHeight: "26px",
              padding: "4px 10px", borderRadius: "8px", backgroundColor: primaryContainer, color: onPrimaryContainer,
              fontSize: "11px", fontWeight: 500,
            }}>
              <text>{settings.data()?.theme.seed_color ? "Use wallpaper" : (wallpaper.data()?.sync_theme ? "Sync wallpaper" : "Manual seed")}</text>
            </Button>
          </row>
          <row style={{ alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
            <For each={THEME_SEED_SWATCHES} keyed={seed => seed}>
              {seed => {
                const selected = () => settings.data()?.theme.seed_color?.toUpperCase() === seed().toUpperCase();
                return (
                  <Button ariaLabel={`Set seed color ${seed()}`} onClick={() => patchTheme({ seed_color: seed() }, { seed: seed() })}
                    style={{
                      width: "24px", height: "24px", borderRadius: "999px", flexShrink: 0,
                      backgroundColor: seed(),
                      border: selected() ? "2px solid var(--color-on-surface)" : "2px solid transparent",
                    }} />
                );
              }}
            </For>
          </row>
          <row style={{ borderRadius: "10px", backgroundColor: container, padding: "4px", gap: "4px" }}>
            <For each={THEME_MODES} keyed={item => item.id}>
              {item => {
                const active = () => currentMode() === item().id;
                return (
                  <Button selected={active()} onClick={() => patchTheme({ mode: item().id }, { mode: item().id })} style={{
                    ...grow, display: "flex", height: "28px", borderRadius: "8px", alignItems: "center", justifyContent: "center",
                    backgroundColor: active() ? primaryContainer : "transparent",
                    border: active() ? "1px solid color-mix(in srgb, var(--color-primary) 35%, transparent)" : "1px solid transparent",
                    color: active() ? onPrimaryContainer : muted,
                    fontSize: "12px", fontWeight: active() ? 600 : 500,
                  }}>
                    <text>{item().label}</text>
                  </Button>
                );
              }}
            </For>
          </row>
        </column>

        <column style={{ ...grow, borderRadius: "16px", backgroundColor: containerHigh, padding: "14px", gap: "10px" }}>
          <text style={{ fontSize: "13px", fontWeight: 600 }}>HCT variant</text>
          <column style={{ gap: "6px" }}>
            <For each={[VARIANTS.slice(0, 3), VARIANTS.slice(3, 6)]} keyed={group => group[0]!.id}>
              {group => (
                <row style={{ gap: "6px" }}>
                  <For each={group()} keyed={variant => variant.id}>
                    {variant => {
                      const active = () => currentVariant() === variant().id;
                      return (
                        <Button selected={active()} onClick={() => patchTheme({ variant: variant().id }, { variant: variant().id })} style={{
                          ...grow, display: "flex", height: "32px", borderRadius: "8px", alignItems: "center", justifyContent: "center",
                          backgroundColor: active() ? primaryContainer : container,
                          border: active()
                            ? "1px solid color-mix(in srgb, var(--color-primary) 35%, transparent)"
                            : "1px solid color-mix(in srgb, var(--color-outline-variant) 50%, transparent)",
                          color: active() ? onPrimaryContainer : muted,
                          fontSize: "12px", fontWeight: active() ? 600 : 500,
                        }}>
                          <text>{variant().label}</text>
                        </Button>
                      );
                    }}
                  </For>
                </row>
              )}
            </For>
          </column>
        </column>
      </row>

      <row style={{
        alignItems: "center", justifyContent: "space-between", gap: "12px",
        borderRadius: "14px", backgroundColor: containerHigh, padding: "12px 14px",
      }}>
        <column style={{ ...grow, gap: "2px" }}>
          <text style={{ fontSize: "13px", fontWeight: 600 }}>Motion physics scheme</text>
          <text style={{ ...clipped, fontSize: "11px", color: muted }}>
            M3 spring physics · Reduced honors WCAG
          </text>
        </column>
        <row style={{ borderRadius: "10px", backgroundColor: container, padding: "4px", gap: "4px", width: "260px", flexShrink: 0 }}>
          <For each={MOTION_SCHEMES} keyed={item => item.id}>
            {item => {
              const active = () => currentMotion() === item().id;
              return (
                <Button testId={`settings-motion-${item().id}`} selected={active()}
                  onClick={() => patchTheme({ motion_scheme: item().id })} style={{
                    ...grow, display: "flex", height: "28px", borderRadius: "8px", alignItems: "center", justifyContent: "center",
                    backgroundColor: active() ? primaryContainer : "transparent",
                    border: active() ? "1px solid color-mix(in srgb, var(--color-primary) 35%, transparent)" : "1px solid transparent",
                    color: active() ? onPrimaryContainer : muted,
                    fontSize: "12px", fontWeight: active() ? 600 : 500,
                  }}>
                  <text>{item().label}</text>
                </Button>
              );
            }}
          </For>
        </row>
      </row>

      <row style={{
        alignItems: "center", justifyContent: "space-between", gap: "10px",
        borderRadius: "14px", backgroundColor: containerHigh, padding: "12px 14px",
      }}>
        <column style={{ ...grow, gap: "2px" }}>
          <text style={{ fontSize: "13px", fontWeight: 600 }}>App color bridges</text>
          <text style={{ ...clipped, fontSize: "11px", color: muted }}>
            {`Backend: ${settings.data()?.theme.backend ?? "builtin"} · Changes persist to settings.toml`}
          </text>
        </column>
        <row style={{ gap: "6px", flexShrink: 0 }}>
          <Button testId="settings-backend-toggle"
            onClick={() => {
              const next = settings.data()?.theme.backend === "matugen" ? "builtin" : "matugen";
              patchTheme({ backend: next }, { backend: next });
            }}
            style={{
              display: "flex", alignItems: "center", minHeight: "26px", padding: "4px 10px", borderRadius: "8px",
              backgroundColor: containerHighest, color: onSurface, fontSize: "11px", fontWeight: 500,
            }}>
            <text>{settings.data()?.theme.backend === "matugen" ? "Matugen" : "Built-in"}</text>
          </Button>
          <Button testId="settings-gtk-toggle" selected={settings.data()?.theme.gtk_linking === true}
            onClick={() => patchTheme({ gtk_linking: !settings.data()?.theme.gtk_linking }, { gtk_linking: !settings.data()?.theme.gtk_linking })}
            style={{
              display: "flex", alignItems: "center", minHeight: "26px", padding: "4px 10px", borderRadius: "8px",
              backgroundColor: settings.data()?.theme.gtk_linking ? primaryContainer : containerHighest,
              color: settings.data()?.theme.gtk_linking ? onPrimaryContainer : muted,
              fontSize: "11px", fontWeight: 600,
            }}>
            <text>{settings.data()?.theme.gtk_linking ? "GTK 3/4 · On" : "GTK 3/4 · Off"}</text>
          </Button>
          <Button onClick={() => void invokePublic("theme.retry", {})} style={{
            display: "flex", alignItems: "center", justifyContent: "center", minHeight: "26px",
            padding: "4px 10px", borderRadius: "8px", backgroundColor: containerHighest, color: onSurface, fontSize: "11px", fontWeight: 500,
          }}>
            <text>Reapply</text>
          </Button>
        </row>
      </row>
    </column>
  );
}

function BarLayoutPane(): NativeChild {
  const { settings, outputs, monitors, invokeHost } = useShellStore();
  const bar = () => settings.data()?.bar;
  const style = (): BarStyle => bar()?.style ?? "floating";
  const position = (): BarPosition => bar()?.position ?? "top";
  const gaps = () => bar()?.gaps ?? 14;
  const patchBar = (patch: Record<string, unknown>) => {
    void invokeHost("settings.patch", { bar: patch });
  };
  const primaryOutput = createMemo(() => outputs.data()?.outputs[0]);
  const monitorLabel = createMemo(() => {
    const out = primaryOutput();
    if (out) {
      const hz = out.refresh_mhz ? ` @ ${Math.round(out.refresh_mhz / 1000)}Hz` : "";
      const dims = out.width && out.height ? `${out.width}×${out.height}` : "active";
      return `${out.name ?? "Output"} · ${dims}${hz}`;
    }
    const m = monitors()[0];
    return m ? `${m.name} · ${m.width}×${m.height}` : "No outputs detected";
  });

  return (
    <column testId="settings-bar-pane" style={{ gap: "12px", width: "100%" }}>
      <column style={{ borderRadius: "16px", backgroundColor: containerHigh, padding: "14px", gap: "12px" }}>
        <row style={{ gap: "12px", width: "100%" }}>
          <column style={{ ...grow, gap: "6px" }}>
            <text style={{ fontSize: "12px", fontWeight: 600, color: muted }}>Bar style</text>
            <row style={{ borderRadius: "10px", backgroundColor: container, padding: "4px", gap: "4px" }}>
              <For each={BAR_STYLES} keyed={item => item.id}>
                {item => {
                  const active = () => style() === item().id;
                  return (
                    <Button testId={`settings-bar-style-${item().id}`} selected={active()}
                      onClick={() => patchBar({ style: item().id })} style={{
                        ...grow, display: "flex", height: "28px", borderRadius: "8px", alignItems: "center", justifyContent: "center",
                        backgroundColor: active() ? primaryContainer : "transparent",
                        color: active() ? onPrimaryContainer : muted, fontSize: "12px", fontWeight: active() ? 600 : 500,
                      }}>
                      <text>{item().label}</text>
                    </Button>
                  );
                }}
              </For>
            </row>
          </column>

          <column style={{ ...grow, gap: "6px" }}>
            <text style={{ fontSize: "12px", fontWeight: 600, color: muted }}>Screen edge</text>
            <row style={{ borderRadius: "10px", backgroundColor: container, padding: "4px", gap: "4px" }}>
              <For each={BAR_POSITIONS} keyed={item => item.id}>
                {item => {
                  const active = () => position() === item().id;
                  return (
                    <Button testId={`settings-bar-pos-${item().id}`} selected={active()}
                      onClick={() => patchBar({ position: item().id })} style={{
                        ...grow, display: "flex", height: "28px", borderRadius: "8px", alignItems: "center", justifyContent: "center",
                        backgroundColor: active() ? primaryContainer : "transparent",
                        color: active() ? onPrimaryContainer : muted, fontSize: "12px", fontWeight: active() ? 600 : 500,
                      }}>
                      <text>{item().label}</text>
                    </Button>
                  );
                }}
              </For>
            </row>
          </column>
        </row>

        <box ariaHidden style={{ width: "100%", height: "1px", backgroundColor: "color-mix(in srgb, var(--color-outline-variant) 45%, transparent)" }} />

        <column style={{ gap: "6px" }}>
          <row style={{ alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
            <row style={{ alignItems: "baseline", gap: "8px" }}>
              <text style={{ fontSize: "12px", fontWeight: 600 }}>Tiling gap</text>
              <text data-tabular="true" style={{ fontFamily: "var(--font-mono)", fontSize: "11px", color: primary, fontVariantNumeric: "tabular-nums" }}>
                {gaps()}px
              </text>
            </row>
            <row style={{ gap: "4px" }}>
              <For each={GAP_PRESETS} keyed={v => v}>
                {preset => {
                  const active = () => gaps() === preset();
                  return (
                    <Button selected={active()} onClick={() => patchBar({ gaps: preset() })} style={{
                      display: "flex", minHeight: "24px", padding: "2px 8px", borderRadius: "8px",
                      alignItems: "center", justifyContent: "center",
                      backgroundColor: active() ? primaryContainer : container,
                      color: active() ? onPrimaryContainer : muted,
                      fontFamily: "var(--font-mono)", fontSize: "11px", fontWeight: 500,
                    }}>
                      <text>{preset()}px</text>
                    </Button>
                  );
                }}
              </For>
            </row>
          </row>
          <PrecisionSliderRow
            label="Tiling gap"
            icon="overview"
            value={Math.round((gaps() / 64) * 100)}
            valueLabel={`${gaps()}px`}
            showTrailingSlot={false}
            onChange={pct => patchBar({ gaps: Math.round((pct / 100) * 64) })}
          />
        </column>
      </column>

      <column style={{ borderRadius: "16px", backgroundColor: containerHigh, padding: "14px", gap: "10px" }}>
        <text style={{ fontSize: "13px", fontWeight: 600 }}>Modules & clock</text>
        <row style={{ gap: "8px", width: "100%" }}>
          <SettingsSwitch testId="settings-bar-launcher" label="Launcher button" detail="Show apps trigger in bar"
            checked={bar()?.launcher_enabled !== false}
            onToggle={() => patchBar({ launcher_enabled: !(bar()?.launcher_enabled !== false) })} />
          <SettingsSwitch testId="settings-bar-dock" label="Bottom dock" detail="Auto-hiding pinned app dock"
            checked={bar()?.dock_enabled !== false}
            onToggle={() => patchBar({ dock_enabled: !(bar()?.dock_enabled !== false) })} />
        </row>
        <row style={{ gap: "8px", width: "100%" }}>
          <SettingsSwitch testId="settings-bar-24h" label="24-hour clock" detail="Use 24h time format"
            checked={bar()?.clock_24h !== false}
            onToggle={() => patchBar({ clock_24h: !(bar()?.clock_24h !== false) })} />
          <SettingsSwitch testId="settings-bar-seconds" label="Clock seconds (1Hz)" detail="Off by default to prevent flicker"
            checked={bar()?.clock_seconds === true}
            onToggle={() => patchBar({ clock_seconds: !(bar()?.clock_seconds === true) })} />
        </row>
      </column>

      <row style={{
        alignItems: "center", justifyContent: "space-between", gap: "10px",
        borderRadius: "14px", backgroundColor: containerHigh, padding: "10px 14px",
      }}>
        <row style={{ alignItems: "center", gap: "8px", minWidth: "0px" }}>
          <ShellIcon name="overview" size={16} color={primary} />
          <text style={{ ...clipped, fontFamily: "var(--font-mono)", fontSize: "11px" }}>{monitorLabel()}</text>
        </row>
        <box style={{
          padding: "3px 8px", borderRadius: "8px", backgroundColor: primaryContainer, color: onPrimaryContainer,
          fontSize: "11px", fontWeight: 600, flexShrink: 0,
        }}>
          <text>{`${monitors().length} ${monitors().length === 1 ? "display" : "displays"} · Bar visible`}</text>
        </box>
      </row>
    </column>
  );
}

interface EditableIdleRule {
  name: string;
  enabled: boolean;
  timeout_seconds: number;
  locked_timeout_seconds: number | null;
  action: IdleAction;
  resume_command: readonly string[] | null;
  pre_action_fade_seconds: number;
}

function actionKindOf(action: IdleAction): typeof IDLE_ACTION_KINDS[number]["id"] {
  return typeof action === "string" ? action : "custom_command";
}

function formatRuleDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function IdlePane(): NativeChild {
  const { idle, invokePublic, invokeHost } = useShellStore();
  const caffeine = () => idle.data()?.caffeine ?? false;
  const serviceStatus = () => idle.data()?.service_status?.status ?? "stopped";
  const [draftRules, setDraftRules] = createSignal<EditableIdleRule[]>([]);
  const [selectedName, setSelectedName] = createSignal<string | null>(null);
  const [dirty, setDirty] = createSignal(false);

  createEffect(() => idle.data()?.rules, rules => {
    if (!rules || dirty()) return;
    const cloned = rules.map(r => ({ ...r }));
    setDraftRules(cloned);
    if (cloned.length > 0 && (!selectedName() || !cloned.some(r => r.name === selectedName()))) {
      setSelectedName(cloned[0]!.name);
    }
  });

  const selectedRule = createMemo(() => draftRules().find(r => r.name === selectedName()) ?? null);

  function updateRule(name: string, updater: (rule: EditableIdleRule) => EditableIdleRule): void {
    setDraftRules(prev => prev.map(rule => (rule.name === name ? updater(rule) : rule)));
    setDirty(true);
  }

  function addRule(): void {
    const existing = new Set(draftRules().map(r => r.name));
    let n = draftRules().length + 1;
    let name = `rule-${n}`;
    while (existing.has(name)) name = `rule-${++n}`;
    const next: EditableIdleRule = {
      name,
      enabled: false,
      timeout_seconds: 300,
      locked_timeout_seconds: null,
      action: "lock",
      resume_command: null,
      pre_action_fade_seconds: 2,
    };
    setDraftRules(prev => [...prev, next]);
    setSelectedName(name);
    setDirty(true);
  }

  function removeSelected(): void {
    const current = selectedName();
    if (!current) return;
    const next = draftRules().filter(r => r.name !== current);
    setDraftRules(next);
    setSelectedName(next[0]?.name ?? null);
    setDirty(true);
  }

  async function applyRules(): Promise<void> {
    const serialized = draftRules().map(rule => ({
      name: rule.name,
      enabled: rule.enabled,
      timeout_seconds: rule.timeout_seconds,
      locked_timeout_seconds: rule.locked_timeout_seconds,
      action: rule.action,
      resume_command: rule.resume_command,
      pre_action_fade_seconds: rule.pre_action_fade_seconds,
    }));
    const res = await invokeHost("settings.patch", { idle: { rules: serialized } });
    if (res) setDirty(false);
  }

  return (
    <column testId="settings-idle-pane" style={{ gap: "12px", width: "100%" }}>
      <row style={{ borderRadius: "16px", backgroundColor: containerHigh, padding: "12px 14px", alignItems: "center", justifyContent: "space-between", gap: "10px" }}>
        <column style={{ ...grow, gap: "2px" }}>
          <row style={{ alignItems: "center", gap: "8px" }}>
            <text style={{ fontSize: "13px", fontWeight: 600 }}>Manual Caffeine Protection</text>
            <row style={{
              alignItems: "center", gap: "5px", padding: "2px 8px", borderRadius: "999px",
              backgroundColor: serviceStatus() === "running" ? primaryContainer : containerHighest,
              color: serviceStatus() === "running" ? onPrimaryContainer : muted,
              fontSize: "11px", fontWeight: 600,
            }}>
              <box ariaHidden style={{ width: "6px", height: "6px", borderRadius: "3px", backgroundColor: serviceStatus() === "running" ? primary : muted }} />
              <text>{serviceStatus() === "running" ? "Watching" : serviceStatus()}</text>
            </row>
          </row>
          <text style={{ fontSize: "11px", color: muted }}>Pause automatic screen off and suspend timers</text>
        </column>
        <Button testId="settings-idle-caffeine" onClick={() => void invokePublic("idle.caffeine", { enabled: !caffeine() })} style={{
          display: "flex", alignItems: "center", justifyContent: "center", minHeight: "30px",
          padding: "6px 12px", borderRadius: "10px", flexShrink: 0,
          backgroundColor: caffeine() ? primaryContainer : containerHighest,
          color: caffeine() ? onPrimaryContainer : onSurface, fontSize: "12px", fontWeight: 600,
        }}>
          <text>{caffeine() ? "Awake" : "Normal"}</text>
        </Button>
      </row>

      <column style={{ borderRadius: "16px", backgroundColor: containerHigh, padding: "14px", gap: "8px" }}>
        <row style={{ alignItems: "center", justifyContent: "space-between" }}>
          <text style={{ fontSize: "13px", fontWeight: 600 }}>Idle rules</text>
          <Button testId="settings-idle-add" onClick={addRule} style={{
            display: "flex", alignItems: "center", justifyContent: "center", minHeight: "26px",
            padding: "4px 10px", borderRadius: "8px", backgroundColor: containerHighest, color: onSurface,
            fontSize: "11px", fontWeight: 600,
          }}>
            <text>+ Add rule</text>
          </Button>
        </row>
        <For each={draftRules()} keyed={rule => rule.name} fallback={<text style={{ fontSize: "12px", color: muted }}>No declarative idle rules configured</text>}>
          {rule => {
            const selected = () => selectedName() === rule().name;
            const actionLabel = () => {
              const value = rule().action;
              return typeof value === "string" ? IDLE_ACTIONS[value] : "Custom command";
            };
            return (
              <row style={{
                borderRadius: "14px", padding: "8px 10px", alignItems: "center", gap: "10px",
                backgroundColor: selected() ? primaryContainer : container,
                border: selected() ? "1px solid color-mix(in srgb, var(--color-primary) 30%, transparent)" : "1px solid transparent",
                color: selected() ? onPrimaryContainer : onSurface,
              }}>
                <Button onClick={() => setSelectedName(rule().name)} style={{
                  ...grow, display: "flex", flexDirection: "column", alignItems: "flex-start", gap: "1px",
                  minHeight: "32px", backgroundColor: "transparent", color: selected() ? onPrimaryContainer : onSurface,
                }}>
                  <text style={{ ...clipped, fontSize: "13px", fontWeight: 600 }}>{`${actionLabel()} · ${rule().name}`}</text>
                  <text data-tabular="true" style={{
                    ...clipped, fontFamily: "var(--font-mono)", fontSize: "11px", fontVariantNumeric: "tabular-nums",
                    color: selected() ? onPrimaryContainer : muted, opacity: selected() ? 0.8 : 1,
                  }}>
                    {`after ${formatRuleDuration(rule().timeout_seconds)}${rule().locked_timeout_seconds ? ` · locked ${formatRuleDuration(rule().locked_timeout_seconds!)}` : ""}${rule().enabled ? "" : " · Disabled"}`}
                  </text>
                </Button>
                <Button data-switch-root="true" ariaLabel={`Enable ${rule().name}`} checked={rule().enabled}
                  onClick={() => updateRule(rule().name, r => ({ ...r, enabled: !r.enabled }))} style={{
                    display: "flex", width: "42px", height: "24px", borderRadius: "999px", padding: "3px", flexShrink: 0,
                    alignItems: "center", justifyContent: rule().enabled ? "flex-end" : "flex-start",
                    backgroundColor: rule().enabled ? primary : containerHighest,
                  }}>
                  <box ariaHidden data-switch-thumb="true" style={{
                    width: "18px", height: "18px", borderRadius: "999px",
                    backgroundColor: rule().enabled ? onPrimary : muted,
                  }} />
                </Button>
              </row>
            );
          }}
        </For>
      </column>

      <Show when={selectedRule()}>
        {rule => (
          <column style={{ borderRadius: "16px", backgroundColor: containerHigh, padding: "14px", gap: "10px" }}>
            <row style={{ alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
              <text style={{ fontSize: "13px", fontWeight: 600 }}>{`Rule editor · ${rule().name}`}</text>
              <Button onClick={removeSelected} style={{
                display: "flex", alignItems: "center", justifyContent: "center", minHeight: "26px",
                padding: "4px 10px", borderRadius: "8px",
                backgroundColor: "var(--color-error-container)", color: "var(--color-on-error-container)",
                fontSize: "11px", fontWeight: 600,
              }}>
                <text>Remove</text>
              </Button>
            </row>

            <row style={{ gap: "4px", borderRadius: "10px", backgroundColor: container, padding: "4px" }}>
              <For each={IDLE_ACTION_KINDS} keyed={item => item.id}>
                {item => {
                  const active = () => actionKindOf(rule().action) === item().id;
                  return (
                    <Button selected={active()} onClick={() => {
                      const kind = item().id;
                      const nextAction: IdleAction = kind === "custom_command"
                        ? (typeof rule().action === "object" ? rule().action : { custom_command: ["true"] })
                        : kind;
                      updateRule(rule().name, r => ({ ...r, action: nextAction }));
                    }} style={{
                      ...grow, display: "flex", height: "28px", borderRadius: "8px", alignItems: "center", justifyContent: "center",
                      backgroundColor: active() ? primaryContainer : "transparent",
                      color: active() ? onPrimaryContainer : muted, fontSize: "11px", fontWeight: active() ? 600 : 500,
                    }}>
                      <text>{item().label}</text>
                    </Button>
                  );
                }}
              </For>
            </row>

            <row style={{ gap: "8px", width: "100%" }}>
              <column style={{ ...grow, gap: "4px" }}>
                <text style={{ fontSize: "11px", color: muted }}>After (seconds)</text>
                <TextField ariaLabel="Idle timeout seconds" value={String(rule().timeout_seconds)}
                  onInput={ev => {
                    const n = Number.parseInt(ev.value, 10);
                    if (Number.isFinite(n) && n >= 0 && n <= 86400) {
                      updateRule(rule().name, r => ({ ...r, timeout_seconds: n }));
                    }
                  }} style={{
                    height: "32px", borderRadius: "8px", padding: "6px 8px",
                    backgroundColor: container, color: onSurface, fontFamily: "var(--font-mono)", fontSize: "12px",
                  }} />
              </column>
              <column style={{ ...grow, gap: "4px" }}>
                <text style={{ fontSize: "11px", color: muted }}>When locked (s)</text>
                <TextField ariaLabel="Locked timeout seconds" value={rule().locked_timeout_seconds == null ? "" : String(rule().locked_timeout_seconds)}
                  placeholder="Optional"
                  onInput={ev => {
                    const trimmed = ev.value.trim();
                    if (!trimmed) {
                      updateRule(rule().name, r => ({ ...r, locked_timeout_seconds: null }));
                      return;
                    }
                    const n = Number.parseInt(trimmed, 10);
                    if (Number.isFinite(n) && n >= 1 && n <= 86400) {
                      updateRule(rule().name, r => ({ ...r, locked_timeout_seconds: n }));
                    }
                  }} style={{
                    height: "32px", borderRadius: "8px", padding: "6px 8px",
                    backgroundColor: container, color: onSurface, fontFamily: "var(--font-mono)", fontSize: "12px",
                  }} />
              </column>
              <column style={{ ...grow, gap: "4px" }}>
                <text style={{ fontSize: "11px", color: muted }}>Warning (0–60s)</text>
                <TextField ariaLabel="Warning fade seconds" value={String(rule().pre_action_fade_seconds)}
                  onInput={ev => {
                    const n = Number.parseInt(ev.value, 10);
                    if (Number.isFinite(n) && n >= 0 && n <= 60) {
                      updateRule(rule().name, r => ({ ...r, pre_action_fade_seconds: n }));
                    }
                  }} style={{
                    height: "32px", borderRadius: "8px", padding: "6px 8px",
                    backgroundColor: container, color: onSurface, fontFamily: "var(--font-mono)", fontSize: "12px",
                  }} />
              </column>
            </row>

            <column style={{ gap: "4px", width: "100%" }}>
              <text style={{ fontSize: "11px", color: muted }}>Resume command (optional argv, space-separated)</text>
              <TextField ariaLabel="Resume command" placeholder="e.g. niri msg action power-on-monitors"
                value={rule().resume_command ? rule().resume_command!.join(" ") : ""}
                onInput={ev => {
                  const parts = ev.value.trim().split(/\s+/).filter(Boolean);
                  updateRule(rule().name, r => ({ ...r, resume_command: parts.length > 0 ? parts : null }));
                }} style={{
                  height: "32px", borderRadius: "8px", padding: "6px 8px",
                  backgroundColor: container, color: onSurface, fontFamily: "var(--font-mono)", fontSize: "12px",
                }} />
            </column>

            <Show when={dirty()}>
              <row style={{ alignItems: "center", justifyContent: "space-between", gap: "8px", paddingTop: "4px" }}>
                <row style={{ alignItems: "center", gap: "6px", minWidth: "0px" }}>
                  <box ariaHidden style={{ width: "6px", height: "6px", borderRadius: "3px", backgroundColor: primary, flexShrink: 0 }} />
                  <text style={{ ...clipped, fontSize: "11px", color: muted }}>Unsaved changes · Apply to commit to host idle daemon</text>
                </row>
                <Button testId="settings-idle-apply" onClick={() => void applyRules()} style={{
                  display: "flex", alignItems: "center", justifyContent: "center", height: "30px",
                  padding: "0 14px", borderRadius: "10px", backgroundColor: primary, color: onPrimary,
                  fontSize: "12px", fontWeight: 600, flexShrink: 0,
                }}>
                  <text>Apply</text>
                </Button>
              </row>
            </Show>
          </column>
        )}
      </Show>

      <Show when={(idle.data()?.active_inhibitors.length ?? 0) > 0}>
        <column style={{ borderRadius: "16px", backgroundColor: containerHigh, padding: "14px", gap: "8px" }}>
          <text style={{ fontSize: "13px", fontWeight: 600 }}>Active inhibitors</text>
          <For each={idle.data()?.active_inhibitors} keyed={item => `${item.source.source}:${item.scope}:${item.reason}`}>
            {item => (
              <row style={{ borderRadius: "10px", backgroundColor: containerHighest, padding: "8px 10px", justifyContent: "space-between", gap: "8px" }}>
                <text style={{ ...clipped, fontWeight: 500, fontSize: "12px" }}>{`${item().source.source} · ${item().scope}`}</text>
                <text style={{ ...clipped, fontSize: "11px", color: muted }}>{item().reason}</text>
              </row>
            )}
          </For>
        </column>
      </Show>
    </column>
  );
}

function PowerPane(): NativeChild {
  const { power, invokePublic } = useShellStore();
  const battery = () => power.data()?.battery;
  return (
    <column testId="settings-power-pane" style={{ gap: "12px", width: "100%" }}>
      <Show when={battery()}>{b => (
        <row style={{ gap: "10px", width: "100%" }}>
          <column style={{ ...grow, borderRadius: "16px", backgroundColor: containerHigh, padding: "14px", gap: "4px" }}>
            <text style={{ fontSize: "11px", color: muted }}>Battery charge</text>
            <text data-tabular="true" style={{ fontFamily: "var(--font-mono)", fontSize: "22px", fontWeight: 600, color: primary, fontVariantNumeric: "tabular-nums" }}>
              {b().percentage != null ? `${Math.round(b().percentage!)}%` : "—"}
            </text>
            <text style={{ fontSize: "11px", color: muted }}>{b().state}</text>
          </column>
          <column style={{ ...grow, borderRadius: "16px", backgroundColor: containerHigh, padding: "14px", gap: "4px" }}>
            <text style={{ fontSize: "11px", color: muted }}>Power draw</text>
            <text data-tabular="true" style={{ fontFamily: "var(--font-mono)", fontSize: "22px", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
              {b().energy_rate_watts != null ? `${b().energy_rate_watts!.toFixed(1)} W` : "—"}
            </text>
            <text style={{ fontSize: "11px", color: muted }}>{power.data()?.on_ac ? "AC online" : "On battery"}</text>
          </column>
          <column style={{ ...grow, borderRadius: "16px", backgroundColor: containerHigh, padding: "14px", gap: "4px" }}>
            <text style={{ fontSize: "11px", color: muted }}>Battery health</text>
            <text data-tabular="true" style={{ fontFamily: "var(--font-mono)", fontSize: "22px", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
              {b().capacity_percent != null ? `${Math.round(b().capacity_percent!)}%` : "—"}
            </text>
            <text data-tabular="true" style={{ fontFamily: "var(--font-mono)", fontSize: "11px", color: muted, fontVariantNumeric: "tabular-nums" }}>
              {b().charge_cycles != null ? `${b().charge_cycles} cycles` : "UPower"}
            </text>
          </column>
        </row>
      )}</Show>

      <column style={{ borderRadius: "16px", backgroundColor: containerHigh, padding: "14px", gap: "10px" }}>
        <text style={{ fontSize: "13px", fontWeight: 600 }}>Active power profile</text>
        <row style={{ gap: "8px" }}>
          <For each={power.data()?.profiles.profiles} keyed={profile => profile} fallback={<text style={{ fontSize: "12px", color: muted }}>No profiles available</text>}>
            {profile => {
              const active = () => power.data()?.profiles.active_profile === profile();
              const info = () => PROFILE_META[profile()] ?? { label: profile(), detail: "Power profile", icon: "battery" as const };
              return (
                <Button selected={active()} onClick={() => void invokePublic("power.set-profile", { profile: profile() })} style={{
                  ...grow, display: "flex", flexDirection: "column", minHeight: "64px", borderRadius: "14px",
                  padding: "10px", alignItems: "flex-start", justifyContent: "center", gap: "4px",
                  backgroundColor: active() ? primaryContainer : container,
                  border: active() ? "1px solid color-mix(in srgb, var(--color-primary) 35%, transparent)" : "1px solid transparent",
                  color: active() ? onPrimaryContainer : onSurface,
                }}>
                  <row style={{ alignItems: "center", gap: "6px" }}>
                    <ShellIcon name={info().icon} size={15} color={active() ? onPrimaryContainer : primary} />
                    <text style={{ fontSize: "12px", fontWeight: 600 }}>{info().label}</text>
                  </row>
                  <text style={{ fontSize: "11px", color: active() ? onPrimaryContainer : muted, opacity: active() ? 0.8 : 1 }}>
                    {active() ? `Active · ${info().detail}` : info().detail}
                  </text>
                </Button>
              );
            }}
          </For>
        </row>
      </column>

      <SystemTelemetryCards />
    </column>
  );
}

/** M3 Fade Through wrapper for Settings Window right-hand pane (`opacity 0->1` + `translateY 6px->0`). */
function FadeThroughPane(props: { readonly animate: boolean; readonly children: NativeChild }): NativeChild {
  const scheme = useMotionScheme();
  const fade = createOpacityEnter("defaultEffects", scheme);
  const rise = createEnterProgress("fastSpatial", { scheme });
  return (
    <box style={{
      width: "100%",
      opacity: props.animate ? Math.max(0, Math.min(1, fade())) : 1,
      transform: !props.animate || scheme() === "reduced" ? "none" : `translateY(${((1 - rise()) * 6).toFixed(2)}px)`,
    }}>
      {props.children}
    </box>
  );
}

function SettingsWindowContent(): NativeChild {
  const { theme, pluginSettingsPages, settingsWindowTab, openSettingsWindow, closeSettingsWindow, invokePublic } = useShellStore();
  useShellTheme(theme.data);
  const activeTab = () => settingsWindowTab();
  const [animatePane, setAnimatePane] = createSignal(false);
  let seenInitialTab = false;
  createEffect(activeTab, () => {
    if (!seenInitialTab) {
      seenInitialTab = true;
      return;
    }
    setAnimatePane(true);
  });
  const activeShellTab = () => SHELL_NAV_TABS.find(tab => tab.id === activeTab());
  const activePluginPage = () => pluginSettingsPages().find(page => page.id === activeTab() || page.pluginId === activeTab());
  const heading = () => activeShellTab()?.label === "Appearance"
    ? "Appearance & wallpaper"
    : activeShellTab()?.label ?? activePluginPage()?.title ?? "Settings";
  const subtitle = () => activeShellTab()?.subtitle ?? `Plugin settings · ${activePluginPage()?.pluginId ?? ""}`;

  return (
    <row testId="settings-window-root" data-theme-rev={String(theme.revision())} style={{
      width: "820px", height: "600px", overflow: "hidden",
      backgroundColor: container, color: onSurface, fontFamily: "var(--font-sans)", fontSize: "13px",
    }}>
      <column testId="settings-sidebar" style={{
        width: "216px", height: "100%", flexShrink: 0, backgroundColor: surface,
        borderRight: "1px solid color-mix(in srgb, var(--color-outline-variant) 42%, transparent)",
        padding: "16px 12px", justifyContent: "space-between",
      }}>
        <column style={{ gap: "14px" }}>
          <row style={{ alignItems: "center", gap: "10px", padding: "2px 6px" }}>
            <box ariaHidden style={{
              display: "flex", width: "30px", height: "30px", borderRadius: "10px", flexShrink: 0,
              alignItems: "center", justifyContent: "center", backgroundColor: primaryContainer,
            }}>
              <ShellIcon name="shellEmblem" size={16} color={onPrimaryContainer} />
            </box>
            <column style={{ minWidth: "0px" }}>
              <text style={{ fontSize: "14px", fontWeight: 600, lineHeight: "18px" }}>Settings</text>
              <text style={{ fontFamily: "var(--font-mono)", fontSize: "10px", color: muted, lineHeight: "14px" }}>z-shell</text>
            </column>
          </row>

          <column style={{ gap: "3px" }}>
            <box style={{ padding: "0 8px 4px 8px" }}>
              <text style={{ fontSize: "11px", fontWeight: 600, letterSpacing: "0.04em", color: outline }}>SHELL</text>
            </box>
            <For each={SHELL_NAV_TABS} keyed={tab => tab.id}>
              {tab => {
                const active = () => activeTab() === tab().id;
                return (
                  <Button testId={`settings-nav-${tab().id}`} data-qs-tile="true" selected={active()} onClick={() => openSettingsWindow(tab().id)} style={{
                    display: "flex", flexDirection: "row", alignItems: "center", gap: "9px", height: "34px",
                    padding: "0 10px", borderRadius: "10px", flexShrink: 0,
                    backgroundColor: active() ? primaryContainer : "transparent",
                    border: active() ? "1px solid color-mix(in srgb, var(--color-primary) 30%, transparent)" : "1px solid transparent",
                    color: active() ? onPrimaryContainer : muted, fontSize: "13px", fontWeight: 500,
                  }}>
                    <ShellIcon name={tab().icon} size={15} color={active() ? onPrimaryContainer : muted} />
                    <text style={clipped}>{tab().label}</text>
                  </Button>
                );
              }}
            </For>
          </column>

          <Show when={pluginSettingsPages().length > 0}>
            <box ariaHidden style={{ width: "100%", height: "1px", backgroundColor: "color-mix(in srgb, var(--color-outline-variant) 45%, transparent)" }} />
            <column style={{ gap: "3px" }}>
              <box style={{ padding: "0 8px 4px 8px" }}>
                <text style={{ fontSize: "11px", fontWeight: 600, letterSpacing: "0.04em", color: outline }}>PLUGINS</text>
              </box>
              <For each={pluginSettingsPages()} keyed={page => page.id}>
                {page => {
                  const active = () => activeTab() === page().id;
                  return (
                    <Button testId={`settings-nav-plugin-${page().id}`} data-qs-tile="true" selected={active()} onClick={() => openSettingsWindow(page().id)} style={{
                      display: "flex", flexDirection: "row", alignItems: "center", gap: "9px", height: "34px",
                      padding: "0 10px", borderRadius: "10px", flexShrink: 0,
                      backgroundColor: active() ? primaryContainer : "transparent",
                      border: active() ? "1px solid color-mix(in srgb, var(--color-primary) 30%, transparent)" : "1px solid transparent",
                      color: active() ? onPrimaryContainer : muted, fontSize: "13px", fontWeight: 500,
                    }}>
                      <ShellIcon name="layers" size={15} color={active() ? onPrimaryContainer : muted} />
                      <text style={{ ...grow, ...clipped }}>{page().title}</text>
                      <box ariaHidden style={{ width: "6px", height: "6px", borderRadius: "3px", flexShrink: 0, backgroundColor: active() ? onPrimaryContainer : primary }} />
                    </Button>
                  );
                }}
              </For>
            </column>
          </Show>
        </column>

        <Button ariaLabel="Reload settings.toml" onClick={() => void invokePublic("settings.reload", {})} style={{
          display: "flex", flexDirection: "row", alignItems: "center", gap: "8px",
          padding: "8px 10px", borderRadius: "10px", backgroundColor: container, color: muted,
        }}>
          <box ariaHidden style={{ width: "6px", height: "6px", borderRadius: "3px", flexShrink: 0, backgroundColor: primary }} />
          <text style={{ fontFamily: "var(--font-mono)", fontSize: "10px", color: muted }}>settings.toml · Live</text>
        </Button>
      </column>

      <column testId="settings-content-pane" style={{
        ...grow, height: "100%", padding: "18px 22px", gap: "14px",
      }}>
        <row style={{ alignItems: "center", justifyContent: "space-between", width: "100%", flexShrink: 0 }}>
          <column style={{ ...grow, gap: "2px" }}>
            <text role="heading" style={{ fontSize: "18px", fontWeight: 600, letterSpacing: "-0.015em", lineHeight: "24px" }}>
              {heading()}
            </text>
            <text style={{ ...clipped, fontSize: "12px", color: muted, lineHeight: "16px" }}>{subtitle()}</text>
          </column>
          <Button testId="settings-window-close" ariaLabel="Close settings" onClick={closeSettingsWindow} style={{
            display: "flex", width: "30px", height: "30px", borderRadius: "10px", flexShrink: 0,
            alignItems: "center", justifyContent: "center", backgroundColor: containerHigh,
          }}>
            <ShellIcon name="close" size={15} color={muted} />
          </Button>
        </row>
        <scroll style={{ ...grow, minHeight: "0px", width: "100%", overflow: "hidden auto" }}>
          <Switch fallback={<FadeThroughPane animate={animatePane()}><AppearancePane /></FadeThroughPane>}>
            <Match when={activeTab() === "appearance"}><FadeThroughPane animate={animatePane()}><AppearancePane /></FadeThroughPane></Match>
            <Match when={activeTab() === "bar"}><FadeThroughPane animate={animatePane()}><BarLayoutPane /></FadeThroughPane></Match>
            <Match when={activeTab() === "idle"}><FadeThroughPane animate={animatePane()}><IdlePane /></FadeThroughPane></Match>
            <Match when={activeTab() === "power"}><FadeThroughPane animate={animatePane()}><PowerPane /></FadeThroughPane></Match>
            <Match when={activePluginPage()}>
              {page => () => <FadeThroughPane animate={animatePane()}>{page().render()}</FadeThroughPane>}
            </Match>
          </Switch>
        </scroll>
      </column>
    </row>
  );
}

export function SettingsWindow(): NativeChild {
  const { settingsWindowOpen, closeSettingsWindow } = useShellStore();
  const [surfaceMounted, setSurfaceMounted] = createSignal(settingsWindowOpen());
  createEffect(settingsWindowOpen, open => {
    if (open) {
      setSurfaceMounted(true);
      return;
    }
    queueMicrotask(() => {
      if (!settingsWindowOpen()) {
        setSurfaceMounted(false);
        flush();
      }
    });
  });
  return (
    <Show when={surfaceMounted()}>
      <WindowSurface name="settings-window" title="z-shell Settings" appId="dev.zshell.shell.settings"
        width={820} height={600} minWidth={820} minHeight={600} resizable={false} decorations="none"
        onClose={closeSettingsWindow}>
        <Show when={settingsWindowOpen()}>
          <SettingsWindowContent />
        </Show>
      </WindowSurface>
    </Show>
  );
}
