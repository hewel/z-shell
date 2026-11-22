import {
  For, PopupSurface, Show, createEffect, createMemo, createSignal, getWindowRect, onCleanup, onSettled, untrack,
  type Component, type NativeChild, type NativeNode, type NativeWindowRect,
} from "@hewel/zgui";
import { type PluginSettingsProps } from "@z-shell/sdk/zgui";
import { createSingleNodeRoundedBlur } from "../blur.ts";
import {
  createRetainedPresence,
  panelMotionStyle,
  popoverContentMotionStyle,
  useMotionScheme,
  type M3Spring,
} from "../motion.ts";
import { POPOVER_BLEED_STYLE, POPOVER_FRAME_STYLE, POPOVER_SHADOW_INSETS, resolvePopoverGeometry } from "../panels/ShellPanels.tsx";
import { useShellStore, type ShellStore } from "../store.ts";
import { useShellTheme } from "../theme.ts";
import { PANEL_MAX_HEIGHTS, formatSurfaceName, resolveBarLayout, resolveBarPopupAnchor, type BarPosition, type BarStyle } from "../topics.ts";
import { composedPlugins, type ComposedEntryInstanceDescriptor, type ComposedServiceDescriptor } from "./composed.ts";
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
  readonly pluginId: string;
  readonly entryId: string;
  readonly instanceId: string;
  readonly outputId: string;
  readonly width: number;
  readonly anchorRect: NativeWindowRect;
  readonly position: BarPosition;
  readonly style: BarStyle;
  readonly Component: Component<PanelProps>;
};

const COMPACT_PLUGIN_PANEL_WIDTH = 360;
const STANDARD_PLUGIN_PANEL_WIDTH = 396;

