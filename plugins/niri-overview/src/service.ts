import { definePlugin, type PluginDefinition } from "@z-shell/plugin-api";
import { scheduleNiriRetry } from "./socket.ts";

export { createNiriSocketTransport } from "./socket.ts";

export type NiriOverviewConfig = {
  zoom_scale: number;
  max_queue_depth: number;
};

export interface NiriOutput {
  readonly name: string;
  readonly width: number;
  readonly height: number;
}

export interface NiriWorkspace {
  readonly id: number;
  readonly index: number;
  readonly output: string | null;
  readonly active: boolean;
  readonly focused: boolean;
}

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface NiriWindow {
  readonly id: number;
  readonly workspaceId: number | null;
  readonly title?: string;
  readonly appId?: string;
  readonly floating: boolean;
  readonly focused: boolean;
  /** Logical pixels relative to the workspace; null when not drawable in the current view. */
  readonly geometry: Rect | null;
}

export interface NiriState {
  readonly outputs: readonly NiriOutput[];
  readonly workspaces: readonly NiriWorkspace[];
  readonly windows: readonly NiriWindow[];
}

export type NiriEvent =
  | { readonly type: "OutputsChanged"; readonly outputs: NiriState["outputs"] }
  | { readonly type: "WorkspacesChanged"; readonly workspaces: NiriState["workspaces"] }
  | { readonly type: "WorkspaceActivated"; readonly id: number; readonly focused: boolean }
  | { readonly type: "WindowsChanged"; readonly windows: NiriState["windows"] }
  | { readonly type: "WindowOpenedOrChanged"; readonly window: NiriWindow }
  | { readonly type: "WindowClosed"; readonly id: number }
  | { readonly type: "WindowFocusChanged"; readonly id: number | null }
  | { readonly type: "WindowLayoutsChanged"; readonly changes: ReadonlyMap<number, Rect | null> };

type Cancel = () => void;
type ScheduleRetry = (delayMs: number, cb: () => void) => Cancel | undefined;

export interface NiriSocketTransport {
  isAvailable(): boolean | Promise<boolean>;
  /** The baseline of the active stream. The coordinator buffers events until this resolves. */
  requestSnapshot(): Promise<NiriState>;
  /** Subscribe before backfill; cancel retires the stream and any pending backfill. */
  subscribeEvents(onEvent: (event: NiriEvent) => void, onDisconnect: () => void): Cancel;
}

interface WindowViewportLayout extends Rect {
  readonly id: number;
  readonly title?: string;
  readonly appId?: string;
  readonly floating: boolean;
  readonly focused: boolean;
}

export interface WorkspaceViewportLayout extends Rect {
  readonly output: string;
  readonly workspaceId: number;
  readonly index: number;
  readonly active: boolean;
  readonly focused: boolean;
  readonly windows: readonly WindowViewportLayout[];
}

export interface NiriOverviewSnapshot {
  readonly capability: "available" | "unsupported" | "disconnected";
  readonly resetting: boolean;
  readonly open: boolean;
  readonly outputs: readonly NiriOutput[];
  readonly layouts: readonly WorkspaceViewportLayout[];
}

function unit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function compareOutput(left: NiriOutput, right: NiriOutput): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

/**
 * Each output gets its own normalized canvas, one output-high row per workspace.
 * Zoom shrinks each row's viewport about its center. Window rectangles are clipped
 * to that workspace viewport, so a scrolled-away window has zero drawable area.
 */
export function computeOverviewLayouts(
  outputs: readonly NiriOutput[], workspaces: readonly NiriWorkspace[], windows: readonly NiriWindow[], zoomScale: number,
): WorkspaceViewportLayout[] {
  const zoom = Math.max(0.25, Math.min(1, zoomScale));
  const inset = (1 - zoom) / 2;
  const byOutput = new Map<string, NiriWorkspace[]>();
  const byWorkspace = new Map<number, NiriWindow[]>();
  for (const workspace of workspaces) {
    if (workspace.output === null) continue;
    const group = byOutput.get(workspace.output);
    if (group) group.push(workspace);
    else byOutput.set(workspace.output, [workspace]);
  }
  for (const window of windows) {
    if (window.workspaceId === null) continue;
    const group = byWorkspace.get(window.workspaceId);
    if (group) group.push(window);
    else byWorkspace.set(window.workspaceId, [window]);
  }
  const layouts: WorkspaceViewportLayout[] = [];
  for (const output of [...outputs].sort(compareOutput)) {
    const group = byOutput.get(output.name);
    if (!group || !(output.width > 0 && output.height > 0)) continue;
    group.sort((a, b) => a.index - b.index || a.id - b.id);
    const height = zoom / group.length;
    for (const [row, workspace] of group.entries()) {
      const y = (row + inset) / group.length;
      const tiles = byWorkspace.get(workspace.id) ?? [];
      tiles.sort((a, b) => Number(a.floating) - Number(b.floating) || a.id - b.id);
      layouts.push({
        output: output.name, workspaceId: workspace.id, index: workspace.index,
        active: workspace.active, focused: workspace.focused, x: inset, y, width: zoom, height,
        windows: tiles.map(({ id, title, appId, floating, focused, geometry }) => {
          const left = geometry ? unit(geometry.x / output.width) : 0;
          const top = geometry ? unit(geometry.y / output.height) : 0;
          const right = geometry ? unit((geometry.x + geometry.width) / output.width) : left;
          const bottom = geometry ? unit((geometry.y + geometry.height) / output.height) : top;
          return {
            id, ...(title !== undefined ? { title } : {}), ...(appId !== undefined ? { appId } : {}),
            floating, focused, x: inset + left * zoom, y: y + top * height,
            width: Math.max(0, right - left) * zoom, height: Math.max(0, bottom - top) * height,
          };
        }),
      });
    }
  }
  return layouts;
}

