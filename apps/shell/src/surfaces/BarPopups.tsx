import { Button, For, Image, PopupSurface, Show, createEffect, createMemo, createSignal, cx, untrack, type NativeChild, type NativeNode } from "@hewel/zgui";
import { MenuItemPrimitive, MenuListPrimitive, MenuRootPrimitive } from "@hewel/zgui/primitives";
import { useDaemonMedia } from "@z-shell/sdk/zgui";
import { ShellIcon } from "../icons.tsx";
import { createRetainedPresence, panelMotionStyle, popoverContentMotionStyle, useMotionScheme, type M3Spring } from "../motion.ts";
import { POPOVER_SHADOW_INSETS, resolvePopoverGeometry, shellPanelsStyles } from "../panels/ShellPanels.tsx";
import { useShellStore, type ImeMenuTarget, type TrayMenuTarget, type TrayOverflowTarget } from "../store.ts";
import { useShellTheme } from "../theme.ts";
import { isImeTrayItem, partitionTrayItems, type BarPosition, type BarStyle, type TrayItem, type TrayMenuNode } from "../topics.ts";
import styles from "./BarPopups.module.css";

const MENU_MIN_WIDTH = 220;
const MENU_MAX_WIDTH = 360;
const MENU_MAX_HEIGHT = 520;
const TRAY_OVERFLOW_TILE_SIZE = 36;
const TRAY_OVERFLOW_GAP = 4;
const TRAY_OVERFLOW_PAD = 6;
const TRAY_OVERFLOW_MAX_COLS = 4;
const TRAY_OVERFLOW_MAX_HEIGHT = 240;

function resolveTrayOverflowWidth(count: number): number {
  const cols = Math.max(1, Math.min(TRAY_OVERFLOW_MAX_COLS, count));
  return 2 + TRAY_OVERFLOW_PAD * 2 + cols * TRAY_OVERFLOW_TILE_SIZE + (cols - 1) * TRAY_OVERFLOW_GAP;
}

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
  label: string;
  header?: string;
  cardTestId?: string;
  position: BarPosition;
  inert: boolean;
  spatial: M3Spring;
  opacity: M3Spring;
  cardRef?: (node: NativeNode) => void;
  onDismiss: () => void;
  children: NativeChild;
}) {
  const { theme } = useShellStore();
  useShellTheme(theme.data);
  const scheme = useMotionScheme();
  return (
    <MenuRootPrimitive open onDismiss={props.onDismiss}>
      <box inert={props.inert} class={shellPanelsStyles.popoverBleed}>
        <box
          ref={props.cardRef}
          testId={props.cardTestId ?? null}
          data-theme-rev={String(theme.revision())}
          data-radius="card"
          class={cx(shellPanelsStyles.popoverFrame, styles.menuCard)}
          style={{
            ...panelMotionStyle(props.spatial(), props.position, false, {
              opacity: props.opacity(),
              reduced: scheme() === "reduced",
            }),
          }}
        >
          <scroll
            class={styles.menuScroll}
            style={popoverContentMotionStyle(props.spatial(), props.opacity(), scheme() === "reduced")}
          >
            <MenuListPrimitive
              label={props.label}
              autoFocus
              dismissOnEscape
              dismissOnOutsidePress={false}
              dismissLayer={false}
              onDismiss={props.onDismiss}
              class={styles.menuList}
            >
              <Show when={props.header}>
                {title => (
                  <box ariaHidden class={styles.menuHeader}>
                    <text class={styles.menuHeaderText}>
                      {title().toUpperCase()}
                    </text>
                  </box>
                )}
              </Show>
              {props.children}
            </MenuListPrimitive>
          </scroll>
        </box>
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
  active?: boolean;
  submenu?: boolean;
  activate: () => void;
}) {
  const depthAttr = () => {
    const clamped = Math.min(props.depth ?? 0, 6);
    return clamped > 0 ? String(clamped) : null;
  };
  return (
    <MenuItemPrimitive
      testId={props.testId}
      role={props.toggle === "radio" ? "menuItemRadio" : props.toggle === "checkmark" ? "menuItemCheckBox" : "menuItem"}
      checked={props.toggle ? props.checked ?? false : null}
      disabled={props.disabled ?? false}
      data-active={props.active ? "true" : null}
      data-depth={depthAttr()}
      closeOnSelect={false}
      onSelect={() => { if (!props.disabled) props.activate(); }}
      class={styles.menuItem}
    >
      <box ariaHidden class={styles.menuIndicator}>
        <Show when={props.checked}>
          <Show
            when={props.toggle === "radio" || props.active}
            fallback={<ShellIcon name="check" size={14} color={props.active ? "var(--color-on-primary-container)" : "var(--color-primary)"} />}
          >
            <box class={styles.menuRadioDot} data-active={props.active ? "true" : null} />
          </Show>
        </Show>
      </box>
      <text class={styles.menuItemLabel}>{props.label}</text>
      <Show when={props.submenu}>
        <ShellIcon name="chevronRight" size={12} color={props.active ? "var(--color-on-primary-container)" : "var(--color-on-surface-variant)"} />
      </Show>
    </MenuItemPrimitive>
  );
}

