/**
 * Quota tests on the live `w0-15-usage.jsonl` capture (cut §1.4 DoD-7). The
 * central discriminator: the fixture's flat `seven_day` window reads 76% while
 * its governing `limits[]` entry reads 94%/critical — an implementation that
 * read the flat window would pass a weaker assert and under-report by 18 points.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLAUDE_RENDERABLE_WINDOWS,
  claudeQuotaToWire,
  decodeClaudeUsage,
  governingLimit,
  quotaNotice,
} from "./quota.js";

const FIXTURES_DIR = join(new URL(".", import.meta.url).pathname, "contract", "fixtures");

/** The live `get_usage` control response from the W0 capture. */
function liveUsageResponse(): Record<string, unknown> {
  const lines = readFileSync(join(FIXTURES_DIR, "w0-15-usage.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { raw: Record<string, unknown> });
  const usage = lines.find(
    (line) =>
      line.raw.type === "control_response" &&
      ((line.raw.response as { response?: { subscription_type?: unknown } }).response?.subscription_type) !== undefined,
  );
  if (usage === undefined) throw new Error("w0-15 fixture is missing the get_usage response");
  return (usage.raw.response as { response: Record<string, unknown> }).response;
}

describe("decodeClaudeUsage — live w0-15 payload", () => {
  it("decodes the subscription type and the allow-listed windows", () => {
    const snapshot = decodeClaudeUsage(liveUsageResponse())!;
    expect(snapshot.subscriptionType).toBe("max");
    expect(snapshot.windows.map((window) => window.key)).toEqual(["five_hour", "seven_day"]);
    expect(snapshot.windows.find((window) => window.key === "seven_day")!.utilization).toBe(76);
  });

  it("renders ONLY allow-listed windows — the eight code-named unreleased-feature windows never surface (rule 2)", () => {
    const response = liveUsageResponse();
    const rateLimits = response.rate_limits as Record<string, unknown>;
    // These really are present in the live payload (not hypothetical).
    for (const codename of ["tangelo", "iguana_necktie", "nimbus_quill", "cinder_cove", "amber_ladder", "omelette_promotional"]) {
      expect(rateLimits).toHaveProperty(codename);
    }
    const snapshot = decodeClaudeUsage(response)!;
    const rendered = snapshot.windows.map((window) => window.key);
    for (const key of rendered) expect(CLAUDE_RENDERABLE_WINDOWS).toContain(key);
    expect(JSON.stringify(snapshot)).not.toContain("tangelo");
    expect(JSON.stringify(snapshot)).not.toContain("nimbus_quill");
  });

  it("SEVERITY COMES FROM limits[], NOT the flat windows — the 18-point live divergence (rule 1)", () => {
    const snapshot = decodeClaudeUsage(liveUsageResponse())!;
    expect(snapshot.limits).toHaveLength(3);

    const governing = governingLimit(snapshot)!;
    // The governing limit is the active, model-scoped weekly one at 94%/critical...
    expect(governing).toMatchObject({ kind: "weekly_scoped", percent: 94, severity: "critical", isActive: true });
    expect(governing.scopeLabel).toBe("Fable");

    // ...while the FLAT seven_day window it would be confused with reads 76.
    const flatSevenDay = snapshot.windows.find((window) => window.key === "seven_day")!;
    expect(flatSevenDay.utilization).toBe(76);
    expect(governing.percent).not.toBe(flatSevenDay.utilization);
    expect(governing.percent - flatSevenDay.utilization).toBe(18);
  });

  it("a critical governing limit produces an engine_notice-worthy warning carrying the REAL percentage", () => {
    const notice = quotaNotice(decodeClaudeUsage(liveUsageResponse())!)!;
    expect(notice.level).toBe("warning");
    expect(notice.message).toContain("94%");
    expect(notice.message).toContain("Fable");
    // The under-reporting number must not be what the user is told.
    expect(notice.message).not.toContain("76%");
  });
});

describe("decodeClaudeUsage — tolerance (rule 3)", () => {
  it("tolerates the CC-B unauthenticated variant: no rate_limits block at all", () => {
    const snapshot = decodeClaudeUsage({ subscription_type: "unknown" });
    expect(snapshot).not.toBeNull();
    expect(snapshot!.windows).toEqual([]);
    expect(snapshot!.limits).toEqual([]);
    expect(quotaNotice(snapshot!)).toBeNull();
  });

  it("tolerates an entirely empty response and an unknown-shaped one", () => {
    expect(decodeClaudeUsage({})).not.toBeNull();
    expect(decodeClaudeUsage({ rate_limits: { limits: "not-an-array", five_hour: 42 } })).toMatchObject({
      windows: [],
      limits: [],
    });
  });

  it("returns null only for a structurally unusable payload", () => {
    expect(decodeClaudeUsage(null)).toBeNull();
    expect(decodeClaudeUsage("nope")).toBeNull();
  });

  it("ignores undecodable limit entries instead of failing the whole snapshot", () => {
    const snapshot = decodeClaudeUsage({
      rate_limits: { limits: [{ kind: "session" }, { percent: 10 }, { kind: "weekly_all", percent: 50, severity: "warning" }] },
    })!;
    expect(snapshot.limits).toHaveLength(1);
    expect(snapshot.limits[0]).toMatchObject({ kind: "weekly_all", percent: 50, severity: "warning" });
  });

  it("an unrecognized severity degrades to normal (never silently escalates)", () => {
    const snapshot = decodeClaudeUsage({ rate_limits: { limits: [{ kind: "session", percent: 10, severity: "apocalyptic" }] } })!;
    expect(snapshot.limits[0]!.severity).toBe("normal");
    expect(quotaNotice(snapshot)).toBeNull();
  });
});

describe("governingLimit — selection order", () => {
  const at = (kind: string, percent: number, severity: string, isActive: boolean) => ({ kind, percent, severity, is_active: isActive });

  it("prefers higher severity over higher percentage", () => {
    const snapshot = decodeClaudeUsage({
      rate_limits: { limits: [at("a", 99, "normal", true), at("b", 30, "critical", false)] },
    })!;
    expect(governingLimit(snapshot)!.kind).toBe("b");
  });

  it("prefers the active limit when severity ties", () => {
    const snapshot = decodeClaudeUsage({
      rate_limits: { limits: [at("a", 80, "warning", false), at("b", 70, "warning", true)] },
    })!;
    expect(governingLimit(snapshot)!.kind).toBe("b");
  });

  it("falls back to the higher percentage when severity and activity tie", () => {
    const snapshot = decodeClaudeUsage({
      rate_limits: { limits: [at("a", 60, "warning", true), at("b", 85, "warning", true)] },
    })!;
    expect(governingLimit(snapshot)!.kind).toBe("b");
  });

  it("a normal-only snapshot is silent (no per-turn noise)", () => {
    const snapshot = decodeClaudeUsage({ rate_limits: { limits: [at("session", 3, "normal", false)] } })!;
    expect(governingLimit(snapshot)!.severity).toBe("normal");
    expect(quotaNotice(snapshot)).toBeNull();
  });
});

/**
 * The quota has to actually REACH the renderer. `refreshQuota()` decoding
 * correctly is only half the path — before this projection existed the snapshot
 * stayed engine-private, so `host_ready` carried no quota while every decoder
 * test stayed green.
 */
describe("claudeQuotaToWire — the decoded snapshot on the shared quota wire", () => {
  it("reports the GOVERNING limit as primary, not the under-reporting flat window", () => {
    const snapshot = decodeClaudeUsage(liveUsageResponse())!;
    const wire = claudeQuotaToWire(snapshot)!;

    const governing = governingLimit(snapshot)!;
    expect(wire.primary!.usedPercent).toBe(governing.percent);
    // The whole point of rule 1: the flat seven_day window reads lower than the
    // active limit does, and showing the window would understate the exposure.
    const flat = snapshot.windows.find((window) => window.key === "seven_day");
    expect(flat!.utilization).toBeLessThan(wire.primary!.usedPercent);
  });

  it("carries the plan type and a named limit, and a second limit as secondary", () => {
    const wire = claudeQuotaToWire(decodeClaudeUsage(liveUsageResponse()))!;
    expect(wire.planType).toBeDefined();
    expect(wire.limitName).toBeDefined();
    expect(wire.secondary).not.toBeNull();
    expect(wire.observedAt).toEqual(expect.any(String));
  });

  it("is null for an absent snapshot, so an engine with no quota keeps the projection byte-identical", () => {
    expect(claudeQuotaToWire(null)).toBeNull();
  });

  it("tolerates the unauthenticated variant that carries no limits at all", () => {
    const wire = claudeQuotaToWire({ subscriptionType: "pro", windows: [], limits: [], observedAt: "2026-07-18T00:00:00.000Z" })!;
    expect(wire.primary).toBeNull();
    expect(wire.secondary).toBeNull();
    expect(wire.planType).toBe("pro");
  });
});
