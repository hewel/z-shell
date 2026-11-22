import { Button, For, Image, LayerSurface, Show, TextField, createEffect, createSignal, flush, focus, onCleanup, type Accessor, type NativeChild, type NativeKeyEvent } from "@hewel/zgui";
import { useDaemonMedia } from "@z-shell/sdk/zgui";
import { ShellIcon } from "../icons.tsx";
import { SPRING_EPSILON, createM3Spring, createRetainedPresence, dialogMotionStyle, scrimBackdrop, useMotionScheme, type M3Spring } from "../motion.ts";
import { useShellStore } from "../store.ts";
import { resolveActiveMonitor, resolveMonitorLogicalSize, type LauncherItem, type LauncherQueryResponse } from "../topics.ts";

const columns = 6;
const iconTile = { width: "44px", height: "44px", flexShrink: 0, borderRadius: "10px" } as const;
const iconTints = ["primary", "secondary", "tertiary"] as const;
const clipped = { maxWidth: "100%", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } as const;

function LauncherTile(props: { item: Accessor<LauncherItem>; selected: boolean; activate: (item: LauncherItem) => void }): NativeChild {
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
    <Button testId={`launcher-item-${item().provider_id}-${item().item_id}`} tabIndex={-1}
      data-selected={props.selected ? "true" : null} onClick={() => props.activate(item())} style={{
        position: "relative", zIndex: 1,
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
        width: "96px", height: "94px", flexShrink: 0, borderRadius: "14px", padding: "8px",
        backgroundColor: "transparent",
        border: "1px solid transparent",
        color: props.selected ? "var(--color-on-primary-container)" : "var(--color-on-surface)",
      }}>
      <column data-press-visual="card" style={{ alignItems: "center", justifyContent: "center", gap: "6px", maxWidth: "100%" }}>
        <Show when={src()} fallback={
          <box style={{
            ...iconTile, display: "flex", alignItems: "center", justifyContent: "center",
            backgroundColor: props.selected ? "var(--color-surface-container-highest)" : `var(--color-${tint()}-container)`,
            color: props.selected ? "var(--color-on-surface)" : `var(--color-on-${tint()}-container)`,
            border: props.selected
              ? "1px solid color-mix(in srgb, var(--color-outline-variant) 75%, transparent)"
              : "1px solid color-mix(in srgb, var(--color-outline-variant) 28%, transparent)",
          }}>
            <text style={{ fontSize: "20px", fontWeight: 600 }}>{initial()}</text>
          </box>
        }>
          {image => <Image src={image()} style={{ ...iconTile, objectFit: "contain" }} />}
        </Show>
        <text style={{ ...clipped, fontSize: "12px", lineHeight: "15px", fontWeight: props.selected ? 600 : 500 }}>{item().title}</text>
        <Show when={item().provider_id !== "desktop"}>
          <text style={{ ...clipped, fontSize: "10px", lineHeight: "12px", color: "var(--color-on-surface-variant)" }}>{item().provider_id}</text>
        </Show>
      </column>
    </Button>
  );
}