function TrayOverflowTile(props: {
  readonly item: TrayItem;
  readonly overflowTarget: TrayOverflowTarget;
  readonly onExternalContextMenu: (itemId: string) => void;
}): NativeChild {
  const { hostClient, invokePublic, openTrayMenu } = useShellStore();
  const { src } = useDaemonMedia(hostClient, () => props.item.icon, { fetchCommand: "tray.fetch-blob" });
  const label = () => props.item.title?.trim() || props.item.app_id?.trim() || props.item.icon_name?.trim() || props.item.id;
  const fallbackLetter = () => {
    const first = Array.from(label())[0];
    return first && /^[\p{L}\p{N}]$/u.test(first) ? first.toUpperCase() : null;
  };
  let lastSecondaryMs = -1;
  const openMenuOnBar = () => {
    const { item } = props;
    const target = props.overflowTarget;
    if (item.menu) {
      // Bar-anchored handoff so tray-menu never anchors to the closing tray-overflow popup.
      openTrayMenu({
        itemId: item.id,
        ...(target.monitorId ? { monitorId: target.monitorId } : {}),
        parentSurface: target.parentSurface,
        anchorRect: target.anchorRect,
      });
    } else {
      props.onExternalContextMenu(item.id);
    }
  };
  const handleSecondary = (
    event: { preventDefault(): void; stopPropagation(): void },
    source: "pointer" | "context",
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const now = Date.now();
    if (source === "context" && lastSecondaryMs >= 0 && now - lastSecondaryMs < 150) {
      lastSecondaryMs = -1;
      return;
    }
    if (source === "pointer") {
      lastSecondaryMs = now;
    }
    openMenuOnBar();
  };
  return (
    <Button
      testId={`tray-overflow-item-${props.item.id}`}
      ariaLabel={label()}
      onClick={() => {
        if (props.item.item_is_menu && props.item.menu) {
          openMenuOnBar();
        } else {
          void invokePublic("tray.activate", { id: props.item.id });
        }
      }}
      onPointerDown={event => {
        if (event.button !== "secondary") return;
        handleSecondary(event, "pointer");
      }}
      onContextMenu={event => {
        handleSecondary(event, "context");
      }}
      class={styles.trayOverflowTile}
    >
      <box data-press-visual="compact" ariaHidden class={styles.trayOverflowVisual}>
        <Show when={src()} fallback={
          <Show when={fallbackLetter()} fallback={
            <box class={styles.trayFallbackIconBox}>
              <ShellIcon name="apps" size={14} color="var(--color-on-surface-variant)" />
            </box>
          }>
            {letter => (
              <box class={styles.trayFallbackLetterBox}>
                <text class={styles.trayFallbackLetterText}>{letter()}</text>
              </box>
            )}
          </Show>
        }>
          {image => <Image src={image()} class={styles.trayOverflowImage} />}
        </Show>
      </box>
    </Button>
  );
}