class Model {
  outputs: NiriState["outputs"];
  workspaces: NiriState["workspaces"];
  readonly windows = new Map<number, NiriWindow>();

  constructor(state: NiriState) {
    this.outputs = state.outputs;
    this.workspaces = state.workspaces;
    for (const window of state.windows) this.windows.set(window.id, window);
  }

  apply(event: NiriEvent): void {
    switch (event.type) {
      case "OutputsChanged": this.outputs = event.outputs; break;
      case "WorkspacesChanged": this.workspaces = event.workspaces; break;
      case "WorkspaceActivated": {
        const target = this.workspaces.find(({ id }) => id === event.id);
        if (target) this.workspaces = this.workspaces.map((workspace) => ({
          ...workspace,
          active: workspace.output === target.output ? workspace.id === target.id : workspace.active,
          focused: event.focused ? workspace.id === target.id : workspace.focused,
        }));
        break;
      }
      case "WindowsChanged":
        this.windows.clear();
        for (const window of event.windows) this.windows.set(window.id, window);
        break;
      case "WindowOpenedOrChanged":
        if (event.window.focused) this.focus(event.window.id);
        this.windows.set(event.window.id, event.window);
        break;
      case "WindowClosed": this.windows.delete(event.id); break;
      case "WindowFocusChanged": this.focus(event.id); break;
      case "WindowLayoutsChanged":
        for (const [id, geometry] of event.changes) {
          const window = this.windows.get(id);
          if (window) this.windows.set(id, { ...window, geometry });
        }
        break;
    }
  }

  private focus(id: number | null): void {
    for (const [key, window] of this.windows) {
      if (window.focused !== (key === id)) this.windows.set(key, { ...window, focused: key === id });
    }
  }
}

interface Stream {
  readonly queue: NiriEvent[];
  model?: Model;
  draining: boolean;
  close?: Cancel;
}

