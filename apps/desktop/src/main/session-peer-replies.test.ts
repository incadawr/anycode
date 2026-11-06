import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { writePrivateFile } from "./communication-ledger.js";
import { createCommunicationBroker } from "./communication-broker.js";
import { createSessionPeerReplies } from "./session-peer-replies.js";
import { createSessionPeersHandler, type PeerHost } from "./session-peers.js";
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "peer-replies-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const hosts: PeerHost[] = ["a", "b", "c", "d"].map(id => ({ sessionId: id, tabId: id, proc: {}, generation: 1,
    workspace: dir, workspaceKey: dir, live: true, root: true, restricted: false, readOnly: false, engine: "core", activity: "idle" }));
  const tabs = hosts.map(h => ({ sessionId: h.sessionId, workspace: dir, state: "running", pid: 1 }));
  const post = vi.fn(async () => ({ state: "acknowledged" }));
  const writer = vi.fn(writePrivateFile);
  const realpath = vi.fn(async (path: string) => path);
  const options = { realpath, writeLedger: writer, ledgerFile: join(dir, "messages"), manager: { listTabs: () => tabs, communicationRequest: post } };
  const broker = await createCommunicationBroker(options); cleanup.push(() => broker.dispose());
  let time = Date.now();
  const replies = createSessionPeerReplies(broker, () => time);
  const access = { canAccess: vi.fn(() => true) };
  const prepare = vi.fn(async () => {});
  const handler = createSessionPeersHandler({ current: id => hosts.find(h => h.tabId === id), targets: () => hosts,
    access, prepare, send: (caller, input, authorize) => replies.send(caller, input, async id => {
      await authorize(id); return tabs.find(t => t.sessionId === id)!;
    }) });
  const call = (id: string, input: Record<string, unknown>) => handler(id, hosts.find(h => h.sessionId === id)!.proc!, {
    requestId: crypto.randomUUID(), operation: "send", input,
  });
  return { prepare, realpath, writer, broker, replies, call, post, hosts, tabs, access, options, tick: (ms: number) => { time += ms; } };
}
it("derives reply destination and correlation, coalesces retries into one inbox post", async () => {
  const f = await fixture();
  const first = await f.call("a", { sessionId: "b", payload: "question", correlationId: "thread" });
  expect(first).toMatchObject({ status: "sent", state: "acknowledged" });
  if (first?.status !== "sent") throw new Error("send failed");
  const input = { replyTo: first.messageId, payload: "answer", idempotencyKey: "reply" };
  const [a, b] = await Promise.all([f.call("b", input), f.call("b", input)]);
  expect(a).toEqual(b); expect(a).toMatchObject({ status: "sent" });
  expect(f.post).toHaveBeenCalledTimes(2);
  const record = [...f.broker.ledger.messages.values()][1]!;
  expect(record.envelope).toMatchObject({ recipientSessionId: "a", correlationId: "thread", replyTo: first.messageId });
  expect(record.peer).toMatchObject({ hop: 1, chainId: first.messageId });
  expect(await f.call("b", { ...input, payload: "changed" })).toEqual({ status: "refused" });
  expect(await f.call("b", { ...input, reply: "on_turn_end" })).toEqual({ status: "unavailable" });
});
it("rejects guesses, outsiders, mismatched targets, legacy sources, self sends and revoked access", async () => {
  const f = await fixture();
  const first = await f.call("a", { sessionId: "b", payload: "question" });
  if (first?.status !== "sent") throw new Error("send failed");
  for (const [caller, input] of [
    ["c", { replyTo: first.messageId }], ["b", { replyTo: "guess" }],
    ["b", { replyTo: first.messageId, sessionId: "c" }], ["a", { sessionId: "a" }],
  ] as const) expect(await f.call(caller, { ...input, payload: "no" })).toEqual({ status: "refused" });
  const source = f.broker.ledger.messages.get(first.messageId)!;
  source.principal = { kind: "external" };
  expect(await f.call("b", { replyTo: first.messageId, payload: "no" })).toEqual({ status: "refused" });
  f.access.canAccess.mockReturnValue(false);
  expect(await f.call("a", { sessionId: "b", payload: "no" })).toEqual({ status: "refused" });
  expect(f.post).toHaveBeenCalledTimes(1);
});
it("enforces hop, message and TTL budgets including concurrent last slots", async () => {
  const f = await fixture();
  const first = await f.call("a", { sessionId: "b", payload: "seed" });
  if (first?.status !== "sent") throw new Error("send failed");
  const source = f.broker.ledger.messages.get(first.messageId)!;
  source.peer!.hop = 8;
  expect(await f.call("b", { replyTo: first.messageId, payload: "hop9" })).toEqual({ status: "refused", reason: "loop_limited" });
  source.peer!.hop = 0;
  for (let i = 0; i < 30; i++) f.broker.ledger.messages.set(`seed-${i}`, structuredClone(source));
  const results = await Promise.all([1, 2].map(i => f.call("b", { replyTo: first.messageId, payload: String(i) })));
  expect(results.filter(r => r?.status === "sent")).toHaveLength(1);
  expect(results.filter(r => r?.status === "refused")).toHaveLength(1);
  for (const key of [...f.broker.ledger.messages.keys()]) if (key !== first.messageId) f.broker.ledger.messages.delete(key);
  f.tick(30 * 60_000);
  expect(await f.call("b", { replyTo: first.messageId, payload: "expired" })).toEqual({ status: "refused", reason: "loop_limited" });
});
it("retains sender and workspace quotas through restart and does not charge refusals or retries", async () => {
  const f = await fixture();
  for (const id of ["a", "b", "c"]) {
    for (let i = 0; i < 20; i++) expect(await f.call(id, { sessionId: "d", payload: "hi", idempotencyKey: String(i) })).toMatchObject({ status: "sent" });
    expect(await f.call(id, { sessionId: "d", payload: "over" })).toEqual({ status: "refused" });
  }
  expect(await f.call("d", { sessionId: "a", payload: "workspace over" })).toEqual({ status: "refused" });
  f.tick(60_001);
  expect(await f.call("d", { sessionId: "a", payload: "reset" })).toMatchObject({ status: "sent" });
  await f.broker.dispose();
  const restarted = await createCommunicationBroker(f.options); cleanup.push(() => restarted.dispose());
  const replies = createSessionPeerReplies(restarted);
  await expect(replies.send(f.hosts[0]!, { sessionId: "d", payload: "over" }, async () => f.tabs[3]!)).rejects.toThrow("rate");
  expect((await replies.send(f.hosts[0]!, { sessionId: "d", payload: "hi", idempotencyKey: "0" }, async () => f.tabs[3]!)).envelope.messageId).toBeDefined();
  expect(f.post).toHaveBeenCalledTimes(61);
});

