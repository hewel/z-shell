import {
  Button,
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  cx,
  focus,
  getWindowRect,
  observeGeometry,
  type NativeChild,
  type NativeEvent,
  type NativeKeyEvent,
  type NativeNode,
  type NativeStyle,
} from "@hewel/zgui";
import { RadioGroupPrimitive, RadioItemPrimitive } from "@hewel/zgui/primitives";
import { SPRING_EPSILON } from "./motion.ts";
import { createM3Spring, createPresence, useGlobalMotionScheme } from "./zgui-motion.ts";
import styles from "./zgui-primitives.module.css";

const CHECK_ICON_PATH = "M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z";

export type M3ButtonVariant = "filled" | "accent-tonal" | "neutral-tonal" | "outlined" | "text" | "destructive";
export type M3ButtonSize = "md" | "sm";

export interface M3ButtonProps {
  readonly variant?: M3ButtonVariant;
  readonly size?: M3ButtonSize;
  readonly neutral?: boolean;
  readonly danger?: boolean;
  readonly selected?: boolean;
  readonly disabled?: boolean;
  readonly testId?: string;
  readonly ariaLabel?: string;
  readonly ref?: (node: NativeNode) => void;
  readonly class?: string;
  readonly style?: NativeStyle;
  readonly onClick?: (event: NativeEvent) => void;
  readonly children?: NativeChild;
}

export function M3Button(props: M3ButtonProps): NativeChild {
  return (
    <Button
      testId={props.testId ?? null}
      ariaLabel={props.ariaLabel ?? null}
      selected={props.selected ?? null}
      disabled={props.disabled ?? false}
      {...(props.ref ? { ref: props.ref } : {})}
      {...(props.onClick ? { onClick: props.onClick } : {})}
      class={cx(styles.button, props.class)}
      data-variant={props.variant ?? "accent-tonal"}
      data-size={props.size ?? "md"}
      data-neutral={props.neutral ? "true" : null}
      data-danger={props.danger ? "true" : null}
      {...(props.style !== undefined ? { style: props.style } : {})}
    >
      <row class={styles.pressInner}>{props.children}</row>
    </Button>
  );
}

export type M3IconButtonVariant = "standard" | "filled-tonal" | "filled" | "outlined";

export interface M3IconButtonProps {
  readonly variant?: M3IconButtonVariant;
  readonly size?: "md" | "sm";
  readonly selected?: boolean;
  readonly disabled?: boolean;
  readonly ariaLabel: string;
  readonly testId?: string;
  readonly ref?: (node: NativeNode) => void;
  readonly class?: string;
  readonly style?: NativeStyle;
  readonly onClick?: (event: NativeEvent) => void;
  readonly children?: NativeChild;
}

export function M3IconButton(props: M3IconButtonProps): NativeChild {
  return (
    <Button
      testId={props.testId ?? null}
      ariaLabel={props.ariaLabel}
      selected={props.selected ?? false}
      disabled={props.disabled ?? false}
      {...(props.ref ? { ref: props.ref } : {})}
      {...(props.onClick ? { onClick: props.onClick } : {})}
      class={cx(styles.iconButton, props.class)}
      data-variant={props.variant ?? "filled-tonal"}
      data-size={props.size ?? "md"}
      data-selected={props.selected ? "true" : null}
      {...(props.style !== undefined ? { style: props.style } : {})}
    >
      <box class={styles.pressInner}>{props.children}</box>
    </Button>
  );
}

export interface M3SwitchProps {
  readonly checked: boolean;
  readonly ariaLabel: string;
  readonly disabled?: boolean;
  readonly testId?: string;
  readonly onToggle: () => void;
}

/**
 * Material Design 3 Desktop Switch (`44×24px`, `14px` off thumb -> `18px` on thumb with `11px` check,
 * `20px` press stretch via `fast.spatial`, and `material-web` v0.192 disabled semantics).
 */
