import { For, LayerSurface, Show, createEffect, createMemo, createSignal, type Accessor, type Monitor, type NativeChild } from "@hewel/zgui";
import { M3Slider } from "@z-shell/sdk/primitives";
import { createSingleNodeRoundedBlur } from "../blur.ts";
import { ShellIcon } from "../icons.tsx";
import {
  createLinearProgress,
  createRetainedPresence,
  useMotionScheme,
  type M3Spring,
} from "../motion.ts";
import { useShellStore } from "../store.ts";
import { formatSurfaceName, resolveMonitorLogicalSize, type OsdPayload, type WarningFade } from "../topics.ts";

const onSurface = "var(--color-on-surface)";
const muted = "var(--color-on-surface-variant)";
const capsule = {
  backgroundColor: "var(--color-surface-container)",
  border: "1px solid color-mix(in srgb, var(--color-outline-variant) 55%, transparent)",
  boxShadow: "var(--shadow-level-2)",
  borderRadius: "999px",
  "--zgui-corner-shape": "none",
  color: onSurface,
} as const;

function OsdPill({ osd, spatial, opacity }: {
  osd: Accessor<OsdPayload>;
  spatial: M3Spring;
  opacity: M3Spring;
}): NativeChild {
  const scheme = useMotionScheme();
  const value = () => Math.max(0, Math.min(100, osd().value ?? 0));
  const icon = () => {
    const { kind, muted } = osd();
    return kind === "brightness" ? "brightness" : kind === "ime" ? "terminal" : muted ? "volumeMute" : "volumeHigh";
  };

  return (
    <row role="status" ariaLabel={osd().label} style={{
      ...capsule, width: "280px", height: "48px", padding: "0 12px 0 8px", gap: "10px", alignItems: "center",
      opacity: Math.max(0, Math.min(1, opacity())),
      transform: scheme() === "reduced"
        ? "none"
        : `translateY(${((1 - spatial()) * 12).toFixed(2)}px) scale(${(0.94 + spatial() * 0.06).toFixed(4)})`,
      transformOrigin: "bottom center",
    }}>
      <box style={{
        display: "flex", width: "32px", height: "32px", borderRadius: "10px", flexShrink: 0,
        alignItems: "center", justifyContent: "center", backgroundColor: "var(--color-primary-container)",
      }}>
        <ShellIcon name={icon()} size={18} color="var(--color-on-primary-container)" />
      </box>
      <Show when={osd().kind === "ime"} fallback={
        <>
          <M3Slider label={osd().label} value={value()} readOnly compact />
          <row style={{ width: "36px", flexShrink: 0, justifyContent: "flex-end" }}>
            <text testId="osd-value" data-tabular="true" style={{
              fontFamily: "var(--font-mono)", fontSize: "12px", fontWeight: 600, fontVariantNumeric: "tabular-nums",
            }}>
              {value()}%
            </text>
          </row>
        </>
      }>
        <text testId="osd-label" style={{
          flexGrow: 1, minWidth: "0px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontSize: "14px", fontWeight: 600,
        }}>{osd().label}</text>
        <text style={{ flexShrink: 0, paddingRight: "4px", color: muted, fontSize: "11px" }}>Input Method</text>
      </Show>
    </row>
  );
}

function IdleScrim({ monitorId, warning, seconds }: {
  monitorId: string;
  warning: Accessor<WarningFade>;
  seconds: Accessor<number>;
}): NativeChild {
  const scheme = useMotionScheme();
  const ramp = createLinearProgress(() => warning().fade_seconds * 1000, scheme);
  const opacity = () => Math.max(0.25, Math.min(1, ramp()));
  return (
    <box style={{
      position: "fixed", top: "0px", left: "0px", width: "100%", height: "100%",
      display: "flex", alignItems: "center", justifyContent: "center",
      backgroundColor: "color-mix(in srgb, var(--color-scrim) 55%, transparent)", opacity: opacity(),
    }}>
      <row testId={`idle-warning-${monitorId}`} style={{
        ...capsule, padding: "10px 16px", gap: "10px", maxWidth: "90%", alignItems: "center",
      }}>
        <text style={{ fontSize: "13px" }}>{warning().rules.join(", ")}</text>
        <text data-tabular="true" style={{ color: muted, flexShrink: 0, fontFamily: "var(--font-mono)", fontSize: "12px", fontVariantNumeric: "tabular-nums" }}>
          {seconds()}s
        </text>
      </row>
    </box>
  );
}

function IdleWarning({ warning, monitors }: { warning: Accessor<WarningFade>; monitors: Accessor<readonly Monitor[]> }): NativeChild {
  const { outputs } = useShellStore();
  const [seconds, setSeconds] = createSignal(warning().fade_seconds);
  // Unrelated idle snapshots can repeat a token; don't restart its countdown.
  const token = createMemo(() => warning().token);
  createEffect(token, () => {
    const deadline = Date.now() + warning().fade_seconds * 1000;
    let timer: number | undefined;
    function tick() {
      const remaining = Math.max(0, deadline - Date.now());
      const secondsLeft = Math.ceil(remaining / 1000);
      setSeconds(secondsLeft);
      if (secondsLeft > 0) timer = setTimeout(tick, remaining - (secondsLeft - 1) * 1000);
    }
    tick();
    return () => { if (timer !== undefined) clearTimeout(timer); };
  });

  return (
    <For each={monitors()} keyed={monitor => monitor.id}>
      {monitor => {
        const size = createMemo(() => resolveMonitorLogicalSize(monitor(), outputs.data()));
        return (
          <LayerSurface name={formatSurfaceName("idle-fade", monitor().id)} output={monitor().id} layer="overlay"
            anchor={["top", "bottom", "left", "right"]} width={size().width} height={size().height}
            exclusiveZone={-1} keyboard="none" inputRegion="empty">
            <IdleScrim monitorId={monitor().id} warning={warning} seconds={seconds} />
          </LayerSurface>
        );
      }}
    </For>
  );
}

export function OsdOverlay(): NativeChild {
  const { activeOsd, activeMonitor, monitors, idle } = useShellStore();
  const scheme = useMotionScheme();
  const osdTarget = () => {
    const payload = activeOsd();
    const output = activeMonitor()?.id;
    return payload && output ? { payload, output } : null;
  };
  const osdPresence = createRetainedPresence(osdTarget, {
    scheme,
    enterRole: "fastSpatial",
    enterOpacityRole: "fastEffects",
    exitRole: "fastEffects",
  });
  return (
    <>
      <Show when={osdPresence.value()?.output} keyed>
        {output => {
          const blur = createSingleNodeRoundedBlur(
            24,
            () => osdPresence.visible() && osdPresence.progress.settled(),
            2,
          );
          return (
            <LayerSurface name="osd-overlay" output={output} layer="overlay" anchor={["bottom"]}
              margin={{ bottom: 52 }} width={344} height={108} keyboard="none" inputRegion="empty" blurRegion={blur.region()}>
              <box style={{
                position: "fixed", left: "0px", top: "0px", width: "100%", height: "100%",
                display: "flex", alignItems: "flex-end", justifyContent: "center",
                paddingBottom: "36px",
              }}>
                <box ref={blur.ref}>
                  <Show when={osdPresence.value()}>
                    {entry => <OsdPill osd={() => entry().payload} spatial={osdPresence.progress} opacity={osdPresence.opacity} />}
                  </Show>
                </box>
              </box>
            </LayerSurface>
          );
        }}
      </Show>
      <Show when={idle.data()?.warning}>
        {warning => <IdleWarning warning={warning} monitors={monitors} />}
      </Show>
    </>
  );
}
