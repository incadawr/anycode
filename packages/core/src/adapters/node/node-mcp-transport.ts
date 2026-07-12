/**
 * Node MCP transport factory (design slice-3.2-cut.md §4.1). stdio servers get a
 * HAND-ROLLED transport with strict kill-discipline (detached process group,
 * SIGTERM -> SIGKILL escalation) — the stock `StdioClientTransport` is rejected
 * because it spawns non-detached and its close() is a single un-escalated

 * unreachable on it. Only the protocol half stays stock (the SDK Client owns
 * JSON-RPC); the Transport interface is the SDK's own extension seam.
 *
 * HTTP servers use the stock `StreamableHTTPClientTransport` as-is (it already
 * satisfies the port structurally). The kill-discipline mirrors
 * adapters/node/node-execution.ts (the Bash/pty precedent): pid == pgid on POSIX
 * so `process.kill(-pid, …)` reaps the whole group; win32 uses `taskkill /t`.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { MCP_STDERR_CAP_BYTES, SIGKILL_GRACE_MS } from "../../types/config.js";
import type {
  McpServerSpec,
  McpStdioServerSpec,
  McpTransportFactory,
  McpWireTransport,
} from "../../ports/mcp.js";

/**
 * The ONLY boundary cast (fable's transport-cast ruling, §3.2). A stock SDK
 * `Transport` types its payloads as the narrower `JSONRPCMessage`; the port uses
 * the deliberately loose `Record<string, unknown>` (kept third-party-free per
 * B5). SDK -> port is not a strict assignment, so this single checked cast
 * widens it — a `JSONRPCMessage` IS a `Record` at runtime (payload-soundness is
 * pinned type-level in mcp/transport-compat.ts). A SINGLE cast (never
 * `as unknown as`) keeps the types comparable, so a future SDK drift severe
 * enough to break comparability becomes a BUILD ERROR — an intentional alarm.
 *
 * INVARIANT: the port value is an OPAQUE HANDLE inside core. `McpManager` MAY
 * hand it to `Client.connect()`, call `close()`, and attach `onclose`/`onerror`.
 * It MUST NEVER call `send()`, invoke/wrap/replace `onmessage`, or interpose a
 * delegating wrapper between Client and transport (that breaks object identity
 * and drops the SDK's `onmessage` 2nd param `extra?: MessageExtraInfo`, which the
 * port deliberately does not model). The cast is sound precisely while core does
 * no protocol I/O through the port — the SDK Client owns all message flow.
 */
function asWireTransport(t: Transport): McpWireTransport {
  return t as McpWireTransport;
}

/** Sends `signal` to the whole process group rooted at `pid` (mirror node-execution.ts). */
function killGroup(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(pid), "/t", "/f"]);
    } catch {
      // best-effort; the process may already be gone.
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // ESRCH: the process group already exited.
  }
}

/**
 * Hand-rolled stdio transport implementing the SDK `Transport` shape (via the
 * port). Newline-delimited JSON framing uses the SDK's own ReadBuffer /
 * serializeMessage (spec-exact, not re-implemented).
 */
export class NodeStdioMcpTransport implements McpWireTransport {
  private child?: ChildProcess;
  private readonly readBuffer = new ReadBuffer();
  private closing = false;
  private stderrText = "";

  onmessage?: (message: Record<string, unknown>) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;

  constructor(private readonly spec: McpStdioServerSpec) {}

  /** The spawned child's pid, or null before start / after close (test hook). */
  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  /** Ring-capped tail of the child's stderr (diagnostics). */
  get stderrTail(): string {
    return this.stderrText;
  }

