/**
 * Host-side role-route resolution (Taskana 4704 §3.6): pure chain-picking,
 * the exponential cooldown ladder, the health cache, and infrastructure
 * failure classification. Everything here is clock-injected — no timers.
 */
import { describe, expect, it } from "vitest";
import {
  ROLE_COOLDOWN_BASE_MS,
  ROLE_COOLDOWN_MAX_MS,
  RoleHealthCache,
  classifyInfraFailure,
  cooldownUntil,
  decideRoutedTerminal,
  entryKey,
  pickEntry,
  type RoutedSpawnFacts,
} from "./role-route.js";

const T0 = 1_000_000;

describe("entryKey", () => {
  it("keys by role + routing target + model", () => {
    expect(entryKey("planner", { engine: "claude" })).toBe("planner|claude|");
    expect(entryKey("planner", { connection: "c1", model: "m1" })).toBe("planner|c1|m1");
    expect(entryKey("planner", { provider: "z-ai" })).toBe("planner|z-ai|");
    expect(entryKey("planner", {})).toBe("planner||");
  });
});

describe("pickEntry", () => {
  const health = new RoleHealthCache();

  it("returns the first entry when everything is healthy", () => {
    const r = pickEntry([{ engine: "claude" }, { engine: "codex" }], health.snapshot(), T0, "planner");
    expect(r).toEqual({ entry: { engine: "claude" }, index: 0, skipped: [] });
  });

  it("skips cooldown entries with their last reason and takes the next healthy one", () => {
    const cache = new RoleHealthCache();
    cache.markFailure(entryKey("executor", { engine: "codex" }), "quota: 429 after retries", T0);
    const r = pickEntry(
      [{ engine: "codex" }, { connection: "conn-main" }],
      cache.snapshot(),
      T0 + 1000,
      "executor",
    );
    expect(r?.index).toBe(1);
    expect(r?.entry).toEqual({ connection: "conn-main" });
    expect(r?.skipped).toEqual([
      { entry: { engine: "codex" }, reason: "quota: 429 after retries" },
    ]);
  });

  it("returns null when the whole chain is in cooldown", () => {
    const cache = new RoleHealthCache();
    cache.markFailure(entryKey("planner", { engine: "claude" }), "auth", T0);
    const r = pickEntry([{ engine: "claude" }], cache.snapshot(), T0 + 1000, "planner");
    expect(r).toBeNull();
  });

  it("an expired cooldown admits the entry again", () => {
    const cache = new RoleHealthCache();
    const h = cache.markFailure(entryKey("planner", { engine: "claude" }), "unreachable", T0);
    const r = pickEntry([{ engine: "claude" }], cache.snapshot(), h.until + 1, "planner");
    expect(r?.index).toBe(0);
    expect(r?.skipped).toEqual([]);
  });
});

describe("cooldownUntil (exponential ladder)", () => {
  it("5m -> 10m -> 20m -> 40m, capped at 60m", () => {
    expect(cooldownUntil(1, T0)).toBe(T0 + ROLE_COOLDOWN_BASE_MS);
    expect(cooldownUntil(2, T0)).toBe(T0 + 2 * ROLE_COOLDOWN_BASE_MS);
    expect(cooldownUntil(3, T0)).toBe(T0 + 4 * ROLE_COOLDOWN_BASE_MS);
    expect(cooldownUntil(4, T0)).toBe(T0 + 8 * ROLE_COOLDOWN_BASE_MS);
    expect(cooldownUntil(5, T0)).toBe(T0 + ROLE_COOLDOWN_MAX_MS);
    expect(cooldownUntil(50, T0)).toBe(T0 + ROLE_COOLDOWN_MAX_MS);
  });

  it("zero/negative failures mean no cooldown", () => {
    expect(cooldownUntil(0, T0)).toBe(0);
  });
});

describe("RoleHealthCache", () => {
  it("markFailure increments and markSuccess resets", () => {
    const cache = new RoleHealthCache();
    const key = entryKey("reviewer", { connection: "c" });
    cache.markFailure(key, "one", T0);
    expect(cache.isUnhealthy(key, T0 + 1)).toBe(true);
    expect(cache.lastReason(key)).toBe("one");
    cache.markSuccess(key);
    expect(cache.isUnhealthy(key, T0 + 1)).toBe(false);
    expect(cache.lastReason(key)).toBeUndefined();
  });

  it("snapshot reflects live state without mutation coupling", () => {
    const cache = new RoleHealthCache();
    const key = entryKey("reviewer", { connection: "c" });
    cache.markFailure(key, "boom", T0);
    const snap = cache.snapshot();
    cache.markSuccess(key);
    expect(snap.get(key)?.failures).toBe(1);
    expect(cache.snapshot().size).toBe(0);
  });
});

