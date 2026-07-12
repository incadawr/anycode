/**
 * McpManager tests (design slice-3.2-cut.md §5.2 items 3 + 5), all hermetic over
 * InMemoryTransport.createLinkedPair() — a real in-process MCP server, zero
 * children, full determinism.
 *
 * item 3 (manager + InMemory): start->list->register; caps (33rd tool dropped +
 *   toolsTruncated); listChanged ignored (v1 static registry); status
 *   transitions; dispose->unregister; repeat start() guarded.
 * item 5 (dispatch integration): a bridged mcp tool in the registry; auto-mode ask
 *   REACHES the broker (fail-closed proven with DenyPermissionBroker); deny ->
 *   denied; plan-mode -> denied (base deny, broker not consulted); an always-allow
 *   rule -> allow WITHOUT ask + a live call; server error -> error-outcome, and a
 *   full loop leaves unansweredToolCallIds() === [].
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  AgentLoop,
  DenyPermissionBroker,
  InMemoryHookRunner,
  InMemoryTodoStore,
  ModePermissionEngine,
  NodeExecutionAdapter,
  NodeFileSystemAdapter,
  NodeHttpAdapter,
  RuleAwarePermissionEngine,
  SessionPermissionRules,
  ToolRegistry,
  executeToolCall,
} from "../index.js";
import type { DispatchContext } from "../dispatch/dispatcher.js";
import { MCP_MAX_TOOLS_PER_SERVER } from "../types/config.js";
import type { McpServerSpec, McpServerStatus, McpTransportFactory, McpWireTransport } from "../ports/mcp.js";
import type { ModelPort, ModelRequest } from "../ports/index.js";
import type {
  AgentEvent,
  ModelStreamEvent,
  PermissionDecision,
  PermissionRequest,
} from "../types/index.js";
import { McpManager, classifyMcpCallError } from "./manager.js";

// ---------------------------------------------------------------------------
// Test transports. The boundary cast (SDK -> port) is the single checked cast
// permitted for test code by fable's transport-cast ruling (§3.2).

function asWire(t: Transport): McpWireTransport {
  return t as McpWireTransport;
}

/** A factory that links each spec to a pre-built in-process McpServer. */
class LinkedFactory implements McpTransportFactory {
  constructor(private readonly servers: Record<string, McpServer>) {}
  create(spec: McpServerSpec): McpWireTransport {
    const server = this.servers[spec.name];
    if (!server) {
      // Simulates a dead server: start() rejects, connect() fails soft.
      return new FailingTransport();
    }
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    void server.connect(serverTransport);
    return asWire(clientTransport);
  }
}

/**
 * Links a single spec to one in-process server AND captures the client-side
 * transport, so a test can drive its `onclose` directly. After start(), the SDK
 * `Client.connect` has overwritten `onclose` with its own Protocol handler, so
 * invoking it simulates a mid-session transport death (the server process dying)
 * without depending on InMemoryTransport's close-propagation semantics.
 */
class ExposingLinkedFactory implements McpTransportFactory {
  clientTransport: McpWireTransport | undefined;
  constructor(private readonly server: McpServer) {}
  create(): McpWireTransport {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    void this.server.connect(serverTransport);
    const wire = asWire(clientTransport);
    this.clientTransport = wire;
    return wire;
  }
}

class FailingTransport implements McpWireTransport {
  onmessage?: (message: Record<string, unknown>) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  start(): Promise<void> {
    return Promise.reject(new Error("simulated spawn failure"));
  }
  send(): Promise<void> {
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.onclose?.();
    return Promise.resolve();
  }
}

function ports() {
  return {
    fs: new NodeFileSystemAdapter(),
    exec: new NodeExecutionAdapter(),
    http: new NodeHttpAdapter(),
    todos: new InMemoryTodoStore(),
  };
}

/** An in-process MCP server with echo (reflects) + fail (isError) tools. */
function echoFailServer(): McpServer {
  const server = new McpServer({ name: "srv", version: "0" });
  server.registerTool("echo", { description: "echoes", inputSchema: { message: z.string() } }, async ({ message }) => ({
    content: [{ type: "text", text: message }],
  }));
  server.registerTool("fail", { description: "always errors", inputSchema: {} }, async () => ({
    content: [{ type: "text", text: "server-side boom" }],
    isError: true,
  }));
  return server;
}

