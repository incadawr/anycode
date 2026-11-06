import { expect, it, vi } from "vitest";
import { createSessionPeerTools, parseSessionPeerRequest } from "./session-peers.js";
import { executeToolCall, type DispatchContext } from "../dispatch/dispatcher.js";
import { ToolRegistry, createDefaultToolRegistry } from "./registry.js";
import { buildChildConfig } from "../subagents/runner.js";
import { getPersona } from "../subagents/personas.js";
import type { AgentLoopConfig } from "../loop/agent-loop.js";
import { ModePermissionEngine } from "../permissions/engine.js";
import type { PermissionMode } from "../types/permissions.js";

it("strict shared schemas reject forged authority and advertise the reply target constraint", () => {
  const tools = createSessionPeerTools(() => ({ mode: "build" }));
  expect(tools.map(t => t.metadata.name)).toEqual(["SessionsList", "SessionOpen", "SessionSend", "WhoEdits"]);
  for (const tool of tools) expect(tool.inputSchema.safeParse({ sender: "forged" }).success).toBe(false);
  expect(parseSessionPeerRequest({ requestId: "r", operation: "send", input: { payload: "x" } })).toBeNull();
  expect(tools[2]!.rawInputJsonSchema).toMatchObject({ anyOf: [{ required: ["sessionId"] }, { required: ["replyTo"] }] });
  expect(tools[0]!.inputSchema.safeParse({ limit: 51 }).success).toBe(false);
});
it("Core plan denies, ask decides once, orchestrate asks even in full access, and full access does not ask", async () => {
  let mode: PermissionMode = "plan", orchestrate = false;
  const registry = new ToolRegistry();
  for (const tool of createSessionPeerTools(() => ({ mode, orchestrate }))) registry.register(tool);
  const request = vi.fn(async () => ({ status: "unavailable" as const }));
  const requestPermission = vi.fn(async () => ({ behavior: "allow" as const }));
  const run = () => executeToolCall({ registry, mode, orchestrate, sessionPeers: { request },
    permissionEngine: new ModePermissionEngine(), permissionBroker: { requestPermission },
    hooks: { runPreToolUse: async () => ({}), runObservers: async () => {} },
    cwd: "/work", ports: {} } as unknown as DispatchContext,
  { id: "send", name: "SessionSend", input: { sessionId: "peer", payload: "hello" } });
  expect((await run()).status).toBe("denied");
  expect(request).not.toHaveBeenCalled();
  mode = "build";
  expect((await run()).status).toBe("success");
  expect(requestPermission).toHaveBeenCalledTimes(1);
  mode = "yolo";
  expect((await run()).status).toBe("success");
  expect(requestPermission).toHaveBeenCalledTimes(1);
  orchestrate = true;
  expect((await run()).status).toBe("success");
  expect(requestPermission).toHaveBeenCalledTimes(2);
  expect(request).toHaveBeenCalledTimes(3);
});

it("default registry exposes no peers, and inline children inherit neither tools nor handle", () => {
  expect(createDefaultToolRegistry().has("SessionsList")).toBe(false);
  const parent = { mode: "yolo", cwd: "/work", ports: {},
    sessionPeers: { request: vi.fn() } } as unknown as AgentLoopConfig;
  const child = buildChildConfig(parent, getPersona("explore"), {
    agentType: "explore", description: "read", prompt: "read", tools: ["SessionSend", "SessionsList"],
  });
  expect(child.sessionPeers).toBeUndefined();
  expect(child.registry.has("SessionSend")).toBe(false);
  expect(child.registry.has("SessionsList")).toBe(false);
});
