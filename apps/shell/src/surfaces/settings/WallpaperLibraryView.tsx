import {
  Button, For, Image, Show, TextField, createEffect, createMemo, createSignal,
  type Accessor, type NativeChild,
} from "@hewel/zgui";
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
import {
  clipped,
  container,
  containerHigh,
  containerHighest,
  grow,
  muted,
  onPrimary,
  onPrimaryContainer,
  onSurface,
  primary,
  primaryContainer,
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
  readonly outputTag: string | null;
  readonly onApply: () => void;
}): NativeChild {
  const { hostClient } = useShellStore();
  const image = useDaemonMedia(hostClient, () => props.item().thumbnail, { fetchCommand: "wallpaper.fetch-blob" });
  const label = () => filenameOf(props.item().source_path, props.item().name);
  return (
    <column style={{ ...grow, gap: "4px", minWidth: "0px" }}>
      <Button
        testId={`wp-lib-item-${props.item().id}`}
        ariaLabel={`Apply wallpaper ${label()}`}
        selected={props.active}
        onClick={props.onApply}
        style={{
          display: "flex", width: "100%", height: "84px", borderRadius: "10px", position: "relative", overflow: "hidden",
          alignItems: "center", justifyContent: "center", backgroundColor: containerHighest,
          border: props.active ? `2px solid ${primary}` : "1px solid color-mix(in srgb, var(--color-outline-variant) 45%, transparent)",
        }}
      >
        <Show when={image.src()} fallback={<ShellIcon name="image" size={20} color={muted} />}>
          {src => <Image ariaHidden src={src()} style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
        </Show>
        <Show when={props.outputTag}>
          {tag => (
            <box ariaHidden style={{
              position: "absolute", left: "6px", top: "6px", height: "18px", padding: "0 6px", borderRadius: "6px",
              display: "flex", alignItems: "center", justifyContent: "center",
              backgroundColor: "var(--color-surface-container-lowest)",
              color: onSurface,
            }}>
              <text style={{ fontFamily: "var(--font-mono)", fontSize: "10px", lineHeight: "12px", fontWeight: 600 }}>
                {tag()}
              </text>
            </box>
          )}
        </Show>
        <Show when={props.active}>
          <box ariaHidden style={{
            position: "absolute", right: "6px", bottom: "6px", width: "18px", height: "18px", borderRadius: "999px",
            "--zgui-corner-shape": "none", display: "flex", alignItems: "center", justifyContent: "center",
            backgroundColor: primary,
          }}>
            <ShellIcon name="check" size={11} color={onPrimary} />
          </box>
        </Show>
      </Button>
      <text style={{ ...clipped, fontFamily: "var(--font-mono)", fontSize: "11px", lineHeight: "14px", color: props.active ? onSurface : muted }}>
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
    <column testId="settings-wallpaper-library" style={{ ...grow, height: "100%", width: "100%", gap: "12px", minHeight: "0px" }}>
      <row style={{ alignItems: "center", justifyContent: "space-between", gap: "8px", width: "100%", flexShrink: 0 }}>
        <row style={{ alignItems: "center", gap: "10px", minWidth: "0px", flexGrow: 1 }}>
          <Button testId="wp-library-back" ariaLabel="Back to Appearance" onClick={props.onBack} style={{
            display: "flex", width: "30px", height: "30px", borderRadius: "10px", flexShrink: 0,
            alignItems: "center", justifyContent: "center", backgroundColor: containerHigh,
          }}>
            <ShellIcon name="arrowLeft" size={16} color={onSurface} />
          </Button>
          <column style={{ ...grow, gap: "1px" }}>
            <text role="heading" style={{ fontSize: "18px", fontWeight: 600, letterSpacing: "-0.015em", lineHeight: "22px" }}>
              Wallpaper library
            </text>
            <text data-tabular="true" style={{ ...clipped, fontFamily: "var(--font-mono)", fontSize: "11px", lineHeight: "15px", color: muted, fontVariantNumeric: "tabular-nums" }}>
              {`${totalCount()} ${totalCount() === 1 ? "file" : "files"} · ${directories().length} ${directories().length === 1 ? "folder" : "folders"}`}
            </text>
          </column>
        </row>
        <row style={{ alignItems: "center", gap: "6px", flexShrink: 0 }}>
          <Button testId="wp-library-output" ariaLabel="Cycle target output" onClick={() => setOutputIndex(index => index + 1)} style={{
            display: "flex", alignItems: "center", justifyContent: "center", height: "30px",
            padding: "0 10px", borderRadius: "8px", backgroundColor: containerHigh, color: muted, fontSize: "11px", fontWeight: 500,
          }}>
            <text>{selectedOutput() ? `Output (${selectedOutput()})` : `All outputs (${monitors()[0]?.name ?? "default"})`}</text>
          </Button>
          <Button testId="wp-library-random" onClick={() => void invokePublic("wallpaper.random", selectedOutput() ? { output: selectedOutput() } : {})} style={{
            display: "flex", alignItems: "center", justifyContent: "center", gap: "5px", height: "30px",
            padding: "0 10px", borderRadius: "8px", backgroundColor: containerHigh, color: onSurface, fontSize: "11px", fontWeight: 500,
          }}>
            <ShellIcon name="shuffle" size={13} color={primary} />
            <text>Random</text>
          </Button>
          <Button testId="wp-library-rescan" onClick={() => {
            void invokePublic("wallpaper.rescan", {}).then(result => { if (result) setScanRevision(rev => rev + 1); });
          }} style={{
            display: "flex", alignItems: "center", justifyContent: "center", height: "30px",
            padding: "0 10px", borderRadius: "8px", backgroundColor: containerHigh, color: onSurface, fontSize: "11px", fontWeight: 500,
          }}>
            <text>Rescan</text>
          </Button>
          <Button testId="settings-window-close" ariaLabel="Close settings" onClick={props.onCloseSettings} style={{
            display: "flex", width: "30px", height: "30px", borderRadius: "10px", flexShrink: 0,
            alignItems: "center", justifyContent: "center", backgroundColor: containerHigh,
          }}>
            <ShellIcon name="close" size={15} color={muted} />
          </Button>
        </row>
      </row>

      <column style={{ borderRadius: "16px", backgroundColor: containerHigh, padding: "10px 12px", gap: "8px", flexShrink: 0 }}>
        <row style={{ alignItems: "center", gap: "8px", width: "100%" }}>
          <row data-composite-input="true" style={{
            ...grow, height: "32px", borderRadius: "10px", padding: filterFocused() ? "0 9px" : "0 10px", gap: "8px",
            alignItems: "center", backgroundColor: container,
            border: filterFocused()
              ? "2px solid var(--color-primary)"
              : "1px solid color-mix(in srgb, var(--color-outline-variant) 45%, transparent)",
          }}>
            <ShellIcon name="search" size={14} color={filterFocused() ? primary : muted} />
            <TextField
              testId="wp-library-filter"
              class="shell-composite-field"
              ariaLabel="Filter wallpapers by filename"
              placeholder="Filter wallpapers by filename..."
              value={query()}
              onInput={ev => setQuery(ev.value)}
              onFocus={() => setFilterFocused(true)}
              onBlur={() => setFilterFocused(false)}
              style={{
                ...grow, height: "26px", padding: "4px 0", lineHeight: "18px",
                backgroundColor: "transparent", color: onSurface, fontSize: "12px",
              }}
            />
          </row>
          <M3SegmentedControl
            ariaLabel="Wallpaper fit mode"
            compact
            options={FIT_OPTIONS}
            value={currentFit()}
            onChange={fit => patchWallpaper({ fit })}
            style={{ width: "224px", flexShrink: 0 }}
          />
        </row>

        <row style={{ alignItems: "center", justifyContent: "space-between", gap: "8px", width: "100%" }}>
          <row style={{ alignItems: "center", gap: "5px", flexWrap: "wrap", ...grow }}>
            <For each={directories()} keyed={dir => dir}>
              {dir => (
                <row style={{
                  alignItems: "center", gap: "4px", height: "24px", padding: "0 2px 0 7px", borderRadius: "8px",
                  backgroundColor: container, border: "1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent)",
                  maxWidth: "172px",
                }}>
                  <ShellIcon name="folder" size={12} color={primary} />
                  <text style={{ ...clipped, fontFamily: "var(--font-mono)", fontSize: "10px", lineHeight: "14px", color: onSurface }}>
                    {dir()}
                  </text>
                  <Button
                    ariaLabel={`Remove folder ${dir()}`}
                    onClick={() => removeDirectory(dir())}
                    style={{
                      display: "flex", alignItems: "center", justifyContent: "center",
                      width: "24px", height: "24px", borderRadius: "6px", backgroundColor: "transparent", flexShrink: 0,
                    }}
                  >
                    <ShellIcon name="close" size={11} color={muted} />
                  </Button>
                </row>
              )}
            </For>
            <Button testId="wp-library-add-folder" onClick={() => setAddFolderOpen(open => !open)} style={{
              display: "flex", alignItems: "center", justifyContent: "center", height: "24px", padding: "0 8px",
              borderRadius: "8px", backgroundColor: addFolderOpen() ? primaryContainer : "transparent",
              border: "1px dashed color-mix(in srgb, var(--color-outline-variant) 70%, transparent)",
              color: addFolderOpen() ? onPrimaryContainer : primary, fontSize: "11px", fontWeight: 500, flexShrink: 0,
            }}>
              <text>+ Add folder</text>
            </Button>
          </row>
          <row style={{ alignItems: "center", gap: "6px", flexShrink: 0 }}>
            <text style={{ fontSize: "11px", color: muted }}>Slideshow</text>
            <Button testId="wp-library-slideshow" ariaLabel="Configure slideshow interval" expanded={slideshowOpen()}
              onClick={() => setSlideshowOpen(open => !open)} style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: "3px", height: "24px",
                padding: "0 8px", borderRadius: "8px",
                backgroundColor: slideshowOpen() ? primaryContainer : container,
                color: slideshowOpen() ? onPrimaryContainer : onSurface, fontSize: "11px", fontWeight: 500,
              }}>
              <text>{formatSlideshowLabel(slideshowSeconds())}</text>
              <ShellIcon name="expandMore" size={13} color={slideshowOpen() ? onPrimaryContainer : muted} />
            </Button>
          </row>
        </row>

        <M3Collapsible open={addFolderOpen()} estimatedHeight={40}>
          <row style={{ alignItems: "center", gap: "8px", paddingTop: "4px", width: "100%" }}>
            <box style={{ ...grow }}>
              <TextField
                testId="wp-library-folder-input"
                ariaLabel="Wallpaper directory path"
                placeholder="~/Pictures/Wallpapers"
                value={folderDraft()}
                onInput={ev => setFolderDraft(ev.value)}
                onKeyDown={ev => {
                  if (ev.key === "Enter") {
                    ev.preventDefault();
                    addDirectory();
                  } else if (ev.key === "Escape") {
                    ev.preventDefault();
                    setAddFolderOpen(false);
                  }
                }}
                style={{
                  width: "100%", height: "30px", borderRadius: "8px", padding: "5px 8px",
                  backgroundColor: container, border: "1px solid color-mix(in srgb, var(--color-outline-variant) 65%, transparent)",
                  color: onSurface, fontFamily: "var(--font-mono)", fontSize: "11px",
                }}
              />
            </box>
            <M3Button testId="wp-library-folder-confirm" variant="filled" size="sm" onClick={addDirectory}>
              <text>Add</text>
            </M3Button>
          </row>
        </M3Collapsible>

        <M3Collapsible open={slideshowOpen()} estimatedHeight={38}>
          <row style={{ alignItems: "center", justifyContent: "space-between", gap: "8px", paddingTop: "4px", width: "100%" }}>
            <text style={{ fontSize: "11px", color: muted }}>Auto-advance interval</text>
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
              style={{ width: "224px", flexShrink: 0 }}
            />
          </row>
        </M3Collapsible>
      </column>

      <scroll testId="wp-library-grid" role="scrollView" ariaLabel="Wallpaper catalog" style={{
        ...grow, minHeight: "0px", width: "100%", overflow: "hidden auto",
      }}>
        <column style={{ gap: "10px", width: "100%", paddingRight: "4px", paddingBottom: "4px" }}>
          <For each={rows()} keyed={row => row[0]?.id ?? "row"} fallback={
            <column testId="wp-library-empty" style={{
              width: "100%", padding: "36px 16px", borderRadius: "16px", backgroundColor: containerHigh,
              alignItems: "center", justifyContent: "center", gap: "6px",
            }}>
              <ShellIcon name="image" size={24} color={muted} />
              <text style={{ fontSize: "13px", fontWeight: 600, color: onSurface }}>
                {query().trim() ? "No matching wallpapers" : "No wallpapers indexed"}
              </text>
              <text style={{ fontSize: "12px", color: muted }}>
                {query().trim() ? "Try clearing the filename filter" : "Add a wallpaper folder above and rescan"}
              </text>
            </column>
          }>
            {row => {
              const spacers = () => Math.max(0, 4 - row().length);
              return (
                <row style={{ gap: "10px", width: "100%", alignItems: "flex-start" }}>
                  <For each={row()} keyed={item => item.id}>
                    {item => (
                      <LibraryTile
                        item={item}
                        active={item().source_path === activeWallpaper()?.source_path}
                        outputTag={outputTagFor(item().source_path)}
                        onApply={() => void invokePublic("wallpaper.set", {
                          path: item().source_path,
                          output: selectedOutput(),
                          fit: currentFit(),
                        })}
                      />
                    )}
                  </For>
                  <For each={Array.from({ length: spacers() }, (_, i) => i)} keyed={i => i}>
                    {() => <box ariaHidden style={{ ...grow }} />}
                  </For>
                </row>
              );
            }}
          </For>
        </column>
      </scroll>

      <row style={{ alignItems: "center", justifyContent: "space-between", gap: "8px", width: "100%", flexShrink: 0 }}>
        <text data-tabular="true" style={{ ...clipped, fontFamily: "var(--font-mono)", fontSize: "11px", color: muted, fontVariantNumeric: "tabular-nums" }}>
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
