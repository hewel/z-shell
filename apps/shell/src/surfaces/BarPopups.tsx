import { For, PopupSurface, Show, createMemo, type NativeChild } from "@hewel/zgui";
import { MenuItemPrimitive, MenuListPrimitive, MenuRootPrimitive } from "@hewel/zgui/primitives";
import { ShellIcon } from "../icons.tsx";
import { createRetainedPresence, panelMotionStyle, popoverContentMotionStyle, useMotionScheme, type M3Spring } from "../motion.ts";
import { resolvePopoverGeometry } from "../panels/ShellPanels.tsx";
import { useShellStore } from "../store.ts";
import { useShellTheme } from "../theme.ts";
import type { BarPosition, BarStyle, TrayMenuNode } from "../topics.ts";

const MENU_MIN_WIDTH = 220;
const MENU_MAX_WIDTH = 360;
const MENU_MAX_HEIGHT = 520;
const primary = "var(--color-primary)";
const onSurfaceVariant = "var(--color-on-surface-variant)";
const separator = { height: "1px", margin: "5px 4px", flexShrink: 0, backgroundColor: "color-mix(in srgb, var(--color-outline-variant) 55%, transparent)" } as const;
const indicator = { display: "flex", width: "14px", height: "14px", flexShrink: 0, alignItems: "center", justifyContent: "center" } as const;

interface TrayMenuRow {
  readonly node: TrayMenuNode;
  readonly depth: number;
  readonly enabled: boolean;
  readonly submenu: boolean;
}

function visibleTrayRows(nodes: readonly TrayMenuNode[]): TrayMenuRow[] {
  const rows: TrayMenuRow[] = [];
  function append(children: readonly TrayMenuNode[], depth: number, parentEnabled: boolean) {
    for (const node of children) {
      if (!node.visible) continue;
      const enabled = parentEnabled && node.enabled;
      const submenu = !node.separator && node.children.some(child => child.visible);
      rows.push({ node, depth, enabled, submenu });
      if (submenu) append(node.children, depth + 1, enabled);
    }
  }
  append(nodes, 0, true);
  return rows;
}

function estimateLabelPx(label: string): number {
  let width = 0;
  for (const ch of label) {
    const code = ch.codePointAt(0) ?? 0;
    width += code > 0x2e7f ? 13.5 : 7.8;
  }
  return width;
}

function resolveMenuWidth(rows: readonly { readonly label: string; readonly depth?: number; readonly submenu?: boolean }[]): number {
  let needed = MENU_MIN_WIDTH;
  for (const row of rows) {
    const leftPad = 8 + Math.min(row.depth ?? 0, 6) * 12;
    const rowWidth =
      18 // outer padding (8*2) + border (2)
      + leftPad
      + 14 // check/radio indicator
      + 8 // gap
      + estimateLabelPx(row.label)
      + (row.submenu ? 20 : 0) // submenu chevron + gap
      + 12; // right padding + safety margin
    if (rowWidth > needed) needed = rowWidth;
  }
  return Math.max(MENU_MIN_WIDTH, Math.min(MENU_MAX_WIDTH, Math.ceil(needed)));
}

function PopupContent(props: {
  padding: string;
  label: string;
  position: BarPosition;
  spatial: M3Spring;
  opacity: M3Spring;
  onDismiss: () => void;
  children: NativeChild;
}) {
  const { theme } = useShellStore();
  useShellTheme(theme.data);
  const scheme = useMotionScheme();
  return (
    <MenuRootPrimitive open onDismiss={props.onDismiss}>
      <box data-theme-rev={String(theme.revision())} style={{
        width: "100%",
        borderRadius: "16px",
        backgroundColor: "var(--color-surface-container)",
        border: "1px solid color-mix(in srgb, var(--color-outline-variant) 55%, transparent)",
        color: "var(--color-on-surface)",
        fontFamily: "var(--font-sans)",
        fontSize: "13px",
        overflow: "hidden",
        ...panelMotionStyle(props.spatial(), props.position, false, {
          opacity: props.opacity(),
          reduced: scheme() === "reduced",
        }),
      }}>
        <scroll style={{
          width: "100%",
          maxHeight: `${MENU_MAX_HEIGHT - 2}px`,
          overflow: "hidden auto",
          ...popoverContentMotionStyle(props.spatial(), props.opacity(), scheme() === "reduced"),
        }}>
          <MenuListPrimitive
            label={props.label}
            autoFocus
            dismissOnEscape
            dismissOnOutsidePress={false}
            dismissLayer={false}
            onDismiss={props.onDismiss}
            style={{ display: "flex", flexDirection: "column", padding: props.padding, gap: "2px" }}
          >
            {props.children}
          </MenuListPrimitive>
        </scroll>
      </box>
    </MenuRootPrimitive>
  );
}

