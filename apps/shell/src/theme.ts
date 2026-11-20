import { createEffect, getSessionGeneration, mountShellStylesheet, onCleanup, type Accessor } from "@hewel/zgui";
import { SHELL_MOTION_CSS } from "./motion.ts";

export const SHOJI_DEFAULT_SCHEME = Object.freeze({
  surface: "#111318",
  surface_dim: "#111318",
  surface_bright: "#37393E",
  surface_container_lowest: "#0C0E13",
  surface_container_low: "#191C20",
  surface_container: "#1D2024",
  surface_container_high: "#272A2F",
  surface_container_highest: "#32353A",
  on_surface: "#E2E2E9",
  on_surface_variant: "#C3C6CF",
  inverse_surface: "#E2E2E9",
  inverse_on_surface: "#2E3036",
  outline: "#8D9199",
  outline_variant: "#43474E",
  scrim: "#000000",
  primary: "#A6C8FF",
  on_primary: "#08305F",
  primary_container: "#254777",
  on_primary_container: "#D4E3FF",
  secondary: "#BCC7DC",
  on_secondary: "#263141",
  secondary_container: "#3C4759",
  on_secondary_container: "#D6E3F8",
  tertiary: "#D8BDE4",
  on_tertiary: "#3C2947",
  tertiary_container: "#533F5F",
  on_tertiary_container: "#F5D9FF",
  error: "#FFB4AB",
  on_error: "#690005",
  error_container: "#93000A",
  on_error_container: "#FFDAD6",
});

export type ThemeColorScheme = Readonly<Record<keyof typeof SHOJI_DEFAULT_SCHEME, string>>;

export interface ThemeTopicSnapshot {
  readonly scheme: ThemeColorScheme;
  readonly dark: boolean;
  readonly variant?: string;
  readonly backend?: string;
  readonly last_error?: string | null;
}

const hexColor = /^#[0-9a-fA-F]{6}$/;
const roles = (Object.keys(SHOJI_DEFAULT_SCHEME) as (keyof ThemeColorScheme)[])
  .map(role => ({ role, property: `--color-${role.replaceAll("_", "-")}`, fallback: SHOJI_DEFAULT_SCHEME[role] }));

export function buildThemeStylesheet(scheme: ThemeColorScheme, dark: boolean): string {
  let css = `:root { color-scheme: ${dark ? "dark" : "light"};`;
  for (const { role, property, fallback } of roles) {
    const value = scheme?.[role];
    css += ` ${property}: ${typeof value === "string" && hexColor.test(value) ? value : fallback};`;
  }
  return `${css} }`;
}

const sessionThemes = new Map<number, {
  users: number;
  snapshot?: ThemeTopicSnapshot;
  css?: string;
  dispose?: () => void;
  disposeMotion?: () => void;
}>();

export function useShellTheme(theme: Accessor<ThemeTopicSnapshot | undefined>): void {
  const generation = getSessionGeneration();
  let session = sessionThemes.get(generation);
  if (session === undefined) {
    session = { users: 0, disposeMotion: mountShellStylesheet("z-shell-motion", SHELL_MOTION_CSS) };
    sessionThemes.set(generation, session);
  }
  const registration = session;
  registration.users++;
  // Existing surfaces and the shell root can share this registration. A
  // surface closing must not remove the stylesheet from the others.
  onCleanup(() => {
    if (--registration.users !== 0) return;
    sessionThemes.delete(generation);
    registration.dispose?.();
    registration.disposeMotion?.();
  });
  createEffect(theme, snapshot => {
    if (registration.css !== undefined && registration.snapshot === snapshot) return;
    const css = buildThemeStylesheet(snapshot?.scheme ?? SHOJI_DEFAULT_SCHEME, snapshot?.dark ?? true);
    if (css !== registration.css) {
      registration.dispose = mountShellStylesheet("z-shell-theme", css);
      registration.css = css;
    }
    registration.snapshot = snapshot;
  });
}
