import {
  Button, For, Image, SessionLockSurface, Show, createEffect, createMemo, createSignal, flush,
  focus, getSessionGeneration, onCleanup, requestSessionLock,
  type Accessor, type Monitor, type NativeChild, type NativeNode, type SessionLockRequest,
} from "@hewel/zgui";
import { Input as TextField } from "@hewel/zgui/components";
import { useDaemonMedia } from "@z-shell/sdk/zgui";
import { ShojiIcon } from "../icons.tsx";
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
const avatarScallop = "M32 2C37-1 43 1 46 6C52 6 57 10 58 16C63 19 65 25 62 31C65 37 63 44 58 47C57 53 52 58 46 58C43 63 37 65 32 62C27 65 21 63 18 58C12 58 7 53 6 47C1 44-1 37 2 31C-1 25 1 19 6 16C7 10 12 6 18 6C21 1 27-1 32 2Z";

function LockScreen(props: {
  readonly monitor: Accessor<Monitor>;
  readonly primary: Accessor<boolean>;
  readonly clock: Accessor<{ readonly time: string; readonly date: string }>;
  readonly avatar: Accessor<string | undefined>;
  readonly controls: LockControls;
}): NativeChild {
  const { hostClient, wallpaper, power, ime, media } = useShellStore();
  const { monitor, controls } = props;
  const activeWallpaper = createMemo(() => resolveMonitorWallpaper(wallpaper.data(), monitor().name));
  const backdrop = useDaemonMedia(hostClient, () => activeWallpaper()?.media, { fetchCommand: "wallpaper.fetch-blob" });
  const playing = () => {
    const player = selectActiveMediaPlayer(media.data());
    return player?.playback_status === "playing" ? player : null;
  };
  const [field, setField] = createSignal<NativeNode>();
  createEffect(() => props.primary() && !controls.disabled() ? field() : undefined, node => {
    if (node) focus(node);
  });

  return (
    <box style={{
      ...centeredColumn, position: "fixed", top: "0px", left: "0px", width: "100%", height: "100%", overflow: "hidden",
      backgroundColor: "var(--color-surface)", fontFamily: "system-ui",
      color: backdrop.src() ? "#F4F5FA" : "var(--color-on-surface)",
    }}>
      <Show when={backdrop.src()}>{src => <>
        <Image ariaHidden src={src()} style={{
          ...cover, zIndex: 0, objectFit: activeWallpaper()?.fit === "center" ? "none" : activeWallpaper()?.fit ?? "cover",
        }} />
        <box ariaHidden style={{ ...cover, zIndex: 1, backgroundColor: "rgba(17, 19, 24, 0.72)" }} />
      </>}</Show>
      <Show when={power.data()?.battery}>{battery => {
        const label = createMemo(() => {
          const percentage = battery().percentage;
          return percentage == null ? "—" : `${Math.round(percentage)}%`;
        });
        return (
          <row testId={`lock-battery-${monitor().id}`} style={{
            position: "absolute", zIndex: 2, top: "20px", right: "24px", alignItems: "center", gap: "5px",
            borderRadius: "16px", backgroundColor: "rgba(255, 255, 255, 0.08)", padding: "5px 10px",
          }}>
            <ShojiIcon name={battery().state === "charging" ? "batteryCharging" : "battery"} color="inherit" />
            <text style={{ fontSize: "13px" }}>{label()}</text>
          </row>
        );
      }}</Show>
      <box style={{ ...centeredColumn, position: "relative", zIndex: 2, justifyContent: "center", flexGrow: 2, flexBasis: "0px" }}>
        <text testId={`lock-clock-${monitor().id}`} style={{ fontSize: "72px", fontWeight: 300, lineHeight: 1 }}>
          {props.clock().time}
        </text>
        <text style={{ fontSize: "17px", marginTop: "6px" }}>{props.clock().date}</text>
      </box>
      <box style={{
        ...centeredColumn, position: "relative", zIndex: 2,
        justifyContent: "center", flexGrow: 3, flexBasis: "0px", gap: "8px", maxWidth: "100%",
      }}>
        <box ariaHidden style={{
          width: "64px", height: "64px", flexShrink: 0, position: "relative",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <vector ariaHidden d={avatarScallop} viewBox="0 0 64 64"
            style={{ ...cover, zIndex: 0, color: "var(--color-primary-container)" }} />
          <Show when={props.avatar()} fallback={
            <text style={{ position: "relative", zIndex: 1, fontSize: "25px", fontWeight: 600, color: "var(--color-on-primary-container)" }}>
              {String.fromCodePoint(controls.username().codePointAt(0) ?? 63).toUpperCase()}
            </text>
          }>{src => <Image ariaHidden src={src()} style={{
            position: "relative", zIndex: 1, width: "54px", height: "54px", borderRadius: "27px", objectFit: "cover",
          }} />}</Show>
        </box>
        <text testId={`lock-user-${monitor().id}`} style={{ fontSize: "17px", fontWeight: 600 }}>{controls.username()}</text>
        <row style={{
          width: "300px", maxWidth: "100%", height: "46px", flexShrink: 0, alignItems: "center", gap: "8px",
          borderRadius: "23px", backgroundColor: "rgba(255, 255, 255, 0.08)",
          border: "1px solid var(--color-outline-variant)", padding: "0px 12px",
        }}>
          <TextField testId="lock-password" secure placeholder="Password" ariaLabel="Password"
            disabled={controls.disabled()} value={controls.password()} onValueChange={value => controls.setPassword(value)}
            ref={node => { setField(node); }} onKeyDown={e => {
              if (e.key === "Enter") {
                e.preventDefault();
                void controls.submit();
              }
            }} style={{
              height: "100%", minWidth: "0px", flexGrow: 1, flexBasis: "0px", padding: "0px",
              border: "0px", backgroundColor: "transparent", color: "inherit", fontSize: "14px",
              boxShadow: "none", "--zui-color-muted-foreground": "inherit",
            }} />
          <text style={{
            fontSize: "11px", borderRadius: "8px", padding: "2px 5px", flexShrink: 0,
            backgroundColor: "rgba(255, 255, 255, 0.1)",
          }}>{ime.data()?.active_im?.short_label || "EN"}</text>
          <Button testId="lock-submit" ariaLabel="Unlock" disabled={controls.disabled()} onClick={() => void controls.submit()}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, padding: "0px",
              width: "28px", height: "28px", borderRadius: "14px", border: "0px",
              backgroundColor: "var(--color-primary)", opacity: controls.disabled() ? 0.45 : 1,
            }}>
            <ShojiIcon name="chevronRight" color="var(--color-on-primary)" size={18} />
          </Button>
        </row>
        <Show when={controls.sleepHold()}><text testId="lock-sleep-hold">Preparing for sleep…</text></Show>
        <Show when={controls.error()}><text testId="lock-error" role="alert" style={{ color: "var(--color-error)" }}>{controls.error()}</text></Show>
        <Show when={playing()}>{player => (
          <row style={{ gap: "5px", alignItems: "center", maxWidth: "300px", opacity: 0.8 }}>
            <ShojiIcon name="play" size={14} color="inherit" />
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
