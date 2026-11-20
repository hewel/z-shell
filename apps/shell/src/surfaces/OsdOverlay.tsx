import { For, LayerSurface, Show, createEffect, createMemo, createSignal, createSpring, onSettled, type Accessor, type Monitor, type NativeChild } from "@hewel/zgui";
import { ShellIcon } from "../icons.tsx";
import { useShellStore } from "../store.ts";
import { formatSurfaceName, resolveMonitorLogicalSize, type OsdPayload, type WarningFade } from "../topics.ts";

const primary = "var(--color-primary)";
const onSurface = "var(--color-on-surface)";
const muted = "var(--color-on-surface-variant)";
const capsule = {
  backgroundColor: "var(--color-surface-container)",
  border: "1px solid color-mix(in srgb, var(--color-outline-variant) 55%, transparent)",
  boxShadow: "0 14px 36px rgba(0, 0, 0, 0.50)",
  borderRadius: "999px",
  color: onSurface,
} as const;

function createReveal(): Accessor<number> {
  const [target, setTarget] = createSignal(0);
  const opacity = createSpring(target, { stiffness: 260, damping: 33 });
  onSettled(() => { setTarget(1); });
  return opacity;
}

function OsdPill({ osd }: { osd: Accessor<OsdPayload> }): NativeChild {
  const opacity = createReveal();
  const value = () => Math.max(0, Math.min(100, osd().value ?? 0));
  const icon = () => {
    const { kind, muted } = osd();
    return kind === "brightness" ? "brightness" : kind === "ime" ? "terminal" : muted ? "volumeMute" : "volumeHigh";
  };

  return (
    <row role="status" ariaLabel={osd().label} style={{
      ...capsule, width: "280px", height: "48px", padding: "0 10px 0 8px", gap: "10px", alignItems: "center",
      opacity: Math.max(0, Math.min(1, opacity() * 1.35)),
      transform: `translateY(${((1 - opacity()) * 12).toFixed(2)}px) scale(${(0.94 + opacity() * 0.06).toFixed(4)})`,
      transformOrigin: "bottom center",
    }}>
      <box style={{
        display: "flex", width: "32px", height: "32px", borderRadius: "999px", flexShrink: 0,
        alignItems: "center", justifyContent: "center", backgroundColor: primary,
      }}>
        <ShellIcon name={icon()} size={18} color="var(--color-on-primary)" />
      </box>
      <Show when={osd().kind === "ime"} fallback={
        <>
          <box style={{ flexGrow: 1, minWidth: "0px", height: "20px", display: "flex", alignItems: "center", position: "relative" }}>
            <box style={{
              width: "100%", height: "6px", borderRadius: "3px", overflow: "hidden",
              backgroundColor: "var(--color-surface-container-highest)",
            }}>
              <box data-percent-fill="true" style={{ width: `${value()}%`, height: "100%", borderRadius: "3px", backgroundColor: primary }} />
            </box>
            <box ariaHidden style={{
              position: "absolute", left: `${Math.max(0, Math.min(92, value() - 4))}%`,
              width: "14px", height: "14px", borderRadius: "999px",
              backgroundColor: primary, border: "2px solid var(--color-surface-container)",
            }} />
          </box>
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
  const opacity = createReveal();
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
  const targetMonitorId = () => activeOsd() ? activeMonitor()?.id : undefined;
  return (
    <>
      <Show when={targetMonitorId()} keyed>
        {output => (
          <LayerSurface name="osd-overlay" output={output} layer="overlay" anchor={["bottom"]}
            margin={{ bottom: 88 }} width={280} height={48} keyboard="none" inputRegion="empty">
            <OsdPill osd={() => activeOsd()!} />
          </LayerSurface>
        )}
      </Show>
      <Show when={idle.data()?.warning}>
        {warning => <IdleWarning warning={warning} monitors={monitors} />}
      </Show>
    </>
  );
}
