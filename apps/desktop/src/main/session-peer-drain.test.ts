import { expect, it, vi } from "vitest";
import { createSessionPeerDrain } from "./session-peer-drain.js";
import { createSessionPeerAccess } from "./session-peer-access.js";
import type { PeerHost } from "./session-peers.js";
import type { CommunicationRecord } from "./communication-ledger.js";
const request = { type: "session_peer_drain_request", messageId: "m", nonce: "n", recipientSessionId: "b", generation: 1 } as const;
function fixture(startedAt = Date.now(), acceptedAt = startedAt) {
  const host = (id: string): PeerHost => ({ sessionId: id, tabId: id, proc: {}, generation: 1, workspace: `/${id}`, workspaceKey: `/${id}`,
    live: true, root: true, restricted: false, readOnly: false, engine: "core", activity: "idle" });
  const a = host("a"), b = host("b");
  const record: CommunicationRecord = { envelope: { messageId: "m", sender: "session:a", recipientSessionId: "b", payload: "hello",
    kind: "agent_message", mode: "next_turn", createdAt: new Date().toISOString() }, state: "queued", workspace: "/b",
    principal: { kind: "session", sessionId: "a", tabId: "a" }, peer: { chainId: "m", startedAt, hop: 0, acceptedAt, senderWorkspace: "/a" } };
  const authority = { grant: true, trust: true };
  const policy = { projectKeys: () => [], isNativeEnabled: () => true, hasPairGrant: () => authority.grant, setNativeEnabled: () => false, setPairGrant: () => false };
  const actual = createSessionPeerAccess({ enabled: () => true, policy, isTrusted: () => authority.trust,
    realpathSync: path => path, statSync: () => ({ isDirectory: () => true }), platform: "linux" });
  const lookup = vi.fn((_id: string) => record), prepare = vi.fn(async () => {}), access = { canAccess: vi.fn(actual.canAccess) };
  const registry = createSessionPeerDrain({ lookup, current: id => [a, b].find(h => h.sessionId === id), prepare, access });
  expect(registry.register(record, a, b)).toBe(true);
  return { authority, a, b, record, lookup, prepare, access, registry, run: (raw: unknown = request, proc = b.proc!) => registry.request(proc, raw) };
}
it("pins the exact broker record and issues once across concurrent and duplicate requests", async () => {
  const f = fixture();
  expect(f.registry.register({ ...f.record }, f.a, f.b)).toBe(false);
  expect(f.registry.register(f.record, f.a, f.b)).toBe(false);
  let release!: () => void;
  f.prepare.mockImplementationOnce(() => new Promise<void>(r => { release = r; }));
  const pending = f.run();
  expect(await f.run()).toBeNull(); release();
  expect(await pending).toEqual({ ...request, type: "session_peer_drain_permit" });
  expect(await f.run({ ...request, nonce: "other" })).toBeNull();
});
it.each([{ messageId: "other" }, { recipientSessionId: "a" }, { generation: 2 }, { sender: "a" }, { nonce: "" }])("rejects forged request %j", async patch => {
  const f = fixture(); expect(await f.run({ ...request, ...patch })).toBeNull(); expect(f.prepare).not.toHaveBeenCalled();
});
it("rejects an unauthenticated process", async () => { expect(await fixture().run(request, {})).toBeNull(); });
it.each(["a", "b"] as const)("rechecks %s process, generation and workspace after fresh prepare", async side => {
  for (const patch of [{ proc: {} }, { generation: 2 }, { workspace: "/moved" }, { workspaceKey: "/moved" }, { live: false }]) {
    const f = fixture(); f.prepare.mockImplementationOnce(async () => { Object.assign(f[side], patch); });
    expect(await f.run()).toBeNull();
  }
});
it.each(["grant", "trust"] as const)("refuses fresh %s revoke and replaced broker membership", async field => {
  const f = fixture(); f.prepare.mockImplementationOnce(async () => { f.authority[field] = false; });
  expect(await f.run()).toBeNull();
  const g = fixture(); g.prepare.mockImplementationOnce(async () => { g.lookup.mockReturnValue({ ...g.record }); });
  expect(await g.run()).toBeNull();
});
it("releases only an issued matching permit and forbids nonce reuse", async () => {
  const f = fixture(), permit = (await f.run())!, release = { ...permit, type: "session_peer_drain_release" };
  expect(f.registry.release({}, release)).toBe(false);
  for (const patch of [{ nonce: "x" }, { messageId: "x" }, { generation: 2 }, { recipientSessionId: "a" }, { extra: true }]) {
    expect(f.registry.release(f.b.proc!, { ...release, ...patch })).toBe(false);
  }
  expect(f.registry.release(f.b.proc!, release)).toBe(true); expect(await f.run()).toBeNull();
  expect(await f.run({ ...request, nonce: "fresh" })).not.toBeNull();
});
it("bounds prepare lifetime, refuses failure and invalidates pending work on dispose", async () => {
  vi.useFakeTimers();
  try {
    const f = fixture(); f.prepare.mockImplementation(() => new Promise(() => {}));
    const pending = f.run(); await vi.advanceTimersByTimeAsync(20_000); expect(await pending).toBeNull();
    const g = fixture(); g.prepare.mockRejectedValueOnce(Error()); expect(await g.run()).toBeNull();
    const h = fixture(); h.prepare.mockImplementationOnce(async () => { h.registry.dispose(); }); expect(await h.run()).toBeNull();
  } finally { vi.useRealTimers(); }
});
it("keeps the accepted payload immutable and refuses rejected or lost deliveries", async () => {
  for (const mutate of [(r: CommunicationRecord) => { r.envelope.payload = "changed"; },
    (r: CommunicationRecord) => { r.state = "rejected"; }, (r: CommunicationRecord) => { r.state = "unknown"; }]) {
    const f = fixture(); f.prepare.mockImplementationOnce(async () => { mutate(f.record); }); expect(await f.run()).toBeNull();
  }
});


