import { Button, For, Image, Show, TextField, createEffect, createMemo, createSignal, getWindowRect, mountStylesheet, scrollIntoView, type Accessor, type NativeKeyEvent, type NativeNode } from "@hewel/zgui";
import { createVirtualFocus } from "@hewel/zgui/primitives";
import { M3Button, M3CardAction, M3FilterChip, M3InteractiveCard } from "@z-shell/sdk/primitives";
import { useDaemonMedia } from "@z-shell/sdk/zgui";
import { ShellIcon } from "../icons.tsx";
import { SPRING_EPSILON, createM3Spring, useMotionScheme } from "../motion.ts";
import { useShellStore } from "../store.ts";
import { PANEL_MAX_HEIGHTS, resolveClipboardSelection, type ClipboardEntrySummary } from "../topics.ts";

const primary = "var(--color-primary)";
const onSurface = "var(--color-on-surface)";
const muted = "var(--color-on-surface-variant)";
const containerHigh = "var(--color-surface-container-high)";
const containerHighest = "var(--color-surface-container-highest)";
const primaryContainer = "var(--color-primary-container)";
const onPrimaryContainer = "var(--color-on-primary-container)";
const errorContainer = "var(--color-error-container)";
const onErrorContainer = "var(--color-on-error-container)";
const thumbnail = { width: "44px", height: "36px", borderRadius: "8px", flexShrink: 0 } as const;
const thumbnailImage = { ...thumbnail, objectFit: "cover" } as const;
const iconButton = {
  display: "flex", width: "28px", height: "28px", borderRadius: "8px",
  flexShrink: 0, alignItems: "center", justifyContent: "center",
} as const;
const truncate = { overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" } as const;
const searchPlaceholder = "Search the clipboard";
const filters = [
  { key: "all", label: "All" },
  { key: "pinned", label: "Pinned" },
  { key: "images", label: "Images" },
  { key: "text", label: "Text" },
] as const;
type Filter = typeof filters[number]["key"];

function ClipboardRow(props: {
  entry: Accessor<ClipboardEntrySummary>;
  selected: boolean;
  onRowRef?: (node: NativeNode) => void;
}) {
  const { hostClient, invokePublic, closePanels } = useShellStore();
  const { entry } = props;
  const { src } = useDaemonMedia(hostClient, () => entry().kind === "image" ? entry().media : undefined, { fetchCommand: "clipboard.fetch-blob" });
  const title = createMemo(() => {
    const current = entry();
    if (current.kind === "text") return current.preview;
    const dimensions = current.dimensions;
    return `${current.mime.replace("image/", "").toUpperCase()} · ${dimensions ? `${dimensions.width} × ${dimensions.height}` : ""}`;
  });

  return (
    <M3InteractiveCard
      layout="row"
      testId={`clip-entry-${entry().id}`}
      actionTestId={`clip-copy-${entry().id}`}
      ariaLabel={title()}
      {...(props.onRowRef ? { ref: props.onRowRef } : {})}
      onClick={() => {
        void invokePublic("clipboard.copy", { id: entry().id });
        closePanels();
      }}
      style={{
        zIndex: 1,
        borderRadius: "14px", padding: "10px", gap: "10px", alignItems: "center",
        backgroundColor: entry().pinned ? primaryContainer : containerHigh,
        border: entry().pinned ? "1px solid color-mix(in srgb, var(--color-primary) 30%, transparent)" : "1px solid transparent",
        color: entry().pinned ? onPrimaryContainer : onSurface,
      }}
    >
      <Show when={src()} fallback={
        <box style={{ ...thumbnail, display: "flex", alignItems: "center", justifyContent: "center", backgroundColor: containerHighest }}>
          <ShellIcon name={entry().kind === "image" ? "image" : entry().preview.startsWith("http") ? "link" : "fileText"} size={18} color={primary} />
        </box>
      }>
        <Image testId={`clip-image-${entry().id}`} src={src()} style={thumbnailImage} />
      </Show>
      <column style={{ flexGrow: 1, flexBasis: "0px", minWidth: "0px", gap: "2px" }}>
        <text style={{ ...truncate, fontWeight: 500, fontSize: "13px" }}>{title()}</text>
        <text data-tabular="true" style={{
          ...truncate, fontFamily: "var(--font-mono)", fontSize: "11px", fontVariantNumeric: "tabular-nums",
          color: entry().pinned ? onPrimaryContainer : muted, opacity: entry().pinned ? 0.78 : 1,
        }}>
          {`${entry().pinned ? "Pinned · " : ""}${entry().kind} · ${entry().byte_len} B`}
        </text>
      </column>
      <M3CardAction style={{ flexShrink: 0 }}>
        <Button testId={`clip-pin-${entry().id}`} ariaLabel={entry().pinned ? "Unpin entry" : "Pin entry"} checked={entry().pinned}
          style={{
            ...iconButton,
            backgroundColor: entry().pinned ? "color-mix(in srgb, var(--color-primary) 20%, transparent)" : containerHighest,
          }}
          onClick={() => { void invokePublic(entry().pinned ? "clipboard.unpin" : "clipboard.pin", { id: entry().id }); }}>
          <ShellIcon name="pin" size={14} color={entry().pinned ? onPrimaryContainer : muted} />
        </Button>
      </M3CardAction>
      <M3CardAction style={{ flexShrink: 0 }}>
        <Button testId={`clip-forget-${entry().id}`} ariaLabel="Forget entry"
          style={{ ...iconButton, backgroundColor: containerHighest }}
          onClick={() => { void invokePublic("clipboard.forget", { id: entry().id }); }}>
          <ShellIcon name="trash" size={14} color="var(--color-error)" />
        </Button>
      </M3CardAction>
    </M3InteractiveCard>
  );
}

export function ClipboardPanel() {
  const { clipboard, invokePublic, closePanels } = useShellStore();
  mountStylesheet("z-shell-clipboard-search", `
    .clipboard-search:empty::before {
      content: "${searchPlaceholder}";
      color: var(--color-on-surface-variant);
      pointer-events: none;
    }
  `);
  const [query, setQuery] = createSignal("");
  const [filter, setFilter] = createSignal<Filter>("all");
  const [searchFocused, setSearchFocused] = createSignal(false);
  let rootNode: NativeNode | undefined;
  let searchNode: NativeNode | undefined;
  const locked = () => clipboard.data()?.locked === "locked";
  const entries = () => locked() ? [] : clipboard.data()?.entries ?? [];
  const counts = createMemo(() => {
    const list = entries();
    const count = { all: list.length, pinned: 0, images: 0, text: 0 };
    for (const entry of list) {
      if (entry.pinned) count.pinned++;
      if (entry.kind === "image") count.images++;
      else count.text++;
    }
    return count;
  });
  const filtered = createMemo(() => {
    const selected = filter();
    const search = query().toLowerCase();
    const list = entries();
    if (selected === "all" && search === "") return list;
    return list.filter(entry => {
      if ((selected === "pinned" && !entry.pinned) || (selected === "images" && entry.kind !== "image") || (selected === "text" && entry.kind !== "text")) return false;
      return search === "" || entry.preview.toLowerCase().includes(search) || entry.mime.toLowerCase().includes(search) || entry.kind.includes(search);
    });
  });
  const scheme = useMotionScheme();
  const virtualFocus = createVirtualFocus({
    items: filtered,
    getId: entry => String(entry.id),
    columns: 1,
    wrap: true,
    textValue: query,
    onActivate: entry => {
      void invokePublic("clipboard.copy", { id: entry.id });
      closePanels();
    },
    onReveal: () => {
      const node = virtualFocus.activeNode();
      if (node) scrollIntoView(node, { block: "nearest" });
    },
  });
  let lastSelectedId: number | null = null;
  let lastSelectedIndex = 0;
  const activeEntry = createMemo(() => {
    const activeId = virtualFocus.activeId();
    if (activeId === null) return null;
    return filtered().find(entry => String(entry.id) === activeId) ?? null;
  });
  const activeIndex = createMemo(() => {
    const activeId = virtualFocus.activeId();
    if (activeId === null) return -1;
    return filtered().findIndex(entry => String(entry.id) === activeId);
  });
  // Preserve adjacent-row fallback when the active entry is deleted while keeping stable-ID focus on prepend.
  createEffect(() => [filtered(), virtualFocus.activeId()] as const, ([list, activeId]) => {
    if (list.length === 0) {
      lastSelectedId = null;
      lastSelectedIndex = 0;
      return;
    }
    if (lastSelectedId !== null && !list.some(entry => entry.id === lastSelectedId)) {
      const fallback = resolveClipboardSelection(list, lastSelectedId, lastSelectedIndex);
      if (fallback.entry && String(fallback.entry.id) !== activeId) {
        virtualFocus.setActive(String(fallback.entry.id));
        lastSelectedId = fallback.entry.id;
        lastSelectedIndex = fallback.index;
        return;
      }
    }
    const idx = activeId !== null ? list.findIndex(entry => String(entry.id) === activeId) : -1;
    if (idx >= 0) {
      lastSelectedId = list[idx]!.id;
      lastSelectedIndex = idx;
    }
  });
  const resetSelection = () => {
    lastSelectedId = null;
    lastSelectedIndex = 0;
    const first = filtered()[0];
    virtualFocus.setActive(first ? String(first.id) : null);
  };
  const [listNode, setListNode] = createSignal<NativeNode | null>(null);
  const [highlightRect, setHighlightRect] = createSignal({ y: 0, height: 58 });
  createEffect(() => [activeIndex(), filtered(), listNode(), virtualFocus.activeNode()] as const, ([idx, _list, containerEl, rowEl]) => {
    if (idx < 0) return;
    if (containerEl && rowEl) {
      const cRect = getWindowRect(containerEl);
      const rRect = getWindowRect(rowEl);
      if (cRect && rRect && rRect.height > 1) {
        setHighlightRect({ y: rRect.y - cRect.y, height: rRect.height });
        return;
      }
    }
    setHighlightRect({ y: idx * 64, height: 58 });
  });
  const highlightY = createM3Spring(() => highlightRect().y, "fastSpatial", { scheme, epsilon: SPRING_EPSILON.px });
  const highlightH = createM3Spring(() => highlightRect().height, "fastSpatial", { scheme, epsilon: SPRING_EPSILON.px });
  const highlightOpacity = createM3Spring(() => (activeIndex() >= 0 ? 1 : 0), "fastEffects", { scheme });
  const handleKeyDown = (event: NativeKeyEvent) => {
    if (event.isComposing) return;
    const list = filtered();
    const inSearch = searchFocused() || (searchNode !== undefined && event.target === searchNode);
    const onRoot = rootNode !== undefined && event.target === rootNode;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closePanels();
      return;
    }
    if (list.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
      virtualFocus.onKeyDown(event);
    } else if (event.key === "Enter") {
      // Only copy the highlighted row when Enter originates in the search bar or panel root;
      // buttons (Pin, Forget, Filter chips, Clear) handle their own Enter activation.
      if (!inSearch && !onRoot) return;
      virtualFocus.onKeyDown(event);
    } else if (event.key === "Delete") {
      // Never hijack Delete while editing text inside the search input.
      if (inSearch) return;
      const target = activeEntry();
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      void invokePublic("clipboard.forget", { id: target.id });
    }
  };

  return (
    <column ref={node => { rootNode = node; }} testId="panel-clipboard" data-active-entry={activeEntry() ? String(activeEntry()!.id) : ""} onKeyDown={handleKeyDown} style={{
      width: "100%", maxHeight: `${PANEL_MAX_HEIGHTS.clipboard}px`, padding: "16px", gap: "10px", flexDirection: "column",
      backgroundColor: "transparent", color: onSurface, fontFamily: "var(--font-sans)", fontSize: "13px",
    }}>
      <Show when={!locked()} fallback={
        <row role="status" style={{ padding: "14px", borderRadius: "16px", gap: "8px", alignItems: "center", backgroundColor: errorContainer, color: onErrorContainer }}>
          <ShellIcon name="lock" size={18} color={onErrorContainer} />
          <text>Clipboard hidden while session is locked</text>
        </row>
      }>
        <row testId="clipboard-search-bar" data-composite-input="true" style={{
          width: "100%", height: "44px", borderRadius: "14px", padding: searchFocused() ? "0 11px 0 13px" : "0 12px 0 14px", gap: "10px",
          alignItems: "center", flexShrink: 0, backgroundColor: containerHigh,
          border: searchFocused()
            ? "2px solid var(--color-primary)"
            : "1px solid color-mix(in srgb, var(--color-outline-variant) 45%, transparent)",
        }}>
          <ShellIcon name="search" size={18} color={searchFocused() ? primary : muted} />
          <TextField ref={node => { searchNode = node; }} testId="clipboard-search" class="clipboard-search shell-composite-field" ariaLabel={searchPlaceholder} placeholder={searchPlaceholder} value={query()}
            ariaActiveDescendant={virtualFocus.activeNode()}
            onInput={event => { setQuery(event.value); resetSelection(); }}
            onFocus={() => setSearchFocused(true)} onBlur={() => setSearchFocused(false)}
            style={{
              flexGrow: 1, flexBasis: "0px", minWidth: "0px", height: "36px", lineHeight: "18px",
              padding: "9px 0", backgroundColor: "transparent", color: onSurface,
            }} />
          <box testId="clipboard-esc-badge" ariaHidden style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            height: "22px", padding: "0 7px", borderRadius: "6px", flexShrink: 0,
            backgroundColor: containerHighest,
          }}>
            <text testId="clipboard-esc-text" style={{
              fontFamily: "var(--font-mono)", fontSize: "10px", lineHeight: "12px", fontWeight: 500, color: muted,
            }}>
              Esc
            </text>
          </box>
        </row>
        <row style={{ gap: "6px", flexWrap: "wrap", flexShrink: 0 }}>
          <For each={filters} keyed={false}>
            {chip => {
              const active = () => filter() === chip().key;
              return (
                <M3FilterChip
                  testId={`clipboard-filter-${chip().key}`}
                  label={chip().label}
                  count={counts()[chip().key]}
                  selected={active()}
                  onClick={() => { setFilter(chip().key); resetSelection(); }}
                />
              );
            }}
          </For>
        </row>
        <scroll style={{ maxHeight: "360px", width: "100%", overflow: "hidden auto" }}>
          <column ref={setListNode} style={{ position: "relative", gap: "6px" }}>
            <Show when={filtered().length > 0} fallback={<text style={{ color: muted, padding: "12px 0" }}>{entries().length ? "No matching entries" : "Clipboard is empty"}</text>}>
              <For each={filtered()} keyed={entry => entry.id}>
                {entry => (
                  <ClipboardRow
                    entry={entry}
                    selected={virtualFocus.activeId() === String(entry().id)}
                    onRowRef={node => { virtualFocus.register(String(entry().id), node); }}
                  />
                )}
              </For>
              <box ariaHidden style={{
                position: "absolute", top: "0px", left: "0px", right: "0px", zIndex: 2,
                height: `${highlightH().toFixed(2)}px`,
                borderRadius: "14px",
                border: `1.5px solid ${primary}`,
                backgroundColor: "transparent",
                pointerEvents: "none",
                opacity: Math.max(0, Math.min(1, highlightOpacity())),
                transform: `translateY(${highlightY().toFixed(2)}px)`,
              }} />
            </Show>
          </column>
        </scroll>
        <box ariaHidden style={{ height: "1px", flexShrink: 0, backgroundColor: "color-mix(in srgb, var(--color-outline-variant) 50%, transparent)" }} />
        <row style={{ justifyContent: "space-between", alignItems: "center", gap: "8px", flexShrink: 0 }}>
          <text style={{ fontFamily: "var(--font-mono)", fontSize: "11px", color: muted }}>
            ↑↓ Move · Enter Copy · Del Forget · Esc Close
          </text>
          <row style={{ alignItems: "center", gap: "8px", flexShrink: 0 }}>
            <text testId="clipboard-count" data-tabular="true" style={{ fontFamily: "var(--font-mono)", fontSize: "11px", color: muted, fontVariantNumeric: "tabular-nums" }}>
              {`${clipboard.data()?.entry_count ?? 0} kept`}
            </text>
            <M3Button
              testId="clipboard-clear"
              variant="destructive"
              size="sm"
              onClick={() => { void invokePublic("clipboard.clear", {}); }}
            >
              <text>Clear unpinned</text>
            </M3Button>
          </row>
        </row>
      </Show>
    </column>
  );
}
