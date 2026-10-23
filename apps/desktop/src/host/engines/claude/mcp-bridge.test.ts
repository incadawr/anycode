/**
 * `ClaudeMcpBridge` tests, unit-level like `approval-bridge.test.ts` (direct
 * `InboundControlRequest`/`ControlRequestResponder` construction — no spawned
 * child, no `ClaudeClient`). Wire shapes below are copied from the live
 * captures in `working-docs/tasks/TASK.226.probes.md` (P0/P1/P3, CLI
 * 2.1.261) — never invented.
 */

import { describe, expect, it, vi } from "vitest";
import type { ControlRequestResponder, InboundControlRequest } from "./claude-client.js";
import { ClaudeMcpBridge, CLAUDE_MCP_NOTIFICATION_ACK, type ClaudeMcpToolCallMeta } from "./mcp-bridge.js";
import type { McpToolCallResult, McpToolDecl } from "@anycode/core";

function responderSpy(): { responder: ControlRequestResponder; success: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } {
  const success = vi.fn();
  const error = vi.fn();
  return { responder: { success, error }, success, error };
}

function inbound(request: Record<string, unknown>, signal: AbortSignal = new AbortController().signal): InboundControlRequest {
  return { requestId: "req-1", subtype: "mcp_message", request, signal };
}

const AGENT_TOOL: McpToolDecl = {
  name: "agent",
  description: "Run an AnyCode agent profile as a child session.",
  inputSchema: { type: "object", properties: { agent_type: { type: "string" } }, required: ["agent_type"], additionalProperties: false },
};

/** Live-captured (`p3.log`/`p3b.log`): the exact `mcp_message`-wrapped MCP `initialize` request the CLI sends BEFORE it answers AnyCode's own outbound `initialize` control_request. */
const MCP_INITIALIZE = {
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "claude-code", title: "Claude Code", version: "2.1.261", description: "Anthropic's agentic coding tool", websiteUrl: "https://claude.com/claude-code" },
  },
  jsonrpc: "2.0",
  id: 0,
};
const MCP_INITIALIZED_NOTIFICATION = { method: "notifications/initialized", jsonrpc: "2.0" };
const MCP_TOOLS_LIST = { method: "tools/list", jsonrpc: "2.0", id: 1 };

function mcpToolsCall(id: number, args: Record<string, unknown>, toolUseId: string, progressToken: number): Record<string, unknown> {
  return {
    method: "tools/call",
    params: { name: "agent", arguments: args, _meta: { "claudecode/toolUseId": toolUseId, progressToken } },
    jsonrpc: "2.0",
    id,
  };
}

function mcpCancelled(requestId: number, reason: string): Record<string, unknown> {
  return { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId, reason } };
}

type CallToolFn = (name: string, args: Record<string, unknown>, signal: AbortSignal, meta: ClaudeMcpToolCallMeta) => Promise<McpToolCallResult>;

function makeBridge(callTool: CallToolFn = async () => ({ text: "", isError: false })): ClaudeMcpBridge {
  return new ClaudeMcpBridge({ serverName: "anycode", version: "0.0.1", listTools: () => [AGENT_TOOL], callTool });
}

describe("ClaudeMcpBridge — announceOn (P0: sdkMcpServers is an array of bare NAME strings)", () => {
  it("carries only the server name — the {name} object form is what the live CLI rejects", () => {
    const bridge = makeBridge();
    expect(bridge.announceOn()).toEqual({ sdkMcpServers: ["anycode"] });
  });

  it("merges into whatever the caller already puts on initialize, without overwriting it", () => {
    const bridge = makeBridge();
    expect(bridge.announceOn({ foo: "bar" })).toEqual({ foo: "bar", sdkMcpServers: ["anycode"] });
  });
});

describe("ClaudeMcpBridge — the MCP handshake, with NO dependency on ClaudeClient.initialize() ever being called", () => {
  it("initialize / notifications/initialized / tools/list all resolve correctly from bridge construction alone", async () => {
    const bridge = makeBridge();

    // Nothing resembling `client.initialize()` runs anywhere in this test —
    // per probes.md P0, the live CLI drives this exact sequence INSIDE its
    // own control_request for OUR initialize, before answering it. The
    // bridge must not assume that call ever resolved, or was even made.
    const init = responderSpy();
    await bridge.handleControlRequest(inbound({ server_name: "anycode", message: MCP_INITIALIZE }), init.responder);
    expect(init.error).not.toHaveBeenCalled();
    const initAnswer = init.success.mock.calls[0]![0] as { mcp_response: { result: { protocolVersion: string; capabilities: { tools: unknown }; serverInfo: { name: string } }; id: number } };
    expect(initAnswer.mcp_response.id).toBe(0);
    expect(initAnswer.mcp_response.result.serverInfo.name).toBe("anycode");
    expect(initAnswer.mcp_response.result.capabilities.tools).toBeDefined();

    const initialized = responderSpy();
    await bridge.handleControlRequest(inbound({ server_name: "anycode", message: MCP_INITIALIZED_NOTIFICATION }), initialized.responder);
    // Taskana 4238: a notification is answered with the official Agent SDK's
    // empty JSON-RPC result, NOT an empty success. CLI 2.1.261 tolerated the
    // absent `response` body; 2.1.288+ parses every mcp_message answer as an
    // object `{mcp_response?}` and throws on `undefined`, failing the whole
    // SDK MCP connect at `notifications/initialized`.
    expect(initialized.success).toHaveBeenCalledTimes(1);
    expect(initialized.success.mock.calls[0]![0]).toEqual({ mcp_response: { jsonrpc: "2.0", result: {}, id: 0 } });
    expect(initialized.error).not.toHaveBeenCalled();

    const list = responderSpy();
    await bridge.handleControlRequest(inbound({ server_name: "anycode", message: MCP_TOOLS_LIST }), list.responder);
    const listAnswer = list.success.mock.calls[0]![0] as { mcp_response: { id: number; result: { tools: McpToolDecl[] } } };
    expect(listAnswer.mcp_response.id).toBe(1);
    expect(listAnswer.mcp_response.result.tools).toEqual([AGENT_TOOL]);
  });
});

