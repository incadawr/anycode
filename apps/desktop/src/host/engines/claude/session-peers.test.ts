import { expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createBridgePresentationStamp } from "./bridge-presentation-stamp.js";
import { ClaudeMcpBridge } from "./mcp-bridge.js";
import { ClaudeApprovalBridge } from "./approval-bridge.js";
import { createSessionPeerBridge } from "../session-peer-bridge.js";
import { createSessionPeersPort } from "../../session-peers-port.js";
import { createSessionPeersHandler, type PeerHost } from "../../../main/session-peers.js";
import { IpcPermissionBroker } from "../../permission-broker.js";

function fixture(enabled = true) {
  const events: any[] = [], sent: any[] = [];
  const rules = { matches: vi.fn(() => true) };
  const broker = new IpcPermissionBroker(event => events.push(event), undefined, rules);
  const proc = {};
  const host: PeerHost = { tabId: "a", sessionId: "a", proc, generation: 1, workspace: "/work", workspaceKey: "/work",
    live: true, root: true, restricted: false, readOnly: false, engine: "claude", activity: "idle" };
  const access = { canAccess: vi.fn(() => !host.readOnly) };
  let release: (() => void) | undefined;
  const handler = createSessionPeersHandler({ current: () => host, targets: () => [host], access,
    prepare: async () => { if (release) await new Promise<void>(resolve => { release = resolve; }); } });
  const port = createSessionPeersPort((message: any) => {
    sent.push(message.request);
    void handler("a", proc, message.request).then(result => port.handle({ type: "session_peers_response", requestId: message.request.requestId, result }));
  });
  const peers = createSessionPeerBridge({ port, broker, cwd: "/work", authority: () => ({ mode: "build", root: host.root }) });
  const door = createBridgePresentationStamp({ catalog: [], resolveCallCatalog: async () => [], onEvent: () => {}, ...(enabled ? { peers } : {}) });
  const mcp = new ClaudeMcpBridge({ serverName: "anycode", version: "1", listTools: door.listTools, callTool: door.callTool });
  let id = 0;
  async function wire(method: string, params?: unknown) {
    const success = vi.fn(), error = vi.fn();
    await mcp.handleControlRequest({ requestId: String(++id), subtype: "mcp_message", signal: new AbortController().signal,
      request: { server_name: "anycode", message: { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) } } }, { success, error });
    expect(error).not.toHaveBeenCalled();
    return success.mock.calls[0]![0].mcp_response;
  }
  const call = (name: string, args: unknown = {}, toolUseId = "use") => wire("tools/call", {
    name, arguments: args, _meta: toolUseId ? { "claudecode/toolUseId": toolUseId } : {} });
  return { events, sent, broker, host, access, door, mcp, wire, call, port,
    delay: () => { release = () => {}; }, release: () => release?.() };
}
const input = { sessionId: "peer", payload: "hello" };
const names = new Set(["mcp__anycode__session_send"]);
async function nameApproval(f: ReturnType<typeof fixture>, bound = true) {
  const approval = new ClaudeApprovalBridge({ broker: f.broker, ...(bound ? { bridge: f.mcp } : {}), activePresetId: () => "ask",
    orchestrationRestricted: () => true, peerToolNames: names });
  const success = vi.fn();
  await approval.handle({ requestId: "name", subtype: "can_use_tool", signal: new AbortController().signal,
    request: { tool_name: "mcp__anycode__session_send", input, tool_use_id: "use" } }, { success, error: vi.fn() });
  return success.mock.calls[0]![0].behavior;
}
async function close(f: ReturnType<typeof fixture>) { f.port.dispose(); await f.mcp.close(); }

it("actual MCP list/call works with empty profiles and shared declarations", async () => {
  const f = fixture();
  try {
    expect((await f.wire("tools/list")).result.tools.map((t: any) => t.name)).toEqual([
      "sessions_list", "session_open", "session_send", "who_edits"]);
    expect(JSON.parse((await f.call("sessions_list")).result.content[0].text)).toMatchObject({ status: "ok", sessions: [{ sessionId: "a" }] });
    const pending = f.call("session_send", input);
    await vi.waitFor(() => expect(f.events).toHaveLength(1));
    expect(f.events[0]).toMatchObject({ toolName: "SessionSend", input });
    f.broker.handleResponse(f.events[0].requestId, "allow");
    expect(JSON.parse((await pending).result.content[0].text)).toEqual({ status: "unavailable" });
    expect(f.sent.map(c => c.operation)).toEqual(["list", "send"]);
  } finally { await close(f); }
});
it("name allow always defers to one input-aware gate; denied ask sends nothing", async () => {
  const f = fixture();
  try {
    expect(await nameApproval(f)).toBe("allow");
    expect(f.events).toHaveLength(0);
    const pending = f.call("session_send", input);
    await vi.waitFor(() => expect(f.events).toHaveLength(1));
    f.broker.handleResponse(f.events[0].requestId, "deny");
    expect((await pending).result.isError).toBe(true);
    expect(f.sent).toHaveLength(0);
  } finally { await close(f); }
});
it("a known allow still reaches the real main handler and preserves its refusal", async () => {
  const f = fixture();
  try {
    f.host.readOnly = true;
    const pending = f.call("session_send", input);
    await vi.waitFor(() => expect(f.events).toHaveLength(1));
    f.broker.handleResponse(f.events[0].requestId, "allow");
    expect(JSON.parse((await pending).result.content[0].text)).toEqual({ status: "refused" });
    expect(f.access.canAccess).toHaveBeenCalled();
    expect(f.sent).toHaveLength(1);
  } finally { await close(f); }
});
it("missing correlation or bridge refuses; disabled inventory stays empty", async () => {
  const f = fixture(), off = fixture(false);
  try {
    expect((await f.call("sessions_list", {}, "")).result.isError).toBe(true);
    expect(f.sent).toHaveLength(0);
    expect((await off.wire("tools/list")).result.tools).toEqual([]);
    expect((await off.call("session_send", input)).result.isError).toBe(true);
    expect(await nameApproval(f, false)).toBe("deny");
  } finally { await close(f); await close(off); }
});
it("aborted calls do not stamp late success", async () => {
  const f = fixture();
  try {
    f.delay();
    const controller = new AbortController();
    const pending = f.door.callTool("sessions_list", {}, controller.signal, { toolUseId: "late" });
    await vi.waitFor(() => expect(f.sent).toHaveLength(1));
    controller.abort(); f.door.dropPresentations(["late"]); f.release();
    expect((await pending).isError).toBe(true);
    expect(f.door.entries().size).toBe(0);
  } finally { await close(f); }
});
it("children cannot dispatch writes; boot binds peers only in the root block", async () => {
  const f = fixture();
  try {
    f.host.root = false;
    expect((await f.call("session_send", input)).result.isError).toBe(true);
    expect(f.sent).toHaveLength(0);
    const source = readFileSync(new URL("../../index.ts", import.meta.url), "utf8");
    const root = source.slice(source.indexOf('if (args.child === undefined) {', source.indexOf('let claudeBrowserToolNames')),
      source.indexOf('console.log("[host] claude mcp bridge: child boot'));
    expect(root).toContain("createSessionPeerBridge");
  } finally { await close(f); }
});
