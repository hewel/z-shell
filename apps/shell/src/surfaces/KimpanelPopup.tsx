import { Button, For, LayerSurface, Show, createMemo, cx, type Accessor, type Monitor, type NativeChild } from "@hewel/zgui";
import { ShellIcon } from "../icons.tsx";
import { useShellStore } from "../store.ts";
import { useShellTheme } from "../theme.ts";
import { clampOverlayPosition, resolveMonitorLogicalSize, type DesktopImePanelSnapshot, type ImeLookupTable } from "../topics.ts";
import styles from "./KimpanelPopup.module.css";

const candidateHeight = 30;
const candidateGap = 4;

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
          <Button
            testId={`kimpanel-cand-${index}`}
            data-active={active() ? "true" : "false"}
            data-layout={props.vertical ? "vertical" : "horizontal"}
            onClick={() => void invokePublic("ime.select-candidate", { index })}
            class={styles.candidateButton}
          >
            <text
              data-tabular="true"
              data-active={active() ? "true" : "false"}
              class={styles.candidateIndex}
            >
              {props.table.labels[index] ?? String(index + 1)}
            </text>
            <text data-active={active() ? "true" : "false"} class={styles.candidateText}>
              {text()}
            </text>
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
  const table = () => props.panel().lookup_table;
  const preedit = createMemo(() => {
    // Kimpanel reports a Unicode code-point offset, not a UTF-16 string index.
    const { preedit: text, caret } = props.panel();
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
  const inlineHorizontalPager = () => !props.vertical() && hasPager() && props.panel().preedit.length > 0;
  const cursorLabel = () => {
    const count = table().texts.length;
    if (count === 0) return "";
    const cur = Math.max(0, Math.min(count - 1, table().cursor));
    return `${cur + 1}/${count}`;
  };

  return (
    <column
      testId="kimpanel-root"
      data-layout={props.vertical() ? "vertical" : "horizontal"}
      class={styles.card}
      style={{ width: `${props.width}px`, height: `${props.height}px` }}
      onWheel={event => {
        if (event.delta.y !== 0) page(event.delta.y > 0);
      }}
    >
      <Show when={props.panel().preedit.length > 0 || props.panel().aux.length > 0}>
        <column class={cx(styles.header, props.vertical() && table().texts.length > 0 && styles.headerVerticalWithCandidates)}>
          <Show when={props.panel().preedit.length > 0}>
            <row class={styles.preeditRow} data-inline-pager={inlineHorizontalPager() ? "true" : "false"}>
              <row testId="kimpanel-preedit" class={styles.preedit}>
                <text class={styles.preeditText}>{preedit().before}</text>
                <box ariaHidden class={styles.caret} />
                <text class={styles.preeditText}>{preedit().after}</text>
              </row>
              <Show when={inlineHorizontalPager()}>
                <row class={styles.pagerInlineRow}>
                  <Button
                    testId="kimpanel-prev"
                    ariaLabel="Previous candidate page"
                    disabled={!table().has_prev}
                    onClick={() => page(false)}
                    class={styles.pagerButton}
                  >
                    <ShellIcon name="chevronLeft" size={14} />
                  </Button>
                  <Button
                    testId="kimpanel-next"
                    ariaLabel="Next candidate page"
                    disabled={!table().has_next}
                    onClick={() => page(true)}
                    class={styles.pagerButton}
                  >
                    <ShellIcon name="chevronRight" size={14} />
                  </Button>
                </row>
              </Show>
              <Show when={props.vertical() && table().texts.length > 0}>
                <text data-tabular="true" class={styles.cursorLabel}>
                  {cursorLabel()}
                </text>
              </Show>
            </row>
          </Show>
          <Show when={props.panel().aux.length > 0}>
            <text testId="kimpanel-aux" class={styles.auxText}>{props.panel().aux}</text>
          </Show>
        </column>
      </Show>
      <Show when={table().texts.length > 0}>
        <scroll class={styles.candidatesScroll}>
          <Show when={props.vertical()} fallback={
            <row class={styles.candidatesList}><CandidateButtons table={table()} /></row>
          }>
            <column class={styles.candidatesList}><CandidateButtons table={table()} vertical /></column>
          </Show>
        </scroll>
      </Show>
      <Show when={hasPager() && !inlineHorizontalPager()}>
        <row class={styles.pagerBottomRow}>
          <Button
            testId="kimpanel-prev"
            ariaLabel="Previous candidate page"
            disabled={!table().has_prev}
            onClick={() => page(false)}
            class={styles.pagerButton}
          >
            <ShellIcon name="chevronLeft" size={14} />
          </Button>
          <Button
            testId="kimpanel-next"
            ariaLabel="Next candidate page"
            disabled={!table().has_next}
            onClick={() => page(true)}
            class={styles.pagerButton}
          >
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
