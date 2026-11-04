import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSettings } from "../settings/files.js";
import { createGlmQuotaPoller, createGlmQuotaService } from "./glm-quota.js";
import { resetConnectionQuotaThrottles } from "./connection-quota.js";

const response = () => new Response(JSON.stringify({ data: { level: "pro", limits: [
  { type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 12000, currentValue: 128, remaining: 11872, percentage: 1.07, nextResetTime: Date.now() + 60_000 },
  { type: "CREDIT_LIMIT", unit: 6, number: 1, usage: 60000, currentValue: 47004, remaining: 12996, percentage: 78.3, nextResetTime: Date.now() + 120_000 },
] } }));
const route = { kind: "direct", why: "explicit-direct" } as const;

// The persisted `lastQuota` windows shape (shared/settings.ts).
interface QuotaWindows { usedPercent: number; windowDurationMins?: number; resetsAt?: number; secondary?: Omit<QuotaWindows, "secondary"> }

describe("GLM quota polling", () => {
  it("sends the key raw in Authorization — NO Bearer — and records both windows", async () => {
    let now = 0;
    const fetch = vi.fn().mockResolvedValue(response());
    const record = vi.fn(async (_id: string, _guard: string, _quota: QuotaWindows) => {});
    const poller = createGlmQuotaPoller({ resolve: async () => ({ apiKey: "secret-key", guard: "guard", route }), fetch: () => fetch, record, now: () => now });
    await poller.refresh("one");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0]).toBe("https://api.z.ai/api/monitor/usage/quota/limit");
    const init = fetch.mock.calls[0]![1];
    expect(init.method).toBe("GET");
    expect(init.headers).toEqual({ Authorization: "secret-key" });
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const windows = record.mock.calls[0]![2];
    expect(windows).toMatchObject({ usedPercent: 1, windowDurationMins: 300, secondary: { usedPercent: 78, windowDurationMins: 10080 } });
    // resets survive the mapping (epoch seconds, near the mocked now)
    expect(windows.resetsAt).toBeGreaterThan(now / 1000);
    expect(windows.secondary?.resetsAt).toBeGreaterThan(windows.resetsAt!);
    await poller.refresh("one");
    expect(fetch).toHaveBeenCalledTimes(1); // 60 s throttle
    now = 60_000;
    await poller.refresh("one");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("silently ignores non-2xx, unknown shapes, redirects and throws — no record", async () => {
    const log = vi.spyOn(console, "error"); const warn = vi.spyOn(console, "warn");
    const record = vi.fn(async () => {});
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("no", { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "not a coding plan" })))
      .mockRejectedValueOnce(new Error("redirect secret-key"))
      .mockRejectedValueOnce(new Error("boom secret-key"));
    const poller = createGlmQuotaPoller({ resolve: async () => ({ apiKey: "secret-key", guard: "guard", route }), fetch: () => fetch, record });
    for (let i = 0; i < 4; i += 1) await poller.refresh("one");
    expect(record).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled(); expect(warn).not.toHaveBeenCalled();
    log.mockRestore(); warn.mockRestore();
  });
});

describe("GLM quota persistence", () => {
  let dir: string; let path: string; let key: string | undefined;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "glm-quota-")); path = join(dir, "settings.json"); key = "glm-key";
    await writeFile(path, JSON.stringify({ version: 2, provider: { connections: [{ id: "c1", providerId: "z-ai" }], activeConnectionId: "c1" }, tools: {}, permissions: { alwaysAllow: [] }, ui: { theme: "system" }, security: { allowWeakSecretStorage: false } }));
    resetConnectionQuotaThrottles();
  });
  afterEach(async () => { resetConnectionQuotaThrottles(); await rm(dir, { recursive: true, force: true }); });

  it("persists both windows for a catalog z-ai connection and notifies the renderer", async () => {
    const notify = vi.fn();
    const service = createGlmQuotaService({ settingsPath: path, vault: { getSecretValue: async () => key }, fetch: () => async () => response(), onPersisted: notify });
    await service.refresh("c1");
    expect((await loadSettings(path)).settings.provider.connections[0]?.lastQuota).toMatchObject({
      usedPercent: 1, windowDurationMins: 300,
      secondary: { usedPercent: 78, windowDurationMins: 10080 },
      source: "glm-coding-plan",
    });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("does not poll a pay-as-you-go Z.AI base or another provider", async () => {
    await writeFile(path, JSON.stringify({ version: 2, provider: { custom: [{ id: "custom:zpay", name: "Z pay", baseUrl: "https://api.z.ai/api/paas/v4", kind: "openai" as const, models: [] }], connections: [{ id: "c1", providerId: "custom:zpay" }, { id: "c2", providerId: "minimax" }], activeConnectionId: "c1" }, tools: {}, permissions: { alwaysAllow: [] }, ui: { theme: "system" }, security: { allowWeakSecretStorage: false } }));
    const fetch = vi.fn(async () => response());
    const service = createGlmQuotaService({ settingsPath: path, vault: { getSecretValue: async () => key }, fetch: () => fetch, onPersisted: () => {} });
    await service.refresh();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("drops an in-flight observation after the credential rotates", async () => {
    let release!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>(resolve => { release = resolve; }));
    const notify = vi.fn();
    const service = createGlmQuotaService({ settingsPath: path, vault: { getSecretValue: async () => key }, fetch: () => fetch, onPersisted: notify });
    const request = service.refresh("c1");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    key = "glm-key-2";
    release(response()); await request;
    expect((await loadSettings(path)).settings.provider.connections[0]?.lastQuota).toBeUndefined();
    expect(notify).not.toHaveBeenCalled();
  });
});
