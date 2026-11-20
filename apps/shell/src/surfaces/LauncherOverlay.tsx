import { Button, For, Image, LayerSurface, Show, TextField, createEffect, createSignal, flush, focus, onCleanup, type NativeChild, type NativeKeyEvent } from "@hewel/zgui";
import { useDaemonMedia } from "@z-shell/sdk/zgui";
import { DIALOG_SPRING, createEnterProgress, dialogMotionStyle, scrimBackdrop } from "../motion.ts";
import { useShellStore } from "../store.ts";
import { resolveActiveMonitor, resolveMonitorLogicalSize, type LauncherItem, type LauncherQueryResponse } from "../topics.ts";

const columns = 6;
const iconTile = { width: "44px", height: "44px", flexShrink: 0, borderRadius: "10px" } as const;
const iconTints = ["primary", "secondary", "tertiary"] as const;
const clipped = { maxWidth: "100%", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } as const;

function LauncherTile(props: { item: LauncherItem; selected: boolean; activate: (item: LauncherItem) => void }): NativeChild {
  const { hostClient } = useShellStore();
  const { item } = props;
  const { src } = useDaemonMedia(hostClient, () => item.icon, { fetchCommand: "launcher.fetch-blob" });
  const letter = item.title.trim().codePointAt(0);
  const initial = letter === undefined ? "?" : String.fromCodePoint(letter).toUpperCase();
  const tint = iconTints[(letter ?? 0) % iconTints.length];

  return (
    <Button testId={`launcher-item-${item.provider_id}-${item.item_id}`} tabIndex={-1}
      data-selected={props.selected ? "true" : null} onClick={() => props.activate(item)} style={{
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
        width: "96px", height: "92px", flexShrink: 0, borderRadius: "16px", padding: "8px", gap: "6px",
        backgroundColor: props.selected ? "var(--color-secondary-container)" : "transparent",
        color: props.selected ? "var(--color-on-secondary-container)" : "var(--color-on-surface)",
      }}>
      <Show when={src()} fallback={
        <box style={{
          ...iconTile, display: "flex", alignItems: "center", justifyContent: "center",
          backgroundColor: `var(--color-${tint}-container)`, color: `var(--color-on-${tint}-container)`,
        }}>
          <text style={{ fontSize: "20px", fontWeight: 600 }}>{initial}</text>
        </box>
      }>
        {image => <Image src={image()} style={iconTile} />}
      </Show>
      <text style={{ ...clipped, fontSize: "12px", lineHeight: "14px" }}>{item.title}</text>
      <Show when={item.provider_id !== "desktop"}>
        <text style={{ ...clipped, fontSize: "10px", lineHeight: "10px", color: "var(--color-on-surface-variant)" }}>{item.provider_id}</text>
      </Show>
    </Button>
  );
}

function LauncherContent(props: { allocateQueryId: () => number }): NativeChild {
  const { publicClient, invokePublic, closePanels } = useShellStore();
  const [query, setQuery] = createSignal("");
  const [results, setResults] = createSignal<LauncherQueryResponse>();
  const [selectedIndex, setSelectedIndex] = createSignal(0);
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
    // The daemon invalidates activation of the previous result as soon as it accepts this query.
    setResults(undefined);
    void invokePublic("launcher.query", { query: text, query_id: id, limit: 18 }).then(result => {
      if (disposed || id !== latestQueryId) return;
      const data = result?.data as LauncherQueryResponse | undefined;
      if (!data || (data.query_id !== undefined && data.query_id !== id)) return;
      setResults({ query_id: id, items: data.items });
      setSelectedIndex(0);
    });
  });

  function activateItem(item: LauncherItem): void {
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

  const enter = createEnterProgress(DIALOG_SPRING);

  return (
    <box testId="launcher-backdrop" onClick={dismiss} style={{
      position: "fixed", left: "0px", top: "0px", width: "100%", height: "100%",
      display: "flex", alignItems: "center", justifyContent: "center",
      backgroundColor: scrimBackdrop(45, enter()),
    }}>
      <box testId="launcher-card" role="dialog" ariaLabel="Launcher" ariaModal onClick={event => event.stopPropagation()} style={{
        display: "flex", flexDirection: "column", width: "652px", height: "410px", borderRadius: "22px",
        backgroundColor: "var(--color-surface)", border: "1px solid var(--color-outline-variant)",
        padding: "18px", gap: "14px", fontFamily: "var(--font-sans)",
        ...dialogMotionStyle(enter()),
      }}>
        <TextField testId="launcher-search" placeholder="Search apps" value={query()} onInput={event => setQuery(event.value)}
          onKeyDown={handleKeyDown} ref={node => focus(node)} style={{
            width: "100%", height: "44px", borderRadius: "22px",
            padding: "12px 18px", lineHeight: "20px", flexShrink: 0,
            backgroundColor: "var(--color-surface-container-high)", color: "var(--color-on-surface)", fontSize: "14px",
          }} />
        <scroll style={{ flexGrow: 1, width: "100%", overflow: "hidden auto" }}>
          <row style={{ width: "100%", flexWrap: "wrap", gap: "6px", justifyContent: "flex-start" }}>
            <For each={items()} keyed={item => item}>
              {(item, index) => <LauncherTile item={item()} selected={index() === selectedIndex()} activate={activateItem} />}
            </For>
          </row>
        </scroll>
      </box>
    </box>
  );
}

export function LauncherOverlay(): NativeChild {
  const { activePanel, activePanelTarget, activeMonitor, monitors, outputs, windows } = useShellStore();
  const targetMonitor = () => {
    if (activePanel() !== "launcher") return undefined;
    return resolveActiveMonitor(monitors(), {
      preferredMonitorId: activePanelTarget()?.monitorId,
      windows: windows.data(),
      outputs: outputs.data(),
      lastMonitorId: activeMonitor()?.id,
    });
  };
  // IDs must keep increasing on the same bus connection, including after reopening the overlay.
  let nextQueryId = 1;
  const allocateQueryId = () => nextQueryId++;

  return (
    <Show when={targetMonitor()?.id} keyed>
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
            <LauncherContent allocateQueryId={allocateQueryId} />
          </LayerSurface>
        );
      }}
    </Show>
  );
}