describe("ClaudeMcpBridge — tools/call reaches the injected handler and answers as control_response{mcp_response}", () => {
  it("passes name/args/meta through, and the resolved result rides back on the SAME jsonrpc id", async () => {
    const seen: { name?: string; args?: Record<string, unknown>; meta?: ClaudeMcpToolCallMeta; signal?: AbortSignal } = {};
    const callTool = vi.fn(async (name: string, args: Record<string, unknown>, signal: AbortSignal, meta: ClaudeMcpToolCallMeta) => {
      seen.name = name;
      seen.args = args;
      seen.meta = meta;
      seen.signal = signal;
      return { text: "ok 2026-09-06", isError: false };
    });
    const bridge = makeBridge(callTool);

    const call = responderSpy();
    await bridge.handleControlRequest(
      inbound({ server_name: "anycode", message: mcpToolsCall(2, { agent_type: "probe", description: "probe run", prompt: "ping" }, "toolu_01ABC", 2) }),
      call.responder,
    );

    expect(seen.name).toBe("agent");
    expect(seen.args).toEqual({ agent_type: "probe", description: "probe run", prompt: "ping" });
    // TASK.226 probes P1: correlation rides in on `tools/call`'s own `_meta`
    // — this is precisely why srez S3 needs no `tool_use` registry of its own.
    expect(seen.meta).toEqual({ toolUseId: "toolu_01ABC", progressToken: 2 });
    expect(seen.signal?.aborted).toBe(false);

    expect(call.error).not.toHaveBeenCalled();
    const answer = call.success.mock.calls[0]![0] as { mcp_response: { id: number; result: { content: { type: string; text: string }[]; isError: boolean } } };
    expect(answer.mcp_response.id).toBe(2);
    expect(answer.mcp_response.result).toEqual({ content: [{ type: "text", text: "ok 2026-09-06" }], isError: false });
  });
});

describe("ClaudeMcpBridge — notifications/cancelled (P3: the ONLY cancellation signal that ever arrives)", () => {
  it("fires the tool handler's AbortSignal, force-closes the pending tools/call's control_request, and leaves nothing to leak", async () => {
    let capturedSignal: AbortSignal | undefined;
    // Mirrors the live behaviour exactly (probes.md P3, two runs): once the
    // SDK server's `extra.signal` aborts, it never calls `transport.send()`
    // for that request — so a callTool stub that never settles is the
    // faithful stand-in, not a shortcut.
    const callTool = vi.fn((_name: string, _args: Record<string, unknown>, signal: AbortSignal) => {
      capturedSignal = signal;
      return new Promise<McpToolCallResult>(() => {});
    });
    const bridge = makeBridge(callTool);

    const call = responderSpy();
    // Intentionally not awaited: per P3 this promise never settles (the SDK
    // server sends zero bytes back for a cancelled request) — awaiting it
    // would hang the test forever, which is itself the leak this bridge
    // exists to prevent one layer up, in `ClaudeClient.pendingInbound`.
    void bridge.handleControlRequest(inbound({ server_name: "anycode", message: mcpToolsCall(2, { agent_type: "probe" }, "toolu_01ABC", 2) }), call.responder);
    await Promise.resolve();
    await Promise.resolve();
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(call.success).not.toHaveBeenCalled();

    const cancel = responderSpy();
    await bridge.handleControlRequest(inbound({ server_name: "anycode", message: mcpCancelled(2, "AbortError: remote-cancel") }), cancel.responder);

    // The tool handler actually gets cancelled...
    expect(capturedSignal?.aborted).toBe(true);
    // ...AND, independently, the ORIGINAL tools/call's own outer
    // control_request is answered — a JSON-RPC error for its OWN id
    // (Taskana 4238: the CLI requires an object body for every mcp_message
    // answer; 2.1.261's empty success is rejected by 2.1.288+). Without this
    // answer at all, `ClaudeClient.pendingInbound` keeps one entry per
    // cancelled call forever.
    expect(call.error).not.toHaveBeenCalled();
    expect(call.success).toHaveBeenCalledTimes(1);
    expect(call.success.mock.calls[0]![0]).toEqual({ mcp_response: { jsonrpc: "2.0", id: 2, error: { code: -32800, message: "Request cancelled" } } });
    // The cancellation notification's OWN envelope gets the notification ack.
    expect(cancel.success).toHaveBeenCalledTimes(1);
    expect(cancel.success.mock.calls[0]![0]).toEqual(CLAUDE_MCP_NOTIFICATION_ACK);

    // Idempotent: bookkeeping for id 2 was actually REMOVED, not merely
    // ignored once — a duplicate/late cancellation must not double-answer.
    const secondCancel = responderSpy();
    await bridge.handleControlRequest(inbound({ server_name: "anycode", message: mcpCancelled(2, "duplicate") }), secondCancel.responder);
    expect(call.success).toHaveBeenCalledTimes(1);
    expect(secondCancel.success).toHaveBeenCalledTimes(1);
  });
});