export function M3Switch(props: M3SwitchProps): NativeChild {
  const scheme = useGlobalMotionScheme();
  const [pressed, setPressed] = createSignal(false);
  const progress = createM3Spring(() => (props.checked ? 1 : 0), "fastSpatial", { scheme });
  const stretch = createM3Spring(() => (pressed() && !props.disabled ? 1 : 0), "fastSpatial", { scheme });

  const thumbHeight = () => 14 + Math.max(0, Math.min(1, progress())) * 4;
  const thumbWidth = () => {
    const base = thumbHeight();
    return base + Math.max(0, Math.min(1, stretch())) * (20 - base);
  };
  // Track inner content box is 41x21 (44x24 minus 1.5px border each side):
  // Off: 14px thumb at 3.5px inner (5px outer). On: 18px thumb at 21.5px inner (23px outer, 3px right inset).
  const thumbLeft = () => {
    const t = Math.max(0, Math.min(1, progress()));
    const w = thumbWidth();
    const minLeft = 3.5;
    const maxLeft = 41 - 1.5 - w;
    return minLeft + t * (maxLeft - minLeft);
  };
  const checkOpacity = () => Math.max(0, Math.min(1, (progress() - 0.35) / 0.65));
  const checkColor = () => (
    props.disabled
      ? "color-mix(in srgb, var(--color-on-surface) var(--disabled-ink), transparent)"
      : "var(--color-on-primary-container)"
  );

  const handleKeyDown = (event: NativeKeyEvent) => {
    if (props.disabled) return;
    if (event.key === " " || event.key === "Spacebar" || event.key === "Enter") {
      event.preventDefault();
      props.onToggle();
    }
  };

  return (
    <control
      role="switch"
      tabIndex={props.disabled ? -1 : 0}
      testId={props.testId ?? null}
      data-switch-root="true"
      data-checked={props.checked ? "true" : null}
      ariaLabel={props.ariaLabel}
      checked={props.checked}
      disabled={props.disabled ?? false}
      class={styles.switchTrack}
      onPointerDown={event => {
        if (!props.disabled && event.primary) setPressed(true);
      }}
      onPointerUp={() => { if (pressed()) setPressed(false); }}
      onPointerCancel={() => { if (pressed()) setPressed(false); }}
      onKeyDown={handleKeyDown}
      onClick={() => { if (!props.disabled) props.onToggle(); }}
    >
      <box
        ariaHidden
        data-switch-thumb="true"
        data-checked={props.checked ? "true" : null}
        data-disabled={props.disabled ? "true" : null}
        class={styles.switchThumb}
        style={{
          left: `${thumbLeft().toFixed(2)}px`,
          width: `${thumbWidth().toFixed(2)}px`,
          height: `${thumbHeight().toFixed(2)}px`,
        }}
      >
        <Show when={props.checked || checkOpacity() > 0.05}>
          <vector
            ariaHidden
            viewBox="0 0 24 24"
            d={CHECK_ICON_PATH}
            style={{
              width: "11px",
              height: "11px",
              opacity: checkOpacity(),
              "--zgui-fill": checkColor(),
            }}
          />
        </Show>
      </box>
    </control>
  );
}

const clampPercent = (value: number): number => Math.max(0, Math.min(100, value));

export interface M3SliderProps {
  readonly label: string;
  readonly value: number;
  readonly disabled?: boolean;
  readonly compact?: boolean;
  readonly readOnly?: boolean;
  readonly step?: number;
  readonly testId?: string;
  readonly onDraggingChange?: (dragging: boolean) => void;
  readonly onChange?: (value: number) => void;
}

/**
 * Material Design 3 Expressive Desktop Slider (`10px` track, `4×20px` vertical handle narrowing to
 * `2.5×22px` on drag, explicit `4px` transparent gaps flanking the handle, `4×4px` trailing stop dot).
 */
