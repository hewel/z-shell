import { Button, For, Image, Show, TextField, createMemo, createSignal, mountStylesheet, type Accessor } from "@hewel/zgui";
import { useDaemonMedia } from "@z-shell/sdk/zgui";
import { ShellIcon } from "../icons.tsx";
import { useShellStore } from "../store.ts";
import { PANEL_MAX_HEIGHTS, type ClipboardEntrySummary } from "../topics.ts";

const primary = "var(--color-primary)";
const onSurface = "var(--color-on-surface)";
const muted = "var(--color-on-surface-variant)";
const container = "var(--color-surface-container)";
const containerHigh = "var(--color-surface-container-high)";
const containerHighest = "var(--color-surface-container-highest)";
const primaryContainer = "var(--color-primary-container)";
const onPrimaryContainer = "var(--color-on-primary-container)";
const errorContainer = "var(--color-error-container)";
const onErrorContainer = "var(--color-on-error-container)";
const pill = {
  display: "flex", minHeight: "28px", padding: "4px 10px", borderRadius: "999px",
  alignItems: "center", justifyContent: "center", fontSize: "12px", fontWeight: 500,
} as const;
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

function ClipboardRow(props: { entry: Accessor<ClipboardEntrySummary>; selected: boolean }) {
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
    <row testId={`clip-entry-${entry().id}`} style={{
      borderRadius: "14px", padding: "10px", gap: "10px", alignItems: "center",
      backgroundColor: entry().pinned ? primaryContainer : containerHigh,
      border: props.selected
        ? `1px solid ${primary}`
        : entry().pinned ? "1px solid color-mix(in srgb, var(--color-primary) 30%, transparent)" : "1px solid transparent",
      color: entry().pinned ? onPrimaryContainer : onSurface,
    }}>
      <Show when={src()} fallback={
        <box style={{ ...thumbnail, display: "flex", alignItems: "center", justifyContent: "center", backgroundColor: containerHighest }}>
          <ShellIcon name={entry().kind === "image" ? "image" : entry().preview.startsWith("http") ? "link" : "fileText"} size={18} color={primary} />
        </box>
      }>
        <Image testId={`clip-image-${entry().id}`} src={src()} style={thumbnailImage} />
      </Show>
      <Button testId={`clip-copy-${entry().id}`} style={{
        display: "flex", flexGrow: 1, flexBasis: "0px", minWidth: "0px", flexDirection: "column", alignItems: "stretch", gap: "2px",
      }}
        onClick={() => {
          void invokePublic("clipboard.copy", { id: entry().id });
          closePanels();
        }}>
        <text style={{ ...truncate, fontWeight: 500, fontSize: "13px" }}>{title()}</text>
        <text data-tabular="true" style={{
          ...truncate, fontFamily: "var(--font-mono)", fontSize: "11px", fontVariantNumeric: "tabular-nums",
          color: entry().pinned ? onPrimaryContainer : muted, opacity: entry().pinned ? 0.78 : 1,
        }}>
          {`${entry().pinned ? "Pinned · " : ""}${entry().kind} · ${entry().byte_len} B`}
        </text>
      </Button>
      <Button testId={`clip-pin-${entry().id}`} ariaLabel={entry().pinned ? "Unpin entry" : "Pin entry"} checked={entry().pinned}
        style={{
          ...iconButton,
          backgroundColor: entry().pinned ? "color-mix(in srgb, var(--color-primary) 20%, transparent)" : containerHighest,
        }}
        onClick={() => { void invokePublic(entry().pinned ? "clipboard.unpin" : "clipboard.pin", { id: entry().id }); }}>
        <ShellIcon name="pin" size={14} color={entry().pinned ? onPrimaryContainer : muted} />
      </Button>
      <Button testId={`clip-forget-${entry().id}`} ariaLabel="Forget entry"
        style={{ ...iconButton, backgroundColor: containerHighest }}
        onClick={() => { void invokePublic("clipboard.forget", { id: entry().id }); }}>
        <ShellIcon name="trash" size={14} color="var(--color-error)" />
      </Button>
    </row>
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
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  const [searchFocused, setSearchFocused] = createSignal(false);
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
  const activeIndex = () => {
    const list = filtered();
    return list.length === 0 ? -1 : Math.max(0, Math.min(selectedIndex(), list.length - 1));
  };
  const handleKeyDown = (event: { key: string | null; preventDefault: () => void }) => {
    const list = filtered();
    if (event.key === "Escape") {
      event.preventDefault();
      closePanels();
      return;
    }
    if (list.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex(index => (index + 1) % list.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex(index => (index - 1 + list.length) % list.length);
    } else if (event.key === "Enter") {
      const target = list[activeIndex()];
      if (!target) return;
      event.preventDefault();
      void invokePublic("clipboard.copy", { id: target.id });
      closePanels();
    } else if (event.key === "Delete") {
      const target = list[activeIndex()];
      if (!target) return;
      event.preventDefault();
      void invokePublic("clipboard.forget", { id: target.id });
    }
  };

  return (
    <column testId="panel-clipboard" onKeyDown={handleKeyDown} style={{
      width: "100%", maxHeight: `${PANEL_MAX_HEIGHTS.clipboard}px`, padding: "16px", gap: "10px", flexDirection: "column",
      backgroundColor: container, color: onSurface, fontFamily: "var(--font-sans)", fontSize: "13px",
    }}>
      <Show when={!locked()} fallback={
        <row role="status" style={{ padding: "14px", borderRadius: "16px", gap: "8px", alignItems: "center", backgroundColor: errorContainer, color: onErrorContainer }}>
          <ShellIcon name="lock" size={18} color={onErrorContainer} />
          <text>Clipboard hidden while session is locked</text>
        </row>
      }>
        <row testId="clipboard-search-bar" data-composite-input="true" style={{
          width: "100%", height: "44px", borderRadius: "14px", padding: searchFocused() ? "0 13px" : "0 14px", gap: "10px",
          alignItems: "center", flexShrink: 0, backgroundColor: containerHigh,
          border: searchFocused()
            ? "2px solid var(--color-primary)"
            : "1px solid color-mix(in srgb, var(--color-outline-variant) 45%, transparent)",
        }}>
          <ShellIcon name="search" size={18} color={searchFocused() ? primary : muted} />
          <TextField testId="clipboard-search" class="clipboard-search shell-composite-field" ariaLabel={searchPlaceholder} placeholder={searchPlaceholder} value={query()}
            onInput={event => { setQuery(event.value); setSelectedIndex(0); }}
            onFocus={() => setSearchFocused(true)} onBlur={() => setSearchFocused(false)}
            onKeyDown={handleKeyDown} style={{
              flexGrow: 1, flexBasis: "0px", minWidth: "0px", height: "36px", lineHeight: "18px",
              padding: "9px 0", backgroundColor: "transparent", color: onSurface,
            }} />
        </row>
        <row style={{ gap: "6px", flexWrap: "wrap", flexShrink: 0 }}>
          <For each={filters} keyed={false}>
            {chip => {
              const active = () => filter() === chip().key;
              return (
                <Button testId={`clipboard-filter-${chip().key}`} selected={active()}
                  onClick={() => { setFilter(chip().key); setSelectedIndex(0); }} style={{
                    ...pill, flexDirection: "row", gap: "5px",
                    backgroundColor: active() ? primaryContainer : containerHigh,
                    border: active() ? "1px solid color-mix(in srgb, var(--color-primary) 30%, transparent)" : "1px solid transparent",
                    color: active() ? onPrimaryContainer : onSurface,
                  }}>
                  <text>{chip().label}</text>
                  <text data-tabular="true" style={{ fontFamily: "var(--font-mono)", fontSize: "11px", fontVariantNumeric: "tabular-nums" }}>
                    {counts()[chip().key]}
                  </text>
                </Button>
              );
            }}
          </For>
        </row>
        <scroll style={{ maxHeight: "360px", width: "100%", overflow: "hidden auto" }}>
          <column style={{ gap: "6px" }}>
            <Show when={filtered().length > 0} fallback={<text style={{ color: muted, padding: "12px 0" }}>{entries().length ? "No matching entries" : "Clipboard is empty"}</text>}>
              <For each={filtered()} keyed={entry => entry.id}>
                {(entry, index) => <ClipboardRow entry={entry} selected={index() === activeIndex()} />}
              </For>
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
            <Button testId="clipboard-clear" style={{
              ...pill, borderRadius: "10px",
              backgroundColor: errorContainer, color: onErrorContainer, fontSize: "11px", fontWeight: 600,
            }}
              onClick={() => { void invokePublic("clipboard.clear", {}); }}>
              <text>Clear unpinned</text>
            </Button>
          </row>
        </row>
      </Show>
    </column>
  );
}
