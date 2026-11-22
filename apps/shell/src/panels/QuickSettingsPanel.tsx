import { Button, For, Image, Show, createSignal, type NativeChild } from "@hewel/zgui";
import { M3SliderRow } from "@z-shell/sdk/primitives";
import { useDaemonMedia } from "@z-shell/sdk/zgui";
import { ShellIcon, type ShellIconName } from "../icons.tsx";
import { createEnterProgress, createOpacityEnter, sharedAxisXStyle, useMotionScheme } from "../motion.ts";
import { SHELL_ROSETTE_CLIP_40, SHELL_ROSETTE_PATH } from "../shapes.ts";
import { useShellStore } from "../store.ts";
import { formatDurationSeconds, type BatteryState, type PowerConfirmAction } from "../topics.ts";
import { QuickSettingsIconButton, QuickSettingsSubpage } from "./QuickSettingsSubpages.tsx";

export type QuickSettingsPage = "main" | "wifi" | "bluetooth" | "sound" | "battery";

const primary = "var(--color-primary)";
const primaryContainer = "var(--color-primary-container)";
const onPrimaryContainer = "var(--color-on-primary-container)";
const onSurface = "var(--color-on-surface)";
const muted = "var(--color-on-surface-variant)";
const containerHigh = "var(--color-surface-container-high)";
const containerHighest = "var(--color-surface-container-highest)";
const card = { borderRadius: "16px", backgroundColor: containerHigh, padding: "10px 12px", gap: "6px" } as const;
const row = { alignItems: "center", gap: "8px" } as const;
const grow = { flexGrow: 1, flexBasis: "0px", minWidth: "0px" } as const;
const clipped = { minWidth: "0px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } as const;
const hiddenSection = { display: "none" } as const;
const iconWell = {
  display: "flex", width: "30px", height: "30px", borderRadius: "10px",
  alignItems: "center", justifyContent: "center", flexShrink: 0,
} as const;
const headerBtn = {
  display: "flex", width: "36px", height: "36px", borderRadius: "10px",
  alignItems: "center", justifyContent: "center", flexShrink: 0,
} as const;

const safePowerActions = [
  { label: "Lock", icon: "lock", action: "lock" },
  { label: "Suspend", icon: "sleep", action: "suspend" },
] as const satisfies readonly { label: string; icon: ShellIconName; action: PowerConfirmAction }[];

const sessionPowerActions = [
  { label: "Log out", icon: "logout", action: "logout", danger: false },
  { label: "Reboot", icon: "reboot", action: "reboot", danger: false },
  { label: "Power off", icon: "power", action: "poweroff", danger: true },
] as const satisfies readonly { label: string; icon: ShellIconName; action: PowerConfirmAction; danger: boolean }[];

const batteryLabels: Readonly<Record<BatteryState, string>> = {
  unknown: "Unknown", charging: "Charging", discharging: "Discharging", full: "Full",
  pending_charge: "Pending charge", pending_discharge: "Pending discharge",
};

export function PrecisionSliderRow(props: {
  label: string;
  icon: ShellIconName;
  iconLabel?: string;
  value: number;
  disabled?: boolean;
  onIconClick?: () => void;
  onChange: (value: number) => void;
  trailingTestId?: string;
  trailingLabel?: string;
  onTrailingClick?: () => void;
  showTrailingSlot?: boolean;
  valueLabel?: string;
}): NativeChild {
  return (
    <M3SliderRow
      label={props.label}
      value={props.value}
      {...(props.valueLabel !== undefined ? { valueLabel: props.valueLabel } : {})}
      {...(props.disabled !== undefined ? { disabled: props.disabled } : {})}
      {...(props.iconLabel !== undefined ? { iconLabel: props.iconLabel } : {})}
      {...(props.onIconClick ? { onIconClick: props.onIconClick } : {})}
      {...(props.showTrailingSlot !== undefined ? { showTrailingSlot: props.showTrailingSlot } : {})}
      leadingIcon={({ dragging }) => (
        <ShellIcon
          name={props.icon}
          size={16}
          color={dragging ? onPrimaryContainer : onSurface}
        />
      )}
      onChange={props.onChange}
      {...(props.onTrailingClick
        ? {
            trailing: (
              <Button
                testId={props.trailingTestId ?? null}
                ariaLabel={props.trailingLabel ?? `Open ${props.label}`}
                onClick={() => props.onTrailingClick?.()}
                style={{
                  display: "flex", width: "26px", height: "26px", borderRadius: "8px", flexShrink: 0,
                  alignItems: "center", justifyContent: "center", backgroundColor: containerHighest,
                }}
              >
                <ShellIcon name="chevronRight" size={16} color={muted} />
              </Button>
            ),
          }
        : {})}
    />
  );
}

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
  const ink = () => props.active ? onPrimaryContainer : onSurface;
  const subInk = () => props.active ? onPrimaryContainer : muted;
  return (
    <row data-qs-tile="true" style={{
      ...grow, height: "50px", borderRadius: "14px", alignItems: "center",
      backgroundColor: props.active ? primaryContainer : containerHigh,
      border: props.active ? "1px solid color-mix(in srgb, var(--color-primary) 30%, transparent)" : "1px solid transparent",
    }}>
      <Button testId={`qs-tile-${props.id}`} ariaLabel={props.label} checked={props.toggle ? props.active ?? false : null}
        disabled={props.disabled ?? false} onClick={props.onClick} style={{
          ...row, ...grow, display: "flex", flexDirection: "row", height: "100%", borderRadius: "14px",
          padding: props.open ? "0 6px 0 10px" : "0 10px",
          color: ink(), opacity: props.disabled ? 0.55 : 1,
        }}>
        <box ariaHidden style={{
          ...iconWell,
          backgroundColor: props.active ? "color-mix(in srgb, var(--color-primary) 18%, transparent)" : containerHighest,
        }}>
          <ShellIcon name={props.icon} size={16} color={props.active ? primary : muted} />
        </box>
        <column style={{ ...grow, gap: "1px" }}>
          <text style={{ ...clipped, fontSize: "13px", fontWeight: 500, lineHeight: "17px" }}>{props.label}</text>
          <text style={{ ...clipped, fontSize: "11px", lineHeight: "14px", color: subInk(), opacity: props.active ? 0.78 : 1 }}>{props.detail}</text>
        </column>
      </Button>
      <Show when={props.open !== undefined} fallback={<box style={hiddenSection} />}>
        <box ariaHidden data-split-divider="true" style={{
          width: "1px", height: "22px", flexShrink: 0,
          backgroundColor: props.active
            ? "color-mix(in srgb, var(--color-on-primary-container) 22%, transparent)"
            : "var(--color-outline-variant)",
        }} />
        <QuickSettingsIconButton testId={`qs-open-${props.id}`} label={`Open ${props.label}`} icon="chevronRight"
          size={26} fill="transparent"
          color={props.active ? onPrimaryContainer : muted}
          onClick={() => props.open?.()} />
        <box style={{ width: "4px", flexShrink: 0 }} />
      </Show>
    </row>
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
      <PrecisionSliderRow
        label="Volume"
        icon={sink()?.muted ? "volumeMute" : "volumeHigh"}
        iconLabel={sink()?.muted ? "Unmute output" : "Mute output"}
        value={(sink()?.volume ?? 0) * 100}
        disabled={!sink()?.channels}
        onIconClick={() => {
          const device = sink();
          if (device) void invokePublic("audio.set-mute", { kind: "sink", index: device.index, muted: !device.muted });
        }}
        onChange={percent => {
          const device = sink();
          if (device) void invokePublic("audio.set-volume", { kind: "sink", index: device.index, volume: percent / 100 });
        }}
        trailingTestId="qs-open-sound"
        trailingLabel="Open sound mixer"
        onTrailingClick={props.openSound}
      />
      <Show when={backlight()} fallback={<box style={hiddenSection} />}>
        {device => (
          <PrecisionSliderRow
            label="Brightness"
            icon="brightness"
            value={device().max_brightness > 0 ? device().brightness * 100 / device().max_brightness : 0}
            disabled={!device().controllable || device().max_brightness <= 0}
            onChange={percent => {
              const { device: id, max_brightness } = device();
              void invokePublic("brightness.set", { device: id, value: Math.round(percent * max_brightness / 100) });
            }}
          />
        )}
      </Show>
    </column>
  );
}

