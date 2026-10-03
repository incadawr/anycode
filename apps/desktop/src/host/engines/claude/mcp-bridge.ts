/**
 * `ClaudeMcpBridge` — the desktop glue that serves the CLI's in-process MCP
 * door (TASK.226 срез S3, plan §3.3/§3.4 as amended by
 * `working-docs/tasks/TASK.226.probes.md` P0/P1/P3). Wires срез S2's
 * `createInProcessMcpServer`/`ControlChannelTransport` (`@anycode/core`) to
 * `ClaudeClient`'s control-request routing (`approval-bridge.ts`), using the
 * literal wire shapes CLI 2.1.261 was proven, live, to send and accept.
 *
 * Scope boundary (this is S3, not S4): the tool catalog and the call handler
 * are BOTH injected. This module owns transport and routing only — never the
 * session-tier port, the profile catalog, the wall clock, or the
 * non-recursion lock, which are `bootClaudeSession`'s business.
 *
 * Three probe findings this file is built around (each is a correction to
 * the pre-probe plan, not a fresh guess):
 *
 * 1. (P0) `initialize`'s `sdkMcpServers` is an array of bare NAME strings,
 *    not `{name}` objects — the live CLI rejects the object form outright
 *    ("sdkMcpServers ... must be arrays of strings"). `announceOn` below
 *    never reverts to the object shape.
 * 2. (P0) the CLI drives the MCP handshake (`initialize` -> `notifications/
 *    initialized` -> `tools/list`, each wrapped as `mcp_message`) BEFORE it
 *    answers our OWN outbound `initialize` control_request. This bridge
 *    therefore has no dependency on `ClaudeClient.initialize()` ever
 *    resolving, or even being called yet — `handleControlRequest` is ready
 *    the moment the bridge exists, which is what lets the caller attach it
 *    to `ClaudeApprovalBridge` before sending `initialize` at all.
 * 3. (P3) cancellation NEVER arrives as `control_cancel_request` for an
 *    `mcp_message`'s outer envelope — only `notifications/cancelled`,
 *    itself another `mcp_message`. Left alone, the outer control_request
 *    that carried the cancelled `tools/call` would never get answered (the
 *    SDK server, once its `extra.signal` aborts, never calls
 *    `transport.send()` for that id — confirmed live, twice: zero bytes
 *    back), leaking one `ClaudeClient.pendingInbound` entry per cancelled
 *    call. `pendingCalls` below exists solely to force that entry closed.
 */

import { ControlChannelTransport, createInProcessMcpServer, type McpToolCallResult, type McpToolDecl } from "@anycode/core";
import type { ControlRequestResponder, InboundControlRequest } from "./claude-client.js";

/**
 * `apps/desktop` has no direct dependency on `@modelcontextprotocol/sdk`
 * (only `packages/core` does — срез S2's own `package.json`), so its types
 * are never imported by NAME here; `Parameters<...>` pulls the exact
 * `JSONRPCMessage` type structurally off the already-imported
 * `ControlChannelTransport` instead, resolved from `@anycode/core`'s own
 * dependency graph rather than this package's.
 */
type McpInboundMessage = Parameters<ControlChannelTransport["handleInbound"]>[0];
/** The SDK's `RequestId` is exactly `string | number` (`RequestIdSchema` — a bare union of the two, nothing more), so this is not an approximation. */
type McpRequestId = string | number;

/**
 * Every tool this door ever declares is named `mcp__<serverName>__<tool>` by
 * MCP convention, so this prefix alone identifies "our door" in a
 * `can_use_tool` request when the owned bridge is attached: `approval-
 * bridge.ts` grants these without a dialog (plan §2.6) — the child session
 * spawned behind the door has its own broker for what it actually does.
 */
export const CLAUDE_ANYCODE_MCP_TOOL_PREFIX = "mcp__anycode__";

/**
 * Structurally identical to core's `McpToolCallMeta`
 * (`packages/core/src/mcp/in-process-server.ts`), which is not on
 * `@anycode/core`'s barrel (срез S2 exports only `CreateInProcessMcpServerOptions`
 * / `McpToolCallResult` / `McpToolDecl`, not the meta type by itself).
 * Re-declared here rather than widening core's exports — TypeScript's
 * structural typing accepts this shape wherever `McpToolCallMeta` is
 * expected, and `packages/core` is out of scope for this slice.
 */
export interface ClaudeMcpToolCallMeta {
  toolUseId?: string;
  progressToken?: string | number;
}

