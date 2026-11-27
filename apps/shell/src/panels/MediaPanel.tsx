import { Button, For, Image, Show, createMemo, createSignal, cx, getWindowRect, type Accessor } from "@hewel/zgui";
import { M3Collapsible } from "@z-shell/sdk/primitives";
import { useDaemonMedia } from "@z-shell/sdk/zgui";
import { ShellIcon } from "../icons.tsx";
import { SPRING_EPSILON, createM3Spring, createPhaseLoop, useMotionScheme } from "../motion.ts";
import { useShellStore } from "../store.ts";
import { formatTrackTimeUs, selectActiveMediaPlayer, type MediaPlayer } from "../topics.ts";
import styles from "./MediaPanel.module.css";

const primary = "var(--color-primary)";
const onPrimary = "var(--color-on-primary)";
const onPrimaryContainer = "var(--color-on-primary-container)";
const onSurface = "var(--color-on-surface)";
const muted = "var(--color-on-surface-variant)";
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
    <control
      testId="media-progress"
      role={props.canScrub ? "slider" : "progressIndicator"}
      ariaLabel="Track position"
      data-slider={props.canScrub ? "true" : null}
      data-progress={props.canScrub ? null : "true"}
      tabIndex={props.canScrub ? 0 : -1}
      ariaValueMin={0}
      ariaValueMax={props.lengthUs}
      ariaValueNow={props.positionUs}
      class={styles.progressControl}
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
      }}
    >
      <vector ariaHidden d={wavePath()} viewBox="0 0 328 28" class={styles.wavyVector} data-flat={isFlat() ? "true" : "false"} />
      <box ariaHidden class={styles.wavyRestTrack} data-flat={isFlat() ? "true" : "false"} style={{ width: restPct() }}>
        <Show when={clamped() < 0.94}>
          <box ariaHidden data-slider-stop-dot="true" class={styles.wavyStopDot} />
        </Show>
      </box>
      <box ariaHidden data-slider-thumb="true" class={styles.wavyThumb} style={{ left: `${(clamped() * 100).toFixed(2)}%` }} />
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
      <row class={styles.trackHeader}>
        <Show when={src()} fallback={
          <box class={cx(styles.coverTile, styles.coverFallback)}>
            <ShellIcon name="mediaEq" size={28} color={primary} />
          </box>
        }>
          <Image testId="media-cover" src={src()} class={cx(styles.coverTile, styles.coverImage)} />
        </Show>
        <column class={styles.trackMetaCol}>
          <text testId="media-title" class={cx(styles.truncate, styles.trackTitle)}>
            {player().metadata.title ?? "Unknown track"}
          </text>
          <Show when={player().metadata.artists.length > 0}>
            <text class={cx(styles.truncate, styles.trackArtists)}>
              {player().metadata.artists.join(" · ")}
            </text>
          </Show>
          <Show when={player().metadata.album}>
            <text class={cx(styles.truncate, styles.trackAlbum)}>
              {player().metadata.album}
            </text>
          </Show>
        </column>
      </row>

      <column class={styles.progressCol}>
        <WavyProgressTrack fraction={fraction()} playing={playing()} canScrub={canScrub()} lengthUs={length()} positionUs={position()} onSeekOffset={seek} />
        <row class={styles.timeRow}>
          <text data-tabular="true" class={styles.timeLabel}>
            {formatTrackTimeUs(position()) || "—"}
          </text>
          <text data-tabular="true" class={styles.timeLabel}>
            {formatTrackTimeUs(length()) || "—"}
          </text>
        </row>
      </column>

      <row class={styles.transportRow}>
        <Button
          testId="media-seek-back"
          ariaLabel="Seek back 10 seconds"
          disabled={!canSeek()}
          data-disabled={!canSeek() ? "true" : "false"}
          onClick={() => seek(-tenSecondsUs)}
          class={styles.subTransportBtn}
        >
          <ShellIcon name="fastRewind" size={18} color={muted} />
        </Button>
        <Button
          testId="media-prev"
          ariaLabel="Previous track"
          disabled={!player().capabilities.can_go_previous}
          class={styles.skipBtn}
          onClick={() => { void invokePublic("media.previous", { player_id: player().id }); }}
        >
          <ShellIcon name="skipPrev" size={20} color={onSurface} />
        </Button>
        <Button
          testId="media-play-pause"
          ariaLabel={playing() ? "Pause" : "Play"}
          disabled={!canPlayPause()}
          class={styles.playPauseBtn}
          onClick={() => { void invokePublic("media.play-pause", { player_id: player().id }); }}
        >
          <ShellIcon name={playing() ? "pause" : "play"} size={22} color={onPrimary} />
        </Button>
        <Button
          testId="media-next"
          ariaLabel="Next track"
          disabled={!player().capabilities.can_go_next}
          class={styles.skipBtn}
          onClick={() => { void invokePublic("media.next", { player_id: player().id }); }}
        >
          <ShellIcon name="skipNext" size={20} color={onSurface} />
        </Button>
        <Button
          testId="media-seek-forward"
          ariaLabel="Seek forward 10 seconds"
          disabled={!canSeek()}
          data-disabled={!canSeek() ? "true" : "false"}
          onClick={() => seek(tenSecondsUs)}
          class={styles.subTransportBtn}
        >
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
    <box
      ariaHidden
      class={styles.sinkChevron}
      style={{
        transform: scheme() === "reduced" ? "none" : `rotate(${deg().toFixed(1)}deg)`,
      }}
    >
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
    <column testId="panel-media" class={styles.panel}>
      <column class={styles.card}>
        <row class={styles.topBar}>
          <Show when={players().length > 0} fallback={
            <text class={styles.mediaFallbackTitle}>Media</text>
          }>
            <row class={styles.playersRow}>
              <For each={players()} keyed={player => player.id}>
                {player => {
                  const active = () => player().id === activePlayer()?.id;
                  return (
                    <Button
                      testId={`media-player-${player().id}`}
                      selected={active()}
                      data-active={active() ? "true" : "false"}
                      onClick={() => { void invokePublic("media.select-player", { player_id: player().id }); }}
                      class={cx(styles.pill, styles.playerPill)}
                    >
                      <ShellIcon name="musicNote" size={12} color={active() ? onPrimaryContainer : muted} />
                      <text class={styles.truncate}>{player().identity}</text>
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
            data-open={sinkPickerOpen() ? "true" : "false"}
            onClick={() => setSinkPickerOpen(open => !open)}
            class={cx(styles.pill, styles.sinkToggle)}
          >
            <ShellIcon name="headphones" size={14} color={sinkPickerOpen() ? onPrimaryContainer : primary} />
            <text class={cx(styles.truncate, styles.sinkLabel)}>{sink()}</text>
            <SinkChevron open={sinkPickerOpen()} color={sinkPickerOpen() ? onPrimaryContainer : muted} />
          </Button>
        </row>

        <M3Collapsible open={sinkPickerOpen()} estimatedHeight={156}>
          <column testId="media-sink-drawer" class={styles.sinkDrawer}>
            <row class={styles.sinkDrawerHeader}>
              <text class={styles.sinkDrawerHeading}>
                AUDIO OUTPUT
              </text>
              <Button
                testId="media-sound-settings"
                onClick={() => openQuickSettingsSubpage("sound")}
                class={styles.soundSettingsBtn}
              >
                <text>Sound settings →</text>
              </Button>
            </row>
            <scroll class={styles.sinkScroll}>
              <column class={styles.sinkList}>
                <For each={sinks()} keyed={device => device.index} fallback={
                  <text class={styles.sinkEmpty}>No audio output devices</text>
                }>
                  {device => {
                    const isDefault = () => device().name === defaultSinkName();
                    const label = () => device().description || device().name;
                    return (
                      <Button
                        testId={`media-sink-${device().index}`}
                        selected={isDefault()}
                        data-selected={isDefault() ? "true" : "false"}
                        ariaLabel={`Use audio output ${label()}`}
                        onClick={() => { void invokePublic("audio.set-default", { kind: "sink", index: device().index }); }}
                        class={styles.sinkItem}
                      >
                        <ShellIcon name={isDefault() ? "check" : "volumeHigh"} size={14} color={isDefault() ? onPrimaryContainer : muted} />
                        <text class={cx(styles.truncate, styles.sinkItemName)} data-selected={isDefault() ? "true" : "false"}>
                          {label()}
                        </text>
                        <text data-tabular="true" class={styles.sinkItemVol} data-selected={isDefault() ? "true" : "false"}>
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
          <column testId="media-idle-empty" class={styles.emptyCard}>
            <box ariaHidden class={styles.emptyIconWell}>
              <ShellIcon name="musicNote" size={20} color={primary} />
            </box>
            <text class={styles.emptyTitle}>Nothing playing</text>
            <text class={styles.emptySubtitle}>Start music or video in any MPRIS app</text>
          </column>
        }>
          {player => <TrackControls player={player} />}
        </Show>
      </column>
    </column>
  );
}
