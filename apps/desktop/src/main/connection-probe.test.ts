import { createConnectionProbe } from "./connection-probe.js";
import { afterEach, expect, it, vi } from "vitest";
import { cloneDefaults } from "../settings/schema.js";
const connection = { id: "go", providerId: "opencode", label: "Go" };
const secret = "fake-private-key";
const settings = cloneDefaults();
settings.provider.connections = [connection];
function probe(fetcher: typeof fetch) {
  return async (...args: [typeof connection, string]) => createConnectionProbe({ settings: async () => settings,
    vault: { getSecretValue: async () => secret }, fetch: () => fetcher })(...args);
}
afterEach(() => vi.useRealTimers());
it.each([[200, { ok: true }], [401, { ok: false, code: "auth" }], [403, { ok: false, code: "forbidden" }], [429, { ok: false, code: "rate_limited" }], [500, { ok: false, code: "server" }], [404, { ok: false, code: "unexpected_response" }], [400, { ok: false, code: "unexpected_response" }]])("classifies HTTP %s without returning credentials or response text", async (status, outcome) => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ usage: { rolling: { percent: 12 } }, echo: secret }), { status }));
  const result = await probe(fetcher)(connection, secret);
  expect(result).toEqual(outcome);
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]?.[0]).toBe("https://opencode.ai/zen/go/v1/usage");
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "GET", redirect: "error", headers: { Authorization: `Bearer ${secret}` } });
});
it("maps network exceptions to a safe code", async () => {
  expect(await probe(vi.fn().mockRejectedValue(new Error(secret)))(connection, secret)).toEqual({ ok: false, code: "network" });
});
it("bounds a hung fetch and aborts it", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
  const result = probe(fetcher)(connection, secret);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await result).toEqual({ ok: false, code: "connect_timeout" });
  expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
});
it("rejects a successful HTTP response with an unexpected body", async () => {
  expect(await probe(vi.fn().mockResolvedValue(new Response("{}")))(connection, secret)).toEqual({ ok: false, code: "unexpected_response" });
});
it.each(["opencode", "opencode-openai"])("supports both Go transports: %s", async providerId => {
  expect(await probe(vi.fn().mockResolvedValue(new Response('{"usage":{"rolling":{"percent":0}}}')))({ ...connection, providerId }, secret)).toEqual({ ok: true });
});
it.each(["anthropic", "openai", "custom:local", "vllm", ""])("skips unsupported kinds without network: %s", async providerId => {
  const fetcher = vi.fn();
  expect(await probe(fetcher)({ ...connection, providerId }, secret)).toBeUndefined();
  expect(fetcher).not.toHaveBeenCalled();
});

it("bounds a stalled response body too", async () => {
  vi.useFakeTimers();
  const response = { ok: true, json: () => new Promise(() => {}) } as Response;
  const result = probe(vi.fn().mockResolvedValue(response))(connection, secret);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await result).toEqual({ ok: false, code: "connect_timeout" });
});
it("does not send a key when the saved credential changed before the probe", async () => {
  const fetcher = vi.fn();
  expect(await probe(fetcher)(connection, "old-private-key")).toBeUndefined();
  expect(fetcher).not.toHaveBeenCalled();
});

it("rejects foreign base URLs before network access", async () => {
  const fetcher = vi.fn();
  expect(await probe(fetcher)({ ...connection, baseUrl: "https://example.test/v1" } as typeof connection, secret)).toBeUndefined();
  expect(fetcher).not.toHaveBeenCalled();
});
it("classifies invalid success JSON as an unexpected response", async () => {
  expect(await probe(vi.fn().mockResolvedValue(new Response("<html>")))(connection, secret)).toEqual({ ok: false, code: "unexpected_response" });
});