export interface ClaudeMcpBridgeOptions {
  /** MCP server name announced on `initialize` and matched against every inbound `mcp_message.server_name` — "anycode" in production. */
  serverName: string;
  version: string;
  /** Injected (срез S4 builds the real one from `discoverAgentProfiles`) — this module never reads a profile catalog itself. */
  listTools: () => McpToolDecl[];
  /** Injected (срез S4 wires this to `runAgentBridgeCall` + the session-tier port) — this module never spawns a child session itself. */
  callTool: (
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    meta: ClaudeMcpToolCallMeta,
  ) => Promise<McpToolCallResult>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/** The JSON-RPC id a `notifications/cancelled` message targets, or `undefined` if this is not that notification (or it is malformed). */
function cancelledTargetId(message: McpInboundMessage): McpRequestId | undefined {
  const candidate = message as { method?: unknown; params?: unknown };
  if (candidate.method !== "notifications/cancelled") return undefined;
  const requestId = record(candidate.params)?.requestId;
  return typeof requestId === "string" || typeof requestId === "number" ? requestId : undefined;
}

export class ClaudeMcpBridge {
  readonly serverName: string;
  private readonly transport: ControlChannelTransport;
  /**
   * Outer `control_request` responders for a `tools/call` (or any other
   * JSON-RPC REQUEST) still in flight, keyed by the INNER MCP id —
   * `handleControlRequest`'s own bookkeeping, separate from and in ADDITION
   * to whatever `ControlChannelTransport` tracks internally (S2's `pending`
   * map is that module's concern, not this one's). See module doc point 3:
   * this is what gets force-cleared on `notifications/cancelled` instead of
   * waiting for an answer the SDK server will never send.
   */
  private readonly pendingCalls = new Map<McpRequestId, ControlRequestResponder>();

  constructor(options: ClaudeMcpBridgeOptions) {
    this.serverName = options.serverName;
    this.transport = new ControlChannelTransport();
    const server = createInProcessMcpServer({
      serverName: options.serverName,
      version: options.version,
      listTools: options.listTools,
      callTool: options.callTool,
    });
    // `Server.connect()` only awaits `transport.start()`, which resolves
    // synchronously (S2 doc: "nothing to open") — nothing here is worth
    // blocking the constructor for, and a constructor cannot be async.
    void server.connect(this.transport);
  }

  /**
   * `initialize`'s wire body (P0, live-confirmed): a bare array of server
   * NAME strings. `extra` carries whatever the caller already puts on
   * `initialize` (none, today) — merged in, never overwritten by this field.
   */
  announceOn(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { ...extra, sdkMcpServers: [this.serverName] };
  }

  /**
   * `ClaudeApprovalBridge.route` calls this for `subtype:"mcp_message"` once
   * a bridge is attached. Handles every inbound shape probed live:
   * - a JSON-RPC REQUEST (`initialize`, `tools/list`, `tools/call` — has an
   *   `id`): answered `control_response{response:{mcp_response:<answer>}}`
   *   once the SDK server actually answers that id.
   * - a plain NOTIFICATION (`notifications/initialized`): fed through and
   *   acknowledged with an EMPTY success (no `response` key at all) — the
   *   same "nothing to report" shape the general control-response envelope
   *   already uses elsewhere, not a bespoke one.
   * - `notifications/cancelled`: same empty-success treatment for ITS OWN
   *   envelope, plus the force-close in `cancelPending` for the call it
   *   targets (module doc point 3).
   */
  handleControlRequest = async (request: InboundControlRequest, responder: ControlRequestResponder): Promise<void> => {
    const body = request.request;
    const serverName = typeof body.server_name === "string" ? body.server_name : null;
    const rawMessage = record(body.message);
    if (serverName !== this.serverName || rawMessage === null) {
      responder.error(`AnyCode's MCP bridge does not serve "${serverName ?? "unknown"}"`);
      return;
    }
    const message = rawMessage as unknown as McpInboundMessage;

    const cancelTarget = cancelledTargetId(message);
    if (cancelTarget !== undefined) this.cancelPending(cancelTarget);

    const jsonRpcId = "id" in message && message.id !== undefined ? (message.id as McpRequestId) : undefined;
    if (jsonRpcId !== undefined) this.pendingCalls.set(jsonRpcId, responder);
    const result = await this.transport.handleInbound(message);
    if (jsonRpcId !== undefined) {
      // `cancelPending` already answered (and removed) this entry while the
      // line above was in flight — a cancelled `tools/call` never reaches
      // this point at all (module doc point 3: the SDK server sends nothing
      // back for it), but the guard is unconditional rather than assuming
      // that race can only go one way.
      if (!this.pendingCalls.delete(jsonRpcId)) return;
    }
    responder.success(result === null ? undefined : { mcp_response: result });
  };

  /**
   * Forces the outer `control_request` for a still-pending `tools/call`
   * (or any other in-flight JSON-RPC request) closed the instant its
   * `notifications/cancelled` arrives, rather than waiting on a
   * `transport.handleInbound` promise the SDK server will never settle
   * (probes.md P3, confirmed by two live runs: the server writes zero bytes
   * back once a request's abort signal has fired). An empty success is
   * enough — the CLI has already moved on from this specific request by the
   * time its own cancellation notification round-trips.
   */
  private cancelPending(jsonRpcId: McpRequestId): void {
    const pending = this.pendingCalls.get(jsonRpcId);
    if (pending === undefined) return;
    this.pendingCalls.delete(jsonRpcId);
    pending.success();
  }
}
