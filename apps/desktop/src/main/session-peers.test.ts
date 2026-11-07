import { expect, it, vi } from "vitest";
import { createSessionPeersHandler, type PeerHost } from "./session-peers.js";

function fixture() {
  const proc = {};
  let caller: PeerHost = { tabId: "a", sessionId: "a", proc, generation: 1, workspace: "/a", workspaceKey: "/a",
    live: true, root: true, restricted: false, readOnly: false, engine: "core", activity: "idle" };
  const target = { ...caller, tabId: "b", sessionId: "b", secret: "credential", pid: 123 };
  const access = { canAccess: vi.fn(() => true) };
  const prepare = vi.fn(async () => {});
  const handler = createSessionPeersHandler({ current: () => caller, targets: () => [target], access, prepare });
  return { handler, proc, prepare, access, set: (patch: Partial<PeerHost>) => { caller = { ...caller, ...patch }; } };
}
const request = { requestId: "r", operation: "list", input: {} };
it("binds identity to the current proc and rejects forged sender fields", async () => {
  const f = fixture();
  expect(await f.handler("a", {}, request)).toBeNull();
  expect(await f.handler("a", f.proc, { ...request, sender: "b" })).toBeNull();
  expect(f.prepare).not.toHaveBeenCalled();
  const answer = await f.handler("a", f.proc, request);
  expect(answer).toMatchObject({ status: "ok", sessions: [{ sessionId: "b" }] });
  expect(JSON.stringify(answer)).not.toMatch(/credential|pid|proc|generation/);
});
it("refuses relocation across an await and drops obsolete process responses", async () => {
  const f = fixture();
  f.prepare.mockImplementationOnce(async () => { f.set({ workspace: "/changed" }); });
  expect(await f.handler("a", f.proc, request)).toEqual({ status: "refused" });
  f.prepare.mockImplementationOnce(async () => { f.set({ proc: {} }); });
  expect(await f.handler("a", f.proc, request)).toBeNull();
});
it("fails closed for access revocation, unavailable operations and internal errors", async () => {
  const f = fixture();
  f.access.canAccess.mockReturnValue(false);
  expect(await f.handler("a", f.proc, request)).toEqual({ status: "refused" });
  f.access.canAccess.mockReturnValue(true);
  expect(await f.handler("a", f.proc, { requestId: "s", operation: "send", input: { sessionId: "b", payload: "hi" } })).toEqual({ status: "unavailable" });
  f.prepare.mockRejectedValueOnce(new Error("credential"));
  expect(await f.handler("a", f.proc, request)).toEqual({ status: "unknown" });
});
it("bounds duplicate and concurrent requests and releases deadline reservations", async () => {
  vi.useFakeTimers();
  try {
    const f = fixture();
    f.prepare.mockImplementation(() => new Promise(() => {}));
    const calls = Array.from({ length: 64 }, (_, i) => f.handler("a", f.proc, { ...request, requestId: String(i) }));
    expect(await f.handler("a", f.proc, { ...request, requestId: "0" })).toBeNull();
    expect(await f.handler("a", f.proc, { ...request, requestId: "overflow" })).toBeNull();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await Promise.all(calls)).toEqual(Array.from({ length: 64 }, () => ({ status: "unknown" })));
    f.prepare.mockImplementation(async () => {});
    expect(await f.handler("a", f.proc, request)).toMatchObject({ status: "ok" });
  } finally { vi.useRealTimers(); }
});

it("keeps the created ids when first-message admission refuses and forwards reply mode", async () => {
  const caller: PeerHost = { tabId: "a", sessionId: "a", proc: {}, generation: 1, workspace: "/a", workspaceKey: "/a",
    live: true, root: true, restricted: false, readOnly: false, engine: "claude", activity: "idle" };
  const target = { ...caller, sessionId: "new", tabId: "new" };
  const send = vi.fn(async () => { throw new Error("private refusal"); });
  type Open = NonNullable<Parameters<typeof createSessionPeersHandler>[0]["open"]>;
  const open = vi.fn(async (request: Parameters<Open>[0], policy: Parameters<Open>[1]) => {
    expect(request).toMatchObject({ workspace: "/a", engine: "claude", firstMessage: "hello" });
    expect(await policy.authorize("/a", "/a", false)).toBe(true);
    return { ok: true as const, sessionId: "new", tabId: "new", handle: "peer",
      delivery: await policy.deliverFirstMessage!("new", request.firstMessage!) };
  });
  const handler = createSessionPeersHandler({ current: () => caller, targets: () => [target], open, send,
    prepare: async () => {}, access: { canAccess: () => true, canAccessWorkspace: async () => true } });
  expect(await handler("a", caller.proc!, { requestId: "r", operation: "open", input: { firstMessage: "hello", reply: "on_turn_end" } }))
    .toEqual({ status: "opened", sessionId: "new", tabId: "new", label: "peer", delivery: { state: "rejected" } });
  expect(send).toHaveBeenCalledWith(expect.anything(), { sessionId: "new", payload: "hello", reply: "on_turn_end" }, expect.any(Function));
});
