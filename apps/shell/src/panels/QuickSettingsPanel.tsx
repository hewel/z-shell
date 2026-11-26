import {
  Button, For, Image, Show, createEffect, createSignal, getWindowRect, onCleanup, untrack,
  type NativeChild, type NativeNode,
} from "@hewel/zgui";
import { M3Collapsible, M3SliderRow } from "@z-shell/sdk/primitives";
import { useDaemonMedia } from "@z-shell/sdk/zgui";
import { ShellIcon, type ShellIconName } from "../icons.tsx";
import {
  SPRING_EPSILON, createEnterProgress, createM3Spring, sharedAxisXStyle, useMotionScheme,
} from "../motion.ts";
import { SHELL_ROSETTE_CLIP_40, SHELL_ROSETTE_PATH } from "../shapes.ts";
import { useShellStore } from "../store.ts";
import {
  formatDurationSeconds,
  formatKeepAwakeRemaining,
  supportsTimedKeepAwake,
  type BatteryState,
  type PowerConfirmAction,
} from "../topics.ts";
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
  checked?: boolean;
  toggle?: boolean;
  disabled?: boolean;
  outgoing?: boolean | undefined;
  onClick: () => void;
  open?: () => void;
}): NativeChild {
  const scheme = useMotionScheme();
  const iconPop = createM3Spring(() => 1, "fastSpatial", { scheme, overrideScheme: "expressive" });
  let prevActive = untrack(() => Boolean(props.active));
  createEffect(() => Boolean(props.active), next => {
    if (next === prevActive) return;
    prevActive = next;
    iconPop.impulse(-8.5);
  });
  const ink = () => props.active ? onPrimaryContainer : onSurface;
  const subInk = () => props.active ? onPrimaryContainer : muted;
  return (
    <row testId={props.outgoing ? null : `qs-tile-card-${props.id}`} data-qs-tile="true" style={{
      ...grow, height: "50px", borderRadius: "14px", alignItems: "center",
      backgroundColor: props.active ? primaryContainer : containerHigh,
      border: props.active ? "1px solid color-mix(in srgb, var(--color-primary) 30%, transparent)" : "1px solid transparent",
    }}>
      <Button testId={props.outgoing ? null : `qs-tile-${props.id}`} ariaLabel={props.label} checked={props.toggle ? (props.checked ?? props.active ?? false) : null}
        disabled={props.disabled ?? false} onClick={props.onClick} style={{
          ...grow, display: "flex", flexDirection: "row", alignItems: "center", height: "100%", borderRadius: "14px",
          padding: props.open ? "0 6px 0 10px" : "0 10px",
          color: ink(), opacity: props.disabled ? 0.55 : 1,
        }}>
        <row data-press-visual="card" style={{ ...row, ...grow }}>
          <box ariaHidden data-qs-tile-icon="true" style={{
            ...iconWell,
            borderRadius: "999px",
            "--zgui-corner-shape": "none",
            backgroundColor: props.active ? "color-mix(in srgb, var(--color-primary) 18%, transparent)" : containerHighest,
            transform: scheme() === "reduced" ? "none" : `scale(${Math.max(0.8, Math.min(1.12, iconPop())).toFixed(4)})`,
          }}>
            <ShellIcon name={props.icon} size={16} color={props.active ? primary : muted} />
          </box>
          <column style={{ ...grow, gap: "1px" }}>
            <text style={{ ...clipped, fontSize: "13px", fontWeight: 500, lineHeight: "17px" }}>{props.label}</text>
            <text style={{ ...clipped, fontSize: "11px", lineHeight: "14px", color: subInk(), opacity: props.active ? 0.78 : 1 }}>{props.detail}</text>
          </column>
        </row>
      </Button>
      <Show when={props.open !== undefined} fallback={<box style={hiddenSection} />}>
        <box ariaHidden data-split-divider="true" style={{
          width: "1px", height: "22px", flexShrink: 0,
          backgroundColor: props.active
            ? "color-mix(in srgb, var(--color-on-primary-container) 22%, transparent)"
            : "var(--color-outline-variant)",
        }} />
        <QuickSettingsIconButton testId={props.outgoing ? undefined : `qs-open-${props.id}`} label={`Open ${props.label}`} icon="chevronRight"
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
      ...grow, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
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
      <column data-press-visual="compact" style={{ alignItems: "center", justifyContent: "center", gap: "4px" }}>
        <ShellIcon name={props.icon} size={16} color={isSafe() ? color() : mutedColor()} />
        <text style={{ whiteSpace: "nowrap" }}>{props.label}</text>
      </column>
    </Button>
  );
}

