import { For, LayerSurface, createEffect, createMemo, cx, focus, type NativeChild, type NativeNode } from "@hewel/zgui";
import { useShellStore } from "../store.ts";
import { formatSurfaceName, resolveMonitorLogicalSize } from "../topics.ts";
import styles from "./BarPopoverBackdrop.module.css";

/** Transparent top-layer outside-click & Escape catcher for ungrabbed bar popup handoffs. */
export function BarPopoverBackdrop(): NativeChild {
  const { monitors, outputs, ungrabbedBarPopupMonitorId, dismissOverlay } = useShellStore();
  const anyUngrabbed = createMemo(() => ungrabbedBarPopupMonitorId() !== null);
  return (
    <For each={monitors()} keyed={monitor => monitor.id}>
      {monitor => {
        let backdropNode: NativeNode | undefined;
        const isKeyboardOwner = createMemo(() => ungrabbedBarPopupMonitorId() === monitor().id);
        const size = createMemo(() => resolveMonitorLogicalSize(monitor(), outputs.data()));
        createEffect(isKeyboardOwner, ownsKeyboard => {
          if (ownsKeyboard && backdropNode) focus(backdropNode);
        });
        return (
          <LayerSurface
            name={formatSurfaceName("bar-backdrop", monitor().id)}
            output={monitor().id}
            layer="top"
            anchor={["top", "bottom", "left", "right"]}
            width={size().width}
            height={size().height}
            exclusiveZone={-1}
            inputRegion={anyUngrabbed() ? "full" : []}
            blurRegion="none"
            keyboard={isKeyboardOwner() ? "exclusive" : "none"}
          >
            <box
              ref={node => { backdropNode = node; }}
              testId={`bar-popover-backdrop-${monitor().id}`}
              data-active={anyUngrabbed() ? "true" : null}
              tabIndex={isKeyboardOwner() ? 0 : -1}
              onPointerDown={event => {
                if (!anyUngrabbed()) return;
                event.preventDefault();
                dismissOverlay();
              }}
              onClick={() => {
                if (anyUngrabbed()) dismissOverlay();
              }}
              onKeyDown={event => {
                if (anyUngrabbed() && event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  dismissOverlay();
                }
              }}
              class={cx(styles.backdrop)}
            />
          </LayerSurface>
        );
      }}
    </For>
  );
}