function MenuButton(props: {
  testId: string;
  label: string;
  disabled?: boolean;
  depth?: number;
  toggle?: "checkmark" | "radio" | null;
  checked?: boolean;
  submenu?: boolean;
  activate: () => void;
}) {
  return (
    <MenuItemPrimitive
      testId={props.testId}
      role={props.toggle === "radio" ? "menuItemRadio" : props.toggle === "checkmark" ? "menuItemCheckBox" : "menuItem"}
      checked={props.toggle ? props.checked ?? false : null}
      disabled={props.disabled ?? false}
      closeOnSelect={false}
      onSelect={() => { if (!props.disabled) props.activate(); }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "8px",
        height: "36px",
        borderRadius: "8px",
        flexShrink: 0,
        padding: `0 8px 0 ${8 + Math.min(props.depth ?? 0, 6) * 12}px`,
        opacity: props.disabled ? 0.38 : 1,
      }}
    >
      <box ariaHidden style={indicator}>
        <Show when={props.checked}>
          <Show when={props.toggle === "radio"} fallback={<ShellIcon name="check" size={14} color={primary} />}>
            <box style={{ width: "6px", height: "6px", borderRadius: "3px", backgroundColor: primary }} />
          </Show>
        </Show>
      </box>
      <text style={{ flexGrow: 1, minWidth: "0px", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{props.label}</text>
      <Show when={props.submenu}><ShellIcon name="chevronRight" size={12} color={onSurfaceVariant} /></Show>
    </MenuItemPrimitive>
  );
}

export function BarPopups(): NativeChild {
  const { activeTrayMenu, closeTrayMenu, tray, activeImeMenu, closeImeMenu, ime, settings, invokePublic } = useShellStore();
  const scheme = useMotionScheme();
  const position = (): BarPosition => settings.data()?.bar.position ?? "top";
  const barStyle = (): BarStyle => settings.data()?.bar.style ?? "floating";
  const geometry = createMemo(() => resolvePopoverGeometry(position(), barStyle(), false));
  const trayTarget = createMemo(() => {
    const target = activeTrayMenu();
    if (!target) return null;
    const item = tray.data()?.items.find(candidate => candidate.id === target.itemId);
    return item?.menu ? { target, label: item.title || item.id, menu: item.menu } : null;
  });
  const trayPresence = createRetainedPresence(trayTarget, {
    scheme,
    enterRole: "defaultSpatial",
    enterOpacityRole: "fastEffects",
    exitRole: "fastEffects",
  });
  const trayRows = createMemo(() => {
    const target = trayPresence.value();
    return target ? visibleTrayRows(target.menu.root.children) : [];
  });
  const trayWidth = createMemo(() =>
    resolveMenuWidth(trayRows().map(row => ({ label: row.node.label ?? "", depth: row.depth, submenu: row.submenu }))),
  );
  const imePresence = createRetainedPresence(activeImeMenu, {
    scheme,
    enterRole: "defaultSpatial",
    enterOpacityRole: "fastEffects",
    exitRole: "fastEffects",
  });
  const imeWidth = createMemo(() => {
    const snapshot = ime.data();
    const labels = [
      ...(snapshot?.group_ims.map(im => ({ label: im.label })) ?? []),
      ...(snapshot?.properties.map(prop => ({ label: prop.label })) ?? []),
    ];
    return resolveMenuWidth(labels);
  });

  return (
    <>
      <Show when={trayPresence.value()}>
        {item => (
          <PopupSurface name="tray-menu" parent={item().target.parentSurface} anchorRect={item().target.anchorRect}
            width={trayWidth()} height="auto" minHeight={48} maxHeight={MENU_MAX_HEIGHT}
            placement={geometry().placement} offset={geometry().offset} grab onDismiss={() => { trayPresence.dismissInstant(); closeTrayMenu(); }}>
            <PopupContent padding="8px" label={item().label} position={position()} spatial={trayPresence.progress} opacity={trayPresence.opacity}
              onDismiss={closeTrayMenu}>
              <For each={trayRows()} keyed={row => row.node.id}>
                {row => (
                  <Show when={!row().node.separator} fallback={<box ariaHidden style={separator} />}>
                    <MenuButton testId={`tray-menu-item-${row().node.id}`} label={row().node.label ?? ""} depth={row().depth}
                      disabled={!row().enabled} toggle={row().node.toggle_type} checked={row().node.toggle_state === 1} submenu={row().submenu}
                      activate={() => {
                        void invokePublic("tray.menu-item", { id: item().target.itemId, menu_id: row().node.id });
                        closeTrayMenu();
                      }} />
                  </Show>
                )}
              </For>
            </PopupContent>
          </PopupSurface>
        )}
      </Show>
      <Show when={imePresence.value()}>
        {target => (
          <PopupSurface name="ime-menu" parent={target().parentSurface} anchorRect={target().anchorRect}
            width={imeWidth()} height="auto" minHeight={48} maxHeight={MENU_MAX_HEIGHT}
            placement={geometry().placement} offset={geometry().offset} grab onDismiss={() => { imePresence.dismissInstant(); closeImeMenu(); }}>
            <PopupContent padding="8px" label="Input method" position={position()} spatial={imePresence.progress} opacity={imePresence.opacity}
              onDismiss={closeImeMenu}>
              <For each={ime.data()?.group_ims} keyed={im => im.unique_name}>
                {im => (
                  <MenuButton testId={`ime-im-${im().unique_name}`} label={im().label}
                    checked={im().unique_name === ime.data()?.active_im?.unique_name}
                    activate={() => {
                      void invokePublic("ime.set-im", { unique_name: im().unique_name });
                      closeImeMenu();
                    }} />
                )}
              </For>
              <For each={ime.data()?.properties} keyed={prop => prop.key}>
                {prop => (
                  <MenuButton testId={`ime-prop-${prop().key}`} label={prop().label}
                    activate={() => {
                      void invokePublic("ime.trigger-property", { key: prop().key });
                      closeImeMenu();
                    }} />
                )}
              </For>
            </PopupContent>
          </PopupSurface>
        )}
      </Show>
    </>
  );
}
