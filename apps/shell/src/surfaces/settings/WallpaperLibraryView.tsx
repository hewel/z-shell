import {
  Button, For, Image, Show, TextField, createEffect, createMemo, createSignal, cx, scrollIntoView,
  type Accessor, type NativeChild, type NativeNode,
} from "@hewel/zgui";
import { createVirtualFocus } from "@hewel/zgui/primitives";
import { M3Button, M3Collapsible, M3SegmentedControl } from "@z-shell/sdk/primitives";
import { useDaemonMedia } from "@z-shell/sdk/zgui";
import { ShellIcon } from "../../icons.tsx";
import { useShellStore } from "../../store.ts";
import {
  resolveMonitorWallpaper,
  type CatalogEntry,
  type WallpaperFit,
  type WallpaperListResponse,
} from "../../topics.ts";
import styles from "./WallpaperLibraryView.module.css";
import {
  muted,
  onPrimary,
  onPrimaryContainer,
  onSurface,
  primary,
} from "./shared.tsx";

const FIT_OPTIONS: readonly { readonly id: WallpaperFit; readonly label: string; readonly testId: string }[] = [
  { id: "cover", label: "Cover", testId: "wp-lib-fit-cover" },
  { id: "contain", label: "Contain", testId: "wp-lib-fit-contain" },
  { id: "fill", label: "Fill", testId: "wp-lib-fit-fill" },
  { id: "center", label: "Center", testId: "wp-lib-fit-center" },
];

const SLIDESHOW_PRESETS = [
  { id: "0", seconds: 0, label: "Off", testId: "wp-lib-slide-0" },
  { id: "900", seconds: 900, label: "15m", testId: "wp-lib-slide-900" },
  { id: "1800", seconds: 1800, label: "30m", testId: "wp-lib-slide-1800" },
  { id: "3600", seconds: 3600, label: "1h", testId: "wp-lib-slide-3600" },
] as const;

function filenameOf(path: string, fallback: string): string {
  const slash = path.lastIndexOf("/");
  const base = slash >= 0 ? path.slice(slash + 1) : path;
  return base || fallback;
}

