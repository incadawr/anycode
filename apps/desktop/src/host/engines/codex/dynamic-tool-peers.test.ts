import { expect, it, vi } from "vitest";
import { createListConnectionsTool, type AgentEvent, type ToolContext } from "@anycode/core";
import { createSessionPeersPort } from "../../session-peers-port.js";
import { createSessionPeersHandler, type PeerHost } from "../../../main/session-peers.js";
import { createSessionPeerAccess } from "../../../main/session-peer-access.js";
import { createSessionPeerBridge } from "../session-peer-bridge.js";
import { nativePeerAuthorityMode } from "../child-permission-map.js";
import { CodexDynamicToolBridge } from "./dynamic-tool-bridge.js";
import { captureBaseConfig, orchestrationOverrides, verifyConfig } from "./orchestration-policy.js";

const active = { threadId: "thread", turnId: "turn" };
function fixture(authority: Parameters<typeof createSessionPeerBridge>[0]["authority"] = () => ({ root: true, mode: "plan", orchestrate: true })) {
  const proc = {};
  let caller: PeerHost = { tabId: "a", sessionId: "a", proc, generation: 1, workspace: "/workspace",
    workspaceKey: "/workspace", live: true, root: true, restricted: false, readOnly: true, engine: "codex", activity: "running" };
  const target: PeerHost = { ...caller, tabId: "b", sessionId: "b" };
  const access = createSessionPeerAccess({ enabled: () => true, isTrusted: () => true,
    realpathSync: p => p, statSync: () => ({ isDirectory: () => true }),
    policy: { projectKeys: () => [], isNativeEnabled: () => true, hasPairGrant: () => false, setNativeEnabled: () => false, setPairGrant: () => false } });
  const prepare = vi.fn(async () => {});
  const main = createSessionPeersHandler({ current: () => caller, targets: () => [target], access, prepare });
  const sent: any[] = [];
  const deliveries: Promise<unknown>[] = [];
  const port = createSessionPeersPort(message => {
    const wire = message as any;
    sent.push(wire);
    deliveries.push(main("a", proc, wire.request).then(result => {
      port.handle({ type: "session_peers_response", requestId: wire.request.requestId, result });
    }));
  });
  const broker = { requestPermission: vi.fn(async () => ({ behavior: "allow" as const })) };
  const peers = createSessionPeerBridge({ port, broker, cwd: "/workspace", authority });
  // The optional dependency is absent in older bridges, so the positive tests distinguish them.
  const bridge = new CodexDynamicToolBridge([], undefined, undefined, undefined, undefined, undefined, peers);
  const events: AgentEvent[] = [];
  const response = { result: vi.fn(), error: vi.fn() };
  const call = (patch = {}, turn: typeof active | null = active) => bridge.handle({ id: 1, method: "item/tool/call",
    params: { ...active, tool: "anycode_sessions_list", callId: "call", arguments: {}, ...patch } }, response, turn, e => events.push(e));
  return { bridge, response, events, call, broker, port, sent, prepare, deliveries,
    writable: () => { caller = { ...caller, readOnly: false }; } };
}

it("announces shared peer schemas and gives an active dynamic request the main acknowledgement", async () => {
  const f = fixture();
  expect(f.bridge.declarations().map(d => d.name)).toEqual([
    "anycode_sessions_list", "anycode_session_open", "anycode_session_send", "anycode_who_edits",
  ]);
  expect(f.bridge.declarations()[2]).toMatchObject({ inputSchema: { additionalProperties: false } });
  await f.call();
  expect(f.response.result).toHaveBeenCalledWith({ success: true,
    contentItems: [{ type: "inputText", text: JSON.stringify({ status: "ok", sessions: [{
      sessionId: "b", tabId: "b", workspace: "/workspace", engine: "codex", activity: "running", addressable: true,
    }] }) }] });
  expect(f.events.at(-1)).toMatchObject({ type: "tool_result", outcome: { toolName: "SessionsList", status: "success" } });
  expect(f.broker.requestPermission).not.toHaveBeenCalled();
});

it("rejects namespaces, foreign turns, absent turns and duplicate calls before RPC", async () => {
  const f = fixture();
  for (const patch of [{ namespace: "foreign" }, { turnId: "foreign" }, { tool: "anycode_session_send_extra" }]) await f.call(patch);
  await f.call({}, null);
  expect(f.sent).toHaveLength(0);
  await f.call();
  await f.call();
  expect(f.sent).toHaveLength(1);
  expect(f.response.result.mock.calls.map(([r]) => r.success)).toEqual([false, false, false, false, true, false]);
});

it("a pending full-access over an applied ask still asks before a peer send", async () => {
  const f = fixture(() => ({ root: true, mode: nativePeerAuthorityMode("codex", "ask", "full-access"), orchestrate: false }));
  await f.call({ tool: "anycode_session_send", arguments: { sessionId: "b", payload: "hello" } });
  expect(f.broker.requestPermission).toHaveBeenCalledOnce();
  expect(f.broker.requestPermission).toHaveBeenCalledWith(expect.objectContaining({ mode: "build" }));
});

