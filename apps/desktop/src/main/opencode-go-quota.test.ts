import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cloneDefaults } from "../settings/schema.js";
import { loadSettings } from "../settings/files.js";
import { createOpenCodeGoQuotaPoller, createOpenCodeGoQuotaService } from "./opencode-go-quota.js";

const route = { kind: "direct", why: "explicit-direct" } as const;
const body = { usage: { rolling: { percent: 0 }, weekly: { percent: 50 }, monthly: { percent: 100 } } };
const response = (value: unknown = body) => new Response(JSON.stringify(value));

describe("Go quota polling", () => {
  it("uses fixed Bearer GET, deduplicates and throttles failures through the boundary", async () => {
    let now = 0; let release!: (r: Response) => void;
    const fetch = vi.fn((_url: string, _init: RequestInit) => new Promise<Response>(resolve => { release = resolve; }));
    const record = vi.fn(async () => {});
    const poller = createOpenCodeGoQuotaPoller({ resolve: async () => ({ apiKey: "key", guard: "guard", route }), fetch: () => fetch, record, now: () => now });
    const a = poller.refresh("a"); const b = poller.refresh("a");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(fetch.mock.calls[0]![0]).toBe("https://opencode.ai/zen/go/v1/usage");
    expect(fetch.mock.calls[0]![1]).toMatchObject({ method: "GET", headers: { Authorization: "Bearer key" }, redirect: "error", signal: expect.any(AbortSignal) });
    release(new Response("bad", { status: 500 })); await Promise.all([a, b]);
    expect(record).toHaveBeenCalledWith("a", "guard", undefined);
    now = 59_999; await poller.refresh("a"); expect(fetch).toHaveBeenCalledTimes(1);
    now = 60_000; const c = poller.refresh("a"); await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2)); release(response()); await c;
  });
});

describe("Go quota persistence", () => {
  let dir: string; let path: string; let key: string | undefined; let now: number;
  const write = (connections: unknown[]) => writeFile(path, JSON.stringify({ ...cloneDefaults(), provider: { connections } }));
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "go-quota-")); path = join(dir, "settings.json"); key = "key"; now = Date.parse("2026-01-01T00:00:00Z"); await write([{ id: "a", providerId: "opencode" }, { id: "b", providerId: "opencode-openai" }]); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
  it("polls both IDs, replaces windows, clears failures and recovers", async () => {
    const fetch = vi.fn().mockImplementation(async () => response()); const ping = vi.fn();
    const service = createOpenCodeGoQuotaService({ settingsPath: path, vault: { getSecretValue: async () => key }, fetch: () => fetch, onPersisted: ping, now: () => now });
    await service.refresh();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((await loadSettings(path)).settings.provider.connections.map(c => c.lastGoQuota?.windows)).toEqual([ { rolling: { usedPercent: 0 }, weekly: { usedPercent: 50 }, monthly: { usedPercent: 100 } }, { rolling: { usedPercent: 0 }, weekly: { usedPercent: 50 }, monthly: { usedPercent: 100 } } ]);
    now += 60_000; fetch.mockResolvedValueOnce(response({ usage: { rolling: { percent: 7 } } })); await service.refresh("a");
    expect((await loadSettings(path)).settings.provider.connections[0]?.lastGoQuota?.windows).toEqual({ rolling: { usedPercent: 7 } });
    now += 60_000; fetch.mockResolvedValueOnce(response({ error: true })); await service.refresh("a");
    expect((await loadSettings(path)).settings.provider.connections[0]?.lastGoQuota).toBeUndefined();
    now += 60_000; await service.refresh("a"); expect((await loadSettings(path)).settings.provider.connections[0]?.lastGoQuota).toBeDefined();
    expect(ping).toHaveBeenCalledTimes(5);
  });
  it("refuses unrelated origins and missing keys", async () => {
    await write([{ id: "a", providerId: "opencode", baseUrl: "https://opencode.ai.evil/inference/go/anthropic" }, { id: "b", providerId: "opencode-openai", baseUrl: "https://opencode.ai/inference/go/openai/v1/other" }]);
    const fetch = vi.fn(async () => response()); const service = createOpenCodeGoQuotaService({ settingsPath: path, vault: { getSecretValue: async () => key }, fetch: () => fetch, onPersisted: () => {} });
    await service.refresh(); expect(fetch).not.toHaveBeenCalled();
    await write([{ id: "c", providerId: "opencode" }]); key = undefined; await service.refresh("c"); expect(fetch).not.toHaveBeenCalled();
  });
  it.each([true, false])("ignores delayed result after credential change (success %s)", async success => {
    let release!: (r: Response) => void; const fetch = vi.fn(() => new Promise<Response>(resolve => { release = resolve; })); const ping = vi.fn();
    const service = createOpenCodeGoQuotaService({ settingsPath: path, vault: { getSecretValue: async () => key }, fetch: () => fetch, onPersisted: ping });
    const pending = service.refresh("a"); await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    key = "new-key"; release(success ? response() : new Response("failed", { status: 500 })); await pending;
    expect((await loadSettings(path)).settings.provider.connections[0]?.lastGoQuota).toBeUndefined(); expect(ping).not.toHaveBeenCalled();
  });
  it.each(["base", "proxy", "deleted", "readonly"])("ignores delayed responses after %s changes", async change => {
    let release!: (r: Response) => void; const fetch = vi.fn(() => new Promise<Response>(resolve => { release = resolve; })); const ping = vi.fn();
    const service = createOpenCodeGoQuotaService({ settingsPath: path, vault: { getSecretValue: async () => key }, fetch: () => fetch, onPersisted: ping });
    const pending = service.refresh("a"); await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    if (change === "deleted") await write([]);
    else if (change === "readonly") await writeFile(path, JSON.stringify({ ...cloneDefaults(), version: 999, provider: { connections: [{ id: "a", providerId: "opencode" }] } }));
    else if (change === "base") await write([{ id: "a", providerId: "opencode", baseUrl: "https://opencode.ai/inference/go/anthropic/v1" }]);
    else await write([{ id: "a", providerId: "opencode", proxyRef: "missing" }]);
    release(response()); await pending; expect(ping).not.toHaveBeenCalled();
  });

});
