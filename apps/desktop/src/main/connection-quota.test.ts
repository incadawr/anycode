/**
 * Unit tests for main/connection-quota.ts (Taskana 4090 / TASK.71 follow-up):
 * the throttled, sparse, locked `lastQuota` write that makes the provider
 * quota line survive a reload / snapshot refresh. Exercised off a scratch
 * settings.json (no Electron, no ipcMain) — the same fixture discipline as
 * provider-ipc.test.ts / settings-ipc.test.ts.
 *
 * The production window is QUOTA_WRITE_INTERVAL_MS (30 s); these tests
 * inject a millisecond-scale window (`writeIntervalMs`) plus a manual `now`
 * clock, so the trailing flush's timer AND its file IO run on the real event
 * loop (no fake timers) while the window arithmetic stays deterministic.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSettings, withSettingsFileLock } from "../settings/files.js";
import type { AnycodeSettings } from "../shared/settings.js";
import {
  QUOTA_QUIT_FLUSH_BUDGET_MS,
  QUOTA_WRITE_INTERVAL_MS,
  flushPendingConnectionQuota,
  handleProviderQuotaMessage,
  parseProviderQuotaEvent,
  recordConnectionQuota,
  resetConnectionQuotaThrottles,
  withConnectionQuota,
  type ConnectionQuotaDeps,
} from "./connection-quota.js";

let dir: string;
let settingsPath: string;
let deps: ConnectionQuotaDeps;
/**
 * Real-time clock + millisecond window: the injected `now` keeps the window
 * arithmetic deterministic (the test "closes" the window by advancing
 * `nowMs`), while the REAL event loop fires the trailing flush's timer and
 * its file IO — no fake timers anywhere.
 */
const INTERVAL = 40;
let nowMs: number;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "anycode-connection-quota-"));
  settingsPath = join(dir, "settings.json");
  nowMs = 1_000_000;
  deps = { settingsPath, now: () => nowMs, writeIntervalMs: INTERVAL };
  resetConnectionQuotaThrottles();
});

afterEach(async () => {
  resetConnectionQuotaThrottles();
  await rm(dir, { recursive: true, force: true });
});

/** Real-time poll loop (this vitest's `vi.waitFor` never polled async fns here). */
async function until(ready: () => Promise<boolean> | boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await ready()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("until: condition not met in time");
}

/** Minimal v2 settings fixture carrying an explicit `provider` object. */
function v2Settings(provider: Record<string, unknown>): AnycodeSettings {
  return {
    version: 2,
    provider,
    tools: {},
    permissions: { alwaysAllow: [] },
    ui: { theme: "system" },
    security: { allowWeakSecretStorage: false },
  } as unknown as AnycodeSettings;
}

async function writeSettingsFixture(provider: Record<string, unknown>): Promise<void> {
  await writeFile(settingsPath, JSON.stringify(v2Settings(provider)));
}

async function readConnections(): Promise<Record<string, unknown>[]> {
  const reloaded = await loadSettings(settingsPath);
  return reloaded.settings.provider.connections as unknown as Record<string, unknown>[];
}

async function persistedLine(): Promise<Record<string, unknown> | undefined> {
  return (await readConnections())[0]?.lastQuota as Record<string, unknown> | undefined;
}

