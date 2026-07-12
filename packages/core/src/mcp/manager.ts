/**
 * MCP manager (design slice-3.2-cut.md §3.4/§4.2). Lives in the agent process
 * (host-per-tab in desktop; the CLI process in a terminal), one instance per
 * process. On boot it connects every configured server in parallel (fail-soft,
 * per-server MCP_CONNECT_TIMEOUT_MS), bridges each server tool into the
 * ToolRegistry, and on shutdown disposes every transport with a deadline.
 *

 * start() (before the first turn) and dispose() (after the last). A
 * `notifications/tools/list_changed` is IGNORED in v1 (no listChanged handlers
 * are wired). A server that dies mid-session is marked `failed` but its tools
 * stay registered — a call then returns the "disconnected" error-outcome (the
 * dispatcher never throws, so history stays valid).
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import {
  MCP_CALL_TIMEOUT_MS,
  MCP_CONNECT_TIMEOUT_MS,
  MCP_DISPOSE_DEADLINE_MS,
} from "../types/config.js";
import type {
  McpServerSpec,
  McpServerStatus,
  McpTransportFactory,
  McpWireTransport,
} from "../ports/mcp.js";
import type { ToolContext } from "../types/tools.js";
import type { ToolRegistry } from "../tools/registry.js";
import {
  bridgeServerTools,
  type McpCallOutcome,
  type McpContentBlock,
  type McpRawTool,
} from "./tool-bridge.js";

export interface McpManagerOptions {
  registry: ToolRegistry;
  transports: McpTransportFactory;
  /** Optional status listener (host bridges it to the mcp_status wire message). */
  onStatusChange?: (statuses: McpServerStatus[]) => void;
  /**
   * Per-phase connect budget (bounds BOTH `client.connect` and the follow-up
   * `tools/list`); defaults to MCP_CONNECT_TIMEOUT_MS. Overridable so a test can
   * shrink it rather than wait the real budget. Production leaves it unset.
   */
  connectTimeoutMs?: number;
}

const CLIENT_INFO = { name: "anycode", version: "0.0.1" };

interface ServerRuntime {
  spec: McpServerSpec;
  status: McpServerStatus;
  client?: Client;
  transport?: McpWireTransport;
  alive: boolean;
  rawTools?: McpRawTool[];
  toolNames: string[];
  lastError?: string;
}

/** True when an error is the SDK's per-request timeout (McpError code RequestTimeout). */
export function isMcpTimeoutError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === ErrorCode.RequestTimeout
  );
}

/** Classifies a callTool rejection into a normalized outcome (pure; unit-tested). */
export function classifyMcpCallError(error: unknown, aborted: boolean): McpCallOutcome {
  if (aborted) return { kind: "cancelled" };
  if (error instanceof Error && error.name === "AbortError") return { kind: "cancelled" };
  if (isMcpTimeoutError(error)) return { kind: "timed_out" };
  return { kind: "failed", error: error instanceof Error ? error.message : String(error) };
}

/** Rejects if `promise` does not settle within `ms` (used to bound connect). */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Resolves when `promise` settles OR after `ms` (a backstop so dispose never hangs). */
function raceDeadline(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}

export class McpManager {
  private started = false;
  private disposed = false;
  private servers: ServerRuntime[] = [];

  constructor(private readonly options: McpManagerOptions) {}

  /**
   * Connects all specs in parallel, fail-soft; resolves when every server is
   * connected/failed (per-server MCP_CONNECT_TIMEOUT_MS). Registers bridged
   * tools into the registry. Idempotent-guard: start() is once-only in v1.
   */
  async start(specs: McpServerSpec[]): Promise<void> {
    if (this.started) {
      throw new Error("McpManager.start() already called (start() is once-only in v1)");
    }
    this.started = true;

    this.servers = specs.map((spec) => ({
      spec,
      alive: false,
      toolNames: [],
      status: {
        name: spec.name,
        transport: spec.kind,
        state: "connecting",
        toolCount: 0,
        toolsTruncated: false,
      },
    }));

    // Connect every server in parallel; connect() never rejects (fail-soft).
    await Promise.all(this.servers.map((runtime) => this.connect(runtime)));

    // Register bridged tools sequentially so cross-server / built-in collisions
    // resolve deterministically against the live registry.
    for (const runtime of this.servers) {
      if (runtime.status.state !== "connected" || !runtime.rawTools) continue;
      const bridged = bridgeServerTools({
        serverName: runtime.spec.name,
        transport: runtime.spec.kind,
        tools: runtime.rawTools,
        callTool: (toolName, args, ctx) => this.callServer(runtime, toolName, args, ctx),
        reserved: (name) => this.options.registry.has(name),
      });
      for (const definition of bridged.definitions) {
        this.options.registry.register(definition);
        runtime.toolNames.push(definition.metadata.name);
      }
      runtime.status.toolCount = bridged.definitions.length;
      runtime.status.toolsTruncated = bridged.toolsTruncated;
      if (bridged.warnings.length > 0) {
        console.warn(`McpManager[${runtime.spec.name}]: ${bridged.warnings.join("; ")}`);
      }
    }

    this.options.onStatusChange?.(this.status());
  }

