import { PopupSurface, Show, createMemo, type NativeChild, type PopupSurfacePlacement } from "@hewel/zgui";
import { createEnterProgress, panelMotionStyle } from "../motion.ts";
import { useShellStore, type PanelId, type ShellStore } from "../store.ts";
import { useShellTheme } from "../theme.ts";
import type { BarPosition } from "../topics.ts";
import { BatteryPanel } from "./BatteryPanel.tsx";
import { CalendarPanel } from "./CalendarPanel.tsx";
import { ClipboardPanel } from "./ClipboardPanel.tsx";
import { MediaPanel } from "./MediaPanel.tsx";
import { QuickSettingsPanel } from "./QuickSettingsPanel.tsx";

const panels = {
  "quick-settings": { width: 396, height: 620, Component: QuickSettingsPanel },
  calendar: { width: 396, height: 620, Component: CalendarPanel },
  media: { width: 392, height: 302, Component: MediaPanel },
  battery: { width: 360, height: 400, Component: BatteryPanel },
  clipboard: { width: 560, height: 518, Component: ClipboardPanel },
};

function PanelContent(props: {
  id: PanelId;
  position: BarPosition;
  centered: boolean;
  theme: ShellStore["theme"];
  children: NativeChild;
}) {
  useShellTheme(props.theme.data);
  const progress = createEnterProgress();
  return (
    <box testId={`panel-root-${props.id}`} data-theme-rev={String(props.theme.revision())} style={{
      // Resolve percentages against the popup viewport, not the content-sized native root.
      position: "fixed",
      left: "0px",
      top: "0px",
      width: "100%",
      height: "100%",
      borderRadius: "24px",
      backgroundColor: "var(--color-surface)",
      border: "1px solid var(--color-outline-variant)",
      overflow: "hidden",
      fontFamily: "system-ui",
      ...panelMotionStyle(progress(), props.position, props.centered),
    }}>
      {props.children}
    </box>
  );
}

export function ShellPanels(): NativeChild {
  const { activePanelTarget, closePanels, theme, settings } = useShellStore();
  const popup = createMemo(() => {
    const target = activePanelTarget();
    if (!target?.parentSurface || target.id === "launcher" || target.id === "overview") return null;
    return { target, panel: panels[target.id] };
  });

  return (
    <Show when={popup()} keyed>
      {({ target, panel: { width, height, Component } }) => {
        const centered = target.id === "calendar" || target.id === "clipboard";
        const geometry = createMemo((): { placement: PopupSurfacePlacement; offset: { x: number; y: number } } => {
          switch (settings.data()?.bar.position) {
            case "left":
              return { placement: { anchor: "right", gravity: "right", flip: true, slide: true }, offset: { x: 8, y: 0 } };
            case "right":
              return { placement: { anchor: "left", gravity: "left", flip: true, slide: true }, offset: { x: -8, y: 0 } };
            default:
              return {
                placement: { anchor: centered ? "bottom" : "bottom-right", gravity: centered ? "bottom" : "bottom-left", flip: true, slide: true },
                offset: { x: 0, y: 8 },
              };
          }
        });
        const position = (): BarPosition => settings.data()?.bar.position ?? "top";
        return (
          <PopupSurface name={`panel-${target.id}`} parent={target.parentSurface} anchorRect={target.anchorRect}
            width={width} height={height} placement={geometry().placement} offset={geometry().offset} grab onDismiss={closePanels}>
            <PanelContent id={target.id} position={position()} centered={centered} theme={theme}><Component /></PanelContent>
          </PopupSurface>
        );
      }}
    </Show>
  );
}