export function M3Slider(props: M3SliderProps): NativeChild {
  const scheme = useGlobalMotionScheme();
  const [dragging, setDragging] = createSignal(false);
  const [focused, setFocused] = createSignal(false);
  const value = () => clampPercent(props.value);
  const animatedValue = createM3Spring(value, "fastSpatial", { scheme, epsilon: SPRING_EPSILON.px });
  const step = () => props.step ?? 5;

  const setDrag = (next: boolean) => {
    if (dragging() !== next) {
      setDragging(next);
      props.onDraggingChange?.(next);
    }
  };

  const change = (next: number, direct = false) => {
    if (props.readOnly || props.disabled || !props.onChange) return;
    const percent = clampPercent(Math.round(next));
    if (direct) animatedValue.jump(percent);
    if (percent !== Math.round(props.value)) props.onChange(percent);
  };

  const pointerToPercent = (clientX: number, rect: { readonly x: number; readonly width: number }): number => {
    const inset = 2;
    const travel = rect.width - inset * 2;
    return travel > 0
      ? ((clientX - rect.x - inset) * 100) / travel
      : ((clientX - rect.x) * 100) / rect.width;
  };

  const displayValue = () => clampPercent(animatedValue());
  const showActive = () => displayValue() > 0.5;
  const showInactive = () => displayValue() < 99.5;
  const showStopDot = () => displayValue() < 95;
  const interactive = () => !props.readOnly && !props.disabled;

  createEffect(interactive, canInteract => {
    if (!canInteract) setFocused(false);
  });

  return (
    <box
      testId={props.testId ?? null}
      role={props.readOnly ? "progressIndicator" : "slider"}
      data-slider={props.readOnly ? null : "true"}
      data-progress={props.readOnly ? "true" : null}
      tabIndex={interactive() ? 0 : -1}
      disabled={props.disabled ?? false}
      ariaLabel={props.label}
      ariaValueMin={0}
      ariaValueMax={100}
      ariaValueNow={Math.round(value())}
      ariaValueStep={props.readOnly ? null : step()}
      class={styles.sliderLane}
      onFocus={() => {
        if (interactive()) setFocused(true);
      }}
      onBlur={() => setFocused(false)}
      onPointerDown={event => {
        if (!interactive() || !event.primary || !(event.button === "primary" || (event.button === null && event.pointerKind !== "mouse"))) return;
        const rect = getWindowRect(event.currentTarget);
        if (!rect || rect.width <= 0) return;
        focus(event.currentTarget);
        setDrag(true);
        change(pointerToPercent(event.position.x, rect), false);
      }}
      onPointerMove={event => {
        if (!dragging() || !interactive() || !event.primary) return;
        const rect = getWindowRect(event.currentTarget);
        if (!rect || rect.width <= 0) return;
        change(pointerToPercent(event.position.x, rect), true);
      }}
      onPointerUp={() => setDrag(false)}
      onPointerCancel={() => setDrag(false)}
      onWheel={event => {
        if (!interactive() || !focused()) return;
        const delta = event.delta.y || event.delta.x;
        if (!delta) return;
        event.preventDefault();
        change(value() - Math.sign(delta) * step(), false);
      }}
      onKeyDown={event => {
        if (!interactive()) return;
        switch (event.key) {
          case "ArrowUp": case "ArrowRight": change(value() + step(), false); break;
          case "ArrowDown": case "ArrowLeft": change(value() - step(), false); break;
          case "Home": change(0, false); break;
          case "End": change(100, false); break;
          default: return;
        }
        event.preventDefault();
      }}
    >
      <Show when={showActive()}>
        <box
          ariaHidden
          data-percent-fill="true"
          data-compact={props.compact ? "true" : null}
          data-disabled={props.disabled ? "true" : null}
          class={styles.sliderActiveTrack}
          style={{ flexGrow: displayValue() }}
        />
      </Show>
      <box
        ariaHidden
        data-slider-thumb="true"
        data-dragging={dragging() ? "true" : null}
        data-disabled={props.disabled ? "true" : null}
        class={styles.sliderHandle}
      />
      <Show when={showInactive()}>
        <box
          ariaHidden
          data-compact={props.compact ? "true" : null}
          data-disabled={props.disabled ? "true" : null}
          class={styles.sliderInactiveTrack}
          style={{ flexGrow: Math.max(0.01, 100 - displayValue()) }}
        >
          <Show when={showStopDot()}>
            <box ariaHidden data-disabled={props.disabled ? "true" : null} class={styles.sliderStopDot} />
          </Show>
        </box>
      </Show>
    </box>
  );
}

