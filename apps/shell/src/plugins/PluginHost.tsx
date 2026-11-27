import {
  Errored, For, PopupSurface, Show, createEffect, createMemo, createSignal, cx, getWindowRect, onCleanup, onSettled, untrack,
  type Component, type NativeChild, type NativeNode, type NativeWindowRect,
} from "@hewel/zgui";
import { M3Button } from "@z-shell/sdk/primitives";
import { type PluginSettingsProps } from "@z-shell/sdk/zgui";
import { ShellIcon } from "../icons.tsx";
import {
  createRetainedPresence,
  panelMotionStyle,
  popoverContentMotionStyle,
  useMotionScheme,
  type M3Spring,
} from "../motion.ts";
import { POPOVER_SHADOW_INSETS, resolvePopoverGeometry, shellPanelsStyles } from "../panels/ShellPanels.tsx";
import { useShellStore, type ShellStore } from "../store.ts";
import { useShellTheme } from "../theme.ts";
import { PANEL_MAX_HEIGHTS, formatSurfaceName, isSessionLockActive, resolveBarLayout, resolveBarPopupAnchor, type BarPosition, type BarStyle } from "../topics.ts";
import { composedPlugins, type ComposedEntryInstanceDescriptor, type ComposedServiceDescriptor } from "./composed.ts";
import styles from "./PluginHost.module.css";
import { createComposedServiceController, type ComposedServiceController } from "./services.ts";

// The generated module exports the descriptors but does not need to know the host's bundle type.
export type ComposedPluginBundle = {
  readonly entryImports: Readonly<Record<string, Record<string, unknown>>>;
  readonly services: readonly ComposedServiceDescriptor[];
  readonly entryInstances: readonly ComposedEntryInstanceDescriptor[];
};

type ClientProps = { readonly client: ShellStore["publicClient"] };
type OpenPanel = (entryId?: string, anchor?: NativeNode) => void;
type WidgetProps = ClientProps & { readonly vertical: boolean; readonly onOpenPanel: OpenPanel };
type PanelProps = ClientProps & { readonly onClose: () => void; readonly onOpenSettings?: () => void };
export type PluginSettingsPageProps = PluginSettingsProps;
type ActivePluginPanel = {
  readonly panel: ComposedEntryInstanceDescriptor;
  readonly pluginId: string;
  readonly entryId: string;
  readonly instanceId: string;
  readonly outputId: string;
  readonly width: number;
  readonly anchorRect: NativeWindowRect;
  readonly position: BarPosition;
  readonly style: BarStyle;
};

const COMPACT_PLUGIN_PANEL_WIDTH = 360;
const STANDARD_PLUGIN_PANEL_WIDTH = 396;

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function GuardedPluginMount(props: {
  readonly instance: ComposedEntryInstanceDescriptor;
  readonly variant: "widget" | "card" | "layer";
  readonly vertical?: boolean;
  readonly onError: (instance: ComposedEntryInstanceDescriptor, error: unknown) => void;
  readonly onReset?: () => void;
  readonly render: () => NativeChild;
}): NativeChild {
  return (
    <Errored
      fallback={(err, reset) => {
        createEffect(err, currentErr => {
          props.onError(props.instance, currentErr);
        });
        if (props.variant === "layer") return null;
        if (props.variant === "widget") {
          return (
            <box
              testId={`plugin-error-${props.instance.instanceId}`}
              ariaLabel={`Plugin error: ${props.instance.entryId}`}
              data-vertical={props.vertical ? "true" : null}
              class={styles.widgetErrorBadge}
            >
              <ShellIcon name="warning" size={13} color="var(--color-on-error-container)" />
            </box>
          );
        }
        return (
          <column
            testId={`plugin-error-${props.instance.instanceId}`}
            class={styles.panelErrorCard}
          >
            <row class={styles.panelErrorHeader}>
              <ShellIcon name="warning" size={16} color="var(--color-on-error-container)" />
              <text class={styles.panelErrorTitle}>{`Plugin error · ${props.instance.entryId}`}</text>
            </row>
            <text class={styles.panelErrorMessage}>{formatErrorMessage(err())}</text>
            <row>
              <M3Button
                variant="neutral-tonal"
                size="sm"
                testId={`plugin-error-retry-${props.instance.instanceId}`}
                onClick={() => {
                  props.onReset?.();
                  reset();
                }}
              >
                <text>Retry</text>
              </M3Button>
            </row>
          </column>
        );
      }}
    >
      {props.render()}
    </Errored>
  );
}

