import { Button, For, LayerSurface, Show, createMemo, type Accessor, type NativeChild, type NativeStyle } from "@hewel/zgui";
import { ShojiIcon } from "../icons.tsx";
import { useShellStore } from "../store.ts";
import { useShellTheme } from "../theme.ts";
import { buildDockItems, type DockEntry } from "../topics.ts";

const primary = "var(--color-primary)";
const outline = "var(--color-outline-variant)";
const onSurfaceVariant = "var(--color-on-surface-variant)";
const tileSize = 40;
const dockGap = 8;
const dockPadding = 10;
const dockHeight = 60;
const capsule = {
  width: "100%", height: `${dockHeight}px`, alignItems: "center", gap: `${dockGap}px`, padding: `0 ${dockPadding}px`,
  borderRadius: "30px", backgroundColor: "var(--color-surface)", border: `1px solid ${outline}`, overflow: "hidden",
} satisfies NativeStyle;
const tile = {
  display: "flex", width: `${tileSize}px`, height: `${tileSize}px`, flexShrink: 0, alignItems: "center", justifyContent: "center",
} satisfies NativeStyle;
const tileStack = { height: "48px", flexShrink: 0, alignItems: "center", gap: "4px" } as const;
const dot = { width: "4px", height: "4px", flexShrink: 0, borderRadius: "2px", backgroundColor: onSurfaceVariant } as const;
const tints = ["primary", "secondary", "tertiary"] as const;

function DockApp(props: { entry: Accessor<DockEntry> }) {
  const { invokePublic, invokeHost } = useShellStore();
  const entry = props.entry;
  const tint = createMemo(() => {
    let hash = 0;
    for (const char of entry().appId) hash = (Math.imul(31, hash) + char.codePointAt(0)!) >>> 0;
    return tints[hash % tints.length];
  });
  const initial = createMemo(() => {
    const id = entry().appId.replace(/\.desktop$/i, "");
    return String.fromCodePoint(id.codePointAt(id.lastIndexOf(".") + 1) ?? 0x3f).toUpperCase();
  });
  function activate() {
    const { appId, windows } = entry();
    const window = windows[0];
    if (window) void invokePublic("wayland.window.activate", { window_id: window.window_id });
    else void invokePublic("launcher.activate", { provider_id: "desktop", item_id: appId });
  }
  function togglePin() {
    const { appId, pinned } = entry();
    void invokeHost("apps.pin", { id: appId, pinned: !pinned });
  }
  return (
    <column style={tileStack}>
      <Button testId={`dock-${entry().pinned ? "app" : "running"}-${entry().appId}`} ariaLabel={entry().title}
        onClick={activate}
        onPointerDown={event => {
          // Mouse secondary presses are pointer events; long presses emit contextmenu.
          if (event.button !== "secondary") return;
          event.preventDefault();
          togglePin();
        }}
        onContextMenu={event => {
          event.preventDefault();
          togglePin();
        }}
        style={{ ...tile, borderRadius: "12px", backgroundColor: `var(--color-${tint()}-container)`, color: `var(--color-on-${tint()}-container)` }}>
        <text style={{ fontFamily: "system-ui", fontSize: "18px", fontWeight: 700 }}>
          {initial()}
        </text>
      </Button>
      <row ariaHidden style={{ height: "4px", maxWidth: `${tileSize}px`, alignItems: "center", gap: "2px", overflow: "hidden" }}>
        <Show when={entry().pinned} fallback={<box style={{ ...dot, backgroundColor: entry().focused ? primary : onSurfaceVariant }} />}>
          <Show when={entry().focused} fallback={
            <For each={entry().windows} keyed={window => window.window_id}>{() => <box style={dot} />}</For>
          }>
            <box style={{ width: "16px", height: "3px", borderRadius: "2px", backgroundColor: primary }} />
          </Show>
        </Show>
      </row>
    </column>
  );
}

function DockCapsule(props: { monitorId: string; pinned: readonly DockEntry[]; runningOnly: readonly DockEntry[] }) {
  const { theme, togglePanel } = useShellStore();
  useShellTheme(theme.data);
  return (
    <row testId={`dock-root-${props.monitorId}`} role="toolbar" ariaLabel="Dock" style={capsule}>
      <column style={tileStack}>
        <Button testId="dock-launcher" ariaLabel="Open launcher" onClick={() => togglePanel("launcher")}
          style={{ ...tile, borderRadius: "14px", backgroundColor: "var(--color-surface-container)" }}>
          <ShojiIcon name="shojiEmblem" size={22} color={primary} />
        </Button>
      </column>
      <scroll style={{ minWidth: "0px", height: "48px", overflow: "auto" }}>
        <row style={{ alignItems: "center", gap: `${dockGap}px` }}>
          <For each={props.pinned} keyed={entry => entry.appId}>{entry => <DockApp entry={entry} />}</For>
          <Show when={props.pinned.length > 0 && props.runningOnly.length > 0}>
            <box ariaHidden style={{ width: "1px", height: "24px", flexShrink: 0, backgroundColor: outline }} />
          </Show>
          <For each={props.runningOnly} keyed={entry => entry.appId}>{entry => <DockApp entry={entry} />}</For>
        </row>
      </scroll>
    </row>
  );
}

export function DockSurface(): NativeChild {
  const { apps, monitors, settings, windows } = useShellStore();
  const dock = createMemo(() => buildDockItems(apps.data()?.pinned_apps ?? [], windows.data()?.windows ?? []));
  const idealWidth = createMemo(() => {
    const { pinned, runningOnly } = dock();
    const count = pinned.length + runningOnly.length;
    const divider = pinned.length > 0 && runningOnly.length > 0 ? 1 + dockGap : 0;
    return tileSize + count * (tileSize + dockGap) + divider + 2 * (dockPadding + 1);
  });
  return (
    <Show when={settings.data()?.bar.dock_enabled !== false && (dock().pinned.length > 0 || dock().runningOnly.length > 0)}>
      <For each={monitors()} keyed={monitor => monitor.id}>
        {monitor => (
          <LayerSurface name={`dock-${monitor().id}`} output={monitor().id} layer="top" anchor={["bottom"]}
            margin={{ bottom: 10 }} width={Math.max(1, Math.min(idealWidth(), monitor().width - 32))}
            height={dockHeight} exclusiveZone={0} keyboard="none">
            <DockCapsule monitorId={monitor().id} pinned={dock().pinned} runningOnly={dock().runningOnly} />
          </LayerSurface>
        )}
      </For>
    </Show>
  );
}
