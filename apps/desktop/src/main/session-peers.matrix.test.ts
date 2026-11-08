import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessagePortMain, UtilityProcess } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nativePeerAuthorityMode } from "../host/engines/child-permission-map.js";
import { ENV_ENGINE, type EngineId } from "../shared/engines.js";
import type { PermissionMode } from "@anycode/core";
import { createCommunicationBroker } from "./communication-broker.js";
import { writePrivateFile } from "./communication-ledger.js";
import { createSessionPeerAccess } from "./session-peer-access.js";
import { createSessionPeerReplies } from "./session-peer-replies.js";
import { createSessionPeerReplyCoordinator } from "./session-peer-reply-coordinator.js";
import { createSessionPeersHandler } from "./session-peers.js";
import { TabHostManager, type HostForkFn } from "./tabs.js";

/**
 * Sender x target matrix on the real TabHostManager: peer facts come from
 * manager.peerHost fed only by the host's own mode_changed/orchestrate_changed
 * reports, never from hand-written PeerHost values.
 *
 * Scope: main admission only (TabHostManager facts, access, handler, replies,
 * and the terminal-driven automatic reply through the reply coordinator). The
 * target delivery is a stub, and the host side (Session publication, the
 * host's engine tag, the native bridge) is covered by the host tests.
 */
const WS = "/ws";
const ENGINES: readonly EngineId[] = ["core", "claude", "codex"];
let pidSeq = 9000;
class FakeHost extends EventEmitter {
  readonly pid = ++pidSeq;
  readonly postMessage = vi.fn();
  readonly kill = vi.fn(() => true);
}
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const flush = () => new Promise(resolve => setTimeout(resolve, 25));

