import { Button, For, LayerSurface, Show, TextField, createEffect, createMemo, createSignal, focus, onCleanup, registerDismissLayer, type Accessor, type NativeChild, type NativeKeyEvent, type NativeNode } from "@hewel/zgui";
import { M3Button, M3DialogShell } from "@z-shell/sdk/primitives";
import { ShellIcon } from "../icons.tsx";
import {
  SPRING_EPSILON,
  createM3Spring,
  createRetainedPresence,
  dialogMotionStyle,
  scrimBackdrop,
  useMotionScheme,
  type M3Spring,
} from "../motion.ts";
import { useShellStore } from "../store.ts";
import { resolveMonitorLogicalSize, type PolkitPromptView } from "../topics.ts";

// An empty native child becomes a text marker that would occupy space in the flex card.
const hiddenSection = { display: "none" } as const;
const containerHigh = "var(--color-surface-container-high)";
const containerHighest = "var(--color-surface-container-highest)";
const onSurface = "var(--color-on-surface)";
const muted = "var(--color-on-surface-variant)";
const primary = "var(--color-primary)";
const primaryContainer = "var(--color-primary-container)";
const onPrimaryContainer = "var(--color-on-primary-container)";
const clipped = { minWidth: "0px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } as const;

function PolkitContent(props: {
  active: Accessor<PolkitPromptView>;
  spatial: M3Spring;
  opacity: M3Spring;
}): NativeChild {
  const { invokeHostResult, theme } = useShellStore();
  const dark = () => theme.data()?.dark ?? true;
  const { active } = props;
  const scheme = useMotionScheme();
  const [response, setResponse] = createSignal("");
  const [localError, setLocalError] = createSignal<string>();
  const [inputFocused, setInputFocused] = createSignal(false);
  const [revealSecret, setRevealSecret] = createSignal(false);
  const detailEntries = createMemo(() => Object.entries(active().details));
  const prompt = createMemo(() => active().prompt ?? "Password");
  const errorText = () => localError() || active().error_message || null;
  const selectedIdentity = createMemo(() => {
    const list = active().identities;
    return list.find(id => id.uid === active().selected_uid) ?? list[0] ?? null;
  });

  const shakeX = createM3Spring(() => 0, "fastSpatial", {
    scheme,
    overrideScheme: "expressive",
    epsilon: SPRING_EPSILON.px,
  });

  let input: NativeNode | undefined;
  let cancelButton: NativeNode | undefined;
  let commandRevision = 0;

  createEffect(() => `${active().request_id}:${active().selected_uid}`, () => {
    commandRevision++;
    setResponse("");
    setLocalError(undefined);
    setRevealSecret(false);
  });
  createEffect(errorText, err => {
    if (err) shakeX.impulse(280);
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

  function selectIdentity(uid: number): void {
    void invokeHostResult("host.polkit-select-identity", { request_id: active().request_id, uid });
  }

  const cardMotion = () => {
    const base = dialogMotionStyle(props.spatial(), {
      opacity: props.opacity(),
      reduced: scheme() === "reduced",
      fromScale: 0.92,
      fromY: 0,
    });
    const dx = shakeX();
    if (scheme() === "reduced" || Math.abs(dx) < SPRING_EPSILON.px) return base;
    return {
      ...base,
      transform: `translateX(${dx.toFixed(2)}px) ${base.transform === "none" ? "" : base.transform}`.trim(),
    };
  };

  const [cardNode, setCardNode] = createSignal<NativeNode | null>(null);
  createEffect(cardNode, node => {
    if (!node) return;
    const handle = registerDismissLayer(node, cancel, { layer: "modal", dismissOnOutsidePress: false });
    return () => handle.dispose();
  });

  return (
    <box style={{
      position: "fixed", left: "0px", top: "0px", width: "100%", height: "100%",
      display: "flex", alignItems: "center", justifyContent: "center",
      backgroundColor: scrimBackdrop(55, props.opacity(), dark()),
    }}>
      <M3DialogShell
        testId="polkit-card"
        ariaLabel="Authentication required"
        error={Boolean(errorText())}
        ref={setCardNode}
        style={{
          padding: "18px",
          gap: "12px",
          ...cardMotion(),
        }}
      >
        <row style={{ alignItems: "center", gap: "12px" }}>
          <box ariaHidden style={{
            display: "flex", width: "46px", height: "46px", flexShrink: 0, borderRadius: "14px",
            alignItems: "center", justifyContent: "center", backgroundColor: primaryContainer,
          }}>
            <ShellIcon name="lock" size={22} color={onPrimaryContainer} />
          </box>
          <column style={{ flexGrow: 1, flexBasis: "0px", minWidth: "0px", gap: "2px" }}>
            <text role="heading" style={{ fontSize: "16px", fontWeight: 600, lineHeight: "22px" }}>Authentication required</text>
            <text style={{ ...clipped, fontSize: "12px", color: muted, lineHeight: "16px" }}>System privileges requested via Polkit</text>
          </column>
        </row>

        <column style={{ borderRadius: "14px", backgroundColor: containerHigh, padding: "10px 12px", gap: "4px" }}>
          <text testId="polkit-message" style={{ fontSize: "13px", fontWeight: 500, lineHeight: "18px" }}>{active().message}</text>
          <text testId="polkit-action-id" style={{
            ...clipped, fontFamily: "var(--font-mono)", fontSize: "11px", color: muted,
          }}>{active().action_id}</text>
          <Show when={detailEntries().length > 0} fallback={<box style={hiddenSection} />}>
            <column style={{ paddingTop: "6px", gap: "3px" }}>
              <For each={detailEntries()} keyed={entry => entry[0]}>
                {entry => (
                  <row style={{ alignItems: "flex-start", gap: "8px", fontSize: "11px" }}>
                    <text style={{ color: muted, flexShrink: 0 }}>{entry()[0]}</text>
                    <text style={{ ...clipped, flexGrow: 1, fontFamily: "var(--font-mono)" }}>{entry()[1]}</text>
                  </row>
                )}
              </For>
            </column>
          </Show>
        </column>

        <column style={{ borderRadius: "14px", backgroundColor: containerHigh, padding: "10px", gap: "8px" }}>
          <Show when={active().identities.length > 1} fallback={
            <Show when={selectedIdentity()} fallback={<box style={hiddenSection} />}>
              {identity => (
                <row testId={`polkit-identity-${identity().uid}`} style={{ alignItems: "center", gap: "8px", padding: "2px 4px" }}>
                  <box ariaHidden style={{
                    display: "flex", width: "24px", height: "24px", borderRadius: "999px", "--zgui-corner-shape": "none", flexShrink: 0,
                    alignItems: "center", justifyContent: "center", backgroundColor: containerHighest,
                  }}>
                    <ShellIcon name="person" size={14} color={primary} />
                  </box>
                  <text style={{ ...clipped, flexGrow: 1, fontSize: "13px", fontWeight: 500 }}>{identity().username}</text>
                  <text style={{ fontFamily: "var(--font-mono)", fontSize: "11px", color: muted }}>{`uid ${identity().uid}`}</text>
                </row>
              )}
            </Show>
          }>
            <row style={{ alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
              <For each={active().identities} keyed={item => item.uid}>
                {identity => {
                  const selected = () => identity().uid === selectedIdentity()?.uid;
                  return (
                    <Button testId={`polkit-identity-${identity().uid}`} selected={selected()}
                      disabled={active().authenticating}
                      onClick={() => selectIdentity(identity().uid)} style={{
                        display: "flex", flexDirection: "row", alignItems: "center", gap: "6px",
                        minHeight: "28px", padding: "4px 10px", borderRadius: "8px",
                        backgroundColor: selected() ? primaryContainer : containerHighest,
                        color: selected() ? onPrimaryContainer : muted,
                        fontSize: "12px", fontWeight: selected() ? 600 : 500,
                      }}>
                      <ShellIcon name="person" size={13} color={selected() ? onPrimaryContainer : muted} />
                      <text>{identity().username}</text>
                    </Button>
                  );
                }}
              </For>
            </row>
          </Show>

          <row data-composite-input="true" style={{
            height: "42px", alignItems: "center", gap: "6px", borderRadius: "10px",
            backgroundColor: containerHighest, padding: inputFocused() ? "0 7px 0 11px" : "0 8px 0 12px",
            border: errorText()
              ? "2px solid var(--color-error)"
              : inputFocused()
                ? `2px solid ${primary}`
                : "1px solid color-mix(in srgb, var(--color-outline-variant) 55%, transparent)",
          }}>
            <TextField testId="polkit-input" class="shell-composite-field" ariaLabel={prompt()} placeholder={prompt()}
              secure={!active().echo_on && !revealSecret()} disabled={active().authenticating}
              value={response()} onInput={event => setResponse(event.value)}
              onFocus={() => setInputFocused(true)} onBlur={() => setInputFocused(false)}
              onKeyDown={handleKeyDown} ref={node => { input = node; focus(node); }} style={{
                flexGrow: 1, flexBasis: "0px", minWidth: "0px", height: "38px", lineHeight: "20px",
                padding: "9px 0px", border: "0px", backgroundColor: "transparent", color: onSurface, fontSize: "14px",
              }} />
            <Button ariaLabel={revealSecret() ? "Hide password" : "Show password"} disabled={active().echo_on}
              onClick={() => setRevealSecret(v => !v)} style={{
                display: "flex", width: "28px", height: "28px", borderRadius: "8px", flexShrink: 0,
                alignItems: "center", justifyContent: "center", backgroundColor: "transparent",
                opacity: active().echo_on ? 0.35 : 1,
              }}>
              <ShellIcon name={revealSecret() ? "visibilityOff" : "visibility"} size={15} color={revealSecret() ? primary : muted} />
            </Button>
          </row>
        </column>

        <Show when={active().info_message} fallback={<box style={hiddenSection} />}>
          {message => <text role="status" style={{ fontSize: "12px", color: muted }}>{message()}</text>}
        </Show>
        <Show when={errorText()} fallback={<box style={hiddenSection} />}>
          {message => <text testId="polkit-error" role="alert" style={{ fontSize: "12px", color: "var(--color-error)" }}>{message()}</text>}
        </Show>

        <row style={{ justifyContent: "flex-end", gap: "8px" }}>
          <M3Button testId="polkit-cancel" variant="outlined" neutral onClick={cancel} ref={node => { cancelButton = node; }}>
            Cancel
          </M3Button>
          <M3Button testId="polkit-submit" variant="filled" disabled={active().authenticating} onClick={submit}>
            Authenticate
          </M3Button>
        </row>
      </M3DialogShell>
    </box>
  );
}

export function PolkitDialog(): NativeChild {
  const { activeMonitor, monitors, outputs, polkit, sessionLock } = useShellStore();
  const scheme = useMotionScheme();
  const locked = () => polkit.data()?.locked_suppressed === true || (sessionLock.data()?.phase ?? "unlocked") !== "unlocked";
  const target = createMemo(() => {
    if (locked()) return null;
    const prompt = polkit.data()?.active;
    const output = activeMonitor()?.id;
    return prompt && output ? { prompt, output } : null;
  });
  // ADR-0004: session lock must hide Polkit instantaneously; normal dismissal plays fastEffects exit.
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
              <LayerSurface name="polkit-dialog" output={output} layer="overlay"
                anchor={["top", "bottom", "left", "right"]} width={size().width} height={size().height}
                exclusiveZone={-1} keyboard="exclusive">
                <PolkitContent active={() => entry().prompt} spatial={presence.progress} opacity={presence.opacity} />
              </LayerSurface>
            )}
          </Show>
        );
      }}
    </Show>
  );
}
