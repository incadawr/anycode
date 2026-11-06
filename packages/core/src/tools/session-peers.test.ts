import { expect, it, vi } from "vitest";
import { createSessionPeerTools, parseSessionPeerRequest, parseSessionPeerResponse } from "./session-peers.js";
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

it("preserves reply receipts and loop refusal through the shared response parser", () => {
  for (const state of ["queued", "acknowledged", "rejected", "unknown"]) {
    const receipt = { status: "sent", messageId: "message", state };
    expect(parseSessionPeerResponse(receipt)).toEqual(receipt);
  }
  expect(parseSessionPeerResponse({ status: "refused", reason: "loop_limited" })).toEqual({ status: "refused", reason: "loop_limited" });
  expect(parseSessionPeerResponse({ status: "sent", messageId: "message", state: "forged" })).toEqual({ status: "unknown" });
});


it("preserves file evidence and bounded recent paths but rejects invented confidence", () => {
  const answer = { status: "file_activity", path: "file", coverage: "partial", startsAt: 1,
    candidates: [], sampler: { coverage: "unknown", baselineCoverage: "unknown", freshness: "stale" },
    limitations: "Incomplete observation", records: [
      { sessionId: "a", toolName: "Write", at: 2, evidence: "reported_write" },
    ] };
  expect(parseSessionPeerResponse(answer)).toEqual(answer);
  expect(parseSessionPeerResponse({ ...answer, coverage: "complete" })).toEqual({ status: "unknown" });
  expect(parseSessionPeerResponse({ ...answer, records: [{ ...answer.records[0], evidence: "proven_author" }] }))
    .toEqual({ status: "unknown" });
  const session = { sessionId: "a", tabId: "a", workspace: "/work", engine: "core",
    activity: "idle", addressable: true, recentPaths: ["file"] };
  expect(parseSessionPeerResponse({ status: "ok", sessions: [session] }))
    .toEqual({ status: "ok", sessions: [session] });
  expect(parseSessionPeerResponse({ status: "ok", sessions: [{ ...session, recentPaths: Array(6).fill("file") }] }))
    .toEqual({ status: "unknown" });
});

it('accepts only candidate shell evidence in the candidate projection', () => {
  const candidate = { sessionId: 'a', toolName: 'Bash', at: 2, evidence: 'observed_during_shell',
    confidence: 'candidate', interval: { start: 0, end: 2 } };
  const answer = { status: 'file_activity', path: 'file', records: [], candidates: [candidate],
    coverage: 'partial', startsAt: 0, limitations: 'Metadata never proves authorship.',
    sampler: { coverage: 'partial', baselineCoverage: 'unknown', freshness: 'stale' } };
  expect(parseSessionPeerResponse(answer)).toEqual(answer);
  for (const spoof of [{ confidence: 'proven' }, { evidence: 'reported_write' }, { command: 'private' }]) {
    expect(parseSessionPeerResponse({ ...answer, candidates: [{ ...candidate, ...spoof }] })).toEqual({ status: 'unknown' });
  }
});

it('rejects missing candidate or sampler fields rather than silently claiming empty evidence', () => {
  const answer = { status: 'file_activity', path: 'file', records: [], candidates: [],
    coverage: 'partial', startsAt: 0, limitations: 'Incomplete',
    sampler: { coverage: 'unknown', baselineCoverage: 'unknown', freshness: 'stale' } };
  expect(parseSessionPeerResponse(answer)).toEqual(answer);
  for (const field of ['candidates', 'sampler']) {
    const missing: Record<string, unknown> = { ...answer }; delete missing[field];
    expect(parseSessionPeerResponse(missing)).toEqual({ status: 'unknown' });
  }
  expect(parseSessionPeerResponse({ ...answer, sampler: { ...answer.sampler, forged: true } })).toEqual({ status: 'unknown' });
});
