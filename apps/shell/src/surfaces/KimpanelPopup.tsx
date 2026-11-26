import { Button, For, LayerSurface, Show, createMemo, type Accessor, type Monitor, type NativeChild, type NativeStyle } from "@hewel/zgui";
import { ShellIcon } from "../icons.tsx";
import { useShellStore } from "../store.ts";
import { useShellTheme } from "../theme.ts";
import { clampOverlayPosition, resolveMonitorLogicalSize, type DesktopImePanelSnapshot, type ImeLookupTable } from "../topics.ts";

const primary = "var(--color-primary)";
const onSurface = "var(--color-on-surface)";
const onSurfaceVariant = "var(--color-on-surface-variant)";
const card = {
  padding: "10px 12px", gap: "8px", borderRadius: "16px",
  backgroundColor: "var(--surface-popover)",
  border: "1px solid var(--border-popover)",
  color: onSurface, fontFamily: "var(--font-sans)", fontSize: "13px", overflow: "hidden",
} satisfies NativeStyle;
const clippedText = { minWidth: "0px", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" } as const;
const candidateHeight = 30;
const candidateGap = 4;
const pagerButton = {
  display: "flex", width: "26px", height: "24px", alignItems: "center", justifyContent: "center",
  borderRadius: "8px", backgroundColor: "var(--color-surface-container-high)", flexShrink: 0,
} satisfies NativeStyle;

function CandidateButtons(props: {
  table: ImeLookupTable;
  vertical?: boolean;
}) {
  const { invokePublic } = useShellStore();
  return (
    <For each={props.table.texts} keyed={false}>
      {(text, index) => {
        const active = () => index === props.table.cursor;
        return (
          <Button testId={`kimpanel-cand-${index}`} data-active={active() ? "true" : "false"}
            onClick={() => void invokePublic("ime.select-candidate", { index })} style={{
              display: "flex", alignItems: "center", justifyContent: "flex-start", flexShrink: 0,
              flexGrow: props.vertical ? 0 : 1, flexBasis: props.vertical ? "auto" : "0px", minWidth: props.vertical ? "0px" : "72px",
              height: `${candidateHeight}px`, padding: "0 10px", gap: "8px", borderRadius: "10px",
              backgroundColor: active() ? "var(--color-primary-container)" : "transparent",
              border: active() ? "1px solid color-mix(in srgb, var(--color-primary) 30%, transparent)" : "1px solid transparent",
              color: active() ? "var(--color-on-primary-container)" : onSurface,
            }}>
            <text data-tabular="true" style={{
              fontFamily: "var(--font-mono)", fontSize: "11px", fontWeight: active() ? 700 : 500, flexShrink: 0,
              fontVariantNumeric: "tabular-nums",
              color: active() ? "var(--color-on-primary-container)" : onSurfaceVariant,
            }}>
              {props.table.labels[index] ?? String(index + 1)}
            </text>
            <text style={{ ...clippedText, fontWeight: active() ? 600 : 400 }}>{text()}</text>
          </Button>
        );
      }}
    </For>
  );
}

function CandidateCard(props: {
  panel: Accessor<DesktopImePanelSnapshot>;
  vertical: Accessor<boolean>;
  width: number;
  height: number;
}) {
  const { theme, invokePublic } = useShellStore();
  useShellTheme(theme.data);
  const panel = props.panel;
  const table = () => panel().lookup_table;
  const preedit = createMemo(() => {
    // Kimpanel reports a Unicode code-point offset, not a UTF-16 string index.
    const { preedit: text, caret } = panel();
    let offset = 0;
    let remaining = caret;
    for (const char of text) {
      if (remaining-- <= 0) break;
      offset += char.length;
    }
    return { before: text.slice(0, offset), after: text.slice(offset) };
  });
  const page = (down: boolean) => void invokePublic(down ? "ime.page-down" : "ime.page-up", {});
  const hasPager = () => table().has_prev || table().has_next;
  const inlineHorizontalPager = () => !props.vertical() && hasPager() && panel().preedit.length > 0;
  const cursorLabel = () => {
    const count = table().texts.length;
    if (count === 0) return "";
    const cur = Math.max(0, Math.min(count - 1, table().cursor));
    return `${cur + 1}/${count}`;
  };

  return (
    <column testId="kimpanel-root" data-layout={props.vertical() ? "vertical" : "horizontal"}
      style={{ ...card, width: `${props.width}px`, height: `${props.height}px` }}
      onWheel={event => {
        if (event.delta.y !== 0) page(event.delta.y > 0);
      }}>
      <Show when={panel().preedit.length > 0 || panel().aux.length > 0}>
        <column style={{
          gap: "4px",
          flexShrink: 0,
          ...(props.vertical() && table().texts.length > 0
            ? {
                paddingBottom: "4px",
                borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 35%, transparent)",
              }
            : {}),
        }}>
          <Show when={panel().preedit.length > 0}>
            <row style={{ alignItems: "center", justifyContent: "space-between", gap: "8px", minHeight: inlineHorizontalPager() ? "24px" : "20px" }}>
              <row testId="kimpanel-preedit" style={{ flexGrow: 1, flexBasis: "0px", minWidth: "0px", height: "20px", alignItems: "center", overflow: "hidden" }}>
                <text style={{ ...clippedText, fontWeight: 500 }}>{preedit().before}</text>
                <box ariaHidden style={{ width: "2px", height: "14px", flexShrink: 0, borderRadius: "1px", backgroundColor: primary }} />
                <text style={{ ...clippedText, fontWeight: 500 }}>{preedit().after}</text>
              </row>
              <Show when={inlineHorizontalPager()}>
                <row style={{ alignItems: "center", gap: "4px", flexShrink: 0 }}>
                  <Button testId="kimpanel-prev" ariaLabel="Previous candidate page" disabled={!table().has_prev}
                    onClick={() => page(false)} style={{ ...pagerButton, opacity: table().has_prev ? 1 : 0.4 }}>
                    <ShellIcon name="chevronLeft" size={14} />
                  </Button>
                  <Button testId="kimpanel-next" ariaLabel="Next candidate page" disabled={!table().has_next}
                    onClick={() => page(true)} style={{ ...pagerButton, opacity: table().has_next ? 1 : 0.4 }}>
                    <ShellIcon name="chevronRight" size={14} />
                  </Button>
                </row>
              </Show>
              <Show when={props.vertical() && table().texts.length > 0}>
                <text data-tabular="true" style={{
                  fontFamily: "var(--font-mono)", fontSize: "11px", color: onSurfaceVariant,
                  fontVariantNumeric: "tabular-nums", flexShrink: 0,
                }}>
                  {cursorLabel()}
                </text>
              </Show>
            </row>
          </Show>
          <Show when={panel().aux.length > 0}>
            <text testId="kimpanel-aux" style={{ ...clippedText, height: "18px", fontSize: "12px", color: onSurfaceVariant }}>{panel().aux}</text>
          </Show>
        </column>
      </Show>
      <Show when={table().texts.length > 0}>
        <scroll style={{ flexGrow: 1, flexBasis: "0px", minHeight: "0px", overflow: "auto" }}>
          <Show when={props.vertical()} fallback={
            <row style={{ gap: `${candidateGap}px` }}><CandidateButtons table={table()} /></row>
          }>
            <column style={{ gap: `${candidateGap}px` }}><CandidateButtons table={table()} vertical /></column>
          </Show>
        </scroll>
      </Show>
      <Show when={hasPager() && !inlineHorizontalPager()}>
        <row style={{ justifyContent: "flex-end", gap: "4px", flexShrink: 0 }}>
          <Button testId="kimpanel-prev" ariaLabel="Previous candidate page" disabled={!table().has_prev}
            onClick={() => page(false)} style={{ ...pagerButton, opacity: table().has_prev ? 1 : 0.4 }}>
            <ShellIcon name="chevronLeft" size={14} />
          </Button>
          <Button testId="kimpanel-next" ariaLabel="Next candidate page" disabled={!table().has_next}
            onClick={() => page(true)} style={{ ...pagerButton, opacity: table().has_next ? 1 : 0.4 }}>
            <ShellIcon name="chevronRight" size={14} />
          </Button>
        </row>
      </Show>
    </column>
  );
}

