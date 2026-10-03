/**
 * In-process MCP server + control-channel transport (TASK.226 срез S2, план
 * §3.4, факты F14/probes.md P0-P3). Exposes ONE model-visible tool over the
 * MCP SDK's own `Server` (never a hand-rolled JSON-RPC layer, ruling B5) so
 * the desktop host's claude-engine glue (срез S3) can serve
 * `mcp__anycode__agent` calls that arrive over the CLI's already-open control
 * channel — no `--mcp-config`, no socket, no port (F1/§2.1).
 *
 * `ControlChannelTransport` is the SDK `Transport` this server is `connect()`-
 * ed to. It is NOT a wire transport in the usual sense (nothing goes over a
 * socket): it is a synchronous adapter between one inbound `mcp_message`
 * envelope at a time (the glue's own concern, срез S3) and the SDK Server's
 * `onmessage`/`send` contract. A JSON-RPC REQUEST is fed to the server and
 * `handleInbound` resolves once the server answers that same id via `send()`;
 * a NOTIFICATION (e.g. `initialize`'s handshake `notifications/initialized`,
 * or a client-driven `notifications/cancelled`) is fed the same way but has
 * no reply to wait for, so `handleInbound` resolves to `null` immediately —
 * the glue supplies its own placeholder response for that case (§3.4).
 *
 * Cancellation needs NO bespoke code here: the SDK's `Protocol` base class
 * already matches an inbound `notifications/cancelled`'s `params.requestId`
 * against the `AbortController` it created for that in-flight request and
 * aborts it — the tool handler's `extra.signal` fires on its own (probes.md
 * P3: "AbortSignal для runAgentBridgeCall берётся из extra.signal SDK-
 * сервера, а не из signal конверта"). The same base class aborts every still-
 * pending request when the transport closes (its `close()` invokes the
 * wrapped `onclose`, which is `Protocol._onclose` after `connect()`), so
 * `ControlChannelTransport.close()` needs only to call `onclose()` — the
 * abort propagation is inherited, not reimplemented.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  isJSONRPCRequest,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { JSONRPCMessage, RequestId, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

// ---------------------------------------------------------------------------
// The tool declaration/call shapes this module speaks — deliberately its own
// (narrower, third-party-free) types rather than importing the SDK's `Tool`
// at the boundary the caller sees; the SDK type is used only internally, at
// the one line that actually builds a `tools/list` response.

export interface McpToolDecl {
  name: string;
  description: string;
  /** JSON Schema object (e.g. `z.toJSONSchema(...)`'s output) — an object-typed schema at runtime, same convention as manager.ts's bridged tools. */
  inputSchema: Record<string, unknown>;
}

export interface McpToolCallResult {
  text: string;
  isError: boolean;
}

/**
 * Correlation the CLI attaches to `tools/call` under `_meta` (probes P1:
 * `"_meta":{"claudecode/toolUseId":"toolu_…","progressToken":2}`). It is the
 * reason срез S3 needs no `tool_use` registry of its own — the id of the
 * claude-side tool call the subagent must be nested under arrives with the
 * call itself. Both fields are absent when the peer is not the claude CLI.
 */
export interface McpToolCallMeta {
  toolUseId?: string;
  progressToken?: string | number;
}

export interface CreateInProcessMcpServerOptions {
  serverName: string;
  version: string;
  /** Snapshot read on every `tools/list` — v1 never pushes `notifications/tools/list_changed` (plan §3.4/probes P0: handshake is once per process). */
  listTools: () => McpToolDecl[];
  /** Routes by tool name — v1 only ever registers one entry ("agent"), but nothing here assumes that. `signal` fires on `notifications/cancelled` OR on transport close (see module doc). */
  callTool: (
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    meta: McpToolCallMeta,
  ) => Promise<McpToolCallResult>;
}

/**
 * Builds an MCP `Server` over exactly `tools/list` + `tools/call`
 * (`capabilities: {tools: {}}` — no resources, no prompts, no sampling: this
 * door serves one thing). The returned server is unconnected; the caller
 * (срез S3's `ClaudeMcpBridge`) `server.connect(new ControlChannelTransport())`s
 * it.
 */
