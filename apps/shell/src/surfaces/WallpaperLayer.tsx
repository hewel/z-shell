import { createEffect, createMemo, createSignal, createSpring, For, Image, LayerSurface, Show, type Accessor, type Monitor, type NativeChild } from "@hewel/zgui";
import type { MediaRef } from "@z-shell/sdk";
import { useDaemonMedia } from "@z-shell/sdk/zgui";
import { useShellStore } from "../store.ts";
import { useShellTheme } from "../theme.ts";
import { resolveMonitorWallpaper, type ActiveWallpaper } from "../topics.ts";

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
        // createSpring has no jump API. Each new image owns a fresh spring starting at zero.
        const progress = createSpring(target, { stiffness: 180, damping: 26 });
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

        const objectFit = createMemo(previous => {
          if (previous !== undefined && requested() !== request) return previous;
          const fit = props.active()?.fit ?? wallpaper.fit;
          return fit === "center" ? "none" : fit;
        });
        // The bridge accepts object-fit; the NativeStyle declaration does not list it yet.
        const style = () => ({
          position: "fixed",
          left: "0px",
          top: "0px",
          width: "100%",
          height: "100%",
          "object-fit": objectFit(),
          opacity: isCurrent() && previousSrc() ? Math.min(1, Math.max(0, progress())) : 1,
        });
        return (
          <Show when={isCurrent() || isPrevious()}>
            <Image
              testId={`wallpaper-${isCurrent() ? "image" : "previous"}-${props.monitor().id}`}
              src={media.src()}
              style={style()}
            />
          </Show>
        );
      }}
    </For>
  );
}

function MonitorWallpaper(props: { readonly monitor: Accessor<Monitor> }): NativeChild {
  const { wallpaper } = useShellStore();
  const { monitor } = props;
  const active = () => resolveMonitorWallpaper(wallpaper.data(), monitor().name);
  return (
    <Show when={active()}>
      <LayerSurface
        name={`wallpaper-${monitor().id}`}
        output={monitor().id}
        layer="background"
        anchor={["top", "bottom", "left", "right"]}
        width={monitor().width}
        height={monitor().height}
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