it("evicts oldest terminal entries across lifetime churn without touching live or pending entries", async () => {
  const f = fixture(Date.now(), -1);
  const records = new Map([["m", f.record]]);
  f.lookup.mockImplementation(id => records.get(id)!);
  const add = (id: string, state: CommunicationRecord["state"], acceptedAt: number, detail?: string) => {
    const record = structuredClone(f.record);
    record.envelope.messageId = id; record.state = state; record.peer!.acceptedAt = acceptedAt; record.detail = detail;
    records.set(id, record);
    return f.registry.register(record, f.a, f.b);
  };
  let finish!: () => void;
  f.prepare.mockImplementationOnce(() => new Promise<void>(r => { finish = r; }));
  const pending = f.run();
  // Even a terminal delivery cannot be evicted while fresh authorization is pending.
  f.record.state = "acknowledged";
  expect(add("live", "queued", 0)).toBe(true);
  expect(add("dispatch", "unknown", 0, "Dispatch pending")).toBe(true);
  expect(add("older", "acknowledged", 1)).toBe(true);
  for (let i = 0; i < 9996; i++) expect(add(`terminal-${i}`, "acknowledged", i + 2)).toBe(true);
  for (let i = 0; i < 20; i++) expect(add(`churn-${i}`, "acknowledged", 10000 + i)).toBe(true);
  expect(await f.run({ ...request, messageId: "older" })).toBeNull();
  expect(await f.run({ ...request, nonce: "duplicate-pending" })).toBeNull();
  finish(); expect(await pending).not.toBeNull();
  expect(await f.run({ ...request, messageId: "live" })).not.toBeNull();
  expect(await f.run({ ...request, messageId: "dispatch" })).not.toBeNull();
});

it("refuses saturation when every entry is live", () => {
  const f = fixture();
  f.lookup.mockImplementation(() => f.record);
  for (let i = 0; i < 9999; i++) {
    f.record.envelope.messageId = `live-${i}`;
    expect(f.registry.register(f.record, f.a, f.b)).toBe(true);
  }
  f.record.envelope.messageId = "overflow";
  expect(f.registry.register(f.record, f.a, f.b)).toBe(false);
});

it("rechecks chain expiry after fresh prepare at the permit boundary", async () => {
  vi.useFakeTimers();
  try {
    const f = fixture(Date.now() - 30 * 60_000 + 1);
    f.prepare.mockImplementationOnce(async () => { vi.setSystemTime(Date.now() + 1); });
    expect(await f.run()).toBeNull();
  } finally { vi.useRealTimers(); }
});

 it("awaits live access and refuses revoke or process replacement during the check", async () => {
   for (const allowed of [false, true]) {
     const f = fixture();
     let release!: (allowed: boolean) => void;
     f.access.canAccess.mockImplementationOnce(() => new Promise<boolean>(r => { release = r; }));
     const pending = f.run();
     await vi.waitFor(() => expect(release).toBeTypeOf("function"));
     if (allowed) f.b.proc = {};
     release(allowed);
     expect(await pending).toBeNull();
   }
 });