describe("parseProviderQuotaEvent — process-boundary validation", () => {
  const raw = {
    type: "anycode:provider-quota",
    quota: { usedPercent: 80, resetsAt: 1_789_999_999 },
    source: "x-ratelimit-requests-remaining",
  };

  it("passes a well-formed event through with its optional fields", () => {
    expect(parseProviderQuotaEvent(raw)).toEqual(raw);
  });

  it("drops a wrong type, non-object, or missing source", () => {
    expect(parseProviderQuotaEvent({ ...raw, type: "other" })).toBeUndefined();
    expect(parseProviderQuotaEvent(null)).toBeUndefined();
    expect(parseProviderQuotaEvent("quota")).toBeUndefined();
    expect(parseProviderQuotaEvent({ ...raw, source: "" })).toBeUndefined();
    expect(parseProviderQuotaEvent({ ...raw, source: 5 })).toBeUndefined();
  });

  it("drops a quota outside [0,100] or with malformed optional fields (never coerced)", () => {
    expect(parseProviderQuotaEvent({ ...raw, quota: { usedPercent: 140 } })).toBeUndefined();
    expect(parseProviderQuotaEvent({ ...raw, quota: { usedPercent: -1 } })).toBeUndefined();
    expect(parseProviderQuotaEvent({ ...raw, quota: { usedPercent: "80%" } })).toBeUndefined();
    expect(parseProviderQuotaEvent({ ...raw, quota: { usedPercent: 80, resetsAt: 60 } })).toBeUndefined();
    expect(parseProviderQuotaEvent({ ...raw, quota: { usedPercent: 80, windowDurationMins: "5" } })).toBeUndefined();
  });

  it("handleProviderQuotaMessage silently drops a malformed payload (no file event)", async () => {
    await writeSettingsFixture({ connections: [{ id: "c1", providerId: "zai" }] });
    const before = await readFile(settingsPath, "utf8");
    handleProviderQuotaMessage(deps, "c1", { type: "anycode:provider-quota", quota: { usedPercent: "x" }, source: "s" });
    await new Promise((resolve) => setTimeout(resolve, INTERVAL * 3));
    expect(await readFile(settingsPath, "utf8")).toBe(before);
  });});

describe("withConnectionQuota — sparse merge, pinned connection only", () => {
  it("writes only the target connection; a sibling on the same host is untouched", () => {
    const settings = v2Settings({
      connections: [
        { id: "c1", providerId: "zai", baseUrl: "https://api.z.ai/api/anthropic", model: "glm-4.7" },
        { id: "c2", providerId: "zai", baseUrl: "https://api.z.ai/api/anthropic", lastHealth: { status: "ready", at: "t" } },
      ],
    });
    const updated = withConnectionQuota(settings, "c2", { usedPercent: 40 }, "x-ratelimit-requests-remaining", "now");
    expect(updated?.provider.connections[0]?.lastQuota).toBeUndefined();
    expect(updated?.provider.connections[0]?.model).toBe("glm-4.7");
    expect(updated?.provider.connections[1]?.lastQuota).toEqual({
      usedPercent: 40,
      observedAt: "now",
      source: "x-ratelimit-requests-remaining",
    });
    // Sibling fields survive verbatim on the written connection too.
    expect(updated?.provider.connections[1]?.lastHealth).toEqual({ status: "ready", at: "t" });
  });

  it("returns undefined for a connection that no longer exists (race-safe no-op)", () => {
    const settings = v2Settings({ connections: [{ id: "c1", providerId: "zai" }] });
    expect(withConnectionQuota(settings, "gone", { usedPercent: 1 }, "s", "now")).toBeUndefined();
  });

  it("same-source observations keep known absent fields; a different source starts clean", () => {
    const base = v2Settings({
      connections: [
        {
          id: "c1",
          providerId: "zai",
          lastQuota: { usedPercent: 80, resetsAt: 1_789_999_999, observedAt: "t0", source: "requests" },
        },
      ],
    });
    const sameFamily = withConnectionQuota(base, "c1", { usedPercent: 75 }, "requests", "t1");
    expect(sameFamily?.provider.connections[0]?.lastQuota).toEqual({
      usedPercent: 75,
      resetsAt: 1_789_999_999, // kept — the new observation did not carry one
      observedAt: "t1",
      source: "requests",
    });
    const otherFamily = withConnectionQuota(base, "c1", { usedPercent: 60 }, "tokens", "t1");
    expect(otherFamily?.provider.connections[0]?.lastQuota).toEqual({
      usedPercent: 60,
      observedAt: "t1",
      source: "tokens", // no inherited reset time from another header family
    });
  });
});