export function createNiriOverviewPlugin(
  transport?: NiriSocketTransport, scheduleRetry: ScheduleRetry = scheduleNiriRetry,
): PluginDefinition<NiriOverviewConfig> {
  return definePlugin<NiriOverviewConfig>({
    manifest: {
      id: "z-shell/niri-overview",
      title: "Niri Overview",
      version: "0.1.0",
      pluginApi: 1,
      entries: [{ name: "service", kind: "service", title: "Niri Overview Coordinator" }],
      defaults: { zoom_scale: 0.5, max_queue_depth: 64 },
    },
    async setup(ctx) {
      const maxDepth = Math.max(8, Math.min(256, Math.trunc(ctx.config.max_queue_depth)));
      let stopped = false;
      let topicRegistered = false;
      let seenSocket = false;
      let stream: Stream | undefined;
      let backfill: Promise<NiriOverviewSnapshot> | undefined;
      let outputRefreshQueued = false;
      let cancelRetry: Cancel | undefined;
      let unsubscribeOutputs: (() => Promise<void>) | undefined;
      let unregisterToggle: (() => Promise<void>) | undefined;
      let unregisterRefresh: (() => Promise<void>) | undefined;
      let snapshot: NiriOverviewSnapshot = {
        capability: transport ? "disconnected" : "unsupported", resetting: transport !== undefined,
        open: false, outputs: [], layouts: [],
      };

      async function publish(next: NiriOverviewSnapshot): Promise<void> {
        snapshot = next;
        await ctx.publishTopic("state", next);
      }

      function retireStream(): void {
        const old = stream;
        stream = undefined;
        if (!old) return;
        old.queue.length = 0;
        old.close?.();
      }

      function retry(): void {
        if (stopped || cancelRetry) return;
        cancelRetry = scheduleRetry(1_000, () => {
          cancelRetry = undefined;
          void refresh().catch(() => undefined);
        });
      }

      async function reset(): Promise<void> {
        retireStream();
        backfill = undefined;
        const publication = publish({ ...snapshot, capability: "disconnected", resetting: true, outputs: [], layouts: [] });
        retry();
        await publication;
      }

      async function drain(active: Stream): Promise<void> {
        const model = active.model;
        if (!model || active.draining || stream !== active) return;
        active.draining = true;
        try {
          do {
            for (const event of active.queue) model.apply(event);
            active.queue.length = 0;
            await publish({
              ...snapshot, capability: "available", resetting: false,
              outputs: [...model.outputs].sort(compareOutput),
              layouts: computeOverviewLayouts(model.outputs, model.workspaces, [...model.windows.values()], ctx.config.zoom_scale),
            });
          } while (stream === active && active.queue.length !== 0);
        } finally {
          active.draining = false;
        }
      }

      async function connect(active: Stream): Promise<NiriOverviewSnapshot> {
        if (!transport) return snapshot;
        try {
          const available = await transport.isAvailable();
          if (stream !== active) return snapshot;
          if (!available) {
            if (seenSocket) {
              await reset();
            } else {
              retireStream();
              await publish({ ...snapshot, capability: "unsupported", resetting: false });
            }
            return snapshot;
          }
          seenSocket = true;
          if (!snapshot.resetting) {
            await publish({ ...snapshot, capability: "disconnected", resetting: true, outputs: [], layouts: [] });
            if (stream !== active) return snapshot;
          }
          const close = transport.subscribeEvents((event) => {
            if (stream !== active) return;
            if (active.queue.length >= maxDepth) {
              void reset().catch(() => undefined);
              return;
            }
            active.queue.push(event);
            if (active.model && !active.draining && active.queue.length === 1) {
              void Promise.resolve().then(() => drain(active)).catch(() => {
                if (stream === active) void reset().catch(() => undefined);
              });
            }
          }, () => {
            if (stream === active) void reset().catch(() => undefined);
          });
          if (stream !== active) {
            close();
            return snapshot;
          }
          active.close = close;
          const baseline = await transport.requestSnapshot();
          if (stream !== active) return snapshot;
          active.model = new Model(baseline);
          await drain(active);
        } catch {
          if (stream === active) await reset();
        }
        return snapshot;
      }

      function refresh(): Promise<NiriOverviewSnapshot> {
        if (stopped || !transport) return Promise.resolve(snapshot);
        if (backfill) return backfill;
        cancelRetry?.();
        cancelRetry = undefined;
        retireStream();
        const active: Stream = { queue: [], draining: false };
        stream = active;
        const pending = Promise.resolve().then(() => stream === active ? connect(active) : snapshot).finally(() => {
          if (backfill === pending) backfill = undefined;
        });
        backfill = pending;
        return pending;
      }

      async function cleanup(): Promise<void> {
        if (stopped) return;
        stopped = true;
        retireStream();
        cancelRetry?.();
        await Promise.all([
          unsubscribeOutputs?.(), unregisterToggle?.(), unregisterRefresh?.(),
          topicRegistered ? ctx.unregisterTopic("state") : undefined,
        ]);
      }

      try {
        await ctx.registerTopic("state", snapshot);
        topicRegistered = true;
        unregisterToggle = await ctx.registerCommand("toggle", "Toggle the Niri overview", async ({ payload }) => {
          const explicit = typeof payload === "object" && payload !== null && "open" in payload ? payload.open : undefined;
          if (explicit !== undefined && typeof explicit !== "boolean") throw new Error("open must be a boolean");
          if (!stopped) await publish({ ...snapshot, open: explicit ?? !snapshot.open });
          return { data: snapshot };
        });
        unregisterRefresh = await ctx.registerCommand("refresh", "Refresh Niri overview state", async () => ({ data: await refresh() }));
        if (transport) {
          // Niri's event stream does not report output mode/size changes. Use Wayland
          // as a topology change signal only; never join the two sources by name.
          const outputs = await ctx.subscribe("wayland.outputs", () => {
            if (!backfill) {
              void refresh().catch(() => undefined);
            } else if (!outputRefreshQueued) {
              outputRefreshQueued = true;
              void backfill.finally(() => {
                outputRefreshQueued = false;
                void refresh().catch(() => undefined);
              }).catch(() => undefined);
            }
          }).catch(() => undefined);
          unsubscribeOutputs = outputs?.unsubscribe;
          void refresh().catch(() => undefined);
        }
        return cleanup;
      } catch (error) {
        await cleanup().catch(() => undefined);
        throw error;
      }
    },
  });
}

export default createNiriOverviewPlugin();