function PowerMenuRow(props: { onSelect: (action: PowerConfirmAction) => void; outgoing?: boolean | undefined }): NativeChild {
  return (
    <row testId={props.outgoing ? null : "qs-power-menu"} style={{
      borderRadius: "16px", backgroundColor: containerHigh, padding: "6px", gap: "6px", alignItems: "center",
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
  outgoing?: boolean | undefined;
}): NativeChild {
  const scheme = useMotionScheme();
  const backEnter = createEnterProgress("defaultSpatial", { scheme });
  const { user, hostClient, network, bluetooth, idle, power, wallpaper, clipboard,
    invokePublic, togglePanel, closePanels, requestPowerDialog, openSettingsWindow } = useShellStore();
  const avatar = useDaemonMedia(hostClient, () => user.data()?.avatar, { fetchCommand: "user.fetch-blob" });
  const name = () => user.data()?.display_name ?? user.data()?.username ?? "User";
  const wifi = () => network.data()?.wifi;
  const ethernetConnected = () => network.data()?.ethernet.some(device => device.carrier) ?? false;
  const activeWifi = () => wifi()?.devices.find(device => device.active_ap_id !== null || device.active_connection !== null);
  const wifiConnected = () => Boolean(wifi()?.enabled && activeWifi());
  const wifiName = () => {
    const device = activeWifi();
    return device?.access_points.find(ap => ap.id === device.active_ap_id)?.ssid || device?.active_connection?.name;
  };
  const adapter = () => bluetooth.data()?.adapters[0];
  const connectedBluetooth = () => bluetooth.data()?.devices.find(device => device.connected && device.adapter === adapter()?.path);
  const caffeine = () => idle.data()?.caffeine ?? false;
  const keepAwakeTimed = () => Boolean(caffeine() && idle.data()?.caffeine_expires_at_ms != null);
  const [nowMs, setNowMs] = createSignal(Date.now());
  createEffect(keepAwakeTimed, active => {
    if (!active) return;
    let timer: number | undefined;
    const tick = () => {
      const now = Date.now();
      setNowMs(now);
      timer = setTimeout(tick, 1_000 - (now % 1_000));
    };
    tick();
    onCleanup(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
  });
  const keepAwakeDetail = () => {
    const snap = idle.data();
    if (!caffeine()) return "Off";
    if (!supportsTimedKeepAwake(snap)) return "On";
    return formatKeepAwakeRemaining(snap?.caffeine_expires_at_ms, nowMs());
  };
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
    <column testId={props.outgoing ? null : "qs-main"} ariaLabel="Quick settings" style={{
      width: "100%", padding: "14px", gap: "10px", flexDirection: "column",
      backgroundColor: "transparent", color: onSurface, fontFamily: "var(--font-sans)", fontSize: "13px",
      ...(props.fromSubpage && !props.outgoing ? sharedAxisXStyle(backEnter(), -1, scheme() === "reduced") : {}),
    }}>
      <row style={{ ...row, gap: "10px", padding: "0 2px" }}>
        <box ariaHidden style={{
          width: "40px", height: "40px", flexShrink: 0, position: "relative",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <vector ariaHidden d={SHELL_ROSETTE_PATH} viewBox="0 0 64 64"
            style={{ position: "absolute", inset: "0px", width: "40px", height: "40px", color: primaryContainer }} />
          <Show when={avatar.src()} fallback={
            <box testId={props.outgoing ? null : "qs-avatar-fallback"} ariaHidden style={{
              position: "relative", zIndex: 1, display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              <ShellIcon name="person" size={18} color={onPrimaryContainer} />
            </box>
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
          <Button testId={props.outgoing ? null : "qs-open-settings"} ariaLabel="Open settings" onClick={() => openSettingsWindow("appearance")}
            style={{ ...headerBtn, backgroundColor: containerHighest }}>
            <box data-press-visual="compact" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
              <ShellIcon name="settings" size={18} color={onSurface} />
            </box>
          </Button>
          <Button testId={props.outgoing ? null : "qs-power-toggle"} ariaLabel="Power menu" expanded={props.powerMenuOpen} onClick={props.togglePowerMenu}
            style={{
              ...headerBtn,
              backgroundColor: props.powerMenuOpen ? primaryContainer : containerHighest,
              border: props.powerMenuOpen
                ? "1px solid color-mix(in srgb, var(--color-primary) 42%, transparent)"
                : "1px solid transparent",
            }}>
            <box data-press-visual="compact" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
              <ShellIcon name="power" size={18} color={props.powerMenuOpen ? onPrimaryContainer : onSurface} />
            </box>
          </Button>
        </row>
      </row>
      <M3Collapsible open={props.powerMenuOpen} estimatedHeight={64}>
        <PowerMenuRow onSelect={handlePowerSelect} outgoing={props.outgoing} />
      </M3Collapsible>
      <column style={{ gap: "8px" }}>
        <row style={{ gap: "8px" }}>
          <QuickTile id="wifi" label="Wi-Fi"
            detail={wifi()?.enabled ? (wifiName() ?? (ethernetConnected() ? "Ethernet · Standby" : "Disconnected")) : "Off"}
            icon={wifi()?.enabled ? "wifi" : "wifiOff"} active={wifiConnected()} checked={Boolean(wifi()?.enabled)} toggle
            disabled={!network.data()?.available || !wifi()?.hardware_enabled}
            outgoing={props.outgoing}
            onClick={() => void invokePublic("network.wifi.set-enabled", { enabled: !wifi()?.enabled })}
            open={() => props.navigate("wifi")} />
          <QuickTile id="bluetooth" label="Bluetooth"
            detail={adapter()?.powered ? connectedBluetooth()?.name || connectedBluetooth()?.address || "On" : "Off"}
            icon={adapter()?.powered ? "bluetooth" : "bluetoothOff"} active={adapter()?.powered ?? false} toggle disabled={!adapter()}
            outgoing={props.outgoing}
            onClick={() => {
              const device = adapter();
              if (device) void invokePublic("bluetooth.set-power", { adapter: device.path, powered: !device.powered });
            }} open={() => props.navigate("bluetooth")} />
        </row>
        <row style={{ gap: "8px" }}>
          <QuickTile id="caffeine" label="Keep awake" detail={keepAwakeDetail()}
            icon="coffee" active={caffeine()} checked={caffeine()} toggle
            outgoing={props.outgoing}
            onClick={() => void invokePublic("idle.caffeine", { enabled: !caffeine() })} />
          <QuickTile id="profile" label="Power Profile" detail={profiles()?.active_profile ?? "balanced"}
            icon="battery" active={profiles()?.active_profile === "performance"} disabled={!profiles()?.profiles.length}
            outgoing={props.outgoing} onClick={cycleProfile} />
        </row>
        <row style={{ gap: "8px" }}>
          <QuickTile id="wallpaper" label="Wallpaper" detail={`${wallpaper.data()?.catalog_count ?? 0} wallpapers`}
            icon="wallpaper" outgoing={props.outgoing} onClick={() => openSettingsWindow("appearance")} />
          <QuickTile id="clipboard" label="Clipboard" detail={`${clipboard.data()?.entry_count ?? 0} entries`}
            icon="copy" outgoing={props.outgoing} onClick={() => togglePanel("clipboard")} />
        </row>
      </column>
      <Sliders openSound={() => props.navigate("sound")} />
      <BatteryCompactRow openBattery={() => props.navigate("battery")} />
    </column>
  );
}

interface OutgoingQuickSettings {
  readonly id: number;
  readonly page: QuickSettingsPage;
  readonly direction: 1 | -1;
}

function OutgoingQuickSettingsLayer(props: {
  readonly entry: OutgoingQuickSettings;
  readonly powerMenuOpen: boolean;
  readonly onDone: () => void;
}): NativeChild {
  const scheme = useMotionScheme();
  const fade = createM3Spring(() => 0, "fastEffects", { initial: 1, scheme });
  createEffect(() => fade.settled() && fade() <= SPRING_EPSILON.unit, done => {
    if (done) props.onDone();
  });
  const noop = () => {};
  const progress = () => Math.max(0, Math.min(1, fade()));
  return (
    <box ariaHidden inert style={{
      position: "absolute", top: "0px", left: "0px", right: "0px",
      pointerEvents: "none",
      opacity: progress(),
      transform: scheme() === "reduced" ? "none" : `translateX(${((1 - progress()) * -14 * props.entry.direction).toFixed(2)}px)`,
    }}>
      <Show when={props.entry.page !== "main"} fallback={
        <MainPage navigate={noop} fromSubpage={false} powerMenuOpen={props.powerMenuOpen} togglePowerMenu={noop} closePowerMenu={noop} outgoing />
      }>
        <QuickSettingsSubpage page={props.entry.page as Exclude<QuickSettingsPage, "main">} onBack={noop} outgoing />
      </Show>
    </box>
  );
}

export function QuickSettingsPanel(): NativeChild {
  const { pendingQuickSettingsSubpage, consumeQuickSettingsSubpage } = useShellStore();
  const scheme = useMotionScheme();
  const [page, setPage] = createSignal<QuickSettingsPage>(consumeQuickSettingsSubpage() ?? "main");
  const [returnedFromSubpage, setReturnedFromSubpage] = createSignal(false);
  const [powerMenuOpen, setPowerMenuOpen] = createSignal(false);
  const [outgoing, setOutgoing] = createSignal<OutgoingQuickSettings | null>(null);
  const [targetHeight, setTargetHeight] = createSignal<number | null>(null);
  let activeWrapper: NativeNode | undefined;
  let transitionSeq = 0;

  createEffect(pendingQuickSettingsSubpage, requested => {
    if (!requested) return;
    const consumed = consumeQuickSettingsSubpage();
    if (consumed) setPage(consumed);
  });

  const animatedHeight = createM3Spring(() => targetHeight() ?? 0, "defaultSpatial", {
    scheme,
    epsilon: SPRING_EPSILON.px,
  });

  createEffect(() => targetHeight() !== null && animatedHeight.settled(), settled => {
    if (settled) setTargetHeight(null);
  });

  const transitionTo = (next: QuickSettingsPage) => {
    const current = page();
    if (current === next) return;
    const isReduced = scheme() === "reduced";
    const prevHeight = activeWrapper ? getWindowRect(activeWrapper)?.height ?? 0 : 0;
    const direction: 1 | -1 = next === "main" ? -1 : 1;
    if (!isReduced) {
      setOutgoing({ id: ++transitionSeq, page: current, direction });
      if (prevHeight > 1) {
        animatedHeight.jump(prevHeight);
        setTargetHeight(prevHeight);
      }
    } else {
      setOutgoing(null);
      setTargetHeight(null);
    }
    setReturnedFromSubpage(next === "main");
    setPage(next);
    if (!isReduced && prevHeight > 1) {
      queueMicrotask(() => {
        const nextHeight = activeWrapper ? getWindowRect(activeWrapper)?.height ?? 0 : 0;
        if (nextHeight > 1 && Math.abs(nextHeight - prevHeight) > 1) {
          setTargetHeight(nextHeight);
        } else {
          setTargetHeight(null);
        }
      });
    }
  };

  const subpage = () => {
    const current = page();
    return current === "main" ? undefined : current;
  };
  return (
    <box style={{
      position: "relative", width: "100%", overflow: "hidden",
      ...(targetHeight() !== null && scheme() !== "reduced" ? { height: `${Math.max(80, animatedHeight()).toFixed(2)}px` } : {}),
    }}>
      <box ref={node => { activeWrapper = node; }} style={{ width: "100%" }}>
        <Show when={subpage()} fallback={
          <MainPage
            navigate={transitionTo}
            fromSubpage={returnedFromSubpage()}
            powerMenuOpen={powerMenuOpen()}
            togglePowerMenu={() => setPowerMenuOpen(open => !open)}
            closePowerMenu={() => setPowerMenuOpen(false)}
          />
        }>
          {current => <QuickSettingsSubpage page={current()} onBack={() => transitionTo("main")} />}
        </Show>
      </box>
      <Show when={outgoing()} keyed>
        {entry => (
          <OutgoingQuickSettingsLayer
            entry={entry}
            powerMenuOpen={powerMenuOpen()}
            onDone={() => {
              if (outgoing()?.id === entry.id) setOutgoing(null);
            }}
          />
        )}
      </Show>
    </box>
  );
}
