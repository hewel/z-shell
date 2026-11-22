import { Button, For, Image, Show, createMemo, createSignal, getWindowRect, type Accessor } from "@hewel/zgui";
import { M3Collapsible } from "@z-shell/sdk/primitives";
import { useDaemonMedia } from "@z-shell/sdk/zgui";
import { ShellIcon } from "../icons.tsx";
import { SPRING_EPSILON, createM3Spring, createPhaseLoop, useMotionScheme } from "../motion.ts";
import { useShellStore } from "../store.ts";
import { formatTrackTimeUs, selectActiveMediaPlayer, type MediaPlayer } from "../topics.ts";

const primary = "var(--color-primary)";
const onPrimary = "var(--color-on-primary)";
const primaryContainer = "var(--color-primary-container)";
const onPrimaryContainer = "var(--color-on-primary-container)";
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
  display: "flex", width: "44px", height: "44px", borderRadius: "999px", "--zgui-corner-shape": "none",
  alignItems: "center", justifyContent: "center", backgroundColor: "transparent", flexShrink: 0,
} as const;
const subTransportBtn = {
  display: "flex", width: "36px", height: "36px", borderRadius: "999px", "--zgui-corner-shape": "none",
  alignItems: "center", justifyContent: "center", flexShrink: 0,
} as const;
const tenSecondsUs = 10_000_000;

/**
 * Generates an analytically regular wavy playback progress SVG path on 0 0 328 28.
 * Expressive-Budget Rule: wavy progress tracks are reserved strictly for MediaPanel.tsx.
 * When `amplitudeScale === 0` (paused or reduced motion), flattens to a crisp straight track.
 */
