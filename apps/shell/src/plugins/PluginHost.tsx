import {
  For, PopupSurface, Show, createEffect, createSignal, getWindowRect, onCleanup, onSettled,
  type Component, type NativeChild, type NativeNode, type NativeWindowRect, type PopupSurfacePlacement,
} from "@hewel/zgui";
import { createEnterProgress, panelMotionStyle } from "../motion.ts";
import { useShellStore, type ShellStore } from "../store.ts";
import { useShellTheme } from "../theme.ts";
import { formatSurfaceName, resolveBarLayout, resolveBarPopupAnchor, type BarPosition } from "../topics.ts";
import { composedPlugins, type ComposedEntryInstanceDescriptor, type ComposedServiceDescriptor } from "./composed.ts";
import { startComposedPluginServices } from "./services.ts";

// The generated module exports the descriptors but does not need to know the host's bundle type.
export type ComposedPluginBundle = {
  readonly entryImports: Readonly<Record<string, Record<string, unknown>>>;
  readonly services: readonly ComposedServiceDescriptor[];
  readonly entryInstances: readonly ComposedEntryInstanceDescriptor[];
};

type ClientProps = { readonly client: ShellStore["publicClient"] };
type OpenPanel = (entryId?: string, anchor?: NativeNode) => void;
type WidgetProps = ClientProps & { readonly vertical: boolean; readonly onOpenPanel: OpenPanel };
type PanelProps = ClientProps & { readonly onClose: () => void };
type ActivePluginPanel = {
  readonly entryId: string;
  readonly instanceId: string;
  readonly outputId: string;
  readonly anchorRect: NativeWindowRect;
  readonly position: BarPosition;
  readonly Component: Component<PanelProps>;
};

const panelPlacement: Record<BarPosition, PopupSurfacePlacement> = {
  top: { anchor: "bottom-right", gravity: "bottom-left", flip: true, slide: true },
  left: { anchor: "right", gravity: "right", flip: true, slide: true },
  right: { anchor: "left", gravity: "left", flip: true, slide: true },
};

const panelOffset: Record<BarPosition, { readonly x: number; readonly y: number }> = {
  top: { x: 0, y: 8 },
  left: { x: 8, y: 0 },
  right: { x: -8, y: 0 },
};

function PluginPanelFrame(props: { theme: ShellStore["theme"]; position: BarPosition; children: NativeChild }): NativeChild {
  useShellTheme(props.theme.data);
  const progress = createEnterProgress();
  return (
    <box data-theme-rev={String(props.theme.revision())} style={{
      position: "fixed",
      left: "0px",
      top: "0px",
      width: "100%",
      height: "100%",
      borderRadius: "24px",
      backgroundColor: "var(--color-surface)",
      border: "1px solid var(--color-outline-variant)",
      overflow: "hidden",
      fontFamily: "system-ui",
      ...panelMotionStyle(progress(), props.position),
    }}>
      <scroll style={{ width: "100%", height: "100%", minHeight: "0px", overflow: "hidden auto" }}>
        {props.children}
      </scroll>
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

export function PluginHost(props?: { readonly bundle?: ComposedPluginBundle }): NativeChild {
  const bundle = props?.bundle ?? composedPlugins;
  if (bundle.entryInstances.length === 0 && bundle.services.length === 0) return null;

  const {
    publicClient, registerPluginBarWidget, monitors, outputs, settings, theme,
    activePluginPanelId, openPluginPanel, closePluginPanel, recordActiveMonitor,
  } = useShellStore();
  const [pluginPanelData, setPluginPanelData] = createSignal<ActivePluginPanel | null>(null);
  const panels = bundle.entryInstances.filter(instance => instance.kind === "panel");
  const activePluginPanel = () => {
    const activeId = activePluginPanelId();
    const data = pluginPanelData();
    return activeId !== null && data?.instanceId === activeId ? data : null;
  };
  const dismissPluginPanel = () => {
    closePluginPanel();
    setPluginPanelData(null);
  };

  if (bundle.services.length > 0) {
    createEffect(publicClient, client => {
      if (!client) return;
      return startComposedPluginServices(bundle, client);
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
    setPluginPanelData({
      entryId: panel.entryId,
      instanceId: panel.instanceId,
      outputId,
      anchorRect: resolveBarPopupAnchor(layout, {
        align: "end",
        targetRect: anchor ? getWindowRect(anchor) : null,
      }),
      position: layout.position,
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
          if (instance.kind !== "widget") return null;
          const WidgetComponent = entryComponent<WidgetProps>(bundle, instance);
          const register = (outputId: string) => {
            const onOpenPanel: OpenPanel = (entryId, anchor) => openPanel(instance, outputId, entryId, anchor);
            let unregister: (() => void) | undefined;
            onSettled(() => {
              unregister = registerPluginBarWidget({
                id: instance.instanceId,
                outputId,
                render: ({ vertical }) => <WidgetComponent client={publicClient} vertical={vertical} onOpenPanel={onOpenPanel} />,
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
      <Show when={activePluginPanel()} keyed>
        {({ instanceId, outputId, anchorRect, position, Component: PanelComponent }) => (
          <PopupSurface name={formatSurfaceName("plugin-panel", instanceId)} parent={formatSurfaceName("bar", outputId)} anchorRect={anchorRect}
            width={396} height={400} placement={panelPlacement[position]} offset={panelOffset[position]} grab onDismiss={dismissPluginPanel}>
            <PluginPanelFrame theme={theme} position={position}>
              <PanelComponent client={publicClient} onClose={dismissPluginPanel} />
            </PluginPanelFrame>
          </PopupSurface>
        )}
      </Show>
    </>
  );
}