function LauncherContent(props: {
  allocateQueryId: () => number;
  spatial: M3Spring;
  opacity: M3Spring;
}): NativeChild {
  const { publicClient, invokePublic, closePanels, theme } = useShellStore();
  const dark = () => theme.data()?.dark ?? true;
  const [query, setQuery] = createSignal("");
  const [results, setResults] = createSignal<LauncherQueryResponse>();
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  const [searchFocused, setSearchFocused] = createSignal(false);
  const items = () => results()?.items ?? [];
  const resolvedQueryId = () => results()?.query_id;
  let latestQueryId = 0;
  let disposed = false;
  onCleanup(() => { disposed = true; });
  function dismiss(): void {
    // Detach the grid and its images before retiring the native layer.
    flush(() => setResults(undefined));
    closePanels();
  }

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
      setSelectedIndex(0);
    });
  });

  function activateItem(item: LauncherItem): void {
    if (resolvedQueryId() !== latestQueryId) return;
    void invokePublic("launcher.activate", {
      query_id: resolvedQueryId(), provider_id: item.provider_id, item_id: item.item_id,
    });
    dismiss();
  }

  function handleKeyDown(event: NativeKeyEvent): void {
    let delta: number;
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        dismiss();
        return;
      case "Enter": {
        event.preventDefault();
        const item = items()[selectedIndex()];
        if (item) activateItem(item);
        return;
      }
      case "ArrowRight": delta = 1; break;
      case "ArrowLeft": delta = -1; break;
      case "ArrowDown": delta = columns; break;
      case "ArrowUp": delta = -columns; break;
      default: return;
    }
    event.preventDefault();
    // Commit the selection before the next native key handler reads it.
    flush(() => setSelectedIndex(index => Math.max(0, Math.min(index + delta, items().length - 1))));
  }

  const scheme = useMotionScheme();
  const hasSelection = () => items().length > 0;
  const clampedSelection = () => Math.max(0, Math.min(selectedIndex(), Math.max(0, items().length - 1)));
  const highlightX = createM3Spring(() => (clampedSelection() % columns) * 102, "fastSpatial", { scheme, epsilon: SPRING_EPSILON.px });
  const highlightY = createM3Spring(() => Math.floor(clampedSelection() / columns) * 100, "fastSpatial", { scheme, epsilon: SPRING_EPSILON.px });
  const highlightOpacity = createM3Spring(() => (hasSelection() ? 1 : 0), "fastEffects", { scheme });

  return (
    <box testId="launcher-backdrop" onClick={dismiss} style={{
      position: "fixed", left: "0px", top: "0px", width: "100%", height: "100%",
      display: "flex", alignItems: "center", justifyContent: "center",
      backgroundColor: scrimBackdrop(45, props.opacity(), dark()),
    }}>
      <box testId="launcher-card" role="dialog" ariaLabel="Launcher" ariaModal onClick={event => event.stopPropagation()} style={{
        display: "flex", flexDirection: "column", width: "652px", height: "410px", borderRadius: "22px",
        backgroundColor: "var(--color-surface-container)",
        border: "1px solid color-mix(in srgb, var(--color-outline-variant) 55%, transparent)",
        boxShadow: "var(--shadow-level-3)",
        padding: "18px", gap: "14px", fontFamily: "var(--font-sans)", color: "var(--color-on-surface)",
        ...dialogMotionStyle(props.spatial(), { opacity: props.opacity(), reduced: scheme() === "reduced", fromScale: 0.95, fromY: 10 }),
      }}>
        <row testId="launcher-search-bar" data-composite-input="true" style={{
          width: "100%", height: "46px", borderRadius: "14px", padding: searchFocused() ? "0 11px 0 13px" : "0 12px 0 14px", gap: "10px",
          alignItems: "center", flexShrink: 0, backgroundColor: "var(--color-surface-container-high)",
          border: searchFocused()
            ? "2px solid var(--color-primary)"
            : "1px solid color-mix(in srgb, var(--color-outline-variant) 45%, transparent)",
        }}>
          <ShellIcon name="search" size={20} color={searchFocused() ? "var(--color-primary)" : "var(--color-on-surface-variant)"} />
          <TextField testId="launcher-search" class="shell-composite-field" placeholder="Search apps" value={query()}
            onInput={event => setQuery(event.value)}
            onFocus={() => setSearchFocused(true)} onBlur={() => setSearchFocused(false)}
            onKeyDown={handleKeyDown} ref={node => focus(node)} style={{
              flexGrow: 1, flexBasis: "0px", minWidth: "0px", height: "38px",
              padding: "9px 0", lineHeight: "20px", backgroundColor: "transparent",
              color: "var(--color-on-surface)", fontSize: "14px",
            }} />
          <box ariaHidden style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            height: "22px", padding: "0 7px", borderRadius: "6px", flexShrink: 0,
            backgroundColor: "var(--color-surface-container-highest)",
          }}>
            <text style={{
              fontFamily: "var(--font-mono)", fontSize: "10px", lineHeight: "12px", fontWeight: 500,
              color: "var(--color-on-surface-variant)",
            }}>
              Esc
            </text>
          </box>
        </row>
        <scroll style={{ flexGrow: 1, width: "100%", overflow: "hidden auto" }}>
          <row style={{ position: "relative", width: "100%", flexWrap: "wrap", gap: "6px", justifyContent: "flex-start" }}>
            <box ariaHidden style={{
              position: "absolute", top: "0px", left: "0px", width: "96px", height: "94px", borderRadius: "14px",
              backgroundColor: "var(--color-primary-container)",
              border: "1px solid color-mix(in srgb, var(--color-primary) 30%, transparent)",
              pointerEvents: "none",
              opacity: Math.max(0, Math.min(1, highlightOpacity())),
              transform: `translate(${highlightX().toFixed(2)}px, ${highlightY().toFixed(2)}px)`,
            }} />
            <For each={items()} keyed={item => `${item.provider_id}:${item.item_id}`}>
              {(item, index) => <LauncherTile item={item} selected={index() === selectedIndex()} activate={activateItem} />}
            </For>
          </row>
        </scroll>
        <row style={{ justifyContent: "space-between", alignItems: "center", paddingTop: "2px", flexShrink: 0 }}>
          <text style={{ fontFamily: "var(--font-mono)", fontSize: "11px", color: "var(--color-on-surface-variant)" }}>
            ↑↓←→ Move · Enter Launch · Esc Close
          </text>
          <text data-tabular="true" style={{ fontFamily: "var(--font-mono)", fontSize: "11px", color: "var(--color-on-surface-variant)", fontVariantNumeric: "tabular-nums" }}>
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
            <LauncherContent allocateQueryId={allocateQueryId} spatial={presence.progress} opacity={presence.opacity} />
          </LayerSurface>
        );
      }}
    </Show>
  );
}
