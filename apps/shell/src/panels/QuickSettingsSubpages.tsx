import { Button, For, Match, Show, Switch, TextField, createMemo, createSignal, type Accessor, type NativeChild } from "@hewel/zgui";
import { ShellIcon, type ShellIconName } from "../icons.tsx";
import { createEnterProgress } from "../motion.ts";
import { useShellStore } from "../store.ts";
import type { AudioDevice, BluetoothDevice } from "../topics.ts";
import { PrecisionSliderRow, type QuickSettingsPage } from "./QuickSettingsPanel.tsx";

type Subpage = Exclude<QuickSettingsPage, "main">;

const titles: Record<Subpage, string> = {
  wifi: "Wi-Fi", bluetooth: "Bluetooth", sound: "Sound",
};
const primary = "var(--color-primary)";
const onSurface = "var(--color-on-surface)";
const muted = "var(--color-on-surface-variant)";
const container = "var(--color-surface-container)";
const containerHigh = "var(--color-surface-container-high)";
const containerHighest = "var(--color-surface-container-highest)";
const selectedFill = "var(--color-primary-container)";
const selectedInk = "var(--color-on-primary-container)";
const row = { display: "flex", flexDirection: "row", alignItems: "center", gap: "8px" } as const;
const pills = { alignItems: "center", gap: "6px", flexWrap: "wrap" } as const;
const grow = { flexGrow: 1, flexBasis: "0px", minWidth: "0px" } as const;
const clipped = { minWidth: "0px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } as const;
const detail = { ...clipped, color: muted, fontSize: "12px" } as const;
const card = { borderRadius: "16px", backgroundColor: containerHigh, padding: "12px", gap: "8px" } as const;
const itemCard = { borderRadius: "14px", backgroundColor: containerHighest, padding: "10px", gap: "6px" } as const;

export function QuickSettingsScroll(props: { testId: string; label: string; children: NativeChild }): NativeChild {
  return (
    <scroll testId={props.testId} role="scrollView" ariaLabel={props.label} style={{
      width: "100%", maxHeight: "100vh",
      overflow: "hidden auto", backgroundColor: container, color: onSurface, fontFamily: "var(--font-sans)", fontSize: "13px",
    }}>
      <column style={{ width: "100%", padding: "14px", gap: "10px", flexDirection: "column" }}>{props.children}</column>
    </scroll>
  );
}

export function QuickSettingsIconButton(props: {
  label: string; icon: ShellIconName; testId?: string; color?: string; fill?: string;
  size?: number; disabled?: boolean; expanded?: boolean; onClick: () => void;
}): NativeChild {
  const px = () => `${props.size ?? 34}px`;
  return (
    <Button testId={props.testId} ariaLabel={props.label} disabled={props.disabled} expanded={props.expanded}
      onClick={props.onClick} style={{
        display: "flex", width: px(), height: px(), borderRadius: "10px", flexShrink: 0,
        alignItems: "center", justifyContent: "center", backgroundColor: props.fill ?? containerHighest, opacity: props.disabled ? 0.45 : 1,
      }}>
      <ShellIcon name={props.icon} size={16} color={props.color} />
    </Button>
  );
}

function Action(props: {
  label: string; testId?: string; ariaLabel?: string; active?: boolean; disabled?: boolean;
  checked?: boolean; onClick: () => void;
}): NativeChild {
  return (
    <Button testId={props.testId} ariaLabel={props.ariaLabel ?? props.label} checked={props.checked} disabled={props.disabled}
      onClick={props.onClick} style={{
        display: "flex", minHeight: "30px", padding: "0 10px", borderRadius: "10px",
        flexShrink: 0, alignItems: "center", justifyContent: "center", fontSize: "12px", fontWeight: 500,
        opacity: props.disabled ? 0.45 : 1,
        backgroundColor: props.active ? selectedFill : containerHighest, color: props.active ? selectedInk : onSurface,
      }}>
      {props.label}
    </Button>
  );
}

function Toggle(props: { label: string; checked: boolean; disabled?: boolean; onClick: () => void }): NativeChild {
  return (
    <control role="switch" tabIndex={props.disabled ? -1 : 0} ariaLabel={props.label} checked={props.checked}
      disabled={props.disabled} onClick={props.onClick} style={{
        ...row, padding: "4px 8px", borderRadius: "999px",
        flexShrink: 0, minHeight: "30px", backgroundColor: containerHigh, opacity: props.disabled ? 0.45 : 1,
      }}>
      <text style={{ fontSize: "12px" }}>{props.label}</text>
      <row ariaHidden data-switch-track="true" style={{
        width: "28px", height: "16px", borderRadius: "8px", padding: "2px", alignItems: "center",
        justifyContent: props.checked ? "flex-end" : "flex-start", backgroundColor: props.checked ? primary : "var(--color-outline-variant)",
      }}>
        <box style={{ width: "12px", height: "12px", borderRadius: "6px", backgroundColor: props.checked ? "var(--color-on-primary)" : muted }} />
      </row>
    </control>
  );
}

function Section(props: { title: string; children: NativeChild }): NativeChild {
  return (
    <column style={card}>
      <text role="heading" style={{ fontSize: "13px", fontWeight: 600, color: muted }}>{props.title}</text>
      {props.children}
    </column>
  );
}

function Page(props: { page: Subpage; onBack: () => void; controls?: NativeChild; scanning?: boolean; children: NativeChild }): NativeChild {
  const enter = createEnterProgress({ stiffness: 420, damping: 32 });
  return (
    <QuickSettingsScroll testId={`qs-page-${props.page}`} label={titles[props.page]}>
      <column style={{
        width: "100%", gap: "10px",
        opacity: Math.max(0, Math.min(1, enter() * 1.35)),
        transform: `translateX(${((1 - enter()) * 16).toFixed(2)}px)`,
      }}>
        <row style={row}>
          <QuickSettingsIconButton testId="qs-back" label="Back" icon="arrowLeft" onClick={props.onBack} />
          <text role="heading" style={{ ...grow, ...clipped, fontSize: "20px", fontWeight: 600 }}>{titles[props.page]}</text>
          {props.controls}
        </row>
        <Show when={props.scanning}>
          <box ariaHidden style={{ width: "100%", height: "3px", borderRadius: "2px", backgroundColor: containerHigh, overflow: "hidden" }}>
            <box style={{ width: "42%", height: "100%", borderRadius: "2px", backgroundColor: primary }} />
          </box>
        </Show>
        {props.children}
      </column>
    </QuickSettingsScroll>
  );
}

function WifiPassword(props: { ssid: string; onCancel: () => void; onConnect: (password: string) => void }): NativeChild {
  const [password, setPassword] = createSignal("");
  const connect = () => {
    if (!password()) return;
    props.onConnect(password());
    setPassword("");
  };
  return (
    <column style={itemCard}>
      <TextField testId="wifi-password-input" secure ariaLabel={`Password for ${props.ssid}`} placeholder="Wi-Fi password"
        value={password()} onInput={event => setPassword(event.value)} style={{
          height: "36px", lineHeight: "18px", padding: "8px 10px",
          borderRadius: "8px", backgroundColor: "var(--color-surface)", color: onSurface,
        }} />
      <row style={{ ...row, justifyContent: "flex-end" }}>
        <Action label="Cancel" onClick={() => { setPassword(""); props.onCancel(); }} />
        <Action testId="wifi-password-connect" label="Connect" active disabled={!password()} onClick={connect} />
      </row>
    </column>
  );
}

function WifiPage(props: { onBack: () => void }): NativeChild {
  const { network, invokePublic, invokeHost } = useShellStore();
  const wifi = () => network.data()?.wifi;
  const enabled = () => wifi()?.enabled ?? false;
  const [selectedAp, setSelectedAp] = createSignal<string>();
  return (
    <Page page="wifi" onBack={props.onBack} scanning={wifi()?.scanning} controls={
      <>
        <Toggle label="Wi-Fi" checked={enabled()} disabled={!network.data()?.available || !wifi()?.hardware_enabled}
          onClick={() => {
            setSelectedAp(undefined);
            void invokePublic("network.wifi.set-enabled", { enabled: !enabled() });
          }} />
        <Action testId="wifi-scan" label={wifi()?.scanning ? "Scanning…" : "Scan"}
          disabled={!enabled() || !wifi()?.devices.length || wifi()?.scanning}
          onClick={() => void invokePublic("network.wifi.scan", {})} />
      </>
    }>
      <Show when={enabled()} fallback={<text style={detail}>{network.data()?.available ? "Wi-Fi is off" : "Wi-Fi is unavailable"}</text>}>
        <For each={wifi()?.devices} keyed={device => device.id} fallback={<text style={detail}>No Wi-Fi adapters</text>}>
          {device => {
            const active = createMemo(() => device().access_points.find(ap => ap.id === device().active_ap_id));
            return (
              <>
                <Show when={active() || device().active_connection}>
                  <Section title="Connected network">
                    <row style={{
                      ...row, minHeight: "52px", padding: "8px 10px", borderRadius: "16px",
                      backgroundColor: selectedFill, color: selectedInk,
                      border: "1px solid color-mix(in srgb, var(--color-primary) 30%, transparent)",
                    }}>
                      <ShellIcon name="wifi" size={18} color={selectedInk} />
                      <column style={{ ...grow, gap: "2px" }}>
                        <text style={{ ...clipped, fontWeight: 600 }}>{active()?.ssid || device().active_connection?.name || "Hidden network"}</text>
                        <text style={{ ...clipped, fontSize: "11px", color: selectedInk, opacity: 0.78 }}>Connected</text>
                      </column>
                      <QuickSettingsIconButton label="Disconnect" icon="linkOff" size={30}
                        fill="color-mix(in srgb, var(--color-primary) 18%, transparent)" color={selectedInk}
                        onClick={() => void invokePublic("network.wifi.disconnect", { device_id: device().id })} />
                    </row>
                  </Section>
                </Show>
                <Section title={(wifi()?.devices.length ?? 0) > 1 ? `Available networks · ${device().interface}` : "Available networks"}>
                  <For each={device().access_points.filter(ap => ap.id !== device().active_ap_id)} keyed={ap => ap.id}
                    fallback={<text style={detail}>No access points found</text>}>
                    {ap => {
                      const ssid = () => ap().ssid || "Hidden network";
                      const needsPassword = () => ap().security === "wpa_psk" || ap().security === "wpa_sae";
                      const requiresProfile = () => ap().security === "enterprise" || ap().security === "unsupported";
                      const savedProfile = () => {
                        if (!requiresProfile()) return undefined;
                        const ssidBytes = ap().ssid_bytes;
                        return wifi()?.profiles.find(profile => profile.ssid_bytes.length === ssidBytes.length
                          && profile.ssid_bytes.every((byte, index) => byte === ssidBytes[index]));
                      };
                      return (
                        <>
                          <Button testId={`wifi-ap-${ap().ssid}`} ariaLabel={ssid()} expanded={needsPassword() ? selectedAp() === ap().id : null}
                            disabled={requiresProfile() && !savedProfile()} onClick={() => {
                              const target = { device_id: device().id, ap_id: ap().id };
                              if (needsPassword()) {
                                setSelectedAp(target.ap_id);
                              } else {
                                setSelectedAp(undefined);
                                const profile = savedProfile();
                                void invokePublic("network.wifi.connect", profile ? { ...target, profile_id: profile.id } : target);
                              }
                          }} style={{ ...itemCard, ...row }}>
                            <ShellIcon name={ap().security === "open" ? "wifi" : "wifiLock"} size={18} color={primary} />
                            <column style={{ ...grow, gap: "2px" }}>
                              <text style={clipped}>{ssid()}</text>
                              <text style={detail}>
                                {requiresProfile() && !savedProfile() ? `${ap().security} · Saved profile required` : `Click to connect · ${ap().security}`}
                              </text>
                            </column>
                            <text data-tabular="true" style={{
                              width: "34px", flexShrink: 0, textAlign: "right",
                              fontFamily: "var(--font-mono)", fontSize: "11px", color: muted, fontVariantNumeric: "tabular-nums",
                            }}>
                              {ap().strength}%
                            </text>
                          </Button>
                          <Show when={needsPassword() && selectedAp() === ap().id}>
                            <WifiPassword ssid={ssid()} onCancel={() => setSelectedAp(undefined)} onConnect={password => {
                              void invokeHost("network.wifi.connect", { device_id: device().id, ap_id: ap().id, password });
                              setSelectedAp(undefined);
                            }} />
                          </Show>
                        </>
                      );
                    }}
                  </For>
                </Section>
              </>
            );
          }}
        </For>
      </Show>
    </Page>
  );
}

function BluetoothDeviceRow(props: { dev: Accessor<BluetoothDevice> }): NativeChild {
  const { bluetooth, invokePublic } = useShellStore();
  const { dev } = props;
  const powered = () => bluetooth.data()?.adapters.some(candidate => candidate.path === dev().adapter && candidate.powered);
  const deviceAction = (action: string) => { void invokePublic(`bluetooth.${action}`, { device: dev().path }); };
  return (
    <column testId={`bt-dev-${dev().address}`} style={{
      borderRadius: "16px", padding: "10px", gap: "8px",
      backgroundColor: dev().connected ? selectedFill : containerHighest,
      color: dev().connected ? selectedInk : onSurface,
      border: dev().connected ? "1px solid color-mix(in srgb, var(--color-primary) 30%, transparent)" : "1px solid transparent",
    }}>
      <row style={row}>
        <ShellIcon name="bluetooth" size={18} color={dev().connected ? selectedInk : muted} />
        <column style={{ ...grow, gap: "2px" }}>
          <text style={{ ...clipped, fontWeight: 600 }}>{dev().name || dev().address}</text>
          <text style={{ ...clipped, fontSize: "11px", color: dev().connected ? selectedInk : muted, opacity: dev().connected ? 0.78 : 1 }}>
            {dev().connected ? "Connected" : dev().paired ? "Click to connect" : "Click to pair"}
          </text>
        </column>
        <Show when={dev().battery != null}>
          <text data-tabular="true" style={{
            width: "34px", flexShrink: 0, textAlign: "right",
            fontFamily: "var(--font-mono)", fontSize: "11px", fontVariantNumeric: "tabular-nums",
          }}>
            {dev().battery}%
          </text>
        </Show>
        <Show when={dev().connected}>
          <QuickSettingsIconButton label="Disconnect" icon="linkOff" size={30}
            fill="color-mix(in srgb, var(--color-primary) 18%, transparent)" color={selectedInk}
            disabled={!powered()} onClick={() => deviceAction("disconnect")} />
        </Show>
      </row>
      <Show when={!dev().connected}>
        <row style={{ ...pills, justifyContent: "flex-end" }}>
          <Action label="Connect" disabled={!powered()} onClick={() => deviceAction("connect")} />
          <Show when={!dev().paired}><Action label="Pair" disabled={!powered()} onClick={() => deviceAction("pair")} /></Show>
          <Action label="Remove" onClick={() => deviceAction("remove")} />
        </row>
      </Show>
    </column>
  );
}

function BluetoothPage(props: { onBack: () => void }): NativeChild {
  const { bluetooth, invokePublic } = useShellStore();
  const adapter = () => bluetooth.data()?.adapters[0];
  const devices = () => bluetooth.data()?.devices ?? [];
  const pairedDevices = createMemo(() => devices().filter(device => device.connected || device.paired));
  const availableDevices = createMemo(() => devices().filter(device => !device.connected && !device.paired));

  return (
    <Page page="bluetooth" onBack={props.onBack} scanning={adapter()?.discovering} controls={
      <>
        <Toggle label="Bluetooth" checked={adapter()?.powered ?? false} disabled={!adapter()} onClick={() => {
          const device = adapter();
          if (device) void invokePublic("bluetooth.set-power", { adapter: device.path, powered: !device.powered });
        }} />
        <Action label={adapter()?.discovering ? "Stop scan" : "Scan"} checked={adapter()?.discovering ?? false}
          active={adapter()?.discovering} disabled={!adapter()?.powered} onClick={() => {
            const device = adapter();
            if (device) void invokePublic("bluetooth.set-discovery", { adapter: device.path, discovering: !device.discovering });
          }} />
      </>
    }>
      <Section title="Paired devices">
        <For each={pairedDevices()} keyed={device => device.path}
          fallback={<text style={detail}>{adapter() ? "No paired Bluetooth devices" : "No Bluetooth adapter"}</text>}>
          {dev => <BluetoothDeviceRow dev={dev} />}
        </For>
      </Section>
      <Show when={availableDevices().length > 0}>
        <Section title="Available devices">
          <For each={availableDevices()} keyed={device => device.path}>
            {dev => <BluetoothDeviceRow dev={dev} />}
          </For>
        </Section>
      </Show>
    </Page>
  );
}

function AudioDeviceRow(props: { device: Accessor<AudioDevice>; kind: "sink" | "source"; active: boolean }): NativeChild {
  const { invokePublic } = useShellStore();
  const target = () => ({ kind: props.kind, index: props.device().index });
  const name = () => props.device().description || props.device().name;
  return (
    <column style={{
      borderRadius: "14px", padding: "8px 10px", gap: "6px",
      backgroundColor: props.active ? selectedFill : containerHighest,
      color: props.active ? selectedInk : onSurface,
      border: props.active ? "1px solid color-mix(in srgb, var(--color-primary) 30%, transparent)" : "1px solid transparent",
    }}>
      <Button ariaLabel={name()} selected={props.active} onClick={() => void invokePublic("audio.set-default", target())}
        style={{ ...row, minHeight: "30px", color: props.active ? selectedInk : onSurface }}>
        <ShellIcon name={props.kind === "sink" ? "volumeHigh" : "mic"} size={16} color={props.active ? selectedInk : muted} />
        <text style={{ ...grow, ...clipped, fontWeight: props.active ? 600 : 500 }}>{name()}</text>
      </Button>
      <PrecisionSliderRow
        label={`${name()} volume`}
        icon={props.device().muted ? "volumeMute" : props.kind === "sink" ? "volumeHigh" : "mic"}
        iconLabel={props.device().muted ? "Unmute device" : "Mute device"}
        value={props.device().volume * 100}
        disabled={!props.device().channels}
        showTrailingSlot={false}
        onIconClick={() => void invokePublic("audio.set-mute", { ...target(), muted: !props.device().muted })}
        onChange={percent => void invokePublic("audio.set-volume", { ...target(), volume: percent / 100 })}
      />
    </column>
  );
}

function SoundPage(props: { onBack: () => void }): NativeChild {
  const { audio, invokePublic } = useShellStore();
  return (
    <Page page="sound" onBack={props.onBack}>
      <Section title="Output Devices">
        <For each={audio.data()?.sinks} keyed={device => device.index} fallback={<text style={detail}>No output devices</text>}>
          {sink => <AudioDeviceRow device={sink} kind="sink" active={sink().name === audio.data()?.default_sink} />}
        </For>
      </Section>
      <Section title="Input Devices">
        <For each={audio.data()?.sources} keyed={device => device.index} fallback={<text style={detail}>No input devices</text>}>
          {source => <AudioDeviceRow device={source} kind="source" active={source().name === audio.data()?.default_source} />}
        </For>
      </Section>
      <Section title="Applications">
        <For each={audio.data()?.sink_inputs} keyed={stream => stream.index} fallback={<text style={detail}>No playback streams</text>}>
          {app => (
            <column style={{ borderRadius: "14px", padding: "8px 10px", gap: "4px", backgroundColor: containerHighest }}>
              <text style={{ ...clipped, fontWeight: 500 }}>{app().application || app().name || "Unknown application"}</text>
              <PrecisionSliderRow
                label={`${app().application || app().name || "Application"} volume`}
                icon={app().muted ? "volumeMute" : "volumeHigh"}
                iconLabel={app().muted ? "Unmute application" : "Mute application"}
                value={(app().volume ?? 0) * 100}
                disabled={!app().volume_writable}
                showTrailingSlot={false}
                onIconClick={() => void invokePublic("audio.set-app-mute", { index: app().index, muted: !app().muted })}
                onChange={percent => void invokePublic("audio.set-app-volume", { index: app().index, volume: percent / 100 })}
              />
            </column>
          )}
        </For>
      </Section>
    </Page>
  );
}

export function QuickSettingsSubpage(props: { readonly page: Subpage; readonly onBack: () => void }): NativeChild {
  return (
    <Switch>
      <Match when={props.page === "wifi"}><WifiPage onBack={props.onBack} /></Match>
      <Match when={props.page === "bluetooth"}><BluetoothPage onBack={props.onBack} /></Match>
      <Match when={props.page === "sound"}><SoundPage onBack={props.onBack} /></Match>
    </Switch>
  );
}
