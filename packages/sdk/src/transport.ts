/** Pluggable NDJSON line transport abstraction (QuickJS / zgui-js / Bun / Fixture compatible). */

export type Unsubscribe = () => void;

export interface BusTransport {
  /** Sends a single NDJSON line (without trailing newline; transport appends `\n`). */
  sendLine(line: string): void;
  /** Subscribes to inbound NDJSON lines emitted by the shell daemon or fixture. */
  onLine(listener: (line: string) => void): Unsubscribe;
  /** Subscribes to transport close/disconnect notifications. */
  onClose(listener: () => void): Unsubscribe;
  /** Closes the underlying transport cleanly. */
  close(): void;
}
