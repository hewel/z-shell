import { Button, For, Image, LayerSurface, Show, TextField, createEffect, createMemo, createSignal, cx, flush, focus, onCleanup, scrollIntoView, type Accessor, type NativeChild, type NativeKeyEvent, type NativeNode } from "@hewel/zgui";
import { createVirtualFocus } from "@hewel/zgui/primitives";
import { useDaemonMedia } from "@z-shell/sdk/zgui";
import { ShellIcon } from "../icons.tsx";
import { SPRING_EPSILON, createM3Spring, createRetainedPresence, dialogMotionStyle, scrimBackdrop, useMotionScheme, type M3Spring } from "../motion.ts";
import { useShellStore } from "../store.ts";
import { resolveActiveMonitor, resolveMonitorLogicalSize, type LauncherItem, type LauncherQueryResponse } from "../topics.ts";
import styles from "./LauncherOverlay.module.css";

const columns = 6;
const iconTints = ["primary", "secondary", "tertiary"] as const;

function LauncherTile(props: {
  item: Accessor<LauncherItem>;
  selected: boolean;
  registerNode: (node: NativeNode) => void;
  activate: (item: LauncherItem) => void;
}): NativeChild {
  const { hostClient } = useShellStore();
  const { item } = props;
  const { src } = useDaemonMedia(hostClient, () => item().icon, { fetchCommand: "launcher.fetch-blob" });
  const letter = () => item().title.trim().codePointAt(0);
  const initial = () => {
    const code = letter();
    return code === undefined ? "?" : String.fromCodePoint(code).toUpperCase();
  };
  const tint = () => iconTints[(letter() ?? 0) % iconTints.length];

  return (
    <Button
      ref={props.registerNode}
      testId={`launcher-item-${item().provider_id}-${item().item_id}`}
      tabIndex={-1}
      selected={props.selected}
      data-selected={props.selected ? "true" : null}
      onClick={() => props.activate(item())}
      class={styles.tile}
    >
      <column data-press-visual="card" class={styles.tileInner}>
        <Show when={src()} fallback={
          <box
            class={styles.iconFallback}
            data-tint={props.selected ? null : tint()}
            data-selected={props.selected ? "true" : "false"}
          >
            <text class={styles.iconInitial}>{initial()}</text>
          </box>
        }>
          {image => <Image src={image()} class={styles.iconImage} />}
        </Show>
        <text data-selected={props.selected ? "true" : "false"} class={styles.tileTitle}>{item().title}</text>
        <Show when={item().provider_id !== "desktop"}>
          <text class={styles.tileProvider}>{item().provider_id}</text>
        </Show>
      </column>
    </Button>
  );
}

