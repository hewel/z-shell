import { Button, LayerSurface, Show, createMemo, focus, registerDismissLayer, type Accessor, type NativeChild } from "@hewel/zgui";
import { ShellIcon } from "../icons.tsx";
import { DIALOG_SPRING, createEnterProgress, dialogMotionStyle, scrimBackdrop } from "../motion.ts";
import { useShellStore } from "../store.ts";
import { POWER_DIALOG_COPY, resolveMonitorLogicalSize, type PowerConfirmAction } from "../topics.ts";

const footerButton = {
  display: "flex", alignItems: "center", justifyContent: "center",
  height: "40px", borderRadius: "999px", fontSize: "14px", fontWeight: 600,
} as const;

function PowerDialogContent(props: { action: Accessor<PowerConfirmAction> }): NativeChild {
  const { closePowerDialog, invokeHost, invokePublic } = useShellStore();
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

  const enter = createEnterProgress(DIALOG_SPRING);

  return (
    <box testId="power-dialog-backdrop" onClick={closePowerDialog} style={{
      position: "fixed", left: "0px", top: "0px", width: "100%", height: "100%",
      display: "flex", alignItems: "center", justifyContent: "center",
      backgroundColor: scrimBackdrop(55, enter()),
    }}>
      <box testId="power-dialog-card" role="dialog" ariaLabel={copy().title} ariaModal
        ref={node => { registerDismissLayer(node, closePowerDialog, { layer: "modal", dismissOnOutsidePress: false }); }}
        onClick={event => event.stopPropagation()} style={{
          display: "flex", flexDirection: "column", alignItems: "center", width: "360px", borderRadius: "22px",
          backgroundColor: "var(--color-surface)", border: "1px solid var(--color-outline-variant)",
          padding: "24px", gap: "14px", fontFamily: "var(--font-sans)", color: "var(--color-on-surface)",
          ...dialogMotionStyle(enter()),
        }}>
        <box style={{
          display: "flex", alignItems: "center", justifyContent: "center", width: "56px", height: "56px", borderRadius: "999px",
          backgroundColor: copy().destructive ? "var(--color-error-container)" : "var(--color-primary-container)",
        }}>
          <ShellIcon name={copy().icon} size={26}
            color={copy().destructive ? "var(--color-on-error-container)" : "var(--color-on-primary-container)"} />
        </box>
        <text testId="power-dialog-title" role="heading" style={{ fontSize: "22px", fontWeight: 700 }}>{copy().title}</text>
        <text testId="power-dialog-desc" style="font-size: 14px; color: var(--color-on-surface-variant); text-align: center;">
          {copy().description}
        </text>
        <row style={{ gap: "12px", justifyContent: "flex-end", width: "100%", marginTop: "6px" }}>
          <Button testId="power-dialog-cancel" onClick={closePowerDialog} ref={node => focus(node)}
            style={{ ...footerButton, padding: "0px 16px", backgroundColor: "transparent", color: "var(--color-primary)" }}>Cancel</Button>
          <Button testId="power-dialog-confirm" onClick={confirm} style={{
            ...footerButton, padding: "0px 20px",
            backgroundColor: copy().destructive ? "var(--color-error-container)" : "var(--color-primary)",
            color: copy().destructive ? "var(--color-on-error-container)" : "var(--color-on-primary)",
          }}>{copy().confirmLabel}</Button>
        </row>
      </box>
    </box>
  );
}

export function PowerDialog(): NativeChild {
  const { monitors, outputs, pendingPowerAction, powerDialogMonitor, sessionLock } = useShellStore();
  const targetMonitorId = () => (sessionLock.data()?.phase ?? "unlocked") === "unlocked" && pendingPowerAction()
    ? powerDialogMonitor()?.id
    : undefined;

  return (
    <Show when={targetMonitorId()} keyed>
      {output => {
        const size = createMemo(() => {
          const monitor = monitors().find(candidate => candidate.id === output);
          return monitor ? resolveMonitorLogicalSize(monitor, outputs.data()) : { width: 1280, height: 720 };
        });
        return (
          <Show when={pendingPowerAction()}>
            {action => (
              <LayerSurface name="power-dialog" output={output} layer="overlay"
                anchor={["top", "bottom", "left", "right"]} width={size().width} height={size().height}
                exclusiveZone={-1} keyboard="exclusive">
                <PowerDialogContent action={action} />
              </LayerSurface>
            )}
          </Show>
        );
      }}
    </Show>
  );
}
