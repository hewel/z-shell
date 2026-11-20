import { Button, For, Image, Match, Show, Switch, TextField, createEffect, createMemo, createSignal, type Accessor, type NativeChild } from "@hewel/zgui";
import { useDaemonMedia } from "@z-shell/sdk/zgui";
import { ShojiIcon, type ShojiIconName } from "../icons.tsx";
import { useShellStore } from "../store.ts";
import { resolveMonitorWallpaper, type AudioDevice, type CatalogEntry, type WallpaperFit, type WallpaperListResponse } from "../topics.ts";
import type { QuickSettingsPage } from "./QuickSettingsPanel.tsx";

type Subpage = Exclude<QuickSettingsPage, "main">;

const titles: Record<Subpage, string> = {
  wifi: "Wi-Fi", bluetooth: "Bluetooth", sound: "Sound", wallpaper: "Wallpaper", settings: "Settings",
};
const primary = "var(--color-primary)";
const onSurface = "var(--color-on-surface)";
const muted = "var(--color-on-surface-variant)";
const container = "var(--color-surface-container)";
const containerHigh = "var(--color-surface-container-high)";
const selectedFill = "var(--color-primary-container)";
const selectedInk = "var(--color-on-primary-container)";
const row = { display: "flex", flexDirection: "row", alignItems: "center", gap: "8px" } as const;
const pills = { alignItems: "center", gap: "6px", flexWrap: "wrap" } as const;
const grow = { flexGrow: 1, flexBasis: "0px", minWidth: "0px" } as const;
const clipped = { minWidth: "0px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } as const;
const detail = { ...clipped, color: muted, fontSize: "12px" } as const;
const card = { borderRadius: "20px", backgroundColor: container, padding: "12px", gap: "8px" } as const;
const itemCard = { borderRadius: "12px", backgroundColor: containerHigh, padding: "8px", gap: "6px" } as const;
const thumbImage = { width: "108px", maxWidth: "100%", height: "68px", borderRadius: "12px", "object-fit": "cover" } as const;

export function QuickSettingsScroll(props: { testId: string; label: string; children: NativeChild }): NativeChild {
  return (
    <scroll testId={props.testId} role="scrollView" ariaLabel={props.label} style={{ width: "100%", height: "100%", minHeight: "0px",
      overflow: "auto", backgroundColor: "var(--color-surface)", color: onSurface, fontFamily: "system-ui", fontSize: "13px" }}>
      <column style={{ padding: "16px", gap: "12px", flexDirection: "column" }}>{props.children}</column>
    </scroll>
  );
}

export function QuickSettingsIconButton(props: {
  label: string; icon: ShojiIconName; testId?: string; color?: string; fill?: string;
  disabled?: boolean; expanded?: boolean; onClick: () => void;
}): NativeChild {
  return (
    <Button testId={props.testId} ariaLabel={props.label} disabled={props.disabled} expanded={props.expanded}
      onClick={props.onClick} style={{ display: "flex", width: "34px", height: "34px", borderRadius: "17px", flexShrink: 0,
        alignItems: "center", justifyContent: "center", backgroundColor: props.fill ?? container, opacity: props.disabled ? 0.45 : 1 }}>
      <ShojiIcon name={props.icon} size={16} color={props.color} />
    </Button>
  );
}

function Action(props: {
  label: string; testId?: string; ariaLabel?: string; active?: boolean; disabled?: boolean;
  checked?: boolean; onClick: () => void;
}): NativeChild {
  return (
    <Button testId={props.testId} ariaLabel={props.ariaLabel ?? props.label} checked={props.checked} disabled={props.disabled}
      onClick={props.onClick} style={{ display: "flex", minHeight: "30px", padding: "0 9px", borderRadius: "15px",
        flexShrink: 0, alignItems: "center", justifyContent: "center", fontSize: "12px", opacity: props.disabled ? 0.45 : 1,
        backgroundColor: props.active ? selectedFill : containerHigh, color: props.active ? selectedInk : onSurface }}>
      {props.label}
    </Button>
  );
}

function Toggle(props: { label: string; checked: boolean; disabled?: boolean; onClick: () => void }): NativeChild {
  return (
    <control role="switch" tabIndex={props.disabled ? -1 : 0} ariaLabel={props.label} checked={props.checked}
      disabled={props.disabled} onClick={props.onClick} style={{ ...row, padding: "4px 8px", borderRadius: "16px",
        flexShrink: 0, minHeight: "30px", backgroundColor: container, opacity: props.disabled ? 0.45 : 1 }}>
      <text style={{ fontSize: "12px" }}>{props.label}</text>
      <row ariaHidden style={{ width: "28px", height: "16px", borderRadius: "8px", padding: "2px", alignItems: "center",
        justifyContent: props.checked ? "flex-end" : "flex-start", backgroundColor: props.checked ? primary : "var(--color-outline-variant)" }}>
        <box style={{ width: "12px", height: "12px", borderRadius: "6px", backgroundColor: props.checked ? "var(--color-on-primary)" : muted }} />
      </row>
    </control>
  );
}

function Section(props: { title: string; children: NativeChild }): NativeChild {
  return (
    <column style={card}>
      <text role="heading" style={{ fontSize: "14px", fontWeight: "600" }}>{props.title}</text>
      {props.children}
    </column>
  );
}

function Page(props: { page: Subpage; onBack: () => void; controls?: NativeChild; children: NativeChild }): NativeChild {
  return (
    <QuickSettingsScroll testId={`qs-page-${props.page}`} label={titles[props.page]}>
      <row style={row}>
        <QuickSettingsIconButton testId="qs-back" label="Back" icon="arrowLeft" onClick={props.onBack} />
        <text role="heading" style={{ ...grow, ...clipped, fontSize: "18px", fontWeight: "600" }}>{titles[props.page]}</text>
        {props.controls}
      </row>
      {props.children}
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
        value={password()} onInput={event => setPassword(event.value)} style={{ minHeight: "34px", padding: "0 8px",
          borderRadius: "8px", backgroundColor: "var(--color-surface)", color: onSurface }} />
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
    <Page page="wifi" onBack={props.onBack} controls={
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
                    <row style={row}>
                      <ShojiIcon name="wifi" size={18} color={primary} />
                      <text style={{ ...grow, ...clipped }}>{active()?.ssid || device().active_connection?.name || "Hidden network"}</text>
                      <Action label="Disconnect" onClick={() => void invokePublic("network.wifi.disconnect", { device_id: device().id })} />
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
                            <ShojiIcon name={ap().security === "open" ? "wifi" : "wifiLock"} size={18} color={primary} />
                            <column style={{ ...grow, gap: "2px" }}>
                              <text style={clipped}>{ssid()}</text>
                              <text style={detail}>{ap().security}{requiresProfile() && !savedProfile() ? " · Saved profile required" : ""}</text>
                            </column>
                            <text style={detail}>{ap().strength}%</text>
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

function BluetoothPage(props: { onBack: () => void }): NativeChild {
  const { bluetooth, invokePublic } = useShellStore();
  const adapter = () => bluetooth.data()?.adapters[0];
  return (
    <Page page="bluetooth" onBack={props.onBack} controls={
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
      <Section title="Devices">
        <For each={bluetooth.data()?.devices} keyed={device => device.path}
          fallback={<text style={detail}>{adapter() ? "No Bluetooth devices" : "No Bluetooth adapter"}</text>}>
          {dev => {
            const powered = () => bluetooth.data()?.adapters.some(candidate => candidate.path === dev().adapter && candidate.powered);
            const deviceAction = (action: string) => { void invokePublic(`bluetooth.${action}`, { device: dev().path }); };
            return (
              <column testId={`bt-dev-${dev().address}`} style={itemCard}>
                <row style={row}>
                  <ShojiIcon name="bluetooth" size={18} color={primary} />
                  <column style={{ ...grow, gap: "2px" }}>
                    <text style={clipped}>{dev().name || dev().address}</text>
                    <Show when={dev().name}><text style={detail}>{dev().address}</text></Show>
                  </column>
                  <Show when={dev().battery != null}><text style={detail}>{dev().battery}%</text></Show>
                  <Show when={dev().connected || dev().paired}>
                    <text style={{ borderRadius: "10px", padding: "3px 7px", fontSize: "11px", backgroundColor: selectedFill,
                      color: selectedInk }}>{dev().connected ? "Connected" : "Paired"}</text>
                  </Show>
                </row>
                <row style={{ ...pills, justifyContent: "flex-end" }}>
                  <Action label={dev().connected ? "Disconnect" : "Connect"} disabled={!powered()}
                    onClick={() => deviceAction(dev().connected ? "disconnect" : "connect")} />
                  <Show when={!dev().paired}><Action label="Pair" disabled={!powered()} onClick={() => deviceAction("pair")} /></Show>
                  <Action label="Remove" onClick={() => deviceAction("remove")} />
                </row>
              </column>
            );
          }}
        </For>
      </Section>
    </Page>
  );
}

function VolumeSteps(props: { value: number | null; disabled?: boolean; onChange: (volume: number) => void }): NativeChild {
  const step = (delta: number) => {
    const volume = props.value;
    if (volume != null) props.onChange(Math.max(0, Math.min(1, Math.round((volume + delta) * 100) / 100)));
  };
  return (
    <>
      <Action label="-" ariaLabel="Decrease volume" disabled={props.disabled || props.value == null || props.value <= 0} onClick={() => step(-0.05)} />
      <row style={{ minWidth: "32px", justifyContent: "center" }}>
        <text style={detail}>{props.value == null ? "—" : `${Math.round(props.value * 100)}%`}</text>
      </row>
      <Action label="+" ariaLabel="Increase volume" disabled={props.disabled || props.value == null || props.value >= 1} onClick={() => step(0.05)} />
    </>
  );
}

function AudioDeviceRow(props: { device: Accessor<AudioDevice>; kind: "sink" | "source"; active: boolean }): NativeChild {
  const { invokePublic } = useShellStore();
  const target = () => ({ kind: props.kind, index: props.device().index });
  const name = () => props.device().description || props.device().name;
  return (
    <row style={{ ...itemCard, ...row, backgroundColor: props.active ? selectedFill : containerHigh }}>
      <Button ariaLabel={name()} selected={props.active} onClick={() => void invokePublic("audio.set-default", target())}
        style={{ ...grow, ...row, minHeight: "34px", color: props.active ? selectedInk : onSurface }}>
        <ShojiIcon name={props.kind === "sink" ? "volumeHigh" : "mic"} color={props.active ? selectedInk : primary} />
        <text style={{ ...grow, ...clipped }}>{name()}</text>
      </Button>
      <QuickSettingsIconButton label={props.device().muted ? "Unmute device" : "Mute device"}
        icon={props.device().muted ? "volumeMute" : props.kind === "sink" ? "volumeHigh" : "mic"}
        onClick={() => void invokePublic("audio.set-mute", { ...target(), muted: !props.device().muted })} />
      <Show when={props.kind === "sink"}>
        <VolumeSteps value={props.device().volume} disabled={!props.device().channels}
          onChange={volume => void invokePublic("audio.set-volume", { ...target(), volume })} />
      </Show>
    </row>
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
            <row style={{ ...itemCard, ...row }}>
              <text style={{ ...grow, ...clipped }}>{app().application || app().name || "Unknown application"}</text>
              <QuickSettingsIconButton label={app().muted ? "Unmute application" : "Mute application"} icon={app().muted ? "volumeMute" : "volumeHigh"}
                onClick={() => void invokePublic("audio.set-app-mute", { index: app().index, muted: !app().muted })} />
              <VolumeSteps value={app().volume} disabled={!app().volume_writable}
                onChange={volume => void invokePublic("audio.set-app-volume", { index: app().index, volume })} />
            </row>
          )}
        </For>
      </Section>
    </Page>
  );
}

function WallpaperThumbnail(props: { item: Accessor<CatalogEntry>; active: boolean; onClick: () => void }): NativeChild {
  const { hostClient } = useShellStore();
  const image = useDaemonMedia(hostClient, () => props.item().thumbnail, { fetchCommand: "wallpaper.fetch-blob" });
  return (
    <Button testId={`wp-thumb-${props.item().id}`} ariaLabel={props.item().name} selected={props.active}
      onClick={props.onClick} style={{ ...grow, display: "flex", maxWidth: "112px", height: "72px", borderRadius: "14px",
        border: `2px solid ${props.active ? primary : "var(--color-outline-variant)"}`, backgroundColor: containerHigh,
        justifyContent: "center", alignItems: "center", position: "relative", overflow: "hidden" }}>
      <Show when={image.src()} fallback={<ShojiIcon name="image" size={20} color={muted} />}>
        {src => <Image ariaHidden src={src()} style={thumbImage} />}
      </Show>
      <Show when={props.active}>
        <box ariaHidden style={{ position: "absolute", right: "4px", top: "4px", width: "20px", height: "20px", borderRadius: "10px",
          display: "flex", alignItems: "center", justifyContent: "center", backgroundColor: primary }}>
          <ShojiIcon name="check" size={14} color="var(--color-on-primary)" />
        </box>
      </Show>
    </Button>
  );
}

const fits: readonly WallpaperFit[] = ["cover", "contain", "fill", "center"];
const wallpaperActions = [
  { command: "wallpaper.previous", label: "Previous" }, { command: "wallpaper.next", label: "Next" },
  { command: "wallpaper.random", label: "Random" }, { command: "wallpaper.rescan", label: "Rescan" },
  { command: "wallpaper.clear", label: "Clear" },
] as const;

function WallpaperPage(props: { onBack: () => void }): NativeChild {
  const { publicClient, monitors, wallpaper, invokePublic } = useShellStore();
  const [catalog, setCatalog] = createSignal<WallpaperListResponse>();
  const [catalogFailed, setCatalogFailed] = createSignal(false);
  const [scanRevision, setScanRevision] = createSignal(0);
  const [output, setOutput] = createSignal<string | null>(null);
  const [fit, setFit] = createSignal<WallpaperFit>();
  const selectedOutput = () => {
    const name = output();
    return name !== null && monitors().some(monitor => monitor.name === name) ? name : null;
  };
  const active = () => {
    const name = selectedOutput();
    const snapshot = wallpaper.data();
    return name === null ? snapshot?.current : resolveMonitorWallpaper(snapshot, name);
  };
  const selectedFit = () => fit() ?? active()?.fit ?? wallpaper.data()?.fit ?? "cover";
  const rows = createMemo(() => {
    const entries = catalog()?.items;
    const result: (readonly CatalogEntry[])[] = [];
    if (entries) for (let index = 0; index < entries.length; index += 3) result.push(entries.slice(index, index + 3));
    return result;
  });

  createEffect(() => [publicClient(), scanRevision()] as const, ([client]) => {
    if (!client) return;
    let live = true;
    setCatalogFailed(false);
    void invokePublic("wallpaper.list", { offset: 0, limit: 24 }).then(result => {
      if (!live) return;
      const data = result?.data as WallpaperListResponse | undefined;
      if (data) setCatalog(data);
      else setCatalogFailed(true);
    });
    return () => { live = false; };
  });

  return (
    <Page page="wallpaper" onBack={props.onBack}>
      <Section title="Output">
        <row style={pills}>
          <Action label="All" active={selectedOutput() === null} checked={selectedOutput() === null} onClick={() => { setOutput(null); setFit(undefined); }} />
          <For each={monitors()} keyed={monitor => monitor.id}>
            {monitor => <Action label={monitor().name} active={selectedOutput() === monitor().name} checked={selectedOutput() === monitor().name}
              onClick={() => { setOutput(monitor().name); setFit(undefined); }} />}
          </For>
        </row>
        <row style={pills}>
          <For each={wallpaperActions} keyed={action => action.command}>
            {action => <Action label={action().label} onClick={() => {
              const command = action().command;
              if (command === "wallpaper.rescan") {
                void invokePublic(command, {}).then(result => { if (result) setScanRevision(revision => revision + 1); });
              } else {
                void invokePublic(command, { output: selectedOutput() });
              }
            }} />}
          </For>
        </row>
      </Section>
      <Section title="Fit">
        <row style={pills}>
          <For each={fits} keyed={mode => mode}>
            {mode => <Action label={mode()} checked={selectedFit() === mode()} active={selectedFit() === mode()} onClick={() => setFit(mode())} />}
          </For>
        </row>
      </Section>
      <For each={rows()} keyed={entries => entries[0]?.id} fallback={
        <text style={detail}>{catalogFailed() ? "Could not load wallpapers" : catalog() ? "No wallpapers found" : "Loading wallpapers…"}</text>
      }>
        {entries => (
          <row style={{ gap: "6px" }}>
            <For each={entries()} keyed={item => item.id}>
              {item => <WallpaperThumbnail item={item} active={item().source_path === active()?.source_path} onClick={() => {
                void invokePublic("wallpaper.set", { path: item().source_path, output: selectedOutput(), fit: selectedFit() });
              }} />}
            </For>
          </row>
        )}
      </For>
    </Page>
  );
}

const seeds = ["#A6C8FF", "#D0BCFF", "#7DD3FC", "#86EFAC", "#FCD34D", "#FCA5A5"] as const;
const variants = ["tonal", "vibrant", "expressive", "fidelity", "neutral", "mono"] as const;
const modes = [{ mode: "light", label: "Light" }, { mode: "auto", label: "Auto" }, { mode: "dark", label: "Dark" }] as const;
const idleActions = { lock: "Lock", screen_off: "Screen off", suspend: "Suspend", lock_and_suspend: "Lock and suspend" } as const;

function SettingsPage(props: { onBack: () => void }): NativeChild {
  const { theme, power, idle, invokePublic } = useShellStore();
  const status = () => {
    const service = idle.data()?.service_status;
    return service?.status === "unavailable" ? `Unavailable · ${service.reason}` : service?.status ?? "Unknown";
  };
  const caffeine = () => idle.data()?.caffeine ?? false;
  return (
    <Page page="settings" onBack={props.onBack}>
      <Section title="Theme & Color">
        <row style={pills}>
          <For each={seeds} keyed={seed => seed}>
            {seed => (
              <Button ariaLabel={`Set seed color ${seed()}`} onClick={() => void invokePublic("theme.set", { seed: seed() })}
                style={{ width: "26px", height: "26px", borderRadius: "13px", backgroundColor: seed(), flexShrink: 0 }} />
            )}
          </For>
        </row>
        <row style={pills}>
          <For each={variants} keyed={variant => variant}>
            {variant => <Action label={variant()} checked={theme.data()?.variant === variant()} active={theme.data()?.variant === variant()}
              onClick={() => void invokePublic("theme.set", { variant: variant() })} />}
          </For>
        </row>
        <row style={pills}>
          <For each={modes} keyed={item => item.mode}>
            {item => <Action label={item().label} onClick={() => void invokePublic("theme.set", { mode: item().mode })} />}
          </For>
          <Action label="Retry" onClick={() => void invokePublic("theme.retry", {})} />
        </row>
        <Show when={theme.data()?.last_error}>
          {error => <text style={{ color: "var(--color-error)", fontSize: "12px" }}>{error()}</text>}
        </Show>
      </Section>
      <Section title="Power Profiles">
        <row style={pills}>
          <For each={power.data()?.profiles.profiles} keyed={profile => profile} fallback={<text style={detail}>No power profiles available</text>}>
            {profile => <Action label={profile()} checked={power.data()?.profiles.active_profile === profile()}
              active={power.data()?.profiles.active_profile === profile()} onClick={() => void invokePublic("power.set-profile", { profile: profile() })} />}
          </For>
        </row>
      </Section>
      <Section title="Idle & Sleep">
        <row style={row}>
          <text style={{ ...grow, color: muted, fontSize: "12px" }}>{status()}</text>
          <Toggle label="Caffeine" checked={caffeine()} onClick={() => void invokePublic("idle.caffeine", { enabled: !caffeine() })} />
        </row>
        <text style={{ fontWeight: "600" }}>Active inhibitors</text>
        <For each={idle.data()?.active_inhibitors} keyed={false} fallback={<text style={detail}>No active inhibitors</text>}>
          {inhibitor => <text style={detail}>{inhibitor().reason || inhibitor().source.source.replaceAll("_", " ")} · {inhibitor().scope}</text>}
        </For>
        <text style={{ fontWeight: "600" }}>Idle rules</text>
        <For each={idle.data()?.rules} keyed={rule => rule.name} fallback={<text style={detail}>No idle rules configured</text>}>
          {rule => {
            const action = () => {
              const value = rule().action;
              return typeof value === "string" ? idleActions[value] : "Custom command";
            };
            return (
              <column style={itemCard}>
                <text style={clipped}>{rule().name}{rule().enabled ? "" : " · Disabled"}</text>
                <text style={detail}>{rule().timeout_seconds}s · {action()}</text>
              </column>
            );
          }}
        </For>
      </Section>
      <Section title="Config">
        <row style={pills}><Action testId="qs-reload-settings" label="Reload settings.toml" onClick={() => void invokePublic("settings.reload", {})} /></row>
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
      <Match when={props.page === "wallpaper"}><WallpaperPage onBack={props.onBack} /></Match>
      <Match when={props.page === "settings"}><SettingsPage onBack={props.onBack} /></Match>
    </Switch>
  );
}