function PluginPanelFrame(props: {
  theme: ShellStore["theme"];
  position: BarPosition;
  inert: boolean;
  spatial: M3Spring;
  opacity: M3Spring;
  cardRef?: (node: NativeNode) => void;
  children: NativeChild;
}): NativeChild {
  useShellTheme(() => props.theme.data());
  const scheme = useMotionScheme();
  return (
    <box inert={props.inert} class={shellPanelsStyles.popoverBleed}>
      <box
        ref={props.cardRef}
        testId="plugin-panel-root"
        data-theme-rev={String(props.theme.revision())}
        class={cx(shellPanelsStyles.popoverFrame, styles.pluginPanelFrame)}
        style={{
          ...panelMotionStyle(props.spatial(), props.position, false, {
            opacity: props.opacity(),
            reduced: scheme() === "reduced",
          }),
        }}
      >
        <scroll
          class={styles.pluginPanelScroll}
          style={popoverContentMotionStyle(props.spatial(), props.opacity(), scheme() === "reduced")}
        >
          {props.children}
        </scroll>
      </box>
    </box>
  );
}

function entryComponent<Props>(bundle: ComposedPluginBundle, instance: ComposedEntryInstanceDescriptor): Component<Props> {
  const component = bundle.entryImports[instance.importKey]?.default;
  if (typeof component !== "function") {
    throw new Error(`Plugin UI entry ${instance.entryId} must default-export a component`);
  }
  return component as Component<Props>;
}

function formatPluginTitle(pluginId: string, entryId: string): string {
  const slug = pluginId.includes("/") ? pluginId.slice(pluginId.indexOf("/") + 1) : entryId;
  return slug
    .split(/[-_:]+/)
    .filter(Boolean)
    .map(part => part.toLowerCase() === "ai" ? "AI" : part[0]!.toUpperCase() + part.slice(1))
    .join(" ");
}

