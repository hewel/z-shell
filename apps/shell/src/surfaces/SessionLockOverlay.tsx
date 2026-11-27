import {
  Button, For, Image, SessionLockSurface, Show, TextField, createDelay, createEffect, createMemo, createSignal, cx, flush,
  focus, getSessionGeneration, onCleanup, requestSessionLock, useCapsLock,
  type Accessor, type Monitor, type NativeChild, type NativeNode, type SessionLockRequest,
} from "@hewel/zgui";
import { useDaemonMedia } from "@z-shell/sdk/zgui";
import { ShellIcon } from "../icons.tsx";
import {
  SPRING_EPSILON,
  createM3Spring,
  createOpacityEnter,
  createPresence,
  useMotionScheme,
} from "../motion.ts";
import { LOCK_MORPH_SHAPES, SHELL_ROSETTE_CLIP_104, SHELL_ROSETTE_PATH } from "../shapes.ts";
import { useShellStore } from "../store.ts";
import { formatBarClock, formatFullDate, formatSurfaceName, resolveMonitorWallpaper, selectActiveMediaPlayer, type UnlockApproval } from "../topics.ts";
import styles from "./SessionLockOverlay.module.css";

type LockScope = { readonly lockId: number; readonly daemonId: string | undefined };
type ActiveLock = LockScope & { readonly request: SessionLockRequest; confirmed: boolean };
type LockOutcome = LockScope & { readonly state: "locked" | "refused" | "finished" };

type LockControls = {
  readonly username: Accessor<string>;
  readonly password: Accessor<string>;
  readonly setPassword: (value: string) => void;
  readonly authenticating: Accessor<boolean>;
  readonly disabled: Accessor<boolean>;
  readonly sleepHold: Accessor<boolean>;
  readonly error: Accessor<string | null>;
  readonly submit: () => Promise<void>;
};

const clockFormat = { clock24h: true, clockSeconds: false };
const MORPH_SEQUENCE = [
  LOCK_MORPH_SHAPES.Cookie4,
  LOCK_MORPH_SHAPES.Clover4,
  LOCK_MORPH_SHAPES.Sunny,
  LOCK_MORPH_SHAPES.Circle,
  LOCK_MORPH_SHAPES.Cookie6,
  LOCK_MORPH_SHAPES.Flower5,
] as const;
const MAX_VISIBLE_DOTS = 14;

function MorphPasswordDot(props: { readonly d: string; readonly viewBox: string; readonly visible: Accessor<boolean>; readonly error?: Accessor<boolean> }): NativeChild {
  const scheme = useMotionScheme();
  const presence = createPresence(() => props.visible(), {
    scheme,
    enterRole: "fastSpatial",
    enterOpacityRole: "fastEffects",
    exitRole: "fastEffects",
    overrideScheme: "expressive",
  });
  const scale = () => (props.visible() ? 0.2 + presence.progress() * 0.8 : presence.progress());
  const deg = () => (props.visible() ? (1 - presence.progress()) * -45 : 0);
  return (
    <Show when={presence.mounted()}>
      <vector
        ariaHidden
        d={props.d}
        viewBox={props.viewBox}
        data-error={props.error?.() ? "true" : "false"}
        class={styles.morphDot}
        style={{
          opacity: Math.max(0, Math.min(1, presence.opacity())),
          transform: scheme() === "reduced"
            ? "none"
            : `scale(${scale().toFixed(4)}) rotate(${deg().toFixed(1)}deg)`,
        }}
      />
    </Show>
  );
}