  start(): Promise<void> {
    if (this.child) {
      return Promise.reject(new Error("NodeStdioMcpTransport already started"));
    }
    return new Promise<void>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(this.spec.command, this.spec.args, {
          cwd: this.spec.cwd,

          // this is the only scrub line (host process.env is already scrubbed).
          env: this.spec.env,
          detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: process.platform === "win32",
          shell: false,
        });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      this.child = child;
      let spawned = false;

      child.on("spawn", () => {
        spawned = true;
        resolve();
      });
      child.on("error", (err) => {
        const error = err instanceof Error ? err : new Error(String(err));
        if (!spawned) {
          this.child = undefined;
          reject(error);
          return;
        }
        this.onerror?.(error);
      });
      child.on("close", (code, signal) => {
        this.child = undefined;
        if (!this.closing && code !== 0 && code !== null) {
          this.onerror?.(
            new Error(
              `MCP stdio server "${this.spec.name}" exited unexpectedly (code=${code}, signal=${String(signal)})` +
                (this.stderrText ? `: ${this.stderrText}` : ""),
            ),
          );
        }
        this.onclose?.();
      });
      child.stdout?.on("data", (chunk: Buffer) => {
        this.readBuffer.append(chunk);
        this.drain();
      });
      child.stdout?.on("error", (err) => this.onerror?.(err instanceof Error ? err : new Error(String(err))));
      // A server that exits without draining stdin raises EPIPE on write; swallow.
      child.stdin?.on("error", () => {});
      child.stderr?.on("data", (chunk: Buffer) => this.appendStderr(chunk));
    });
  }

  send(message: Record<string, unknown>): Promise<void> {
    const child = this.child;
    if (!child?.stdin) {
      return Promise.reject(new Error(`MCP stdio server "${this.spec.name}" is not connected`));
    }
    const json = serializeMessage(message as JSONRPCMessage);
    return new Promise<void>((resolve, reject) => {
      child.stdin!.write(json, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Graceful close then SIGKILL escalation. Sends stdin EOF + SIGTERM to the
   * whole group, then SIGKILL after SIGKILL_GRACE_MS if the child has not
   * exited. Resolves only once the child's `close` event fires (the process is
   * actually gone) — SIGKILL always reaps, so this never hangs.
   */
  close(): Promise<void> {
    const child = this.child;
    if (!child || child.pid == null) {
      this.readBuffer.clear();
      return Promise.resolve();
    }
    this.closing = true;
    this.child = undefined;
    const pid = child.pid;

    const closed = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      child.once("close", () => resolve());
    });

    try {
      child.stdin?.end();
    } catch {
      // ignore — stdin may already be gone.
    }
    killGroup(pid, "SIGTERM");
    const killTimer = setTimeout(() => killGroup(pid, "SIGKILL"), SIGKILL_GRACE_MS);

    return closed.finally(() => {
      clearTimeout(killTimer);
      this.readBuffer.clear();
    });
  }

  private drain(): void {
    for (;;) {
      let message: JSONRPCMessage | null;
      try {
        message = this.readBuffer.readMessage();
      } catch (err) {
        // Malformed frame: ReadBuffer has already consumed the bad line, so
        // report and continue (mirrors the stock transport's processReadBuffer).
        this.onerror?.(err instanceof Error ? err : new Error(String(err)));
        continue;
      }
      if (message === null) break;
      this.onmessage?.(message);
    }
  }

  private appendStderr(chunk: Buffer): void {
    this.stderrText += chunk.toString("utf-8");
    if (Buffer.byteLength(this.stderrText, "utf-8") > MCP_STDERR_CAP_BYTES) {
      // Ring behaviour: keep only the most recent MCP_STDERR_CAP_BYTES bytes.
      const buf = Buffer.from(this.stderrText, "utf-8");
      this.stderrText = buf.subarray(buf.length - MCP_STDERR_CAP_BYTES).toString("utf-8");
    }
  }
}

/**
 * Builds transports for the manager. stdio -> the hand-rolled kill-disciplined
 * transport above; http -> the stock Streamable HTTP transport (no OAuth in v1,
 * §5.1), returned behind the single boundary cast.
 */
export class NodeMcpTransportFactory implements McpTransportFactory {
  create(spec: McpServerSpec): McpWireTransport {
    if (spec.kind === "stdio") {
      return new NodeStdioMcpTransport(spec);
    }
    const transport = new StreamableHTTPClientTransport(new URL(spec.url), {
      requestInit: spec.headers ? { headers: spec.headers } : undefined,
    });
    return asWireTransport(transport);
  }
}
