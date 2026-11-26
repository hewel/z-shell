import {
  Button, For, Image, Show, createEffect, createSignal, cx, getWindowRect, onCleanup, untrack,
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
import { POWER_PROFILE_META } from "./BatteryPanel.tsx";
import styles from "./QuickSettingsPanel.module.css";
import { QuickSettingsIconButton, QuickSettingsSubpage } from "./QuickSettingsSubpages.tsx";

export type QuickSettingsPage = "main" | "wifi" | "bluetooth" | "sound" | "battery";

const primary = "var(--color-primary)";
const onPrimaryContainer = "var(--color-on-primary-container)";
const onSurface = "var(--color-on-surface)";
const muted = "var(--color-on-surface-variant)";

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
  sliderTestId?: string;
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
      {...(props.sliderTestId !== undefined ? { sliderTestId: props.sliderTestId } : {})}
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
                class={styles.sliderTrailingBtn}
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
  openMode?: "navigate" | "expand";
  expanded?: boolean;
  openDisabled?: boolean;
}): NativeChild {
  const scheme = useMotionScheme();
  const iconPop = createM3Spring(() => 1, "fastSpatial", { scheme, overrideScheme: "expressive" });
  const chevronProgress = createM3Spring(() => (props.expanded ? 1 : 0), "fastSpatial", { scheme });
  let prevActive = untrack(() => Boolean(props.active));
  createEffect(() => Boolean(props.active), next => {
    if (next === prevActive) return;
    prevActive = next;
    iconPop.impulse(-8.5);
  });
  const isExpand = () => props.openMode === "expand";
  const splitDisabled = () => props.openDisabled ?? false;
  const chevronRotation = () => {
    if (scheme() === "reduced") return "none";
    const deg = Math.max(0, Math.min(180, chevronProgress() * 180));
    return `rotate(${deg.toFixed(2)}deg)`;
  };
  return (
    <row
      testId={props.outgoing ? null : `qs-tile-card-${props.id}`}
      data-qs-tile="true"
      data-active={props.active ? "true" : "false"}
      class={styles.qsTileCard}
    >
      <Button
        testId={props.outgoing ? null : `qs-tile-${props.id}`}
        ariaLabel={props.label}
        checked={props.toggle ? (props.checked ?? props.active ?? false) : null}
        disabled={props.disabled ?? false}
        data-active={props.active ? "true" : "false"}
        data-has-open={props.open ? "true" : "false"}
        data-disabled={props.disabled ? "true" : "false"}
        onClick={props.onClick}
        class={styles.qsTileBtn}
      >
        <row data-press-visual="card" class={cx(styles.row, styles.grow)}>
          <box
            ariaHidden
            data-qs-tile-icon="true"
            data-active={props.active ? "true" : "false"}
            class={styles.qsTileIcon}
            style={{
              transform: scheme() === "reduced" ? "none" : `scale(${Math.max(0.8, Math.min(1.12, iconPop())).toFixed(4)})`,
            }}
          >
            <ShellIcon name={props.icon} filled={props.active} size={16} color={props.active ? primary : muted} />
          </box>
          <column class={cx(styles.grow, styles.qsTileTextCol)}>
            <text class={cx(styles.clipped, styles.qsTileLabel)}>{props.label}</text>
            <text class={cx(styles.clipped, styles.qsTileDetail)} data-active={props.active ? "true" : "false"}>{props.detail}</text>
          </column>
        </row>
      </Button>
      <Show when={props.open !== undefined} fallback={<box class={styles.hiddenSection} />}>
        <box ariaHidden data-split-divider="true" data-active={props.active ? "true" : "false"} class={styles.splitDivider} />
        <Show when={isExpand()} fallback={
          <QuickSettingsIconButton
            testId={props.outgoing ? undefined : `qs-open-${props.id}`}
            label={`Open ${props.label}`}
            icon="chevronRight"
            size={26}
            tone="transparent"
            disabled={splitDisabled()}
            color={props.active ? onPrimaryContainer : muted}
            onClick={() => props.open?.()}
          />
        }>
          <Button
            testId={props.outgoing ? null : `qs-open-${props.id}`}
            ariaLabel={props.expanded ? `Collapse ${props.label}` : `Expand ${props.label}`}
            expanded={props.expanded ?? false}
            disabled={splitDisabled()}
            data-disabled={splitDisabled() ? "true" : "false"}
            onClick={() => props.open?.()}
            class={styles.expandBtn}
          >
            <box
              data-press-visual="compact"
              class={styles.pressVisualCompact}
              style={{ transform: chevronRotation() }}
            >
              <ShellIcon name="expandMore" size={16} color={props.active ? onPrimaryContainer : muted} />
            </box>
          </Button>
        </Show>
        <box class={styles.splitTrailingPad} />
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
    <column class={styles.card}>
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
      <Show when={backlight()} fallback={<box class={styles.hiddenSection} />}>
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
    <Show when={power.data()?.battery} fallback={<box class={styles.hiddenSection} />}>
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
          <Button testId="qs-battery-row" ariaLabel="Open battery and power sub-panel" onClick={props.openBattery} class={styles.batteryRow}>
            <box ariaHidden class={styles.batteryIconWell}>
              <ShellIcon name={charging() ? "batteryCharging" : "battery"} size={18} color={primary} />
            </box>
            <column class={cx(styles.grow, styles.batteryTextCol)}>
              <row class={styles.batteryHeadlineRow}>
                <text data-tabular="true" class={styles.batteryPercent}>
                  {battery().percentage == null ? "—" : `${Math.round(battery().percentage ?? 0)}%`}
                </text>
                <text class={styles.batteryState} data-charging={charging() ? "true" : "false"}>
                  {batteryLabels[battery().state]}
                </text>
              </row>
              <text class={cx(styles.clipped, styles.batteryDetail)}>{detail()}</text>
            </column>
            <box ariaHidden class={styles.batteryChevronWell}>
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
  const tone = () => (props.danger ? "danger" : isSafe() ? "safe" : "session");
  return (
    <Button
      ariaLabel={props.label}
      data-tone={tone()}
      onClick={() => props.onSelect(props.action)}
      class={styles.powerActionBtn}
    >
      <column data-press-visual="compact" class={styles.powerActionVisual}>
        <ShellIcon name={props.icon} size={16} color={isSafe() ? color() : mutedColor()} />
        <text class={styles.powerActionLabel}>{props.label}</text>
      </column>
    </Button>
  );
}

function PowerMenuRow(props: { onSelect: (action: PowerConfirmAction) => void; outgoing?: boolean | undefined }): NativeChild {
  return (
    <row testId={props.outgoing ? null : "qs-power-menu"} class={styles.powerMenuRow}>
      <For each={safePowerActions} keyed={entry => entry.action}>
        {entry => <PowerActionButton label={entry().label} icon={entry().icon} action={entry().action} onSelect={props.onSelect} />}
      </For>
      <box ariaHidden class={styles.powerMenuDivider} />
      <For each={sessionPowerActions} keyed={entry => entry.action}>
        {entry => <PowerActionButton label={entry().label} icon={entry().icon} action={entry().action} danger={entry().danger} onSelect={props.onSelect} />}
      </For>
    </row>
  );
}

function PowerProfileDrawer(props: {
  readonly profiles: readonly string[];
  readonly activeProfile: string | null;
  readonly onSelect: (profile: string) => void;
  readonly outgoing?: boolean | undefined;
}): NativeChild {
  return (
    <column testId={props.outgoing ? null : "qs-profile-menu"} class={styles.profileMenu}>
      <For each={props.profiles} keyed={name => name}>
        {name => {
          const active = () => name() === props.activeProfile;
          const meta = () => POWER_PROFILE_META[name()] ?? {
            label: name(),
            detail: "System power profile",
            shortDetail: "System power profile",
            icon: "battery" as const,
          };
          return (
            <Button
              testId={props.outgoing ? null : `qs-profile-option-${name()}`}
              ariaLabel={meta().label}
              selected={active()}
              data-active={active() ? "true" : "false"}
              onClick={() => props.onSelect(name())}
              class={styles.profileOptionBtn}
            >
              <row data-press-visual="card" class={cx(styles.profileOptionRow, styles.grow)}>
                <box ariaHidden class={styles.profileOptionIcon} data-active={active() ? "true" : "false"}>
                  <ShellIcon name={meta().icon} size={16} color={active() ? onPrimaryContainer : muted} />
                </box>
                <column class={cx(styles.grow, styles.profileOptionText)}>
                  <text class={cx(styles.clipped, styles.profileOptionTitle)}>{meta().label}</text>
                  <text class={cx(styles.clipped, styles.profileOptionDetail)} data-active={active() ? "true" : "false"}>
                    {meta().shortDetail}
                  </text>
                </column>
                <Show when={active()} fallback={<box class={styles.hiddenSection} />}>
                  <ShellIcon name="check" size={16} color={active() ? onPrimaryContainer : muted} />
                </Show>
              </row>
            </Button>
          );
        }}
      </For>
    </column>
  );
}

function MainPage(props: {
  navigate: (page: QuickSettingsPage) => void;
  fromSubpage: boolean;
  powerMenuOpen: boolean;
  togglePowerMenu: () => void;
  closePowerMenu: () => void;
  profileMenuOpen: boolean;
  toggleProfileMenu: () => void;
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
  const hasProfiles = () => Boolean(profiles()?.available && profiles()?.profiles.length);
  const profileDetail = () => {
    const current = profiles();
    const active = current?.active_profile;
    if (active) return POWER_PROFILE_META[active]?.label ?? active;
    return current?.available ? "None" : "Unavailable";
  };
  const cycleProfile = () => {
    const current = profiles();
    if (!current?.available || !current.profiles.length) return;
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
    <column
      testId={props.outgoing ? null : "qs-main"}
      ariaLabel="Quick settings"
      class={styles.mainPage}
      style={props.fromSubpage && !props.outgoing ? sharedAxisXStyle(backEnter(), -1, scheme() === "reduced") : undefined}
    >
      <row class={cx(styles.row, styles.mainHeader)}>
        <box ariaHidden class={styles.avatarWrap}>
          <vector ariaHidden d={SHELL_ROSETTE_PATH} viewBox="0 0 64 64" class={styles.avatarRosette} />
          <Show when={avatar.src()} fallback={
            <box testId={props.outgoing ? null : "qs-avatar-fallback"} ariaHidden class={styles.avatarFallback}>
              <ShellIcon name="person" filled size={18} color={onPrimaryContainer} />
            </box>
          }>
            {src => <Image ariaHidden src={src()} class={styles.avatarImg} style={{ clipPath: SHELL_ROSETTE_CLIP_40 }} />}
          </Show>
        </box>
        <column class={cx(styles.grow, styles.userCol)}>
          <text class={cx(styles.clipped, styles.userName)}>{name()}</text>
          <text class={cx(styles.clipped, styles.userSub)}>z-shell</text>
        </column>
        <row class={styles.headerBtnGroup}>
          <Button
            testId={props.outgoing ? null : "qs-open-settings"}
            ariaLabel="Open settings"
            onClick={() => openSettingsWindow("appearance")}
            class={styles.headerBtn}
          >
            <box data-press-visual="compact" class={styles.pressVisualCompact}>
              <ShellIcon name="settings" size={18} color={onSurface} />
            </box>
          </Button>
          <Button
            testId={props.outgoing ? null : "qs-power-toggle"}
            ariaLabel="Power menu"
            expanded={props.powerMenuOpen}
            data-active={props.powerMenuOpen ? "true" : "false"}
            onClick={props.togglePowerMenu}
            class={cx(styles.headerBtn, styles.powerToggleBtn)}
          >
            <box data-press-visual="compact" class={styles.pressVisualCompact}>
              <ShellIcon name="power" size={18} color={props.powerMenuOpen ? onPrimaryContainer : onSurface} />
            </box>
          </Button>
        </row>
      </row>
      <M3Collapsible open={props.powerMenuOpen} estimatedHeight={64}>
        <PowerMenuRow onSelect={handlePowerSelect} outgoing={props.outgoing} />
      </M3Collapsible>
      <column class={styles.tilesGrid}>
        <row class={styles.tilesRow}>
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
        <row class={styles.tilesRow}>
          <QuickTile id="caffeine" label="Keep awake" detail={keepAwakeDetail()}
            icon="coffee" active={caffeine()} checked={caffeine()} toggle
            outgoing={props.outgoing}
            onClick={() => void invokePublic("idle.caffeine", { enabled: !caffeine() })} />
          <QuickTile id="profile" label="Power Profile" detail={profileDetail()}
            icon="battery" active={profiles()?.active_profile === "performance"} disabled={!hasProfiles()}
            outgoing={props.outgoing} onClick={cycleProfile}
            open={props.toggleProfileMenu} openMode="expand" expanded={props.profileMenuOpen} openDisabled={!hasProfiles()} />
        </row>
        <M3Collapsible open={props.profileMenuOpen && hasProfiles()} estimatedHeight={156}>
          <PowerProfileDrawer
            profiles={profiles()?.profiles ?? []}
            activeProfile={profiles()?.active_profile ?? null}
            onSelect={profile => { void invokePublic("power.set-profile", { profile }); }}
            outgoing={props.outgoing}
          />
        </M3Collapsible>
        <row class={styles.tilesRow}>
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
  readonly profileMenuOpen: boolean;
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
    <box
      ariaHidden
      inert
      class={styles.outgoingLayer}
      style={{
        opacity: progress(),
        transform: scheme() === "reduced" ? "none" : `translateX(${((1 - progress()) * -14 * props.entry.direction).toFixed(2)}px)`,
      }}
    >
      <Show when={props.entry.page !== "main"} fallback={
        <MainPage
          navigate={noop}
          fromSubpage={false}
          powerMenuOpen={props.powerMenuOpen}
          togglePowerMenu={noop}
          closePowerMenu={noop}
          profileMenuOpen={props.profileMenuOpen}
          toggleProfileMenu={noop}
          outgoing
        />
      }>
        <QuickSettingsSubpage page={props.entry.page as Exclude<QuickSettingsPage, "main">} onBack={noop} outgoing />
      </Show>
    </box>
  );
}

export function QuickSettingsPanel(): NativeChild {
  const {
    power,
    quickSettingsPage,
    setQuickSettingsPage,
    pendingQuickSettingsSubpage,
    consumeQuickSettingsSubpage,
  } = useShellStore();
  const scheme = useMotionScheme();
  const [page, setPage] = createSignal<QuickSettingsPage>(consumeQuickSettingsSubpage() ?? quickSettingsPage());
  const [returnedFromSubpage, setReturnedFromSubpage] = createSignal(false);
  const [powerMenuOpen, setPowerMenuOpen] = createSignal(false);
  const [profileMenuOpen, setProfileMenuOpen] = createSignal(false);
  const [outgoing, setOutgoing] = createSignal<OutgoingQuickSettings | null>(null);
  const [targetHeight, setTargetHeight] = createSignal<number | null>(null);
  let activeWrapper: NativeNode | undefined;
  let transitionSeq = 0;

  createEffect(pendingQuickSettingsSubpage, requested => {
    if (!requested) return;
    const consumed = consumeQuickSettingsSubpage();
    if (consumed) setPage(consumed);
  });

  createEffect(
    () => Boolean(power.data()?.profiles.available && power.data()?.profiles.profiles.length),
    available => {
      if (!available && profileMenuOpen()) setProfileMenuOpen(false);
    },
  );

  const togglePowerMenu = () => {
    setPowerMenuOpen(open => {
      const next = !open;
      if (next) setProfileMenuOpen(false);
      return next;
    });
  };

  const toggleProfileMenu = () => {
    setProfileMenuOpen(open => {
      const next = !open;
      if (next) setPowerMenuOpen(false);
      return next;
    });
  };

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
    setQuickSettingsPage(next);
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

  createEffect(quickSettingsPage, requested => {
    if (requested !== page()) transitionTo(requested);
  });

  const subpage = () => {
    const current = page();
    return current === "main" ? undefined : current;
  };
  return (
    <box
      class={styles.panelRoot}
      style={targetHeight() !== null && scheme() !== "reduced"
        ? { height: `${Math.max(80, animatedHeight()).toFixed(2)}px` }
        : undefined}
    >
      <box ref={node => { activeWrapper = node; }} class={styles.activeWrapper}>
        <Show when={subpage()} fallback={
          <MainPage
            navigate={transitionTo}
            fromSubpage={returnedFromSubpage()}
            powerMenuOpen={powerMenuOpen()}
            togglePowerMenu={togglePowerMenu}
            closePowerMenu={() => setPowerMenuOpen(false)}
            profileMenuOpen={profileMenuOpen()}
            toggleProfileMenu={toggleProfileMenu}
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
            profileMenuOpen={profileMenuOpen()}
            onDone={() => {
              if (outgoing()?.id === entry.id) setOutgoing(null);
            }}
          />
        )}
      </Show>
    </box>
  );
}