function LockScreen(props: {
  readonly monitor: Accessor<Monitor>;
  readonly primary: Accessor<boolean>;
  readonly clock: Accessor<{ readonly time: string; readonly date: string }>;
  readonly avatar: Accessor<string | undefined>;
  readonly controls: LockControls;
}): NativeChild {
  const { hostClient, wallpaper, power, ime, media } = useShellStore();
  const capsLock = useCapsLock();
  const scheme = useMotionScheme();
  const entryFade = createOpacityEnter("slowEffects", scheme);
  const shakeX = createM3Spring(() => 0, "fastSpatial", {
    scheme,
    overrideScheme: "expressive",
    epsilon: SPRING_EPSILON.px,
  });
  createEffect(() => props.controls.error(), err => {
    if (err) shakeX.impulse(650);
  });
  const activeWallpaper = createMemo(() => resolveMonitorWallpaper(wallpaper.data(), props.monitor().name));
  const backdrop = useDaemonMedia(hostClient, () => activeWallpaper()?.media, { fetchCommand: "wallpaper.fetch-blob" });
  const playing = () => {
    const player = selectActiveMediaPlayer(media.data());
    return player?.playback_status === "playing" ? player : null;
  };
  const [field, setField] = createSignal<NativeNode>();
  const [passwordFocused, setPasswordFocused] = createSignal(false);
  createEffect(() => props.primary() && !props.controls.disabled() ? field() : undefined, node => {
    if (node) focus(node);
  });
  const dotSlots = Array.from({ length: MAX_VISIBLE_DOTS }, (_, index) => ({
    index,
    shape: MORPH_SEQUENCE[index % MORPH_SEQUENCE.length]!,
  }));
  const dotCount = () => Math.min(props.controls.password().length, MAX_VISIBLE_DOTS);

  return (
    <box class={styles.lockRoot} style={{ opacity: Math.max(0, Math.min(1, entryFade())) }}>
      <Show when={backdrop.src()}>{src => <>
        <Image
          ariaHidden
          src={src()}
          data-fit={activeWallpaper()?.fit === "center" ? "none" : activeWallpaper()?.fit ?? "cover"}
          class={styles.backdropImage}
        />
        <box ariaHidden class={styles.backdropScrim} />
      </>}</Show>
      <Show when={power.data()?.battery}>{battery => {
        const label = createMemo(() => {
          const percentage = battery().percentage;
          return percentage == null ? "—" : `${Math.round(percentage)}%`;
        });
        return (
          <row testId={`lock-battery-${props.monitor().id}`} class={styles.batteryPill}>
            <ShellIcon name={battery().state === "charging" ? "batteryCharging" : "battery"} size={18} color="var(--color-on-surface)" />
            <text data-tabular="true" class={styles.batteryLabel}>
              {label()}
            </text>
          </row>
        );
      }}</Show>
      <box class={styles.clockSection}>
        <text testId={`lock-clock-${props.monitor().id}`} class={styles.clockTime}>
          {props.clock().time}
        </text>
        <text class={styles.clockDate}>{props.clock().date}</text>
      </box>
      <box class={styles.authSection}>
        <box ariaHidden class={styles.avatarBox}>
          <vector ariaHidden d={SHELL_ROSETTE_PATH} viewBox="0 0 64 64" class={styles.avatarRosette} />
          <Show when={props.avatar()} fallback={
            <ShellIcon name="person" size={46} color="var(--color-on-primary-container)" />
          }>{src => <Image ariaHidden src={src()} class={styles.avatarImage} style={{ clipPath: SHELL_ROSETTE_CLIP_104 }} />}</Show>
        </box>
        <text testId={`lock-user-${props.monitor().id}`} class={styles.username}>
          {props.controls.username()}
        </text>
        <row
          testId="lock-password-capsule"
          data-composite-input="true"
          data-focused={passwordFocused() ? "true" : "false"}
          data-error={props.controls.error() ? "true" : null}
          class={styles.passwordCapsule}
          style={{
            transform: scheme() === "reduced" || Math.abs(shakeX()) < SPRING_EPSILON.px
              ? "none"
              : `translateX(${shakeX().toFixed(2)}px)`,
          }}
        >
          <box ariaHidden class={styles.capsuleSpacer} />
          <row testId="lock-morph-dots" ariaHidden class={styles.morphDots}>
            <Show when={dotCount() > 0} fallback={
              <text class={styles.passwordPlaceholder}>Enter password</text>
            }>
              <For each={dotSlots} keyed={slot => slot.index}>
                {slot => (
                  <MorphPasswordDot
                    d={slot().shape.d}
                    viewBox={slot().shape.viewBox}
                    visible={() => slot().index < dotCount()}
                    error={() => props.controls.error() !== null}
                  />
                )}
              </For>
            </Show>
          </row>
          <TextField
            testId="lock-password"
            class={cx(styles.passwordField, "shell-composite-field")}
            secure
            placeholder="Password"
            ariaLabel="Password"
            disabled={props.controls.disabled()}
            value={props.controls.password()}
            onInput={e => props.controls.setPassword(e.value)}
            onFocus={() => setPasswordFocused(true)}
            onBlur={() => setPasswordFocused(false)}
            ref={node => { setField(node); }}
            onKeyDown={e => {
              if (e.key === "Enter") {
                e.preventDefault();
                void props.controls.submit();
              }
            }}
          />
          <row class={styles.capsuleTrailing}>
            <box class={styles.imeBadge}>
              <text class={styles.imeText}>
                {ime.data()?.active_im?.short_label || "EN"}
              </text>
            </box>
            <Button
              testId="lock-submit"
              ariaLabel="Unlock"
              disabled={props.controls.disabled()}
              onClick={() => void props.controls.submit()}
              class={styles.submitButton}
            >
              <ShellIcon name="chevronRight" color="var(--color-on-primary)" size={18} />
            </Button>
          </row>
        </row>
        <column class={styles.statusSlot}>
          <Show when={capsLock()}>
            <row testId="lock-caps-lock" role="status" class={styles.capsLockPill}>
              <ShellIcon name="keyboardCapslock" size={14} color="var(--color-on-secondary-container)" />
              <text class={styles.capsLockText}>Caps Lock is on</text>
            </row>
          </Show>
          <Show when={props.controls.sleepHold()}>
            <text testId="lock-sleep-hold">Preparing for sleep…</text>
          </Show>
          <Show when={props.controls.authenticating()}>
            <row testId="lock-verifying" role="status" class={styles.verifyingPill}>
              <box ariaHidden class={styles.verifyingDot} />
              <text class={styles.verifyingText}>Verifying PAM credentials...</text>
            </row>
          </Show>
          <Show when={props.controls.error()}>
            <text testId="lock-error" role="alert" class={styles.errorText}>
              {props.controls.error()}
            </text>
          </Show>
        </column>
        <Show when={playing()}>{player => (
          <row class={styles.playingRow}>
            <ShellIcon name="play" size={14} color="var(--color-on-surface)" />
            <text class={styles.playingText}>
              {player().metadata.title ?? player().identity}
              {player().metadata.artists.length > 0 ? ` · ${player().metadata.artists.join(", ")}` : ""}
            </text>
          </row>
        )}</Show>
      </box>
    </box>
  );
}

