import { Button, For, Image, Show, createSignal, focus, getWindowRect, type NativeChild } from "@hewel/zgui";
import { useDaemonMedia } from "@z-shell/sdk/zgui";
import { ShellIcon, type ShellIconName } from "../icons.tsx";
import { useShellStore } from "../store.ts";
import { formatDurationSeconds, type BatteryState, type PowerConfirmAction } from "../topics.ts";
import { QuickSettingsIconButton, QuickSettingsScroll, QuickSettingsSubpage } from "./QuickSettingsSubpages.tsx";

export type QuickSettingsPage = "main" | "wifi" | "bluetooth" | "sound" | "wallpaper" | "settings";

const primary = "var(--color-primary)";
const onPrimary = "var(--color-on-primary)";
const primaryContainer = "var(--color-primary-container)";
const onPrimaryContainer = "var(--color-on-primary-container)";
const onSurface = "var(--color-on-surface)";
const muted = "var(--color-on-surface-variant)";
const container = "var(--color-surface-container)";
const containerHigh = "var(--color-surface-container-high)";
const card = { borderRadius: "16px", backgroundColor: container, padding: "12px", gap: "10px" } as const;
const row = { alignItems: "center", gap: "8px" } as const;
const grow = { flexGrow: 1, flexBasis: "0px", minWidth: "0px" } as const;
const clipped = { minWidth: "0px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } as const;
const hiddenSection = { display: "none" } as const;
const avatarStyle = { width: "36px", height: "36px", borderRadius: "999px", flexShrink: 0, "object-fit": "cover" } as const;

const powerActions = [
  { label: "Lock", icon: "lock", action: "lock" },
  { label: "Log out", icon: "logout", action: "logout" },
  { label: "Suspend", icon: "sleep", action: "suspend" },
  { label: "Reboot", icon: "reboot", action: "reboot" },
  { label: "Power off", icon: "power", action: "poweroff", danger: true },
] as const satisfies readonly {
  label: string; icon: ShellIconName; action: PowerConfirmAction; danger?: boolean;
}[];

const batteryLabels: Readonly<Record<BatteryState, string>> = {
  unknown: "Unknown", charging: "Charging", discharging: "Discharging", full: "Full",
  pending_charge: "Pending charge", pending_discharge: "Pending discharge",
};

function QuickTile(props: {
  id: string;
  label: string;
  detail: string;
  icon: ShellIconName;
  active?: boolean;
  toggle?: boolean;
  disabled?: boolean;
  onClick: () => void;
  open?: () => void;
}): NativeChild {
  const color = () => props.active ? onPrimaryContainer : onSurface;
  return (
    <row data-qs-tile="true" style={{ ...grow, height: "50px", borderRadius: "14px", alignItems: "center",
      backgroundColor: props.active ? primaryContainer : containerHigh,
      border: props.active ? "1px solid color-mix(in srgb, var(--color-primary) 30%, transparent)" : "1px solid transparent" }}>
      <Button testId={`qs-tile-${props.id}`} ariaLabel={props.label} checked={props.toggle ? props.active ?? false : null}
        disabled={props.disabled ?? false} onClick={props.onClick} style={{
          ...row, ...grow, display: "flex", flexDirection: "row", height: "100%", borderRadius: "14px",
          padding: props.open ? "0 0 0 10px" : "0 10px",
          color: color(), opacity: props.disabled ? 0.55 : 1,
        }}>
        <ShellIcon name={props.icon} size={18} color={color()} />
        <column style={{ ...grow, gap: "2px" }}>
          <text style={{ ...clipped, fontSize: "13px", fontWeight: "600" }}>{props.label}</text>
          <text style={{ ...clipped, fontSize: "11px", color: props.active ? onPrimaryContainer : muted, opacity: props.active ? 0.78 : 1 }}>{props.detail}</text>
        </column>
      </Button>
      <Show when={props.open !== undefined} fallback={<box style={hiddenSection} />}>
        <QuickSettingsIconButton testId={`qs-open-${props.id}`} label={`Open ${props.label}`} icon="chevronRight"
          fill={props.active ? "color-mix(in srgb, var(--color-primary) 18%, transparent)" : "var(--color-surface-container-highest)"}
          color={props.active ? onPrimaryContainer : onSurface}
          onClick={() => props.open?.()} />
        <box style={{ width: "6px", flexShrink: 0 }} />
      </Show>
    </row>
  );
}

const clampPercent = (value: number) => Math.max(0, Math.min(100, value));

function PercentTrack(props: {
  label: string;
  value: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}): NativeChild {
  const value = () => clampPercent(props.value);
  const change = (next: number) => {
    const percent = clampPercent(Math.round(next));
    if (percent !== props.value) props.onChange(percent);
  };
  return (
    <>
      <box role="slider" tabIndex={props.disabled ? -1 : 0} disabled={props.disabled ?? false} ariaLabel={props.label}
        ariaValueMin={0} ariaValueMax={100} ariaValueNow={value()} ariaValueStep={5}
        onPointerDown={event => {
          if (props.disabled || !event.primary || !(event.button === "primary" || (event.button === null && event.pointerKind !== "mouse"))) return;
          const rect = getWindowRect(event.currentTarget);
          if (!rect || rect.width <= 0) return;
          focus(event.currentTarget);
          change((event.position.x - rect.x) * 100 / rect.width);
        }}
        onWheel={event => {
          if (props.disabled) return;
          const delta = event.delta.y || event.delta.x;
          if (!delta) return;
          event.preventDefault();
          change(value() - Math.sign(delta) * 5);
        }}
        onKeyDown={event => {
          if (props.disabled) return;
          switch (event.key) {
            case "ArrowUp": case "ArrowRight": change(value() + 5); break;
            case "ArrowDown": case "ArrowLeft": change(value() - 5); break;
            case "Home": change(0); break;
            case "End": change(100); break;
            default: return;
          }
          event.preventDefault();
        }}
        style={{ ...grow, display: "flex", flexDirection: "column", height: "26px", justifyContent: "center", opacity: props.disabled ? 0.5 : 1 }}>
        <box ariaHidden style={{ width: "100%", height: "12px", borderRadius: "6px", backgroundColor: containerHigh }}>
          <box data-percent-fill="true" style={{ width: `${value()}%`, height: "100%", borderRadius: "6px", backgroundColor: primary }} />
        </box>
      </box>
      <row style={{ width: "36px", flexShrink: 0, justifyContent: "flex-end" }}>
        <text style={{ fontFamily: "var(--font-mono)", fontSize: "11px", color: muted }}>{Math.round(props.value)}%</text>
      </row>
    </>
  );
}

function Sliders(props: { openSound: () => void }): NativeChild {
  const { audio, brightness, invokePublic } = useShellStore();
  const sink = () => {
    const snapshot = audio.data();
    return snapshot?.sinks.find(device => device.name === snapshot.default_sink);
  };
  const backlight = () => {
    const devices = brightness.data()?.devices;
    return devices?.find(device => device.controllable && device.max_brightness > 0) ?? devices?.[0];
  };
  return (
    <column style={card}>
      <row style={row}>
        <QuickSettingsIconButton label={sink()?.muted ? "Unmute output" : "Mute output"}
          icon={sink()?.muted ? "volumeMute" : "volumeHigh"} disabled={!sink()} onClick={() => {
            const device = sink();
            if (device) void invokePublic("audio.set-mute", { kind: "sink", index: device.index, muted: !device.muted });
          }} />
        <PercentTrack label="Volume" value={(sink()?.volume ?? 0) * 100} disabled={!sink()?.channels} onChange={percent => {
          const device = sink();
          if (device) void invokePublic("audio.set-volume", { kind: "sink", index: device.index, volume: percent / 100 });
        }} />
        <QuickSettingsIconButton testId="qs-open-sound" label="Open sound mixer" icon="chevronRight" onClick={props.openSound} />
      </row>
      <Show when={backlight()} fallback={<box style={hiddenSection} />}>
        {device => (
          <row style={row}>
            <row style={{ width: "34px", justifyContent: "center", flexShrink: 0 }}><ShellIcon name="brightness" size={18} /></row>
            <PercentTrack label="Brightness" value={device().max_brightness > 0 ? device().brightness * 100 / device().max_brightness : 0}
              disabled={!device().controllable || device().max_brightness <= 0} onChange={percent => {
                const { device: id, max_brightness } = device();
                void invokePublic("brightness.set", { device: id, value: Math.round(percent * max_brightness / 100) });
              }} />
            <box style={{ width: "34px", flexShrink: 0 }} />
          </row>
        )}
      </Show>
    </column>
  );
}

function BatterySummary(): NativeChild {
  const { power } = useShellStore();
  return (
    <Show when={power.data()?.battery} fallback={<box style={hiddenSection} />}>
      {battery => {
        const charging = () => battery().state === "charging" || battery().state === "pending_charge";
        const duration = () => formatDurationSeconds(charging() ? battery().time_to_full_seconds : battery().time_to_empty_seconds);
        return (
          <column style={card}>
            <row style={row}>
              <ShellIcon name={charging() ? "batteryCharging" : "battery"} size={20} color={primary} />
              <text style={{ fontSize: "20px", fontWeight: "600" }}>
                {battery().percentage == null ? "—" : `${Math.round(battery().percentage ?? 0)}%`}
              </text>
              <text style={{ ...grow, fontSize: "12px", color: muted }}>{duration()}</text>
              <text style={{ borderRadius: "10px", padding: "4px 8px", fontSize: "11px", backgroundColor: "var(--color-secondary-container)",
                color: "var(--color-on-secondary-container)" }}>{batteryLabels[battery().state]}</text>
            </row>
            <row style={{ gap: "6px" }}>
              <BatteryChip label="Power" value={battery().energy_rate_watts?.toFixed(1)} unit=" W" />
              <BatteryChip label="Health" value={battery().capacity_percent?.toFixed(0)} unit="%" />
              <BatteryChip label="Cycles" value={battery().charge_cycles?.toString()} />
            </row>
          </column>
        );
      }}
    </Show>
  );
}

function BatteryChip(props: { label: string; value?: string | undefined; unit?: string | undefined }): NativeChild {
  return (
    <column style={{ ...grow, gap: "2px", borderRadius: "10px", padding: "6px 8px", backgroundColor: containerHigh }}>
      <text style={{ fontSize: "11px", color: muted }}>{props.label}</text>
      <text style={{ fontSize: "13px", fontWeight: "600" }}>{props.value === undefined ? "—" : `${props.value}${props.unit ?? ""}`}</text>
    </column>
  );
}

function RecentNotifications(): NativeChild {
  const { notifications, invokePublic } = useShellStore();
  const history = () => notifications.data()?.history;
  return (
    <column style={card}>
      <row style={row}>
        <text role="heading" style={{ ...grow, fontSize: "14px", fontWeight: "600" }}>Notifications</text>
        <Button disabled={!history()?.length} onClick={() => void invokePublic("notifications.clear", {})}
          style={{ padding: "5px 9px", borderRadius: "10px", backgroundColor: containerHigh, color: primary, fontSize: "12px" }}>
          Clear all
        </Button>
      </row>
      <For each={history()?.slice(0, 3)} keyed={item => item.id}
        fallback={<text style={{ fontSize: "12px", color: muted }}>No recent notifications</text>}>
        {item => (
          <row style={{ ...row, backgroundColor: containerHigh, borderRadius: "10px", padding: "6px 8px" }}>
            <column style={{ ...grow, gap: "2px" }}>
              <text style={{ ...clipped, fontSize: "13px", fontWeight: "600" }}>{item().summary || item().app_name}</text>
              <text style={{ ...clipped, fontSize: "11px", color: muted }}>{item().body || item().app_name}</text>
            </column>
            <QuickSettingsIconButton label={`Dismiss ${item().summary || item().app_name}`} icon="close"
              onClick={() => void invokePublic("notifications.dismiss", { id: item().id })} />
          </row>
        )}
      </For>
    </column>
  );
}

function MainPage(props: {
  navigate: (page: QuickSettingsPage) => void;
  powerMenuOpen: boolean;
  togglePowerMenu: () => void;
  closePowerMenu: () => void;
}): NativeChild {
  const { user, hostClient, network, bluetooth, notifications, idle, power, wallpaper,
    invokePublic, togglePanel, closePanels, requestPowerDialog } = useShellStore();
  const avatar = useDaemonMedia(hostClient, () => user.data()?.avatar, { fetchCommand: "user.fetch-blob" });
  const name = () => user.data()?.display_name ?? user.data()?.username ?? "User";
  const wifi = () => network.data()?.wifi;
  const activeWifi = () => wifi()?.devices.find(device => device.active_ap_id !== null || device.active_connection !== null);
  const wifiName = () => {
    const device = activeWifi();
    return device?.access_points.find(ap => ap.id === device.active_ap_id)?.ssid || device?.active_connection?.name;
  };
  const adapter = () => bluetooth.data()?.adapters[0];
  const connectedBluetooth = () => bluetooth.data()?.devices.find(device => device.connected && device.adapter === adapter()?.path);
  const caffeine = () => idle.data()?.caffeine ?? false;
  const ruleCount = () => idle.data()?.rules.length ?? 0;
  const profiles = () => power.data()?.profiles;
  const cycleProfile = () => {
    const current = profiles();
    if (!current?.profiles.length) return;
    const index = current.active_profile === null ? -1 : current.profiles.indexOf(current.active_profile);
    void invokePublic("power.set-profile", { profile: current.profiles[(index + 1) % current.profiles.length] });
  };

  return (
    <QuickSettingsScroll testId="qs-main" label="Quick settings">
      <row style={row}>
        <Show when={avatar.src()} fallback={
          <box ariaHidden style={{ ...avatarStyle, display: "flex", alignItems: "center", justifyContent: "center",
            backgroundColor: "var(--color-primary-container)", color: "var(--color-on-primary-container)", fontWeight: "600" }}>
            <text>{Array.from(name().trim())[0]?.toUpperCase() || "U"}</text>
          </box>
        }>
          {src => <Image ariaHidden src={src()} style={avatarStyle} />}
        </Show>
        <column style={{ ...grow, gap: "2px" }}>
          <text style={{ ...clipped, fontSize: "15px", fontWeight: "600" }}>{name()}</text>
          <text style={{ fontSize: "11px", color: muted }}>z-shell</text>
        </column>
        <QuickSettingsIconButton testId="qs-open-clipboard" label="Open clipboard" icon="copy" onClick={() => togglePanel("clipboard")} />
        <QuickSettingsIconButton testId="qs-open-settings" label="Open settings" icon="settings" onClick={() => props.navigate("settings")} />
        <QuickSettingsIconButton testId="qs-power-toggle" label="Power menu" icon="power" fill={primary} color={onPrimary}
          expanded={props.powerMenuOpen} onClick={props.togglePowerMenu} />
      </row>
      <Show when={props.powerMenuOpen} fallback={<box style={hiddenSection} />}>
        <row testId="qs-power-menu" style={{ ...card, gap: "4px" }}>
          <For each={powerActions} keyed={entry => entry.action}>
            {action => {
              const danger = () => "danger" in action();
              const color = () => danger() ? "var(--color-on-error-container)" : onSurface;
              return (
                <Button ariaLabel={action().label} onClick={() => {
                  const selected = action().action;
                  props.closePowerMenu();
                  if (selected === "lock") {
                    void invokePublic("lock.request", {});
                    closePanels();
                  } else {
                    requestPowerDialog(selected);
                  }
                }} style={{ ...grow, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "4px",
                  padding: "6px 2px", borderRadius: "10px", backgroundColor: danger() ? "var(--color-error-container)" : containerHigh,
                  color: color(), fontSize: "11px" }}>
                  <ShellIcon name={action().icon} size={16} color={color()} />
                  <text style={{ whiteSpace: "nowrap" }}>{action().label}</text>
                </Button>
              );
            }}
          </For>
        </row>
      </Show>
      <column style={{ gap: "8px" }}>
        <row style={{ gap: "8px" }}>
          <QuickTile id="wifi" label="Wi-Fi" detail={wifi()?.enabled ? wifiName() ?? "Disconnected" : "Off"}
            icon={wifi()?.enabled ? "wifi" : "wifiOff"} active={Boolean(wifi()?.enabled)} toggle
            disabled={!network.data()?.available || !wifi()?.hardware_enabled}
            onClick={() => void invokePublic("network.wifi.set-enabled", { enabled: !wifi()?.enabled })}
            open={() => props.navigate("wifi")} />
          <QuickTile id="bluetooth" label="Bluetooth"
            detail={adapter()?.powered ? connectedBluetooth()?.name || connectedBluetooth()?.address || "On" : "Off"}
            icon={adapter()?.powered ? "bluetooth" : "bluetoothOff"} active={Boolean(adapter()?.powered)} toggle disabled={!adapter()}
            onClick={() => {
              const device = adapter();
              if (device) void invokePublic("bluetooth.set-power", { adapter: device.path, powered: !device.powered });
            }} open={() => props.navigate("bluetooth")} />
        </row>
        <row style={{ gap: "8px" }}>
          <QuickTile id="dnd" label="Do Not Disturb" detail={notifications.data()?.dnd ? "On" : "Off"}
            icon={notifications.data()?.dnd ? "bellOff" : "bell"} active={Boolean(notifications.data()?.dnd)} toggle
            onClick={() => void invokePublic("notifications.set-dnd", { dnd: !notifications.data()?.dnd })} />
          <QuickTile id="caffeine" label="Caffeine" detail={`${caffeine() ? "Awake" : "Normal"} · ${ruleCount()} ${ruleCount() === 1 ? "rule" : "rules"}`}
            icon="coffee" active={caffeine()} toggle onClick={() => void invokePublic("idle.caffeine", { enabled: !caffeine() })} />
        </row>
        <row style={{ gap: "8px" }}>
          <QuickTile id="profile" label="Power Profile" detail={profiles()?.active_profile ?? "balanced"}
            icon="battery" disabled={!profiles()?.profiles.length} onClick={cycleProfile} />
          <QuickTile id="wallpaper" label="Wallpaper" detail={`${wallpaper.data()?.catalog_count ?? 0} wallpapers`}
            icon="wallpaper" onClick={() => props.navigate("wallpaper")} />
        </row>
      </column>
      <Sliders openSound={() => props.navigate("sound")} />
      <BatterySummary />
      <RecentNotifications />
    </QuickSettingsScroll>
  );
}

export function QuickSettingsPanel(): NativeChild {
  const [page, setPage] = createSignal<QuickSettingsPage>("main");
  const [powerMenuOpen, setPowerMenuOpen] = createSignal(false);
  const subpage = () => {
    const current = page();
    return current === "main" ? undefined : current;
  };
  return (
    <Show when={subpage()} fallback={
      <MainPage navigate={setPage} powerMenuOpen={powerMenuOpen()}
        togglePowerMenu={() => setPowerMenuOpen(open => !open)} closePowerMenu={() => setPowerMenuOpen(false)} />
    }>
      {current => <QuickSettingsSubpage page={current()} onBack={() => setPage("main")} />}
    </Show>
  );
}
