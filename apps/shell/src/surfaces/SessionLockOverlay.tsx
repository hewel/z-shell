import {
  Button, For, Image, SessionLockSurface, Show, createEffect, createMemo, createSignal, flush,
  focus, getSessionGeneration, onCleanup, requestSessionLock,
  type Accessor, type Monitor, type NativeChild, type NativeNode, type SessionLockRequest,
} from "@hewel/zgui";
import { Input as TextField } from "@hewel/zgui/components";
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

type LockScope = { readonly lockId: number; readonly daemonId: string | undefined };
type ActiveLock = LockScope & { readonly request: SessionLockRequest; confirmed: boolean };
type LockOutcome = LockScope & { readonly state: "locked" | "refused" | "finished" };

type LockControls = {
  readonly username: Accessor<string>;
  readonly password: Accessor<string>;
  readonly setPassword: (value: string) => void;
  readonly disabled: Accessor<boolean>;
  readonly sleepHold: Accessor<boolean>;
  readonly error: Accessor<string | null>;
  readonly submit: () => Promise<void>;
};

const clockFormat = { clock24h: true, clockSeconds: false };
const cover = { position: "absolute", inset: "0px", width: "100%", height: "100%", pointerEvents: "none" } as const;
const centeredColumn = { display: "flex", flexDirection: "column", alignItems: "center" } as const;
const MORPH_SEQUENCE = [
  LOCK_MORPH_SHAPES.Cookie4,
  LOCK_MORPH_SHAPES.Clover4,
  LOCK_MORPH_SHAPES.Sunny,
  LOCK_MORPH_SHAPES.Circle,
  LOCK_MORPH_SHAPES.Cookie6,
  LOCK_MORPH_SHAPES.Flower5,
] as const;
const MAX_VISIBLE_DOTS = 14;

