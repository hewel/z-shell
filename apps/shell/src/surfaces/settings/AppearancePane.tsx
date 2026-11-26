import { Button, For, Image, Show, createEffect, createMemo, createSignal, cx, type Accessor, type NativeChild } from "@hewel/zgui";
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
import styles from "./AppearancePane.module.css";
import { muted, onPrimary } from "./shared.tsx";

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
    <Button
      testId={`settings-wp-${props.item().id}`}
      ariaLabel={props.item().name}
      selected={props.active}
      data-active={props.active ? "true" : null}
      onClick={props.onClick}
      class={cx(styles.wallpaperTile)}
    >
      <Show when={image.src()} fallback={<ShellIcon name="image" size={20} color={muted} />}>
        {src => <Image ariaHidden src={src()} class={cx(styles.wallpaperImage)} />}
      </Show>
      <Show when={props.active}>
        <box ariaHidden class={cx(styles.activeCheckBadge)}>
          <ShellIcon name="check" size={11} color={onPrimary} />
        </box>
      </Show>
    </Button>
  );
}

export function AppearancePane(props?: { readonly onOpenLibrary?: () => void }): NativeChild {
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
    <column testId="settings-appearance-pane" class={cx(styles.pane)}>
      <column class={cx(styles.card)}>
        <row class={cx(styles.cardHeaderRow)}>
          <row class={cx(styles.wallpaperTitleRow)}>
            <text class={cx(styles.sectionTitle)}>Wallpaper</text>
            <text data-tabular="true" class={cx(styles.wallpaperMeta)}>
              {`${activeFileName()} · ${wallpaper.data()?.catalog_count ?? 0} files`}
            </text>
          </row>
          <row class={cx(styles.actionRow)}>
            <Button ariaLabel="Cycle target output" onClick={() => setOutputIndex(index => index + 1)} class={cx(styles.compactMutedButton)}>
              <text>{selectedOutput() ? `Output (${selectedOutput()})` : `All outputs (${monitors()[0]?.name ?? "default"})`}</text>
            </Button>
            <Button
              testId="settings-wp-rescan"
              onClick={() => {
                void invokePublic("wallpaper.rescan", {}).then(result => { if (result) setScanRevision(revision => revision + 1); });
              }}
              class={cx(styles.compactButton)}
            >
              <text>Rescan</text>
            </Button>
          </row>
        </row>
        <row class={cx(styles.gridRow)}>
          <For each={visibleItems().slice(0, 4)} keyed={item => item.id} fallback={
            <row class={cx(styles.emptyRow)}>
              <text class={cx(styles.emptyText)}>No wallpapers indexed</text>
              <Button testId="settings-wp-browse" onClick={() => props?.onOpenLibrary?.()} class={cx(styles.browseEmptyButton)}>
                <text>Browse folder</text>
              </Button>
            </row>
          }>
            {item => (
              <WallpaperCardTile item={item} active={item().source_path === activeWallpaper()?.source_path}
                onClick={() => void invokePublic("wallpaper.set", { path: item().source_path, output: selectedOutput(), fit: wallpaper.data()?.fit ?? "cover" })} />
            )}
          </For>
        </row>
        <Show when={visibleItems().length > 0}>
          <row class={cx(styles.gridRow)}>
            <For each={visibleItems().slice(4, 7)} keyed={item => item.id}>
              {item => (
                <WallpaperCardTile item={item} active={item().source_path === activeWallpaper()?.source_path}
                  onClick={() => void invokePublic("wallpaper.set", { path: item().source_path, output: selectedOutput(), fit: wallpaper.data()?.fit ?? "cover" })} />
              )}
            </For>
            <Button testId="settings-wp-browse" onClick={() => props?.onOpenLibrary?.()} class={cx(styles.browseTileButton)}>
              <text class={cx(styles.browseTileTitle)}>{remainingCount() > 0 ? `+${remainingCount()} more` : "Browse folder"}</text>
              <text class={cx(styles.browseTileSubtitle)}>{remainingCount() > 0 ? "Browse folder" : "Wallpaper library"}</text>
            </Button>
          </row>
        </Show>
      </column>

      <row class={cx(styles.splitRow)}>
        <column class={cx(styles.growCard)}>
          <row class={cx(styles.cardHeaderRow)}>
            <text class={cx(styles.sectionTitle)}>Color seed</text>
            <Button
              onClick={() => {
                if (settings.data()?.theme.seed_color) patchTheme({ seed_color: null });
                else void invokePublic("theme.retry", {});
              }}
              class={cx(styles.accentActionButton)}
            >
              <text>{settings.data()?.theme.seed_color ? "Use wallpaper" : (wallpaper.data()?.sync_theme ? "Sync wallpaper" : "Manual seed")}</text>
            </Button>
          </row>
          <row class={cx(styles.swatchRow)}>
            <For each={THEME_SEED_SWATCHES} keyed={seed => seed}>
              {seed => {
                const selected = () => settings.data()?.theme.seed_color?.toUpperCase() === seed().toUpperCase();
                return (
                  <Button
                    ariaLabel={`Set seed color ${seed()}`}
                    selected={selected()}
                    data-selected={selected() ? "true" : null}
                    onClick={() => patchTheme({ seed_color: seed() }, { seed: seed() })}
                    class={cx(styles.swatchButton)}
                  >
                    <box ariaHidden class={cx(styles.swatchDot)} style={{ backgroundColor: seed() }} />
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

        <column class={cx(styles.growCard)}>
          <text class={cx(styles.sectionTitle)}>HCT variant</text>
          <column class={cx(styles.variantGrid)}>
            <For each={[VARIANTS.slice(0, 3), VARIANTS.slice(3, 6)]} keyed={group => group[0]!.id}>
              {group => (
                <row class={cx(styles.variantRow)}>
                  <For each={group()} keyed={variant => variant.id}>
                    {variant => {
                      const active = () => currentVariant() === variant().id;
                      return (
                        <Button
                          selected={active()}
                          data-active={active() ? "true" : null}
                          onClick={() => patchTheme({ variant: variant().id }, { variant: variant().id })}
                          class={cx(styles.variantButton)}
                        >
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

      <row class={cx(styles.compactCard)}>
        <column class={cx(styles.cardMeta)}>
          <text class={cx(styles.sectionTitle)}>Motion physics scheme</text>
          <text class={cx(styles.cardSubtitle)}>
            M3 spring physics · Reduced honors WCAG
          </text>
        </column>
        <box class={cx(styles.motionSegmented)}>
          <M3SegmentedControl
            ariaLabel="Motion physics scheme"
            options={MOTION_SCHEMES}
            value={currentMotion()}
            onChange={motion_scheme => patchTheme({ motion_scheme })}
          />
        </box>
      </row>

      <row class={cx(styles.bridgesCard)}>
        <column class={cx(styles.cardMeta)}>
          <text class={cx(styles.sectionTitle)}>App color bridges</text>
          <text class={cx(styles.cardSubtitle)}>
            {`Backend: ${settings.data()?.theme.backend ?? "builtin"} · Changes persist to settings.toml`}
          </text>
        </column>
        <row class={cx(styles.actionRow)}>
          <Button
            testId="settings-backend-toggle"
            onClick={() => {
              const next = settings.data()?.theme.backend === "matugen" ? "builtin" : "matugen";
              patchTheme({ backend: next }, { backend: next });
            }}
            class={cx(styles.compactButton)}
          >
            <text>{settings.data()?.theme.backend === "matugen" ? "Matugen" : "Built-in"}</text>
          </Button>
          <Button
            testId="settings-gtk-toggle"
            selected={settings.data()?.theme.gtk_linking === true}
            data-active={settings.data()?.theme.gtk_linking ? "true" : null}
            onClick={() => patchTheme({ gtk_linking: !settings.data()?.theme.gtk_linking }, { gtk_linking: !settings.data()?.theme.gtk_linking })}
            class={cx(styles.gtkButton)}
          >
            <text>{settings.data()?.theme.gtk_linking ? "GTK 3/4 · On" : "GTK 3/4 · Off"}</text>
          </Button>
          <Button onClick={() => void invokePublic("theme.retry", {})} class={cx(styles.compactButton)}>
            <text>Reapply</text>
          </Button>
        </row>
      </row>
    </column>
  );
}
