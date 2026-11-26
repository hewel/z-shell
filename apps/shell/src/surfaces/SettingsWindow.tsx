import {
  Button, For, Match, Show, Switch,
  createEffect, createSignal,
  type NativeChild,
} from "@hewel/zgui";
import { ShellIcon, type ShellIconName } from "../icons.tsx";
import {
  createEnterProgress,
  sharedAxisXStyle,
  useMotionScheme,
} from "../motion.ts";
import { useShellStore } from "../store.ts";
import { useShellTheme } from "../theme.ts";
import { AppearancePane } from "./settings/AppearancePane.tsx";
import { BarLayoutPane } from "./settings/BarLayoutPane.tsx";
import { IdlePane } from "./settings/IdlePane.tsx";
import { PluginsPane } from "./settings/PluginsPane.tsx";
import { PowerPane } from "./settings/PowerPane.tsx";
import { TrayRulesView } from "./settings/TrayRulesView.tsx";
import { WallpaperLibraryView } from "./settings/WallpaperLibraryView.tsx";
import {
  clipped,
  container,
  containerHigh,
  grow,
  muted,
  onPrimaryContainer,
  onSurface,
  outline,
  primary,
  primaryContainer,
  surface,
} from "./settings/shared.tsx";
import { FadeThroughPane, SingleInstanceWindowSurface, SlidingNavPill } from "./window-chrome.tsx";

type ShellNavTab = {
  readonly id: "appearance" | "bar" | "idle" | "power" | "plugins";
  readonly label: string;
  readonly subtitle: string;
  readonly icon: ShellIconName;
};

const SHELL_NAV_TABS: readonly ShellNavTab[] = [
  { id: "appearance", label: "Appearance", subtitle: "Dynamic Material 3 HCT palette & motion physics synced to settings.toml", icon: "palette" },
  { id: "bar", label: "Bar & layout", subtitle: "Wayland layer-shell edge strut, spacing rhythm, and visible modules", icon: "overview" },
  { id: "idle", label: "Idle & sleep", subtitle: "Automatic actions pause while media is playing · Declarative rules", icon: "sleep" },
  { id: "power", label: "Power & battery", subtitle: "UPower telemetry, power-profiles-daemon switching, and system load", icon: "batteryCharging" },
  { id: "plugins", label: "Plugins", subtitle: "Installed plugins, catalog sources, capability review, and build state", icon: "extension" },
];

/** M3 Shared Axis X wrapper for Settings sub-page drill-down (`Appearance <-> Wallpaper library`). */
function SharedAxisXPane(props: { readonly direction: 1 | -1; readonly children: NativeChild }): NativeChild {
  const scheme = useMotionScheme();
  const progress = createEnterProgress("defaultSpatial", { scheme });
  return (
    <column style={{
      ...grow,
      width: "100%",
      height: "100%",
      minHeight: "0px",
      ...sharedAxisXStyle(progress(), props.direction, scheme() === "reduced"),
    }}>
      {props.children}
    </column>
  );
}

