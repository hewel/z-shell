import { Button, LayerSurface, Show, createMemo, focus, registerDismissLayer, type Accessor, type NativeChild } from "@hewel/zgui";
import { ShojiIcon } from "../icons.tsx";
import { useShellStore } from "../store.ts";
import { POWER_DIALOG_COPY, type PowerConfirmAction } from "../topics.ts";

const footerButton = {
  display: "flex", alignItems: "center", justifyContent: "center",
  height: "40px", borderRadius: "20px", fontSize: "14px", fontWeight: 600,
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

  return (
    <box testId="power-dialog-backdrop" onClick={closePowerDialog} style={{
      position: "fixed", left: "0px", top: "0px", width: "100%", height: "100%",
      display: "flex", alignItems: "center", justifyContent: "center", backgroundColor: "rgba(11, 13, 18, 0.55)",
    }}>
      <box testId="power-dialog-card" role="dialog" ariaLabel={copy().title} ariaModal
        ref={node => { registerDismissLayer(node, closePowerDialog, { layer: "modal", dismissOnOutsidePress: false }); }}
        onClick={event => event.stopPropagation()} style={{
          display: "flex", flexDirection: "column", alignItems: "center", width: "340px", borderRadius: "24px",
          backgroundColor: "var(--color-surface)", border: "1px solid var(--color-outline-variant)",
          padding: "24px", gap: "14px", fontFamily: "system-ui", color: "var(--color-on-surface)",
        }}>
        <box style={{
          display: "flex", alignItems: "center", justifyContent: "center", width: "56px", height: "56px", borderRadius: "28px",
          backgroundColor: copy().destructive ? "var(--color-error-container)" : "var(--color-primary-container)",
        }}>
          <ShojiIcon name={copy().icon} size={26}
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
  const { monitors, pendingPowerAction, sessionLock } = useShellStore();

  return (
    <Show when={(sessionLock.data()?.phase ?? "unlocked") === "unlocked" && monitors()[0]}>
      {primaryMonitor => (
        <Show when={pendingPowerAction()}>
          {action => (
            <LayerSurface name="power-dialog" output={primaryMonitor().id} layer="overlay"
              anchor={["top", "bottom", "left", "right"]} width={primaryMonitor().width} height={primaryMonitor().height}
              exclusiveZone={-1} keyboard="exclusive">
              <PowerDialogContent action={action} />
            </LayerSurface>
          )}
        </Show>
      )}
    </Show>
  );
}
