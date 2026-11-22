import { Button, For, Image, Show, createEffect, createMemo, createSignal, type Accessor, type NativeChild } from "@hewel/zgui";
import { M3SegmentedControl } from "@z-shell/sdk/primitives";
import { useDaemonMedia } from "@z-shell/sdk/zgui";
import { ShellIcon } from "../../icons.tsx";
import { useShellStore } from "../../store.ts";
import { THEME_SEED_SWATCHES } from "../../theme.ts";
import {
  resolveMonitorWallpaper,
  type CatalogEntry,
  type MotionScheme,
  type WallpaperListResponse,
} from "../../topics.ts";
import {
  clipped,
  container,
  containerHigh,
  containerHighest,
  grow,
  muted,
  onPrimary,
  onPrimaryContainer,
  onSurface,
  primary,
  primaryContainer,
} from "./shared.tsx";

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

const MOTION_SCHEMES: readonly { readonly id: MotionScheme; readonly label: string; readonly testId: string }[] = [
  { id: "standard", label: "Standard", testId: "settings-motion-standard" },
  { id: "expressive", label: "Expressive", testId: "settings-motion-expressive" },
  { id: "reduced", label: "Reduced", testId: "settings-motion-reduced" },
];

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

export function AppearancePane(): NativeChild {
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
          <row style={{ alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
            <For each={THEME_SEED_SWATCHES} keyed={seed => seed}>
              {seed => {
                const selected = () => settings.data()?.theme.seed_color?.toUpperCase() === seed().toUpperCase();
                return (
                  <Button ariaLabel={`Set seed color ${seed()}`} selected={selected()} onClick={() => patchTheme({ seed_color: seed() }, { seed: seed() })}
                    style={{
                      display: "flex", alignItems: "center", justifyContent: "center",
                      width: "24px", height: "24px", borderRadius: "999px", flexShrink: 0, padding: "2px",
                      backgroundColor: selected() ? containerHigh : "transparent",
                      border: selected() ? "2px solid var(--color-on-surface)" : "2px solid transparent",
                    }}>
                    <box ariaHidden style={{
                      width: "100%", height: "100%", borderRadius: "999px",
                      backgroundColor: seed(),
                    }} />
                  </Button>
                );
              }}
            </For>
          </row>
          <M3SegmentedControl
            ariaLabel="Theme mode"
            options={THEME_MODES}
            value={currentMode()}
            onChange={mode => patchTheme({ mode }, { mode })}
          />
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
        <M3SegmentedControl
          ariaLabel="Motion physics scheme"
          options={MOTION_SCHEMES}
          value={currentMotion()}
          onChange={motion_scheme => patchTheme({ motion_scheme })}
          style={{ width: "260px", flexShrink: 0 }}
        />
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
