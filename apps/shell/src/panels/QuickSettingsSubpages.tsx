import { Button, For, Match, Show, Switch, TextField, createMemo, createSignal, cx, type Accessor, type NativeChild } from "@hewel/zgui";
import { M3Button, M3CardAction, M3Collapsible, M3InteractiveCard, M3Switch } from "@z-shell/sdk/primitives";
import { ShellIcon, type ShellIconName } from "../icons.tsx";
import { SPRING_EPSILON, createEnterProgress, createM3Spring, sharedAxisXStyle, useMotionScheme } from "../motion.ts";
import { useShellStore } from "../store.ts";
import { PANEL_MAX_HEIGHTS, type AudioDevice, type BluetoothDevice } from "../topics.ts";
import { BatteryPowerContent } from "./BatteryPanel.tsx";
import { PrecisionSliderRow, type QuickSettingsPage } from "./QuickSettingsPanel.tsx";
import styles from "./QuickSettingsSubpages.module.css";

type Subpage = Exclude<QuickSettingsPage, "main">;

const titles: Record<Exclude<Subpage, "battery">, string> = {
  wifi: "Network", bluetooth: "Bluetooth", sound: "Sound",
};
const primary = "var(--color-primary)";
const muted = "var(--color-on-surface-variant)";
const selectedInk = "var(--color-on-primary-container)";

export function QuickSettingsScroll(props: { testId?: string | null; label: string; children: NativeChild }): NativeChild {
  return (
    <scroll
      testId={props.testId ?? null}
      role="scrollView"
      ariaLabel={props.label}
      class={styles.scroll}
      style={{ maxHeight: `${PANEL_MAX_HEIGHTS["quick-settings"]}px` }}
    >
      <column class={styles.scrollInner}>{props.children}</column>
    </scroll>
  );
}

export function QuickSettingsIconButton(props: {
  label: string;
  icon: ShellIconName;
  testId?: string | undefined;
  color?: string;
  tone?: "default" | "transparent" | "accent-subtle";
  size?: 26 | 30 | 34;
  disabled?: boolean;
  expanded?: boolean;
  onClick: () => void;
}): NativeChild {
  return (
    <Button
      testId={props.testId ?? null}
      ariaLabel={props.label}
      disabled={props.disabled ?? false}
      expanded={props.expanded ?? null}
      data-size={String(props.size ?? 34)}
      data-tone={props.tone ?? "default"}
      data-disabled={props.disabled ? "true" : "false"}
      onClick={props.onClick}
      class={styles.iconBtn}
    >
      <box data-press-visual="compact" class={styles.pressVisualCompact}>
        <ShellIcon name={props.icon} size={16} color={props.color} />
      </box>
    </Button>
  );
}

function Action(props: {
  label: string; testId?: string; ariaLabel?: string; active?: boolean; disabled?: boolean;
  checked?: boolean; onClick: () => void;
}): NativeChild {
  return (
    <M3Button
      size="sm"
      variant={props.active ? "accent-tonal" : "neutral-tonal"}
      {...(props.testId !== undefined ? { testId: props.testId } : {})}
      ariaLabel={props.ariaLabel ?? props.label}
      {...(props.active !== undefined ? { selected: props.active } : {})}
      {...(props.disabled !== undefined ? { disabled: props.disabled } : {})}
      onClick={props.onClick}
    >
      <text>{props.label}</text>
    </M3Button>
  );
}

function Toggle(props: { label: string; checked: boolean; disabled?: boolean; onClick: () => void }): NativeChild {
  return (
    <row class={cx(styles.row, styles.toggleRow)}>
      <text class={styles.toggleLabel}>{props.label}</text>
      <M3Switch
        checked={props.checked}
        ariaLabel={props.label}
        {...(props.disabled !== undefined ? { disabled: props.disabled } : {})}
        onToggle={props.onClick}
      />
    </row>
  );
}

function Section(props: { title: string; children: NativeChild }): NativeChild {
  return (
    <column class={styles.card}>
      <text role="heading" class={styles.sectionTitle}>{props.title}</text>
      {props.children}
    </column>
  );
}

