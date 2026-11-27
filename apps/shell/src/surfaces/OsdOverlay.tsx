import { For, LayerSurface, Show, createDelay, createEffect, createMemo, createSignal, onCleanup, untrack, type Accessor, type Monitor, type NativeChild, type NativeNode } from "@hewel/zgui";
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

function OsdPill(props: {
  osd: Accessor<OsdPayload>;
  spatial: M3Spring;
  opacity: M3Spring;
  pillRef?: (node: NativeNode | null) => void;
}): NativeChild {
  const scheme = useMotionScheme();
  const value = () => Math.max(0, Math.min(100, props.osd().value ?? 0));
  const icon = () => {
    const { kind, muted } = props.osd();
    return kind === "brightness" ? "brightness" : kind === "ime" ? "terminal" : muted ? "volumeMute" : "volumeHigh";
  };
  onCleanup(() => props.pillRef?.(null));

  return (
    <row
      ref={node => props.pillRef?.(node)}
      testId="osd-pill"
      role="status"
      ariaLabel={props.osd().label}
      class={styles.osdPill}
      style={{
        opacity: Math.max(0, Math.min(1, props.opacity())),
        transform: scheme() === "reduced"
          ? "none"
          : `translateY(${((1 - props.spatial()) * 12).toFixed(2)}px) scale(${(0.94 + props.spatial() * 0.06).toFixed(4)})`,
      }}
    >
      <box class={styles.iconWell}>
        <ShellIcon name={icon()} size={18} color="var(--color-on-primary-container)" />
      </box>
      <Show when={props.osd().kind === "ime"} fallback={
        <>
          <M3Slider label={props.osd().label} value={value()} readOnly compact />
          <row class={styles.valueRow}>
            <text testId="osd-value" data-tabular="true" class={styles.valueText}>
              {value()}%
            </text>
          </row>
        </>
      }>
        <text testId="osd-label" class={styles.imeLabel}>{props.osd().label}</text>
        <text class={styles.imeSubtitle}>Input Method</text>
      </Show>
    </row>
  );
}

function IdleScrim(props: {
  monitorId: string;
  warning: Accessor<WarningFade>;
  seconds: Accessor<number>;
}): NativeChild {
  const scheme = useMotionScheme();
  const ramp = createLinearProgress(() => props.warning().fade_seconds * 1000, scheme);
  const opacity = () => Math.max(0.25, Math.min(1, ramp()));
  return (
    <box class={styles.idleScrim} style={{ opacity: opacity() }}>
      <row testId={`idle-warning-${props.monitorId}`} class={styles.idleWarning}>
        <text class={styles.idleRules}>{props.warning().rules.join(", ")}</text>
        <text data-tabular="true" class={styles.idleSeconds}>
          {props.seconds()}s
        </text>
      </row>
    </box>
  );
}

function IdleWarning(props: { warning: Accessor<WarningFade>; monitors: Accessor<readonly Monitor[]> }): NativeChild {
  const { outputs } = useShellStore();
  const [seconds, setSeconds] = createSignal(untrack(() => props.warning().fade_seconds));
  // Unrelated idle snapshots can repeat a token; don't restart its countdown.
  const token = createMemo(() => props.warning().token);
  const countdownDelay = createDelay();
  createEffect(token, () => {
    const deadline = Date.now() + props.warning().fade_seconds * 1000;
    function tick() {
      const remaining = Math.max(0, deadline - Date.now());
      const secondsLeft = Math.ceil(remaining / 1000);
      setSeconds(secondsLeft);
      if (secondsLeft > 0) {
        countdownDelay.schedule(Math.max(0, remaining - (secondsLeft - 1) * 1000), tick);
      }
    }
    tick();
    return () => countdownDelay.cancel();
  });

  return (
    <For each={props.monitors()} keyed={monitor => monitor.id}>
      {monitor => {
        const size = createMemo(() => resolveMonitorLogicalSize(monitor(), outputs.data()));
        return (
          <LayerSurface name={formatSurfaceName("idle-fade", monitor().id)} output={monitor().id} layer="overlay"
            anchor={["top", "bottom", "left", "right"]} width={size().width} height={size().height}
            exclusiveZone={-1} keyboard="none" inputRegion="empty">
            <IdleScrim monitorId={monitor().id} warning={props.warning} seconds={seconds} />
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