function TrayOverflowCard(props: {
  readonly overflowTarget: TrayOverflowTarget;
  readonly rows: readonly (readonly TrayItem[])[];
  readonly position: BarPosition;
  readonly inert: boolean;
  readonly spatial: M3Spring;
  readonly opacity: M3Spring;
  readonly cardRef: (node: NativeNode) => void;
  readonly onExternalContextMenu: (itemId: string) => void;
}): NativeChild {
  const { theme } = useShellStore();
  useShellTheme(theme.data);
  const scheme = useMotionScheme();
  return (
    <box inert={props.inert} class={shellPanelsStyles.popoverBleed}>
      <box
        ref={props.cardRef}
        testId="tray-overflow-card"
        data-theme-rev={String(theme.revision())}
        data-radius="card"
        class={cx(shellPanelsStyles.popoverFrame, styles.trayOverflowCard)}
        style={{
          ...panelMotionStyle(props.spatial(), props.position, false, {
            opacity: props.opacity(),
            reduced: scheme() === "reduced",
          }),
        }}
      >
        <box
          class={styles.trayOverflowContent}
          style={popoverContentMotionStyle(props.spatial(), props.opacity(), scheme() === "reduced")}
        >
          <scroll class={styles.trayOverflowScroll}>
            <column class={styles.trayOverflowGrid}>
              <For each={props.rows} keyed={row => row.map(i => i.id).join("|")}>
                {row => (
                  <row class={styles.trayOverflowRow}>
                    <For each={row()} keyed={item => item.id}>
                      {item => (
                        <TrayOverflowTile
                          item={item()}
                          overflowTarget={props.overflowTarget}
                          onExternalContextMenu={props.onExternalContextMenu}
                        />
                      )}
                    </For>
                  </row>
                )}
              </For>
            </column>
          </scroll>
        </box>
      </box>
    </box>
  );
}

type ActiveBarPopup =
  | {
      readonly kind: "tray-menu";
      readonly key: string;
      readonly target: TrayMenuTarget;
      readonly label: string;
      readonly menu: NonNullable<TrayItem["menu"]>;
    }
  | {
      readonly kind: "ime-menu";
      readonly key: string;
      readonly target: ImeMenuTarget;
    }
  | {
      readonly kind: "tray-overflow";
      readonly key: string;
      readonly target: TrayOverflowTarget;
    };

