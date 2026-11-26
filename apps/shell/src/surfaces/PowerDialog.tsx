import { LayerSurface, Show, createEffect, createMemo, createSignal, focus, registerDismissLayer, type Accessor, type NativeChild, type NativeNode } from "@hewel/zgui";
import { M3Button, M3DialogShell } from "@z-shell/sdk/primitives";
import { ShellIcon } from "../icons.tsx";
import { createRetainedPresence, dialogMotionStyle, scrimBackdrop, useMotionScheme, type M3Spring } from "../motion.ts";
import { useShellStore } from "../store.ts";
import { POWER_DIALOG_COPY, resolveMonitorLogicalSize, type PowerConfirmAction } from "../topics.ts";
import styles from "./PowerDialog.module.css";

function PowerDialogContent(props: {
  action: Accessor<PowerConfirmAction>;
  inert: boolean;
  spatial: M3Spring;
  opacity: M3Spring;
}): NativeChild {
  const { closePowerDialog, invokeHost, invokePublic, theme } = useShellStore();
  const dark = () => theme.data()?.dark ?? true;
  const copy = createMemo(() => POWER_DIALOG_COPY[props.action()]);

  function confirm(): void {
    switch (props.action()) {
      case "lock": void invokePublic("lock.request", {}); break;
      case "suspend": void invokeHost("host.suspend", {}); break;
      case "reboot": void invokeHost("power.reboot"); break;
      case "poweroff": void invokeHost("power.poweroff"); break;
      case "logout": void invokeHost("power.logout"); break;
    }
    closePowerDialog();
  }

  const scheme = useMotionScheme();
  const [cardNode, setCardNode] = createSignal<NativeNode | null>(null);
  createEffect(cardNode, node => {
    if (!node) return;
    const handle = registerDismissLayer(node, closePowerDialog, { layer: "modal", dismissOnOutsidePress: false });
    return () => handle.dispose();
  });

  return (
    <box
      testId="power-dialog-backdrop"
      inert={props.inert}
      onClick={closePowerDialog}
      class={styles.backdrop}
      style={{ backgroundColor: scrimBackdrop(55, props.opacity(), dark()) }}
    >
      <M3DialogShell
        testId="power-dialog-card"
        ariaLabel={copy().title}
        centered
        ref={setCardNode}
        badge={{
          tone: copy().destructive ? "destructive" : "accent",
          icon: (
            <ShellIcon
              name={copy().icon}
              size={22}
              color={copy().destructive ? "var(--color-on-error-container)" : "var(--color-on-primary-container)"}
            />
          ),
        }}
        style={{
          padding: "24px",
          gap: "14px",
          ...dialogMotionStyle(props.spatial(), { opacity: props.opacity(), reduced: scheme() === "reduced", fromScale: 0.92, fromY: 0 }),
        }}
      >
        <text testId="power-dialog-title" role="heading" class={styles.title}>{copy().title}</text>
        <text testId="power-dialog-desc" class={styles.description}>
          {copy().description}
        </text>
        <row class={styles.actions}>
          <M3Button testId="power-dialog-cancel" variant="outlined" neutral onClick={closePowerDialog} ref={node => focus(node)}>
            Cancel
          </M3Button>
          <M3Button testId="power-dialog-confirm" variant={copy().destructive ? "destructive" : "filled"} onClick={confirm}>
            {copy().confirmLabel}
          </M3Button>
        </row>
      </M3DialogShell>
    </box>
  );
}

export function PowerDialog(): NativeChild {
  const { monitors, outputs, pendingPowerAction, powerDialogMonitor, sessionLock } = useShellStore();
  const scheme = useMotionScheme();
  const locked = () => (sessionLock.data()?.phase ?? "unlocked") !== "unlocked";
  const target = createMemo(() => {
    if (locked()) return null;
    const action = pendingPowerAction();
    const output = powerDialogMonitor()?.id;
    return action && output ? { action, output } : null;
  });
  const presence = createRetainedPresence(target, {
    scheme,
    enterRole: "defaultSpatial",
    enterOpacityRole: "defaultEffects",
    exitRole: "fastEffects",
    instantExit: locked,
  });

  return (
    <Show when={presence.value()?.output} keyed>
      {output => {
        const size = createMemo(() => {
          const monitor = monitors().find(candidate => candidate.id === output);
          return monitor ? resolveMonitorLogicalSize(monitor, outputs.data()) : { width: 1280, height: 720 };
        });
        return (
          <Show when={presence.value()}>
            {entry => (
              <LayerSurface name="power-dialog" output={output} layer="overlay"
                anchor={["top", "bottom", "left", "right"]} width={size().width} height={size().height}
                exclusiveZone={-1} keyboard="exclusive">
                <PowerDialogContent action={() => entry().action} inert={!presence.present()} spatial={presence.progress} opacity={presence.opacity} />
              </LayerSurface>
            )}
          </Show>
        );
      }}
    </Show>
  );
}
