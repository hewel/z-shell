import { Button, For, LayerSurface, Show, TextField, createEffect, createMemo, createSignal, focus, onCleanup, registerDismissLayer, type Accessor, type NativeChild, type NativeKeyEvent, type NativeNode } from "@hewel/zgui";
import { ShojiIcon } from "../icons.tsx";
import { useShellStore } from "../store.ts";
import type { PolkitPromptView } from "../topics.ts";

// An empty native child becomes a text marker that would occupy space in the flex card.
const hiddenSection = { display: "none" } as const;
const footerButton = {
  display: "flex", alignItems: "center", justifyContent: "center",
  height: "40px", borderRadius: "20px", fontSize: "14px", fontWeight: 600,
} as const;

function PolkitContent(props: { active: Accessor<PolkitPromptView> }): NativeChild {
  const { invokeHostResult } = useShellStore();
  const { active } = props;
  const [response, setResponse] = createSignal("");
  const [localError, setLocalError] = createSignal<string>();
  const detailEntries = createMemo(() => Object.entries(active().details));
  const prompt = createMemo(() => active().prompt ?? "Password:");
  let input: NativeNode | undefined;
  let cancelButton: NativeNode | undefined;
  let commandRevision = 0;

  createEffect(() => `${active().request_id}:${active().selected_uid}`, () => {
    commandRevision++;
    setResponse("");
    setLocalError(undefined);
  });
  createEffect(() => active().authenticating, authenticating => {
    const target = authenticating ? cancelButton : input;
    if (target) focus(target);
  });
  onCleanup(() => { commandRevision++; });

  async function invoke(name: "host.polkit-cancel" | "host.polkit-respond", payload: {
    request_id: number;
    response?: string;
  }): Promise<void> {
    const revision = ++commandRevision;
    setLocalError(undefined);
    const result = await invokeHostResult(name, payload);
    if (!result.ok && revision === commandRevision) setLocalError(result.error);
  }

  function cancel(): void {
    setResponse("");
    void invoke("host.polkit-cancel", { request_id: active().request_id });
  }

  function submit(): void {
    if (active().authenticating) return;
    const value = response();
    setResponse("");
    void invoke("host.polkit-respond", { request_id: active().request_id, response: value });
  }

  function handleKeyDown(event: NativeKeyEvent): void {
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (!event.repeat) submit();
  }

  return (
    <box style={{
      position: "fixed", left: "0px", top: "0px", width: "100%", height: "100%",
      display: "flex", alignItems: "center", justifyContent: "center", backgroundColor: "rgba(11, 13, 18, 0.55)",
    }}>
      <box testId="polkit-card" role="dialog" ariaLabel="Authentication Required" ariaModal
        ref={node => { registerDismissLayer(node, cancel, { layer: "modal", dismissOnOutsidePress: false }); }} style={{
        display: "flex", flexDirection: "column", width: "420px", borderRadius: "24px",
        backgroundColor: "var(--color-surface)", border: "1px solid var(--color-outline-variant)",
        padding: "24px", gap: "14px", fontFamily: "system-ui", color: "var(--color-on-surface)",
      }}>
        <row style={{ alignItems: "center", gap: "12px" }}>
          <box style={{
            display: "flex", width: "44px", height: "44px", flexShrink: 0, borderRadius: "22px",
            alignItems: "center", justifyContent: "center", backgroundColor: "var(--color-primary-container)",
          }}>
            <ShojiIcon name="lock" size={22} color="var(--color-on-primary-container)" />
          </box>
          <column style={{ minWidth: "0px", alignItems: "flex-start", gap: "4px" }}>
            <text role="heading" style={{ fontSize: "20px", fontWeight: 700 }}>Authentication Required</text>
            <text testId="polkit-action-id" style={{
              padding: "3px 8px", borderRadius: "10px", maxWidth: "100%", whiteSpace: "nowrap",
              overflow: "hidden", textOverflow: "ellipsis", backgroundColor: "var(--color-surface-container)",
              color: "var(--color-on-surface-variant)", fontSize: "12px",
            }}>{active().action_id}</text>
          </column>
        </row>
        <text testId="polkit-message" style={{ fontSize: "14px" }}>{active().message}</text>
        <Show when={detailEntries().length > 0} fallback={<box style={hiddenSection} />}>
          <column style={{ backgroundColor: "var(--color-surface-container)", borderRadius: "12px", padding: "10px 12px", gap: "4px" }}>
            <For each={detailEntries()} keyed={entry => entry[0]}>
              {entry => (
                <row style={{ alignItems: "flex-start", gap: "10px", fontSize: "12px" }}>
                  <text style={{ color: "var(--color-on-surface-variant)" }}>{entry()[0]}</text>
                  <text style={{ flexGrow: 1, minWidth: "0px" }}>{entry()[1]}</text>
                </row>
              )}
            </For>
          </column>
        </Show>
        <Show when={active().identities.length > 0} fallback={<box style={hiddenSection} />}>
          <row role="group" ariaLabel="Identity" style={{ flexWrap: "wrap", gap: "8px" }}>
            <For each={active().identities} keyed={identity => identity.uid}>
              {id => {
                const selected = () => id().uid === active().selected_uid;
                return (
                  <Button testId={`polkit-identity-${id().uid}`} selected={selected()} onClick={() => {
                    void invokeHostResult("host.polkit-select-identity", { request_id: active().request_id, uid: id().uid });
                  }} style={{
                    display: "flex", alignItems: "center", justifyContent: "center",
                    height: "32px", padding: "0px 12px", borderRadius: "16px", fontSize: "13px",
                    backgroundColor: selected() ? "var(--color-primary)" : "var(--color-surface-container)",
                    color: selected() ? "var(--color-on-primary)" : "var(--color-on-surface-variant)",
                  }}>{id().username}</Button>
                );
              }}
            </For>
          </row>
        </Show>
        <column style={{ gap: "6px" }}>
          <text testId="polkit-prompt" style={{ fontSize: "14px" }}>{prompt()}</text>
          <TextField testId="polkit-input" ariaLabel={prompt()} secure={!active().echo_on}
            disabled={active().authenticating} value={response()} onInput={event => setResponse(event.value)}
            onKeyDown={handleKeyDown} ref={node => { input = node; focus(node); }} style={{
              display: "flex", alignItems: "center", width: "100%", height: "44px", borderRadius: "12px", padding: "0px 12px",
              backgroundColor: "var(--color-surface-container-high)", color: "var(--color-on-surface)", fontSize: "14px",
            }} />
        </column>
        <Show when={active().info_message} fallback={<box style={hiddenSection} />}>
          {message => <text role="status" style={{ fontSize: "13px", color: "var(--color-on-surface-variant)" }}>{message()}</text>}
        </Show>
        <Show when={localError() || active().error_message} fallback={<box style={hiddenSection} />}>
          {message => <text testId="polkit-error" role="alert" style={{ fontSize: "13px", color: "var(--color-error)" }}>{message()}</text>}
        </Show>
        <row style={{ justifyContent: "flex-end", gap: "10px" }}>
          <Button testId="polkit-cancel" onClick={cancel} ref={node => { cancelButton = node; }}
            style={{ ...footerButton, padding: "0px 16px", backgroundColor: "transparent", color: "var(--color-primary)" }}>Cancel</Button>
          <Button testId="polkit-submit" disabled={active().authenticating} onClick={submit} style={{
            ...footerButton, padding: "0px 20px", opacity: active().authenticating ? 0.5 : 1,
            backgroundColor: "var(--color-primary)", color: "var(--color-on-primary)",
          }}>Authenticate</Button>
        </row>
      </box>
    </box>
  );
}

export function PolkitDialog(): NativeChild {
  const { monitors, polkit, sessionLock } = useShellStore();
  const visiblePrompt = () => {
    const snapshot = polkit.data();
    return !snapshot?.locked_suppressed && (sessionLock.data()?.phase ?? "unlocked") === "unlocked"
      ? snapshot?.active : null;
  };

  return (
    <Show when={visiblePrompt()}>
      {active => (
        <Show when={monitors()[0]}>
          {primaryMonitor => (
            <LayerSurface name="polkit-dialog" output={primaryMonitor().id} layer="overlay"
              anchor={["top", "bottom", "left", "right"]} width={primaryMonitor().width} height={primaryMonitor().height}
              exclusiveZone={-1} keyboard="exclusive">
              <PolkitContent active={active} />
            </LayerSurface>
          )}
        </Show>
      )}
    </Show>
  );
}
