import { createEffect, createSignal, onCleanup, type Accessor } from "@hewel/zgui";
import { registerImageBytes, type ImageHandle } from "@hewel/zgui-services";
import type { ZShellClient } from "./client.ts";
import type { MediaRef, TopicRemovedNotification, TopicResetNotification, TopicUpdate } from "./protocol.ts";

export type MaybeAccessor<T> = T | Accessor<T>;
export type TopicStatus = "idle" | "loading" | "ready" | "removed" | "error";

export interface UseTopicOptions<T> {
  readonly initialData?: T;
  /** Restore initialData on removal. Defaults to true. */
  readonly resetOnRemoved?: boolean;
  readonly onLiveUpdate?: (update: TopicUpdate<T>) => void;
  readonly onBaselineUpdate?: (update: TopicUpdate<T>) => void;
  readonly onRemoved?: (event: TopicRemovedNotification) => void;
  readonly onReset?: (event: TopicResetNotification) => void;
  readonly onError?: (error: unknown) => void;
}

export interface TopicState<T> {
  readonly data: Accessor<T | undefined>;
  readonly revision: Accessor<number>;
  readonly status: Accessor<TopicStatus>;
  readonly error: Accessor<unknown>;
  readonly sourceBaseline: Accessor<boolean>;
}

function read<T>(input: MaybeAccessor<T>): T {
  return typeof input === "function" ? (input as Accessor<T>)() : input;
}

function notifyError(listener: ((error: unknown) => void) | undefined, error: unknown): void {
  try {
    listener?.(error);
  } catch {
    // Like the bus client, isolate secondary failures in error observers.
  }
}

// The daemon subscribes per connection/topic, not per listener. Settle the old
// start (including any late unsubscribe) before sending another for that pair.
const pendingStarts = new WeakMap<ZShellClient, Map<string, Promise<void>>>();

function startSubscription(client: ZShellClient, topic: string, start: () => Promise<void>): void {
  let topics = pendingStarts.get(client);
  if (!topics) {
    topics = new Map();
    pendingStarts.set(client, topics);
  }
  const pending = topics.get(topic);
  const next = pending === undefined ? start() : pending.then(start, start);
  topics.set(topic, next);
  const clear = () => {
    if (topics.get(topic) === next) topics.delete(topic);
  };
  void next.then(clear, clear);
}

export function useTopic<T>(
  client: MaybeAccessor<ZShellClient | null | undefined>,
  topic: MaybeAccessor<string | null | undefined>,
  options?: UseTopicOptions<T>,
): TopicState<T> {
  const initialData = options?.initialData;
  const resetOnRemoved = options?.resetOnRemoved ?? true;
  const [data, setData] = createSignal<T>();
  if (initialData !== undefined) setData(() => initialData);
  const [revision, setRevision] = createSignal(0);
  const [status, setStatus] = createSignal<TopicStatus>("idle");
  const [error, setError] = createSignal<unknown>();
  const [sourceBaseline, setSourceBaseline] = createSignal(false);
  const [reconnect, setReconnect] = createSignal(0);

  createEffect(() => {
    const scope = {
      client: read(client),
      topic: read(topic),
      active: true,
      unsubscribe: undefined as (() => Promise<void>) | undefined,
    };
    reconnect();
    // Solid 2 tracks ownership in the computation, not in its apply callback.
    onCleanup(() => {
      scope.active = false;
      void scope.unsubscribe?.().catch(() => undefined);
    });
    return scope;
  }, (scope) => {
    const { client, topic } = scope;
    setData(() => initialData);
    setRevision(0);
    setSourceBaseline(false);
    setError(undefined);
    if (client == null || topic == null) {
      setStatus("idle");
      return;
    }
    setStatus("loading");

    startSubscription(client, topic, async () => {
      if (!scope.active) return;
      // A notification can follow the snapshot on the wire before this await resumes.
      let acceptSnapshot = true;
      let removed = false;
      try {
        const { snapshot, unsubscribe } = await client.subscribe<T>(topic, {
          onUpdate(update) {
            if (!scope.active) return;
            acceptSnapshot = false;
            setData(() => update.data);
            setRevision(update.revision);
            setSourceBaseline(update.source_baseline);
            setStatus("ready");
            if (update.source_baseline) options?.onBaselineUpdate?.(update);
            else options?.onLiveUpdate?.(update);
          },
          onRemoved(event) {
            if (!scope.active) return;
            removed = true;
            if (resetOnRemoved) {
              setData(() => initialData);
              setSourceBaseline(false);
            }
            setStatus("removed");
            options?.onRemoved?.(event);
          },
          onReset(event) {
            if (!scope.active) return;
            acceptSnapshot = false;
            setReconnect((value) => value + 1);
            options?.onReset?.(event);
          },
        });
        if (!scope.active) {
          void unsubscribe().catch(() => undefined);
          return;
        }
        scope.unsubscribe = unsubscribe;
        if (acceptSnapshot) {
          if (!removed || !resetOnRemoved) setData(() => snapshot.data);
          setRevision(snapshot.revision);
          if (!removed) setStatus("ready");
        }
      } catch (cause) {
        if (!scope.active) return;
        setError(() => cause);
        setStatus("error");
        notifyError(options?.onError, cause);
      }
    });
  });

  return { data, revision, status, error, sourceBaseline };
}