function ActivePluginHost(props: { readonly bundle: ComposedPluginBundle }): NativeChild {
  const {
    publicClient, invokeHostResult, registerPluginBarWidget, registerPluginSettingsPage, pluginSettingsPages, openSettingsWindow,
    reportPluginRuntimeError, clearPluginRuntimeErrors,
    monitors, outputs, settings, theme, sessionLock,
    activePluginPanelId, overlayKind, barPopupGrab, togglePluginPanel, closePluginPanel, dismissBarPopupFromCompositor, recordActiveMonitor,
  } = useShellStore();
  const [pluginPanelData, setPluginPanelData] = createSignal<ActivePluginPanel | null>(null);
  let serviceController: ComposedServiceController | undefined;
  const panels = () => props.bundle.entryInstances.filter(instance => instance.kind === "panel");
  const scheme = useMotionScheme();
  const lockActive = () => isSessionLockActive(sessionLock.data());
  const reportEntryError = (instance: ComposedEntryInstanceDescriptor, error: unknown) => {
    reportPluginRuntimeError({
      pluginId: instance.pluginId,
      entryId: instance.entryId,
      instanceId: instance.instanceId,
      kind: instance.kind,
      message: formatErrorMessage(error),
    });
  };
  const activePluginPanel = createMemo(() => {
    if (lockActive()) return null;
    const activeId = activePluginPanelId();
    const data = pluginPanelData();
    return activeId !== null && data?.instanceId === activeId ? data : null;
  });
  const panelPresence = createRetainedPresence(activePluginPanel, {
    scheme,
    enterRole: "defaultSpatial",
    enterOpacityRole: "fastEffects",
    exitRole: "fastEffects",
    instantExit: () => lockActive() || (overlayKind() !== null && activePluginPanel() === null),
  });
  const mountedPanelKey = createMemo(() => {
    const entry = panelPresence.value();
    return entry ? `${entry.instanceId}:${entry.outputId}` : null;
  });
  const dismissPluginPanel = () => {
    closePluginPanel();
    setPluginPanelData(null);
  };
  const dismissPluginPanelInstant = () => {
    panelPresence.dismissInstant();
    dismissBarPopupFromCompositor("plugin");
    setPluginPanelData(null);
  };

  createEffect(
    () => (props.bundle.services.length > 0 ? publicClient() : undefined),
    client => {
      if (!client) {
        serviceController = undefined;
        return;
      }
      const controller = createComposedServiceController(props.bundle, client, (service, error) => {
        reportPluginRuntimeError({
          pluginId: service.pluginId,
          entryId: service.entryId,
          kind: "service",
          message: formatErrorMessage(error),
        });
      });
      serviceController = controller;
      return () => {
        if (serviceController === controller) serviceController = undefined;
        controller.dispose();
      };
    },
  );

  function openPanel(widget: ComposedEntryInstanceDescriptor, outputId: string, entryId?: string, anchor?: NativeNode): void {
    const monitor = monitors().find(candidate => candidate.id === outputId);
    if (!monitor) return;
    recordActiveMonitor(outputId);
    const targetEntryId = entryId !== undefined && !entryId.includes(":") ? `${widget.pluginId}:${entryId}` : entryId;
    let panel: ComposedEntryInstanceDescriptor | undefined;
    for (const candidate of panels()) {
      if (targetEntryId === undefined ? candidate.pluginId !== widget.pluginId : candidate.entryId !== targetEntryId) continue;
      if (candidate.outputId === outputId) {
        panel = candidate;
        break;
      }
      if (candidate.outputId === undefined) panel ??= candidate;
    }
    if (!panel) return;

    const layout = resolveBarLayout(settings.data()?.bar, monitor, outputs.data());
    const targetRect = anchor ? getWindowRect(anchor) : null;
    setPluginPanelData({
      panel,
      pluginId: panel.pluginId,
      entryId: panel.entryId,
      instanceId: panel.instanceId,
      outputId,
      width: panel.widthTier === "compact" ? COMPACT_PLUGIN_PANEL_WIDTH : STANDARD_PLUGIN_PANEL_WIDTH,
      anchorRect: resolveBarPopupAnchor(layout, {
        align: targetRect ? "target" : "end",
        targetRect,
      }),
      position: layout.position,
      style: layout.style,
    });
    if (!togglePluginPanel(panel.instanceId, outputId, panel.pluginId)) {
      setPluginPanelData(null);
    }
  }

  return (
    <>
      <For each={props.bundle.entryInstances}>
        {instance => {
          if (instance.kind === "layer") {
            return (
              <GuardedPluginMount
                instance={instance}
                variant="layer"
                onError={reportEntryError}
                render={() => {
                  const LayerComponent = entryComponent<ClientProps>(props.bundle, instance);
                  return <LayerComponent client={publicClient} />;
                }}
              />
            );
          }
          if (instance.kind === "settings_page") {
            const readSettings = async (): Promise<Readonly<Record<string, unknown>>> => {
              const res = await invokeHostResult("settings.get-plugin", { plugin_id: instance.pluginId });
              const data = res.ok ? (res.result.data as { settings?: Record<string, unknown> } | undefined) : undefined;
              return { ...instance.pluginSettings, ...(data?.settings ?? {}) };
            };
            const patchSettings = async (
              patch: Readonly<Record<string, unknown>>,
            ): Promise<Readonly<Record<string, unknown>> | undefined> => {
              const res = await invokeHostResult("settings.patch-plugin", {
                plugin_id: instance.pluginId,
                settings: patch,
              });
              if (!res.ok) return undefined;
              const data = res.result.data as { settings?: Record<string, unknown> } | undefined;
              const committed = data?.settings ?? patch;
              for (const svc of props.bundle.services) {
                if (svc.pluginId === instance.pluginId) {
                  clearPluginRuntimeErrors(instance.pluginId, svc.entryId);
                }
              }
              serviceController?.restartPlugin(instance.pluginId, committed);
              return committed;
            };
            let unregister: (() => void) | undefined;
            onSettled(() => {
              unregister = registerPluginSettingsPage({
                id: instance.instanceId,
                pluginId: instance.pluginId,
                title: formatPluginTitle(instance.pluginId, instance.entryId),
                render: () => (
                  <GuardedPluginMount
                    instance={instance}
                    variant="card"
                    onError={reportEntryError}
                    onReset={() => clearPluginRuntimeErrors(instance.pluginId, instance.instanceId)}
                    render={() => {
                      const SettingsComponent = entryComponent<PluginSettingsPageProps>(props.bundle, instance);
                      return (
                        <SettingsComponent
                          client={publicClient}
                          readSettings={readSettings}
                          patchSettings={patchSettings}
                        />
                      );
                    }}
                  />
                ),
              });
            });
            onCleanup(() => unregister?.());
            return null;
          }
          if (instance.kind !== "widget") return null;
          const register = (outputId: string) => {
            let slotNode: NativeNode | undefined;
            const onOpenPanel: OpenPanel = (entryId, anchor) => openPanel(instance, outputId, entryId, anchor ?? slotNode);
            let unregister: (() => void) | undefined;
            onSettled(() => {
              unregister = registerPluginBarWidget({
                id: instance.instanceId,
                pluginId: instance.pluginId,
                entryId: instance.entryId,
                ...(instance.instanceSlug !== undefined ? { instanceSlug: instance.instanceSlug } : {}),
                outputId,
                render: slotProps => (
                  <box
                    ref={node => { slotNode = node; }}
                    class={styles.widgetSlot}
                    data-vertical={slotProps.vertical ? "true" : null}
                  >
                    <GuardedPluginMount
                      instance={instance}
                      variant="widget"
                      vertical={slotProps.vertical}
                      onError={reportEntryError}
                      render={() => {
                        const WidgetComponent = entryComponent<WidgetProps>(props.bundle, instance);
                        return <WidgetComponent client={publicClient} vertical={slotProps.vertical} onOpenPanel={onOpenPanel} />;
                      }}
                    />
                  </box>
                ),
              });
            });
            onCleanup(() => unregister?.());
            return null;
          };
          if (instance.outputId !== undefined) return register(instance.outputId);
          // Slots only receive orientation. Bind one slot per output so a popup uses the bar that opened it.
          return <For each={monitors()} keyed={monitor => monitor.id}>{monitor => register(untrack(() => monitor().id))}</For>;
        }}
      </For>
      <Show when={mountedPanelKey()} keyed>
        {_key => {
          const initial = untrack(() => panelPresence.value()!);
          const initialGrab = untrack(barPopupGrab);
          const current = () => panelPresence.value() ?? initial;
          const { panel: panelInstance, pluginId, instanceId, outputId, width } = initial;
          const geometry = createMemo(() => resolvePopoverGeometry(current().position, current().style, false));
          const ownSettingsPage = () => pluginSettingsPages().find(page => page.pluginId === pluginId);
          const onOpenSettings = () => {
            const page = ownSettingsPage();
            dismissPluginPanel();
            openSettingsWindow(page ? page.id : "appearance");
          };
          const [cardNode, setCardNode] = createSignal<NativeNode | null>(null);
          return (
            <PopupSurface name={formatSurfaceName("plugin-panel", instanceId)} parent={formatSurfaceName("bar", outputId)} anchorRect={current().anchorRect}
              width={width} height="auto" minHeight={80} maxHeight={PANEL_MAX_HEIGHTS.plugin}
              geometryInsets={POPOVER_SHADOW_INSETS}
              inputRegion={cardNode() ? [cardNode()!] : []}
              placement={geometry().placement} offset={geometry().offset} grab={initialGrab} blurRegion={cardNode() ? [cardNode()!] : "none"} onDismiss={dismissPluginPanelInstant}>
              <PluginPanelFrame theme={theme} position={current().position} inert={!panelPresence.present()} spatial={panelPresence.progress} opacity={panelPresence.opacity} cardRef={setCardNode}>
                <GuardedPluginMount
                  instance={panelInstance}
                  variant="card"
                  onError={reportEntryError}
                  onReset={() => clearPluginRuntimeErrors(panelInstance.pluginId, panelInstance.instanceId)}
                  render={() => {
                    const PanelComponent = entryComponent<PanelProps>(props.bundle, panelInstance);
                    return <PanelComponent client={publicClient} onClose={dismissPluginPanel} onOpenSettings={onOpenSettings} />;
                  }}
                />
              </PluginPanelFrame>
            </PopupSurface>
          );
        }}
      </Show>
    </>
  );
}

export function PluginHost(props: { readonly bundle?: ComposedPluginBundle } = {}): NativeChild {
  const activeBundle = () => {
    const candidate = props.bundle ?? composedPlugins;
    return candidate.entryInstances.length > 0 || candidate.services.length > 0 ? candidate : null;
  };
  return (
    <Show when={activeBundle()} keyed>
      {bundle => <ActivePluginHost bundle={bundle} />}
    </Show>
  );
}