it("never overshoots concurrent sender or workspace reservations", async () => {
  const f = await fixture();
  for (const id of ["a", "b", "c"]) {
    for (let i = 0; i < 19; i++) await f.call(id, { sessionId: "d", payload: "seed" });
  }
  for (const id of ["a", "b"]) {
    const results = await Promise.all([1, 2].map(i => f.call(id, { sessionId: "d", payload: String(i) })));
    expect(results.filter(r => r?.status === "sent")).toHaveLength(1);
  }
  const results = await Promise.all(["c", "d"].map(id => f.call(id, { sessionId: "a", payload: "last" })));
  expect(results.filter(r => r?.status === "sent")).toHaveLength(1);
  expect(f.post).toHaveBeenCalledTimes(60);
});
it("releases failed durable reservations without persisting them in a concurrent snapshot", async () => {
  const f = await fixture();
  f.writer.mockRejectedValueOnce(new Error("disk unavailable"));
  const results = await Promise.all(["a", "b"].map(id => f.call(id, { sessionId: "d", payload: "hi" })));
  expect(results.filter(r => r?.status === "sent")).toHaveLength(1);
  expect(f.post).toHaveBeenCalledTimes(1);
  expect(f.broker.ledger.messages.size).toBe(1);
  await f.broker.dispose();
  const restarted = await createCommunicationBroker(f.options); cleanup.push(() => restarted.dispose());
  expect(restarted.ledger.messages.size).toBe(1);
});

it("restores chain budgets rather than restarting them with the app", async () => {
  const f = await fixture();
  const first = await f.call("a", { sessionId: "b", payload: "seed" });
  if (first?.status !== "sent") throw new Error("send failed");
  const record = f.broker.ledger.messages.get(first.messageId)!;
  record.peer!.hop = 8;
  await f.broker.ledger.persist(); await f.broker.dispose();
  const restarted = await createCommunicationBroker(f.options); cleanup.push(() => restarted.dispose());
  await expect(createSessionPeerReplies(restarted).send(f.hosts[1]!, { replyTo: first.messageId, payload: "hop9" },
    async () => f.tabs[0]!)).rejects.toThrow("loop_limited");
  expect(f.post).toHaveBeenCalledTimes(1);
});