describe("recordConnectionQuota — 30-second throttle with trailing flush", () => {
  beforeEach(async () => {
    await writeSettingsFixture({ connections: [{ id: "c1", providerId: "zai" }] });
  });

  it("two events inside the window give ONE write; the trailing write carries the LATEST value", async () => {
    const first = await recordConnectionQuota(deps, "c1", { usedPercent: 80 }, "requests");
    expect(first).toBe(true);
    expect((await persistedLine())?.usedPercent).toBe(80);

    const second = await recordConnectionQuota(deps, "c1", { usedPercent: 25 }, "requests");
    expect(second).toBe(false); // throttled, coalesced
    expect((await persistedLine())?.usedPercent).toBe(80); // not yet flushed

    nowMs += INTERVAL; // window arithmetic reads the test clock…
    await until(async () => (await persistedLine())?.usedPercent === 25); // latest wins
    const line = (await persistedLine()) as Record<string, unknown>;
    expect(line.observedAt).toBe(new Date(nowMs).toISOString());
    // The flushed observation replaced (not stacked on) the first write.
    const connections = await readConnections();
    expect(connections.length).toBe(1);
  });

  it("an event after the window writes immediately (no timer needed)", async () => {
    await recordConnectionQuota(deps, "c1", { usedPercent: 80 }, "requests");
    nowMs += INTERVAL + 1;
    const again = await recordConnectionQuota(deps, "c1", { usedPercent: 30, resetsAt: 1_790_000_100 }, "requests");
    expect(again).toBe(true);
    expect(await persistedLine()).toEqual({
      usedPercent: 30,
      resetsAt: 1_790_000_100,
      observedAt: new Date(nowMs).toISOString(),
      source: "requests",
    });
  });

  it("a pending value flushes at most once per window even under many events", async () => {
    await recordConnectionQuota(deps, "c1", { usedPercent: 10 }, "requests");
    for (const usedPercent of [20, 30, 40]) {
      await recordConnectionQuota(deps, "c1", { usedPercent }, "requests");
    }
    nowMs += INTERVAL;
    await until(async () => (await persistedLine())?.usedPercent === 40);
    // One trailing flush per window: observedAt stops moving afterward.
    const observedAtAfterFlush = (await persistedLine())?.observedAt;
    await new Promise((resolve) => setTimeout(resolve, INTERVAL * 3));
    expect((await persistedLine())?.observedAt).toBe(observedAtAfterFlush);
  });

  it("read-only settings resolve false and never write", async () => {
    const raw = JSON.parse(await readFile(settingsPath, "utf8"));
    raw.version = 999; // newer-than-CURRENT ⇒ readOnly
    await writeFile(settingsPath, JSON.stringify(raw));
    expect(await recordConnectionQuota(deps, "c1", { usedPercent: 80 }, "requests")).toBe(false);
    expect((await readConnections())[0]?.lastQuota).toBeUndefined();
  });

  it("a connection that no longer exists means nothing happens", async () => {
    expect(await recordConnectionQuota(deps, "gone", { usedPercent: 80 }, "requests")).toBe(false);
    const connections = await readConnections();
    expect(connections.length).toBe(1);
    expect(connections[0]?.lastQuota).toBeUndefined();
  });

  it("onPersisted fires only for a real write (never for a throttled or refused one)", async () => {
    const onPersisted = vi.fn();
    await recordConnectionQuota(deps, "c1", { usedPercent: 80 }, "requests", onPersisted);
    expect(onPersisted).toHaveBeenCalledTimes(1);
    onPersisted.mockClear();
    await recordConnectionQuota(deps, "c1", { usedPercent: 20 }, "requests", onPersisted);
    expect(onPersisted).not.toHaveBeenCalled();
  });
});

