/**
 * in-process-server.ts tests (TASK.226 срез S2, план §3.4/§5).
 *
 * `createInProcessMcpServer` is proven the same way manager.test.ts proves the
 * client side — hermetically, over `InMemoryTransport.createLinkedPair()` with
 * a REAL SDK `Client`, zero children. `ControlChannelTransport` has no socket
 * to link, so its own suite drives it directly with hand-built JSON-RPC
 * envelopes (exactly the shape a `control_request{subtype:"mcp_message"}`
 * carries, per probes.md) rather than through a Client.
 */

import { describe, expect, it, vi } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import {
  ControlChannelTransport,
  createInProcessMcpServer,
  type CreateInProcessMcpServerOptions,
  type McpToolCallResult,
  type McpToolDecl,
} from "./in-process-server.js";
import { buildAgentBridgeToolDecl, decodeAgentBridgeCallInput, runAgentBridgeCall } from "../subagents/agent-bridge.js";

const AGENT_DECL: McpToolDecl = {
  name: "agent",
  description: "Delegate a task to an AnyCode subagent profile.",
  inputSchema: {
    type: "object",
    properties: {
      agent_type: { type: "string" },
      prompt: { type: "string" },
    },
    required: ["agent_type", "prompt"],
  },
};

describe("createInProcessMcpServer (SDK Client over InMemoryTransport.createLinkedPair)", () => {
  async function connectedClient(options: {
    listTools: () => McpToolDecl[];
    callTool: (name: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<McpToolCallResult>;
  }) {
    const server = createInProcessMcpServer({ serverName: "anycode", version: "0.0.1", ...options });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "0.0.1" }, { capabilities: {} });
    await client.connect(clientTransport);
    return { client, server };
  }

  it("tools/list announces exactly the declared tool", async () => {
    const { client } = await connectedClient({
      listTools: () => [AGENT_DECL],
      callTool: async () => ({ text: "unused", isError: false }),
    });
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ name: "agent", description: AGENT_DECL.description });
    expect(tools[0]!.inputSchema).toEqual(AGENT_DECL.inputSchema);
  });

  it("an empty catalog announces zero tools", async () => {
    const { client } = await connectedClient({
      listTools: () => [],
      callTool: async () => ({ text: "unused", isError: false }),
    });
    const { tools } = await client.listTools();
    expect(tools).toEqual([]);
  });

  it("tools/call reaches callTool with the name and arguments, and returns its text", async () => {
    const callTool = vi.fn(async (name: string, args: Record<string, unknown>) => {
      expect(name).toBe("agent");
      expect(args).toEqual({ agent_type: "probe", prompt: "ping" });
      return { text: "ok 42", isError: false };
    });
    const { client } = await connectedClient({ listTools: () => [AGENT_DECL], callTool });
    const result = await client.callTool({ name: "agent", arguments: { agent_type: "probe", prompt: "ping" } });
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(false);
    expect(result.content).toEqual([{ type: "text", text: "ok 42" }]);
  });

  it("isError:true from callTool rides the CallToolResult's own isError, not a protocol error", async () => {
    const { client } = await connectedClient({
      listTools: () => [AGENT_DECL],
      callTool: async () => ({ text: "Unknown agent_type.", isError: true }),
    });
    const result = await client.callTool({ name: "agent", arguments: { agent_type: "bogus", prompt: "x" } });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "Unknown agent_type." }]);
  });

  it("a client-cancelled call aborts the handler's own signal (extra.signal, not the envelope's)", async () => {
    let capturedSignal: AbortSignal | undefined;
    let releaseCall: (() => void) | undefined;
    const callTool = vi.fn((_name: string, _args: Record<string, unknown>, signal: AbortSignal) => {
      capturedSignal = signal;
      return new Promise<McpToolCallResult>((resolve) => {
        releaseCall = () => resolve({ text: "too late", isError: false });
      });
    });
    const { client } = await connectedClient({ listTools: () => [AGENT_DECL], callTool });

    const controller = new AbortController();
    const call = client.callTool(
      { name: "agent", arguments: { agent_type: "probe", prompt: "slow" } },
      undefined,
      { signal: controller.signal },
    );
    await vi.waitFor(() => {
      if (capturedSignal === undefined) throw new Error("callTool not invoked yet");
    });
    expect(capturedSignal!.aborted).toBe(false);

    controller.abort(new Error("client gave up"));
    await expect(call).rejects.toThrow();
    await vi.waitFor(() => {
      if (!capturedSignal!.aborted) throw new Error("handler signal not aborted yet");
    });

    releaseCall?.(); // let the dangling handler settle so it does not leak into the next test.
  });
});

