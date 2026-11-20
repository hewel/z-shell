import { Button, For, LayerSurface, Show, createMemo, type Accessor, type Monitor, type NativeChild, type NativeStyle } from "@hewel/zgui";
import { ShojiIcon } from "../icons.tsx";
import { useShellStore } from "../store.ts";
import { useShellTheme } from "../theme.ts";
import { clampOverlayPosition, type DesktopImePanelSnapshot, type ImeLookupTable } from "../topics.ts";

const primary = "var(--color-primary)";
const onSurface = "var(--color-on-surface)";
const onSurfaceVariant = "var(--color-on-surface-variant)";
const card = {
  padding: "10px", gap: "8px", borderRadius: "16px",
  backgroundColor: "var(--color-surface)", border: "1px solid var(--color-outline-variant)",
  color: onSurface, fontFamily: "system-ui", fontSize: "13px", overflow: "hidden",
} satisfies NativeStyle;
const clippedText = { minWidth: "0px", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" } as const;
const candidateHeight = 30;
const candidateGap = 4;
const pagerButton = {
  display: "flex", width: "28px", height: "24px", alignItems: "center", justifyContent: "center",
  borderRadius: "8px", backgroundColor: "var(--color-surface-container)",
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
              height: `${candidateHeight}px`, padding: "0 8px", gap: "6px", borderRadius: "10px",
              backgroundColor: active() ? "var(--color-primary-container)" : "transparent",
              color: active() ? "var(--color-on-primary-container)" : onSurface,
            }}>
            <text style={{ fontWeight: 700, flexShrink: 0 }}>{props.table.labels[index] ?? String(index + 1)}</text>
            <text style={clippedText}>{text()}</text>
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

  return (
    <column testId="kimpanel-root" data-layout={props.vertical() ? "vertical" : "horizontal"}
      style={{ ...card, width: `${props.width}px`, height: `${props.height}px` }}
      onWheel={event => {
        if (event.delta.y !== 0) page(event.delta.y > 0);
      }}>
      <Show when={panel().preedit.length > 0 || panel().aux.length > 0}>
        <column style={{ gap: "4px", flexShrink: 0 }}>
          <Show when={panel().preedit.length > 0}>
            <row testId="kimpanel-preedit" style={{ height: "18px", alignItems: "center", overflow: "hidden" }}>
              <text style={clippedText}>{preedit().before}</text>
              <box ariaHidden style={{ width: "2px", height: "14px", flexShrink: 0, borderRadius: "1px", backgroundColor: primary }} />
              <text style={clippedText}>{preedit().after}</text>
            </row>
          </Show>
          <Show when={panel().aux.length > 0}>
            <text testId="kimpanel-aux" style={{ ...clippedText, height: "18px", color: onSurfaceVariant }}>{panel().aux}</text>
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
      <Show when={table().has_prev || table().has_next}>
        <row style={{ justifyContent: "flex-end", gap: "4px", flexShrink: 0 }}>
          <Button testId="kimpanel-prev" ariaLabel="Previous candidate page" disabled={!table().has_prev}
            onClick={() => page(false)} style={{ ...pagerButton, opacity: table().has_prev ? 1 : 0.4 }}>
            <ShojiIcon name="chevronLeft" size={14} />
          </Button>
          <Button testId="kimpanel-next" ariaLabel="Next candidate page" disabled={!table().has_next}
            onClick={() => page(true)} style={{ ...pagerButton, opacity: table().has_next ? 1 : 0.4 }}>
            <ShojiIcon name="chevronRight" size={14} />
          </Button>
        </row>
      </Show>
    </column>
  );
}

function PopupOnMonitor(props: { monitor: Monitor; panel: Accessor<DesktopImePanelSnapshot> }) {
  const { ime } = useShellStore();
  const vertical = () => {
    const hint = props.panel().lookup_table.layout;
    return (hint === "auto" ? ime.data()?.candidate_layout : hint) === "vertical";
  };
  const placement = createMemo(() => {
    const panel = props.panel();
    const table = panel.lookup_table;
    const monitor = props.monitor;
    const count = table.texts.length;
    const headerLines = Number(panel.preedit.length > 0) + Number(panel.aux.length > 0);
    const header = headerLines * 18 + (headerLines === 2 ? 4 : 0);
    const list = count === 0 ? 0 : vertical() ? count * (candidateHeight + candidateGap) - candidateGap : candidateHeight;
    const pager = table.has_prev || table.has_next ? 24 : 0;
    const sections = Number(header > 0) + Number(list > 0) + Number(pager > 0);
    const width = vertical() ? 260 : Math.max(180, Math.min(640, 22 + count * 96));
    const height = 22 + header + list + pager + Math.max(0, sections - 1) * 8;
    const popupWidth = Math.max(1, Math.min(width, monitor.width - 16));
    const popupHeight = Math.max(1, Math.min(height, monitor.height - 16));
    const pos = clampOverlayPosition(panel.spot_rect, popupWidth, popupHeight, monitor);
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
  const { ime, imePanel, monitors } = useShellStore();
  return (
    <Show when={ime.data()?.mode === "kimpanel" && monitors()[0]}>
      {monitor => (
        <Show when={imePanel.data()?.visible === true && imePanel.data()}>
          {panel => <PopupOnMonitor monitor={monitor()} panel={panel} />}
        </Show>
      )}
    </Show>
  );
}