export function BarPopups(): NativeChild {
  const {
    overlayKind,
    barPopupGrab,
    dismissBarPopupFromCompositor,
    activeTrayMenu,
    closeTrayMenu,
    activeTrayOverflow,
    closeTrayOverflow,
    tray,
    ime,
    activeImeMenu,
    closeImeMenu,
    settings,
    invokePublic,
  } = useShellStore();
  const scheme = useMotionScheme();
  const [instantExitNext, setInstantExitNext] = createSignal(false);
  const position = (): BarPosition => settings.data()?.bar.position ?? "top";
  const barStyle = (): BarStyle => settings.data()?.bar.style ?? "floating";
  const geometry = createMemo(() => resolvePopoverGeometry(position(), barStyle(), false));
  const showImeIndicator = createMemo(() => Boolean(ime.data()?.available && ime.data()?.mode !== "disabled"));
  const collapsedTrayItems = createMemo(() => {
    const deduped = (tray.data()?.items ?? []).filter(item => !(showImeIndicator() && isImeTrayItem(item)));
    return partitionTrayItems(deduped, settings.data()?.bar.tray).collapsed;
  });
  createEffect(
    () => Boolean(activeTrayOverflow() && collapsedTrayItems().length === 0),
    shouldClose => {
      if (shouldClose) closeTrayOverflow();
    },
  );
  const overflowRows = createMemo(() => {
    const items = collapsedTrayItems();
    const rows: (readonly TrayItem[])[] = [];
    for (let i = 0; i < items.length; i += TRAY_OVERFLOW_MAX_COLS) {
      rows.push(items.slice(i, i + TRAY_OVERFLOW_MAX_COLS));
    }
    return rows;
  });
  const overflowWidth = createMemo(() => resolveTrayOverflowWidth(collapsedTrayItems().length));
  const activePopup = createMemo((): ActiveBarPopup | null => {
    const trayMenuTarget = activeTrayMenu();
    if (trayMenuTarget) {
      const item = tray.data()?.items.find(candidate => candidate.id === trayMenuTarget.itemId);
      if (item?.menu) {
        return {
          kind: "tray-menu",
          key: `tray-menu:${trayMenuTarget.itemId}:${trayMenuTarget.parentSurface}`,
          target: trayMenuTarget,
          label: item.title || item.id,
          menu: item.menu,
        };
      }
      return null;
    }
    const imeTarget = activeImeMenu();
    if (imeTarget) {
      return {
        kind: "ime-menu",
        key: `ime-menu:${imeTarget.parentSurface}`,
        target: imeTarget,
      };
    }
    const overflowTarget = activeTrayOverflow();
    if (overflowTarget && collapsedTrayItems().length > 0) {
      return {
        kind: "tray-overflow",
        key: `tray-overflow:${overflowTarget.parentSurface}`,
        target: overflowTarget,
      };
    }
    return null;
  });
  createEffect(
    () => activePopup() !== null,
    isOpen => {
      if (isOpen && instantExitNext()) setInstantExitNext(false);
    },
  );
  const presence = createRetainedPresence(activePopup, {
    scheme,
    enterRole: "defaultSpatial",
    enterOpacityRole: "fastEffects",
    exitRole: "fastEffects",
    instantExit: () => instantExitNext() || (overlayKind() !== null && activePopup() === null),
  });
  const mountedKey = createMemo(() => presence.value()?.key ?? null);
  const trayRows = createMemo(() => {
    const current = presence.value();
    return current?.kind === "tray-menu" ? visibleTrayRows(current.menu.root.children) : [];
  });
  const trayWidth = createMemo(() =>
    resolveMenuWidth(trayRows().map(row => ({ label: row.node.label ?? "", depth: row.depth, submenu: row.submenu }))),
  );
  const imeWidth = createMemo(() => {
    const snapshot = ime.data();
    const labels = [
      ...(snapshot?.group_ims.map(im => ({ label: im.label })) ?? []),
      ...(snapshot?.properties.map(prop => ({ label: prop.label })) ?? []),
    ];
    return resolveMenuWidth(labels);
  });
  const handleExternalContextMenu = (itemId: string) => {
    setInstantExitNext(true);
    closeTrayOverflow();
    void invokePublic("tray.context-menu", { id: itemId });
  };

  return (
    <Show when={mountedKey()} keyed>
      {_key => {
        const entry = untrack(() => presence.value()!);
        const initialGrab = untrack(barPopupGrab);
        const [cardNode, setCardNode] = createSignal<NativeNode | null>(null);

        if (entry.kind === "tray-menu") {
          const currentLabel = () => {
            const current = presence.value();
            return current?.kind === "tray-menu" ? current.label : entry.label;
          };
          return (
            <PopupSurface name="tray-menu" parent={entry.target.parentSurface} anchorRect={entry.target.anchorRect}
              width={trayWidth()} height="auto" minHeight={48} maxHeight={MENU_MAX_HEIGHT}
              geometryInsets={POPOVER_SHADOW_INSETS}
              inputRegion={cardNode() ? [cardNode()!] : []}
              placement={geometry().placement} offset={geometry().offset} grab={initialGrab} blurRegion={cardNode() ? [cardNode()!] : "none"}
              onDismiss={() => { presence.dismissInstant(); dismissBarPopupFromCompositor("tray"); }}>
              <PopupContent label={currentLabel()} header={currentLabel()} cardTestId="tray-menu-card" position={position()} inert={!presence.present()} spatial={presence.progress} opacity={presence.opacity}
                cardRef={setCardNode} onDismiss={closeTrayMenu}>
                <For each={trayRows()} keyed={row => row.node.id}>
                  {row => (
                    <Show when={!row().node.separator} fallback={<box ariaHidden class={styles.separator} />}>
                      <MenuButton testId={`tray-menu-item-${row().node.id}`} label={row().node.label ?? ""} depth={row().depth}
                        disabled={!row().enabled} toggle={row().node.toggle_type} checked={row().node.toggle_state === 1} submenu={row().submenu}
                        activate={() => {
                          void invokePublic("tray.menu-item", { id: entry.target.itemId, menu_id: row().node.id });
                          closeTrayMenu();
                        }} />
                    </Show>
                  )}
                </For>
              </PopupContent>
            </PopupSurface>
          );
        }

        if (entry.kind === "ime-menu") {
          return (
            <PopupSurface name="ime-menu" parent={entry.target.parentSurface} anchorRect={entry.target.anchorRect}
              width={imeWidth()} height="auto" minHeight={48} maxHeight={MENU_MAX_HEIGHT}
              geometryInsets={POPOVER_SHADOW_INSETS}
              inputRegion={cardNode() ? [cardNode()!] : []}
              placement={geometry().placement} offset={geometry().offset} grab={initialGrab} blurRegion={cardNode() ? [cardNode()!] : "none"}
              onDismiss={() => { presence.dismissInstant(); dismissBarPopupFromCompositor("ime"); }}>
              <PopupContent label="Input method" header="Input method" cardTestId="ime-menu-card" position={position()} inert={!presence.present()} spatial={presence.progress} opacity={presence.opacity}
                cardRef={setCardNode} onDismiss={closeImeMenu}>
                <For each={ime.data()?.group_ims} keyed={im => im.unique_name}>
                  {im => {
                    const isActive = () => im().unique_name === ime.data()?.active_im?.unique_name;
                    return (
                      <MenuButton testId={`ime-im-${im().unique_name}`} label={im().label}
                        toggle="radio" checked={isActive()} active={isActive()}
                        activate={() => {
                          void invokePublic("ime.set-im", { unique_name: im().unique_name });
                          closeImeMenu();
                        }} />
                    );
                  }}
                </For>
                <Show when={(ime.data()?.group_ims.length ?? 0) > 0 && (ime.data()?.properties.length ?? 0) > 0}>
                  <box ariaHidden class={styles.separator} />
                </Show>
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
          );
        }

        return (
          <PopupSurface name="tray-overflow" parent={entry.target.parentSurface} anchorRect={entry.target.anchorRect}
            width={overflowWidth()} height="auto" minHeight={50} maxHeight={TRAY_OVERFLOW_MAX_HEIGHT}
            geometryInsets={POPOVER_SHADOW_INSETS}
            inputRegion={cardNode() ? [cardNode()!] : []}
            placement={geometry().placement} offset={geometry().offset} grab={initialGrab} blurRegion={cardNode() ? [cardNode()!] : "none"}
            onDismiss={() => { presence.dismissInstant(); dismissBarPopupFromCompositor("tray-overflow"); }}>
            <TrayOverflowCard
              overflowTarget={entry.target}
              rows={overflowRows()}
              position={position()}
              inert={!presence.present()}
              spatial={presence.progress}
              opacity={presence.opacity}
              cardRef={setCardNode}
              onExternalContextMenu={handleExternalContextMenu}
            />
          </PopupSurface>
        );
      }}
    </Show>
  );
}
