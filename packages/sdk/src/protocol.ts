/** Wire protocol types and runtime envelope validator matching `crates/z-shell-protocol` (ES2022, QuickJS-safe). */

export const JSONRPC_VERSION = "2.0" as const;
export const PROTOCOL_VERSION = 1 as const;
export const MAX_FRAME_BYTES = 1024 * 1024;
export const MAX_SAFE_JS_INT = 9007199254740991; // 2^53 - 1
export const MAX_IDENTIFIER_LEN = 128;
export const MAX_SEGMENT_LEN = 64;

export const METHODS = {
  BUS_HELLO: "bus.hello",
  TOPIC_LIST: "topic.list",
  TOPIC_SUBSCRIBE: "topic.subscribe",
  TOPIC_UNSUBSCRIBE: "topic.unsubscribe",
  TOPIC_REGISTER: "topic.register",
  TOPIC_PUBLISH: "topic.publish",
  TOPIC_UNREGISTER: "topic.unregister",
  TOPIC_UPDATE: "topic.update",
  TOPIC_REMOVED: "topic.removed",
  TOPIC_RESET: "topic.reset",
  COMMAND_LIST: "command.list",
  COMMAND_INVOKE: "command.invoke",
  COMMAND_REGISTER: "command.register",
  COMMAND_UNREGISTER: "command.unregister",
  COMMAND_DISPATCH: "command.dispatch",
  COMMAND_REPLY: "command.reply",
  INHIBITOR_ACQUIRE: "inhibitor.acquire",
  INHIBITOR_RELEASE: "inhibitor.release",
} as const;

export type RequestId = number | string;
export type ClientRole = "public" | "privileged_host";

export type ErrorCode =
  | "invalid_request"
  | "handshake_required"
  | "version_mismatch"
  | "method_not_found"
  | "invalid_params"
  | "not_found"
  | "already_exists"
  | "permission_denied"
  | "resource_exhausted"
  | "timeout"
  | "disabled"
  | "internal";

export interface RpcErrorPayload {
  readonly code: ErrorCode;
  readonly message: string;
  readonly data?: unknown;
}

export class BusRpcError extends Error {
  readonly code: ErrorCode;
  readonly data?: unknown;

  constructor(payload: RpcErrorPayload) {
    super(`${payload.code}: ${payload.message}`);
    this.name = "BusRpcError";
    this.code = payload.code;
    this.data = payload.data;
  }
}

export interface ClientRequestFrame {
  readonly jsonrpc: typeof JSONRPC_VERSION;
  readonly id?: RequestId;
  readonly method: string;
  readonly params?: unknown;
}

export interface ServerOkFrame {
  readonly kind: "ok";
  readonly jsonrpc: typeof JSONRPC_VERSION;
  readonly id: RequestId;
  readonly result: unknown;
}

export interface ServerErrFrame {
  readonly kind: "err";
  readonly jsonrpc: typeof JSONRPC_VERSION;
  readonly id: RequestId | null;
  readonly error: RpcErrorPayload;
}

export interface ServerNotificationFrame {
  readonly kind: "notification";
  readonly jsonrpc: typeof JSONRPC_VERSION;
  readonly method: string;
  readonly params: unknown;
}

export type ServerFrame = ServerOkFrame | ServerErrFrame | ServerNotificationFrame;

export type TopicOwner =
  | { readonly kind: "core" }
  | { readonly kind: "plugin"; readonly plugin_id?: string; readonly client_id: number };

export interface BusHelloParams {
  readonly protocol_version: number;
  readonly client_name?: string;
}

export interface BusHelloResult {
  readonly protocol_version: number;
  readonly daemon_version: string;
  readonly daemon_instance_id: string;
  readonly client_id: number;
  readonly role: ClientRole;
  readonly media_dir: string;
}

export interface TopicListEntry {
  readonly topic: string;
  readonly topic_instance_id: number;
  readonly revision: number;
  readonly owner: TopicOwner;
}

export interface TopicSnapshot<T = unknown> {
  readonly daemon_instance_id: string;
  readonly topic_instance_id: number;
  readonly topic: string;
  readonly revision: number;
  readonly data: T;
}

export interface TopicUpdate<T = unknown> {
  readonly daemon_instance_id: string;
  readonly topic_instance_id: number;
  readonly topic: string;
  readonly revision: number;
  readonly source_baseline: boolean;
  readonly data: T;
}

export interface TopicRemovedNotification {
  readonly daemon_instance_id: string;
  readonly topic_instance_id: number;
  readonly topic: string;
}

export interface TopicResetNotification {
  readonly daemon_instance_id: string;
  readonly reason: string;
  readonly topics: readonly string[];
}

export interface CommandSummary {
  readonly name: string;
  readonly description: string;
  readonly owner: TopicOwner;
}

export interface CommandInvokeResult {
  readonly message?: string;
  readonly data?: unknown;
}

export interface CommandDispatchNotification {
  readonly call_id: number;
  readonly name: string;
  readonly args: readonly string[];
  readonly payload?: unknown;
}

export type InhibitorScope = "idle" | "sleep" | "lock";

export interface InhibitorEntry {
  readonly cookie: number;
  readonly scope: InhibitorScope;
  readonly reason: string;
  readonly owner: TopicOwner;
}

export type MediaRef =
  | {
      readonly kind: "runtime_path";
      readonly path: string;
      readonly mime: string;
      readonly revision: number;
    }
  | {
      readonly kind: "blob_handle";
      readonly token: string;
      readonly mime: string;
      readonly byte_len: number;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidRequestId(value: unknown): value is RequestId {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 && value <= MAX_SAFE_JS_INT;
  }
  return typeof value === "string" && value.length > 0 && value.length <= MAX_IDENTIFIER_LEN;
}

function isValidRpcError(value: unknown): value is RpcErrorPayload {
  return (
    isRecord(value) &&
    typeof value.code === "string" &&
    value.code.length > 0 &&
    typeof value.message === "string"
  );
}

/**
 * Runtime validator for inbound server NDJSON lines enforcing `jsonrpc === "2.0"`,
 * mutually exclusive `result`/`error`, safe integer IDs, and strict notification shape.
 */
export function parseServerFrame(line: string): ServerFrame | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > MAX_FRAME_BYTES) {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(raw) || raw.jsonrpc !== JSONRPC_VERSION) {
    return null;
  }

  const hasMethod = "method" in raw;
  const hasId = "id" in raw;
  const hasResult = "result" in raw;
  const hasError = "error" in raw;

  if (hasMethod) {
    if (hasId || hasResult || hasError || !("params" in raw)) {
      return null;
    }
    if (typeof raw.method !== "string" || raw.method.length === 0) {
      return null;
    }
    return {
      kind: "notification",
      jsonrpc: JSONRPC_VERSION,
      method: raw.method,
      params: raw.params,
    };
  }

  if (!hasId || hasResult === hasError) {
    return null;
  }

  if (hasResult) {
    if (!isValidRequestId(raw.id)) {
      return null;
    }
    return {
      kind: "ok",
      jsonrpc: JSONRPC_VERSION,
      id: raw.id,
      result: raw.result,
    };
  }

  const idVal = raw.id;
  if (idVal !== null && !isValidRequestId(idVal)) {
    return null;
  }
  if (!isValidRpcError(raw.error)) {
    return null;
  }
  return {
    kind: "err",
    jsonrpc: JSONRPC_VERSION,
    id: idVal,
    error: raw.error,
  };
}
