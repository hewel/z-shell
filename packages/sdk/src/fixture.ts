/** Deterministic in-memory transport supporting async scheduling, topic reset, and disconnect replay. */

import {
  JSONRPC_VERSION,
  METHODS,
  type ClientRequestFrame,
  type CommandDispatchNotification,
  type RpcErrorPayload,
  type TopicRemovedNotification,
  type TopicResetNotification,
  type TopicUpdate,
} from "./protocol.ts";
import type { BusTransport, Unsubscribe } from "./transport.ts";

export type FixtureResponder = (
  request: ClientRequestFrame,
) => { readonly result: unknown } | { readonly error: RpcErrorPayload };

export interface FixtureOptions {
  /** When true, responses queue on microtasks instead of resolving synchronously inside sendLine. */
  readonly asyncDispatch?: boolean;
}

export class FixtureTransport implements BusTransport {
  readonly sentFrames: ClientRequestFrame[] = [];
  readonly #lineListeners = new Set<(line: string) => void>();
  readonly #closeListeners = new Set<() => void>();
  readonly #responder: FixtureResponder;
  readonly #asyncDispatch: boolean;
  #closed = false;

  constructor(responder: FixtureResponder, options?: FixtureOptions) {
    this.#responder = responder;
    this.#asyncDispatch = options?.asyncDispatch ?? false;
  }

  sendLine(line: string): void {
    if (this.#closed) {
      throw new Error("fixture transport is closed");
    }
    const parsed = JSON.parse(line) as ClientRequestFrame;
    this.sentFrames.push(parsed);
    if (parsed.id === undefined) {
      return;
    }
    const deliver = () => {
      if (this.#closed) return;
      const reply = this.#responder(parsed);
      const wireFrame =
        "error" in reply
          ? { jsonrpc: JSONRPC_VERSION, id: parsed.id, error: reply.error }
          : { jsonrpc: JSONRPC_VERSION, id: parsed.id, result: reply.result };
      this.emitRaw(wireFrame);
    };
    if (this.#asyncDispatch) {
      void Promise.resolve().then(deliver);
    } else {
      deliver();
    }
  }

  onLine(listener: (line: string) => void): Unsubscribe {
    this.#lineListeners.add(listener);
    return () => {
      this.#lineListeners.delete(listener);
    };
  }

  onClose(listener: () => void): Unsubscribe {
    this.#closeListeners.add(listener);
    return () => {
      this.#closeListeners.delete(listener);
    };
  }

  emitRaw(frame: Record<string, unknown>): void {
    if (this.#closed) return;
    const encoded = JSON.stringify(frame);
    for (const listener of [...this.#lineListeners]) {
      listener(encoded);
    }
  }

  emitTopicUpdate<T>(update: TopicUpdate<T>): void {
    this.emitRaw({
      jsonrpc: JSONRPC_VERSION,
      method: METHODS.TOPIC_UPDATE,
      params: update,
    });
  }

  emitTopicRemoved(event: TopicRemovedNotification): void {
    this.emitRaw({
      jsonrpc: JSONRPC_VERSION,
      method: METHODS.TOPIC_REMOVED,
      params: event,
    });
  }

  emitTopicReset(event: TopicResetNotification): void {
    this.emitRaw({
      jsonrpc: JSONRPC_VERSION,
      method: METHODS.TOPIC_RESET,
      params: event,
    });
  }

  emitCommandDispatch(dispatch: CommandDispatchNotification): void {
    this.emitRaw({
      jsonrpc: JSONRPC_VERSION,
      method: METHODS.COMMAND_DISPATCH,
      params: dispatch,
    });
  }

  /** Simulates abrupt daemon disconnect / session retirement. */
  simulateDisconnect(): void {
    this.close();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const listener of [...this.#closeListeners]) {
      listener();
    }
  }
}