it("Stop releases the RPC wait with unknown and ignores a late main response", async () => {
  const f = fixture();
  let release!: () => void;
  f.prepare.mockImplementationOnce(() => new Promise<void>(r => { release = r; }));
  const pending = f.call();
  expect(f.port.pendingCount).toBe(1);
  await f.call(); // duplicate while pending
  f.bridge.cancel();
  await pending;
  expect(f.port.pendingCount).toBe(0);
  expect(f.response.result).toHaveBeenLastCalledWith({ success: false,
    contentItems: [{ type: "inputText", text: JSON.stringify({ status: "unknown" }) }] });
  expect(f.events.at(-1)).toMatchObject({ type: "tool_result", outcome: { status: "cancelled" } });
  release();
  await Promise.all(f.deliveries);
  await f.bridge.drain();
  expect(f.response.result).toHaveBeenCalledTimes(2);
  expect(f.bridge.hasPendingCalls()).toBe(false);
});

it("restrictive orchestration approves owned writes but main still refuses production read-only facts", async () => {
  const f = fixture();
  const base = captureBaseConfig({ config: { mcp_servers: { ambient: {} } } });
  const overrides = orchestrationOverrides(base);
  expect(overrides).toContain('sandbox_mode="read-only"');
  expect(overrides).toContain("mcp_servers.ambient.enabled=false");
  expect(() => verifyConfig({ config: { mcp_servers: { ambient: { enabled: false } },
    features: { multi_agent: false, remote_plugin: false }, apps: { _default: { enabled: false } },
    sandbox_mode: "read-only", approval_policy: "never" } }, base, true)).not.toThrow();
  await f.call({ tool: "shell" });
  await f.call({ tool: "mcp__ambient__send" });
  expect(f.sent).toHaveLength(0);
  await f.call({ tool: "anycode_session_send", arguments: { sessionId: "b", payload: "hello" } });
  expect(f.broker.requestPermission).toHaveBeenCalledTimes(1);
  expect(f.broker.requestPermission).toHaveBeenCalledWith(expect.objectContaining({ toolName: "SessionSend", mode: "plan", orchestrate: true }));
  expect(f.response.result).toHaveBeenLastCalledWith({ success: true,
    contentItems: [{ type: "inputText", text: '{"status":"refused"}' }] });
  await f.call({ callId: "readonly-open", tool: "anycode_session_open", arguments: {} });
  expect(f.response.result).toHaveBeenLastCalledWith({ success: true,
    contentItems: [{ type: "inputText", text: '{"status":"refused"}' }] });
  f.writable();
  await f.call({ callId: "next", tool: "anycode_session_open", arguments: {} });
  expect(f.broker.requestPermission).toHaveBeenCalledTimes(3);
  expect(f.response.result).toHaveBeenLastCalledWith({ success: true,
    contentItems: [{ type: "inputText", text: '{"status":"unavailable"}' }] });
});

it("OFF leaves declarations byte-identical and rejects unannounced peer calls", async () => {
  const bridge = new CodexDynamicToolBridge([], undefined);
  expect(JSON.stringify(bridge.declarations())).toBe("[]");
  const response = { result: vi.fn(), error: vi.fn() };
  await bridge.handle({ id: 1, method: "item/tool/call", params: { ...active,
    tool: "anycode_sessions_list", callId: "off", arguments: {} } }, response, active, () => {});
  expect(response.result).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
});

it("invalid input and denied approval cannot dispatch a mutation", async () => {
  const f = fixture();
  await f.call({ tool: "anycode_session_send", arguments: { sessionId: "b", payload: "hello", sender: "forged" } });
  expect(f.broker.requestPermission).not.toHaveBeenCalled();
  f.broker.requestPermission.mockResolvedValueOnce({ behavior: "deny", reason: "Denied" } as any);
  await f.call({ callId: "denied", tool: "anycode_session_send", arguments: { sessionId: "b", payload: "hello" } });
  expect(f.sent).toHaveLength(0);
  expect(f.response.result).toHaveBeenLastCalledWith({ success: false, contentItems: [{ type: "inputText", text: "Denied" }] });
});

it("OFF preserves the independent read-only connection catalogue", async () => {
  const bridge = new CodexDynamicToolBridge([], undefined);
  expect(bridge.declarations()).toEqual([]);
  const catalogue = createListConnectionsTool(() => ({ current: {}, connections: [] }));
  expect(catalogue.metadata).toMatchObject({ readOnly: true, needsApproval: false });
  expect(await catalogue.handler({}, {} as ToolContext)).toMatchObject({ ok: true, output: { connections: [] } });
});
