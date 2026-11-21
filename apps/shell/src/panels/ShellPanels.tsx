import { PopupSurface, Show, createMemo, untrack, type NativeChild, type PopupSurfacePlacement } from "@hewel/zgui";
import {
  createRetainedPresence,
  panelMotionStyle,
  useMotionScheme,
  type M3Spring,
} from "../motion.ts";
import { useShellStore, type PanelId, type ShellStore } from "../store.ts";
import { useShellTheme } from "../theme.ts";
import { PANEL_MAX_HEIGHTS, type BarPosition, type BarStyle } from "../topics.ts";
import { BatteryPanel } from "./BatteryPanel.tsx";
import { CalendarPanel } from "./CalendarPanel.tsx";
import { ClipboardPanel } from "./ClipboardPanel.tsx";
import { MediaPanel } from "./MediaPanel.tsx";
import { QuickSettingsPanel } from "./QuickSettingsPanel.tsx";

const panels = {
  "quick-settings": { width: 396, maxHeight: PANEL_MAX_HEIGHTS["quick-settings"], Component: QuickSettingsPanel },
  calendar: { width: 396, maxHeight: PANEL_MAX_HEIGHTS.calendar, Component: CalendarPanel },
  media: { width: 396, maxHeight: PANEL_MAX_HEIGHTS.media, Component: MediaPanel },
  battery: { width: 396, maxHeight: PANEL_MAX_HEIGHTS.battery, Component: BatteryPanel },
  clipboard: { width: 560, maxHeight: PANEL_MAX_HEIGHTS.clipboard, Component: ClipboardPanel },
};

export const POPOVER_FRAME_STYLE = {
  width: "100%",
  borderRadius: "22px",
  backgroundColor: "var(--color-surface-container)",
  border: "1px solid color-mix(in srgb, var(--color-outline-variant) 55%, transparent)",
  overflow: "hidden",
  fontFamily: "var(--font-sans)",
} as const;

export function resolvePopoverGeometry(
  position: BarPosition,
  style: BarStyle,
  centered = false,
): { readonly placement: PopupSurfacePlacement; readonly offset: { readonly x: number; readonly y: number } } {
  const offsetPx = style === "docked" ? 10 : 12;
  switch (position) {
    case "left":
      // Bottom-align popovers triggered from the bottom-left Status Island (DESIGN.md D3/D10/D16).
      return {
        placement: centered
          ? { anchor: "right", gravity: "right", flip: true, slide: true }
          : { anchor: "bottom-right", gravity: "top-right", flip: true, slide: true },
        offset: { x: offsetPx, y: 0 },
      };
    case "right":
      return {
        placement: centered
          ? { anchor: "left", gravity: "left", flip: true, slide: true }
          : { anchor: "bottom-left", gravity: "top-left", flip: true, slide: true },
        offset: { x: -offsetPx, y: 0 },
      };
    default:
      return {
        placement: { anchor: centered ? "bottom" : "bottom-right", gravity: centered ? "bottom" : "bottom-left", flip: true, slide: true },
        offset: { x: 0, y: offsetPx },
      };
  }
}

function PanelContent(props: {
  id: PanelId;
  maxHeight: number;
  position: BarPosition;
  centered: boolean;
  theme: ShellStore["theme"];
  spatial: M3Spring;
  opacity: M3Spring;
  children: NativeChild;
}) {
  useShellTheme(props.theme.data);
  const scheme = useMotionScheme();
  return (
    <box testId={`panel-root-${props.id}`} data-theme-rev={String(props.theme.revision())} style={{
      ...POPOVER_FRAME_STYLE,
      maxHeight: `${props.maxHeight}px`,
      ...panelMotionStyle(props.spatial(), props.position, props.centered, {
        opacity: props.opacity(),
        reduced: scheme() === "reduced",
      }),
    }}>
      {props.children}
    </box>
  );
}

export function ShellPanels(): NativeChild {
  const { activePanelTarget, closePanels, theme, settings } = useShellStore();
  const scheme = useMotionScheme();
  const popup = createMemo(() => {
    const target = activePanelTarget();
    if (!target?.parentSurface || target.id === "launcher" || target.id === "overview") return null;
    return { target, panel: panels[target.id] };
  });
  const presence = createRetainedPresence(popup, {
    scheme,
    enterRole: "defaultSpatial",
    enterOpacityRole: "fastEffects",
    exitRole: "fastEffects",
  });
  const mountedKey = createMemo(() => {
    const entry = presence.value();
    return entry ? `${entry.target.id}:${entry.target.parentSurface}` : null;
  });

  return (
    <Show when={mountedKey()} keyed>
      {_key => {
        const entry = untrack(() => presence.value()!);
        const { target, panel: { width, maxHeight, Component } } = entry;
        const centered = target.id === "calendar" || target.id === "clipboard";
        const position = (): BarPosition => settings.data()?.bar.position ?? "top";
        const barStyle = (): BarStyle => settings.data()?.bar.style ?? "floating";
        const geometry = createMemo(() => resolvePopoverGeometry(position(), barStyle(), centered));
        const handleDismiss = () => {
          presence.dismissInstant();
          closePanels();
        };
        return (
          <PopupSurface name={`panel-${target.id}`} parent={target.parentSurface} anchorRect={target.anchorRect}
            width={width} height="auto" minHeight={80} maxHeight={maxHeight}
            placement={geometry().placement} offset={geometry().offset} grab onDismiss={handleDismiss}>
            <PanelContent id={target.id} maxHeight={maxHeight} position={position()} centered={centered}
              theme={theme} spatial={presence.progress} opacity={presence.opacity}>
              <Component />
            </PanelContent>
          </PopupSurface>
        );
      }}
    </Show>
  );
}