async function matrixRig(senderEngine: EngineId, targetEngine: EngineId) {
  const dir = await mkdtemp(join(tmpdir(), "peer-matrix-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const hosts: FakeHost[] = [];
  const fork: HostForkFn = () => {
    const host = new FakeHost();
    hosts.push(host);
    queueMicrotask(() => host.emit("spawn"));
    host.postMessage.mockImplementation((msg: unknown) => {
      if ((msg as { type?: unknown }).type === "shutdown") queueMicrotask(() => host.emit("exit", 0));
    });
    return host as unknown as UtilityProcess;
  };
  const manager = new TabHostManager({
    fork, hostEntry: "/fake/host.js",
    createChannel: () => ({ port1: {} as MessagePortMain, port2: {} as MessagePortMain }),
    getWindow: () => ({ isDestroyed: () => false, webContents: { postMessage() {}, send() {} } }) as never,
    env: () => ({}), engineEnv: engine => ({ [ENV_ENGINE]: engine }), engineReady: () => true,
    logger: { log() {}, warn() {}, error() {} }, limits: {},
    onSessionPeerRequest: (id, proc, request) => handler(id, proc, request),
  });
  cleanup.push(() => manager.shutdownAllTabHosts());
  const sender = manager.createTab({ workspace: WS, sessionId: "s", resume: false, engine: senderEngine });
  const target = manager.createTab({ workspace: WS, sessionId: "t", resume: false, engine: targetEngine });
  if (!sender.ok || !target.ok) throw new Error("create failed");
  for (const tab of [sender.tab, target.tab]) manager.getTab(tab.tabId)!.peerWorkspaceKey = WS;
  const post = vi.fn(async () => ({ state: "acknowledged" }));
  const broker = await createCommunicationBroker({ realpath: async (p: string) => p, writeLedger: writePrivateFile,
    ledgerFile: join(dir, "messages"), manager: { listTabs: () => manager.listTabs() as never, communicationRequest: post as never,
      onSessionPeerTerminal: listener => manager.onSessionPeerTerminal(listener) } });
  cleanup.push(() => broker.dispose());
  // Automatic replies are driven by the host's real terminal push, as in production.
  const replies = createSessionPeerReplies(broker, Date.now, createSessionPeerReplyCoordinator(broker, {
    current: id => { const tab = manager.listTabs().find(t => t.sessionId === id); return tab && manager.peerHost(tab.tabId); },
    sendAuto: (caller, source, payload) => replies.auto(caller, source, payload,
      async id => manager.listTabs().find(t => t.sessionId === id) as never) }));
  const access = createSessionPeerAccess({ enabled: () => true,
    policy: { isNativeEnabled: () => true, hasPairGrant: () => false } as never,
    isTrusted: () => true, realpathSync: p => p, statSync: () => ({ isDirectory: () => true }) });
  type Open = NonNullable<Parameters<typeof createSessionPeersHandler>[0]["open"]>;
  const open = vi.fn(async (request: Parameters<Open>[0], policy: Parameters<Open>[1]) =>
    await policy.authorize(request.workspace!, WS, true)
      ? { ok: true as const, sessionId: "new", tabId: "new-tab" } : { ok: false as const } as never);
  const handler = createSessionPeersHandler({ current: id => manager.peerHost(id),
    targets: () => manager.listTabs().map(t => manager.peerHost(t.tabId)!), access, open: open as never,
    prepare: async () => {},
    send: (caller, input, authorize) => replies.send(caller, input, async id => {
      await authorize(id); return manager.listTabs().find(t => t.sessionId === id) as never;
    }) });
  const hostOf = (who: "s" | "t") => hosts[who === "s" ? 0 : 1]!;
  const engineOf = (who: "s" | "t") => who === "s" ? senderEngine : targetEngine;
  /** A report as the real host publishes it: tagged with its engine. */
  const report = (who: "s" | "t", mode: PermissionMode, orchestrate = false, tagged = true) => {
    const engine = tagged ? { engine: engineOf(who) } : {};
    hostOf(who).emit("message", { type: "mode_changed", mode, ...engine });
    hostOf(who).emit("message", { type: "orchestrate_changed", enabled: orchestrate, ...engine });
  };
  const call = async (who: "s" | "t", input: Record<string, unknown>, operation: "send" | "open" = "send") => {
    const responses = hostOf(who).postMessage.mock.calls.length;
    const requestId = crypto.randomUUID();
    hostOf(who).emit("message", { type: "session_peers_request", request: { requestId, operation, input } });
    await vi.waitFor(() => expect(hostOf(who).postMessage.mock.calls.length).toBeGreaterThan(responses));
    await flush();
    return hostOf(who).postMessage.mock.calls.map(c => c[0] as { type?: string; requestId?: string; result?: unknown })
      .find(m => m.type === "session_peers_response" && m.requestId === requestId)?.result;
  };
  const peer = (who: "s" | "t") => manager.peerHost(who === "s" ? sender.tab.tabId : target.tab.tabId)!;
  /** The target host pushes a turn start and its terminal result for one delivered message, through TabHostManager. */
  const terminal = async (messageId: string, sequence: number) => {
    const target = peer("t"), base = { generation: target.generation, sequence, turnId: `turn-${sequence}`, requestId: messageId, deliveredMessageIds: [messageId] };
    (manager as unknown as { peerTurns: { expectMessage(proc: object, id: string): void } }).peerTurns.expectMessage(target.proc!, messageId);
    hostOf("t").emit("message", { type: "session_peer_turn", ...base });
    hostOf("t").emit("message", { type: "session_peer_terminal", ...base,
      result: { source: "live_turn", turnId: base.turnId, requestId: messageId, nativeTurnId: null, terminalReason: "completed", publicAnswer: "answer", truncated: false, completedAt: 1 } });
    await flush();
  };
  return { manager, replies, broker, report, call, peer, open, hostOf, post, terminal };
}

const pairs = ENGINES.flatMap(sender => ENGINES.map(target => [sender, target] as const));

describe("session peer matrix on the real TabHostManager", () => {
  it.each(pairs)("send: %s sender to %s target", async (senderEngine, targetEngine) => {
    const rig = await matrixRig(senderEngine, targetEngine);
    const send = { sessionId: "t", payload: "hello" };
    expect(rig.peer("s").readOnly).toBe(true);
    expect(await rig.call("s", send)).toEqual({ status: "refused" });
    rig.report("s", "plan");
    expect(await rig.call("s", send)).toEqual({ status: "refused" });
    rig.report("s", "plan", true);
    expect(await rig.call("s", send)).toMatchObject({ status: "sent" });
    for (const mode of ["build", "edit", "auto", "yolo"] as const) {
      rig.report("s", mode);
      expect(await rig.call("s", send)).toMatchObject({ status: "sent" });
    }
    rig.report("s", "plan");
    expect(await rig.call("s", send)).toEqual({ status: "refused" });
  });

  it.each(["claude", "codex"] as const)("send: %s mapped presets decide the published mode", async engine => {
    const rig = await matrixRig(engine, "core");
    const send = { sessionId: "t", payload: "hello" };
    const presets = engine === "claude"
      ? [["read-only", "refused"], ["ask", "sent"], ["workspace", "sent"]] as const
      : [["read-only", "refused"], ["ask", "sent"], ["approve-for-me", "sent"], ["full-access", "sent"]] as const;
    for (const [preset, expected] of presets) {
      rig.report("s", nativePeerAuthorityMode(engine, preset));
      expect(await rig.call("s", send)).toMatchObject({ status: expected });
    }
    // Pending narrowing counts at once, a pending widening does not.
    rig.report("s", nativePeerAuthorityMode(engine, "ask", "read-only"));
    expect(await rig.call("s", send)).toEqual({ status: "refused" });
    rig.report("s", nativePeerAuthorityMode(engine, "read-only", engine === "claude" ? "ask" : "full-access"));
    expect(await rig.call("s", send)).toEqual({ status: "refused" });
    if (engine === "codex") {
      rig.report("s", nativePeerAuthorityMode(engine, "full-access"));
      expect(rig.peer("s").readOnly).toBe(false);
    }
  });

  it.each(pairs)("send: forged and mismatched reports for %s sender to %s target stay refused", async (senderEngine, targetEngine) => {
    const rig = await matrixRig(senderEngine, targetEngine);
    const send = { sessionId: "t", payload: "hello" };
    rig.report("s", "plan");
    // Untagged yolo is Core's own report: only a Core tab may accept it.
    rig.report("s", "yolo", true, false);
    if (senderEngine === "core") expect(await rig.call("s", send)).toMatchObject({ status: "sent" });
    else expect(await rig.call("s", send)).toEqual({ status: "refused" });
    rig.report("s", "plan");
    for (const wrong of ENGINES.filter(e => e !== senderEngine)) {
      rig.hostOf("s").emit("message", { type: "mode_changed", mode: "yolo", engine: wrong });
      rig.hostOf("s").emit("message", { type: "orchestrate_changed", enabled: true, engine: wrong });
    }
    expect(await rig.call("s", send)).toEqual({ status: "refused" });
  });

  it.each(pairs)("open: %s sender opens a %s session", async (senderEngine, targetEngine) => {
    const rig = await matrixRig(senderEngine, targetEngine);
    const open = { workspace: rig.peer("s").workspace, engine: targetEngine };
    rig.report("s", "plan");
    expect(await rig.call("s", open, "open")).toEqual({ status: "refused" });
    expect(rig.open).not.toHaveBeenCalled();
    rig.report("s", "build");
    expect(await rig.call("s", open, "open")).toMatchObject({ status: "opened", sessionId: "new" });
    expect(rig.open).toHaveBeenCalledWith(expect.objectContaining({ engine: targetEngine }), expect.anything());
    rig.report("s", "plan", true);
    expect(await rig.call("s", { workspace: open.workspace }, "open")).toMatchObject({ status: "opened" });
    expect(rig.open).toHaveBeenLastCalledWith(expect.objectContaining({ engine: senderEngine }), expect.anything());
  });

  it.each(pairs)("reply: %s target answers a %s sender, explicitly and automatically", async (senderEngine, targetEngine) => {
    const rig = await matrixRig(senderEngine, targetEngine);
    rig.report("s", "build");
    const first = await rig.call("s", { sessionId: "t", payload: "question" });
    if ((first as { status?: string })?.status !== "sent") throw new Error("send failed");
    const messageId = (first as { messageId: string }).messageId;
    const reply = { replyTo: messageId, payload: "answer" };
    const authorizeSender = async (id: string) => rig.manager.listTabs().find(t => t.sessionId === id) as never;
    const source = () => rig.broker.ledger.messages.get(messageId)!;
    const auto = async () => rig.replies.auto(rig.peer("t"), source(), "auto answer", authorizeSender);
    // The target holds no authority until it reports one.
    expect(await rig.call("t", reply)).toEqual({ status: "refused" });
    await expect(auto()).rejects.toThrow("Peer send refused");
    rig.report("t", "plan");
    expect(await rig.call("t", reply)).toEqual({ status: "refused" });
    await expect(auto()).rejects.toThrow("Peer send refused");
    rig.report("t", "build");
    expect(await rig.call("t", reply)).toMatchObject({ status: "sent" });
    rig.report("t", "build");
    const automatic = await auto();
    expect(automatic.envelope).toMatchObject({ recipientSessionId: "s", replyTo: messageId });
  });

  it.each(pairs)("terminal-driven reply: %s target auto-answers a %s sender only while it holds authority", async (senderEngine, targetEngine) => {
    const rig = await matrixRig(senderEngine, targetEngine);
    const results = () => [...rig.broker.ledger.messages.values()].filter(r => r.envelope.kind === "task_result");
    const ask = async (sequence: number) => {
      const sent = await rig.call("s", { sessionId: "t", payload: `question ${sequence}`, reply: "on_turn_end" });
      if ((sent as { status?: string })?.status !== "sent") throw new Error("send failed " + JSON.stringify(sent));
      return (sent as unknown as { messageId: string }).messageId;
    };
    rig.report("s", "build");
    rig.report("t", "plan");
    await rig.terminal(await ask(1), 1);
    expect(results()).toHaveLength(0); // a read-only target never answers automatically
    rig.report("t", "build");
    await rig.terminal(await ask(2), 2);
    expect(results()).toHaveLength(1);
    expect(results()[0]!.envelope).toMatchObject({ recipientSessionId: "s" });
  });
});
