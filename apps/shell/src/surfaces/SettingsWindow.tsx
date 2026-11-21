import {
  Button, For, Match, Show, Switch, WindowSurface,
  createEffect, createSignal, flush,
  type NativeChild,
} from "@hewel/zgui";
import { ShellIcon, type ShellIconName } from "../icons.tsx";
import {
  SPRING_EPSILON,
  createEnterProgress,
  createM3Spring,
  createOpacityEnter,
  useMotionScheme,
} from "../motion.ts";
import { useShellStore } from "../store.ts";
import { useShellTheme } from "../theme.ts";
import { AppearancePane } from "./settings/AppearancePane.tsx";
import { BarLayoutPane } from "./settings/BarLayoutPane.tsx";
import { IdlePane } from "./settings/IdlePane.tsx";
import { PowerPane } from "./settings/PowerPane.tsx";
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

type ShellNavTab = {
  readonly id: "appearance" | "bar" | "idle" | "power";
  readonly label: string;
  readonly subtitle: string;
  readonly icon: ShellIconName;
};

const NAV_ITEM_PITCH = 37; // 34px item height + 3px column gap

const SHELL_NAV_TABS: readonly ShellNavTab[] = [
  { id: "appearance", label: "Appearance", subtitle: "Dynamic Material 3 HCT palette & motion physics synced to settings.toml", icon: "palette" },
  { id: "bar", label: "Bar & layout", subtitle: "Wayland layer-shell edge strut, spacing rhythm, and visible modules", icon: "overview" },
  { id: "idle", label: "Idle & sleep", subtitle: "Automatic actions pause while media is playing · Declarative rules", icon: "sleep" },
  { id: "power", label: "Power & battery", subtitle: "UPower telemetry, power-profiles-daemon switching, and system load", icon: "batteryCharging" },
];

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

function SlidingNavPill(props: { readonly activeIndex: () => number }): NativeChild {
  const scheme = useMotionScheme();
  const pillY = createM3Spring(() => Math.max(0, props.activeIndex()) * NAV_ITEM_PITCH, "fastSpatial", {
    scheme,
    epsilon: SPRING_EPSILON.px,
  });
  const pillOpacity = createM3Spring(() => (props.activeIndex() >= 0 ? 1 : 0), "fastEffects", { scheme });
  return (
    <box ariaHidden style={{
      position: "absolute", top: "0px", left: "0px", right: "0px", height: "34px", borderRadius: "10px",
      backgroundColor: primaryContainer,
      border: "1px solid color-mix(in srgb, var(--color-primary) 30%, transparent)",
      pointerEvents: "none",
      opacity: Math.max(0, Math.min(1, pillOpacity())),
      transform: `translateY(${pillY().toFixed(2)}px)`,
    }} />
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
                    <Button testId={`settings-nav-${tab().id}`} data-qs-tile="true" selected={active()} onClick={() => openSettingsWindow(tab().id)} style={{
                      position: "relative", zIndex: 1,
                      display: "flex", flexDirection: "row", alignItems: "center", gap: "9px", height: "34px",
                      padding: "0 10px", borderRadius: "10px", flexShrink: 0,
                      backgroundColor: "transparent", border: "1px solid transparent",
                      color: active() ? onPrimaryContainer : muted, fontSize: "13px", fontWeight: 500,
                    }}>
                      <ShellIcon name={tab().icon} size={15} color={active() ? onPrimaryContainer : muted} />
                      <text style={clipped}>{tab().label}</text>
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
                        <ShellIcon name="layers" size={15} color={active() ? onPrimaryContainer : muted} />
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
