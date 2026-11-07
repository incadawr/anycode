import { expect, it, vi } from "vitest";
import { createSessionPeerBridge } from "./session-peer-bridge.js";
import { createSessionPeersPort } from "../session-peers-port.js";
import { createSessionPeersHandler, type PeerHost } from "../../main/session-peers.js";
import { IpcPermissionBroker } from "../permission-broker.js";
import { createSessionPeerTools, ToolRegistry, executeToolCall, ModePermissionEngine } from "@anycode/core";
import type { DispatchContext, PermissionMode } from "@anycode/core";

const signal = () => new AbortController().signal;
function fixture() {
  const calls: any[] = [];
  const proc = {};
  const host: PeerHost = { tabId: "a", sessionId: "a", proc, generation: 1, workspace: "/work", workspaceKey: "/work",
    live: true, root: true, restricted: false, readOnly: false, engine: "core", activity: "idle" };
  const access = { canAccess: vi.fn(() => true) };
  const handler = createSessionPeersHandler({ current: () => host, targets: () => [host], access, prepare: async () => {} });
  const port = createSessionPeersPort((message: any) => {
    calls.push(message.request);
    void handler("a", proc, message.request).then(result => port.handle({
      type: "session_peers_response", requestId: message.request.requestId, result }));
  });
  return { calls, port, access };
}
it("Core dispatch reaches the authenticated port for list/open/send; missing child handle fails closed", async () => {
  const { calls, port } = fixture();
  const registry = new ToolRegistry();
  for (const tool of createSessionPeerTools(() => ({ mode: "yolo" }))) registry.register(tool);
  const ctx = { registry, mode: "yolo", cwd: "/work", ports: {}, sessionPeers: port,
    permissionEngine: new ModePermissionEngine(), permissionBroker: { requestPermission: vi.fn() },
    hooks: { runPreToolUse: async () => ({ decision: "allow" }), runObservers: async () => {} },
    abortSignal: signal(), emit: () => {} } as unknown as DispatchContext;
  for (const [name, input] of [["SessionsList", {}], ["SessionOpen", {}], ["SessionSend", { sessionId: "peer", payload: "hello" }]] as const) {
    await executeToolCall(ctx, { id: name, name, input });
  }
  expect(calls.map(c => c.operation)).toEqual(["list", "open", "send"]);
  const absent = await executeToolCall({ ...ctx, sessionPeers: undefined }, { id: "child", name: "SessionSend", input: { sessionId: "peer", payload: "x" } });
  expect(absent.status).toBe("error");
  expect(calls).toHaveLength(3);
});
it("native plan and children deny before dispatch; full access preserves main refusal", async () => {
  const { calls, port, access } = fixture();
  let mode: PermissionMode = "plan", root = true;
  const broker = { requestPermission: vi.fn() };
  const bridge = createSessionPeerBridge({ port, broker, cwd: "/work", authority: () => ({ mode, root }) });
  expect((await bridge.call("SessionOpen", {}, signal(), "plan")).ok).toBe(false);
  mode = "yolo"; root = false;
  expect((await bridge.call("SessionSend", { sessionId: "peer", payload: "x" }, signal(), "child")).ok).toBe(false);
  expect(calls).toHaveLength(0);
  root = true; access.canAccess.mockReturnValue(false);
  expect(await bridge.call("SessionOpen", {}, signal(), "full")).toEqual({ ok: true, output: { status: "refused" } });
  expect(calls).toHaveLength(1);
  expect(broker.requestPermission).not.toHaveBeenCalled();
});
it("ask delegates exactly once to the live broker with validated input; WhoEdits is unavailable", async () => {
  const { calls, port } = fixture();
  const events: any[] = [];
  const broker = new IpcPermissionBroker(event => events.push(event));
  const bridge = createSessionPeerBridge({ port, broker, cwd: "/work", authority: () => ({ mode: "build", root: true }) });
  const pending = bridge.call("SessionSend", { sessionId: "peer", payload: "hello" }, signal(), "ask");
  await vi.waitFor(() => expect(events.filter(e => e.type === "permission_request")).toHaveLength(1));
  expect(calls).toHaveLength(0);
  broker.handleResponse(events.find(e => e.type === "permission_request").requestId, "allow");
  await pending;
  expect(calls).toHaveLength(1);
  const read = await bridge.call("WhoEdits", { path: "src/a.ts" }, signal(), "read");
  expect(read).toEqual({ ok: true, output: { status: "unavailable" } });
  expect((await bridge.call("SessionOpen", { sender: "fake" }, signal(), "bad")).ok).toBe(false);
});
