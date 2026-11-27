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
import styles from "./SettingsWindow.module.css";
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
    <column
      class={styles.sharedAxisPane}
      style={sharedAxisXStyle(progress(), props.direction, scheme() === "reduced")}
    >
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
    <row testId="settings-window-root" data-theme-rev={String(theme.revision())} class={styles.root}>
      <column testId="settings-sidebar" class={styles.sidebar}>
        <column class={styles.sidebarTop}>
          <row class={styles.brandHeader}>
            <box ariaHidden class={styles.brandBadge}>
              <ShellIcon name="shellEmblem" size={16} color="var(--color-on-primary-container)" />
            </box>
            <column class={styles.brandTextCol}>
              <text class={styles.brandTitle}>Settings</text>
              <text class={styles.brandSubtitle}>z-shell</text>
            </column>
          </row>

          <column class={styles.navSection}>
            <box class={styles.navSectionHeader}>
              <text class={styles.navSectionTitle}>SHELL</text>
            </box>
            <column class={styles.navTrack}>
              <SlidingNavPill activeIndex={activeShellIndex} />
              <For each={SHELL_NAV_TABS} keyed={tab => tab.id}>
                {tab => {
                  const active = () => activeTab() === tab().id;
                  return (
                    <Button
                      testId={`settings-nav-${tab().id}`}
                      data-qs-tile="true"
                      data-active={active() ? "true" : "false"}
                      selected={active()}
                      class={styles.navItem}
                      onClick={() => {
                        if (tab().id === "plugins") setSelectedPluginId(null);
                        openSettingsWindow(tab().id);
                      }}
                    >
                      <ShellIcon
                        name={tab().icon}
                        size={15}
                        color={active() ? "var(--color-on-primary-container)" : "var(--color-on-surface-variant)"}
                      />
                      <text class={styles.navLabel}>{tab().label}</text>
                      <Show when={tab().id === "plugins" && pluginUpdatesCount() > 0}>
                        <box class={styles.updatesBadge} data-active={active() ? "true" : "false"}>
                          <text data-tabular="true" class={styles.updatesBadgeText}>
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
            <box ariaHidden class={styles.sidebarDivider} />
            <column class={styles.navSection}>
              <box class={styles.navSectionHeader}>
                <text class={styles.navSectionTitle}>PLUGINS</text>
              </box>
              <column class={styles.navTrack}>
                <SlidingNavPill activeIndex={activePluginIndex} />
                <For each={pluginSettingsPages()} keyed={page => page.id}>
                  {page => {
                    const active = () => activeTab() === page().id;
                    return (
                      <Button
                        testId={`settings-nav-plugin-${page().id}`}
                        data-qs-tile="true"
                        data-active={active() ? "true" : "false"}
                        selected={active()}
                        class={styles.navItem}
                        onClick={() => openSettingsWindow(page().id)}
                      >
                        <ShellIcon
                          name="layers"
                          size={15}
                          color={active() ? "var(--color-on-primary-container)" : "var(--color-on-surface-variant)"}
                        />
                        <text class={styles.navLabel}>{page().title}</text>
                        <box ariaHidden class={styles.pluginDot} data-active={active() ? "true" : "false"} />
                      </Button>
                    );
                  }}
                </For>
              </column>
            </column>
          </Show>
        </column>

        <Button
          ariaLabel="Reload settings.toml"
          class={styles.reloadButton}
          onClick={() => void invokePublic("settings.reload", {})}
        >
          <box ariaHidden class={styles.reloadDot} />
          <text class={styles.reloadLabel}>settings.toml · Live</text>
        </Button>
      </column>

      <column testId="settings-content-pane" class={styles.contentPane}>
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
          <row class={styles.contentHeader}>
            <column class={styles.headerTextCol}>
              <text role="heading" class={styles.headerTitle}>
                {heading()}
              </text>
              <text class={styles.headerSubtitle}>{subtitle()}</text>
            </column>
            <Button
              testId="settings-window-close"
              ariaLabel="Close settings"
              class={styles.closeButton}
              onClick={closeSettingsWindow}
            >
              <ShellIcon name="close" size={15} color="var(--color-on-surface-variant)" />
            </Button>
          </row>
          <scroll class={styles.contentScroll}>
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
