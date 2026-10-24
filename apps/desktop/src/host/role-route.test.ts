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

describe("classifyInfraFailure (F3: anchored to the exact provider/resolver sentences)", () => {
  it("model resolver texts -> model_not_found", () => {
    expect(classifyInfraFailure("This model is not available on the selected connection. Use its exact model ID and choose a matching provider/connection, or retry without a model override.")).toBe("model_not_found");
    expect(classifyInfraFailure('Agent: role "executor" ran on the parent\'s model (explore default model "cheap-1" is not available on this connection; ran on the parent\'s model.)')).toBe("model_not_found");
    expect(classifyInfraFailure('Agent: model "glm-4.6" could not be resolved in this host: nope')).toBe("model_not_found");
  });

  it("redacted safe messages -> auth/quota/unreachable (failure.ts SAFE_MESSAGES, not raw bodies)", () => {
    expect(classifyInfraFailure("authentication failed (HTTP 401)")).toBe("auth");
    expect(classifyInfraFailure("forbidden (HTTP 403)")).toBe("auth");
    expect(classifyInfraFailure("Proxy authentication failed (407). Check the username and password in the connection proxy settings.")).toBe("auth");
    expect(classifyInfraFailure("rate limited (HTTP 429)")).toBe("quota");
    expect(classifyInfraFailure("quota exhausted")).toBe("quota");
    expect(classifyInfraFailure("rate limit reached after 3 retries")).toBe("quota");
    expect(classifyInfraFailure("network error")).toBe("unreachable");
    expect(classifyInfraFailure("connect timeout")).toBe("unreachable");
    expect(classifyInfraFailure("Proxy unavailable. Check the connection proxy address and that the proxy is running, then try again.")).toBe("unreachable");
    expect(classifyInfraFailure("TLS certificate is not trusted. For a corporate proxy, configure NODE_EXTRA_CA_CERTS with your trusted CA certificate and restart AnyCode.")).toBe("unreachable");
    expect(classifyInfraFailure("server error (HTTP 500)")).toBe("unreachable");
  });

  it("FREE MODEL TEXT never classifies: an executor's own report discussing auth/lines/imports/code is a task report, not infra", () => {
    // F3's false-positive class: a child that touched auth code, hit a TS
    // import error in its own work, or reported "line 403"/"unreachable
    // code"/an author field must NEVER respawn.
    expect(classifyInfraFailure("I refactored the authorize() function and fixed the OAuth token refresh; the author field was stale.")).toBe("none");
    expect(classifyInfraFailure("line 403 needs a nil check before the map access")).toBe("none");
    expect(classifyInfraFailure("Module \"../provider/failure\" could not be resolved by the test bundler; switched to a relative import.")).toBe("none");
    expect(classifyInfraFailure("The linter flags the unreachable code after the early return.")).toBe("none");
    expect(classifyInfraFailure("429 tests passed, 2 flaky (line 88 timing)")).toBe("none");
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
      "rate limited (HTTP 429)",
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
    const d = decideRoutedTerminal(facts(), "error", "network error", cache, T0);
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

  // F3 (cross-review): a cancelled or max_turns terminal NEVER respawns, no
  // matter what free text it carries — the user's Stop and the turn budget
  // are user-visible outcomes, and a second executor would re-edit the same
  // worktree after the user's decision.
  it("a CANCELLED terminal never respawns — even with an infra-looking error text", () => {
    const cache = new RoleHealthCache();
    const d = decideRoutedTerminal(
      facts([{ connection: "conn-main" }]),
      "cancelled",
      "rate limited (HTTP 429)",
      cache,
      T0,
    );
    expect(d).toEqual({ action: "deliver" });
    expect(cache.snapshot().size).toBe(0);
  });

  it("a MAX_TURNS terminal never respawns — even with an infra-looking error text", () => {
    const cache = new RoleHealthCache();
    const d = decideRoutedTerminal(
      facts([{ connection: "conn-main" }]),
      "max_turns",
      "authentication failed (HTTP 401)",
      cache,
      T0,
    );
    expect(d).toEqual({ action: "deliver" });
    expect(cache.snapshot().size).toBe(0);
  });

  // R2 (cross-review): classification runs over the SAFE ERROR DESCRIPTOR,
  // never the child's free model text — an error terminal whose descriptor
  // is a benign task failure but whose PROSE mentions infra-looking words
  // must deliver, and the converse (infra descriptor + benign prose) must
  // still respawn.
  it("R2: an infra-sounding FREE-TEXT tail after a benign descriptor NEVER respawns", () => {
    const cache = new RoleHealthCache();
    const d = decideRoutedTerminal(
      facts([{ connection: "conn-main" }]),
      "error",
      "task failed: the module could not be resolved\n\nAdditionally, while investigating I hit a network error and saw the endpoint was forbidden with rate_limit headers.",
      cache,
      T0,
      "task failed: the module could not be resolved",
    );
    expect(d).toEqual({ action: "deliver" });
    expect(cache.snapshot().size).toBe(0);
  });

  it("R2: an infra descriptor still respawns even when the free text is benign", () => {
    const cache = new RoleHealthCache();
    const d = decideRoutedTerminal(
      facts([{ connection: "conn-main", model: "glm-5.3" }]),
      "error",
      "rate limited (HTTP 429)\n\nI was halfway through the edit; the work is on disk.",
      cache,
      T0,
      "rate limited (HTTP 429)",
    );
    expect(d.action).toBe("respawn");
    if (d.action !== "respawn") return;
    expect(d.reason).toBe("quota");
    expect(cache.isUnhealthy(entryKey("executor", { engine: "codex" }), T0 + 1)).toBe(true);
  });

  it("R2: without a structured descriptor, only the FIRST LINE of finalText classifies", () => {
    const cache = new RoleHealthCache();
    // Infra word buried in the prose tail only — first line is a task failure.
    const d = decideRoutedTerminal(
      facts([{ connection: "conn-main" }]),
      "error",
      "task failed: assertion mismatch\n\nnetwork error while fetching docs",
      cache,
      T0,
    );
    expect(d).toEqual({ action: "deliver" });
    expect(cache.snapshot().size).toBe(0);
    // First line IS the safe descriptor shape — legacy single-line behavior
    // preserved.
    const d2 = decideRoutedTerminal(
      facts([{ connection: "conn-main" }]),
      "error",
      "server error (HTTP 500)\n\nchild report prose",
      cache,
      T0,
    );
    expect(d2.action).toBe("respawn");
  });
});
