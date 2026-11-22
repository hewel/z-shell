import { For, PopupSurface, Show, createMemo, type NativeChild, type PopupSurfacePlacement } from "@hewel/zgui";
import { MenuItemPrimitive, MenuListPrimitive, MenuRootPrimitive } from "@hewel/zgui/primitives";
import { ShellIcon } from "../icons.tsx";
import { createRetainedPresence, panelMotionStyle, useMotionScheme, type M3Spring } from "../motion.ts";
import { useShellStore } from "../store.ts";
import { useShellTheme } from "../theme.ts";
import type { TrayMenuNode } from "../topics.ts";

const placement: PopupSurfacePlacement = { anchor: "bottom-right", gravity: "bottom-left", flip: true, slide: true };
const offset = { x: 0, y: 8 };
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

function PopupContent(props: {
  padding: string;
  label: string;
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
      <scroll data-theme-rev={String(theme.revision())} style={{
        width: "100%",
        height: "100%",
        overflow: "hidden auto",
        borderRadius: "16px",
        backgroundColor: "var(--color-surface-container)",
        border: "1px solid color-mix(in srgb, var(--color-outline-variant) 55%, transparent)",
        color: "var(--color-on-surface)",
        fontFamily: "var(--font-sans)",
        fontSize: "13px",
        ...panelMotionStyle(props.spatial(), "top", false, {
          opacity: props.opacity(),
          reduced: scheme() === "reduced",
        }),
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
  const { activeTrayMenu, closeTrayMenu, tray, activeImeMenu, closeImeMenu, ime, invokePublic } = useShellStore();
  const scheme = useMotionScheme();
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
  const imePresence = createRetainedPresence(activeImeMenu, {
    scheme,
    enterRole: "defaultSpatial",
    enterOpacityRole: "fastEffects",
    exitRole: "fastEffects",
  });
  const imeRowCount = createMemo(() => {
    const snapshot = ime.data();
    return snapshot ? snapshot.group_ims.length + snapshot.properties.length : 0;
  });

  return (
    <>
      <Show when={trayPresence.value()}>
        {item => (
          <PopupSurface name="tray-menu" parent={item().target.parentSurface} anchorRect={item().target.anchorRect}
            width={220} height={Math.min(340, Math.max(88, trayRows().length * 36 + 16))}
            placement={placement} offset={offset} grab onDismiss={() => { trayPresence.dismissInstant(); closeTrayMenu(); }}>
            <PopupContent padding="8px" label={item().label} spatial={trayPresence.progress} opacity={trayPresence.opacity}
              onDismiss={() => { trayPresence.dismissInstant(); closeTrayMenu(); }}>
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
            width={220} height={Math.min(340, Math.max(100, imeRowCount() * 36 + 24))}
            placement={placement} offset={offset} grab onDismiss={() => { imePresence.dismissInstant(); closeImeMenu(); }}>
            <PopupContent padding="12px 8px" label="Input method" spatial={imePresence.progress} opacity={imePresence.opacity}
              onDismiss={() => { imePresence.dismissInstant(); closeImeMenu(); }}>
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