function buildWavyWavePath(playheadX: number, amplitudeScale: number, phasePx: number): string {
  const halfPeriod = 9;
  const quarterPeriod = halfPeriod / 2;
  const amplitude = 4.5 * Math.max(0, Math.min(1, amplitudeScale));
  const midY = 14;
  const waveStart = 4;
  const waveEnd = Math.max(8, playheadX - 7);
  if (amplitude < 0.05) {
    return `M ${waveStart} ${midY} L ${waveEnd.toFixed(2)} ${midY}`;
  }
  const period = halfPeriod * 2;
  const phaseOffset = ((phasePx % period) + period) % period;
  const k = Math.PI / halfPeriod;
  const yAt = (x: number): number => midY - Math.sin((x - phaseOffset) * k) * amplitude;
  const dyAt = (x: number): number => -Math.cos((x - phaseOffset) * k) * amplitude * k;

  // Split at every quarter-period knot so each Hermite cubic Bezier segment spans <= pi/2
  // with exact C1 tangents (0 slope at peaks/troughs) and < 0.05px deviation from sin(x).
  const knots: number[] = [waveStart];
  const firstIndex = Math.floor((waveStart - phaseOffset) / quarterPeriod) + 1;
  for (let x = phaseOffset + firstIndex * quarterPeriod; x < waveEnd - 0.05; x += quarterPeriod) {
    if (x > waveStart + 0.05) knots.push(x);
  }
  knots.push(waveEnd);

  const startY = yAt(waveStart);
  let wave = `M ${waveStart.toFixed(2)} ${startY.toFixed(2)}`;
  for (let i = 1; i < knots.length; i++) {
    const x0 = knots[i - 1]!;
    const x1 = knots[i]!;
    const dx = x1 - x0;
    const y0 = yAt(x0);
    const y1 = yAt(x1);
    const cx1 = x0 + dx / 3;
    const cy1 = y0 + dyAt(x0) * (dx / 3);
    const cx2 = x1 - dx / 3;
    const cy2 = y1 - dyAt(x1) * (dx / 3);
    wave += ` C ${cx1.toFixed(2)} ${cy1.toFixed(2)} ${cx2.toFixed(2)} ${cy2.toFixed(2)} ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  }
  return wave;
}

function WavyProgressTrack(props: {
  fraction: number;
  playing: boolean;
  canScrub: boolean;
  lengthUs: number | null;
  positionUs: number | null;
  onSeekOffset: (offsetUs: number) => void;
}) {
  const scheme = useMotionScheme();
  const waveAmplitude = createM3Spring(() => props.playing && scheme() !== "reduced" ? 1 : 0, "defaultSpatial", { scheme });
  const phase = createPhaseLoop(() => props.playing, 24, scheme);
  const clamped = () => Math.max(0.03, Math.min(0.97, props.fraction));
  const isFlat = () => !props.playing || scheme() === "reduced";
  // Track inner width is 340px (396 - 56 padding); viewBox 0..328 is centered at x=[6, 334].
  const playheadX = () => Math.round(clamped() * 340) - 6;
  const wavePath = createMemo(() => buildWavyWavePath(playheadX(), waveAmplitude(), phase()));
  const restPct = () => `${Math.max(0, 100 - clamped() * 100 - 3.0).toFixed(2)}%`;

  return (
    <control testId="media-progress" role={props.canScrub ? "slider" : "progressIndicator"} ariaLabel="Track position"
      data-slider={props.canScrub ? "true" : null}
      data-progress={props.canScrub ? null : "true"}
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
        "--zgui-stroke-width": isFlat() ? "5px" : "4px",
        "--zgui-stroke-linecap": "round",
        "--zgui-stroke-linejoin": "round",
      }} />
      <box ariaHidden style={{
        position: "absolute", right: "2px", height: isFlat() ? "5px" : "4px", width: restPct(),
        display: "flex", alignItems: "center", justifyContent: "flex-end", paddingRight: "1px",
        borderRadius: "3px", "--zgui-corner-shape": "none", backgroundColor: containerHighest,
      }}>
        <Show when={clamped() < 0.94}>
          <box ariaHidden data-slider-stop-dot="true" style={{
            width: "4px", height: "4px", borderRadius: "999px", "--zgui-corner-shape": "none", backgroundColor: primary, flexShrink: 0,
          }} />
        </Show>
      </box>
      <box ariaHidden data-slider-thumb="true" style={{
        position: "absolute", left: `${(clamped() * 100).toFixed(2)}%`,
        width: "4px", height: "20px", borderRadius: "2px", "--zgui-corner-shape": "none", backgroundColor: primary,
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
        <WavyProgressTrack fraction={fraction()} playing={playing()} canScrub={canScrub()} lengthUs={length()} positionUs={position()} onSeekOffset={seek} />
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
            display: "flex", width: "72px", height: "56px", borderRadius: "999px", "--zgui-corner-shape": "none", flexShrink: 0,
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

function SinkChevron(props: { readonly open: boolean; readonly color: string }) {
  const scheme = useMotionScheme();
  const deg = createM3Spring(() => (props.open ? 180 : 0), "fastSpatial", { scheme, epsilon: SPRING_EPSILON.deg });
  return (
    <box ariaHidden style={{
      display: "flex", width: "14px", height: "14px", alignItems: "center", justifyContent: "center", flexShrink: 0,
      transform: scheme() === "reduced" ? "none" : `rotate(${deg().toFixed(1)}deg)`,
    }}>
      <ShellIcon name="expandMore" size={14} color={props.color} />
    </box>
  );
}

export function MediaPanel() {
  const { media, audio, invokePublic, openQuickSettingsSubpage } = useShellStore();
  const [sinkPickerOpen, setSinkPickerOpen] = createSignal(false);
  const activePlayer = createMemo(() => selectActiveMediaPlayer(media.data()));
  const players = () => media.data()?.players ?? [];
  const sinks = () => audio.data()?.sinks ?? [];
  const defaultSinkName = () => audio.data()?.default_sink ?? null;
  const sink = createMemo(() => {
    const snapshot = audio.data();
    return snapshot?.sinks.find(device => device.name === snapshot.default_sink)?.description ?? "Audio";
  });

  return (
    <column testId="panel-media" style={{
      width: "100%", padding: "14px", flexDirection: "column",
      backgroundColor: "transparent", color: onSurface, fontFamily: "var(--font-sans)", fontSize: "13px",
    }}>
      <column style={{ borderRadius: "16px", backgroundColor: containerHigh, padding: "14px", gap: "14px", width: "100%" }}>
        <row style={{ alignItems: "center", justifyContent: "space-between", gap: "8px", width: "100%" }}>
          <Show when={players().length > 0} fallback={
            <text style={{ fontSize: "14px", fontWeight: 600, color: onSurface }}>Media</text>
          }>
            <row style={{ flexWrap: "wrap", gap: "6px", flexGrow: 1, flexBasis: "0px", minWidth: "0px" }}>
              <For each={players()} keyed={player => player.id}>
                {player => {
                  const active = () => player().id === activePlayer()?.id;
                  return (
                    <Button testId={`media-player-${player().id}`} selected={active()}
                      onClick={() => { void invokePublic("media.select-player", { player_id: player().id }); }}
                      style={{
                        ...pill, maxWidth: "100%",
                        backgroundColor: active() ? primaryContainer : containerHighest,
                        border: active()
                          ? "1px solid color-mix(in srgb, var(--color-primary) 30%, transparent)"
                          : "1px solid transparent",
                        color: active() ? onPrimaryContainer : muted,
                        fontSize: "11px", fontWeight: active() ? 600 : 500,
                      }}>
                      <ShellIcon name="musicNote" size={12} color={active() ? onPrimaryContainer : muted} />
                      <text style={truncate}>{player().identity}</text>
                    </Button>
                  );
                }}
              </For>
            </row>
          </Show>
          <Button
            testId="media-sink-toggle"
            ariaLabel={`Audio output: ${sink()}`}
            expanded={sinkPickerOpen()}
            selected={sinkPickerOpen()}
            onClick={() => setSinkPickerOpen(open => !open)}
            style={{
              ...pill, maxWidth: "52%",
              backgroundColor: sinkPickerOpen() ? primaryContainer : containerHighest,
              border: sinkPickerOpen()
                ? "1px solid color-mix(in srgb, var(--color-primary) 35%, transparent)"
                : "1px solid transparent",
              color: sinkPickerOpen() ? onPrimaryContainer : onSurface,
              fontSize: "11px", fontWeight: 500,
            }}
          >
            <ShellIcon name="headphones" size={14} color={sinkPickerOpen() ? onPrimaryContainer : primary} />
            <text style={{ ...truncate, minWidth: "0px" }}>{sink()}</text>
            <SinkChevron open={sinkPickerOpen()} color={sinkPickerOpen() ? onPrimaryContainer : muted} />
          </Button>
        </row>

        <M3Collapsible open={sinkPickerOpen()} estimatedHeight={156}>
          <column testId="media-sink-drawer" style={{
            width: "100%", borderRadius: "14px", backgroundColor: container, padding: "10px", gap: "6px",
            border: "1px solid color-mix(in srgb, var(--color-outline-variant) 45%, transparent)",
          }}>
            <row style={{ alignItems: "center", justifyContent: "space-between", gap: "8px", padding: "0 2px" }}>
              <text style={{ fontSize: "10px", lineHeight: "14px", fontWeight: 600, letterSpacing: "0.05em", color: muted }}>
                AUDIO OUTPUT
              </text>
              <Button
                testId="media-sound-settings"
                onClick={() => openQuickSettingsSubpage("sound")}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  height: "24px", padding: "0 6px", borderRadius: "6px",
                  backgroundColor: "transparent", color: primary, fontSize: "11px", fontWeight: 500,
                }}
              >
                <text>Sound settings →</text>
              </Button>
            </row>
            <scroll style={{ width: "100%", maxHeight: "180px", overflow: "hidden auto" }}>
              <column style={{ gap: "4px", width: "100%" }}>
                <For each={sinks()} keyed={device => device.index} fallback={
                  <text style={{ fontSize: "12px", color: muted, padding: "6px 4px" }}>No audio output devices</text>
                }>
                  {device => {
                    const isDefault = () => device().name === defaultSinkName();
                    const label = () => device().description || device().name;
                    return (
                      <Button
                        testId={`media-sink-${device().index}`}
                        selected={isDefault()}
                        ariaLabel={`Use audio output ${label()}`}
                        onClick={() => { void invokePublic("audio.set-default", { kind: "sink", index: device().index }); }}
                        style={{
                          display: "flex", flexDirection: "row", alignItems: "center", gap: "8px", width: "100%",
                          minHeight: "34px", padding: "6px 10px", borderRadius: "10px",
                          backgroundColor: isDefault() ? primaryContainer : "transparent",
                          border: isDefault()
                            ? "1px solid color-mix(in srgb, var(--color-primary) 35%, transparent)"
                            : "1px solid transparent",
                          color: isDefault() ? onPrimaryContainer : onSurface,
                        }}
                      >
                        <ShellIcon name={isDefault() ? "check" : "volumeHigh"} size={14} color={isDefault() ? onPrimaryContainer : muted} />
                        <text style={{
                          ...truncate, flexGrow: 1, flexBasis: "0px", minWidth: "0px",
                          fontSize: "12px", fontWeight: isDefault() ? 600 : 500, textAlign: "left",
                        }}>
                          {label()}
                        </text>
                        <text data-tabular="true" style={{
                          fontFamily: "var(--font-mono)", fontSize: "11px", lineHeight: "14px",
                          fontVariantNumeric: "tabular-nums", flexShrink: 0,
                          color: isDefault() ? onPrimaryContainer : muted,
                        }}>
                          {`${Math.round(device().volume * 100)}%`}
                        </text>
                      </Button>
                    );
                  }}
                </For>
              </column>
            </scroll>
          </column>
        </M3Collapsible>

        <Show when={activePlayer()} fallback={
          <column testId="media-idle-empty" style={{
            width: "100%", borderRadius: "14px", backgroundColor: container,
            padding: "28px 16px", alignItems: "center", justifyContent: "center", gap: "8px",
          }}>
            <box ariaHidden style={{
              display: "flex", width: "40px", height: "40px", borderRadius: "999px", "--zgui-corner-shape": "none",
              alignItems: "center", justifyContent: "center", backgroundColor: containerHigh,
            }}>
              <ShellIcon name="musicNote" size={20} color={primary} />
            </box>
            <text style={{ fontSize: "14px", fontWeight: 600, color: onSurface }}>Nothing playing</text>
            <text style={{ fontSize: "12px", color: muted }}>Start music or video in any MPRIS app</text>
          </column>
        }>
          {player => <TrackControls player={player} />}
        </Show>
      </column>
    </column>
  );
}
