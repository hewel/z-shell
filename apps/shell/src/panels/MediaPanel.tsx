import { Button, For, Image, Show, createMemo, getWindowRect, type Accessor } from "@hewel/zgui";
import { useDaemonMedia } from "@z-shell/sdk/zgui";
import { ShojiIcon } from "../icons.tsx";
import { useShellStore } from "../store.ts";
import { formatTrackTimeUs, selectActiveMediaPlayer, type MediaPlayer } from "../topics.ts";

const primary = "var(--color-primary)";
const onPrimary = "var(--color-on-primary)";
const onSurface = "var(--color-on-surface)";
const muted = "var(--color-on-surface-variant)";
const container = "var(--color-surface-container)";
const containerHigh = "var(--color-surface-container-high)";
const pill = { display: "flex", minHeight: "30px", padding: "4px 10px", borderRadius: "16px", alignItems: "center", justifyContent: "center" } as const;
const coverTile = { width: "64px", height: "64px", flexShrink: 0, borderRadius: "14px" } as const;
const coverImage = { ...coverTile, "object-fit": "cover" } as const;
const truncate = { overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" } as const;
const skip = { display: "flex", width: "36px", height: "36px", borderRadius: "999px", alignItems: "center", justifyContent: "center", backgroundColor: containerHigh } as const;
const tenSecondsUs = 10_000_000;

function TrackControls(props: { player: Accessor<MediaPlayer> }) {
  const { media, hostClient, invokePublic } = useShellStore();
  const { player } = props;
  const { src } = useDaemonMedia(hostClient, () => media.data()?.cover, { fetchCommand: "media.fetch-blob" });
  const playing = () => player().playback_status === "playing";
  const length = () => player().metadata.length_us;
  const position = () => player().position_us;
  const canSeek = () => player().capabilities.can_seek;
  const canScrub = () => canSeek() && (length() ?? 0) > 0 && position() != null;
  const fraction = () => Math.max(0, Math.min(1, (position() ?? 0) / (length() || 1)));
  const canPlayPause = () => playing() ? player().capabilities.can_pause : player().capabilities.can_play;

  function seek(offsetUs: number) {
    const current = player();
    if (current.capabilities.can_seek) void invokePublic("media.seek", { player_id: current.id, offset_us: offsetUs });
  }

  return (
    <>
      <row style={{ alignItems: "center", gap: "12px" }}>
        <Show when={src()} fallback={
          <box style={{ ...coverTile, display: "flex", backgroundColor: container, alignItems: "center", justifyContent: "center" }}>
            <ShojiIcon name="mediaEq" size={28} color={primary} />
          </box>
        }>
          <Image testId="media-cover" src={src()} style={coverImage} />
        </Show>
        <column style={{ flexGrow: 1, flexBasis: "0px", minWidth: "0px", gap: "3px" }}>
          <text testId="media-title" style={{ ...truncate, fontSize: "18px", fontWeight: 600 }}>{player().metadata.title ?? "Unknown track"}</text>
          <Show when={player().metadata.artists.length > 0}>
            <text style={{ ...truncate, color: muted }}>{player().metadata.artists.join(" · ")}</text>
          </Show>
          <Show when={player().metadata.album}>
            <text style={{ ...truncate, color: muted, fontSize: "11px" }}>{player().metadata.album}</text>
          </Show>
        </column>
      </row>
      <column style={{ gap: "4px" }}>
        <control testId="media-progress" role={canScrub() ? "slider" : "progressIndicator"} ariaLabel="Track position"
          tabIndex={canScrub() ? 0 : -1} ariaValueMin={0} ariaValueMax={length()} ariaValueNow={position()}
          style={{ display: "flex", height: "20px", justifyContent: "center", flexDirection: "column" }}
          onPointerDown={event => {
            if (!event.primary || !(event.button === "primary" || (event.button === null && event.pointerKind !== "mouse"))) return;
            const duration = length();
            const current = position();
            if (!canSeek() || duration == null || duration <= 0 || current == null) return;
            const rect = getWindowRect(event.currentTarget);
            if (!rect || rect.width <= 0) return;
            const target = Math.max(0, Math.min(1, (event.position.x - rect.x) / rect.width));
            seek(Math.round(target * duration - current));
          }}
          onKeyDown={event => {
            if (!canScrub() || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
            event.preventDefault();
            seek(event.key === "ArrowLeft" ? -tenSecondsUs : tenSecondsUs);
          }}>
          <box style={{ height: "6px", borderRadius: "3px", backgroundColor: "var(--color-surface-container-highest)", overflow: "hidden" }}>
            <box style={{ width: `${fraction() * 100}%`, height: "100%", borderRadius: "3px", backgroundColor: primary }} />
          </box>
        </control>
        <row style={{ justifyContent: "space-between", alignItems: "center", gap: "8px" }}>
          <text style={{ color: muted, fontSize: "11px" }}>{formatTrackTimeUs(position()) || "—"}</text>
          <row style={{ gap: "6px" }}>
            <Button testId="media-seek-back" ariaLabel="Seek back 10 seconds" disabled={!canSeek()}
              onClick={() => seek(-tenSecondsUs)} style={{ ...pill, backgroundColor: containerHigh }}><text>-10s</text></Button>
            <Button testId="media-seek-forward" ariaLabel="Seek forward 10 seconds" disabled={!canSeek()}
              onClick={() => seek(tenSecondsUs)} style={{ ...pill, backgroundColor: containerHigh }}><text>+10s</text></Button>
          </row>
          <text style={{ color: muted, fontSize: "11px" }}>{formatTrackTimeUs(length()) || "—"}</text>
        </row>
      </column>
      <row style={{ justifyContent: "center", alignItems: "center", gap: "16px" }}>
        <Button testId="media-prev" ariaLabel="Previous track" disabled={!player().capabilities.can_go_previous} style={skip}
          onClick={() => { void invokePublic("media.previous", { player_id: player().id }); }}>
          <ShojiIcon name="skipPrev" size={18} />
        </Button>
        <Button testId="media-play-pause" ariaLabel={playing() ? "Pause" : "Play"} disabled={!canPlayPause()}
          style={{ ...skip, width: "52px", height: "52px", borderRadius: "999px", backgroundColor: primary }}
          onClick={() => { void invokePublic("media.play-pause", { player_id: player().id }); }}>
          <ShojiIcon name={playing() ? "pause" : "play"} size={24} color={onPrimary} />
        </Button>
        <Button testId="media-next" ariaLabel="Next track" disabled={!player().capabilities.can_go_next} style={skip}
          onClick={() => { void invokePublic("media.next", { player_id: player().id }); }}>
          <ShojiIcon name="skipNext" size={18} />
        </Button>
      </row>
    </>
  );
}

export function MediaPanel() {
  const { media, audio, invokePublic } = useShellStore();
  const activePlayer = createMemo(() => selectActiveMediaPlayer(media.data()));
  const sink = createMemo(() => {
    const snapshot = audio.data();
    return snapshot?.sinks.find(device => device.name === snapshot.default_sink)?.description ?? "Audio";
  });

  return (
    <column testId="panel-media" style={{ width: "100%", height: "100%", minHeight: "calc(100vh - 2px)", padding: "16px", gap: "12px", flexDirection: "column", backgroundColor: "var(--color-surface)", color: onSurface, fontFamily: "var(--font-sans)", fontSize: "13px" }}>
      <row style={{ alignItems: "flex-start", justifyContent: "space-between", gap: "8px" }}>
        <row style={{ flexWrap: "wrap", gap: "6px", flexGrow: 1, flexBasis: "0px", minWidth: "0px" }}>
          <For each={media.data()?.players ?? []} keyed={player => player.id}>
            {player => {
              const active = () => player().id === activePlayer()?.id;
              return (
                <Button testId={`media-player-${player().id}`} selected={active()}
                  onClick={() => { void invokePublic("media.select-player", { player_id: player().id }); }}
                  style={{ ...pill, maxWidth: "100%", backgroundColor: active() ? primary : containerHigh, color: active() ? onPrimary : onSurface }}>
                  <text style={truncate}>{player().identity}</text>
                </Button>
              );
            }}
          </For>
        </row>
        <row style={{ ...pill, maxWidth: "48%", flexDirection: "row", gap: "5px", backgroundColor: "var(--color-secondary-container)", color: "var(--color-on-secondary-container)" }}>
          <ShojiIcon name="volumeHigh" size={14} color="currentColor" />
          <text style={{ ...truncate, minWidth: "0px" }}>{sink()}</text>
        </row>
      </row>
      <Show when={activePlayer()} fallback={
        <column style={{ flexGrow: 1, alignItems: "center", justifyContent: "center", gap: "8px", color: muted }}>
          <ShojiIcon name="mediaEq" size={28} color={primary} />
          <text>Nothing playing</text>
        </column>
      }>
        {player => <TrackControls player={player} />}
      </Show>
    </column>
  );
}
