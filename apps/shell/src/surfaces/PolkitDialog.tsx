import { Button, For, LayerSurface, Show, TextField, createEffect, createMemo, createSignal, cx, focus, onCleanup, registerDismissLayer, type Accessor, type NativeChild, type NativeKeyEvent, type NativeNode } from "@hewel/zgui";
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
import { usePinnedOutput, useShellStore } from "../store.ts";
import { resolveMonitorLogicalSize, type PolkitPromptView } from "../topics.ts";
import styles from "./PolkitDialog.module.css";

function PolkitContent(props: {
  active: Accessor<PolkitPromptView>;
  inert: boolean;
  spatial: M3Spring;
  opacity: M3Spring;
}): NativeChild {
  const { invokeHostResult, theme } = useShellStore();
  const dark = () => theme.data()?.dark ?? true;
  const scheme = useMotionScheme();
  const [response, setResponse] = createSignal("");
  const [localError, setLocalError] = createSignal<string>();
  const [inputFocused, setInputFocused] = createSignal(false);
  const [revealSecret, setRevealSecret] = createSignal(false);
  const detailEntries = createMemo(() => Object.entries(props.active().details));
  const prompt = createMemo(() => props.active().prompt ?? "Password");
  const errorText = () => localError() || props.active().error_message || null;
  const selectedIdentity = createMemo(() => {
    const list = props.active().identities;
    return list.find(id => id.uid === props.active().selected_uid) ?? list[0] ?? null;
  });

  const shakeX = createM3Spring(() => 0, "fastSpatial", {
    scheme,
    overrideScheme: "expressive",
    epsilon: SPRING_EPSILON.px,
  });

  let input: NativeNode | undefined;
  let cancelButton: NativeNode | undefined;
  let commandRevision = 0;

  createEffect(() => `${props.active().request_id}:${props.active().selected_uid}`, () => {
    commandRevision++;
    setResponse("");
    setLocalError(undefined);
    setRevealSecret(false);
  });
  createEffect(errorText, err => {
    if (err) shakeX.impulse(280);
  });
  createEffect(() => props.active().authenticating, authenticating => {
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
    void invoke("host.polkit-cancel", { request_id: props.active().request_id });
  }

  function submit(): void {
    if (props.active().authenticating) return;
    const value = response();
    setResponse("");
    void invoke("host.polkit-respond", { request_id: props.active().request_id, response: value });
  }

  function handleKeyDown(event: NativeKeyEvent): void {
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (!event.repeat) submit();
  }

  function selectIdentity(uid: number): void {
    void invokeHostResult("host.polkit-select-identity", { request_id: props.active().request_id, uid });
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
    <box
      inert={props.inert}
      class={styles.backdrop}
      style={{ backgroundColor: scrimBackdrop(55, props.opacity(), dark()) }}
    >
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
        <row class={styles.headerRow}>
          <box ariaHidden class={styles.headerBadge}>
            <ShellIcon name="lock" size={22} color="var(--color-on-primary-container)" />
          </box>
          <column class={styles.headerText}>
            <text role="heading" class={styles.headerTitle}>Authentication required</text>
            <text class={styles.headerSubtitle}>System privileges requested via Polkit</text>
          </column>
        </row>

        <column class={styles.sectionCard}>
          <text testId="polkit-message" class={styles.messageText}>{props.active().message}</text>
          <text testId="polkit-action-id" class={styles.actionId}>{props.active().action_id}</text>
          <Show when={detailEntries().length > 0} fallback={<box class={styles.hiddenSection} />}>
            <column class={styles.detailsList}>
              <For each={detailEntries()} keyed={entry => entry[0]}>
                {entry => (
                  <row class={styles.detailRow}>
                    <text class={styles.detailKey}>{entry()[0]}</text>
                    <text class={styles.detailValue}>{entry()[1]}</text>
                  </row>
                )}
              </For>
            </column>
          </Show>
        </column>

        <column class={styles.authCard}>
          <Show when={props.active().identities.length > 1} fallback={
            <Show when={selectedIdentity()} fallback={<box class={styles.hiddenSection} />}>
              {identity => (
                <row testId={`polkit-identity-${identity().uid}`} class={styles.identityRow}>
                  <box ariaHidden class={styles.identityAvatar}>
                    <ShellIcon name="person" size={14} color="var(--color-primary)" />
                  </box>
                  <text class={styles.identityName}>{identity().username}</text>
                  <text class={styles.identityUid}>{`uid ${identity().uid}`}</text>
                </row>
              )}
            </Show>
          }>
            <row class={styles.identityList}>
              <For each={props.active().identities} keyed={item => item.uid}>
                {identity => {
                  const selected = () => identity().uid === selectedIdentity()?.uid;
                  return (
                    <Button
                      testId={`polkit-identity-${identity().uid}`}
                      selected={selected()}
                      data-selected={selected() ? "true" : "false"}
                      disabled={props.active().authenticating}
                      onClick={() => selectIdentity(identity().uid)}
                      class={styles.identityButton}
                    >
                      <ShellIcon
                        name="person"
                        size={13}
                        color={selected() ? "var(--color-on-primary-container)" : "var(--color-on-surface-variant)"}
                      />
                      <text>{identity().username}</text>
                    </Button>
                  );
                }}
              </For>
            </row>
          </Show>

          <row
            data-composite-input="true"
            data-focused={inputFocused() ? "true" : "false"}
            data-error={errorText() ? "true" : "false"}
            class={styles.compositeInput}
          >
            <TextField
              testId="polkit-input"
              class={cx(styles.textField, "shell-composite-field")}
              ariaLabel={prompt()}
              placeholder={prompt()}
              secure={!props.active().echo_on && !revealSecret()}
              disabled={props.active().authenticating}
              value={response()}
              onInput={event => setResponse(event.value)}
              onFocus={() => setInputFocused(true)}
              onBlur={() => setInputFocused(false)}
              onKeyDown={handleKeyDown}
              ref={node => { input = node; focus(node); }}
            />
            <Button
              ariaLabel={revealSecret() ? "Hide password" : "Show password"}
              disabled={props.active().echo_on}
              onClick={() => setRevealSecret(v => !v)}
              class={styles.revealButton}
            >
              <ShellIcon
                name={revealSecret() ? "visibilityOff" : "visibility"}
                size={15}
                color={revealSecret() ? "var(--color-primary)" : "var(--color-on-surface-variant)"}
              />
            </Button>
          </row>
        </column>

        <Show when={props.active().info_message} fallback={<box class={styles.hiddenSection} />}>
          {message => <text role="status" class={styles.infoText}>{message()}</text>}
        </Show>
        <Show when={errorText()} fallback={<box class={styles.hiddenSection} />}>
          {message => <text testId="polkit-error" role="alert" class={styles.errorText}>{message()}</text>}
        </Show>

        <row class={styles.actionsRow}>
          <M3Button testId="polkit-cancel" variant="outlined" neutral onClick={cancel} ref={node => { cancelButton = node; }}>
            Cancel
          </M3Button>
          <M3Button testId="polkit-submit" variant="filled" disabled={props.active().authenticating} onClick={submit}>
            Authenticate
          </M3Button>
        </row>
      </M3DialogShell>
    </box>
  );
}

export function PolkitDialog(): NativeChild {
  const { monitors, outputs, polkit, sessionLock } = useShellStore();
  const scheme = useMotionScheme();
  const locked = () => polkit.data()?.locked_suppressed === true || (sessionLock.data()?.phase ?? "unlocked") !== "unlocked";
  const pinnedOutput = usePinnedOutput(() => (locked() ? null : polkit.data()?.active?.request_id ?? null));
  const target = createMemo(() => {
    const output = pinnedOutput();
    const prompt = polkit.data()?.active;
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
                <PolkitContent active={() => entry().prompt} inert={!presence.present()} spatial={presence.progress} opacity={presence.opacity} />
              </LayerSurface>
            )}
          </Show>
        );
      }}
    </Show>
  );
}
