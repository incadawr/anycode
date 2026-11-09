import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createCommunicationLedger, writePrivateFile } from "./communication-ledger.js";
import { createCommunicationDispatch, type CommunicationPrincipal } from "./communication-dispatch.js";

const roots: string[] = [];
const disposers: Array<() => void> = [];
afterEach(async () => {
  disposers.splice(0).forEach((dispose) => dispose());
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const input = { sessionId: "target", payload: "hello", mode: "next_turn" as const, kind: "agent_message" as const, idempotencyKey: "key" };
const external: CommunicationPrincipal = { kind: "external" };
const session = (id: string): CommunicationPrincipal => ({ kind: "session", sessionId: id, tabId: `tab-${id}` });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "communication-dispatch-")); roots.push(root);
  const path = join(root, "messages");
  const writer = vi.fn(writePrivateFile);
  const ledger = await createCommunicationLedger(path, writer);
  const post = vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ state: "acknowledged", detail: "accepted" }));
  const authorize = vi.fn(async (_id: string) => ({ workspace: "/workspace", pid: 42 }));
  const dispatch = createCommunicationDispatch({ ledger, authorize, resolvePath: async (path) => path, post, markLostGeneration: async () => false, dispatchTimeoutMs: 20 });
  disposers.push(dispatch.dispose);
  return { path, writer, ledger, post, authorize, ...dispatch };
}
it("namespaces identical keys by authenticated sender and preserves them after restart", async () => {
  const f = await fixture();
  const a = await f.send(session("a"), input); const b = await f.send(session("b"), input);
  expect(a.envelope.messageId).not.toBe(b.envelope.messageId);
  expect(a.envelope.sender).toBe("session:a"); expect(f.post).toHaveBeenCalledTimes(2);
  const legacy = await f.send(external, input);
  const reopened = await createCommunicationLedger(f.path);
  expect(reopened.messages.get(a.envelope.messageId)?.principal).toEqual(session("a"));
  const restarted = createCommunicationDispatch({ ledger: reopened, authorize: f.authorize, resolvePath: async (path) => path, post: f.post, markLostGeneration: async () => false });
  disposers.push(restarted.dispose);
  expect((await restarted.send(session("a"), input)).envelope.messageId).toBe(a.envelope.messageId);
  expect((await restarted.send(external, input)).envelope.messageId).toBe(legacy.envelope.messageId);
  expect(f.post).toHaveBeenCalledTimes(3);
});
it("coalesces concurrent retries behind durable acceptance and rejects every changed input", async () => {
  const f = await fixture(); const hold = deferred(); const entered = deferred();
  f.writer.mockImplementationOnce(async (path, text) => { entered.resolve(); await hold.promise; await writePrivateFile(path, text); });
  const first = f.send(external, input); await entered.promise;
  const second = f.send(external, input);
  try { expect(f.post).not.toHaveBeenCalled(); } finally { hold.resolve(); }
  const [a, b] = await Promise.all([first, second]);
  expect(a).toEqual(b); expect(f.post).toHaveBeenCalledTimes(1);
  for (const change of [{ payload: "changed" }, { sessionId: "other" }, { mode: "steer" as const }, { kind: "task_result" as const }, { correlationId: "c" }, { replyTo: "r" }]) {
    await expect(f.send(external, { ...input, ...change })).rejects.toThrow("Idempotency key reused");
  }
  expect(f.post).toHaveBeenCalledTimes(1);
});
it("posts only the durable envelope and projects host responses without accepting injected fields", async () => {
  const f = await fixture();
  f.post.mockImplementationOnce(async (_id, envelope) => {
    const saved = JSON.parse(await readFile(f.path, "utf8"));
    expect(saved[0].envelope).toEqual(JSON.parse(JSON.stringify(envelope)));
    return { state: "acknowledged", detail: "accepted", envelope: { sender: "forged" }, secret: "sentinel" };
  });
  const result = await f.send(external, input);
  expect(result.envelope.sender).toBe("authenticated-local-supervisor");
  expect(JSON.stringify(result)).not.toContain("sentinel");
  expect(Object.keys(result)).toEqual(["envelope", "state", "detail", "idempotencyKey", "workspace", "hostPid"]);
  expect((await f.send(external, input)).envelope.messageId).toBe(result.envelope.messageId);
});
it("passes the optional deliveryKind and reasonCode through, dropping unknown values and tolerating older hosts", async () => {
  const f = await fixture();
  f.post.mockResolvedValueOnce({ state: "acknowledged", detail: "inserted", deliveryKind: "core_seam" });
  const seam = await f.send(external, { ...input, idempotencyKey: "seam", mode: "steer" });
  expect(seam).toMatchObject({ state: "acknowledged", deliveryKind: "core_seam" }); expect(seam).not.toHaveProperty("reasonCode");
  f.post.mockResolvedValueOnce({ state: "rejected", detail: "no seam", reasonCode: "core_seam_inactive", deliveryKind: "bogus" });
  const refused = await f.send(external, { ...input, idempotencyKey: "refused", mode: "steer" });
  expect(refused).toMatchObject({ state: "rejected", reasonCode: "core_seam_inactive" }); expect(refused).not.toHaveProperty("deliveryKind");
  const older = await f.send(external, { ...input, idempotencyKey: "older" });
  expect(older).not.toHaveProperty("deliveryKind");
  expect(JSON.parse(await readFile(f.path, "utf8"))[0].deliveryKind).toBe("core_seam");
});
it.each([{ state: "invented", detail: "bad" }, { state: "acknowledged", detail: { secret: "sentinel" } }, null])("fails closed on malformed host response %j", async (response) => {
  const f = await fixture(); f.post.mockResolvedValueOnce(response);
  const result = await f.send(external, input);
  expect(result.state).toBe("unknown"); expect(JSON.stringify(result)).not.toContain("sentinel");
});
it("does not post when acceptance cannot be saved", async () => {
  const f = await fixture(); f.writer.mockRejectedValueOnce(new Error("disk unavailable"));
  await expect(f.send(external, input)).rejects.toThrow("disk unavailable");
  expect(f.post).not.toHaveBeenCalled(); expect(f.inFlight.size).toBe(0);
});
it("expires pending dispatch to unknown while keeping it excluded from restore until settled", async () => {
  const f = await fixture(); const hold = deferred(); const entered = deferred();
  f.post.mockImplementationOnce(async () => { entered.resolve(); await hold.promise; throw new Error("lost response"); });
  vi.useFakeTimers(); const sending = f.send(external, input); await entered.promise;
  const retryBeforeExpiry = f.send(external, input);
  try {
    await vi.advanceTimersByTimeAsync(21);
    expect([...f.ledger.messages.values()][0]).toMatchObject({ state: "unknown", detail: "Host response unavailable; do not blindly resend" });
    expect(f.inFlight.size).toBe(1);
    const retryWhileHanging = f.send(external, input);
    await Promise.resolve();
    expect(f.post).toHaveBeenCalledTimes(1);
    hold.resolve();
    expect((await retryWhileHanging).envelope.messageId).toBe((await sending).envelope.messageId);
    expect((await retryBeforeExpiry).envelope.messageId).toBe((await sending).envelope.messageId);
  } finally { hold.resolve(); }
  const settled = await sending;
  expect(settled.state).toBe("unknown"); expect(f.inFlight.size).toBe(0);
  expect((await f.send(external, input)).envelope.messageId).toBe(settled.envelope.messageId);
  expect(f.post).toHaveBeenCalledTimes(1);
});
it("aborts before authorization or after the durability barrier without posting", async () => {
  const f = await fixture(); const controller = new AbortController(); controller.abort();
  await expect(f.send(external, input, controller.signal)).rejects.toThrow("Send aborted");
  expect(f.authorize).not.toHaveBeenCalled();
  vi.useFakeTimers();
  const later = new AbortController();
  f.writer.mockImplementationOnce(async (path, text) => { await writePrivateFile(path, text); later.abort(); });
  await expect(f.send(external, input, later.signal)).rejects.toThrow("Send aborted");
  expect(f.post).not.toHaveBeenCalled();
  const saved = JSON.parse(await readFile(f.path, "utf8"));
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({ state: "unknown", detail: "Dispatch pending", idempotencyKey: input.idempotencyKey });
  expect(await f.send(external, input)).toEqual(saved[0]);
  expect(f.ledger.messages.size).toBe(1); expect(f.post).not.toHaveBeenCalled();
});