function LockSurfaces(props: { readonly controls: LockControls }): NativeChild {
  const { activeMonitor, monitors, hostClient, user } = useShellStore();
  const avatar = useDaemonMedia(hostClient, () => user.data()?.avatar, { fetchCommand: "user.fetch-blob" });
  // Monitor has no primary flag; focus the active output, falling back to the first output.
  const primaryId = () => activeMonitor()?.id ?? monitors()[0]?.id;
  const initialNow = Date.now();
  const [now, setNow] = createSignal(initialNow);
  const clock = createMemo(() => {
    const time = now();
    const { hours, minutes } = formatBarClock(time, clockFormat);
    return { time: `${hours}:${minutes}`, date: formatFullDate(time) };
  });
  const clockDelay = createDelay();
  function tick() {
    const time = Date.now();
    setNow(time);
    clockDelay.schedule(60_000 - time % 60_000, tick);
  }
  clockDelay.schedule(60_000 - initialNow % 60_000, tick);

  return <For each={monitors()} keyed={monitor => monitor.id}>{monitor => (
    <SessionLockSurface name={formatSurfaceName("lock", monitor().id)} output={monitor().id}>
      <LockScreen monitor={monitor} primary={() => monitor().id === primaryId()} clock={clock} avatar={avatar.src} controls={props.controls} />
    </SessionLockSurface>
  )}</For>;
}

