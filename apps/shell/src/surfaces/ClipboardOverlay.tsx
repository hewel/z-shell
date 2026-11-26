import { LayerSurface, Show, type NativeChild } from "@hewel/zgui";
import { createRetainedPresence, dialogMotionStyle, scrimBackdrop, useMotionScheme, type M3Spring } from "../motion.ts";
import { ClipboardPanel } from "../panels/ClipboardPanel.tsx";
import { useShellStore } from "../store.ts";
import { resolveActiveMonitor, resolveMonitorLogicalSize } from "../topics.ts";
import styles from "./ClipboardOverlay.module.css";

function ClipboardOverlayContent(props: {
  readonly inert: boolean;
  readonly spatial: M3Spring;
  readonly opacity: M3Spring;
}): NativeChild {
  const { closePanels, theme } = useShellStore();
  const dark = () => theme.data()?.dark ?? true;
  const scheme = useMotionScheme();

  return (
    <box
      testId="clipboard-backdrop"
      inert={props.inert}
      onClick={closePanels}
      class={styles.backdrop}
      style={{ backgroundColor: scrimBackdrop(45, props.opacity(), dark()) }}
    >
      <box
        testId="clipboard-card"
        role="dialog"
        ariaLabel="Clipboard"
        ariaModal
        onClick={event => event.stopPropagation()}
        class={styles.card}
        style={{ ...dialogMotionStyle(props.spatial(), { opacity: props.opacity(), reduced: scheme() === "reduced", fromScale: 0.95, fromY: 10 }) }}
      >
        <ClipboardPanel />
      </box>
    </box>
  );
}

export function ClipboardOverlay(): NativeChild {
  const { activePanel, activePanelTarget, activeMonitor, monitors, outputs, windows } = useShellStore();
  const scheme = useMotionScheme();
  const targetOutputId = () => {
    if (activePanel() !== "clipboard") return null;
    return resolveActiveMonitor(monitors(), {
      preferredMonitorId: activePanelTarget()?.monitorId,
      windows: windows.data(),
      outputs: outputs.data(),
      lastMonitorId: activeMonitor()?.id,
    })?.id ?? null;
  };
  const presence = createRetainedPresence(targetOutputId, {
    scheme,
    enterRole: "defaultSpatial",
    enterOpacityRole: "defaultEffects",
    exitRole: "fastEffects",
  });

  return (
    <Show when={presence.value()} keyed>
      {output => {
        const monitor = () => monitors().find(candidate => candidate.id === output);
        const size = () => {
          const current = monitor();
          return current ? resolveMonitorLogicalSize(current, outputs.data()) : { width: 1280, height: 720 };
        };
        return (
          <LayerSurface name="clipboard-overlay" output={output} layer="overlay"
            anchor={["top", "bottom", "left", "right"]} width={size().width} height={size().height}
            exclusiveZone={-1} keyboard="exclusive">
            <ClipboardOverlayContent inert={!presence.present()} spatial={presence.progress} opacity={presence.opacity} />
          </LayerSurface>
        );
      }}
    </Show>
  );
}