it("revalidates caller workspace and grants after asynchronous path resolution", async () => {
  const f = await fixture();
  const original = f.hosts[0]!.workspace;
  f.realpath.mockImplementationOnce(async path => { f.hosts[0]!.workspace = "/relocated"; return path; });
  expect(await f.call("a", { sessionId: "b", payload: "no" })).toEqual({ status: "refused" });
  f.hosts[0]!.workspace = original;
  f.realpath.mockImplementationOnce(async path => { f.access.canAccess.mockReturnValue(false); return path; });
  expect(await f.call("a", { sessionId: "b", payload: "no" })).toEqual({ status: "refused" });
  expect(f.post).not.toHaveBeenCalled();
});


it("inherits a reply-wake chain even with omitted replyTo and a new correlation", async () => {
  const f = await fixture();
  const first = await f.call("a", { sessionId: "b", payload: "question", correlationId: "original" });
  if (first?.status !== "sent") throw new Error("send failed");
  f.hosts[1]!.turnContext = { sequence: 1, turnId: "turn", requestId: first.messageId, deliveredMessageIds: [first.messageId] };
  for (const correlationId of [undefined, "new-thread"]) {
    expect(await f.call("b", { sessionId: "c", payload: "follow-up", correlationId })).toMatchObject({ status: "sent" });
    expect([...f.broker.ledger.messages.values()].at(-1)?.peer).toMatchObject({ chainId: first.messageId, hop: 1 });
  }
  f.broker.ledger.messages.get(first.messageId)!.peer!.hop = 8;
  expect(await f.call("b", { sessionId: "c", payload: "over" })).toEqual({ status: "refused", reason: "loop_limited" });
});


it("keeps the admitted turn context when that turn settles during broker preparation", async () => {
  const f = await fixture();
  const first = await f.call("a", { sessionId: "b", payload: "seed" });
  if (first?.status !== "sent") throw new Error("send failed");
  f.hosts[1]!.turnContext = { sequence: 1, turnId: "turn", requestId: first.messageId, deliveredMessageIds: [first.messageId] };
  f.prepare.mockImplementationOnce(async () => { f.hosts[1]!.turnContext = undefined; });
  expect(await f.call("b", { sessionId: "c", payload: "follow-up" })).toMatchObject({ status: "sent" });
  expect([...f.broker.ledger.messages.values()].at(-1)?.peer).toMatchObject({ chainId: first.messageId, hop: 1 });
});

it("pins admission snapshots before durable write and posts the exact accepted record", async () => {
  const f = await fixture();
  const accepted = vi.fn((record: import("./communication-ledger.js").CommunicationRecord) => {
    expect(record.peer).toBeDefined();
    expect(f.broker.ledger.messages.has(record.envelope.messageId)).toBe(false);
    expect(f.post).not.toHaveBeenCalled();
  });
  const result = await f.replies.send(f.hosts[0]!, { sessionId: "b", payload: "pin", mode: "next_turn", reply: "explicit" },
    async () => f.tabs[1]!, undefined, accepted);
  expect(accepted).toHaveBeenCalledTimes(1);
  expect(accepted.mock.calls[0]![0]).toBe(result);
  expect(f.post).toHaveBeenCalledWith("b", "send_message", result.envelope, f.tabs[1]!.workspace);
});

it("authorizes live durable acceptance while dispatch is still unknown/pending", async () => {
  const { createSessionPeerDrain } = await import("./session-peer-drain.js");
  const f = await fixture();
  const registry = createSessionPeerDrain({ lookup: id => f.broker.ledger.messages.get(id),
    current: id => f.hosts.find(h => h.sessionId === id), prepare: f.prepare, access: f.access });
  f.post.mockImplementationOnce(async () => {
    const record = [...f.broker.ledger.messages.values()][0]!;
    expect(record).toMatchObject({ state: "unknown", detail: "Dispatch pending" });
    expect(registry.register(record, f.hosts[0]!, f.hosts[1]!)).toBe(true);
    expect(await registry.request(f.hosts[1]!.proc!, { type: "session_peer_drain_request", messageId: record.envelope.messageId,
      nonce: "live", recipientSessionId: "b", generation: f.hosts[1]!.generation })).toMatchObject({ type: "session_peer_drain_permit" });
    return { state: "acknowledged" };
  });
  expect(await f.call("a", { sessionId: "b", payload: "live" })).toMatchObject({ status: "sent" });
  registry.dispose();
});