export function SessionLockOverlay(): NativeChild {
  const { sessionLock, publicClient, hostClient, publicHello, invokeHostResult, user } = useShellStore();
  const [activeLock, setActiveLock] = createSignal<ActiveLock | null>(null);
  const [releasing, setReleasing] = createSignal<SessionLockRequest | null>(null);
  const [outcome, setOutcome] = createSignal<LockOutcome | null>(null);
  const [password, setPassword] = createSignal("");
  const [authenticating, setAuthenticating] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const sleepHold = createMemo(() => sessionLock.data()?.sleep_hold === true);
  const username = () => {
    const canonical = user.data()?.username?.trim();
    if (canonical) return canonical;
    const display = user.data()?.display_name?.trim();
    return display || "Locked session";
  };
  const disabled = () => authenticating() || sleepHold();
  let lastRequest: LockScope | undefined;
  let previousRefusal = false;
  let authSeq = 0;
  let disposed = false;

  onCleanup(() => {
    disposed = true;
    const active = activeLock();
    const state = active?.request.state();
    if (active && !active.confirmed && state !== "locked" && state !== "unlocking") active.request.dispose();
  });

  createEffect(() => {
    // Do not let a new scope claim the compositor lock while its predecessor's unlock is queued.
    if (releasing()) return;
    const snapshot = sessionLock.data();
    const lockId = snapshot?.phase === "engaging" || snapshot?.phase === "locked" ? snapshot.lock_id : null;
    return [lockId, publicHello()?.daemon_instance_id] as const;
  }, scope => {
    if (!scope) return;
    const [lockId, daemonId] = scope;
    // IDs increase within a daemon incarnation. A stale snapshot must not retry a refused or consumed request.
    if (lockId == null || (lastRequest && lastRequest.daemonId === daemonId && lastRequest.lockId >= lockId)) return;
    const previous = activeLock();
    const request = requestSessionLock();
    lastRequest = { lockId, daemonId };
    setOutcome(null);
    setActiveLock({ ...lastRequest, request, confirmed: false });
    // The SDK disposal only unsubscribes; it never changes the compositor lock role.
    previous?.request.dispose();
  });

  createEffect(() => {
    const request = releasing();
    return request?.state() === "unlocked" ? request : null;
  }, request => {
    if (!request) return;
    request.dispose();
    setReleasing(null);
  });

  createEffect(() => {
    const active = activeLock();
    return [active, active?.request.state()] as const;
  }, ([active, state]) => {
    if (!active || active.confirmed) return;
    const { lockId, daemonId, request } = active;
    if (state === "pending") {
      previousRefusal = false;
    } else if (state === "locked") {
      previousRefusal = false;
      active.confirmed = true;
      setOutcome({ lockId, daemonId, state });
    } else if (state === "refused" || state === "finished") {
      // A new SDK handle initially reports the previous compositor state, not a fresh refusal.
      if (state === "refused" && previousRefusal) return;
      previousRefusal = state === "refused";
      setOutcome({ lockId, daemonId, state });
      request.dispose();
      setActiveLock(null);
    }
  });

  // A public lock snapshot can precede the host handshake. Hold its result until the matching host is available.
  createEffect(() => [outcome(), hostClient()] as const, ([result, client]) => {
    if (!result || !client || client.helloInfo?.daemon_instance_id !== result.daemonId) return;
    setOutcome(null);
    if (result.state === "locked") {
      if (activeLock()?.request.state() !== "locked") return;
      void invokeHostResult("host.lock-ack", { lock_id: result.lockId, ui_session_generation: getSessionGeneration() });
    } else {
      void invokeHostResult("host.lock-failed", { lock_id: result.lockId, reason: `compositor lock ${result.state}` });
    }
  });

  createEffect(() => [sleepHold(), activeLock(), hostClient(), publicClient()] as const, () => {
    ++authSeq;
    setPassword("");
    setAuthenticating(false);
    setError(null);
  });

  async function submit(): Promise<void> {
    const initialActive = activeLock();
    const host = hostClient();
    const bus = publicClient();
    if (!initialActive || !host || !bus || host.helloInfo?.daemon_instance_id !== initialActive.daemonId || disabled() ||
        initialActive.request.state() !== "locked" || sessionLock.data()?.lock_id !== initialActive.lockId) return;
    const submittedPassword = password();
    if (submittedPassword.length === 0) return;
    const { lockId, request } = initialActive;
    const seq = ++authSeq;
    flush(() => {
      setPassword("");
      setError(null);
      setAuthenticating(true);
    });

    function isCurrent(consumed = false): boolean {
      const snapshot = sessionLock.data();
      return !disposed && seq === authSeq && hostClient() === host && publicClient() === bus && activeLock() === initialActive &&
        request.state() === "locked" && snapshot !== undefined && !snapshot.sleep_hold &&
        // Consume publishes the unlocked snapshot before returning its reply.
        (snapshot.lock_id === lockId || (consumed && snapshot.phase === "unlocked"));
    }

    try {
      if (!isCurrent()) return;
      const canonicalUsername = user.data()?.username?.trim();
      const authRes = await invokeHostResult("host.lock-authenticate", {
        ...(canonicalUsername ? { username: canonicalUsername } : {}),
        password: submittedPassword,
        lock_id: lockId,
        ui_session_generation: getSessionGeneration(),
      });
      flush();
      if (!isCurrent()) return;
      if (!authRes.ok) {
        setError(authRes.error || "Incorrect password · Try again");
        return;
      }
      const approval = authRes.result.data as UnlockApproval;
      if (typeof approval?.token !== "string" || approval.lock_id !== lockId) {
        setError("Invalid unlock approval");
        return;
      }
      const consumeRes = await invokeHostResult("host.lock-consume-unlock", {
        token: approval.token, lock_id: approval.lock_id, ui_session_generation: approval.ui_session_generation,
      });
      flush();
      if (!isCurrent(true)) return;
      if (!consumeRes.ok) {
        setError(consumeRes.error || "Unlock approval rejected");
        return;
      }
      request.unlock();
      setReleasing(request);
      setActiveLock(null);
      setError(null);
    } catch {
      if (isCurrent(true)) setError("Unable to unlock session");
    } finally {
      if (!disposed && seq === authSeq) setAuthenticating(false);
    }
  }

  const controls: LockControls = {
    username, password, authenticating, disabled, sleepHold, error, submit,
    setPassword: value => { if (!disabled()) setPassword(value); },
  };
  const visible = () => {
    const state = activeLock()?.request.state();
    return state !== undefined && state !== "refused" && state !== "unlocked";
  };
  return <Show when={visible()}><LockSurfaces controls={controls} /></Show>;
}