function PopupOnMonitor(props: { monitor: Monitor; panel: Accessor<DesktopImePanelSnapshot> }) {
  const { ime, outputs } = useShellStore();
  const vertical = () => {
    const hint = props.panel().lookup_table.layout;
    return (hint === "auto" ? ime.data()?.candidate_layout : hint) === "vertical";
  };
  const placement = createMemo(() => {
    const panel = props.panel();
    const table = panel.lookup_table;
    const size = resolveMonitorLogicalSize(props.monitor, outputs.data());
    const count = table.texts.length;
    const hasPager = table.has_prev || table.has_next;
    const inlineHorizontalPager = !vertical() && hasPager && panel.preedit.length > 0;
    const preeditH = panel.preedit.length > 0 ? (inlineHorizontalPager ? 24 : 20) : 0;
    const auxH = panel.aux.length > 0 ? 18 : 0;
    const baseHeader = preeditH + auxH + (preeditH > 0 && auxH > 0 ? 4 : 0);
    const header = baseHeader + (vertical() && baseHeader > 0 && count > 0 ? 5 : 0);
    const list = count === 0 ? 0 : vertical() ? count * (candidateHeight + candidateGap) - candidateGap : candidateHeight;
    const pager = hasPager && !inlineHorizontalPager ? 24 : 0;
    const sections = Number(header > 0) + Number(list > 0) + Number(pager > 0);
    const width = vertical() ? 240 : Math.max(200, Math.min(640, 26 + count * 96));
    const height = 22 + header + list + pager + Math.max(0, sections - 1) * 8;
    const popupWidth = Math.max(1, Math.min(width, size.width - 16));
    const popupHeight = Math.max(1, Math.min(height, size.height - 16));
    const pos = clampOverlayPosition(panel.spot_rect, popupWidth, popupHeight, size);
    return { popupWidth, popupHeight, margin: { top: Math.round(pos.y), left: Math.round(pos.x) } };
  });

  return (
    <LayerSurface name="kimpanel-popup" output={props.monitor.id} layer="overlay" anchor={["top", "left"]}
      margin={placement().margin} width={placement().popupWidth} height={placement().popupHeight} keyboard="none">
      <CandidateCard panel={props.panel} vertical={vertical} width={placement().popupWidth} height={placement().popupHeight} />
    </LayerSurface>
  );
}

export function KimpanelPopup(): NativeChild {
  const { activeMonitor, ime, imePanel, monitors } = useShellStore();
  const targetMonitorId = () => ime.data()?.mode === "kimpanel" && imePanel.data()?.visible === true
    ? activeMonitor()?.id
    : undefined;
  return (
    <Show when={targetMonitorId()} keyed>
      {output => (
        <Show when={monitors().find(candidate => candidate.id === output)}>
          {monitor => (
            <Show when={imePanel.data()?.visible === true && imePanel.data()}>
              {panel => <PopupOnMonitor monitor={monitor()} panel={panel} />}
            </Show>
          )}
        </Show>
      )}
    </Show>
  );
}