export interface M3SliderRowProps {
  readonly label: string;
  readonly value: number;
  readonly valueLabel?: string;
  readonly disabled?: boolean;
  readonly compact?: boolean;
  readonly step?: number;
  readonly sliderTestId?: string;
  readonly iconLabel?: string;
  readonly onIconClick?: () => void;
  readonly leadingIcon: (state: { readonly dragging: boolean; readonly disabled: boolean }) => NativeChild;
  readonly onChange: (value: number) => void;
  readonly trailing?: NativeChild;
  readonly showTrailingSlot?: boolean;
}

export function M3SliderRow(props: M3SliderRowProps): NativeChild {
  const [dragging, setDragging] = createSignal(false);
  const disabled = () => props.disabled === true;

  return (
    <row class={styles.sliderRow}>
      <Show
        when={props.onIconClick}
        fallback={
          <box
            ariaHidden
            class={styles.sliderIconWell}
            data-dragging={dragging() ? "true" : null}
            data-disabled={disabled() ? "true" : null}
          >
            {props.leadingIcon({ dragging: dragging(), disabled: disabled() })}
          </box>
        }
      >
        <Button
          ariaLabel={props.iconLabel ?? props.label}
          disabled={disabled()}
          onClick={() => props.onIconClick?.()}
          class={styles.sliderIconWell}
          data-dragging={dragging() ? "true" : null}
          data-disabled={disabled() ? "true" : null}
        >
          {props.leadingIcon({ dragging: dragging(), disabled: disabled() })}
        </Button>
      </Show>
      <M3Slider
        label={props.label}
        value={props.value}
        disabled={disabled()}
        compact={props.compact ?? false}
        {...(props.step !== undefined ? { step: props.step } : {})}
        {...(props.sliderTestId !== undefined ? { testId: props.sliderTestId } : {})}
        onDraggingChange={setDragging}
        onChange={props.onChange}
      />
      <row class={styles.sliderValue}>
        <text
          data-tabular="true"
          data-dragging={dragging() ? "true" : null}
          data-disabled={disabled() ? "true" : null}
          class={styles.sliderValueText}
        >
          {props.valueLabel ?? `${Math.round(clampPercent(props.value))}%`}
        </text>
      </row>
      <Show when={props.showTrailingSlot !== false}>
        {props.trailing ?? <box ariaHidden style={{ width: "26px", height: "26px", flexShrink: 0 }} />}
      </Show>
    </row>
  );
}

export interface M3SegmentedOption<T extends string = string> {
  readonly id: T;
  readonly label: string;
  readonly testId?: string;
  readonly disabled?: boolean;
}

export interface M3SegmentedControlProps<T extends string = string> {
  readonly options: readonly M3SegmentedOption<T>[];
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly ariaLabel: string;
  readonly compact?: boolean;
  readonly recessed?: "container" | "surface";
  readonly style?: NativeStyle;
  readonly class?: string;
}

/**
 * Tonal Track Segmented Control (`docs/design/components.md §2.7`):
 * recessed `10px` track + `fast.spatial` sliding `8px` `primary-container` pill backed by
 * headless `RadioGroupPrimitive` / `RadioItemPrimitive` roving tabindex navigation.
 */