function PluginPanelFrame(props: {
  theme: ShellStore["theme"];
  position: BarPosition;
  inert: boolean;
  spatial: M3Spring;
  opacity: M3Spring;
  cardRef?: (node: NativeNode) => void;
  blurRef?: (node: NativeNode) => void;
  children: NativeChild;
}): NativeChild {
  useShellTheme(props.theme.data);
  const scheme = useMotionScheme();
  return (
    <box inert={props.inert} style={POPOVER_BLEED_STYLE}>
      <box
        ref={node => {
          props.cardRef?.(node);
          props.blurRef?.(node);
        }}
        testId="plugin-panel-root"
        data-theme-rev={String(props.theme.revision())}
        style={{
          ...POPOVER_FRAME_STYLE,
          maxHeight: `${PANEL_MAX_HEIGHTS.plugin}px`,
          ...panelMotionStyle(props.spatial(), props.position, false, {
            opacity: props.opacity(),
            reduced: scheme() === "reduced",
          }),
        }}
      >
        <scroll style={{
          width: "100%",
          maxHeight: `${PANEL_MAX_HEIGHTS.plugin}px`,
          overflow: "hidden auto",
          ...popoverContentMotionStyle(props.spatial(), props.opacity(), scheme() === "reduced"),
        }}>
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

export function PluginHost(props?: { readonly bundle?: ComposedPluginBundle }): NativeChild {
  const bundle = props?.bundle ?? composedPlugins;
  if (bundle.entryInstances.length === 0 && bundle.services.length === 0) return null;

  const {
    publicClient, invokeHostResult, registerPluginBarWidget, registerPluginSettingsPage, pluginSettingsPages, openSettingsWindow,
    monitors, outputs, settings, theme,
    activePluginPanelId, openPluginPanel, closePluginPanel, recordActiveMonitor,
  } = useShellStore();
  const [pluginPanelData, setPluginPanelData] = createSignal<ActivePluginPanel | null>(null);
  let serviceController: ComposedServiceController | undefined;
  const panels = bundle.entryInstances.filter(instance => instance.kind === "panel");
  const scheme = useMotionScheme();
  const activePluginPanel = createMemo(() => {
    const activeId = activePluginPanelId();
    const data = pluginPanelData();
    return activeId !== null && data?.instanceId === activeId ? data : null;
  });
  const panelPresence = createRetainedPresence(activePluginPanel, {
    scheme,
    enterRole: "defaultSpatial",
    enterOpacityRole: "fastEffects",
    exitRole: "fastEffects",
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
    dismissPluginPanel();
  };

  if (bundle.services.length > 0) {
    createEffect(publicClient, client => {
      if (!client) {
        serviceController = undefined;
        return;
      }
      const controller = createComposedServiceController(bundle, client);
      serviceController = controller;
      return () => {
        if (serviceController === controller) serviceController = undefined;
        controller.dispose();
      };
    });
  }

  function openPanel(widget: ComposedEntryInstanceDescriptor, outputId: string, entryId?: string, anchor?: NativeNode): void {
    const monitor = monitors().find(candidate => candidate.id === outputId);
    if (!monitor) return;
    recordActiveMonitor(outputId);
    const targetEntryId = entryId !== undefined && !entryId.includes(":") ? `${widget.pluginId}:${entryId}` : entryId;
    let panel: ComposedEntryInstanceDescriptor | undefined;
    for (const candidate of panels) {
      if (targetEntryId === undefined ? candidate.pluginId !== widget.pluginId : candidate.entryId !== targetEntryId) continue;
      if (candidate.outputId === outputId) {
        panel = candidate;
        break;
      }
      if (candidate.outputId === undefined) panel ??= candidate;
    }
    if (!panel) return;

    if (activePluginPanelId() === panel.instanceId && pluginPanelData()?.outputId === outputId) {
      dismissPluginPanel();
      return;
    }

    const layout = resolveBarLayout(settings.data()?.bar, monitor, outputs.data());
    const targetRect = anchor ? getWindowRect(anchor) : null;
    setPluginPanelData({
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
      Component: entryComponent<PanelProps>(bundle, panel),
    });
    openPluginPanel(panel.instanceId, outputId);
  }

  return (
    <>
      <For each={bundle.entryInstances}>
        {instance => {
          if (instance.kind === "layer") {
            const LayerComponent = entryComponent<ClientProps>(bundle, instance);
            return <LayerComponent client={publicClient} />;
          }
          if (instance.kind === "settings_page") {
            const SettingsComponent = entryComponent<PluginSettingsPageProps>(bundle, instance);
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
                  <SettingsComponent
                    client={publicClient}
                    readSettings={readSettings}
                    patchSettings={patchSettings}
                  />
                ),
              });
            });
            onCleanup(() => unregister?.());
            return null;
          }
          if (instance.kind !== "widget") return null;
          const WidgetComponent = entryComponent<WidgetProps>(bundle, instance);
          const register = (outputId: string) => {
            let slotNode: NativeNode | undefined;
            const onOpenPanel: OpenPanel = (entryId, anchor) => openPanel(instance, outputId, entryId, anchor ?? slotNode);
            let unregister: (() => void) | undefined;
            onSettled(() => {
              unregister = registerPluginBarWidget({
                id: instance.instanceId,
                outputId,
                render: ({ vertical }) => (
                  <box
                    ref={node => { slotNode = node; }}
                    style={{ display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
                  >
                    <WidgetComponent client={publicClient} vertical={vertical} onOpenPanel={onOpenPanel} />
                  </box>
                ),
              });
            });
            onCleanup(() => unregister?.());
            return null;
          };
          if (instance.outputId !== undefined) return register(instance.outputId);
          // Slots only receive orientation. Bind one slot per output so a popup uses the bar that opened it.
          return <For each={monitors()} keyed={monitor => monitor.id}>{monitor => register(monitor().id)}</For>;
        }}
      </For>
      <Show when={mountedPanelKey()} keyed>
        {_key => {
          const initial = untrack(() => panelPresence.value()!);
          const current = () => panelPresence.value() ?? initial;
          const { pluginId, instanceId, outputId, width, Component: PanelComponent } = initial;
          const geometry = createMemo(() => resolvePopoverGeometry(current().position, current().style, false));
          const ownSettingsPage = () => pluginSettingsPages().find(page => page.pluginId === pluginId);
          const onOpenSettings = () => {
            const page = ownSettingsPage();
            dismissPluginPanel();
            openSettingsWindow(page ? page.id : "appearance");
          };
          const [cardNode, setCardNode] = createSignal<NativeNode | null>(null);
          const blur = createSingleNodeRoundedBlur(22, () => panelPresence.visible() && panelPresence.progress.settled());
          return (
            <PopupSurface name={formatSurfaceName("plugin-panel", instanceId)} parent={formatSurfaceName("bar", outputId)} anchorRect={current().anchorRect}
              width={width} height="auto" minHeight={80} maxHeight={PANEL_MAX_HEIGHTS.plugin}
              geometryInsets={POPOVER_SHADOW_INSETS}
              inputRegion={cardNode() ? [cardNode()!] : []}
              placement={geometry().placement} offset={geometry().offset} grab blurRegion={blur.region()} onDismiss={dismissPluginPanelInstant}>
              <PluginPanelFrame theme={theme} position={current().position} inert={!panelPresence.present()} spatial={panelPresence.progress} opacity={panelPresence.opacity} cardRef={setCardNode} blurRef={blur.ref}>
                <PanelComponent client={publicClient} onClose={dismissPluginPanel} onOpenSettings={onOpenSettings} />
              </PluginPanelFrame>
            </PopupSurface>
          );
        }}
      </Show>
    </>
  );
}
