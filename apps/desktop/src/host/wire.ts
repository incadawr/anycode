/**
 * Adapts Electron's MessagePortMain (utilityProcess + MessageChannelMain) to
 * the transport-agnostic WirePort contract (shared/protocol.ts) so host
 * logic can be unit-tested against worker_threads.MessageChannel instead of

 */
import type { MessagePortMain } from "electron";
import type { WirePort } from "../shared/protocol.js";

export function createWirePort(port: MessagePortMain): WirePort {
  return {
    post(msg: unknown): void {
      port.postMessage(msg);
    },
    onMessage(cb: (msg: unknown) => void): void {
      port.on("message", (event) => {
        cb(event.data);
      });
      // MessagePortMain buffers nothing until started — a frequent "messages

      // listener is attached so no message emitted synchronously is missed.
      port.start();
    },
    onClose(cb: () => void): void {
      port.on("close", cb);
    },
  };
}