it("keeps a joining retry independent of the first caller aborting during acceptance", async () => {
  const f = await fixture(); const hold = deferred(); const entered = deferred();
  const firstCaller = new AbortController();
  f.writer.mockImplementationOnce(async (path, text) => { entered.resolve(); await hold.promise; await writePrivateFile(path, text); });
  const first = f.send(external, input, firstCaller.signal); await entered.promise;
  const retry = f.send(external, input, new AbortController().signal);
  const outcomes = Promise.allSettled([first, retry]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(f.authorize).toHaveBeenCalledTimes(4);
  firstCaller.abort(); hold.resolve();
  const [a, b] = await outcomes;
  expect(a).toMatchObject({ status: "rejected", reason: new Error("Send aborted") });
  expect(b.status).toBe("fulfilled");
  const saved = JSON.parse(await readFile(f.path, "utf8"));
  expect(saved).toHaveLength(1);
  if (b.status === "fulfilled") expect(b.value.envelope.messageId).toBe(saved[0].envelope.messageId);
  expect((await f.send(external, input)).envelope.messageId).toBe(saved[0].envelope.messageId);
  expect(f.post).not.toHaveBeenCalled();
});
it("checks a joining caller's own abort after the shared dispatch settles", async () => {
  const f = await fixture(); const hold = deferred(); const entered = deferred();
  const joining = new AbortController();
  f.post.mockImplementationOnce(async () => { entered.resolve(); await hold.promise; return { state: "acknowledged" }; });
  const first = f.send(external, input); await entered.promise;
  const retry = f.send(external, input, joining.signal);
  const outcomes = Promise.allSettled([first, retry]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(f.authorize).toHaveBeenCalledTimes(4);
  joining.abort(); hold.resolve();
  const [a, b] = await outcomes;
  expect(a.status).toBe("fulfilled");
  expect(b).toMatchObject({ status: "rejected", reason: new Error("Send aborted") });
  expect(f.post).toHaveBeenCalledTimes(1);
});