function LauncherContent(props: {
  allocateQueryId: () => number;
  inert: boolean;
  spatial: M3Spring;
  opacity: M3Spring;
}): NativeChild {
  const { publicClient, invokePublic, closePanels, theme } = useShellStore();
  const dark = () => theme.data()?.dark ?? true;
  const [query, setQuery] = createSignal("");
  const [results, setResults] = createSignal<LauncherQueryResponse>();
  const [searchFocused, setSearchFocused] = createSignal(false);
  const items = () => results()?.items ?? [];
  const itemKey = (item: LauncherItem) => `${item.provider_id}:${item.item_id}`;
  const resolvedQueryId = () => results()?.query_id;
  let latestQueryId = 0;
  let disposed = false;
  onCleanup(() => { disposed = true; });
  function dismiss(): void {
    // Detach the grid and its images before retiring the native layer.
    flush(() => setResults(undefined));
    closePanels();
  }

  function activateItem(item: LauncherItem): void {
    if (resolvedQueryId() !== latestQueryId) return;
    void invokePublic("launcher.activate", {
      query_id: resolvedQueryId(), provider_id: item.provider_id, item_id: item.item_id,
    });
    dismiss();
  }

  const virtualFocus = createVirtualFocus({
    items,
    getId: itemKey,
    columns,
    textValue: query,
    onActivate: activateItem,
    onReveal: () => {
      const node = virtualFocus.activeNode();
      if (node) scrollIntoView(node, { block: "nearest" });
    },
  });

  // A panel opened during bus.hello also needs its initial results once the bus is ready.
  createEffect(() => ({ text: query(), client: publicClient() }), ({ text }) => {
    const id = props.allocateQueryId();
    latestQueryId = id;
    // Retain existing tiles while the next query resolves so icons do not flash on every keystroke;
    // activateItem checks `resolvedQueryId() === latestQueryId` to preserve daemon query_id validity.
    void invokePublic("launcher.query", { query: text, query_id: id, limit: 18 }).then(result => {
      if (disposed || id !== latestQueryId) return;
      const data = result?.data as LauncherQueryResponse | undefined;
      if (!data || (data.query_id !== undefined && data.query_id !== id)) return;
      setResults({ query_id: id, items: data.items });
      const first = data.items[0];
      virtualFocus.setActive(first ? itemKey(first) : null);
    });
  });

  function handleKeyDown(event: NativeKeyEvent): void {
    if (event.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      dismiss();
      return;
    }
    flush(() => virtualFocus.onKeyDown(event));
  }

  const scheme = useMotionScheme();
  const activeIndex = createMemo(() => {
    const activeId = virtualFocus.activeId();
    if (activeId === null) return -1;
    return items().findIndex(item => itemKey(item) === activeId);
  });
  const hasSelection = () => activeIndex() >= 0;
  const clampedSelection = () => Math.max(0, activeIndex());
  const highlightX = createM3Spring(() => (clampedSelection() % columns) * 102, "fastSpatial", { scheme, epsilon: SPRING_EPSILON.px });
  const highlightY = createM3Spring(() => Math.floor(clampedSelection() / columns) * 100, "fastSpatial", { scheme, epsilon: SPRING_EPSILON.px });
  const highlightOpacity = createM3Spring(() => (hasSelection() ? 1 : 0), "fastEffects", { scheme });

  return (
    <box
      testId="launcher-backdrop"
      inert={props.inert}
      onClick={dismiss}
      class={styles.backdrop}
      style={{ backgroundColor: scrimBackdrop(45, props.opacity(), dark()) }}
    >
      <box
        testId="launcher-card"
        role="dialog"
        ariaLabel="Launcher"
        ariaModal
        onClick={event => event.stopPropagation()}
        class={styles.card}
        style={{ ...dialogMotionStyle(props.spatial(), { opacity: props.opacity(), reduced: scheme() === "reduced", fromScale: 0.95, fromY: 10 }) }}
      >
        <row
          testId="launcher-search-bar"
          data-composite-input="true"
          data-focused={searchFocused() ? "true" : "false"}
          class={styles.searchBar}
        >
          <ShellIcon name="search" size={20} color={searchFocused() ? "var(--color-primary)" : "var(--color-on-surface-variant)"} />
          <TextField
            testId="launcher-search"
            class={cx(styles.searchField, "shell-composite-field")}
            placeholder="Search apps"
            value={query()}
            ariaActiveDescendant={virtualFocus.activeNode()}
            onInput={event => setQuery(event.value)}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
            onKeyDown={handleKeyDown}
            ref={node => focus(node)}
          />
          <box testId="launcher-esc-badge" ariaHidden class={styles.escBadge}>
            <text testId="launcher-esc-text" class={styles.escText}>
              Esc
            </text>
          </box>
        </row>
        <scroll class={styles.resultsScroll}>
          <Show when={items().length > 0 || results() === undefined} fallback={
            <column testId="launcher-empty" class={styles.emptyState}>
              <ShellIcon name="search" size={22} color="var(--color-on-surface-variant)" />
              <text class={styles.emptyTitle}>No matching apps</text>
              <text class={styles.emptyHint}>Press Esc to clear search</text>
            </column>
          }>
            <row class={styles.grid}>
              <box
                ariaHidden
                class={styles.highlight}
                style={{
                  opacity: Math.max(0, Math.min(1, highlightOpacity())),
                  transform: `translate(${highlightX().toFixed(2)}px, ${highlightY().toFixed(2)}px)`,
                }}
              />
              <For each={items()} keyed={itemKey}>
                {item => (
                  <LauncherTile
                    item={item}
                    selected={virtualFocus.activeId() === itemKey(item())}
                    registerNode={node => { virtualFocus.register(itemKey(item()), node); }}
                    activate={activateItem}
                  />
                )}
              </For>
            </row>
          </Show>
        </scroll>
        <row class={styles.footer}>
          <text class={styles.footerText}>
            ↑↓←→ Move · Enter Launch · Esc Close
          </text>
          <text data-tabular="true" class={styles.footerCount}>
            {items().length} apps
          </text>
        </row>
      </box>
    </box>
  );
}

export function LauncherOverlay(): NativeChild {
  const { activePanel, activePanelTarget, activeMonitor, monitors, outputs, windows } = useShellStore();
  const scheme = useMotionScheme();
  const targetOutputId = () => {
    if (activePanel() !== "launcher") return null;
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
  // IDs must keep increasing on the same bus connection, including after reopening the overlay.
  let nextQueryId = 1;
  const allocateQueryId = () => nextQueryId++;

  return (
    <Show when={presence.value()} keyed>
      {output => {
        const monitor = () => monitors().find(candidate => candidate.id === output);
        const size = () => {
          const current = monitor();
          return current ? resolveMonitorLogicalSize(current, outputs.data()) : { width: 1280, height: 720 };
        };
        return (
          <LayerSurface name="launcher-overlay" output={output} layer="overlay"
            anchor={["top", "bottom", "left", "right"]} width={size().width} height={size().height}
            exclusiveZone={-1} keyboard="exclusive">
            <LauncherContent allocateQueryId={allocateQueryId} inert={!presence.present()} spatial={presence.progress} opacity={presence.opacity} />
          </LayerSurface>
        );
      }}
    </Show>
  );
}
