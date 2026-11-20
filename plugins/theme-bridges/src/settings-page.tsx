import { Button, Show, createSignal, type Accessor, type NativeChild, type NativeStyle } from "@hewel/zgui";
import type { ZShellClient } from "@z-shell/sdk";
import { useTopic } from "@z-shell/sdk/zgui";
import type { BridgeTargetStatus, ThemeBridgesStatus } from "./service.ts";

const actionStyle: NativeStyle = {
  padding: "8px 14px", borderRadius: "999px", minHeight: "40px", fontSize: "14px",
  backgroundColor: "var(--color-secondary-container)", color: "var(--color-on-secondary-container)",
};

function BridgeTarget(props: {
  readonly name: string;
  readonly testId: string;
  readonly status: BridgeTargetStatus;
}): NativeChild {
  const failed = () => props.status.state === "conflict" || props.status.state === "error";
  const applied = () => props.status.state === "applied";

  return (
    <column style={{ gap: "6px", padding: "12px", borderRadius: "16px", backgroundColor: "var(--color-surface-container)" }}>
      <row style={{ alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
        <text style={{ fontSize: "14px", fontWeight: "600" }}>{props.name}</text>
        <text testId={props.testId} style={{
          padding: "4px 10px", borderRadius: "999px", fontSize: "12px",
          backgroundColor: failed() ? "var(--color-error-container)"
            : applied() ? "var(--color-primary-container)" : "var(--color-surface-container-highest)",
          color: failed() ? "var(--color-on-error-container)"
            : applied() ? "var(--color-on-primary-container)" : "var(--color-on-surface-variant)",
        }}>{props.status.state}</text>
      </row>
      <text style={{ fontSize: "12px", color: "var(--color-on-surface-variant)" }}>
        {props.status.target ?? "No target configured"}
      </text>
      <Show when={props.status.message} fallback={<box style={{ display: "none" }} />}>
        {message => <text style={{ fontSize: "12px" }}>{message()}</text>}
      </Show>
    </column>
  );
}

export default function ThemeBridgesSettingsPage(props: { readonly client: Accessor<ZShellClient | undefined> }): NativeChild {
  const { data: status } = useTopic<ThemeBridgesStatus>(props.client, "plugin.z-shell.theme-bridges.status");
  const [commandError, setCommandError] = createSignal<string>();

  async function invoke(action: "reapply" | "revert"): Promise<void> {
    const client = props.client();
    if (!client) return;
    setCommandError(undefined);
    try {
      await client.invokeCommand(`plugin.z-shell.theme-bridges.${action}`);
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <box testId="plugin-theme-bridges-settings" style={{
      display: "flex", flexDirection: "column", padding: "16px", gap: "12px", borderRadius: "16px",
      backgroundColor: "var(--color-surface-container-low)", color: "var(--color-on-surface)",
    }}>
      <row style={{ alignItems: "center", flexWrap: "wrap", gap: "8px" }}>
        <text role="heading" style={{ flexGrow: 1, fontSize: "22px", fontWeight: "600" }}>Theme Bridges</text>
        <Button testId="theme-bridges-reapply" style={actionStyle} disabled={!props.client()} onClick={() => void invoke("reapply")}>
          Reapply
        </Button>
        <Button testId="theme-bridges-revert" style={actionStyle} disabled={!props.client()} onClick={() => void invoke("revert")}>
          Revert
        </Button>
      </row>
      <Show when={commandError()} fallback={<box style={{ display: "none" }} />}>
        {message => <text role="alert" style={{ color: "var(--color-error)" }}>{message()}</text>}
      </Show>
      <Show when={status()} fallback={<text>Waiting for bridge status</text>}>
        {data => <>
          <BridgeTarget name="ShojiWM" testId="bridge-shojiwm-state" status={data().shojiwm} />
          <BridgeTarget name="Zen Browser" testId="bridge-zen-state" status={data().zenBrowser} />
        </>}
      </Show>
    </box>
  );
}