export function createInProcessMcpServer(options: CreateInProcessMcpServerOptions): Server {
  const server = new Server(
    { name: options.serverName, version: options.version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: options.listTools().map(
      (decl): Tool => ({
        name: decl.name,
        description: decl.description,
        // Boundary cast (same convention as manager.ts's listAllTools): an
        // object-schema JSON Schema IS the `{type:"object",...}` shape the
        // SDK's Tool.inputSchema expects at runtime.
        inputSchema: decl.inputSchema as Tool["inputSchema"],
      }),
    ),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const result = await options.callTool(request.params.name, args, extra.signal, readCallMeta(request.params._meta));
    return {
      content: [{ type: "text" as const, text: result.text }],
      isError: result.isError,
    };
  });

  return server;
}

/** Reads the two correlation fields out of a `tools/call` `_meta`, tolerating a peer that sends neither. */
function readCallMeta(meta: unknown): McpToolCallMeta {
  if (typeof meta !== "object" || meta === null) return {};
  const record = meta as Record<string, unknown>;
  const toolUseId = record["claudecode/toolUseId"];
  const progressToken = record.progressToken;
  return {
    ...(typeof toolUseId === "string" ? { toolUseId } : {}),
    ...(typeof progressToken === "string" || typeof progressToken === "number" ? { progressToken } : {}),
  };
}

// ---------------------------------------------------------------------------

/**
 * SDK `Transport` fed one inbound JSON-RPC message at a time via
 * `handleInbound` (§3.4) rather than reading from a socket. `send()` is the
 * ONLY way an answer ever reaches the caller: it settles the matching pending
 * `handleInbound` call by response id.
 */
export class ControlChannelTransport implements Transport {
  onmessage?: (message: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;

  private closed = false;
  private readonly pending = new Map<RequestId, (message: JSONRPCMessage | null) => void>();

  async start(): Promise<void> {
    // Nothing to open: this transport has no I/O of its own, only the
    // handleInbound()/send() pair below. Present so `Server.connect()`
    // (which calls `transport.start()`) has something to await.
  }

  /**
   * Called by the SDK Server (via `Protocol`) to answer or notify. A
   * response (has `id`) settles the `handleInbound` promise waiting on that
   * id; a server-initiated notification or request has no pending waiter in
   * v1 (the server never emits `notifications/tools/list_changed` — plan
   * §3.3 "v1 их не шлёт" — and never sends its own requests), so it is
   * silently dropped rather than mis-filed.
   */
  async send(message: JSONRPCMessage): Promise<void> {
    if (isJSONRPCRequest(message)) {
      return;
    }
    if ("id" in message && message.id !== undefined) {
      const resolve = this.pending.get(message.id);
      if (resolve !== undefined) {
        this.pending.delete(message.id);
        resolve(message);
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    // A request still waiting for `send()` at this point never gets one: once
    // Protocol._onclose() (invoked via the onclose chain below) aborts the
    // handler's controller, `_onrequest`'s success/error branches both check
    // `abortController.signal.aborted` and return WITHOUT sending anything
    // (protocol.js) — settle with null here so handleInbound never hangs past
    // this transport's own lifetime, symmetric with the notification case.
    for (const resolve of this.pending.values()) {
      resolve(null);
    }
    this.pending.clear();
    this.onclose?.();
  }

  /**
   * Feeds one inbound control-channel message into the SDK server (§3.4). A
   * JSON-RPC REQUEST (has `id`) is handed to `onmessage` and this resolves
   * once `send()` answers that exact id — a request an aborted handler never
   * answers (see `close()`) resolves to `null` instead of hanging. A
   * NOTIFICATION (no `id`) is handed to `onmessage` and this resolves to
   * `null` immediately: there is nothing to wait for (the caller's own
   * placeholder response covers the control-channel envelope in that case).
   */
  async handleInbound(message: JSONRPCMessage): Promise<JSONRPCMessage | null> {
    if (!isJSONRPCRequest(message)) {
      this.onmessage?.(message);
      return null;
    }
    return new Promise<JSONRPCMessage | null>((resolve) => {
      this.pending.set(message.id, resolve);
      this.onmessage?.(message);
    });
  }
}