export function M3SegmentedControl<T extends string = string>(props: M3SegmentedControlProps<T>): NativeChild {
  const scheme = useGlobalMotionScheme();
  const activeIndex = createMemo(() => {
    const idx = props.options.findIndex(opt => opt.id === props.value);
    return idx >= 0 ? idx : 0;
  });
  const animatedIndex = createM3Spring(activeIndex, "fastSpatial", { scheme, epsilon: 0.005 });
  const segmentWidthPct = () => (props.options.length > 0 ? 100 / props.options.length : 100);

  return (
    <RadioGroupPrimitive
      orientation="horizontal"
      value={props.value}
      onValueChange={next => props.onChange(next as T)}
      ariaLabel={props.ariaLabel}
      class={cx(styles.segmentedTrack, props.class)}
      data-compact={props.compact ? "true" : null}
      data-recessed={props.recessed ?? "container"}
      {...(props.style !== undefined ? { style: props.style } : {})}
    >
      <box ariaHidden class={styles.segmentedRail}>
        <box
          ariaHidden
          class={styles.segmentedIndicator}
          style={{
            width: `${segmentWidthPct().toFixed(4)}%`,
            transform: `translateX(${(animatedIndex() * 100).toFixed(3)}%)`,
          }}
        />
      </box>
      <For each={props.options} keyed={option => option.id}>
        {option => {
          const selected = () => option().id === props.value;
          return (
            <RadioItemPrimitive
              value={option().id}
              testId={option().testId ?? null}
              disabled={option().disabled ?? false}
              class={styles.segmentedItem}
              data-selected={selected() ? "true" : null}
            >
              <row class={styles.pressInner}>
                <text>{option().label}</text>
              </row>
            </RadioItemPrimitive>
          );
        }}
      </For>
    </RadioGroupPrimitive>
  );
}

export interface M3FilterChipProps {
  readonly label: string;
  readonly count?: number;
  readonly selected: boolean;
  readonly disabled?: boolean;
  readonly testId?: string;
  readonly onClick: () => void;
}

/** Material Design 3 Desktop Filter Chip (`28px`, `8px` radius, `0px` selected border + spring check reveal). */
export function M3FilterChip(props: M3FilterChipProps): NativeChild {
  const scheme = useGlobalMotionScheme();
  const checkPop = createM3Spring(() => (props.selected ? 1 : 0), "fastSpatial", { scheme });

  return (
    <Button
      testId={props.testId ?? null}
      selected={props.selected}
      disabled={props.disabled ?? false}
      onClick={props.onClick}
      class={styles.filterChip}
      data-selected={props.selected ? "true" : null}
    >
      <row class={styles.pressInner} style={{ gap: "5px" }}>
        <Show when={props.selected}>
          <vector
            ariaHidden
            viewBox="0 0 24 24"
            d={CHECK_ICON_PATH}
            style={{
              width: "14px",
              height: "14px",
              "--zgui-fill": "var(--color-on-primary-container)",
              transform: scheme() === "reduced" ? "none" : `scale(${(0.75 + Math.max(0, Math.min(1.12, checkPop())) * 0.25).toFixed(4)})`,
            }}
          />
        </Show>
        <text>{props.label}</text>
        <Show when={props.count !== undefined}>
          <text data-tabular="true" style={{ fontFamily: "var(--font-mono)", fontSize: "11px", fontVariantNumeric: "tabular-nums" }}>
            {props.count}
          </text>
        </Show>
      </row>
    </Button>
  );
}

export interface M3CollapsibleProps {
  readonly open: boolean;
  readonly estimatedHeight?: number;
  readonly children: NativeChild;
}

/**
 * Clip-Height Spring Expansion primitive (`docs/design/motion.md §5.9`):
 * animates outer clip height `0 <-> measuredHeight` via `fastSpatial` with `createPresence` exit
 * retention, inner `-4px -> 0` glide + delayed opacity ramp, and zero displacement in `reduced` mode.
 */
