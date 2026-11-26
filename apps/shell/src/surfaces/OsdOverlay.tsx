import { For, LayerSurface, Show, createEffect, createMemo, createSignal, onCleanup, type Accessor, type Monitor, type NativeChild, type NativeNode } from "@hewel/zgui";
import { M3Slider } from "@z-shell/sdk/primitives";
import { ShellIcon } from "../icons.tsx";
import {
  createLinearProgress,
  createRetainedPresence,
  useMotionScheme,
  type M3Spring,
} from "../motion.ts";
import { usePinnedOutput, useShellStore } from "../store.ts";
import { formatSurfaceName, resolveMonitorLogicalSize, type OsdPayload, type WarningFade } from "../topics.ts";
import styles from "./OsdOverlay.module.css";

function OsdPill({ osd, spatial, opacity, pillRef }: {
  osd: Accessor<OsdPayload>;
  spatial: M3Spring;
  opacity: M3Spring;
  pillRef?: (node: NativeNode | null) => void;
}): NativeChild {
  const scheme = useMotionScheme();
  const value = () => Math.max(0, Math.min(100, osd().value ?? 0));
  const icon = () => {
    const { kind, muted } = osd();
    return kind === "brightness" ? "brightness" : kind === "ime" ? "terminal" : muted ? "volumeMute" : "volumeHigh";
  };
  onCleanup(() => pillRef?.(null));

  return (
    <row
      ref={node => pillRef?.(node)}
      testId="osd-pill"
      role="status"
      ariaLabel={osd().label}
      class={styles.osdPill}
      style={{
        opacity: Math.max(0, Math.min(1, opacity())),
        transform: scheme() === "reduced"
          ? "none"
          : `translateY(${((1 - spatial()) * 12).toFixed(2)}px) scale(${(0.94 + spatial() * 0.06).toFixed(4)})`,
      }}
    >
      <box class={styles.iconWell}>
        <ShellIcon name={icon()} size={18} color="var(--color-on-primary-container)" />
      </box>
      <Show when={osd().kind === "ime"} fallback={
        <>
          <M3Slider label={osd().label} value={value()} readOnly compact />
          <row class={styles.valueRow}>
            <text testId="osd-value" data-tabular="true" class={styles.valueText}>
              {value()}%
            </text>
          </row>
        </>
      }>
        <text testId="osd-label" class={styles.imeLabel}>{osd().label}</text>
        <text class={styles.imeSubtitle}>Input Method</text>
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
    <box class={styles.idleScrim} style={{ opacity: opacity() }}>
      <row testId={`idle-warning-${monitorId}`} class={styles.idleWarning}>
        <text class={styles.idleRules}>{warning().rules.join(", ")}</text>
        <text data-tabular="true" class={styles.idleSeconds}>
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
  const { activeOsd, monitors, idle } = useShellStore();
  const scheme = useMotionScheme();
  const pinnedOutput = usePinnedOutput(() => (activeOsd() !== null ? true : null));
  const osdTarget = createMemo(() => {
    const payload = activeOsd();
    const output = pinnedOutput();
    return payload && output ? { payload, output } : null;
  });
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
          const [pillNode, setPillNode] = createSignal<NativeNode | null>(null);
          let disposed = false;
          onCleanup(() => { disposed = true; });
          const bindPillRef = (node: NativeNode | null) => {
            if (!disposed) setPillNode(node);
          };
          return (
            <LayerSurface name="osd-overlay" output={output} layer="overlay" anchor={["bottom"]}
              margin={{ bottom: 52 }} width={344} height={108} keyboard="none" inputRegion="empty" blurRegion={pillNode() ? [pillNode()!] : "none"}>
              <box class={styles.osdContainer}>
                <Show when={osdPresence.value()}>
                  {entry => <OsdPill osd={() => entry().payload} spatial={osdPresence.progress} opacity={osdPresence.opacity} pillRef={bindPillRef} />}
                </Show>
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