function MorphPasswordDot(props: { readonly d: string; readonly viewBox: string; readonly visible: Accessor<boolean> }): NativeChild {
  const scheme = useMotionScheme();
  const presence = createPresence(props.visible, {
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
      <vector ariaHidden d={props.d} viewBox={props.viewBox} style={{
        width: "14px", height: "14px", flexShrink: 0, color: "var(--color-on-surface)",
        opacity: Math.max(0, Math.min(1, presence.opacity())),
        transform: scheme() === "reduced"
          ? "none"
          : `scale(${scale().toFixed(4)}) rotate(${deg().toFixed(1)}deg)`,
        transformOrigin: "center",
      }} />
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
  const { monitor, controls } = props;
  const scheme = useMotionScheme();
  const entryFade = createOpacityEnter("slowEffects", scheme);
  const shakeX = createM3Spring(() => 0, "fastSpatial", {
    scheme,
    overrideScheme: "expressive",
    epsilon: SPRING_EPSILON.px,
  });
  createEffect(controls.error, err => {
    if (err) shakeX.impulse(650);
  });
  const activeWallpaper = createMemo(() => resolveMonitorWallpaper(wallpaper.data(), monitor().name));
  const backdrop = useDaemonMedia(hostClient, () => activeWallpaper()?.media, { fetchCommand: "wallpaper.fetch-blob" });
  const playing = () => {
    const player = selectActiveMediaPlayer(media.data());
    return player?.playback_status === "playing" ? player : null;
  };
  const [field, setField] = createSignal<NativeNode>();
  const [passwordFocused, setPasswordFocused] = createSignal(false);
  createEffect(() => props.primary() && !controls.disabled() ? field() : undefined, node => {
    if (node) focus(node);
  });
  const dotSlots = Array.from({ length: MAX_VISIBLE_DOTS }, (_, index) => ({
    index,
    shape: MORPH_SEQUENCE[index % MORPH_SEQUENCE.length]!,
  }));
  const dotCount = () => Math.min(controls.password().length, MAX_VISIBLE_DOTS);

  return (
    <box style={{
      ...centeredColumn, position: "fixed", top: "0px", left: "0px", width: "100%", height: "100%", overflow: "hidden",
      backgroundColor: "var(--color-surface)", fontFamily: "var(--font-sans)",
      color: "var(--color-on-surface)",
      opacity: Math.max(0, Math.min(1, entryFade())),
    }}>
      <Show when={backdrop.src()}>{src => <>
        <Image ariaHidden src={src()} style={{
          ...cover, zIndex: 0, objectFit: activeWallpaper()?.fit === "center" ? "none" : activeWallpaper()?.fit ?? "cover",
        }} />
        <box ariaHidden style={{ ...cover, zIndex: 1, backgroundColor: "color-mix(in srgb, var(--color-surface) 76%, transparent)" }} />
      </>}</Show>
      <Show when={power.data()?.battery}>{battery => {
        const label = createMemo(() => {
          const percentage = battery().percentage;
          return percentage == null ? "—" : `${Math.round(percentage)}%`;
        });
        return (
          <row testId={`lock-battery-${monitor().id}`} style={{
            position: "absolute", zIndex: 2, top: "28px", right: "36px", alignItems: "center", gap: "6px",
            borderRadius: "16px", backgroundColor: "color-mix(in srgb, var(--color-on-surface) 10%, transparent)", padding: "5px 10px",
          }}>
            <ShellIcon name={battery().state === "charging" ? "batteryCharging" : "battery"} size={18} color="inherit" />
            <text data-tabular="true" style={{ fontFamily: "var(--font-mono)", fontSize: "14px", fontWeight: 500, fontVariantNumeric: "tabular-nums" }}>
              {label()}
            </text>
          </row>
        );
      }}</Show>
      <box style={{ ...centeredColumn, position: "relative", zIndex: 2, justifyContent: "center", flexGrow: 2, flexBasis: "0px", gap: "6px" }}>
        <text testId={`lock-clock-${monitor().id}`} style={{
          fontSize: "112px", fontWeight: 300, lineHeight: "124px", letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums",
        }}>
          {props.clock().time}
        </text>
        <text style={{ fontSize: "22px", lineHeight: "28px", opacity: 0.85 }}>{props.clock().date}</text>
      </box>
      <box style={{
        ...centeredColumn, position: "relative", zIndex: 2,
        justifyContent: "center", flexGrow: 3, flexBasis: "0px", gap: "16px", maxWidth: "100%",
      }}>
        <box ariaHidden style={{
          width: "104px", height: "104px", flexShrink: 0, position: "relative",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <vector ariaHidden d={SHELL_ROSETTE_PATH} viewBox="0 0 64 64"
            style={{ ...cover, zIndex: 0, color: "var(--color-primary-container)" }} />
          <Show when={props.avatar()} fallback={
            <ShellIcon name="person" size={46} color="var(--color-on-primary-container)" />
          }>{src => <Image ariaHidden src={src()} style={{
            position: "relative", zIndex: 1, width: "104px", height: "104px", objectFit: "cover", clipPath: SHELL_ROSETTE_CLIP_104,
          }} />}</Show>
        </box>
        <text testId={`lock-user-${monitor().id}`} style={{ fontSize: "22px", fontWeight: 500, lineHeight: "28px" }}>
          {controls.username()}
        </text>
        <row data-composite-input="true" style={{
          position: "relative", width: "340px", maxWidth: "100%", height: "56px", flexShrink: 0,
          alignItems: "center", justifyContent: "space-between", gap: "8px",
          borderRadius: "999px",
          backgroundColor: "color-mix(in srgb, var(--color-on-surface) 14%, transparent)",
          border: controls.error()
            ? "2px solid var(--color-error)"
            : passwordFocused()
              ? "2px solid var(--color-primary)"
              : "1px solid color-mix(in srgb, var(--color-on-surface) 24%, transparent)",
          padding: passwordFocused() || controls.error() ? "0px 11px" : "0px 12px",
          transform: scheme() === "reduced" || Math.abs(shakeX()) < SPRING_EPSILON.px
            ? "none"
            : `translateX(${shakeX().toFixed(2)}px)`,
        }}>
          <box ariaHidden style={{ width: "36px", height: "32px", flexShrink: 0 }} />
          <row testId="lock-morph-dots" ariaHidden style={{
            flexGrow: 1, flexBasis: "0px", minWidth: "0px", alignItems: "center", justifyContent: "center",
            gap: "12px", overflow: "hidden", pointerEvents: "none",
          }}>
            <Show when={dotCount() > 0} fallback={
              <text style={{ fontSize: "14px", color: "var(--color-on-surface-variant)", opacity: 0.78 }}>Enter password</text>
            }>
              <For each={dotSlots} keyed={slot => slot.index}>
                {slot => (
                  <MorphPasswordDot
                    d={slot().shape.d}
                    viewBox={slot().shape.viewBox}
                    visible={() => slot().index < dotCount()}
                  />
                )}
              </For>
            </Show>
          </row>
          <TextField testId="lock-password" class="shell-composite-field" secure placeholder="Password" ariaLabel="Password"
            disabled={controls.disabled()} value={controls.password()} onValueChange={value => controls.setPassword(value)}
            onFocus={() => setPasswordFocused(true)} onBlur={() => setPasswordFocused(false)}
            ref={node => { setField(node); }} onKeyDown={e => {
              if (e.key === "Enter") {
                e.preventDefault();
                void controls.submit();
              }
            }} style={{
              position: "absolute", left: "12px", top: "4px", right: "92px", bottom: "4px",
              padding: "0px", border: "0px", backgroundColor: "transparent", color: "transparent",
              opacity: 0, fontSize: "14px", boxShadow: "none",
            }} />
          <row style={{ alignItems: "center", gap: "6px", flexShrink: 0, position: "relative", zIndex: 2 }}>
            <box style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              minWidth: "36px", height: "32px", padding: "0 10px", borderRadius: "16px",
              backgroundColor: "color-mix(in srgb, var(--color-on-surface) 14%, transparent)",
            }}>
              <text style={{ fontFamily: "var(--font-mono)", fontSize: "12px", fontWeight: 600 }}>
                {ime.data()?.active_im?.short_label || "EN"}
              </text>
            </box>
            <Button testId="lock-submit" ariaLabel="Unlock" disabled={controls.disabled()} onClick={() => void controls.submit()}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, padding: "0px",
                width: "32px", height: "32px", borderRadius: "999px", border: "0px",
                backgroundColor: "var(--color-primary)", opacity: controls.disabled() ? 0.45 : 1,
              }}>
              <ShellIcon name="chevronRight" color="var(--color-on-primary)" size={18} />
            </Button>
          </row>
        </row>
        <Show when={controls.sleepHold()}><text testId="lock-sleep-hold">Preparing for sleep…</text></Show>
        <Show when={controls.error()}><text testId="lock-error" role="alert" style={{ color: "var(--color-error)" }}>{controls.error()}</text></Show>
        <Show when={playing()}>{player => (
          <row style={{ gap: "6px", alignItems: "center", maxWidth: "320px", opacity: 0.8 }}>
            <ShellIcon name="play" size={14} color="inherit" />
            <text style={{ fontSize: "12px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
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
  const [now, setNow] = createSignal(Date.now());
  const clock = createMemo(() => {
    const time = now();
    const { hours, minutes } = formatBarClock(time, clockFormat);
    return { time: `${hours}:${minutes}`, date: formatFullDate(time) };
  });
  function tick() {
    const time = Date.now();
    setNow(time);
    timer = setTimeout(tick, 60_000 - time % 60_000);
  }
  let timer = setTimeout(tick, 60_000 - now() % 60_000);
  onCleanup(() => clearTimeout(timer));

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
  const username = () => user.data()?.username ?? user.data()?.display_name ?? "user";
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
    const active = activeLock();
    const host = hostClient();
    const bus = publicClient();
    if (!active || !host || !bus || host.helloInfo?.daemon_instance_id !== active.daemonId || disabled() ||
        active.request.state() !== "locked" || sessionLock.data()?.lock_id !== active.lockId) return;
    const submittedPassword = password();
    if (submittedPassword.length === 0) return;
    const { lockId, request } = active;
    const seq = ++authSeq;
    flush(() => {
      setPassword("");
      setError(null);
      setAuthenticating(true);
    });

    function isCurrent(consumed = false): boolean {
      const snapshot = sessionLock.data();
      return !disposed && seq === authSeq && hostClient() === host && publicClient() === bus && activeLock() === active &&
        request.state() === "locked" && snapshot !== undefined && !snapshot.sleep_hold &&
        // Consume publishes the unlocked snapshot before returning its reply.
        (snapshot.lock_id === lockId || (consumed && snapshot.phase === "unlocked"));
    }

    try {
      if (!isCurrent()) return;
      const authRes = await invokeHostResult("host.lock-authenticate", {
        username: username(), password: submittedPassword, lock_id: lockId, ui_session_generation: getSessionGeneration(),
      });
      flush();
      if (!isCurrent()) return;
      if (!authRes.ok) {
        setError(authRes.error || "Authentication failed");
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
    username, password, disabled, sleepHold, error, submit,
    setPassword: value => { if (!disabled()) setPassword(value); },
  };
  const visible = () => {
    const state = activeLock()?.request.state();
    return state !== undefined && state !== "refused" && state !== "unlocked";
  };
  return <Show when={visible()}><LockSurfaces controls={controls} /></Show>;
}
