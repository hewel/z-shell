import { Button, For, Image, Show, TextField, createEffect, createMemo, createSignal, cx, flush, focus, getWindowRect, scrollIntoView, type Accessor, type NativeKeyEvent, type NativeNode } from "@hewel/zgui";
import { createVirtualFocus } from "@hewel/zgui/primitives";
import { M3Button, M3CardAction, M3FilterChip, M3InteractiveCard } from "@z-shell/sdk/primitives";
import { useDaemonMedia } from "@z-shell/sdk/zgui";
import { ShellIcon } from "../icons.tsx";
import { SPRING_EPSILON, createM3Spring, useMotionScheme } from "../motion.ts";
import { useShellStore } from "../store.ts";
import { PANEL_MAX_HEIGHTS, resolveClipboardSelection, type ClipboardEntrySummary } from "../topics.ts";
import styles from "./ClipboardPanel.module.css";

const primary = "var(--color-primary)";
const muted = "var(--color-on-surface-variant)";
const onPrimaryContainer = "var(--color-on-primary-container)";
const onErrorContainer = "var(--color-on-error-container)";
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
      class={cx(styles.rowCard, entry().pinned && styles.rowCardPinned)}
    >
      <Show when={src()} fallback={
        <box class={cx(styles.thumbnail, styles.thumbnailFallback)}>
          <ShellIcon name={entry().kind === "image" ? "image" : entry().preview.startsWith("http") ? "link" : "fileText"} size={18} color={primary} />
        </box>
      }>
        <Image testId={`clip-image-${entry().id}`} src={src()} class={cx(styles.thumbnail, styles.thumbnailImage)} />
      </Show>
      <column class={styles.rowTextCol}>
        <text class={cx(styles.truncate, styles.rowTitle)}>{title()}</text>
        <text data-tabular="true" class={cx(styles.truncate, styles.rowMeta)} data-pinned={entry().pinned ? "true" : "false"}>
          {`${entry().pinned ? "Pinned · " : ""}${entry().kind} · ${entry().byte_len} B`}
        </text>
      </column>
      <M3CardAction class={styles.rowActionWrap}>
        <Button
          testId={`clip-pin-${entry().id}`}
          ariaLabel={entry().pinned ? "Unpin entry" : "Pin entry"}
          checked={entry().pinned}
          class={cx(styles.iconButton, styles.pinButton)}
          data-pinned={entry().pinned ? "true" : "false"}
          onClick={() => { void invokePublic(entry().pinned ? "clipboard.unpin" : "clipboard.pin", { id: entry().id }); }}
        >
          <ShellIcon name="pin" filled={entry().pinned} size={14} color={entry().pinned ? onPrimaryContainer : muted} />
        </Button>
      </M3CardAction>
      <M3CardAction class={styles.rowActionWrap}>
        <Button
          testId={`clip-forget-${entry().id}`}
          ariaLabel="Forget entry"
          class={styles.iconButton}
          onClick={() => { void invokePublic("clipboard.forget", { id: entry().id }); }}
        >
          <ShellIcon name="trash" size={14} color="var(--color-error)" />
        </Button>
      </M3CardAction>
    </M3InteractiveCard>
  );
}

export function ClipboardPanel() {
  const { clipboard, invokePublic, closePanels } = useShellStore();
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
    flush(() => virtualFocus.setActive(first ? String(first.id) : null));
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
      flush(() => virtualFocus.onKeyDown(event));
    } else if (event.key === "Enter") {
      // Only copy the highlighted row when Enter originates in the search bar or panel root;
      // buttons (Pin, Forget, Filter chips, Clear) handle their own Enter activation.
      if (!inSearch && !onRoot) return;
      flush(() => virtualFocus.onKeyDown(event));
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
    <column
      ref={node => { rootNode = node; }}
      testId="panel-clipboard"
      data-active-entry={activeEntry() ? String(activeEntry()!.id) : ""}
      onKeyDown={handleKeyDown}
      class={styles.panel}
      style={{ maxHeight: `${PANEL_MAX_HEIGHTS.clipboard}px` }}
    >
      <Show when={!locked()} fallback={
        <row role="status" class={styles.lockedBanner}>
          <ShellIcon name="lock" size={18} color={onErrorContainer} />
          <text>Clipboard hidden while session is locked</text>
        </row>
      }>
        <row testId="clipboard-search-bar" data-composite-input="true" data-focused={searchFocused() ? "true" : "false"} class={styles.searchBar}>
          <ShellIcon name="search" size={18} color={searchFocused() ? primary : muted} />
          <TextField
            ref={node => { searchNode = node; focus(node); }}
            testId="clipboard-search"
            class={cx(styles.searchField, "clipboard-search", "shell-composite-field")}
            ariaLabel={searchPlaceholder}
            placeholder={searchPlaceholder}
            value={query()}
            ariaActiveDescendant={virtualFocus.activeNode()}
            onInput={event => { flush(() => setQuery(event.value)); resetSelection(); }}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
          />
          <box testId="clipboard-esc-badge" ariaHidden class={styles.escBadge}>
            <text testId="clipboard-esc-text" class={styles.escText}>
              Esc
            </text>
          </box>
        </row>
        <row class={styles.filtersRow}>
          <For each={filters} keyed={false}>
            {chip => {
              const active = () => filter() === chip().key;
              return (
                <M3FilterChip
                  testId={`clipboard-filter-${chip().key}`}
                  label={chip().label}
                  count={counts()[chip().key]}
                  selected={active()}
                  onClick={() => { flush(() => setFilter(chip().key)); resetSelection(); }}
                />
              );
            }}
          </For>
        </row>
        <scroll class={styles.listScroll}>
          <column ref={setListNode} class={styles.listCol}>
            <Show when={filtered().length > 0} fallback={<text class={styles.emptyText}>{entries().length ? "No matching entries" : "Clipboard is empty"}</text>}>
              <For each={filtered()} keyed={entry => entry.id}>
                {entry => (
                  <ClipboardRow
                    entry={entry}
                    selected={virtualFocus.activeId() === String(entry().id)}
                    onRowRef={node => { virtualFocus.register(String(entry().id), node); }}
                  />
                )}
              </For>
              <box
                ariaHidden
                class={styles.highlightRing}
                style={{
                  height: `${highlightH().toFixed(2)}px`,
                  opacity: Math.max(0, Math.min(1, highlightOpacity())),
                  transform: `translateY(${highlightY().toFixed(2)}px)`,
                }}
              />
            </Show>
          </column>
        </scroll>
        <box ariaHidden class={styles.divider} />
        <row class={styles.footerRow}>
          <text class={styles.footerHints}>
            ↑↓ Move · Enter Copy · Del Forget · Esc Close
          </text>
          <row class={styles.footerRight}>
            <text testId="clipboard-count" data-tabular="true" class={styles.footerCount}>
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
