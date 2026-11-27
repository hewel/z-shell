import {
  Show,
  WindowSurface,
  createEffect,
  createSignal,
  flush,
  onCleanup,
  untrack,
  type Accessor,
  type NativeChild,
} from "@hewel/zgui";
import {
  SPRING_EPSILON,
  createEnterProgress,
  createM3Spring,
  createOpacityEnter,
  useMotionScheme,
} from "../motion.ts";
import styles from "./window-chrome.module.css";

export const NAV_ITEM_PITCH = 37; // 34px item height + 3px column gap

/** M3 Fade Through wrapper for toplevel window detail panes (`opacity 0->1` + `translateY 6px->0`). */
export function FadeThroughPane(props: {
  readonly animate: boolean;
  readonly children: NativeChild;
}): NativeChild {
  const scheme = useMotionScheme();
  const fade = createOpacityEnter("defaultEffects", scheme);
  const rise = createEnterProgress("fastSpatial", { scheme });
  return (
    <box
      class={styles.fadeThroughPane}
      style={{
        opacity: props.animate ? Math.max(0, Math.min(1, fade())) : 1,
        transform: !props.animate || scheme() === "reduced"
          ? "none"
          : `translateY(${((1 - rise()) * 6).toFixed(2)}px)`,
      }}
    >
      {props.children}
    </box>
  );
}

/**
 * Velocity-preserving M3 `fast.spatial` sliding indicator pill for vertical sidebar nav tracks.
 * Supports dynamic nav lists where items may appear/disappear (e.g., optional GPU/plugin sections)
 * without stranding the pill out of range.
 */
export function SlidingNavPill(props: {
  readonly activeIndex: Accessor<number>;
  readonly itemCount?: Accessor<number>;
  readonly pitch?: number;
  readonly height?: number;
}): NativeChild {
  const scheme = useMotionScheme();
  const pitch = () => props.pitch ?? NAV_ITEM_PITCH;
  const height = () => props.height ?? 34;
  const clampedIndex = () => {
    const idx = props.activeIndex();
    if (idx < 0) return -1;
    const count = props.itemCount?.();
    if (count !== undefined && count > 0) {
      return Math.min(idx, count - 1);
    }
    return idx;
  };
  const pillY = createM3Spring(
    () => Math.max(0, clampedIndex()) * pitch(),
    "fastSpatial",
    { scheme, epsilon: SPRING_EPSILON.px },
  );
  const pillOpacity = createM3Spring(
    () => (clampedIndex() >= 0 ? 1 : 0),
    "fastEffects",
    { scheme },
  );
  return (
    <box
      ariaHidden
      class={styles.slidingNavPill}
      style={{
        height: `${height()}px`,
        opacity: Math.max(0, Math.min(1, pillOpacity())),
        transform: `translateY(${pillY().toFixed(2)}px)`,
      }}
    />
  );
}

/**
 * Single-instance XDG toplevel `WindowSurface` wrapper (`prefer-no-csd`, `decorations="none"`).
 * Preserves the deferred `queueMicrotask + flush()` close/unmount sequence so rapid close-then-reopen
 * never races native Wayland surface teardown and keeps a single toplevel instance.
 */
export function SingleInstanceWindowSurface(props: {
  readonly open: Accessor<boolean>;
  readonly onClose: () => void;
  readonly name: string;
  readonly title: string;
  readonly appId: string;
  readonly width?: number;
  readonly height?: number;
  readonly children: NativeChild;
}): NativeChild {
  const width = () => props.width ?? 820;
  const height = () => props.height ?? 600;
  const [surfaceMounted, setSurfaceMounted] = createSignal(untrack(() => props.open()));
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });
  createEffect(() => props.open(), open => {
    if (open) {
      setSurfaceMounted(true);
      return;
    }
    if (!surfaceMounted()) return;
    queueMicrotask(() => {
      if (!disposed && !props.open()) {
        setSurfaceMounted(false);
        flush();
      }
    });
  });

  return (
    <Show when={surfaceMounted()}>
      <WindowSurface
        name={props.name}
        title={props.title}
        appId={props.appId}
        width={width()}
        height={height()}
        minWidth={width()}
        minHeight={height()}
        resizable={false}
        decorations="none"
        onClose={props.onClose}
      >
        <Show when={props.open()}>
          {props.children}
        </Show>
      </WindowSurface>
    </Show>
  );
}