/** An in-process MCP server exposing `count` tools named tool0..tool{count-1}. */
function manyToolServer(count: number): McpServer {
  const server = new McpServer({ name: "srv", version: "0" });
  for (let i = 0; i < count; i += 1) {
    server.registerTool(`tool${i}`, { description: `t${i}`, inputSchema: {} }, async () => ({
      content: [{ type: "text", text: "ok" }],
    }));
  }
  return server;
}

const spec = (name: string): McpServerSpec => ({
  kind: "stdio",
  name,
  command: "unused",
  args: [],
  env: {},
});

describe("McpManager — lifecycle (item 3)", () => {
  let manager: McpManager | undefined;

  afterEach(async () => {
    if (manager) {
      await manager.dispose();
      manager = undefined;
    }
  });

  it("connects, lists, and registers bridged tools; status is connected", async () => {
    const registry = new ToolRegistry();
    manager = new McpManager({ registry, transports: new LinkedFactory({ srv: echoFailServer() }) });
    await manager.start([spec("srv")]);

    expect(registry.has("mcp__srv__echo")).toBe(true);
    expect(registry.has("mcp__srv__fail")).toBe(true);
    const status = manager.status();
    expect(status).toHaveLength(1);
    expect(status[0]).toMatchObject({ name: "srv", transport: "stdio", state: "connected", toolCount: 2, toolsTruncated: false });
    // Bridged metadata is fail-closed regardless of what the server said.
    expect(registry.getMetadata("mcp__srv__echo")).toMatchObject({ riskLevel: "high", needsApproval: true, readOnly: false });
  });

  it("drops the 33rd tool at the per-server cap and reports toolsTruncated", async () => {
    const registry = new ToolRegistry();
    manager = new McpManager({ registry, transports: new LinkedFactory({ srv: manyToolServer(MCP_MAX_TOOLS_PER_SERVER + 1) }) });
    await manager.start([spec("srv")]);

    const registered = registry.list().filter((n) => n.startsWith("mcp__srv__"));
    expect(registered).toHaveLength(MCP_MAX_TOOLS_PER_SERVER);
    expect(manager.status()[0]!.toolsTruncated).toBe(true);
  });

  it("ignores a tools/list_changed notification (registry is static in v1)", async () => {
    const registry = new ToolRegistry();
    const server = echoFailServer();
    manager = new McpManager({ registry, transports: new LinkedFactory({ srv: server }) });
    await manager.start([spec("srv")]);
    const before = registry.list().sort();

    // Register a NEW tool on the live server, then fire list_changed.
    server.registerTool("added_later", { description: "late", inputSchema: {} }, async () => ({ content: [{ type: "text", text: "x" }] }));
    server.sendToolListChanged();
    await new Promise((r) => setTimeout(r, 50));

    expect(registry.list().sort()).toEqual(before);
    expect(registry.has("mcp__srv__added_later")).toBe(false);
  });

  it("marks an unreachable server failed (fail-soft) without blocking others", async () => {
    const registry = new ToolRegistry();
    manager = new McpManager({ registry, transports: new LinkedFactory({ ok: echoFailServer() }) });
    await manager.start([spec("ok"), spec("dead")]);

    const byName = Object.fromEntries(manager.status().map((s) => [s.name, s]));
    expect(byName.ok!.state).toBe("connected");
    expect(byName.dead!.state).toBe("failed");
    expect(byName.dead!.error).toBeTruthy();
    expect(registry.has("mcp__ok__echo")).toBe(true);
  });

  it("dispose unregisters bridged tools and marks servers closed", async () => {
    const registry = new ToolRegistry();
    const m = new McpManager({ registry, transports: new LinkedFactory({ srv: echoFailServer() }) });
    await m.start([spec("srv")]);
    expect(registry.has("mcp__srv__echo")).toBe(true);

    await m.dispose();
    expect(registry.has("mcp__srv__echo")).toBe(false);
    expect(registry.has("mcp__srv__fail")).toBe(false);
    expect(m.status()[0]!.state).toBe("closed");
  });

  it("guards a repeat start() (once-only in v1)", async () => {
    const registry = new ToolRegistry();
    manager = new McpManager({ registry, transports: new LinkedFactory({ srv: echoFailServer() }) });
    await manager.start([spec("srv")]);
    await expect(manager.start([spec("srv")])).rejects.toThrow(/once-only/);
  });

  it("notifies onStatusChange when a connected server dies mid-session (onclose -> failed)", async () => {
    const registry = new ToolRegistry();
    const factory = new ExposingLinkedFactory(echoFailServer());
    const snapshots: McpServerStatus[][] = [];
    manager = new McpManager({ registry, transports: factory, onStatusChange: (s) => snapshots.push(s) });
    await manager.start([spec("srv")]);
    expect(manager.status()[0]!.state).toBe("connected");
    const afterStart = snapshots.length; // start() emits one snapshot at the end

    // Simulate the server process dying: the SDK Client fires onclose, which must
    // flip the server to failed AND re-emit the snapshot so the UI row refreshes.
    factory.clientTransport!.onclose?.();

    expect(manager.status()[0]!.state).toBe("failed");
    expect(snapshots.length).toBe(afterStart + 1);
    expect(snapshots[snapshots.length - 1]![0]!.state).toBe("failed");
  });
});