function SettingsWindowContent(): NativeChild {
  const {
    theme,
    pluginSettingsPages,
    pluginUpdatesCount,
    settingsWindowTab,
    settingsSubpage,
    setSettingsSubpage,
    openSettingsWindow,
    closeSettingsWindow,
    invokePublic,
  } = useShellStore();
  useShellTheme(theme.data);
  const activeTab = () => settingsWindowTab();
  const [animatePane, setAnimatePane] = createSignal(false);
  const [returnedFromLibrary, setReturnedFromLibrary] = createSignal(false);
  const [returnedFromTrayRules, setReturnedFromTrayRules] = createSignal(false);
  const [selectedPluginId, setSelectedPluginId] = createSignal<string | null>(null);
  let seenInitialTab = false;
  createEffect(activeTab, () => {
    if (!seenInitialTab) {
      seenInitialTab = true;
      return;
    }
    setAnimatePane(true);
    setReturnedFromLibrary(false);
    setReturnedFromTrayRules(false);
    if (activeTab() !== "plugins") {
      setSelectedPluginId(null);
    }
  });

  const openWallpaperLibrary = () => {
    setReturnedFromLibrary(false);
    setSettingsSubpage("wallpaper-library");
  };
  const closeWallpaperLibrary = () => {
    setReturnedFromLibrary(true);
    setSettingsSubpage(null);
  };
  const openTrayRules = () => {
    setReturnedFromTrayRules(false);
    setSettingsSubpage("tray-rules");
  };
  const closeTrayRules = () => {
    setReturnedFromTrayRules(true);
    setSettingsSubpage(null);
  };
  const showingWallpaperLibrary = () => activeTab() === "appearance" && settingsSubpage() === "wallpaper-library";
  const showingTrayRules = () => activeTab() === "bar" && settingsSubpage() === "tray-rules";

  const activeShellIndex = () => SHELL_NAV_TABS.findIndex(tab => tab.id === activeTab());
  const activePluginIndex = () => pluginSettingsPages().findIndex(page => page.id === activeTab() || page.pluginId === activeTab());
  const activeShellTab = () => (activeShellIndex() >= 0 ? SHELL_NAV_TABS[activeShellIndex()] : undefined);
  const activePluginPage = () => (activePluginIndex() >= 0 ? pluginSettingsPages()[activePluginIndex()] : undefined);
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
            <column style={{ position: "relative", gap: "3px" }}>
              <SlidingNavPill activeIndex={activeShellIndex} />
              <For each={SHELL_NAV_TABS} keyed={tab => tab.id}>
                {tab => {
                  const active = () => activeTab() === tab().id;
                  return (
                    <Button testId={`settings-nav-${tab().id}`} data-qs-tile="true" selected={active()} onClick={() => {
                      if (tab().id === "plugins") setSelectedPluginId(null);
                      openSettingsWindow(tab().id);
                    }} style={{
                      position: "relative", zIndex: 1,
                      display: "flex", flexDirection: "row", alignItems: "center", gap: "9px", height: "34px",
                      padding: "0 10px", borderRadius: "10px", flexShrink: 0,
                      backgroundColor: "transparent", border: "1px solid transparent",
                      color: active() ? onPrimaryContainer : muted, fontSize: "13px", fontWeight: 500,
                    }}>
                      <ShellIcon name={tab().icon} filled={active()} size={15} color={active() ? onPrimaryContainer : muted} />
                      <text style={{ ...grow, ...clipped }}>{tab().label}</text>
                      <Show when={tab().id === "plugins" && pluginUpdatesCount() > 0}>
                        <box style={{
                          display: "flex", alignItems: "center", justifyContent: "center",
                          minWidth: "18px", height: "18px", padding: "0 5px",
                          borderRadius: "999px", "--zgui-corner-shape": "none",
                          backgroundColor: active() ? containerHigh : primaryContainer,
                          color: active() ? onSurface : onPrimaryContainer,
                        }}>
                          <text data-tabular="true" style={{ fontFamily: "var(--font-mono)", fontSize: "10px", lineHeight: "12px", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
                            {pluginUpdatesCount()}
                          </text>
                        </box>
                      </Show>
                    </Button>
                  );
                }}
              </For>
            </column>
          </column>

          <Show when={pluginSettingsPages().length > 0}>
            <box ariaHidden style={{ width: "100%", height: "1px", backgroundColor: "color-mix(in srgb, var(--color-outline-variant) 45%, transparent)" }} />
            <column style={{ gap: "3px" }}>
              <box style={{ padding: "0 8px 4px 8px" }}>
                <text style={{ fontSize: "11px", fontWeight: 600, letterSpacing: "0.04em", color: outline }}>PLUGINS</text>
              </box>
              <column style={{ position: "relative", gap: "3px" }}>
                <SlidingNavPill activeIndex={activePluginIndex} />
                <For each={pluginSettingsPages()} keyed={page => page.id}>
                  {page => {
                    const active = () => activeTab() === page().id;
                    return (
                      <Button testId={`settings-nav-plugin-${page().id}`} data-qs-tile="true" selected={active()} onClick={() => openSettingsWindow(page().id)} style={{
                        position: "relative", zIndex: 1,
                        display: "flex", flexDirection: "row", alignItems: "center", gap: "9px", height: "34px",
                        padding: "0 10px", borderRadius: "10px", flexShrink: 0,
                        backgroundColor: "transparent", border: "1px solid transparent",
                        color: active() ? onPrimaryContainer : muted, fontSize: "13px", fontWeight: 500,
                      }}>
                        <ShellIcon name="layers" filled={active()} size={15} color={active() ? onPrimaryContainer : muted} />
                        <text style={{ ...grow, ...clipped }}>{page().title}</text>
                        <box ariaHidden style={{ width: "6px", height: "6px", borderRadius: "3px", flexShrink: 0, backgroundColor: active() ? onPrimaryContainer : primary }} />
                      </Button>
                    );
                  }}
                </For>
              </column>
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
        ...grow, height: "100%", padding: "18px 22px", gap: "14px", overflow: "hidden", position: "relative",
      }}>
        <Show
          when={!showingWallpaperLibrary() && !showingTrayRules()}
          fallback={
            <Show
              when={showingWallpaperLibrary()}
              fallback={
                <SharedAxisXPane direction={1}>
                  <TrayRulesView onBack={closeTrayRules} />
                </SharedAxisXPane>
              }
            >
              <SharedAxisXPane direction={1}>
                <WallpaperLibraryView onBack={closeWallpaperLibrary} onCloseSettings={closeSettingsWindow} />
              </SharedAxisXPane>
            </Show>
          }
        >
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
            <Switch fallback={<FadeThroughPane animate={animatePane()}><AppearancePane onOpenLibrary={openWallpaperLibrary} /></FadeThroughPane>}>
              <Match when={activeTab() === "appearance"}>
                <Show when={returnedFromLibrary()} fallback={<FadeThroughPane animate={animatePane()}><AppearancePane onOpenLibrary={openWallpaperLibrary} /></FadeThroughPane>}>
                  <SharedAxisXPane direction={-1}><AppearancePane onOpenLibrary={openWallpaperLibrary} /></SharedAxisXPane>
                </Show>
              </Match>
              <Match when={activeTab() === "bar"}>
                <Show when={returnedFromTrayRules()} fallback={<FadeThroughPane animate={animatePane()}><BarLayoutPane onOpenTrayRules={openTrayRules} /></FadeThroughPane>}>
                  <SharedAxisXPane direction={-1}><BarLayoutPane onOpenTrayRules={openTrayRules} /></SharedAxisXPane>
                </Show>
              </Match>
              <Match when={activeTab() === "idle"}><FadeThroughPane animate={animatePane()}><IdlePane /></FadeThroughPane></Match>
              <Match when={activeTab() === "power"}><FadeThroughPane animate={animatePane()}><PowerPane /></FadeThroughPane></Match>
              <Match when={activeTab() === "plugins"}>
                <FadeThroughPane animate={animatePane()}>
                  <PluginsPane selectedPluginId={selectedPluginId} onSelectPlugin={setSelectedPluginId} />
                </FadeThroughPane>
              </Match>
              <Match when={activePluginPage()}>
                {page => () => <FadeThroughPane animate={animatePane()}>{page().render()}</FadeThroughPane>}
              </Match>
            </Switch>
          </scroll>
        </Show>
      </column>
    </row>
  );
}

export function SettingsWindow(): NativeChild {
  const { settingsWindowOpen, closeSettingsWindow } = useShellStore();
  return (
    <SingleInstanceWindowSurface
      open={settingsWindowOpen}
      onClose={closeSettingsWindow}
      name="settings-window"
      title="z-shell Settings"
      appId="dev.zshell.shell.settings"
      width={820}
      height={600}
    >
      <SettingsWindowContent />
    </SingleInstanceWindowSurface>
  );
}
