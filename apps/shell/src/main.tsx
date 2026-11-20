import * as stylex from "@stylexjs/stylex";
import { For, LayerSurface, renderShell } from "@hewel/zgui";
import { createShellStore, ShellProvider, useShellStore } from "./store.ts";
import { useShellTheme } from "./theme.ts";

const barHeight = 48;

const styles = stylex.create({
  surround: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "100%",
    height: "48px",
  },
  pill: {
    alignItems: "center",
    gap: "var(--spacing-10)",
    height: "36px",
    paddingInline: "var(--spacing-14)",
    borderRadius: "var(--radius-pill)",
    backgroundColor: "var(--color-surface-container)",
    color: "var(--color-on-surface)",
    // The shipped preview font manifest registers system-ui, not the Shoji font families.
    fontFamily: "system-ui",
    fontSize: "var(--text-14)",
  },
  badge: {
    paddingInline: "var(--spacing-8)",
    paddingBlock: "2px",
    borderRadius: "var(--radius-pill)",
    backgroundColor: "var(--color-surface-container-high)",
    color: "var(--color-on-surface-variant)",
    fontSize: "var(--text-12)",
  },
  ready: {
    backgroundColor: "var(--color-secondary-container)",
    color: "var(--color-on-secondary-container)",
  },
  swatch: {
    width: "var(--spacing-12)",
    height: "var(--spacing-12)",
    borderRadius: "var(--radius-pill)",
    backgroundColor: "var(--color-primary)",
  },
});

function Bar() {
  const { publicStatus, theme } = useShellStore();
  useShellTheme(theme.data);
  return (
    <box {...stylex.props(styles.surround)} data-theme-rev={String(theme.revision())}>
      <row {...stylex.props(styles.pill)}>
        <text>z-shell</text>
        <text {...stylex.props(styles.badge, publicStatus() === "ready" && styles.ready)} testId="daemon-status">
          {publicStatus()}
        </text>
        <box {...stylex.props(styles.swatch)} testId="theme-accent" />
      </row>
    </box>
  );
}

function ShellApp() {
  const store = createShellStore();
  const { monitors } = store;
  return (
    <ShellProvider value={store}>
      <For each={monitors()} keyed={monitor => monitor.id}>
        {monitor => (
          <LayerSurface
            name={`bar-${monitor().id}`}
            output={monitor().id}
            layer="top"
            anchor={["top", "left", "right"]}
            width={monitor().width}
            height={barHeight}
            exclusiveZone={barHeight}
          >
            <Bar />
          </LayerSurface>
        )}
      </For>
    </ShellProvider>
  );
}

export const hostApiVersion = 1;

export function mount(): () => void {
  return renderShell(() => <ShellApp />);
}
