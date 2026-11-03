import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSettings } from "../settings/files.js";
import { createMiniMaxQuotaPoller, createMiniMaxQuotaService } from "./minimax-quota.js";
import { resetConnectionQuotaThrottles } from "./connection-quota.js";

const response = () => new Response(JSON.stringify({ base_resp: { status_code: 0 }, model_remains: [{ current_interval_remaining_percent: 80 }] }));
const route = { kind: "direct", why: "explicit-direct" } as const;

describe("MiniMax quota polling", () => {
  it("deduplicates in-flight requests, throttles, and refuses redirects", async () => {
    let now = 0;
    let release!: (response: Response) => void;
    const fetch = vi.fn((_url: string, _init: RequestInit) => new Promise<Response>(resolve => { release = resolve; }));
    const record = vi.fn(async () => {});
    const poller = createMiniMaxQuotaPoller({ resolve: async () => ({ apiKey: "secret-key", guard: "guard", route }), fetch: () => fetch, record, now: () => now });
    const first = poller.refresh("one");
    expect(poller.refresh("one")).toBe(first);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(fetch.mock.calls[0]![0]).toBe("https://api.minimax.io/v1/token_plan/remains");
    expect(fetch.mock.calls[0]![1]).toMatchObject({ redirect: "error", method: "GET" });
    expect(fetch.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal);
    release(response()); await first;
    expect(record).toHaveBeenCalledWith("one", "guard", { usedPercent: 20, windowDurationMins: 300 });
    await poller.refresh("one"); expect(fetch).toHaveBeenCalledTimes(1);
    now = 60_000;
    const next = poller.refresh("one");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    release(response()); await next;
  });
  it("silently ignores redirects and pay as you go responses", async () => {
    const log = vi.spyOn(console, "error"); const warn = vi.spyOn(console, "warn");
    const record = vi.fn(async () => {});
    const fetch = vi.fn().mockRejectedValueOnce(new Error("redirect secret-key")).mockResolvedValueOnce(new Response(JSON.stringify({ base_resp: { status_code: 1004 } })));
    const poller = createMiniMaxQuotaPoller({ resolve: async () => ({ apiKey: "secret-key", guard: "guard", route }), fetch: () => fetch, record });
    await poller.refresh("one"); await poller.refresh("two");
    expect(record).not.toHaveBeenCalled(); expect(log).not.toHaveBeenCalled(); expect(warn).not.toHaveBeenCalled();
    log.mockRestore(); warn.mockRestore();
  });
});

describe("MiniMax quota persistence", () => {
  let dir: string; let path: string; let key: string | undefined;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "minimax-quota-")); path = join(dir, "settings.json"); key = "sk-cp-old";
    await writeFile(path, JSON.stringify({ version: 2, provider: { connections: [{ id: "c1", providerId: "minimax" }], activeConnectionId: "c1" }, tools: {}, permissions: { alwaysAllow: [] }, ui: { theme: "system" }, security: { allowWeakSecretStorage: false } }));
    resetConnectionQuotaThrottles();
  });
  afterEach(async () => { resetConnectionQuotaThrottles(); await rm(dir, { recursive: true, force: true }); });
  it("persists the primary window and notifies the renderer", async () => {
    const notify = vi.fn();
    const service = createMiniMaxQuotaService({ settingsPath: path, vault: { getSecretValue: async () => key }, fetch: () => async () => response(), onPersisted: notify });
    await service.refresh("c1");
    expect((await loadSettings(path)).settings.provider.connections[0]?.lastQuota).toMatchObject({ usedPercent: 20, windowDurationMins: 300, source: "minimax-token-plan" });
    expect(notify).toHaveBeenCalledTimes(1);
  });
  it.each(["rotate", "delete"])("drops an in-flight response after credential %s", async operation => {
    let release!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>(resolve => { release = resolve; }));
    const notify = vi.fn();
    const service = createMiniMaxQuotaService({ settingsPath: path, vault: { getSecretValue: async () => key }, fetch: () => fetch, onPersisted: notify });
    const request = service.refresh("c1");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    key = operation === "rotate" ? "sk-cp-new" : undefined;
    release(response()); await request;
    expect((await loadSettings(path)).settings.provider.connections[0]?.lastQuota).toBeUndefined();
    expect(notify).not.toHaveBeenCalled();
  });
  it("does not send credentials to the global endpoint for a China connection", async () => {
    await writeFile(path, JSON.stringify({ version: 2, provider: { connections: [{ id: "c1", providerId: "minimax-cn" }], activeConnectionId: "c1" }, tools: {}, permissions: { alwaysAllow: [] }, ui: { theme: "system" }, security: { allowWeakSecretStorage: false } }));
    const fetch = vi.fn(async () => response());
    const service = createMiniMaxQuotaService({ settingsPath: path, vault: { getSecretValue: async () => key }, fetch: () => fetch, onPersisted: () => {} });
    await service.refresh("c1");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("drops an in-flight response after the connection is removed", async () => {
    let release!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>(resolve => { release = resolve; }));
    const notify = vi.fn();
    const service = createMiniMaxQuotaService({ settingsPath: path, vault: { getSecretValue: async () => key }, fetch: () => fetch, onPersisted: notify });
    const request = service.refresh("c1");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await writeFile(path, JSON.stringify({ version: 2, provider: { connections: [] }, tools: {}, permissions: { alwaysAllow: [] }, ui: { theme: "system" }, security: { allowWeakSecretStorage: false } }));
    release(response()); await request;
    expect((await loadSettings(path)).settings.provider.connections).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
  });
});