export function M3Collapsible(props: M3CollapsibleProps): NativeChild {
  const scheme = useGlobalMotionScheme();
  const presence = createPresence(() => props.open, {
    scheme,
    enterRole: "fastSpatial",
    enterOpacityRole: "fastEffects",
    exitRole: "fastEffects",
  });
  const [innerNode, setInnerNode] = createSignal<NativeNode | null>(null);
  const [measuredHeight, setMeasuredHeight] = createSignal(props.estimatedHeight ?? 64);

  createEffect(() => [presence.mounted(), innerNode()] as const, ([mounted, node]) => {
    if (!mounted || !node) return;
    const rect = getWindowRect(node);
    if (rect && rect.height > 1) setMeasuredHeight(Math.ceil(rect.height));
    return observeGeometry(node, "borderSize", size => {
      if (size.height > 1) setMeasuredHeight(Math.ceil(size.height));
    });
  });

  const clipStyle = (): NativeStyle => {
    const p = Math.max(0, Math.min(1, presence.progress()));
    const reduced = scheme() === "reduced";
    const settledOpen = props.open && presence.progress.settled() && p >= 0.99;
    return {
      width: "100%",
      overflow: "hidden",
      ...(settledOpen || reduced ? {} : { height: `${(p * measuredHeight()).toFixed(2)}px` }),
    };
  };

  const innerStyle = (): NativeStyle => {
    const p = Math.max(0, Math.min(1.04, presence.progress()));
    const rawOpacity = Math.max(0, Math.min(1, presence.opacity()));
    const reduced = scheme() === "reduced";
    const opacity = reduced ? rawOpacity : Math.max(0, Math.min(1, (rawOpacity - 0.14) / 0.86));
    return {
      width: "100%",
      opacity,
      transform: reduced ? "none" : `translateY(${((1 - p) * -4).toFixed(2)}px)`,
    };
  };

  return (
    <Show when={presence.mounted()} fallback={<box style={{ display: "none" }} />}>
      <box inert={!props.open} style={clipStyle()}>
        <box ref={setInnerNode} style={innerStyle()}>
          {props.children}
        </box>
      </box>
    </Show>
  );
}

export interface M3LinearProgressProps {
  readonly value: number;
  readonly compact?: boolean;
  readonly tone?: "primary" | "error";
  readonly ariaLabel?: string;
  readonly testId?: string;
}

/** Material Design 3 Expressive Linear Progress (`4px–6px` bar + `4px` gap + trailing `4px` stop dot). */
export function M3LinearProgress(props: M3LinearProgressProps): NativeChild {
  const clamped = () => clampPercent(props.value);
  const showActive = () => clamped() > 0.5;
  const showInactive = () => clamped() < 99.5;
  const showStopDot = () => clamped() < 95;

  return (
    <box
      testId={props.testId ?? null}
      role="progressIndicator"
      ariaLabel={props.ariaLabel ?? null}
      ariaValueMin={0}
      ariaValueMax={100}
      ariaValueNow={Math.round(clamped())}
      class={styles.linearProgress}
      data-compact={props.compact ? "true" : null}
    >
      <Show when={showActive()}>
        <box
          ariaHidden
          data-percent-fill="true"
          data-tone={props.tone ?? "primary"}
          class={styles.linearProgressActive}
          style={{ flexGrow: clamped() }}
        />
      </Show>
      <Show when={showInactive()}>
        <box
          ariaHidden
          class={styles.linearProgressInactive}
          style={{ flexGrow: Math.max(0.01, 100 - clamped()) }}
        >
          <Show when={showStopDot()}>
            <box ariaHidden class={styles.sliderStopDot} />
          </Show>
        </box>
      </Show>
    </box>
  );
}

export interface M3DialogShellProps {
  readonly testId: string;
  readonly ariaLabel: string;
  readonly error?: boolean;
  readonly centered?: boolean;
  readonly ref?: (node: NativeNode) => void;
  readonly style?: NativeStyle;
  readonly badge?: {
    readonly tone?: "accent" | "destructive";
    readonly icon: NativeChild;
  };
  readonly children: NativeChild;
}

