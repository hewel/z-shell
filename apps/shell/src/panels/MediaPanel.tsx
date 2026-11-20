import { Button, For, Image, Show, createMemo, getWindowRect, type Accessor } from "@hewel/zgui";
import { useDaemonMedia } from "@z-shell/sdk/zgui";
import { ShellIcon } from "../icons.tsx";
import { useShellStore } from "../store.ts";
import { formatTrackTimeUs, selectActiveMediaPlayer, type MediaPlayer } from "../topics.ts";

const primary = "var(--color-primary)";
const onPrimary = "var(--color-on-primary)";
const onSurface = "var(--color-on-surface)";
const muted = "var(--color-on-surface-variant)";
const container = "var(--color-surface-container)";
const containerHigh = "var(--color-surface-container-high)";
const containerHighest = "var(--color-surface-container-highest)";
const pill = {
  display: "flex", minHeight: "26px", padding: "4px 10px", borderRadius: "14px",
  alignItems: "center", justifyContent: "center", gap: "5px", flexShrink: 0,
} as const;
const coverTile = { width: "72px", height: "72px", flexShrink: 0, borderRadius: "16px" } as const;
const coverImage = { ...coverTile, objectFit: "cover" } as const;
const truncate = { overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" } as const;
const skipBtn = {
  display: "flex", width: "44px", height: "44px", borderRadius: "999px",
  alignItems: "center", justifyContent: "center", backgroundColor: "transparent", flexShrink: 0,
} as const;
const subTransportBtn = {
  display: "flex", width: "36px", height: "36px", borderRadius: "999px",
  alignItems: "center", justifyContent: "center", flexShrink: 0,
} as const;
const tenSecondsUs = 10_000_000;

/**
 * Generates an analytically regular wavy playback progress SVG path on 0 0 328 28.
 * Expressive-Budget Rule: wavy progress tracks are reserved strictly for MediaPanel.tsx.
 */
function buildWavyWavePath(playheadX: number): string {
  const halfPeriod = 9;
  const amplitude = 4.5;
  const midY = 14;
  const waveEnd = Math.max(8, playheadX - 5);
  let wave = `M 4 ${midY}`;
  let x = 4;
  let up = true;
  while (x + halfPeriod <= waveEnd) {
    const cx = x + halfPeriod / 2;
    const cy = up ? midY - amplitude : midY + amplitude;
    const nx = x + halfPeriod;
    wave += ` Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${nx.toFixed(1)} ${midY}`;
    x = nx;
    up = !up;
  }
  if (waveEnd - x > 1) {
    const cx = (x + waveEnd) / 2;
    const cy = up ? midY - amplitude * ((waveEnd - x) / halfPeriod) : midY + amplitude * ((waveEnd - x) / halfPeriod);
    wave += ` Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${waveEnd.toFixed(1)} ${midY}`;
  }
  return wave;
}

function WavyProgressTrack(props: {
  fraction: number;
  canScrub: boolean;
  lengthUs: number | null;
  positionUs: number | null;
  onSeekOffset: (offsetUs: number) => void;
}) {
  const clamped = () => Math.max(0.03, Math.min(0.97, props.fraction));
  const playheadX = () => Math.round(clamped() * 316) + 6;
  const wavePath = createMemo(() => buildWavyWavePath(playheadX()));
  const restPct = () => `${Math.max(0, 100 - clamped() * 100 - 2.5).toFixed(2)}%`;

  return (
    <control testId="media-progress" role={props.canScrub ? "slider" : "progressIndicator"} ariaLabel="Track position"
      tabIndex={props.canScrub ? 0 : -1} ariaValueMin={0} ariaValueMax={props.lengthUs} ariaValueNow={props.positionUs}
      style={{ display: "flex", height: "28px", width: "100%", alignItems: "center", position: "relative" }}
      onPointerDown={event => {
        if (!event.primary || !(event.button === "primary" || (event.button === null && event.pointerKind !== "mouse"))) return;
        const duration = props.lengthUs;
        const current = props.positionUs;
        if (!props.canScrub || duration == null || duration <= 0 || current == null) return;
        const rect = getWindowRect(event.currentTarget);
        if (!rect || rect.width <= 0) return;
        const target = Math.max(0, Math.min(1, (event.position.x - rect.x) / rect.width));
        props.onSeekOffset(Math.round(target * duration - current));
      }}
      onKeyDown={event => {
        if (!props.canScrub || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
        event.preventDefault();
        props.onSeekOffset(event.key === "ArrowLeft" ? -tenSecondsUs : tenSecondsUs);
      }}>
      <vector ariaHidden d={wavePath()} viewBox="0 0 328 28" style={{
        position: "absolute", inset: "0px", width: "100%", height: "28px",
        "--zgui-fill": "transparent",
        "--zgui-stroke": primary,
        "--zgui-stroke-width": "4px",
        "--zgui-stroke-linecap": "round",
        "--zgui-stroke-linejoin": "round",
      }} />
      <box ariaHidden style={{
        position: "absolute", right: "2px", height: "4px", width: restPct(),
        borderRadius: "2px", backgroundColor: containerHighest,
      }} />
      <box ariaHidden style={{
        position: "absolute", left: `${(clamped() * 100).toFixed(2)}%`,
        width: "6px", height: "24px", borderRadius: "3px", backgroundColor: primary,
      }} />
    </control>
  );
}

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
      <row style={{ alignItems: "center", gap: "14px", width: "100%" }}>
        <Show when={src()} fallback={
          <box style={{ ...coverTile, display: "flex", backgroundColor: containerHighest, alignItems: "center", justifyContent: "center" }}>
            <ShellIcon name="mediaEq" size={28} color={primary} />
          </box>
        }>
          <Image testId="media-cover" src={src()} style={coverImage} />
        </Show>
        <column style={{ flexGrow: 1, flexBasis: "0px", minWidth: "0px", gap: "2px" }}>
          <text testId="media-title" style={{ ...truncate, fontSize: "16px", fontWeight: 600, lineHeight: "22px" }}>
            {player().metadata.title ?? "Unknown track"}
          </text>
          <Show when={player().metadata.artists.length > 0}>
            <text style={{ ...truncate, fontSize: "14px", color: onSurface, opacity: 0.85, lineHeight: "20px" }}>
              {player().metadata.artists.join(" · ")}
            </text>
          </Show>
          <Show when={player().metadata.album}>
            <text style={{ ...truncate, color: muted, fontSize: "12px", fontWeight: 500, lineHeight: "16px" }}>
              {player().metadata.album}
            </text>
          </Show>
        </column>
      </row>

      <column style={{ gap: "2px", width: "100%" }}>
        <WavyProgressTrack fraction={fraction()} canScrub={canScrub()} lengthUs={length()} positionUs={position()} onSeekOffset={seek} />
        <row style={{ justifyContent: "space-between", alignItems: "center", padding: "0 2px" }}>
          <text data-tabular="true" style={{ fontFamily: "var(--font-mono)", color: muted, fontSize: "11px", fontVariantNumeric: "tabular-nums" }}>
            {formatTrackTimeUs(position()) || "—"}
          </text>
          <text data-tabular="true" style={{ fontFamily: "var(--font-mono)", color: muted, fontSize: "11px", fontVariantNumeric: "tabular-nums" }}>
            {formatTrackTimeUs(length()) || "—"}
          </text>
        </row>
      </column>

      <row style={{ justifyContent: "space-between", alignItems: "center", padding: "0 8px", width: "100%" }}>
        <Button testId="media-seek-back" ariaLabel="Seek back 10 seconds" disabled={!canSeek()}
          onClick={() => seek(-tenSecondsUs)} style={{ ...subTransportBtn, opacity: canSeek() ? 1 : 0.45 }}>
          <ShellIcon name="fastRewind" size={18} color={muted} />
        </Button>
        <Button testId="media-prev" ariaLabel="Previous track" disabled={!player().capabilities.can_go_previous} style={skipBtn}
          onClick={() => { void invokePublic("media.previous", { player_id: player().id }); }}>
          <ShellIcon name="skipPrev" size={24} color={onSurface} />
        </Button>
        <Button testId="media-play-pause" ariaLabel={playing() ? "Pause" : "Play"} disabled={!canPlayPause()}
          style={{
            display: "flex", width: "72px", height: "56px", borderRadius: "999px", flexShrink: 0,
            alignItems: "center", justifyContent: "center", backgroundColor: primary,
          }}
          onClick={() => { void invokePublic("media.play-pause", { player_id: player().id }); }}>
          <ShellIcon name={playing() ? "pause" : "play"} size={26} color={onPrimary} />
        </Button>
        <Button testId="media-next" ariaLabel="Next track" disabled={!player().capabilities.can_go_next} style={skipBtn}
          onClick={() => { void invokePublic("media.next", { player_id: player().id }); }}>
          <ShellIcon name="skipNext" size={24} color={onSurface} />
        </Button>
        <Button testId="media-seek-forward" ariaLabel="Seek forward 10 seconds" disabled={!canSeek()}
          onClick={() => seek(tenSecondsUs)} style={{ ...subTransportBtn, opacity: canSeek() ? 1 : 0.45 }}>
          <ShellIcon name="fastForward" size={18} color={muted} />
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
    <column testId="panel-media" style={{
      width: "100%", padding: "14px", flexDirection: "column",
      backgroundColor: container, color: onSurface, fontFamily: "var(--font-sans)", fontSize: "13px",
    }}>
      <column style={{ borderRadius: "16px", backgroundColor: containerHigh, padding: "14px", gap: "14px", width: "100%" }}>
        <row style={{ alignItems: "center", justifyContent: "space-between", gap: "8px", width: "100%" }}>
          <row style={{ flexWrap: "wrap", gap: "6px", flexGrow: 1, flexBasis: "0px", minWidth: "0px" }}>
            <For each={media.data()?.players ?? []} keyed={player => player.id}>
              {player => {
                const active = () => player().id === activePlayer()?.id;
                return (
                  <Button testId={`media-player-${player().id}`} selected={active()}
                    onClick={() => { void invokePublic("media.select-player", { player_id: player().id }); }}
                    style={{
                      ...pill, maxWidth: "100%",
                      backgroundColor: active() ? primary : containerHighest,
                      color: active() ? onPrimary : muted,
                      fontSize: "11px", fontWeight: active() ? 600 : 500,
                    }}>
                    <ShellIcon name="musicNote" size={12} color={active() ? onPrimary : muted} />
                    <text style={truncate}>{player().identity}</text>
                  </Button>
                );
              }}
            </For>
          </row>
          <row style={{ ...pill, maxWidth: "48%", backgroundColor: containerHighest, color: onSurface, fontSize: "11px", fontWeight: 500 }}>
            <ShellIcon name="headphones" size={14} color={primary} />
            <text style={{ ...truncate, minWidth: "0px" }}>{sink()}</text>
          </row>
        </row>
        <Show when={activePlayer()} fallback={
          <column style={{ padding: "24px 0", alignItems: "center", justifyContent: "center", gap: "8px", color: muted }}>
            <ShellIcon name="mediaEq" size={28} color={primary} />
            <text>Nothing playing</text>
          </column>
        }>
          {player => <TrackControls player={player} />}
        </Show>
      </column>
    </column>
  );
}