describe("ClaudeMcpBridge — server_name mismatch", () => {
  it("a foreign server_name is refused rather than routed", async () => {
    const bridge = makeBridge();
    const { responder, success, error } = responderSpy();

    await bridge.handleControlRequest(inbound({ server_name: "someone-elses-server", message: MCP_TOOLS_LIST }), responder);

    expect(success).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
  });
});

describe("ClaudeMcpBridge — Taskana 4238: every mcp_message answer carries an object body", () => {
  it("the CLI parses every answer as `{mcp_response?}` — no call may succeed with an absent/undefined body", async () => {
    const bridge = makeBridge();

    // A never-settling callTool so the cancelled-call path leaves a pending
    // entry to force-close (same stand-in as the P3 suite above).
    const neverSettles = vi.fn(() => new Promise<McpToolCallResult>(() => {}));
    const cancelledBridge = new ClaudeMcpBridge({ serverName: "anycode", version: "0.0.1", listTools: () => [AGENT_TOOL], callTool: neverSettles });

    const spies = [responderSpy(), responderSpy(), responderSpy(), responderSpy(), responderSpy()];
    await bridge.handleControlRequest(inbound({ server_name: "anycode", message: MCP_INITIALIZE }), spies[0]!.responder);
    await bridge.handleControlRequest(inbound({ server_name: "anycode", message: MCP_INITIALIZED_NOTIFICATION }), spies[1]!.responder);
    await bridge.handleControlRequest(inbound({ server_name: "anycode", message: MCP_TOOLS_LIST }), spies[2]!.responder);
    void cancelledBridge.handleControlRequest(inbound({ server_name: "anycode", message: mcpToolsCall(9, { agent_type: "probe" }, "toolu_01XYZ", 3) }), spies[3]!.responder);
    await Promise.resolve();
    await Promise.resolve();
    await cancelledBridge.handleControlRequest(inbound({ server_name: "anycode", message: mcpCancelled(9, "AbortError") }), spies[4]!.responder);

    const settled = spies
      .filter((spy) => spy.success.mock.calls.length > 0)
      .map((spy) => spy.success.mock.calls[0]![0]);
    expect(settled.length).toBe(5);
    for (const body of settled) {
      expect(body).not.toBeNull();
      expect(typeof body).toBe("object");
      expect((body as { mcp_response?: unknown }).mcp_response).toBeTypeOf("object");
      expect((body as { mcp_response?: { jsonrpc?: unknown } }).mcp_response!.jsonrpc).toBe("2.0");
    }
  });

  it("the CLI's connect sequence succeeds under its strict body parsing", async () => {
    // `apps/desktop` cannot import `@modelcontextprotocol/sdk` (it is a
    // dependency of core only), so this mirrors the CLI's own resolver:
    // `z.object({mcp_response: ...}).parse(response.response)` throws
    // "expected object, received undefined" when the `response` key is
    // absent. With the pre-4238 bridge this throws at step 2
    // (`notifications/initialized`) — the exact live failure.
    const cliStrictSend = async (bridge: ClaudeMcpBridge, message: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const { responder, success } = responderSpy();
      await bridge.handleControlRequest(inbound({ server_name: "anycode", message }), responder);
      if (success.mock.calls.length !== 1) throw new Error(`expected exactly one success for ${String(message.method)}`);
      const body = success.mock.calls[0]![0];
      if (body === null || typeof body !== "object") throw new Error("expected object, received undefined");
      return body.mcp_response as Record<string, unknown>;
    };

    const bridge = makeBridge();
    const init = await cliStrictSend(bridge, MCP_INITIALIZE);
    expect(init).toBeTypeOf("object");
    await cliStrictSend(bridge, MCP_INITIALIZED_NOTIFICATION);
    const list = await cliStrictSend(bridge, MCP_TOOLS_LIST);
    const result = list.result as { tools: McpToolDecl[] };
    expect(result.tools[0]!.name).toBe("agent");
  });
});
