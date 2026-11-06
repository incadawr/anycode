import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createCommunicationBroker } from "./communication-broker.js";
import { createSessionPeerReplies } from "./session-peer-replies.js";
import { createSessionPeerReplyCoordinator } from "./session-peer-reply-coordinator.js";
import { writePrivateFile } from "./communication-ledger.js";
import type { PeerHost } from "./session-peers.js";
import type { SessionPeerTurnEvent } from "../shared/session-peers.js";
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "terminal-replies-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const hosts: PeerHost[] = ["a", "b"].map(id => ({ sessionId: id, tabId: id, proc: {}, generation: 1,
    workspace: dir, workspaceKey: dir, live: true, root: true, restricted: false, readOnly: false, engine: "core", activity: "idle" }));
  const tabs = hosts.map(h => ({ sessionId: h.sessionId, workspace: dir, state: "running", pid: 1 }));
  let terminal: (id: string, event: SessionPeerTurnEvent) => void = () => {};
  let delivery: (id: string, value: import("../shared/communication.js").AgentDelivery) => void = () => {};
  const post = vi.fn(async (_id: string, _operation: string, _payload?: unknown, _workspace?: string) => ({ state: "acknowledged" }));
  const writer = vi.fn(writePrivateFile);
  const options = { ledgerFile: join(dir, "ledger"), writeLedger: writer, realpath: async (p: string) => p,
    manager: { listTabs: () => tabs, communicationRequest: post, onCommunicationDelivery: (fn: typeof delivery) => { delivery = fn; return () => { delivery = () => {}; }; }, onSessionPeerTerminal: (fn: typeof terminal) => { terminal = fn; return () => { terminal = () => {}; }; } } };
  const broker = await createCommunicationBroker(options); cleanup.push(() => broker.dispose());
  const authorize = async (id: string) => tabs.find(t => t.sessionId === id)!;
  const coordinator = createSessionPeerReplyCoordinator(broker, { current: id => hosts.find(h => h.sessionId === id),
    sendAuto: (caller, source, payload) => replies.auto(caller, source, payload, authorize) });
  const replies = createSessionPeerReplies(broker, Date.now, coordinator);
  const seed = () => replies.send(hosts[0]!, { sessionId: "b", payload: "question", reply: "on_turn_end" }, authorize);
  const end = (id: string, reason: "completed" | "error" | "cancelled" = "completed", answer: string | null = "answer", generation = 1) => terminal("b", {
    type: "session_peer_terminal", generation, sequence: 1, turnId: "turn", requestId: id, deliveredMessageIds: [id],
    result: { source: "live_turn", turnId: "turn", requestId: id, nativeTurnId: null, terminalReason: reason, publicAnswer: answer, truncated: false, completedAt: 1 } });
  return { broker, replies, hosts, post, writer, options, authorize, seed, end, deliver: (id: string, value: import("../shared/communication.js").AgentDelivery) => delivery(id, value) };
}
it.each(["idle", "running"] as const)("sends exactly one terminal result to a %s sender", async activity => {
  const f = await fixture(); f.hosts[0]!.activity = activity;
  const source = await f.seed(); f.end(source.envelope.messageId); f.end(source.envelope.messageId);
  await vi.waitFor(() => expect(f.post).toHaveBeenCalledTimes(2));
  const auto = [...f.broker.ledger.messages.values()][1]!;
  expect(auto.envelope).toMatchObject({ kind: "task_result", replyTo: source.envelope.messageId, recipientSessionId: "a" });
  expect(auto.subscription).toBeUndefined(); expect(source.subscription).toMatchObject({ state: "auto", messageId: auto.envelope.messageId });
});
it.each(["completed", "error", "cancelled"] as const)("serializes only the public %s terminal including null", async reason => {
  const f = await fixture(), source = await f.seed(); f.end(source.envelope.messageId, reason, null);
  await vi.waitFor(() => expect(f.post).toHaveBeenCalledTimes(2));
  expect(JSON.parse([...f.broker.ledger.messages.values()][1]!.envelope.payload)).toMatchObject({ terminalReason: reason, publicAnswer: null, truncated: false });
});
it("explicit wins before terminal; terminal wins before explicit; duplicate retries do not subscribe", async () => {
  const f = await fixture(), source = await f.seed();
  const input = { replyTo: source.envelope.messageId, payload: "explicit", idempotencyKey: "same" };
  await f.replies.send(f.hosts[1]!, input, f.authorize); f.end(source.envelope.messageId);
  await f.replies.send(f.hosts[1]!, input, f.authorize); expect(f.post).toHaveBeenCalledTimes(2);
  const next = await f.seed(); f.end(next.envelope.messageId);
  await vi.waitFor(() => expect(f.post).toHaveBeenCalledTimes(4));
  await expect(f.replies.send(f.hosts[1]!, { replyTo: next.envelope.messageId, payload: "late" }, f.authorize)).rejects.toThrow();
});
it("releases a failed durable explicit reservation", async () => {
  const f = await fixture(), source = await f.seed(); f.writer.mockRejectedValueOnce(new Error("disk"));
  await expect(f.replies.send(f.hosts[1]!, { replyTo: source.envelope.messageId, payload: "failed" }, f.authorize)).rejects.toThrow();
  f.end(source.envelope.messageId); await vi.waitFor(() => expect(f.post).toHaveBeenCalledTimes(2));
});
it("ignores wrong generation, unrelated turn and replaced process", async () => {
  const f = await fixture(), source = await f.seed(); f.end(source.envelope.messageId, "completed", "bad", 2); f.end("unrelated");
  expect(f.post).toHaveBeenCalledTimes(1); f.hosts[1]!.proc = {}; f.end(source.envelope.messageId);
  await f.broker.reconcile(); expect(source.subscription?.state).toBe("unknown"); expect(f.post).toHaveBeenCalledTimes(1);
});
it.each([false, true])("new broker restores cards without replay after auto accepted=%s", async accepted => {
  const f = await fixture(), source = await f.seed();
  if (accepted) { f.post.mockResolvedValueOnce({ state: "queued" }); f.end(source.envelope.messageId); await vi.waitFor(() => expect(source.subscription?.state).toBe("auto")); }
  await f.broker.ledger.flush();
  const restarted = await createCommunicationBroker(f.options); cleanup.push(() => restarted.dispose());
  await f.broker.dispose();
  expect(restarted.ledger.messages.get(source.envelope.messageId)?.subscription).toMatchObject({ state: accepted ? "auto" : "unknown" });
  const count = f.post.mock.calls.length; f.end(source.envelope.messageId);
  f.options.manager.listTabs().forEach(tab => { tab.pid = 2; });
  restarted.observe({ tabs: async () => f.options.manager.listTabs(), requireSession: f.authorize });
  await restarted.reconcile();
  expect(f.post.mock.calls.slice(count).every(call => call[1] !== "send_message")).toBe(true);
  if (accepted) expect(restarted.ledger.messages.get(source.subscription!.messageId!)?.state).toBe("unknown");
});
it.each(["hop", "count", "ttl", "rate"])("refuses automatic delivery over %s budget", async budget => {
  const f = await fixture(), source = await f.seed();
  if (budget === "hop") source.peer!.hop = 8;
  if (budget === "ttl") source.peer!.startedAt = 0;
  if (budget === "count" || budget === "rate") for (let i = 0; i < (budget === "count" ? 31 : 20); i++) {
    const copy = structuredClone(source); if (budget === "rate") copy.principal = { kind: "session", sessionId: "b", tabId: "b" };
    f.broker.ledger.messages.set(`copy-${i}`, copy);
  }
  f.end(source.envelope.messageId); await vi.waitFor(() => expect(source.subscription?.state).toBe("unknown")); expect(f.post).toHaveBeenCalledTimes(1);
});
it("loads durable auto identity in a new broker before the original host ACK", async () => {
  const f = await fixture(), source = await f.seed();
  let ack!: (value: { state: string }) => void;
  f.post.mockImplementationOnce(() => new Promise(resolve => { ack = resolve; }));
  f.end(source.envelope.messageId);
  await vi.waitFor(() => expect(f.post).toHaveBeenCalledTimes(2));
  const restarted = await createCommunicationBroker(f.options); cleanup.push(() => restarted.dispose());
  const saved = restarted.ledger.messages.get(source.envelope.messageId)!;
  expect(saved.subscription).toMatchObject({ state: "auto", messageId: expect.any(String) });
  expect(restarted.ledger.messages.get(saved.subscription!.messageId!)?.state).toBe("unknown");
  const count = f.post.mock.calls.length;
  await restarted.reconcile(); expect(f.post).toHaveBeenCalledTimes(count);
  ack({ state: "acknowledged" });
});
it("terminal waits for a failed explicit durable write and then wins once", async () => {
  const f = await fixture(), source = await f.seed();
  let fail!: (reason: Error) => void;
  f.writer.mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
  const explicit = f.replies.send(f.hosts[1]!, { replyTo: source.envelope.messageId, payload: "failed" }, f.authorize);
  const rejected = expect(explicit).rejects.toThrow("disk");
  await vi.waitFor(() => expect(source.subscription?.state).toBe("explicit"));
  f.end(source.envelope.messageId); expect(f.post).toHaveBeenCalledTimes(1);
  fail(new Error("disk")); await rejected;
  await vi.waitFor(() => expect(f.post).toHaveBeenCalledTimes(2));
  expect(source.subscription?.state).toBe("auto");
});
it("bounds escaped public text and preserves the truncation signal", async () => {
  const f = await fixture(), source = await f.seed(); f.end(source.envelope.messageId, "completed", "\u0000".repeat(32000));
  await vi.waitFor(() => expect(f.post).toHaveBeenCalledTimes(2));
  const payload = [...f.broker.ledger.messages.values()][1]!.envelope.payload;
  expect(payload.length).toBeLessThanOrEqual(32000); expect(JSON.parse(payload).truncated).toBe(true);
});
it("records native-only delivery receipts and reconciles host loss without an HTTP observer", async () => {
  const f = await fixture(), source = await f.seed();
  f.post.mockResolvedValueOnce({ state: "queued" }); f.end(source.envelope.messageId);
  await vi.waitFor(() => expect([...f.broker.ledger.messages.values()][1]?.state).toBe("queued"));
  const auto = [...f.broker.ledger.messages.values()][1]!;
  f.deliver("a", { envelope: auto.envelope, state: "rejected", detail: "revoked" });
  expect(auto.state).toBe("rejected"); expect(source.subscription?.state).toBe("auto");
  auto.state = "queued"; f.options.manager.listTabs()[0]!.pid = 2;
  await f.broker.reconcile(); expect(auto.state).toBe("unknown");
});
it("keeps the automatic wake chain when the next turn requests another subscription", async () => {
  const f = await fixture(), source = await f.seed(); f.end(source.envelope.messageId);
  await vi.waitFor(() => expect(f.post).toHaveBeenCalledTimes(2));
  const auto = [...f.broker.ledger.messages.values()][1]!;
  auto.peer!.hop = 8;
  f.hosts[0]!.turnContext = { sequence: 2, turnId: "wake", requestId: auto.envelope.messageId, deliveredMessageIds: [auto.envelope.messageId] };
  await expect(f.replies.send(f.hosts[0]!, { sessionId: "b", payload: "followup", reply: "on_turn_end" }, f.authorize)).rejects.toThrow("loop_limited");
  expect(f.post).toHaveBeenCalledTimes(2); expect(f.broker.ledger.messages.size).toBe(2);
});