function Page(props: { page: Exclude<Subpage, "battery">; onBack: () => void; controls?: NativeChild; scanning?: boolean; outgoing?: boolean | undefined; children: NativeChild }): NativeChild {
  const scheme = useMotionScheme();
  const enter = createEnterProgress("defaultSpatial", { scheme });
  return (
    <QuickSettingsScroll testId={props.outgoing ? null : `qs-page-${props.page}`} label={titles[props.page]}>
      <column class={styles.pageBody} style={props.outgoing ? undefined : sharedAxisXStyle(enter(), 1, scheme() === "reduced")}>
        <row class={styles.row}>
          <QuickSettingsIconButton testId={props.outgoing ? undefined : "qs-back"} label="Back" icon="arrowLeft" onClick={props.onBack} />
          <text role="heading" class={cx(styles.grow, styles.clipped, styles.pageTitle)}>{titles[props.page]}</text>
          {props.controls}
        </row>
        <Show when={props.scanning}>
          <box ariaHidden class={styles.scanTrack}>
            <box class={styles.scanFill} />
          </box>
        </Show>
        {props.children}
      </column>
    </QuickSettingsScroll>
  );
}

function BatterySubpage(props: { onBack: () => void; outgoing?: boolean | undefined }): NativeChild {
  const scheme = useMotionScheme();
  const enter = createEnterProgress("defaultSpatial", { scheme });
  return (
    <QuickSettingsScroll testId={props.outgoing ? null : "qs-page-battery"} label="Battery & power">
      <column class={styles.batteryPageBody} style={props.outgoing ? undefined : sharedAxisXStyle(enter(), 1, scheme() === "reduced")}>
        <BatteryPowerContent onBack={props.onBack} />
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
    <column class={styles.itemCard}>
      <TextField
        testId="wifi-password-input"
        secure
        ariaLabel={`Password for ${props.ssid}`}
        placeholder="Wi-Fi password"
        value={password()}
        onInput={event => setPassword(event.value)}
        class={styles.passwordInput}
      />
      <row class={cx(styles.row, styles.passwordActions)}>
        <Action label="Cancel" onClick={() => { setPassword(""); props.onCancel(); }} />
        <Action testId="wifi-password-connect" label="Connect" active disabled={!password()} onClick={connect} />
      </row>
    </column>
  );
}

function WifiExpandChevron(props: { readonly open: boolean }): NativeChild {
  const scheme = useMotionScheme();
  const deg = createM3Spring(() => (props.open ? 180 : 0), "fastSpatial", { scheme, epsilon: SPRING_EPSILON.deg });
  return (
    <box
      ariaHidden
      class={styles.expandChevron}
      style={{ transform: scheme() === "reduced" ? "none" : `rotate(${deg().toFixed(1)}deg)` }}
    >
      <ShellIcon name="expandMore" size={16} color={muted} />
    </box>
  );
}

