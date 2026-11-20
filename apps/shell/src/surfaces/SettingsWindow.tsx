import { Button, For, Image, Match, Show, Switch, WindowSurface, createEffect, createMemo, createSignal, type Accessor, type NativeChild } from "@hewel/zgui";
import { useDaemonMedia } from "@z-shell/sdk/zgui";
import { ShellIcon, type ShellIconName } from "../icons.tsx";
import { SystemTelemetryCards } from "../panels/BatteryPanel.tsx";
import { useShellStore } from "../store.ts";
import { THEME_SEED_SWATCHES, useShellTheme } from "../theme.ts";
import { resolveMonitorWallpaper, type CatalogEntry, type WallpaperListResponse } from "../topics.ts";

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

type ShellNavTab = {
  readonly id: "appearance" | "bar" | "idle" | "power";
  readonly label: string;
  readonly subtitle: string;
  readonly icon: ShellIconName;
};

const SHELL_NAV_TABS: readonly ShellNavTab[] = [
  { id: "appearance", label: "Appearance", subtitle: "Dynamic Material 3 HCT palette synced to desktop background", icon: "palette" },
  { id: "bar", label: "Bar & layout", subtitle: "Floating islands, docked flush strip, and edge geometry", icon: "overview" },
  { id: "idle", label: "Idle & sleep", subtitle: "Inhibitors, caffeine guard, and declarative idle rules", icon: "sleep" },
  { id: "power", label: "Power & battery", subtitle: "Performance profiles, battery health, and live telemetry", icon: "batteryCharging" },
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

const IDLE_ACTIONS = {
  lock: "Lock",
  screen_off: "Screen off",
  suspend: "Suspend",
  lock_and_suspend: "Lock and suspend",
} as const;

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
  const { publicClient, monitors, wallpaper, theme, settings, invokePublic } = useShellStore();
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

  return (
    <column style={{ gap: "14px", width: "100%" }}>
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
        <column style={{ ...grow, borderRadius: "16px", backgroundColor: containerHigh, padding: "14px", gap: "12px" }}>
          <row style={{ alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
            <text style={{ fontSize: "13px", fontWeight: 600 }}>Color seed</text>
            <Button onClick={() => void invokePublic("theme.retry", {})} style={{
              display: "flex", alignItems: "center", justifyContent: "center", minHeight: "26px",
              padding: "4px 10px", borderRadius: "8px", backgroundColor: primaryContainer, color: onPrimaryContainer,
              fontSize: "11px", fontWeight: 500,
            }}>
              <text>{wallpaper.data()?.sync_theme ? "Sync wallpaper" : "Manual seed"}</text>
            </Button>
          </row>
          <row style={{ alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
            <For each={THEME_SEED_SWATCHES} keyed={seed => seed}>
              {seed => {
                const selected = () => settings.data()?.theme.seed_color?.toUpperCase() === seed().toUpperCase();
                return (
                  <Button ariaLabel={`Set seed color ${seed()}`} onClick={() => void invokePublic("theme.set", { seed: seed() })}
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
                  <Button selected={active()} onClick={() => void invokePublic("theme.set", { mode: item().id })} style={{
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
                        <Button selected={active()} onClick={() => void invokePublic("theme.set", { variant: variant().id })} style={{
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
        alignItems: "center", justifyContent: "space-between", gap: "10px",
        borderRadius: "14px", backgroundColor: containerHigh, padding: "12px 14px",
      }}>
        <column style={{ ...grow, gap: "2px" }}>
          <text style={{ fontSize: "13px", fontWeight: 600 }}>App color bridges</text>
          <text style={{ ...clipped, fontSize: "11px", color: muted }}>
            {`Backend: ${settings.data()?.theme.backend ?? "builtin"} · Changes take effect immediately`}
          </text>
        </column>
        <row style={{ gap: "6px", flexShrink: 0 }}>
          <box style={{
            display: "flex", alignItems: "center", minHeight: "26px", padding: "4px 10px", borderRadius: "8px",
            backgroundColor: settings.data()?.theme.gtk_linking ? primaryContainer : containerHighest,
            color: settings.data()?.theme.gtk_linking ? onPrimaryContainer : muted,
            fontSize: "11px", fontWeight: 600,
          }}>
            <text>{settings.data()?.theme.gtk_linking ? "GTK 3/4 · On" : "GTK 3/4 · Off"}</text>
          </box>
          <box style={{
            display: "flex", alignItems: "center", minHeight: "26px", padding: "4px 10px", borderRadius: "8px",
            backgroundColor: primaryContainer, color: onPrimaryContainer, fontSize: "11px", fontWeight: 600,
          }}>
            <text>{settings.data()?.theme.backend ?? "builtin"}</text>
          </box>
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
  const { settings, invokePublic } = useShellStore();
  const bar = () => settings.data()?.bar;
  return (
    <column style={{ gap: "12px", width: "100%" }}>
      <column style={{ borderRadius: "16px", backgroundColor: containerHigh, padding: "14px", gap: "10px" }}>
        <text style={{ fontSize: "13px", fontWeight: 600 }}>Active Bar Configuration</text>
        <row style={{ justifyContent: "space-between" }}>
          <text style={{ color: muted }}>Position</text>
          <text style={{ fontFamily: "var(--font-mono)" }}>{bar()?.position ?? "top"}</text>
        </row>
        <row style={{ justifyContent: "space-between" }}>
          <text style={{ color: muted }}>Chrome style</text>
          <text style={{ fontFamily: "var(--font-mono)" }}>{bar()?.style ?? "floating"}</text>
        </row>
        <row style={{ justifyContent: "space-between" }}>
          <text style={{ color: muted }}>Tiling gap</text>
          <text data-tabular="true" style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>{bar()?.gaps ?? 14}px</text>
        </row>
        <row style={{ justifyContent: "space-between" }}>
          <text style={{ color: muted }}>Clock seconds (1Hz)</text>
          <text style={{ fontFamily: "var(--font-mono)" }}>{bar()?.clock_seconds ? "enabled" : "disabled"}</text>
        </row>
      </column>
      <row style={{ justifyContent: "flex-end" }}>
        <Button onClick={() => void invokePublic("settings.reload", {})} style={{
          padding: "8px 14px", borderRadius: "10px", backgroundColor: primaryContainer, color: onPrimaryContainer, fontSize: "12px", fontWeight: 600,
        }}>
          <text>Reload settings.toml</text>
        </Button>
      </row>
    </column>
  );
}

function IdlePane(): NativeChild {
  const { idle, invokePublic } = useShellStore();
  const caffeine = () => idle.data()?.caffeine ?? false;
  return (
    <column style={{ gap: "12px", width: "100%" }}>
      <row style={{ borderRadius: "16px", backgroundColor: containerHigh, padding: "14px", alignItems: "center", justifyContent: "space-between" }}>
        <column style={{ gap: "2px" }}>
          <text style={{ fontSize: "13px", fontWeight: 600 }}>Manual Caffeine Protection</text>
          <text style={{ fontSize: "12px", color: muted }}>Pause automatic screen off and suspend timers</text>
        </column>
        <Button onClick={() => void invokePublic("idle.caffeine", { enabled: !caffeine() })} style={{
          display: "flex", alignItems: "center", justifyContent: "center", minHeight: "30px",
          padding: "6px 12px", borderRadius: "10px",
          backgroundColor: caffeine() ? primaryContainer : containerHighest,
          color: caffeine() ? onPrimaryContainer : onSurface, fontSize: "12px", fontWeight: 600,
        }}>
          <text>{caffeine() ? "Awake" : "Normal"}</text>
        </Button>
      </row>
      <column style={{ borderRadius: "16px", backgroundColor: containerHigh, padding: "14px", gap: "8px" }}>
        <text style={{ fontSize: "13px", fontWeight: 600 }}>Active Inhibitors</text>
        <For each={idle.data()?.active_inhibitors} keyed={item => `${item.source.source}:${item.scope}:${item.reason}`}
          fallback={<text style={{ fontSize: "12px", color: muted }}>No active idle inhibitors</text>}>
          {item => (
            <row style={{ borderRadius: "10px", backgroundColor: containerHighest, padding: "10px", justifyContent: "space-between", gap: "8px" }}>
              <text style={{ ...clipped, fontWeight: 500 }}>{`${item().source.source} · ${item().scope}`}</text>
              <text style={{ ...clipped, fontSize: "12px", color: muted }}>{item().reason}</text>
            </row>
          )}
        </For>
      </column>
      <column style={{ borderRadius: "16px", backgroundColor: containerHigh, padding: "14px", gap: "8px" }}>
        <text style={{ fontSize: "13px", fontWeight: 600 }}>Declarative Idle Rules</text>
        <For each={idle.data()?.rules} keyed={rule => rule.name} fallback={<text style={{ fontSize: "12px", color: muted }}>No idle rules configured</text>}>
          {rule => {
            const action = () => {
              const value = rule().action;
              return typeof value === "string" ? IDLE_ACTIONS[value] : "Custom command";
            };
            return (
              <row style={{ borderRadius: "10px", backgroundColor: containerHighest, padding: "10px", justifyContent: "space-between" }}>
                <text style={{ fontWeight: 500 }}>{rule().name}</text>
                <text data-tabular="true" style={{ fontFamily: "var(--font-mono)", fontSize: "11px", color: muted, fontVariantNumeric: "tabular-nums" }}>
                  {`${rule().timeout_seconds}s · ${action()}`}
                </text>
              </row>
            );
          }}
        </For>
      </column>
    </column>
  );
}

function PowerPane(): NativeChild {
  const { power, invokePublic } = useShellStore();
  return (
    <column style={{ gap: "12px", width: "100%" }}>
      <column style={{ borderRadius: "16px", backgroundColor: containerHigh, padding: "14px", gap: "10px" }}>
        <text style={{ fontSize: "13px", fontWeight: 600 }}>Power Profile</text>
        <row style={{ gap: "8px" }}>
          <For each={power.data()?.profiles.profiles} keyed={profile => profile} fallback={<text style={{ fontSize: "12px", color: muted }}>No profiles available</text>}>
            {profile => {
              const active = () => power.data()?.profiles.active_profile === profile();
              return (
                <Button selected={active()} onClick={() => void invokePublic("power.set-profile", { profile: profile() })} style={{
                  ...grow, display: "flex", height: "34px", borderRadius: "10px", alignItems: "center", justifyContent: "center",
                  backgroundColor: active() ? primaryContainer : containerHighest,
                  color: active() ? onPrimaryContainer : onSurface, fontSize: "12px", fontWeight: 600,
                }}>
                  <text>{profile()}</text>
                </Button>
              );
            }}
          </For>
        </row>
      </column>
      <Show when={power.data()?.battery}>{battery => (
        <column style={{ borderRadius: "16px", backgroundColor: containerHigh, padding: "14px", gap: "8px" }}>
          <text style={{ fontSize: "13px", fontWeight: 600 }}>Battery Health</text>
          <row style={{ justifyContent: "space-between" }}>
            <text style={{ color: muted }}>Charge</text>
            <text data-tabular="true" style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
              {battery().percentage != null ? `${Math.round(battery().percentage!)}% · ${battery().state}` : battery().state}
            </text>
          </row>
          <Show when={battery().capacity_percent != null}>
            <row style={{ justifyContent: "space-between" }}>
              <text style={{ color: muted }}>Design capacity</text>
              <text data-tabular="true" style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
                {`${Math.round(battery().capacity_percent!)}%`}
              </text>
            </row>
          </Show>
          <Show when={battery().charge_cycles != null}>
            <row style={{ justifyContent: "space-between" }}>
              <text style={{ color: muted }}>Charge cycles</text>
              <text data-tabular="true" style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
                {`${battery().charge_cycles}`}
              </text>
            </row>
          </Show>
          <Show when={battery().energy_rate_watts != null}>
            <row style={{ justifyContent: "space-between" }}>
              <text style={{ color: muted }}>Power draw</text>
              <text data-tabular="true" style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
                {`${battery().energy_rate_watts!.toFixed(1)} W`}
              </text>
            </row>
          </Show>
        </column>
      )}</Show>
      <SystemTelemetryCards />
    </column>
  );
}

function SettingsWindowContent(): NativeChild {
  const { theme, pluginSettingsPages, settingsWindowTab, openSettingsWindow, closeSettingsWindow, invokePublic } = useShellStore();
  useShellTheme(theme.data);
  const activeTab = () => settingsWindowTab();
  const activeShellTab = () => SHELL_NAV_TABS.find(tab => tab.id === activeTab());
  const activePluginPage = () => pluginSettingsPages().find(page => page.id === activeTab() || page.pluginId === activeTab());
  const heading = () => activeShellTab()?.label === "Appearance"
    ? "Appearance & wallpaper"
    : activeShellTab()?.label ?? activePluginPage()?.title ?? "Settings";
  const subtitle = () => activeShellTab()?.subtitle ?? `Plugin settings · ${activePluginPage()?.pluginId ?? ""}`;

  return (
    <row testId="settings-window-root" data-theme-rev={String(theme.revision())} style={{
      width: "820px", height: "600px", borderRadius: "22px", overflow: "hidden",
      backgroundColor: container, color: onSurface, fontFamily: "var(--font-sans)", fontSize: "13px",
      border: "1px solid color-mix(in srgb, var(--color-outline-variant) 55%, transparent)",
      boxShadow: "0 20px 56px rgba(0, 0, 0, 0.60)",
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
                  <Button testId={`settings-nav-${tab().id}`} selected={active()} onClick={() => openSettingsWindow(tab().id)} style={{
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
                    <Button testId={`settings-nav-plugin-${page().id}`} selected={active()} onClick={() => openSettingsWindow(page().id)} style={{
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
          <Switch fallback={<AppearancePane />}>
            <Match when={activeTab() === "appearance"}><AppearancePane /></Match>
            <Match when={activeTab() === "bar"}><BarLayoutPane /></Match>
            <Match when={activeTab() === "idle"}><IdlePane /></Match>
            <Match when={activeTab() === "power"}><PowerPane /></Match>
            <Match when={activePluginPage()}>
              {page => () => page().render()}
            </Match>
          </Switch>
        </scroll>
      </column>
    </row>
  );
}

export function SettingsWindow(): NativeChild {
  const { settingsWindowOpen, closeSettingsWindow } = useShellStore();
  return (
    <Show when={settingsWindowOpen()}>
      <WindowSurface name="settings-window" title="z-shell Settings" appId="dev.zshell.shell.settings"
        width={820} height={600} minWidth={820} minHeight={600} resizable={false} decorations="none" transparent
        onClose={closeSettingsWindow}>
        <SettingsWindowContent />
      </WindowSurface>
    </Show>
  );
}
