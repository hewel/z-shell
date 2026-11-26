import { createEffect, createMemo, createSignal, For, Image, LayerSurface, Show, type Accessor, type Monitor, type NativeChild } from "@hewel/zgui";
import type { MediaRef } from "@z-shell/sdk";
import { useDaemonMedia } from "@z-shell/sdk/zgui";
import { createM3Spring, useMotionScheme } from "../motion.ts";
import { useShellStore } from "../store.ts";
import { useShellTheme } from "../theme.ts";
import { formatSurfaceName, resolveMonitorLogicalSize, resolveMonitorWallpaper, type ActiveWallpaper } from "../topics.ts";
import styles from "./WallpaperLayer.module.css";

type WallpaperRequest = { readonly wallpaper: ActiveWallpaper };
type WallpaperSource = { readonly request: WallpaperRequest; readonly src: string };

function sameMedia(a: MediaRef, b: MediaRef): boolean {
  return a.kind === "runtime_path"
    ? b.kind === "runtime_path" && a.path === b.path && a.revision === b.revision
    : b.kind === "blob_handle" && a.token === b.token;
}

function WallpaperContent(props: { readonly monitor: Accessor<Monitor>; readonly active: Accessor<ActiveWallpaper | null> }): NativeChild {
  const { theme, hostClient } = useShellStore();
  useShellTheme(theme.data);
  const scheme = useMotionScheme();

  const requested = createMemo<WallpaperRequest | null>(previous => {
    const wallpaper = props.active();
    if (wallpaper === null) return null;
    return previous && sameMedia(previous.wallpaper.media, wallpaper.media) ? previous : { wallpaper };
  });
  const [currentSrc, setCurrentSrc] = createSignal<WallpaperSource>();
  const [previousSrc, setPreviousSrc] = createSignal<WallpaperSource>();

  // Keep a separate owner (and blob lease) for each image until its pixels are no longer needed.
  const frames = () => {
    const previous = previousSrc()?.request;
    const current = currentSrc()?.request;
    const next = requested();
    const result: WallpaperRequest[] = [];
    if (previous) result.push(previous);
    if (current) result.push(current);
    if (next && next !== current) result.push(next);
    return result;
  };

  return (
    <For each={frames()}>
      {request => {
        const { wallpaper } = request;
        const media = useDaemonMedia(hostClient, wallpaper.media, { fetchCommand: "wallpaper.fetch-blob" });
        const isCurrent = () => currentSrc()?.request === request;
        const isPrevious = () => previousSrc()?.request === request;
        const [target, setTarget] = createSignal(0);
        const progress = createM3Spring(target, "slowEffects", { scheme });
        createEffect(media.src, src => {
          if (src === undefined || requested() !== request) return;
          const current = currentSrc();
          if (current?.request === request && current.src === src) return;
          const fade = current !== undefined && current.request !== request && current.src !== src;
          setPreviousSrc(fade ? current : undefined);
          setCurrentSrc({ request, src });
          if (fade) setTarget(1);
        });
        createEffect(() => isCurrent() && progress() === 1, settled => {
          if (settled) setPreviousSrc(undefined);
        });

        const objectFit = createMemo<string>(previous => {
          if (previous !== undefined && requested() !== request) return previous;
          const fit = props.active()?.fit ?? wallpaper.fit;
          return fit === "center" ? "none" : fit;
        });
        const opacity = () => (isCurrent() && previousSrc() ? Math.min(1, Math.max(0, progress())) : 1);
        return (
          <Show when={isCurrent() || isPrevious()}>
            <Image
              testId={`wallpaper-${isCurrent() ? "image" : "previous"}-${props.monitor().id}`}
              src={media.src()}
              class={styles.wallpaperImage}
              data-fit={objectFit()}
              style={{ opacity: opacity() }}
            />
          </Show>
        );
      }}
    </For>
  );
}

function MonitorWallpaper(props: { readonly monitor: Accessor<Monitor> }): NativeChild {
  const { outputs, wallpaper } = useShellStore();
  const { monitor } = props;
  const active = () => resolveMonitorWallpaper(wallpaper.data(), monitor().name);
  const size = createMemo(() => resolveMonitorLogicalSize(monitor(), outputs.data()));
  return (
    <Show when={active()}>
      <LayerSurface
        name={formatSurfaceName("wallpaper", monitor().id)}
        output={monitor().id}
        layer="background"
        anchor={["top", "bottom", "left", "right"]}
        width={size().width}
        height={size().height}
        exclusiveZone={-1}
        keyboard="none"
        inputRegion="empty"
      >
        <WallpaperContent monitor={monitor} active={active} />
      </LayerSurface>
    </Show>
  );
}

export function WallpaperLayer(): NativeChild {
  const { monitors } = useShellStore();
  return (
    <For each={monitors()} keyed={monitor => monitor.id}>
      {monitor => <MonitorWallpaper monitor={monitor} />}
    </For>
  );
}