function WifiPage(props: { onBack: () => void; outgoing?: boolean | undefined }): NativeChild {
  const { network, invokePublic, invokeHost } = useShellStore();
  const wifi = () => network.data()?.wifi;
  const ethernet = () => network.data()?.ethernet ?? [];
  const activeVpn = () => network.data()?.vpn ?? [];
  const availableVpnProfiles = createMemo(() => {
    const activeIds = new Set(activeVpn().map(item => item.profile_id));
    return (network.data()?.vpn_profiles ?? []).filter(prof => !activeIds.has(prof.id));
  });
  const enabled = () => wifi()?.enabled ?? false;
  const [selectedAp, setSelectedAp] = createSignal<string>();
  return (
    <Page page="wifi" onBack={props.onBack} outgoing={props.outgoing} scanning={wifi()?.scanning ?? false} controls={
      <>
        <Toggle label="Wi-Fi" checked={enabled()} disabled={!network.data()?.available || !wifi()?.hardware_enabled}
          onClick={() => {
            setSelectedAp(undefined);
            void invokePublic("network.wifi.set-enabled", { enabled: !enabled() });
          }} />
        <Action testId="wifi-scan" label={wifi()?.scanning ? "Scanning…" : "Scan"}
          disabled={!enabled() || !wifi()?.devices.length || (wifi()?.scanning ?? false)}
          onClick={() => void invokePublic("network.wifi.scan", {})} />
      </>
    }>
      <Show when={ethernet().length > 0}>
        <Section title="Wired">
          <For each={ethernet()} keyed={device => device.id}>
            {device => {
              const active = () => device().active_connection;
              const connected = () => Boolean(active());
              const summaryParts = () => {
                const items: string[] = [];
                if (active()) {
                  items.push(device().interface);
                  if (device().ipv4) items.push(device().ipv4!);
                  if (device().speed_mbps) items.push(`${device().speed_mbps} Mb/s`);
                } else if (device().carrier) {
                  items.push("Cable plugged", "Disconnected");
                } else {
                  items.push("Cable unplugged");
                }
                return items.join(" · ");
              };
              const preferredProfile = () => device().available_profiles?.[0];
              return (
                <Show
                  when={connected()}
                  fallback={
                    <row testId={props.outgoing ? null : `net-eth-${device().interface}`} class={cx(styles.itemCard, styles.row)}>
                      <ShellIcon name="ethernet" size={18} color={device().carrier ? primary : muted} />
                      <column class={cx(styles.grow, styles.itemTextCol)}>
                        <text class={cx(styles.clipped, styles.itemTitle)}>{device().interface}</text>
                        <text class={cx(styles.clipped, styles.detail)}>{summaryParts()}</text>
                      </column>
                      <Show when={device().carrier}>
                        <Action
                          {...(props.outgoing ? {} : { testId: `net-eth-connect-${device().interface}` })}
                          label="Connect"
                          onClick={() => void invokePublic("network.ethernet.connect", {
                            device_id: device().id,
                            ...(preferredProfile() ? { profile_id: preferredProfile()!.id } : {}),
                          })}
                        />
                      </Show>
                    </row>
                  }
                >
                  <row testId={props.outgoing ? null : `net-eth-${device().interface}`} class={cx(styles.row, styles.connectedRow)}>
                    <ShellIcon name="ethernet" size={18} color={selectedInk} />
                    <column class={cx(styles.grow, styles.itemTextCol)}>
                      <text class={cx(styles.clipped, styles.connectedTitle)}>{active()?.name || device().interface}</text>
                      <text class={cx(styles.clipped, styles.connectedSub)}>{summaryParts()}</text>
                    </column>
                    <QuickSettingsIconButton
                      testId={props.outgoing ? undefined : `net-eth-disconnect-${device().interface}`}
                      label="Disconnect"
                      icon="linkOff"
                      size={30}
                      tone="accent-subtle"
                      color={selectedInk}
                      onClick={() => void invokePublic("network.ethernet.disconnect", { device_id: device().id })}
                    />
                  </row>
                </Show>
              );
            }}
          </For>
        </Section>
      </Show>
      <Show when={activeVpn().length > 0 || availableVpnProfiles().length > 0}>
        <Section title="VPN">
          <For each={activeVpn()} keyed={conn => conn.id}>
            {conn => (
              <row testId={props.outgoing ? null : `net-vpn-active-${conn().profile_id}`} class={cx(styles.row, styles.vpnActiveRow)}>
                <ShellIcon name="shield" size={18} color={selectedInk} />
                <column class={cx(styles.grow, styles.itemTextCol)}>
                  <text class={cx(styles.clipped, styles.connectedTitle)}>{conn().name}</text>
                  <text class={cx(styles.clipped, styles.connectedSub)}>Connected</text>
                </column>
                <QuickSettingsIconButton
                  label="Disconnect VPN"
                  icon="linkOff"
                  size={30}
                  tone="accent-subtle"
                  color={selectedInk}
                  onClick={() => void invokePublic("network.vpn.disconnect", { id: conn().id })}
                />
              </row>
            )}
          </For>
          <For each={availableVpnProfiles()} keyed={prof => prof.id}>
            {prof => (
              <row testId={props.outgoing ? null : `net-vpn-profile-${prof().id}`} class={cx(styles.itemCard, styles.row)}>
                <ShellIcon name="shield" size={18} color={primary} />
                <column class={cx(styles.grow, styles.itemTextCol)}>
                  <text class={styles.clipped}>{prof().name}</text>
                  <text class={cx(styles.clipped, styles.detail)}>{prof().kind === "wireguard" ? "WireGuard" : "VPN"}</text>
                </column>
                <Action label="Connect" onClick={() => void invokePublic("network.vpn.connect", { profile_id: prof().id })} />
              </row>
            )}
          </For>
        </Section>
      </Show>
      <Show when={enabled()} fallback={<text class={cx(styles.clipped, styles.detail)}>{network.data()?.available ? "Wi-Fi is off" : "Wi-Fi is unavailable"}</text>}>
        <For each={wifi()?.devices} keyed={device => device.id} fallback={<text class={cx(styles.clipped, styles.detail)}>No Wi-Fi adapters</text>}>
          {device => {
            const active = createMemo(() => device().access_points.find(ap => ap.id === device().active_ap_id));
            return (
              <>
                <Show when={active() || device().active_connection}>
                  <Section title="Connected network">
                    <row class={cx(styles.row, styles.connectedRow)}>
                      <ShellIcon name="wifi" size={18} color={selectedInk} />
                      <column class={cx(styles.grow, styles.itemTextCol)}>
                        <text class={cx(styles.clipped, styles.connectedTitle)}>{active()?.ssid || device().active_connection?.name || "Hidden network"}</text>
                        <text class={cx(styles.clipped, styles.connectedSub)}>Connected</text>
                      </column>
                      <QuickSettingsIconButton label="Disconnect" icon="linkOff" size={30}
                        tone="accent-subtle" color={selectedInk}
                        onClick={() => void invokePublic("network.wifi.disconnect", { device_id: device().id })} />
                    </row>
                  </Section>
                </Show>
                <Section title={(wifi()?.devices.length ?? 0) > 1 ? `Available networks · ${device().interface}` : "Available networks"}>
                  <For each={device().access_points.filter(ap => ap.id !== device().active_ap_id)} keyed={ap => ap.id}
                    fallback={<text class={cx(styles.clipped, styles.detail)}>No access points found</text>}>
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
                          <Button
                            testId={props.outgoing ? null : `wifi-ap-${ap().ssid}`}
                            ariaLabel={ssid()}
                            expanded={needsPassword() ? selectedAp() === ap().id : null}
                            disabled={requiresProfile() && !savedProfile()}
                            onClick={() => {
                              const target = { device_id: device().id, ap_id: ap().id };
                              if (needsPassword()) {
                                setSelectedAp(current => (current === target.ap_id ? undefined : target.ap_id));
                              } else {
                                setSelectedAp(undefined);
                                const profile = savedProfile();
                                void invokePublic("network.wifi.connect", profile ? { ...target, profile_id: profile.id } : target);
                              }
                            }}
                            class={cx(styles.itemCard, styles.row)}
                          >
                            <ShellIcon name={ap().security === "open" ? "wifi" : "wifiLock"} size={18} color={primary} />
                            <column class={cx(styles.grow, styles.itemTextCol)}>
                              <text class={styles.clipped}>{ssid()}</text>
                              <text class={cx(styles.clipped, styles.detail)}>
                                {requiresProfile() && !savedProfile() ? `${ap().security} · Saved profile required` : `Click to connect · ${ap().security}`}
                              </text>
                            </column>
                            <text data-tabular="true" class={cx(styles.monoPercent, styles.monoPercentMuted)}>
                              {ap().strength}%
                            </text>
                            <Show when={needsPassword()}>
                              <WifiExpandChevron open={selectedAp() === ap().id} />
                            </Show>
                          </Button>
                          <M3Collapsible open={needsPassword() && selectedAp() === ap().id} estimatedHeight={104}>
                            <WifiPassword ssid={ssid()} onCancel={() => setSelectedAp(undefined)} onConnect={password => {
                              void invokeHost("network.wifi.connect", { device_id: device().id, ap_id: ap().id, password });
                              setSelectedAp(undefined);
                            }} />
                          </M3Collapsible>
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
    <column testId={`bt-dev-${dev().address}`} class={styles.btCard} data-connected={dev().connected ? "true" : "false"}>
      <row class={styles.row}>
        <ShellIcon name="bluetooth" size={18} color={dev().connected ? selectedInk : muted} />
        <column class={cx(styles.grow, styles.itemTextCol)}>
          <text class={cx(styles.clipped, styles.connectedTitle)}>{dev().name || dev().address}</text>
          <text class={cx(styles.clipped, styles.btSub)} data-connected={dev().connected ? "true" : "false"}>
            {dev().connected ? "Connected" : dev().paired ? "Click to connect" : "Click to pair"}
          </text>
        </column>
        <Show when={dev().battery != null}>
          <text data-tabular="true" class={styles.monoPercent}>
            {dev().battery}%
          </text>
        </Show>
        <Show when={dev().connected}>
          <QuickSettingsIconButton label="Disconnect" icon="linkOff" size={30}
            tone="accent-subtle" color={selectedInk}
            disabled={!powered()} onClick={() => deviceAction("disconnect")} />
        </Show>
      </row>
      <Show when={!dev().connected}>
        <row class={styles.btActions}>
          <Action label="Connect" disabled={!powered()} onClick={() => deviceAction("connect")} />
          <Show when={!dev().paired}><Action label="Pair" disabled={!powered()} onClick={() => deviceAction("pair")} /></Show>
          <Action label="Remove" onClick={() => deviceAction("remove")} />
        </row>
      </Show>
    </column>
  );
}

function BluetoothPage(props: { onBack: () => void; outgoing?: boolean | undefined }): NativeChild {
  const { bluetooth, invokePublic } = useShellStore();
  const adapter = () => bluetooth.data()?.adapters[0];
  const devices = () => bluetooth.data()?.devices ?? [];
  const pairedDevices = createMemo(() => devices().filter(device => device.connected || device.paired));
  const availableDevices = createMemo(() => devices().filter(device => !device.connected && !device.paired));

  return (
    <Page page="bluetooth" onBack={props.onBack} outgoing={props.outgoing} scanning={adapter()?.discovering ?? false} controls={
      <>
        <Toggle label="Bluetooth" checked={adapter()?.powered ?? false} disabled={!adapter()} onClick={() => {
          const device = adapter();
          if (device) void invokePublic("bluetooth.set-power", { adapter: device.path, powered: !device.powered });
        }} />
        <Action label={adapter()?.discovering ? "Stop scan" : "Scan"} checked={adapter()?.discovering ?? false}
          active={adapter()?.discovering ?? false} disabled={!adapter()?.powered} onClick={() => {
            const device = adapter();
            if (device) void invokePublic("bluetooth.set-discovery", { adapter: device.path, discovering: !device.discovering });
          }} />
      </>
    }>
      <Section title="Paired devices">
        <For each={pairedDevices()} keyed={device => device.path}
          fallback={<text class={cx(styles.clipped, styles.detail)}>{adapter() ? "No paired Bluetooth devices" : "No Bluetooth adapter"}</text>}>
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
    <M3InteractiveCard
      layout="column"
      testId={`qs-audio-${props.kind}-${props.device().index}`}
      actionTestId={`qs-audio-${props.kind}-select-${props.device().index}`}
      ariaLabel={name()}
      selected={props.active}
      onClick={() => void invokePublic("audio.set-default", target())}
      class={cx(styles.audioCard, props.active && styles.audioCardActive)}
    >
      <row class={cx(styles.row, styles.audioHeader)}>
        <ShellIcon name={props.kind === "sink" ? "volumeHigh" : "mic"} size={16} color={props.active ? selectedInk : muted} />
        <text class={cx(styles.grow, styles.clipped, props.active ? styles.audioNameActive : styles.audioName)}>{name()}</text>
      </row>
      <M3CardAction>
        <PrecisionSliderRow
          label={`${name()} volume`}
          sliderTestId={`qs-audio-${props.kind}-slider-${props.device().index}`}
          icon={props.device().muted ? "volumeMute" : props.kind === "sink" ? "volumeHigh" : "mic"}
          iconLabel={props.device().muted ? "Unmute device" : "Mute device"}
          value={props.device().volume * 100}
          disabled={!props.device().channels}
          showTrailingSlot={false}
          onIconClick={() => void invokePublic("audio.set-mute", { ...target(), muted: !props.device().muted })}
          onChange={percent => void invokePublic("audio.set-volume", { ...target(), volume: percent / 100 })}
        />
      </M3CardAction>
    </M3InteractiveCard>
  );
}

function SoundPage(props: { onBack: () => void; outgoing?: boolean | undefined }): NativeChild {
  const { audio, invokePublic } = useShellStore();
  return (
    <Page page="sound" onBack={props.onBack} outgoing={props.outgoing}>
      <Section title="Output Devices">
        <For each={audio.data()?.sinks} keyed={device => device.index} fallback={<text class={cx(styles.clipped, styles.detail)}>No output devices</text>}>
          {sink => <AudioDeviceRow device={sink} kind="sink" active={sink().name === audio.data()?.default_sink} />}
        </For>
      </Section>
      <Section title="Input Devices">
        <For each={audio.data()?.sources} keyed={device => device.index} fallback={<text class={cx(styles.clipped, styles.detail)}>No input devices</text>}>
          {source => <AudioDeviceRow device={source} kind="source" active={source().name === audio.data()?.default_source} />}
        </For>
      </Section>
      <Section title="Applications">
        <For each={audio.data()?.sink_inputs} keyed={stream => stream.index} fallback={<text class={cx(styles.clipped, styles.detail)}>No playback streams</text>}>
          {app => (
            <column class={styles.appStreamCard}>
              <text class={cx(styles.clipped, styles.itemTitle)}>{app().application || app().name || "Unknown application"}</text>
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

export function QuickSettingsSubpage(props: { readonly page: Subpage; readonly onBack: () => void; readonly outgoing?: boolean | undefined }): NativeChild {
  return (
    <Switch>
      <Match when={props.page === "wifi"}><WifiPage onBack={props.onBack} outgoing={props.outgoing} /></Match>
      <Match when={props.page === "bluetooth"}><BluetoothPage onBack={props.onBack} outgoing={props.outgoing} /></Match>
      <Match when={props.page === "sound"}><SoundPage onBack={props.onBack} outgoing={props.outgoing} /></Match>
      <Match when={props.page === "battery"}><BatterySubpage onBack={props.onBack} outgoing={props.outgoing} /></Match>
    </Switch>
  );
}