describe("flushPendingConnectionQuota — the quit flush (Taskana 4090 follow-up)", () => {
  beforeEach(async () => {
    await writeSettingsFixture({ connections: [{ id: "c1", providerId: "zai" }] });
  });

  it("a pending trailing value is written on quit WITHOUT waiting out the window, latest wins", async () => {
    // First write lands; the second is coalesced as pending with a trailing
    // timer that (in production) would only fire after the 30 s window —
    // the exact value the quit flush exists to rescue.
    expect(await recordConnectionQuota(deps, "c1", { usedPercent: 80 }, "requests")).toBe(true);
    expect(await recordConnectionQuota(deps, "c1", { usedPercent: 25 }, "requests")).toBe(false);
    expect((await persistedLine())?.usedPercent).toBe(80); // still the flushed one

    // "Quit": the budget beats the window by orders of magnitude.
    const flushed = await flushPendingConnectionQuota(deps);
    expect(flushed).toBe(true);
    expect((await persistedLine())?.usedPercent).toBe(25);
    expect((await persistedLine())?.observedAt).toBe(new Date(nowMs).toISOString());

    // Idempotent: a second flush finds nothing pending and writes nothing.
    const again = await flushPendingConnectionQuota(deps);
    expect(again).toBe(false);
    expect((await persistedLine())?.usedPercent).toBe(25);
    // And the cancelled trailing timer never fires a late double-write.
    await new Promise((resolve) => setTimeout(resolve, INTERVAL * 3));
    expect((await persistedLine())?.usedPercent).toBe(25);
  });

  it("no pending value means the flush resolves immediately without touching the file", async () => {
    expect(await recordConnectionQuota(deps, "c1", { usedPercent: 80 }, "requests")).toBe(true);
    const before = await readFile(settingsPath, "utf8");
    expect(await flushPendingConnectionQuota(deps)).toBe(false);
    expect(await readFile(settingsPath, "utf8")).toBe(before);
  });

  it("the flush is BOUNDED: a write that exceeds the budget is abandoned, never blocks quit", async () => {
    expect(await recordConnectionQuota(deps, "c1", { usedPercent: 80 }, "requests")).toBe(true);
    expect(await recordConnectionQuota(deps, "c1", { usedPercent: 25 }, "requests")).toBe(false);

    // The settings-file lock is wedged by an outside writer that never
    // releases — the flush must give up within the (tiny, injected) budget.
    let releaseLock: () => void = () => {};
    const gate = withSettingsFileLock(settingsPath, () => new Promise<void>((resolve) => {
      releaseLock = resolve;
    }));
    try {
      const bounded = { ...deps, quitFlushBudgetMs: 15 };
      const startedAt = Date.now();
      expect(await flushPendingConnectionQuota(bounded)).toBe(false);
      expect(Date.now() - startedAt).toBeLessThan(1_000); // ~budget, not the wedged lock's forever
      // The abandoned pending value is not flushed WITHIN the budget; disk
      // keeps the first write at the moment the flush returned.
      expect((await persistedLine())?.usedPercent).toBe(80);
    } finally {
      releaseLock();
      await gate;
      // Let the abandoned write (still queued on the now-released lock) drain
      // BEFORE teardown: it is harmless to correctness (the flush already gave
      // up on it) but its file IO must not race this test's `rm` cleanup.
      await until(async () => (await persistedLine())?.usedPercent === 25);
    }
  });

  it("exports the production budget as ~200 ms (the brief's ceiling)", () => {
    expect(QUOTA_QUIT_FLUSH_BUDGET_MS).toBe(200);
  });
});

describe("corrupt stored lastQuota loads as absent (schema fail-soft)", () => {
  it("a string usedPercent reads back as undefined — the rest of the document survives", async () => {
    await writeSettingsFixture({
      activeConnectionId: "c1",
      connections: [{ id: "c1", providerId: "zai", lastQuota: { usedPercent: "80%", observedAt: "t", source: "x" } }],
    });
    const reloaded = await loadSettings(settingsPath);
    expect(reloaded.readOnly).toBe(false);
    expect(reloaded.settings.provider.connections[0]?.lastQuota).toBeUndefined();
    expect(reloaded.settings.provider.connections[0]?.id).toBe("c1");
  });
});
