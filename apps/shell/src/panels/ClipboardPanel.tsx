import { Button, For, Image, Show, TextField, createMemo, createSignal, mountStylesheet, type Accessor } from "@hewel/zgui";
import { useDaemonMedia } from "@z-shell/sdk/zgui";
import { ShellIcon } from "../icons.tsx";
import { useShellStore } from "../store.ts";
import type { ClipboardEntrySummary } from "../topics.ts";

const primary = "var(--color-primary)";
const onPrimary = "var(--color-on-primary)";
const onSurface = "var(--color-on-surface)";
const muted = "var(--color-on-surface-variant)";
const container = "var(--color-surface-container)";
const containerHigh = "var(--color-surface-container-high)";
const secondaryContainer = "var(--color-secondary-container)";
const onSecondaryContainer = "var(--color-on-secondary-container)";
const errorContainer = "var(--color-error-container)";
const onErrorContainer = "var(--color-on-error-container)";
const pill = { display: "flex", minHeight: "30px", padding: "4px 8px", borderRadius: "16px", alignItems: "center", justifyContent: "center" } as const;
const thumbnail = { width: "48px", height: "36px", borderRadius: "8px", flexShrink: 0 } as const;
const thumbnailImage = { ...thumbnail, "object-fit": "cover" } as const;
const iconButton = { display: "flex", width: "28px", height: "28px", borderRadius: "14px", flexShrink: 0, alignItems: "center", justifyContent: "center" } as const;
const truncate = { overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" } as const;
const searchPlaceholder = "Search the clipboard";
const filters = [
  { key: "all", label: "All" },
  { key: "pinned", label: "Pinned" },
  { key: "images", label: "Images" },
  { key: "text", label: "Text" },
] as const;
type Filter = typeof filters[number]["key"];

function ClipboardRow(props: { entry: Accessor<ClipboardEntrySummary> }) {
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
    <row testId={`clip-entry-${entry().id}`} style={{ borderRadius: "16px", padding: "10px", gap: "6px", alignItems: "center",
      backgroundColor: entry().pinned ? secondaryContainer : container, color: entry().pinned ? onSecondaryContainer : onSurface }}>
      <Show when={src()} fallback={
        <box style={{ ...thumbnail, display: "flex", alignItems: "center", justifyContent: "center", backgroundColor: containerHigh }}>
          <ShellIcon name={entry().kind === "image" ? "image" : entry().preview.startsWith("http") ? "link" : "fileText"} color={primary} />
        </box>
      }>
        <Image testId={`clip-image-${entry().id}`} src={src()} style={thumbnailImage} />
      </Show>
      <Button testId={`clip-copy-${entry().id}`} style={{ display: "flex", flexGrow: 1, flexBasis: "0px", minWidth: "0px", flexDirection: "column", alignItems: "stretch", gap: "2px" }}
        onClick={() => {
          void invokePublic("clipboard.copy", { id: entry().id });
          closePanels();
        }}>
        <text style={{ ...truncate, fontWeight: 600 }}>{title()}</text>
        <text style={{ ...truncate, fontSize: "11px", color: entry().pinned ? onSecondaryContainer : muted }}>
          {`${entry().pinned ? "Pinned · " : ""}${entry().kind} · ${entry().byte_len} B`}
        </text>
      </Button>
      <Button testId={`clip-pin-${entry().id}`} ariaLabel={entry().pinned ? "Unpin entry" : "Pin entry"} checked={entry().pinned}
        style={{ ...iconButton, backgroundColor: entry().pinned ? "var(--color-primary-container)" : containerHigh }}
        onClick={() => { void invokePublic(entry().pinned ? "clipboard.unpin" : "clipboard.pin", { id: entry().id }); }}>
        <ShellIcon name="pin" size={14} color={entry().pinned ? "var(--color-on-primary-container)" : muted} />
      </Button>
      <Button testId={`clip-forget-${entry().id}`} ariaLabel="Forget entry" style={iconButton}
        onClick={() => { void invokePublic("clipboard.forget", { id: entry().id }); }}>
        <text style={{ fontSize: "16px", color: "var(--color-error)" }}>×</text>
      </Button>
    </row>
  );
}

export function ClipboardPanel() {
  const { clipboard, invokePublic } = useShellStore();
  mountStylesheet("z-shell-clipboard-search", `
    .clipboard-search:empty::before {
      content: "${searchPlaceholder}";
      color: var(--color-on-surface-variant);
      pointer-events: none;
    }
  `);
  const [query, setQuery] = createSignal("");
  const [filter, setFilter] = createSignal<Filter>("all");
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

  return (
    <column testId="panel-clipboard" style={{ width: "100%", height: "100%", minHeight: "calc(100vh - 2px)", padding: "14px", gap: "10px", flexDirection: "column", backgroundColor: "var(--color-surface)", color: onSurface, fontFamily: "var(--font-sans)", fontSize: "13px" }}>
      <Show when={!locked()} fallback={
        <row role="status" style={{ padding: "14px", borderRadius: "16px", gap: "8px", alignItems: "center", backgroundColor: errorContainer, color: onErrorContainer }}>
          <ShellIcon name="lock" size={18} color={onErrorContainer} />
          <text>Clipboard hidden while session is locked</text>
        </row>
      }>
        <TextField testId="clipboard-search" class="clipboard-search" ariaLabel={searchPlaceholder} placeholder={searchPlaceholder} value={query()}
          onInput={event => setQuery(event.value)} style={{ width: "100%", height: "38px", lineHeight: "18px", flexShrink: 0,
            borderRadius: "999px", padding: "10px 14px", backgroundColor: containerHigh, color: onSurface }} />
        <row style={{ gap: "6px", flexWrap: "wrap" }}>
          <For each={filters} keyed={false}>
            {chip => {
              const active = () => filter() === chip().key;
              return (
                <Button testId={`clipboard-filter-${chip().key}`} selected={active()}
                  onClick={() => setFilter(chip().key)} style={{ ...pill, flexDirection: "row", gap: "5px",
                    backgroundColor: active() ? primary : containerHigh, color: active() ? onPrimary : onSurface }}>
                  <text>{chip().label}</text>
                  <text style={{ fontSize: "11px" }}>{counts()[chip().key]}</text>
                </Button>
              );
            }}
          </For>
        </row>
        <scroll style={{ flexGrow: 1, flexBasis: "0px", minHeight: "0px", width: "100%", overflow: "hidden auto" }}>
          <column style={{ gap: "6px" }}>
            <Show when={filtered().length > 0} fallback={<text style={{ color: muted, padding: "10px 0" }}>{entries().length ? "No matching entries" : "Clipboard is empty"}</text>}>
              <For each={filtered()} keyed={entry => entry.id}>{entry => <ClipboardRow entry={entry} />}</For>
            </Show>
          </column>
        </scroll>
        <box ariaHidden style={{ height: "1px", flexShrink: 0, backgroundColor: "var(--color-outline-variant)" }} />
        <row style={{ justifyContent: "space-between", alignItems: "center", gap: "8px" }}>
          <text testId="clipboard-count" style={{ color: muted }}>{`${clipboard.data()?.entry_count ?? 0} kept`}</text>
          <Button testId="clipboard-clear" style={{ ...pill, backgroundColor: errorContainer, color: onErrorContainer }}
            onClick={() => { void invokePublic("clipboard.clear", {}); }}>
            <text>Clear unpinned</text>
          </Button>
        </row>
      </Show>
    </column>
  );
}
