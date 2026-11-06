import { expect, it, vi } from "vitest";
import { createSessionPeersPort } from "./session-peers-port.js";

it("bounds pending calls and frees them on abort, deadline and disconnect", async () => {
  vi.useFakeTimers();
  const sent: any[] = [];
  const port = createSessionPeersPort(m => sent.push(m), { maxPending: 1, timeoutMs: 10 });
  const abort = new AbortController();
  const first = port.request({ operation: "list", input: {} }, abort.signal);
  expect(port.pendingCount).toBe(1);
  expect(await port.request({ operation: "list", input: {} })).toEqual({ status: "unavailable" });
  abort.abort();
  expect(await first).toEqual({ status: "unknown" });
  const timed = port.request({ operation: "list", input: {} });
  await vi.advanceTimersByTimeAsync(10);
  expect(await timed).toEqual({ status: "unknown" });
  const disconnected = port.request({ operation: "list", input: {} });
  port.dispose();
  expect(await disconnected).toEqual({ status: "unknown" });
  expect(port.pendingCount).toBe(0);
  expect(await port.request({ operation: "list", input: {} })).toEqual({ status: "unavailable" });
  vi.useRealTimers();
});
it("correlates responses and refuses malformed payloads without leaking fields", async () => {
  const sent: any[] = [];
  const port = createSessionPeersPort(m => sent.push(m));
  const result = port.request({ operation: "list", input: {} });
  port.handle({ type: "session_peers_response", requestId: "foreign", result: { status: "unknown" } });
  expect(port.pendingCount).toBe(1);
  port.handle({ type: "session_peers_response", requestId: sent[0].request.requestId,
    result: { status: "ok", sessions: [], secret: "credential" } });
  expect(await result).toEqual({ status: "unknown" });
  const next = port.request({ operation: "list", input: {} });
  port.handle({ type: "session_peers_response", requestId: sent[1].request.requestId, result: { status: "ok", sessions: [] } });
  expect(await next).toEqual({ status: "ok", sessions: [] });
  port.dispose();
});