describe("ControlChannelTransport (hand-driven control-channel envelopes, no SDK Client)", () => {
  function request(id: number, method: string, params?: Record<string, unknown>): JSONRPCMessage {
    return { jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) } as JSONRPCMessage;
  }

  function notification(method: string, params?: Record<string, unknown>): JSONRPCMessage {
    return { jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) } as JSONRPCMessage;
  }

  async function connectedTransport(options: {
    listTools: () => McpToolDecl[];
    callTool: CreateInProcessMcpServerOptions["callTool"];
  }) {
    const server = createInProcessMcpServer({ serverName: "anycode", version: "0.0.1", ...options });
    const transport = new ControlChannelTransport();
    await server.connect(transport);
    return { server, transport };
  }

  async function initialize(transport: ControlChannelTransport): Promise<void> {
    const response = await transport.handleInbound(
      request(1, "initialize", {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "control-channel-probe", version: "0.0.1" },
      }),
    );
    expect(response).toMatchObject({ jsonrpc: "2.0", id: 1 });
    await transport.handleInbound(notification("notifications/initialized"));
  }

  it("a request with an id resolves to the server's response carrying that same id", async () => {
    const { transport } = await connectedTransport({
      listTools: () => [AGENT_DECL],
      callTool: async () => ({ text: "unused", isError: false }),
    });
    await initialize(transport);

    const response = await transport.handleInbound(request(2, "tools/list"));
    expect(response).toMatchObject({ jsonrpc: "2.0", id: 2 });
    expect((response as unknown as { result: { tools: unknown[] } }).result.tools).toHaveLength(1);
  });

  it("a notification resolves to null and still reaches the server (onmessage)", async () => {
    const { transport } = await connectedTransport({
      listTools: () => [AGENT_DECL],
      callTool: async () => ({ text: "unused", isError: false }),
    });
    const result = await transport.handleInbound(notification("notifications/initialized"));
    expect(result).toBeNull();
  });

  it("tools/call hands callTool the CLI's own correlation out of _meta (probes P1), so S3 needs no tool_use registry", async () => {
    const seen: unknown[] = [];
    const { transport } = await connectedTransport({
      listTools: () => [AGENT_DECL],
      callTool: async (_name, _args, _signal, meta) => {
        seen.push(meta);
        return { text: "done", isError: false };
      },
    });
    await initialize(transport);

    await transport.handleInbound(
      request(2, "tools/call", {
        name: "agent",
        arguments: { agent_type: "codex", prompt: "ping" },
        _meta: { "claudecode/toolUseId": "toolu_01PARENT", progressToken: 2 },
      }),
    );
    expect(seen).toEqual([{ toolUseId: "toolu_01PARENT", progressToken: 2 }]);

    // A peer that sends no _meta at all (any non-claude MCP client) is not an error:
    // the correlation is simply absent, and both fields stay undefined.
    await transport.handleInbound(request(3, "tools/call", { name: "agent", arguments: {} }));
    expect(seen[1]).toEqual({});
  });

  it("notifications/cancelled aborts the pending call's signal, matched by requestId", async () => {
    let capturedSignal: AbortSignal | undefined;
    const callTool = vi.fn((_name: string, _args: Record<string, unknown>, signal: AbortSignal) => {
      capturedSignal = signal;
      return new Promise<McpToolCallResult>(() => {
        // Deliberately never settles: the incident under test (probes.md P3)
        // is that a cancelled `mcp_message{tools/call}` gets NO response ever
        // — the handler is expected to observe the abort, not to return.
      });
    });
    const { transport } = await connectedTransport({ listTools: () => [AGENT_DECL], callTool });
    await initialize(transport);

    const pendingCall = transport.handleInbound(
      request(2, "tools/call", { name: "agent", arguments: { agent_type: "probe", prompt: "slow" } }),
    );
    await vi.waitFor(() => {
      if (capturedSignal === undefined) throw new Error("callTool not invoked yet");
    });
    expect(capturedSignal!.aborted).toBe(false);

    await transport.handleInbound(notification("notifications/cancelled", { requestId: 2, reason: "remote-cancel" }));
    await vi.waitFor(() => {
      if (!capturedSignal!.aborted) throw new Error("signal not aborted yet");
    });

    // The plan's own finding (probes.md P3): a cancelled call is answered
    // NEVER — pendingCall must not resolve on its own; it is only settled by
    // close() below (proven separately), never by a cancellation notification.
    const stillPending = await Promise.race([pendingCall.then(() => "resolved"), Promise.resolve("pending")]);
    expect(stillPending).toBe("pending");
  });

  it("closing the transport mid-call aborts the handler's signal AND settles the dangling handleInbound with null", async () => {
    let capturedSignal: AbortSignal | undefined;
    const callTool = vi.fn((_name: string, _args: Record<string, unknown>, signal: AbortSignal) => {
      capturedSignal = signal;
      return new Promise<McpToolCallResult>(() => {});
    });
    const { transport } = await connectedTransport({ listTools: () => [AGENT_DECL], callTool });
    await initialize(transport);

    const pendingCall = transport.handleInbound(
      request(2, "tools/call", { name: "agent", arguments: { agent_type: "probe", prompt: "slow" } }),
    );
    await vi.waitFor(() => {
      if (capturedSignal === undefined) throw new Error("callTool not invoked yet");
    });

    await transport.close();

    expect(capturedSignal!.aborted).toBe(true);
    await expect(pendingCall).resolves.toBeNull();
  });
});