function formatSlideshowLabel(seconds: number): string {
  if (!seconds || seconds <= 0) return "Off";
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

function closestSlideshowPresetId(seconds: number): string {
  const exact = SLIDESHOW_PRESETS.find(preset => preset.seconds === seconds);
  return exact ? exact.id : "0";
}

function LibraryTile(props: {
  readonly item: Accessor<CatalogEntry>;
  readonly active: boolean;
  readonly highlighted: boolean;
  readonly outputTag: string | null;
  readonly registerNode: (node: NativeNode) => void;
  readonly onApply: () => void;
}): NativeChild {
  const { hostClient } = useShellStore();
  const image = useDaemonMedia(hostClient, () => props.item().thumbnail, { fetchCommand: "wallpaper.fetch-blob" });
  const label = () => filenameOf(props.item().source_path, props.item().name);
  return (
    <column class={cx(styles.tileColumn)}>
      <Button
        ref={props.registerNode}
        testId={`wp-lib-item-${props.item().id}`}
        ariaLabel={`Apply wallpaper ${label()}`}
        selected={props.active}
        data-active={props.active ? "true" : null}
        data-highlighted={props.highlighted ? "true" : null}
        onClick={props.onApply}
        class={cx(styles.tileButton)}
      >
        <Show when={image.src()} fallback={<ShellIcon name="image" size={20} color={muted} />}>
          {src => <Image ariaHidden src={src()} class={cx(styles.tileImage)} />}
        </Show>
        <Show when={props.outputTag}>
          {tag => (
            <box ariaHidden class={cx(styles.outputTag)}>
              <text class={cx(styles.outputTagText)}>
                {tag()}
              </text>
            </box>
          )}
        </Show>
        <Show when={props.active}>
          <box ariaHidden class={cx(styles.activeCheckBadge)}>
            <ShellIcon name="check" size={11} color={onPrimary} />
          </box>
        </Show>
      </Button>
      <text class={cx(styles.tileLabel)} data-active={props.active ? "true" : null}>
        {label()}
      </text>
    </column>
  );
}

export function WallpaperLibraryView(props: {
  readonly onBack: () => void;
  readonly onCloseSettings: () => void;
}): NativeChild {
  const { publicClient, monitors, wallpaper, settings, invokePublic, invokeHost } = useShellStore();
  const [catalog, setCatalog] = createSignal<WallpaperListResponse>();
  const [scanRevision, setScanRevision] = createSignal(0);
  const [outputIndex, setOutputIndex] = createSignal(0);
  const [query, setQuery] = createSignal("");
  const [filterFocused, setFilterFocused] = createSignal(false);
  const [addFolderOpen, setAddFolderOpen] = createSignal(false);
  const [folderDraft, setFolderDraft] = createSignal("");
  const [slideshowOpen, setSlideshowOpen] = createSignal(false);

  const outputChoices = createMemo(() => [null, ...monitors().map(monitor => monitor.name)] as const);
  const selectedOutput = () => outputChoices()[outputIndex() % outputChoices().length] ?? null;
  const currentFit = (): WallpaperFit => settings.data()?.wallpaper.fit ?? wallpaper.data()?.fit ?? "cover";
  const slideshowSeconds = () => settings.data()?.wallpaper.slideshow_seconds ?? wallpaper.data()?.slideshow_seconds ?? 0;
  const directories = () => settings.data()?.wallpaper.directories ?? [];

  const activeWallpaper = () => {
    const name = selectedOutput();
    const snapshot = wallpaper.data();
    return name === null ? snapshot?.current : resolveMonitorWallpaper(snapshot, name);
  };

  createEffect(() => [publicClient(), scanRevision(), wallpaper.data()?.available, wallpaper.data()?.catalog_count] as const, ([client]) => {
    if (!client) return;
    let live = true;
    void invokePublic("wallpaper.list", {}).then(result => {
      if (!live) return;
      const data = result?.data as WallpaperListResponse | undefined;
      if (data) setCatalog(data);
    });
    return () => { live = false; };
  });

  const allItems = () => catalog()?.items ?? [];
  const totalCount = () => catalog()?.total ?? wallpaper.data()?.catalog_count ?? allItems().length;
  const filteredItems = createMemo(() => {
    const needle = query().trim().toLowerCase();
    const items = allItems();
    if (!needle) return items;
    return items.filter(item =>
      filenameOf(item.source_path, item.name).toLowerCase().includes(needle)
      || item.name.toLowerCase().includes(needle),
    );
  });

  const rows = createMemo(() => {
    const items = filteredItems();
    const chunks: CatalogEntry[][] = [];
    for (let i = 0; i < items.length; i += 4) {
      chunks.push(items.slice(i, i + 4));
    }
    return chunks;
  });

  function applyWallpaper(item: CatalogEntry): void {
    void invokePublic("wallpaper.set", {
      path: item.source_path,
      output: selectedOutput(),
      fit: currentFit(),
    });
  }

  const virtualFocus = createVirtualFocus({
    items: filteredItems,
    getId: item => item.id,
    columns: 4,
    textValue: query,
    onActivate: applyWallpaper,
    onReveal: () => {
      const node = virtualFocus.activeNode();
      if (node) scrollIntoView(node, { block: "nearest" });
    },
  });

  function patchWallpaper(patch: Record<string, unknown>): void {
    void invokeHost("settings.patch", { wallpaper: patch });
  }

  function addDirectory(): void {
    const next = folderDraft().trim();
    if (!next) return;
    const current = directories();
    if (!current.includes(next)) {
      void invokeHost("settings.patch", { wallpaper: { directories: [...current, next] } }).then(() => {
        void invokePublic("wallpaper.rescan", {}).then(() => setScanRevision(rev => rev + 1));
      });
    }
    setFolderDraft("");
    setAddFolderOpen(false);
  }

  function removeDirectory(dir: string): void {
    const next = directories().filter(candidate => candidate !== dir);
    void invokeHost("settings.patch", { wallpaper: { directories: next } }).then(() => {
      void invokePublic("wallpaper.rescan", {}).then(() => setScanRevision(rev => rev + 1));
    });
  }

  function outputTagFor(sourcePath: string): string | null {
    const overrides = wallpaper.data()?.per_output ?? {};
    const target = selectedOutput();
    if (target && overrides[target]?.source_path === sourcePath) return target;
    for (const [output, entry] of Object.entries(overrides)) {
      if (entry.source_path === sourcePath) return output;
    }
    return null;
  }

  return (
    <column testId="settings-wallpaper-library" class={cx(styles.view)}>
      <row class={cx(styles.headerRow)}>
        <row class={cx(styles.headerLead)}>
          <Button testId="wp-library-back" ariaLabel="Back to Appearance" onClick={props.onBack} class={cx(styles.iconButton)}>
            <ShellIcon name="arrowLeft" size={16} color={onSurface} />
          </Button>
          <column class={cx(styles.titleCol)}>
            <text role="heading" class={cx(styles.heading)}>
              Wallpaper library
            </text>
            <text data-tabular="true" class={cx(styles.headerMeta)}>
              {`${totalCount()} ${totalCount() === 1 ? "file" : "files"} · ${directories().length} ${directories().length === 1 ? "folder" : "folders"}`}
            </text>
          </column>
        </row>
        <row class={cx(styles.headerActions)}>
          <Button testId="wp-library-output" ariaLabel="Cycle target output" onClick={() => setOutputIndex(index => index + 1)} class={cx(styles.headerMutedButton)}>
            <text>{selectedOutput() ? `Output (${selectedOutput()})` : `All outputs (${monitors()[0]?.name ?? "default"})`}</text>
          </Button>
          <Button testId="wp-library-random" onClick={() => void invokePublic("wallpaper.random", selectedOutput() ? { output: selectedOutput() } : {})} class={cx(styles.headerButton)}>
            <ShellIcon name="shuffle" size={13} color={primary} />
            <text>Random</text>
          </Button>
          <Button testId="wp-library-rescan" onClick={() => {
            void invokePublic("wallpaper.rescan", {}).then(result => { if (result) setScanRevision(rev => rev + 1); });
          }} class={cx(styles.headerButton)}>
            <text>Rescan</text>
          </Button>
          <Button testId="settings-window-close" ariaLabel="Close settings" onClick={props.onCloseSettings} class={cx(styles.iconButton)}>
            <ShellIcon name="close" size={15} color={muted} />
          </Button>
        </row>
      </row>

      <column class={cx(styles.controlsCard)}>
        <row class={cx(styles.searchRow)}>
          <row data-composite-input="true" class={cx(styles.searchPill)} data-focused={filterFocused() ? "true" : null}>
            <ShellIcon name="search" size={14} color={filterFocused() ? primary : muted} />
            <TextField
              testId="wp-library-filter"
              class={cx("shell-composite-field", styles.searchField)}
              ariaLabel="Filter wallpapers by filename"
              placeholder="Filter wallpapers by filename..."
              ariaActiveDescendant={virtualFocus.activeNode()}
              value={query()}
              onInput={ev => setQuery(ev.value)}
              onKeyDown={virtualFocus.onKeyDown}
              onFocus={() => setFilterFocused(true)}
              onBlur={() => setFilterFocused(false)}
            />
          </row>
          <box class={cx(styles.fitSegmented)}>
            <M3SegmentedControl
              ariaLabel="Wallpaper fit mode"
              compact
              options={FIT_OPTIONS}
              value={currentFit()}
              onChange={fit => patchWallpaper({ fit })}
            />
          </box>
        </row>

        <row class={cx(styles.foldersBar)}>
          <row class={cx(styles.foldersWrap)}>
            <For each={directories()} keyed={dir => dir}>
              {dir => (
                <row class={cx(styles.folderChip)}>
                  <ShellIcon name="folder" size={12} color={primary} />
                  <text class={cx(styles.folderText)}>
                    {dir()}
                  </text>
                  <Button
                    ariaLabel={`Remove folder ${dir()}`}
                    onClick={() => removeDirectory(dir())}
                    class={cx(styles.removeFolderButton)}
                  >
                    <ShellIcon name="close" size={11} color={muted} />
                  </Button>
                </row>
              )}
            </For>
            <Button
              testId="wp-library-add-folder"
              onClick={() => setAddFolderOpen(open => !open)}
              class={cx(styles.addFolderButton)}
              data-active={addFolderOpen() ? "true" : null}
            >
              <text>+ Add folder</text>
            </Button>
          </row>
          <row class={cx(styles.slideshowRow)}>
            <text class={cx(styles.slideshowLabel)}>Slideshow</text>
            <Button
              testId="wp-library-slideshow"
              ariaLabel="Configure slideshow interval"
              expanded={slideshowOpen()}
              onClick={() => setSlideshowOpen(open => !open)}
              class={cx(styles.slideshowButton)}
              data-active={slideshowOpen() ? "true" : null}
            >
              <text>{formatSlideshowLabel(slideshowSeconds())}</text>
              <ShellIcon name="expandMore" size={13} color={slideshowOpen() ? onPrimaryContainer : muted} />
            </Button>
          </row>
        </row>

        <M3Collapsible open={addFolderOpen()} estimatedHeight={40}>
          <row class={cx(styles.collapsibleRow)}>
            <box class={cx(styles.growBox)}>
              <TextField
                testId="wp-library-folder-input"
                ariaLabel="Wallpaper directory path"
                placeholder="~/Pictures/Wallpapers"
                value={folderDraft()}
                onInput={ev => setFolderDraft(ev.value)}
                onKeyDown={ev => {
                  if (ev.isComposing) return;
                  if (ev.key === "Enter") {
                    ev.preventDefault();
                    addDirectory();
                  } else if (ev.key === "Escape") {
                    ev.preventDefault();
                    setAddFolderOpen(false);
                  }
                }}
                class={cx(styles.folderInput)}
              />
            </box>
            <M3Button testId="wp-library-folder-confirm" variant="filled" size="sm" onClick={addDirectory}>
              <text>Add</text>
            </M3Button>
          </row>
        </M3Collapsible>

        <M3Collapsible open={slideshowOpen()} estimatedHeight={38}>
          <row class={cx(styles.slideshowCollapsibleRow)}>
            <text class={cx(styles.slideshowIntervalLabel)}>Auto-advance interval</text>
            <box class={cx(styles.slideshowSegmented)}>
              <M3SegmentedControl
                ariaLabel="Slideshow interval"
                compact
                options={SLIDESHOW_PRESETS}
                value={closestSlideshowPresetId(slideshowSeconds())}
                onChange={id => {
                  const match = SLIDESHOW_PRESETS.find(preset => preset.id === id);
                  if (match) patchWallpaper({ slideshow_seconds: match.seconds });
                  setSlideshowOpen(false);
                }}
              />
            </box>
          </row>
        </M3Collapsible>
      </column>

      <scroll testId="wp-library-grid" role="scrollView" ariaLabel="Wallpaper catalog" class={cx(styles.gridScroll)}>
        <column class={cx(styles.gridColumn)}>
          <For each={rows()} keyed={row => row[0]?.id ?? "row"} fallback={
            <column testId="wp-library-empty" class={cx(styles.emptyColumn)}>
              <ShellIcon name="image" size={24} color={muted} />
              <text class={cx(styles.emptyTitle)}>
                {query().trim() ? "No matching wallpapers" : "No wallpapers indexed"}
              </text>
              <text class={cx(styles.emptySubtitle)}>
                {query().trim() ? "Try clearing the filename filter" : "Add a wallpaper folder above and rescan"}
              </text>
            </column>
          }>
            {row => {
              const spacers = () => Math.max(0, 4 - row().length);
              return (
                <row class={cx(styles.gridRow)}>
                  <For each={row()} keyed={item => item.id}>
                    {item => (
                      <LibraryTile
                        item={item}
                        active={item().source_path === activeWallpaper()?.source_path}
                        highlighted={filterFocused() && virtualFocus.activeId() === item().id}
                        outputTag={outputTagFor(item().source_path)}
                        registerNode={node => { virtualFocus.register(item().id, node); }}
                        onApply={() => {
                          virtualFocus.setActive(item().id);
                          applyWallpaper(item());
                        }}
                      />
                    )}
                  </For>
                  <For each={Array.from({ length: spacers() }, (_, i) => i)} keyed={i => i}>
                    {() => <box ariaHidden class={cx(styles.growBox)} />}
                  </For>
                </row>
              );
            }}
          </For>
        </column>
      </scroll>

      <row class={cx(styles.footerRow)}>
        <text data-tabular="true" class={cx(styles.footerCount)}>
          {`Showing ${filteredItems().length} of ${totalCount()} · Click any thumbnail to apply immediately`}
        </text>
        <M3Button
          testId="wp-library-clear"
          variant="text"
          danger
          size="sm"
          onClick={() => void invokePublic("wallpaper.clear", selectedOutput() ? { output: selectedOutput() } : {})}
        >
          <text>Clear wallpaper</text>
        </M3Button>
      </row>
    </column>
  );
}