export function M3DialogShell(props: M3DialogShellProps): NativeChild {
  return (
    <column
      testId={props.testId}
      role="dialog"
      ariaLabel={props.ariaLabel}
      ariaModal
      {...(props.ref ? { ref: props.ref } : {})}
      onClick={event => event.stopPropagation()}
      class={styles.dialogCard}
      data-error={props.error ? "true" : null}
      style={{
        ...(props.centered ? { alignItems: "center" } : {}),
        ...(typeof props.style === "object" && props.style !== null ? props.style : {}),
      }}
    >
      <Show when={props.badge}>
        {badge => (
          <box ariaHidden class={styles.dialogBadge} data-tone={badge().tone ?? "accent"}>
            {badge().icon}
          </box>
        )}
      </Show>
      {props.children}
    </column>
  );
}

export interface M3InteractiveCardProps {
  readonly layout?: "row" | "column";
  readonly testId?: string | null;
  readonly actionTestId?: string | null;
  readonly ariaLabel?: string | null;
  readonly selected?: boolean;
  readonly expanded?: boolean;
  readonly disabled?: boolean;
  readonly inert?: boolean;
  readonly ref?: (node: NativeNode) => void;
  readonly class?: string;
  readonly style?: NativeStyle;
  readonly onClick?: ((event: NativeEvent) => void) | undefined;
  readonly children?: NativeChild;
}

/**
 * Full-card interactive container using a stretched sibling hit layer so M3
 * :hover/:active state layers fill the entire outer rounded card (including
 * superellipse corners) without negative-margin "box-in-box" clipping.
 * Wrap independent secondary controls inside `<M3CardAction>` so hovering them
 * hits only the secondary control without double-highlighting the card.
 */
export function M3InteractiveCard(props: M3InteractiveCardProps): NativeChild {
  const interactive = () => (props.onClick !== undefined ? "true" : null);
  const className = () => cx(styles.interactiveCard, props.class);
  const renderHitLayer = () => (
    <Show when={props.onClick !== undefined}>
      <Button
        testId={props.actionTestId ?? null}
        ariaLabel={props.ariaLabel ?? null}
        selected={props.selected ?? null}
        expanded={props.expanded ?? null}
        disabled={props.disabled ?? false}
        onClick={event => props.onClick?.(event)}
        class={styles.interactiveCardHit}
      />
    </Show>
  );

  if (props.layout === "row") {
    return (
      <row
        testId={props.testId ?? null}
        data-interactive={interactive()}
        {...(props.inert !== undefined ? { inert: props.inert } : {})}
        {...(props.ref ? { ref: props.ref } : {})}
        class={className()}
        {...(props.style !== undefined ? { style: props.style } : {})}
      >
        {renderHitLayer()}
        {props.children}
      </row>
    );
  }

  return (
    <column
      testId={props.testId ?? null}
      data-interactive={interactive()}
      {...(props.inert !== undefined ? { inert: props.inert } : {})}
      {...(props.ref ? { ref: props.ref } : {})}
      class={className()}
      {...(props.style !== undefined ? { style: props.style } : {})}
    >
      {renderHitLayer()}
      {props.children}
    </column>
  );
}

export interface M3CardActionProps {
  readonly layout?: "box" | "row" | "column";
  readonly class?: string;
  readonly style?: NativeStyle;
  readonly children?: NativeChild;
}

/** Elevates a secondary interactive control above `M3InteractiveCard`'s hit layer. */
export function M3CardAction(props: M3CardActionProps): NativeChild {
  const className = () => cx(styles.interactiveCardAction, props.class);
  if (props.layout === "row") {
    return (
      <row class={className()} {...(props.style !== undefined ? { style: props.style } : {})}>
        {props.children}
      </row>
    );
  }
  if (props.layout === "column") {
    return (
      <column class={className()} {...(props.style !== undefined ? { style: props.style } : {})}>
        {props.children}
      </column>
    );
  }
  return (
    <box class={className()} {...(props.style !== undefined ? { style: props.style } : {})}>
      {props.children}
    </box>
  );
}