function BatteryCompactRow(props: { openBattery: () => void }): NativeChild {
  const { power } = useShellStore();
  return (
    <Show when={power.data()?.battery} fallback={<box style={hiddenSection} />}>
      {battery => {
        const charging = () => battery().state === "charging" || battery().state === "pending_charge";
        const duration = () => formatDurationSeconds(charging() ? battery().time_to_full_seconds : battery().time_to_empty_seconds);
        const detail = () => {
          const parts: string[] = [];
          const time = duration();
          if (time) parts.push(charging() ? `${time} until full` : `${time} remaining`);
          if (battery().energy_rate_watts != null) parts.push(`${battery().energy_rate_watts!.toFixed(1)} W`);
          return parts.join(" · ") || batteryLabels[battery().state];
        };
        return (
          <Button testId="qs-battery-row" ariaLabel="Open battery and power sub-panel" onClick={props.openBattery} style={{
            display: "flex", flexDirection: "row", alignItems: "center", gap: "10px",
            borderRadius: "16px", backgroundColor: containerHigh, padding: "10px 12px", color: onSurface,
          }}>
            <box ariaHidden style={{ ...iconWell, width: "36px", height: "24px", borderRadius: "8px", backgroundColor: containerHighest }}>
              <ShellIcon name={charging() ? "batteryCharging" : "battery"} size={18} color={primary} />
            </box>
            <column style={{ ...grow, gap: "1px" }}>
              <row style={{ alignItems: "baseline", gap: "6px" }}>
                <text data-tabular="true" style={{ fontFamily: "var(--font-mono)", fontSize: "14px", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
                  {battery().percentage == null ? "—" : `${Math.round(battery().percentage ?? 0)}%`}
                </text>
                <text style={{ fontSize: "12px", fontWeight: 500, color: charging() ? primary : muted }}>
                  {batteryLabels[battery().state]}
                </text>
              </row>
              <text style={{ ...clipped, fontSize: "11px", color: muted }}>{detail()}</text>
            </column>
            <box ariaHidden style={{ display: "flex", width: "26px", height: "26px", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <ShellIcon name="chevronRight" size={16} color={muted} />
            </box>
          </Button>
        );
      }}
    </Show>
  );
}

function PowerActionButton(props: {
  label: string;
  icon: ShellIconName;
  action: PowerConfirmAction;
  danger?: boolean;
  onSelect: (action: PowerConfirmAction) => void;
}): NativeChild {
  const color = () => props.danger ? "var(--color-on-error-container)" : onSurface;
  const mutedColor = () => props.danger ? "var(--color-on-error-container)" : muted;
  const isSafe = () => props.action === "lock" || props.action === "suspend";
  return (
    <Button ariaLabel={props.label} onClick={() => props.onSelect(props.action)} style={{
      ...grow, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "4px",
      padding: props.danger ? "7px 2px" : "8px 2px", borderRadius: "10px",
      backgroundColor: props.danger
        ? "color-mix(in srgb, var(--color-error-container) 38%, transparent)"
        : containerHighest,
      border: props.danger
        ? "1px solid color-mix(in srgb, var(--color-error) 35%, transparent)"
        : "1px solid transparent",
      color: isSafe() ? color() : mutedColor(),
      fontSize: "11px", fontWeight: 500,
    }}>
      <ShellIcon name={props.icon} size={16} color={isSafe() ? color() : mutedColor()} />
      <text style={{ whiteSpace: "nowrap" }}>{props.label}</text>
    </Button>
  );
}

function PowerMenuRow(props: { onSelect: (action: PowerConfirmAction) => void }): NativeChild {
  const scheme = useMotionScheme();
  const reveal = createEnterProgress("fastSpatial", { scheme });
  const fade = createOpacityEnter("fastEffects", scheme);
  return (
    <row testId="qs-power-menu" style={{
      borderRadius: "16px", backgroundColor: containerHigh, padding: "6px", gap: "6px", alignItems: "center",
      opacity: Math.max(0, Math.min(1, fade())),
      transform: scheme() === "reduced" ? "none" : `translateY(${((1 - reveal()) * -6).toFixed(2)}px) scale(${(0.97 + reveal() * 0.03).toFixed(4)})`,
      transformOrigin: "top center",
    }}>
      <For each={safePowerActions} keyed={entry => entry.action}>
        {entry => <PowerActionButton label={entry().label} icon={entry().icon} action={entry().action} onSelect={props.onSelect} />}
      </For>
      <box ariaHidden style={{ width: "1px", height: "28px", flexShrink: 0, backgroundColor: "var(--color-outline-variant)" }} />
      <For each={sessionPowerActions} keyed={entry => entry.action}>
        {entry => <PowerActionButton label={entry().label} icon={entry().icon} action={entry().action} danger={entry().danger} onSelect={props.onSelect} />}
      </For>
    </row>
  );
}

function MainPage(props: {
  navigate: (page: QuickSettingsPage) => void;
  fromSubpage: boolean;
  powerMenuOpen: boolean;
  togglePowerMenu: () => void;
  closePowerMenu: () => void;
}): NativeChild {
  const scheme = useMotionScheme();
  const backEnter = createEnterProgress("defaultSpatial", { scheme });
  const { user, hostClient, network, bluetooth, idle, power, wallpaper, clipboard,
    invokePublic, togglePanel, closePanels, requestPowerDialog, openSettingsWindow } = useShellStore();
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

  const handlePowerSelect = (selected: PowerConfirmAction) => {
    props.closePowerMenu();
    if (selected === "lock") {
      void invokePublic("lock.request", {});
      closePanels();
    } else {
      requestPowerDialog(selected);
    }
  };

  return (
    <column testId="qs-main" ariaLabel="Quick settings" style={{
      width: "100%", padding: "14px", gap: "10px", flexDirection: "column",
      backgroundColor: "var(--color-surface-container)", color: onSurface, fontFamily: "var(--font-sans)", fontSize: "13px",
      ...(props.fromSubpage ? sharedAxisXStyle(backEnter(), -1, scheme() === "reduced") : {}),
    }}>
      <row style={{ ...row, gap: "10px", padding: "0 2px" }}>
        <box ariaHidden style={{
          width: "40px", height: "40px", flexShrink: 0, position: "relative",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <vector ariaHidden d={SHELL_ROSETTE_PATH} viewBox="0 0 64 64"
            style={{ position: "absolute", inset: "0px", width: "40px", height: "40px", color: primaryContainer }} />
          <Show when={avatar.src()} fallback={
            <ShellIcon name="person" size={18} color={onPrimaryContainer} />
          }>
            {src => <Image ariaHidden src={src()} style={{
              position: "relative", zIndex: 1, width: "40px", height: "40px", objectFit: "cover", clipPath: SHELL_ROSETTE_CLIP_40,
            }} />}
          </Show>
        </box>
        <column style={{ ...grow, gap: "1px" }}>
          <text style={{ ...clipped, fontSize: "15px", fontWeight: 600, lineHeight: "20px" }}>{name()}</text>
          <text style={{ ...clipped, fontSize: "12px", color: muted, lineHeight: "16px" }}>z-shell</text>
        </column>
        <row style={{ gap: "6px", flexShrink: 0 }}>
          <Button testId="qs-open-settings" ariaLabel="Open settings" onClick={() => openSettingsWindow("appearance")}
            style={{ ...headerBtn, backgroundColor: containerHighest }}>
            <ShellIcon name="settings" size={18} color={onSurface} />
          </Button>
          <Button testId="qs-power-toggle" ariaLabel="Power menu" expanded={props.powerMenuOpen} onClick={props.togglePowerMenu}
            style={{
              ...headerBtn,
              backgroundColor: props.powerMenuOpen ? primaryContainer : containerHighest,
              border: props.powerMenuOpen
                ? "1px solid color-mix(in srgb, var(--color-primary) 42%, transparent)"
                : "1px solid transparent",
            }}>
            <ShellIcon name="power" size={18} color={props.powerMenuOpen ? onPrimaryContainer : onSurface} />
          </Button>
        </row>
      </row>
      <Show when={props.powerMenuOpen} fallback={<box style={hiddenSection} />}>
        <PowerMenuRow onSelect={handlePowerSelect} />
      </Show>
      <column style={{ gap: "8px" }}>
        <row style={{ gap: "8px" }}>
          <QuickTile id="wifi" label="Wi-Fi" detail={wifi()?.enabled ? wifiName() ?? "Disconnected" : "Off"}
            icon={wifi()?.enabled ? "wifi" : "wifiOff"} active={wifi()?.enabled ?? false} toggle
            disabled={!network.data()?.available || !wifi()?.hardware_enabled}
            onClick={() => void invokePublic("network.wifi.set-enabled", { enabled: !wifi()?.enabled })}
            open={() => props.navigate("wifi")} />
          <QuickTile id="bluetooth" label="Bluetooth"
            detail={adapter()?.powered ? connectedBluetooth()?.name || connectedBluetooth()?.address || "On" : "Off"}
            icon={adapter()?.powered ? "bluetooth" : "bluetoothOff"} active={adapter()?.powered ?? false} toggle disabled={!adapter()}
            onClick={() => {
              const device = adapter();
              if (device) void invokePublic("bluetooth.set-power", { adapter: device.path, powered: !device.powered });
            }} open={() => props.navigate("bluetooth")} />
        </row>
        <row style={{ gap: "8px" }}>
          <QuickTile id="caffeine" label="Nosleep" detail={caffeine() ? "Awake" : `${ruleCount()} ${ruleCount() === 1 ? "rule" : "rules"}`}
            icon="coffee" active={caffeine()} toggle
            onClick={() => void invokePublic("idle.caffeine", { enabled: !caffeine() })}
            open={() => openSettingsWindow("idle")} />
          <QuickTile id="profile" label="Power Profile" detail={profiles()?.active_profile ?? "balanced"}
            icon="battery" active={profiles()?.active_profile === "performance"} disabled={!profiles()?.profiles.length} onClick={cycleProfile} />
        </row>
        <row style={{ gap: "8px" }}>
          <QuickTile id="wallpaper" label="Wallpaper" detail={`${wallpaper.data()?.catalog_count ?? 0} wallpapers`}
            icon="wallpaper" onClick={() => openSettingsWindow("appearance")} />
          <QuickTile id="clipboard" label="Clipboard" detail={`${clipboard.data()?.entry_count ?? 0} entries`}
            icon="copy" onClick={() => togglePanel("clipboard")} />
        </row>
      </column>
      <Sliders openSound={() => props.navigate("sound")} />
      <BatteryCompactRow openBattery={() => props.navigate("battery")} />
    </column>
  );
}

export function QuickSettingsPanel(): NativeChild {
  const [page, setPage] = createSignal<QuickSettingsPage>("main");
  const [returnedFromSubpage, setReturnedFromSubpage] = createSignal(false);
  const [powerMenuOpen, setPowerMenuOpen] = createSignal(false);
  const subpage = () => {
    const current = page();
    return current === "main" ? undefined : current;
  };
  return (
    <Show when={subpage()} fallback={
      <MainPage
        navigate={next => { setReturnedFromSubpage(false); setPage(next); }}
        fromSubpage={returnedFromSubpage()}
        powerMenuOpen={powerMenuOpen()}
        togglePowerMenu={() => setPowerMenuOpen(open => !open)}
        closePowerMenu={() => setPowerMenuOpen(false)}
      />
    }>
      {current => <QuickSettingsSubpage page={current()} onBack={() => { setReturnedFromSubpage(true); setPage("main"); }} />}
    </Show>
  );
}