describe("classifyInfraFailure", () => {
  it("model resolver texts -> model_not_found", () => {
    expect(classifyInfraFailure('Agent: model "glm-4.6" could not be resolved in this host: nope')).toBe("model_not_found");
    expect(classifyInfraFailure("This model is not available on the selected connection.")).toBe("model_not_found");
  });

  it("401/403/auth -> auth", () => {
    expect(classifyInfraFailure("provider returned 401 unauthorized")).toBe("auth");
    expect(classifyInfraFailure("HTTP 403 Forbidden")).toBe("auth");
    expect(classifyInfraFailure("auth_invalid from broker")).toBe("auth");
  });

  it("429/quota/rate -> quota (the final error text after retries)", () => {
    expect(classifyInfraFailure("429 Too Many Requests after 3 retries")).toBe("quota");
    expect(classifyInfraFailure("quota exceeded on this key")).toBe("quota");
    expect(classifyInfraFailure("rate limit reached")).toBe("quota");
  });

  it("network/TLS texts -> unreachable", () => {
    expect(classifyInfraFailure("getaddrinfo ENOTFOUND api.example.com")).toBe("unreachable");
    expect(classifyInfraFailure("connect ECONNREFUSED 127.0.0.1:443")).toBe("unreachable");
    expect(classifyInfraFailure("socket hang up ECONNRESET")).toBe("unreachable");
    expect(classifyInfraFailure("ETIMEDOUT")).toBe("unreachable");
    expect(classifyInfraFailure("unable to verify the first certificate (TLS)")).toBe("unreachable");
    expect(classifyInfraFailure("host unreachable")).toBe("unreachable");
  });

  it("first-token stalls -> timeout_first_token", () => {
    expect(classifyInfraFailure("aborted before first token")).toBe("timeout_first_token");
    expect(classifyInfraFailure("stream stalled before any output")).toBe("timeout_first_token");
  });

  it("ordinary task failures NEVER classify (no fallback)", () => {
    expect(classifyInfraFailure("task failed: could not find the file")).toBe("none");
    expect(classifyInfraFailure("test assertion failed in runner.test.ts")).toBe("none");
    expect(classifyInfraFailure("the child reported DEFECTS and asked for changes")).toBe("none");
    expect(classifyInfraFailure("")).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// Taskana 4704 §3.6 (fallback point 2): the PURE detached-terminal respawn
// decision. Infra failures re-spawn on the next healthy entry; an exhausted
// chain delivers the original error (exhausted marker); completed children
// mark their entry healthy; ordinary task failures never fall back.

describe("decideRoutedTerminal (Taskana 4704 §3.6)", () => {
  const facts = (rest: Array<{ engine?: "codex" | "claude"; connection?: string; model?: string }> = []): RoutedSpawnFacts => ({
    role: "executor",
    entry: { engine: "codex" },
    rest,
    usedFallback: false,
  });

  it("an unrouted spawn always delivers", () => {
    const cache = new RoleHealthCache();
    expect(decideRoutedTerminal(undefined, "error", "429 quota exceeded", cache, T0)).toEqual({ action: "deliver" });
  });

  it("a completed terminal marks the entry healthy and delivers", () => {
    const cache = new RoleHealthCache();
    // Seed a prior failure so markSuccess has something to clear.
    cache.markFailure(entryKey("executor", { engine: "codex" }), "quota", T0);
    const d = decideRoutedTerminal(facts(), "completed", "done", cache, T0 + 1);
    expect(d).toEqual({ action: "deliver" });
    expect(cache.isUnhealthy(entryKey("executor", { engine: "codex" }), T0 + 2)).toBe(false);
  });

  it("an infra failure respawns on the next healthy entry with the short notice", () => {
    const cache = new RoleHealthCache();
    const d = decideRoutedTerminal(
      facts([{ connection: "conn-main", model: "glm-5.3" }]),
      "error",
      "429 Too Many Requests after retries",
      cache,
      T0,
    );
    expect(d.action).toBe("respawn");
    if (d.action !== "respawn") return;
    expect(d.entry).toEqual({ connection: "conn-main", model: "glm-5.3" });
    expect(d.notice).toContain('role executor retrying on conn-main / glm-5.3 after quota');
    expect(d.next.usedFallback).toBe(true);
    expect(d.next.skipReason).toBe("quota");
    // The failed entry is now in cooldown.
    expect(cache.isUnhealthy(entryKey("executor", { engine: "codex" }), T0 + 1)).toBe(true);
  });

  it("an exhausted chain delivers exhausted (the caller appends the failure line)", () => {
    const cache = new RoleHealthCache();
    const d = decideRoutedTerminal(facts(), "error", "ETIMEDOUT", cache, T0);
    expect(d).toMatchObject({ action: "deliver_exhausted", reason: "unreachable" });
  });

  it("an ordinary task failure NEVER falls back", () => {
    const cache = new RoleHealthCache();
    const d = decideRoutedTerminal(
      facts([{ connection: "conn-main" }]),
      "error",
      "test assertion failed in runner.test.ts",
      cache,
      T0,
    );
    expect(d).toEqual({ action: "deliver" });
    // No health mutation for a task failure.
    expect(cache.snapshot().size).toBe(0);
  });
});
