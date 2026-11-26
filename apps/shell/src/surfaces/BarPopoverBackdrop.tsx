import { For, LayerSurface, createEffect, createMemo, cx, focus, type NativeChild, type NativeNode } from "@hewel/zgui";
import { useShellStore } from "../store.ts";
import { formatSurfaceName, resolveMonitorLogicalSize } from "../topics.ts";
import styles from "./BarPopoverBackdrop.module.css";

/** Transparent top-layer outside-click & Escape catcher for ungrabbed bar popup handoffs. */
export function BarPopoverBackdrop(): NativeChild {
  const { monitors, outputs, ungrabbedBarPopupMonitorId, dismissOverlay } = useShellStore();
  return (
    <For each={monitors()} keyed={monitor => monitor.id}>
      {monitor => {
        let backdropNode: NativeNode | undefined;
        const active = createMemo(() => ungrabbedBarPopupMonitorId() === monitor().id);
        const size = createMemo(() => resolveMonitorLogicalSize(monitor(), outputs.data()));
        createEffect(active, isActive => {
          if (isActive && backdropNode) focus(backdropNode);
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
            inputRegion={active() ? "full" : []}
            blurRegion="none"
            keyboard={active() ? "exclusive" : "none"}
          >
            <box
              ref={node => { backdropNode = node; }}
              testId={`bar-popover-backdrop-${monitor().id}`}
              data-active={active() ? "true" : null}
              tabIndex={active() ? 0 : -1}
              onPointerDown={event => {
                if (!active()) return;
                event.preventDefault();
                dismissOverlay();
              }}
              onClick={() => {
                if (active()) dismissOverlay();
              }}
              onKeyDown={event => {
                if (active() && event.key === "Escape") {
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