  status(): McpServerStatus[] {
    return this.servers.map((runtime) => ({ ...runtime.status }));
  }

  /** Graceful close of every transport with deadline, then SIGKILL (stdio). */
  async dispose(opts?: { deadlineMs?: number }): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const deadlineMs = opts?.deadlineMs ?? MCP_DISPOSE_DEADLINE_MS;

    // Unregister bridged tools (registry is static; safe after the last turn).
    for (const runtime of this.servers) {
      for (const name of runtime.toolNames) {
        this.options.registry.unregister(name);
      }
      runtime.toolNames = [];
    }

    await Promise.allSettled(this.servers.map((runtime) => this.closeRuntime(runtime, deadlineMs)));

    for (const runtime of this.servers) {
      if (runtime.status.state !== "failed") {
        runtime.status.state = "closed";
      }
    }
    this.options.onStatusChange?.(this.status());
  }

  private async connect(runtime: ServerRuntime): Promise<void> {
    try {
      const transport = this.options.transports.create(runtime.spec);
      runtime.transport = transport;

      const client = new Client(CLIENT_INFO, { capabilities: {} });
      runtime.client = client;
      // Observe lifecycle via the CLIENT (Protocol) callbacks: Client.connect()
      // overwrites the transport's own onclose/onerror with its Protocol
      // handlers, which then fan out to client.onclose/onerror. This keeps us out
      // of the transport's message flow (the boundary-cast invariant).
      client.onerror = (err: unknown) => {
        runtime.lastError = err instanceof Error ? err.message : String(err);
      };
      client.onclose = () => {
        runtime.alive = false;
        // An UNEXPECTED close (server died mid-session) marks the server failed;
        // an intentional dispose is handled by dispose() itself (-> "closed").
        if (!this.disposed && runtime.status.state === "connected") {
          runtime.status.state = "failed";
          if (runtime.lastError && !runtime.status.error) {
            runtime.status.error = runtime.lastError;
          }
          // Notify the UI: a mid-session death must refresh the Settings row
          // (start()/dispose() are the only other emitters of the snapshot).
          this.options.onStatusChange?.(this.status());
        }
      };

      const connectTimeoutMs = this.options.connectTimeoutMs ?? MCP_CONNECT_TIMEOUT_MS;
      await withTimeout(
        client.connect(transport),
        connectTimeoutMs,
        `MCP server '${runtime.spec.name}' connect timed out after ${connectTimeoutMs}ms`,
      );

      // Bound tools/list by the SAME connect budget: the SDK otherwise falls back
      // to its own 60s-per-page default, so a server that finishes `initialize`
      // but stalls on `tools/list` would hang connect() well past the budget. On a
      // timeout this REJECTS into the catch below, which marks the server failed
      // and closes the transport — the stalled child is reaped, never orphaned.
      runtime.rawTools = await withTimeout(
        this.listAllTools(client),
        connectTimeoutMs,
        `MCP server '${runtime.spec.name}' tools/list timed out after ${connectTimeoutMs}ms`,
      );
      runtime.alive = true;
      runtime.status.state = "connected";
    } catch (err) {
      runtime.alive = false;
      runtime.status.state = "failed";
      runtime.status.error = runtime.lastError ?? (err instanceof Error ? err.message : String(err));
      // Reap any partially-started child so a connect failure leaves no orphan.
      try {
        await runtime.transport?.close();
      } catch {
        // best-effort.
      }
    }
  }

  private async listAllTools(client: Client): Promise<McpRawTool[]> {
    const tools: McpRawTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      for (const tool of page.tools) {
        tools.push({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema as Record<string, unknown>,
          // annotations are intentionally NOT carried through — the bridge
          // ignores them, and dropping them here proves they never reach metadata.
        });
      }
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }

  private async callServer(
    runtime: ServerRuntime,
    toolName: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<McpCallOutcome> {
    if (!runtime.alive || !runtime.client) {
      return { kind: "failed", error: `MCP server '${runtime.spec.name}' is disconnected` };
    }
    if (ctx.abortSignal.aborted) {
      return { kind: "cancelled" };
    }
    try {
      const result = await runtime.client.callTool({ name: toolName, arguments: args }, undefined, {
        signal: ctx.abortSignal,
        timeout: MCP_CALL_TIMEOUT_MS,
      });
      return {
        kind: "result",
        content: (result.content ?? []) as McpContentBlock[],
        isError: result.isError === true,
      };
    } catch (err) {
      return classifyMcpCallError(err, ctx.abortSignal.aborted);
    }
  }

  private async closeRuntime(runtime: ServerRuntime, deadlineMs: number): Promise<void> {
    const transport = runtime.transport;
    if (!transport) return;
    runtime.alive = false;
    // transport.close() owns the SIGTERM->SIGKILL escalation; the deadline is an
    // outer backstop so dispose never blocks longer than deadlineMs.
    await raceDeadline(transport.close(), deadlineMs);
  }
}
