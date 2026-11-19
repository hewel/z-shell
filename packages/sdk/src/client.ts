/** QuickJS-safe, zero-global NDJSON bus client with mandatory handshake, strict ordering, and isolated listeners. */

import {
  BusRpcError,
  JSONRPC_VERSION,
  METHODS,
  PROTOCOL_VERSION,
  parseServerFrame,
  type BusHelloResult,
  type ClientRequestFrame,
  type CommandDispatchNotification,
  type CommandInvokeResult,
  type CommandSummary,
  type InhibitorScope,
  type RequestId,
  type TopicListEntry,
  type TopicRemovedNotification,
  type TopicResetNotification,
  type TopicSnapshot,
  type TopicUpdate,
} from "./protocol.ts";
import type { BusTransport, Unsubscribe } from "./transport.ts";

export type TopicListener<T = unknown> = (update: TopicUpdate<T>) => void;
export type TopicRemovedListener = (event: TopicRemovedNotification) => void;
export type TopicResetListener = (event: TopicResetNotification) => void;
export type ClientErrorListener = (error: unknown) => void;

export interface SubscribeOptions<T = unknown> {
  readonly onUpdate: TopicListener<T>;
  readonly onRemoved?: TopicRemovedListener;
  readonly onReset?: TopicResetListener;
}

export interface ClientOptions {
  readonly onError?: ClientErrorListener;
}

export type CommandHandler = (input: {
  readonly name: string;
  readonly args: readonly string[];
  readonly payload?: unknown;
}) => CommandInvokeResult | Promise<CommandInvokeResult>;

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
}

interface TopicSubscriptionState {
  daemonInstanceId: string;
  topicInstanceId: number;
  lastRevision: number;
  readonly onUpdate: Set<TopicListener>;
  readonly onRemoved: Set<TopicRemovedListener>;
  readonly onReset: Set<TopicResetListener>;
}

interface RegisteredCommandEntry {
  readonly token: number;
  readonly handler: CommandHandler;
}

export class ZShellClient {
  readonly #transport: BusTransport;
  readonly #pending = new Map<RequestId, PendingRequest>();
  readonly #topics = new Map<string, TopicSubscriptionState>();
  readonly #commandHandlers = new Map<string, RegisteredCommandEntry>();
  readonly #onError?: ClientErrorListener;
  readonly #unsubLine: Unsubscribe;
  readonly #unsubClose: Unsubscribe;
  #helloResult: BusHelloResult | undefined;
  #nextId = 1;
  #nextToken = 1;
  #closed = false;

  constructor(transport: BusTransport, options?: ClientOptions) {
    this.#transport = transport;
    if (options?.onError !== undefined) {
      this.#onError = options.onError;
    }
    this.#unsubLine = transport.onLine((line) => this.#handleLine(line));
    this.#unsubClose = transport.onClose(() => this.#handleClose());
  }

  /** Connects and performs the mandatory `bus.hello` version handshake. */
  static async connect(
    transport: BusTransport,
    clientName?: string,
    options?: ClientOptions,
  ): Promise<ZShellClient> {
    const client = new ZShellClient(transport, options);
    await client.hello(clientName);
    return client;
  }

  /** Returns the negotiated `bus.hello` metadata once handshake completes. */
  get helloInfo(): BusHelloResult | undefined {
    return this.#helloResult;
  }