describe("classifyMcpCallError (unit)", () => {
  it("maps abort/timeout/other deterministically", () => {
    expect(classifyMcpCallError(new Error("x"), true)).toEqual({ kind: "cancelled" });
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    expect(classifyMcpCallError(abortErr, false)).toEqual({ kind: "cancelled" });
    // McpError code RequestTimeout === -32001.
    expect(classifyMcpCallError({ code: -32001, message: "timeout" }, false)).toEqual({ kind: "timed_out" });
    expect(classifyMcpCallError(new Error("boom"), false)).toMatchObject({ kind: "failed", error: "boom" });
  });
});

// ---------------------------------------------------------------------------
// item 5 — dispatch integration.

class RecordingBroker {
  readonly seen: PermissionRequest[] = [];
  constructor(private readonly decision: PermissionDecision) {}
  requestPermission(request: PermissionRequest): Promise<PermissionDecision> {
    this.seen.push(request);
    return Promise.resolve(this.decision);
  }
}

describe("McpManager — dispatch integration (item 5)", () => {
  let manager: McpManager | undefined;
  let registry: ToolRegistry;

  afterEach(async () => {
    if (manager) {
      await manager.dispose();
      manager = undefined;
    }
  });

  async function startManager(): Promise<void> {
    registry = new ToolRegistry();
    manager = new McpManager({ registry, transports: new LinkedFactory({ srv: echoFailServer() }) });
    await manager.start([spec("srv")]);
  }

  function baseCtx(
    over: Partial<DispatchContext> & Pick<DispatchContext, "permissionEngine" | "permissionBroker" | "mode">,
  ): DispatchContext {
    return {
      registry,
      hooks: new InMemoryHookRunner(),
      ports: ports(),
      cwd: "/tmp",
      ...over,
    };
  }

  const echoCall = { id: "c1", name: "mcp__srv__echo", input: { message: "live-hello" } };

  it("auto-mode: ask REACHES the broker; an allow yields a live call", async () => {
    await startManager();
    const broker = new RecordingBroker({ behavior: "allow" });
    const outcome = await executeToolCall(
      baseCtx({ permissionEngine: new ModePermissionEngine(), permissionBroker: broker, mode: "auto" }),
      echoCall,
    );
    expect(broker.seen).toHaveLength(1); // fail-closed high/ask reached the broker
    expect(broker.seen[0]!.toolName).toBe("mcp__srv__echo");
    expect(outcome.status).toBe("success");
    expect(outcome.modelText).toBe("live-hello");
  });

  it("auto-mode + DenyPermissionBroker (default): the ask is denied (fail-closed)", async () => {
    await startManager();
    const outcome = await executeToolCall(
      baseCtx({ permissionEngine: new ModePermissionEngine(), permissionBroker: new DenyPermissionBroker(), mode: "auto" }),
      echoCall,
    );
    expect(outcome.status).toBe("denied");
  });

  it("a deny from the broker maps to a denied outcome", async () => {
    await startManager();
    const broker = new RecordingBroker({ behavior: "deny", reason: "user said no" });
    const outcome = await executeToolCall(
      baseCtx({ permissionEngine: new ModePermissionEngine(), permissionBroker: broker, mode: "auto" }),
      echoCall,
    );
    expect(outcome.status).toBe("denied");
    expect(outcome.modelText).toContain("user said no");
  });

  it("plan-mode: denied by the base table WITHOUT consulting the broker", async () => {
    await startManager();
    const broker = new RecordingBroker({ behavior: "allow" });
    const outcome = await executeToolCall(
      baseCtx({ permissionEngine: new ModePermissionEngine(), permissionBroker: broker, mode: "plan" }),
      echoCall,
    );
    expect(outcome.status).toBe("denied");
    expect(broker.seen).toHaveLength(0); // base deny short-circuits the broker
  });

  it("an always-allow rule downgrades ask->allow (no broker) and the call runs live", async () => {
    await startManager();
    const rules = new SessionPermissionRules();
    rules.add({ toolName: "mcp__srv__echo" }); // pattern-less: matches every call
    const broker = new RecordingBroker({ behavior: "deny", reason: "should not be asked" });
    const outcome = await executeToolCall(
      baseCtx({
        permissionEngine: new RuleAwarePermissionEngine(new ModePermissionEngine(), rules),
        permissionBroker: broker,
        mode: "auto",
      }),
      echoCall,
    );
    expect(broker.seen).toHaveLength(0);
    expect(outcome.status).toBe("success");
    expect(outcome.modelText).toBe("live-hello");
  });

  it("a server-side error becomes an error-outcome (not a throw)", async () => {
    await startManager();
    const outcome = await executeToolCall(
      baseCtx({ permissionEngine: new ModePermissionEngine(), permissionBroker: new DenyPermissionBroker(), mode: "yolo" }),
      { id: "c2", name: "mcp__srv__fail", input: {} },
    );
    expect(outcome.status).toBe("error");
    expect(outcome.modelText).toContain("boom");
  });

  it("full loop over a server-error mcp call: every call is answered (unansweredToolCallIds === [])", async () => {
    await startManager();
    const model = new ScriptedModelPort([
      [
        { type: "start" },
        { type: "tool_call", toolCall: { id: "c1", name: "mcp__srv__fail", input: {} } },
        { type: "finish", finishReason: "tool_calls", usage: {} },
      ],
      [{ type: "start" }, { type: "text_delta", id: "t", text: "done" }, { type: "finish", finishReason: "stop", usage: {} }],
    ]);
    const loop = new AgentLoop({
      modelPort: model,
      registry,
      hooks: new InMemoryHookRunner(),
      permissionEngine: new ModePermissionEngine(),
      permissionBroker: new DenyPermissionBroker(),
      mode: "yolo",
      ports: ports(),
      cwd: "/tmp",
      systemPrompt: "test",
    });

    const events: AgentEvent[] = [];
    for await (const event of loop.runTurn("call the failing mcp tool")) events.push(event);

    const toolResults = events.filter((e): e is Extract<AgentEvent, { type: "tool_result" }> => e.type === "tool_result");
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]!.outcome.status).toBe("error");
    expect(loop.history.unansweredToolCallIds()).toEqual([]);

    // The server's result text lands in the conversation history as a "tool" message
    // (not just inferred from unansweredToolCallIds()), proving the dispatch's outcome
    // is actually threaded back into the history the model sees on the next turn.
    const toolMessages = loop.history.toMessages().filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0]!.content).toEqual([
      { type: "tool_result", toolCallId: "c1", toolName: "mcp__srv__fail", text: expect.stringContaining("boom"), status: "error" },
    ]);
  });
});

// Minimal scripted model port (mirrors phase1-integration.test.ts).
class ScriptedModelPort implements ModelPort {
  private call = 0;
  constructor(private readonly scripts: ModelStreamEvent[][]) {}
  async *streamText(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const script = this.scripts[this.call] ?? [{ type: "finish", finishReason: "stop", usage: {} }];
    this.call += 1;
    for (const event of script) {
      if (request.abortSignal?.aborted) throw new DOMException("Aborted", "AbortError");
      yield event;
    }
  }
}

// Silence the intentional duplicate-registration / collision warnings in these tests.
vi.spyOn(console, "warn").mockImplementation(() => {});
