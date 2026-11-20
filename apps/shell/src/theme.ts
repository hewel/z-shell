import { createEffect, getOwner, mountStylesheet, runWithOwner, type Accessor } from "@hewel/zgui";

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

export function useShellTheme(theme: Accessor<ThemeTopicSnapshot | undefined>): void {
  const surfaceOwner = getOwner();
  createEffect(
    () => {
      const snapshot = theme();
      return buildThemeStylesheet(snapshot?.scheme ?? SHOJI_DEFAULT_SCHEME, snapshot?.dark ?? true);
    },
    css => {
      // Preserve the enclosing surface Region owner so mountStylesheet binds to this surface's bridge
      // and registers idempotent removal on surface unmount.
      runWithOwner(surfaceOwner, () => {
        mountStylesheet("z-shell-theme", css);
      });
    },
  );
}