export interface UseDaemonMediaOptions {
  readonly fetchCommand: string;
  readonly onError?: (error: unknown) => void;
}

export interface DaemonMediaState {
  readonly src: Accessor<string | undefined>;
  readonly loading: Accessor<boolean>;
  readonly error: Accessor<unknown>;
}

export function encodeFileUrlPath(path: string): string {
  return `file://${path.split("/").map(encodeURIComponent).join("/")}`;
}

function isImageByteArray(bytes: unknown): bytes is number[] {
  if (!Array.isArray(bytes) || bytes.length === 0) return false;
  for (const byte of bytes) {
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) return false;
  }
  return true;
}

export function useDaemonMedia(
  hostClient: MaybeAccessor<ZShellClient | null | undefined>,
  media: MaybeAccessor<MediaRef | null | undefined>,
  options: UseDaemonMediaOptions,
): DaemonMediaState {
  // A new runtime file revision must publish even when its URL is unchanged.
  const [src, setSrc] = createSignal<string | undefined>(undefined, { equals: false });
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<unknown>();

  createEffect(() => {
    const ref = read(media);
    if (ref?.kind === "runtime_path") {
      return { kind: ref.kind, path: ref.path, revision: ref.revision };
    }
    if (ref?.kind === "blob_handle") {
      return { kind: ref.kind, token: ref.token, client: read(hostClient) };
    }
    return undefined;
  }, (input) => {
    setError(undefined);
    if (input?.kind === "runtime_path") {
      setSrc(encodeFileUrlPath(input.path));
      setLoading(false);
      return;
    }
    setSrc(undefined);
    if (input?.client == null) {
      setLoading(false);
      return;
    }
    setLoading(true);
    let active = true;
    let handle: ImageHandle | undefined;
    void input.client.invokeCommand(options.fetchCommand, [], { token: input.token }).then(({ data }) => {
      if (!active) return;
      const bytes = typeof data === "object" && data !== null && "bytes" in data ? data.bytes : undefined;
      if (!isImageByteArray(bytes)) throw new TypeError("daemon media response must contain a non-empty byte array");
      handle = registerImageBytes(new Uint8Array(bytes));
      setSrc(handle.src);
      setLoading(false);
    }).catch((cause: unknown) => {
      if (!active) return;
      setError(() => cause);
      setLoading(false);
      notifyError(options.onError, cause);
    });
    return () => {
      active = false;
      handle?.release();
    };
  });

  return { src, loading, error };
}
