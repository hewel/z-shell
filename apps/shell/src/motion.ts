import { createSignal, createSpring, onSettled, type Accessor, type SpringOptions } from "@hewel/zgui";
import type { BarPosition } from "./topics.ts";

export interface MotionStyle {
  readonly opacity: number;
  readonly transform: string;
  readonly transformOrigin: string;
}

export const PANEL_SPRING: SpringOptions = { stiffness: 380, damping: 30 };
export const DIALOG_SPRING: SpringOptions = { stiffness: 360, damping: 29 };
export const DOCK_SPRING: SpringOptions = { stiffness: 320, damping: 28 };
export const TOAST_SPRING: SpringOptions = { stiffness: 360, damping: 30 };

export const SHELL_MOTION_CSS = `
[data-dock-item] {
  transition-property: transform, background-color;
  transition-duration: 180ms;
  transition-timing-function: cubic-bezier(0.2, 0.9, 0.3, 1.15);
}
[data-dock-item]:hover {
  transform: translateY(-6px) scale(1.1);
}
[data-dock-item]:active {
  transform: translateY(-2px) scale(0.92);
}
[data-ws-pill] {
  transition-property: width, height, background-color, opacity;
  transition-duration: 220ms;
  transition-timing-function: cubic-bezier(0.2, 0.9, 0.3, 1.1);
}
[data-qs-tile] {
  transition-property: background-color, transform;
  transition-duration: 180ms;
  transition-timing-function: cubic-bezier(0.2, 0, 0, 1);
}
[data-qs-tile]:active {
  transform: scale(0.98);
}
[data-percent-fill] {
  transition-property: width;
  transition-duration: 110ms;
  transition-timing-function: ease-out;
}
[data-switch-track] {
  transition-property: background-color;
  transition-duration: 160ms;
  transition-timing-function: ease;
}
`;

export function createEnterProgress(options: SpringOptions = PANEL_SPRING): Accessor<number> {
  const [target, setTarget] = createSignal(0);
  const progress = createSpring(target, options);
  onSettled(() => { setTarget(1); });
  return progress;
}

export function panelMotionStyle(
  progress: number,
  position: BarPosition = "top",
  centered = false,
): MotionStyle {
  const clamped = Math.max(0, Math.min(1, progress));
  const opacity = Math.max(0, Math.min(1, clamped * 1.35));
  const remaining = 1 - clamped;
  const scale = 0.95 + clamped * 0.05;
  switch (position) {
    case "left":
      return {
        opacity,
        transform: `translateX(${(-10 * remaining).toFixed(2)}px) scale(${scale.toFixed(4)})`,
        transformOrigin: "left center",
      };
    case "right":
      return {
        opacity,
        transform: `translateX(${(10 * remaining).toFixed(2)}px) scale(${scale.toFixed(4)})`,
        transformOrigin: "right center",
      };
    default:
      return {
        opacity,
        transform: `translateY(${(-10 * remaining).toFixed(2)}px) scale(${scale.toFixed(4)})`,
        transformOrigin: centered ? "top center" : "top right",
      };
  }
}

export function scrimBackdrop(maxPercent: number, progress: number): string {
  const pct = (maxPercent * Math.max(0, Math.min(1, progress))).toFixed(1);
  return `color-mix(in srgb, var(--color-scrim) ${pct}%, transparent)`;
}

export function dialogMotionStyle(progress: number): MotionStyle {
  const opacity = Math.max(0, Math.min(1, progress * 1.4));
  const scale = 0.92 + progress * 0.08;
  const offsetY = (1 - progress) * 18;
  return {
    opacity,
    transform: `translateY(${offsetY.toFixed(2)}px) scale(${scale.toFixed(4)})`,
    transformOrigin: "center",
  };
}