// TASK.218 (supervisor correction 6): the Claude MCP transport's result path —
// a REAL runAgentBridgeCall delegation (mocked session port) projected through
// createInProcessMcpServer and read back over a real SDK Client, proving the
// child-session id + continue_session hint reach the wire verbatim.
describe("createInProcessMcpServer — agent result id/hint through runAgentBridgeCall (TASK.218)", () => {
  const CATALOG = [{ name: "glm-lead", description: "Leads", systemPrompt: "LEAD BODY" }] as const;

  function portFor(outcome: {
    finalText: string;
    childSessionId: string;
    withStart?: boolean;
  }): import("../ports/session-subagent.js").SessionSubagentPort {
    return {
      run: async (req, opts) => {
        if (outcome.withStart === true) {
          opts.onProgress?.({ kind: "start", agentType: "glm-lead", description: "d" });
        }
        return {
          status: "completed",
          finalText: outcome.finalText,
          truncated: false,
          turns: 1,
          toolCalls: 0,
          durationMs: 2,
          childSessionId: outcome.childSessionId,
          parentSessionId: "parent-1",
          spawnToolCallId: req.spawnToolCallId,
        };
      },
    };
  }

  async function callAgentOverTransport(
    port: import("../ports/session-subagent.js").SessionSubagentPort,
    args: Record<string, unknown>,
  ): Promise<{ isError: boolean | undefined; text: string }> {
    const decl = buildAgentBridgeToolDecl([...CATALOG], { continueSession: true, detach: true });
    if (decl === null) throw new Error("decl unexpectedly null");
    const server = createInProcessMcpServer({
      serverName: "anycode",
      version: "0.0.1",
      listTools: () => [decl],
      callTool: (name, callArgs, signal) =>
        runAgentBridgeCall(decodeAgentBridgeCallInput(callArgs)!, {
          catalog: CATALOG,
          port,
          spawnToolCallId: `bridge-${name}`,
          signal,
        }),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "0.0.1" }, { capabilities: {} });
    await client.connect(clientTransport);
    const result = (await client.callTool({ name: "agent", arguments: args })) as {
      isError?: boolean;
      content: { type: string; text: string }[];
    };
    return { isError: result.isError, text: result.content[0]!.text };
  }

  it("sync agent call: id + hint ride the MCP response text", async () => {
    const out = await callAgentOverTransport(portFor({ finalText: "did the thing", childSessionId: "child-1", withStart: true }), {
      agent_type: "glm-lead",
      description: "d",
      prompt: "p",
    });
    expect(out.isError).toBe(false);
    expect(out.text).toContain("Child session id: child-1");
    expect(out.text).toContain("continue_session");
  });

  it("detach: the admit text carries id + hint through the transport", async () => {
    const out = await callAgentOverTransport(
      portFor({ finalText: "Agent: child session child-1 started in the background.", childSessionId: "child-1" }),
      { agent_type: "glm-lead", description: "d", prompt: "p", detach: true },
    );
    expect(out.isError).toBe(false);
    expect(out.text).toContain("Child session id: child-1");
    expect(out.text).toContain("continue_session");
  });
});
