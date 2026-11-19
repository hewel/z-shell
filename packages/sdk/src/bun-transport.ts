/** Bun Unix domain socket transport with byte-bounded framing and backpressure drain queue. */

import { MAX_FRAME_BYTES } from "./protocol.ts";
import type { BusTransport, Unsubscribe } from "./transport.ts";

const NEWLINE_BYTE = 0x0a;

export async function connectUnixSocket(socketPath: string): Promise<BusTransport> {
  const lineListeners = new Set<(line: string) => void>();
  const closeListeners = new Set<() => void>();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  let readBuf = new Uint8Array(0);
  const writeQueue: Uint8Array[] = [];
  let closed = false;

  const notifyClose = () => {
    if (closed) return;
    closed = true;
    writeQueue.length = 0;
    for (const listener of [...closeListeners]) {
      listener();
    }
  };

  const flushWrites = (sock: { write(data: Uint8Array): number }) => {
    while (writeQueue.length > 0 && !closed) {
      const head = writeQueue[0];
      if (!head) break;
      const written = sock.write(head);
      if (written === 0) {
        // Socket send buffer full; wait for `drain` callback.
        break;
      }
      if (written < head.byteLength) {
        writeQueue[0] = head.subarray(written);
        break;
      }
      writeQueue.shift();
    }
  };

  const socket = await Bun.connect({
    unix: socketPath,
    socket: {
      data(sock, chunk) {
        const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        if (readBuf.byteLength + bytes.byteLength > MAX_FRAME_BYTES * 2) {
          sock.end();
          notifyClose();
          return;
        }
        const merged = new Uint8Array(readBuf.byteLength + bytes.byteLength);
        merged.set(readBuf, 0);
        merged.set(bytes, readBuf.byteLength);
        readBuf = merged;

        let offset = 0;
        while (offset < readBuf.byteLength) {
          const nlIdx = readBuf.indexOf(NEWLINE_BYTE, offset);
          if (nlIdx === -1) {
            if (readBuf.byteLength - offset > MAX_FRAME_BYTES) {
              sock.end();
              notifyClose();
              return;
            }
            break;
          }
          const lineBytes = readBuf.subarray(offset, nlIdx);
          offset = nlIdx + 1;
          if (lineBytes.byteLength > MAX_FRAME_BYTES) {
            sock.end();
            notifyClose();
            return;
          }
          const line = decoder.decode(lineBytes);
          for (const listener of [...lineListeners]) {
            listener(line);
          }
        }
        readBuf = offset === 0 ? readBuf : readBuf.slice(offset);
      },
      drain(sock) {
        flushWrites(sock);
      },
      close() {
        notifyClose();
      },
      error() {
        notifyClose();
      },
    },
  });

  return {
    sendLine(line: string) {
      if (closed) {
        throw new Error("unix socket transport is closed");
      }
      const encoded = encoder.encode(`${line}\n`);
      if (encoded.byteLength > MAX_FRAME_BYTES) {
        throw new Error(`outbound frame exceeds MAX_FRAME_BYTES (${MAX_FRAME_BYTES})`);
      }
      writeQueue.push(encoded);
      flushWrites(socket);
    },
    onLine(listener: (line: string) => void): Unsubscribe {
      lineListeners.add(listener);
      return () => {
        lineListeners.delete(listener);
      };
    },
    onClose(listener: () => void): Unsubscribe {
      closeListeners.add(listener);
      return () => {
        closeListeners.delete(listener);
      };
    },
    close() {
      if (closed) return;
      notifyClose();
      socket.end();
    },
  };
}
