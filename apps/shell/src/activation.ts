import { requestActivationToken } from "@hewel/zgui";
import { isTrayActivateMenuFallback, type LauncherItem, type NotificationItem } from "./topics.ts";

const MAX_ACTIVATION_APP_ID_BYTES = 256;

function utf8BytesIfSafeUnicode(value: string): number | null {
  let bytes = 0;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    // Match @hewel/zgui validateActivationAppIdBytes: reject ASCII controls (<= 0x1F, 0x7F)
    // and C1 controls (0x80..0x9F) so requestActivationToken never throws TypeError.
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return null;
    }
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        return null;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return null;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * Sanitizes an application desktop ID for Wayland `xdg_activation_v1` `set_app_id`:
 * - Rejects nullish strings, ASCII/C1 control characters, and unpaired UTF-16 surrogates.
 * - Strips a single trailing `.desktop` suffix (preserving base reverse-DNS case).
 * - Rejects empty/whitespace-only results or strings exceeding 256 UTF-8 bytes.
 */
export function sanitizeActivationAppId(rawAppId: string | null | undefined): string | undefined {
  if (typeof rawAppId !== "string") return undefined;
  // Validate the raw string first so control characters before `.desktop` are never stripped into safety.
  if (utf8BytesIfSafeUnicode(rawAppId) === null) return undefined;
  const stripped = rawAppId.replace(/\.desktop$/i, "");
  if (stripped.trim().length === 0) return undefined;
  const byteLength = utf8BytesIfSafeUnicode(stripped);
  if (byteLength === null || byteLength > MAX_ACTIVATION_APP_ID_BYTES) return undefined;
  return stripped;
}

/**
 * Extracts a safe activation `appId` from a Freedesktop notification using ONLY `desktop_entry`
 * (never human-readable `app_name`).
 */
export function notificationActivationAppId(
  item: Pick<NotificationItem, "desktop_entry">,
): string | undefined {
  return sanitizeActivationAppId(item.desktop_entry);
}

/**
 * Extracts a safe activation `appId` for launcher items: passes the sanitized desktop entry ID
 * for built-in `"desktop"` items and omits `appId` for `launcher_provider` plugin items.
 */
export function launcherActivationAppId(
  item: Pick<LauncherItem, "provider_id" | "item_id">,
): string | undefined {
  return item.provider_id === "desktop" ? sanitizeActivationAppId(item.item_id) : undefined;
}

/**
 * Synchronously snapshots the active trusted press/key gesture via `requestActivationToken`
 * BEFORE returning, resolving to a non-empty token string or `undefined` when unavailable/denied.
 *
 * Call on the first line of a physical gesture handler—strictly before dismissing popups/overlays
 * and before any `await`.
 */
export function mintActivationToken(
  rawAppId?: string | null | undefined,
): Promise<string | undefined> {
  const appId = sanitizeActivationAppId(rawAppId);
  try {
    const tokenPromise =
      appId !== undefined ? requestActivationToken({ appId }) : requestActivationToken();
    return tokenPromise.then(
      token => (typeof token === "string" && token.length > 0 ? token : undefined),
      () => undefined,
    );
  } catch {
    return Promise.resolve(undefined);
  }
}

/**
 * Appends `activation_token` to a Bus RPC payload only when a non-empty token was minted,
 * preserving byte-identical payloads in headless previews and tokenless environments.
 */
export function withActivationToken<T extends Record<string, unknown>>(
  payload: T,
  token: string | null | undefined,
): T & { readonly activation_token?: string } {
  return typeof token === "string" && token.length > 0
    ? { ...payload, activation_token: token }
    : payload;
}

export type PublicCommandInvoker = (
  name: string,
  payload: unknown,
) => Promise<{ readonly data?: unknown } | undefined>;

/**
 * Captures a gesture-bound activation token synchronously using `item.desktop_entry` and
 * returns a Promise that resolves once the `notifications.invoke-action` RPC settles.
 */
export function invokeNotificationAction(
  invokePublic: PublicCommandInvoker,
  item: Pick<NotificationItem, "id" | "desktop_entry">,
  actionKey: string,
): Promise<void> {
  const notificationId = item.id;
  const tokenPromise = mintActivationToken(notificationActivationAppId(item));
  return tokenPromise.then(token =>
    invokePublic(
      "notifications.invoke-action",
      withActivationToken({ id: notificationId, action_key: actionKey }, token),
    ).then(() => {}),
  );
}

/**
 * Captures a gesture-bound activation token synchronously (omitting `appId` for SNI items),
 * invokes `tray.activate`, and triggers `onMenuFallback` if the item falls back to its menu.
 */
export function activateTrayItemWithFallback(
  invokePublic: PublicCommandInvoker,
  itemId: string,
  onMenuFallback: () => void,
): void {
  const tokenPromise = mintActivationToken();
  void tokenPromise
    .then(token => invokePublic("tray.activate", withActivationToken({ id: itemId }, token)))
    .then(res => {
      if (isTrayActivateMenuFallback(res)) {
        onMenuFallback();
      }
    });
}

