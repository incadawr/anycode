import { expect, it, vi } from "vitest";
import { createSessionPeerDrainTransport } from "./session-peer-drain.js";
it("matches strict nonce/message/recipient/generation and consumes only the original permit once", async () => {
  const post = vi.fn(), port = createSessionPeerDrainTransport(post, { recipientSessionId: "b", generation: 1 });
  const waiting = port.request("m"), request = post.mock.calls[0]![0];
  expect(await port.request("m")).toBeNull();
  const permit = { ...request, type: "session_peer_drain_permit" };
  for (const patch of [{ nonce: "fake" }, { messageId: "x" }, { recipientSessionId: "x" }, { generation: 2 }, { extra: true }]) {
    expect(port.handle({ ...permit, ...patch })).toBe(false);
  }
  expect(port.handle(permit)).toBe(true);
  const received = await waiting;
  expect(port.handle(permit)).toBe(false);
  expect(port.consume({ ...permit })).toBe(false);
  expect(port.consume(received!)).toBe(true); expect(port.consume(received!)).toBe(false);
  port.dispose();
});
it.each(["timeout", "disconnect", "dispose"] as const)("bounds pending lifetime on %s and refuses late responses", async end => {
  vi.useFakeTimers();
  try {
    const post = vi.fn(), port = createSessionPeerDrainTransport(post, { recipientSessionId: "b", generation: 1, timeoutMs: 10 });
    const pending = port.request("m"), late = { ...post.mock.calls[0]![0], type: "session_peer_drain_permit" };
    if (end === "timeout") await vi.advanceTimersByTimeAsync(10); else port[end]();
    expect(await pending).toBeNull(); expect(port.handle(late)).toBe(false);
    port.dispose(); expect(await port.request("new")).toBeNull();
  } finally { vi.useRealTimers(); }
});
it("expires unconsumed permits and fails closed when post throws", async () => {
  vi.useFakeTimers();
  try {
    const post = vi.fn(), port = createSessionPeerDrainTransport(post, { recipientSessionId: "b", generation: 1, timeoutMs: 10 });
    const pending = port.request("m"); port.handle({ ...post.mock.calls[0]![0], type: "session_peer_drain_permit" });
    const permit = await pending; await vi.advanceTimersByTimeAsync(10); expect(port.consume(permit!)).toBe(false);
    port.dispose();
    const broken = createSessionPeerDrainTransport(() => { throw Error(); }, { recipientSessionId: "b", generation: 1 });
    expect(await broken.request("m")).toBeNull(); broken.dispose();
  } finally { vi.useRealTimers(); }
});
it("discards an unused permit explicitly so a busy session can request fresh authorization", async () => {
  const post = vi.fn(), port = createSessionPeerDrainTransport(post, { recipientSessionId: "b", generation: 1 });
  const pending = port.request("m"); port.handle({ ...post.mock.calls[0]![0], type: "session_peer_drain_permit" });
  const permit = (await pending)!;
  expect(port.discard({ ...permit })).toBe(false); expect(port.discard(permit)).toBe(true);
  expect(post.mock.lastCall![0]).toEqual({ ...permit, type: "session_peer_drain_release" });
  expect(port.consume(permit)).toBe(false); expect(port.discard(permit)).toBe(false); port.dispose();
});
it("caps pending requests and validates locally before posting", async () => {
  const post = vi.fn(), port = createSessionPeerDrainTransport(post, { recipientSessionId: "b", generation: 1 });
  expect(await port.request("")).toBeNull();
  const waiting = Array.from({ length: 64 }, (_, i) => port.request(String(i)));
  expect(await port.request("overflow")).toBeNull(); expect(post).toHaveBeenCalledTimes(64);
  port.dispose(); expect(await Promise.all(waiting)).toEqual(Array(64).fill(null));
});
