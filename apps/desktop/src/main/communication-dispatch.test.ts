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
  try {
    await vi.advanceTimersByTimeAsync(21);
    expect([...f.ledger.messages.values()][0]).toMatchObject({ state: "unknown", detail: "Host response unavailable; do not blindly resend" });
    expect(f.inFlight.size).toBe(1);
  } finally { hold.resolve(); }
  expect((await sending).state).toBe("unknown"); expect(f.inFlight.size).toBe(0);
});
it("aborts before authorization or after the durability barrier without posting", async () => {
  const f = await fixture(); const controller = new AbortController(); controller.abort();
  await expect(f.send(external, input, controller.signal)).rejects.toThrow("Send aborted");
  expect(f.authorize).not.toHaveBeenCalled();
  const later = new AbortController();
  f.writer.mockImplementationOnce(async (path, text) => { await writePrivateFile(path, text); later.abort(); });
  await expect(f.send(external, input, later.signal)).rejects.toThrow("Send aborted");
  expect(f.post).not.toHaveBeenCalled();
});
