import { PopupSurface, Show, createMemo, createSignal, untrack, type NativeChild, type NativeNode, type PopupSurfacePlacement } from "@hewel/zgui";
import {
  createRetainedPresence,
  panelMotionStyle,
  popoverContentMotionStyle,
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
import { SystemMonitorPanel } from "./SystemMonitorPanel.tsx";

const panels = {
  "quick-settings": { width: 396, maxHeight: PANEL_MAX_HEIGHTS["quick-settings"], Component: QuickSettingsPanel },
  calendar: { width: 396, maxHeight: PANEL_MAX_HEIGHTS.calendar, Component: CalendarPanel },
  media: { width: 396, maxHeight: PANEL_MAX_HEIGHTS.media, Component: MediaPanel },
  battery: { width: 396, maxHeight: PANEL_MAX_HEIGHTS.battery, Component: BatteryPanel },
  "system-monitor": { width: 396, maxHeight: PANEL_MAX_HEIGHTS["system-monitor"], Component: SystemMonitorPanel },
  clipboard: { width: 560, maxHeight: PANEL_MAX_HEIGHTS.clipboard, Component: ClipboardPanel },
};

/** Outer drawable shadow bleed for Level 2 popovers (`--shadow-level-2`: `0 10px 24px`). */
export const POPOVER_SHADOW_INSETS = { top: 20, right: 28, bottom: 38, left: 28 } as const;

export const POPOVER_BLEED_STYLE = {
  width: "100%",
  padding: `${POPOVER_SHADOW_INSETS.top}px ${POPOVER_SHADOW_INSETS.right}px ${POPOVER_SHADOW_INSETS.bottom}px ${POPOVER_SHADOW_INSETS.left}px`,
  boxSizing: "border-box",
  backgroundColor: "transparent",
} as const;

export const POPOVER_FRAME_STYLE = {
  width: "100%",
  borderRadius: "22px",
  backgroundColor: "var(--surface-popover)",
  border: "1px solid var(--border-popover)",
  boxShadow: "var(--shadow-level-2)",
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
  inert: boolean;
  theme: ShellStore["theme"];
  spatial: M3Spring;
  opacity: M3Spring;
  cardRef?: (node: NativeNode) => void;
  children: NativeChild;
}) {
  useShellTheme(props.theme.data);
  const scheme = useMotionScheme();
  return (
    <box inert={props.inert} style={POPOVER_BLEED_STYLE}>
      <box
        ref={props.cardRef}
        testId={`panel-root-${props.id}`}
        data-theme-rev={String(props.theme.revision())}
        style={{
          ...POPOVER_FRAME_STYLE,
          maxHeight: `${props.maxHeight}px`,
          ...panelMotionStyle(props.spatial(), props.position, props.centered, {
            opacity: props.opacity(),
            reduced: scheme() === "reduced",
          }),
        }}
      >
        <box style={{
          width: "100%",
          ...popoverContentMotionStyle(props.spatial(), props.opacity(), scheme() === "reduced"),
        }}>
          {props.children}
        </box>
      </box>
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
        const [cardNode, setCardNode] = createSignal<NativeNode | null>(null);
        return (
          <PopupSurface name={`panel-${target.id}`} parent={target.parentSurface} anchorRect={target.anchorRect}
            width={width} height="auto" minHeight={80} maxHeight={maxHeight}
            geometryInsets={POPOVER_SHADOW_INSETS}
            inputRegion={cardNode() ? [cardNode()!] : []}
            placement={geometry().placement} offset={geometry().offset} grab blurRegion={cardNode() ? [cardNode()!] : "none"} onDismiss={handleDismiss}>
            <PanelContent id={target.id} maxHeight={maxHeight} position={position()} centered={centered}
              inert={!presence.present()} theme={theme} spatial={presence.progress} opacity={presence.opacity} cardRef={setCardNode}>
              <Component />
            </PanelContent>
          </PopupSurface>
        );
      }}
    </Show>
  );
}