  request<R = unknown>(method: string, params?: unknown): Promise<R> {
    if (this.#closed) {
      return Promise.reject(new Error("z-shell bus client is closed"));
    }
    const id = this.#nextId++;
    const frame: ClientRequestFrame =
      params === undefined
        ? { jsonrpc: JSONRPC_VERSION, id, method }
        : { jsonrpc: JSONRPC_VERSION, id, method, params };

    return new Promise<R>((resolve, reject) => {
      this.#pending.set(id, {
        resolve: (value) => resolve(value as R),
        reject,
      });
      try {
        this.#transport.sendLine(JSON.stringify(frame));
      } catch (err) {
        this.#pending.delete(id);
        reject(err);
      }
    });
  }

  async hello(clientName?: string): Promise<BusHelloResult> {
    const params =
      clientName === undefined
        ? { protocol_version: PROTOCOL_VERSION }
        : { protocol_version: PROTOCOL_VERSION, client_name: clientName };
    const result = await this.request<BusHelloResult>(METHODS.BUS_HELLO, params);
    this.#helloResult = result;
    return result;
  }

  listTopics(): Promise<readonly TopicListEntry[]> {
    return this.request<readonly TopicListEntry[]>(METHODS.TOPIC_LIST);
  }

  async subscribe<T = unknown>(
    topic: string,
    listenerOrOptions: TopicListener<T> | SubscribeOptions<T>,
  ): Promise<{ readonly snapshot: TopicSnapshot<T>; readonly unsubscribe: () => Promise<void> }> {
    const opts: SubscribeOptions<T> =
      typeof listenerOrOptions === "function"
        ? { onUpdate: listenerOrOptions }
        : listenerOrOptions;

    const snapshot = await this.request<TopicSnapshot<T>>(METHODS.TOPIC_SUBSCRIBE, { topic });

    let state = this.#topics.get(topic);
    if (!state) {
      state = {
        daemonInstanceId: snapshot.daemon_instance_id,
        topicInstanceId: snapshot.topic_instance_id,
        lastRevision: snapshot.revision,
        onUpdate: new Set(),
        onRemoved: new Set(),
        onReset: new Set(),
      };
      this.#topics.set(topic, state);
    } else {
      state.daemonInstanceId = snapshot.daemon_instance_id;
      state.topicInstanceId = snapshot.topic_instance_id;
      state.lastRevision = snapshot.revision;
    }

    const castUpdate = opts.onUpdate as TopicListener;
    state.onUpdate.add(castUpdate);
    if (opts.onRemoved) state.onRemoved.add(opts.onRemoved);
    if (opts.onReset) state.onReset.add(opts.onReset);

    return {
      snapshot,
      unsubscribe: async () => {
        const current = this.#topics.get(topic);
        if (!current) return;
        current.onUpdate.delete(castUpdate);
        if (opts.onRemoved) current.onRemoved.delete(opts.onRemoved);
        if (opts.onReset) current.onReset.delete(opts.onReset);
        if (current.onUpdate.size === 0) {
          this.#topics.delete(topic);
          if (!this.#closed) {
            await this.request(METHODS.TOPIC_UNSUBSCRIBE, { topic });
          }
        }
      },
    };
  }

  registerTopic(
    topic: string,
    initial: unknown,
    pluginId?: string,
  ): Promise<{ readonly topic_instance_id: number; readonly revision: number }> {
    const params =
      pluginId === undefined ? { topic, initial } : { topic, initial, plugin_id: pluginId };
    return this.request(METHODS.TOPIC_REGISTER, params);
  }

  publishTopic(topic: string, data: unknown): Promise<{ readonly revision: number }> {
    return this.request(METHODS.TOPIC_PUBLISH, { topic, data });
  }

  unregisterTopic(topic: string): Promise<void> {
    return this.request(METHODS.TOPIC_UNREGISTER, { topic }).then(() => undefined);
  }

  listCommands(): Promise<readonly CommandSummary[]> {
    return this.request<readonly CommandSummary[]>(METHODS.COMMAND_LIST);
  }

  invokeCommand(
    name: string,
    args: readonly string[] = [],
    payload?: unknown,
  ): Promise<CommandInvokeResult> {
    const params = payload === undefined ? { name, args } : { name, args, payload };
    return this.request<CommandInvokeResult>(METHODS.COMMAND_INVOKE, params);
  }

  async registerCommand(
    name: string,
    description: string,
    handler: CommandHandler,
    pluginId?: string,
  ): Promise<() => Promise<void>> {
    // Reject local duplicate registration BEFORE touching the wire so an existing handler is never clobbered.
    if (this.#commandHandlers.has(name)) {
      throw new Error(`command ${JSON.stringify(name)} is already registered on this client`);
    }
    const token = this.#nextToken++;
    this.#commandHandlers.set(name, { token, handler });
    const params =
      pluginId === undefined ? { name, description } : { name, description, plugin_id: pluginId };
    try {
      await this.request(METHODS.COMMAND_REGISTER, params);
    } catch (err) {
      const current = this.#commandHandlers.get(name);
      if (current?.token === token) {
        this.#commandHandlers.delete(name);
      }
      throw err;
    }
    return async () => {
      const current = this.#commandHandlers.get(name);
      if (current?.token !== token) return;
      this.#commandHandlers.delete(name);
      if (!this.#closed) {
        await this.request(METHODS.COMMAND_UNREGISTER, { name });
      }
    };
  }

  acquireInhibitor(
    scope: InhibitorScope,
    reason: string,
    pluginId?: string,
  ): Promise<{ readonly cookie: number }> {
    const params =
      pluginId === undefined ? { scope, reason } : { scope, reason, plugin_id: pluginId };
    return this.request(METHODS.INHIBITOR_ACQUIRE, params);
  }

  releaseInhibitor(cookie: number): Promise<void> {
    return this.request(METHODS.INHIBITOR_RELEASE, { cookie }).then(() => undefined);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsubLine();
    this.#unsubClose();
    this.#transport.close();
    this.#topics.clear();
    this.#commandHandlers.clear();
    this.#rejectAllPending(new Error("z-shell bus client closed"));
  }

  #handleClose(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#topics.clear();
    this.#commandHandlers.clear();
    this.#rejectAllPending(new Error("z-shell bus connection closed"));
  }

  #rejectAllPending(reason: Error): void {
    for (const pending of this.#pending.values()) {
      pending.reject(reason);
    }
    this.#pending.clear();
  }

  #reportError(err: unknown): void {
    if (this.#onError) {
      try {
        this.#onError(err);
      } catch {
        // Swallow secondary errors from the error hook itself.
      }
    }
  }

  #handleLine(line: string): void {
    const frame = parseServerFrame(line);
    if (!frame) {
      this.#reportError(new Error("received malformed bus frame"));
      return;
    }

    if (frame.kind === "ok") {
      const pending = this.#pending.get(frame.id);
      if (!pending) return;
      this.#pending.delete(frame.id);
      pending.resolve(frame.result);
      return;
    }

    if (frame.kind === "err") {
      const rpcErr = new BusRpcError(frame.error);
      if (frame.id === null) {
        this.#reportError(rpcErr);
        return;
      }
      const pending = this.#pending.get(frame.id);
      if (!pending) return;
      this.#pending.delete(frame.id);
      pending.reject(rpcErr);
      return;
    }

    if (frame.method === METHODS.TOPIC_UPDATE) {
      const update = frame.params as TopicUpdate;
      const state = this.#topics.get(update.topic);
      if (!state) return;
      // Defensive monotonicity guard: ignore stale revisions from the same topic instance.
      if (
        update.daemon_instance_id === state.daemonInstanceId &&
        update.topic_instance_id === state.topicInstanceId &&
        update.revision <= state.lastRevision
      ) {
        return;
      }
      state.daemonInstanceId = update.daemon_instance_id;
      state.topicInstanceId = update.topic_instance_id;
      state.lastRevision = update.revision;
      for (const listener of [...state.onUpdate]) {
        try {
          listener(update);
        } catch (err) {
          this.#reportError(err);
        }
      }
      return;
    }

    if (frame.method === METHODS.TOPIC_REMOVED) {
      const removed = frame.params as TopicRemovedNotification;
      const state = this.#topics.get(removed.topic);
      if (!state) return;
      this.#topics.delete(removed.topic);
      for (const listener of [...state.onRemoved]) {
        try {
          listener(removed);
        } catch (err) {
          this.#reportError(err);
        }
      }
      return;
    }

    if (frame.method === METHODS.TOPIC_RESET) {
      const reset = frame.params as TopicResetNotification;
      for (const topicName of reset.topics) {
        const state = this.#topics.get(topicName);
        if (!state) continue;
        this.#topics.delete(topicName);
        for (const listener of [...state.onReset]) {
          try {
            listener(reset);
          } catch (err) {
            this.#reportError(err);
          }
        }
      }
      return;
    }

    if (frame.method === METHODS.COMMAND_DISPATCH) {
      const dispatch = frame.params as CommandDispatchNotification;
      void this.#handleCommandDispatch(dispatch);
    }
  }

  async #handleCommandDispatch(dispatch: CommandDispatchNotification): Promise<void> {
    const entry = this.#commandHandlers.get(dispatch.name);
    if (!entry) {
      if (!this.#closed) {
        await this.request(METHODS.COMMAND_REPLY, {
          call_id: dispatch.call_id,
          error: `no local handler registered for command ${dispatch.name}`,
        }).catch(() => undefined);
      }
      return;
    }
    try {
      const result = await entry.handler({
        name: dispatch.name,
        args: dispatch.args,
        payload: dispatch.payload,
      });
      if (!this.#closed) {
        await this.request(METHODS.COMMAND_REPLY, {
          call_id: dispatch.call_id,
          result,
        }).catch(() => undefined);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!this.#closed) {
        await this.request(METHODS.COMMAND_REPLY, {
          call_id: dispatch.call_id,
          error: message,
        }).catch(() => undefined);
      }
    }
  }
}
