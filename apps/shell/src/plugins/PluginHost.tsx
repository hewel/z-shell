import {
  For, PopupSurface, Show, createSignal, getWindowRect, onCleanup, onSettled,
  type Component, type NativeChild, type NativeNode, type NativeWindowRect, type PopupSurfacePlacement,
} from "@hewel/zgui";
import { useShellStore, type ShellStore } from "../store.ts";
import { resolveBarLayout, type BarPosition } from "../topics.ts";
import { composedPlugins, type ComposedEntryInstanceDescriptor, type ComposedServiceDescriptor } from "./composed.ts";

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

function entryComponent<Props>(bundle: ComposedPluginBundle, instance: ComposedEntryInstanceDescriptor): Component<Props> {
  const component = bundle.entryImports[instance.importKey]?.default;
  if (typeof component !== "function") {
    throw new Error(`Plugin UI entry ${instance.entryId} must default-export a component`);
  }
  return component as Component<Props>;
}

export function PluginHost(props?: { readonly bundle?: ComposedPluginBundle }): NativeChild {
  const bundle = props?.bundle ?? composedPlugins;
  if (bundle.entryInstances.length === 0) return null;

  const { publicClient, registerPluginBarWidget, monitors, settings, closePanels } = useShellStore();
  const [activePluginPanel, setActivePluginPanel] = createSignal<ActivePluginPanel | null>(null);
  const panels = bundle.entryInstances.filter(instance => instance.kind === "panel");
  const closePluginPanel = () => setActivePluginPanel(null);

  function openPanel(widget: ComposedEntryInstanceDescriptor, outputId: string, entryId?: string, anchor?: NativeNode): void {
    const monitor = monitors().find(candidate => candidate.id === outputId);
    if (!monitor) return;
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

    const { position, width, height } = resolveBarLayout(settings.data()?.bar, monitor);
    closePanels();
    setActivePluginPanel({
      entryId: panel.entryId,
      instanceId: panel.instanceId,
      outputId,
      anchorRect: (anchor && getWindowRect(anchor)) || { x: width - 1, y: height - 1, width: 1, height: 1 },
      position,
      Component: entryComponent<PanelProps>(bundle, panel),
    });
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
          <PopupSurface name={`plugin-panel-${instanceId}`} parent={`bar-${outputId}`} anchorRect={anchorRect}
            width={396} height={400} placement={panelPlacement[position]} grab onDismiss={closePluginPanel}>
            <PanelComponent client={publicClient} onClose={closePluginPanel} />
          </PopupSurface>
        )}
      </Show>
    </>
  );
}
