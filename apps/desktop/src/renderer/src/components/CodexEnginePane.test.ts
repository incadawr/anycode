/**
 * Pure-logic tests for CodexEnginePane's exported helpers (TASK.41/TASK.50/53,
 * codex-profiles cut §4.2/§4.4/§6.2). Same `.test.ts`-only, no-jsdom rationale
 * as every other component test in this directory: this package's vitest
 * config runs `environment: "node"`, so the status-machine/quota/custody
 * derivation is exercised through the component's exported pure builders, not
 * a rendered DOM.
 */
import { describe, expect, it, vi } from "vitest";
import type { CodexDoctorReport } from "../../../shared/codex-doctor.js";
import type { CodexQuotaCredits, CodexRateLimits } from "../../../shared/codex-quota.js";
import type { CodexProfileRecord } from "../../../shared/settings.js";
import {
  canRepairLink,
  canSignIn,
  codexQuotaLines,
  deriveCodexQuotaWindowLabel,
  describeAccountEmailLine,
  describeCodexReportStatus,
  formatBinarySourceLabel,
  formatCodexQuotaCreditsLine,
  formatCodexQuotaReset,
  formatCodexQuotaWindowLine,
  hasMainAuthLinkProfile,
  loginFailureMessage,
  pickBinaryFailureMessage,
} from "./CodexEnginePane.js";

function profile(overrides: Partial<CodexProfileRecord> = {}): CodexProfileRecord {
  return { id: "personal", label: "Personal", createdAt: "2026-07-14T00:00:00.000Z", ...overrides };
}

// ── status-automaton (codex-profiles cut §4.2 — all 8 table rows) ──

describe("describeCodexReportStatus", () => {
  it("renders a checking placeholder when no report has arrived yet for this row", () => {
    expect(describeCodexReportStatus(undefined)).toEqual({ headline: "Checking…", detail: "Diagnosing this profile.", tone: "muted" });
  });

  it("row 1: binary not found -> not_installed, profile-independent", () => {
    const result = describeCodexReportStatus({ status: "not_installed" });
    expect(result).toEqual({ headline: "Not installed", detail: "No Codex CLI was found on PATH or in common install locations.", tone: "muted" });
  });

  it("row 2: binary/home trust rejected -> error carrying the diagnostic", () => {
    const result = describeCodexReportStatus({ status: "error", error: "codex home is world-writable" });
    expect(result.headline).toBe("Error");
    expect(result.detail).toBe("codex home is world-writable");
    expect(result.tone).toBe("error");
  });

  it("row 3: version outside the manifest range, no risk acceptance -> update_required, range from the report (never hardcoded)", () => {
    const result = describeCodexReportStatus({ status: "update_required", version: "0.99.0", supportedRange: ">=0.144.0 <0.145.0" });
    expect(result.tone).toBe("warn");
    expect(result.detail).toContain("0.99.0");
    expect(result.detail).toContain(">=0.144.0 <0.145.0");
    expect(result.detail).toMatch(/upgrade or downgrade/i);
  });

  it("row 4: RPC/spawn/timeout garbage -> error, same shape as row 2", () => {
    const result = describeCodexReportStatus({ status: "error", error: "codex doctor exceeded its watchdog" });
    expect(result.headline).toBe("Error");
    expect(result.detail).toBe("codex doctor exceeded its watchdog");
  });

  it("row 5: any non-null account variant -> Ready, with an account suffix", () => {
    expect(describeCodexReportStatus({ status: "ready", version: "0.144.3", account: { type: "chatgpt", email: null, plan: "plus" } }).detail).toBe(
      "Codex 0.144.3 — signed in (chatgpt · plus)",
    );
    expect(describeCodexReportStatus({ status: "ready", version: "0.144.3", account: { type: "apiKey" } }).detail).toBe("Codex 0.144.3 — signed in (apiKey)");
    expect(describeCodexReportStatus({ status: "ready", version: "0.144.3", account: { type: "amazonBedrock" } }).detail).toBe(
      "Codex 0.144.3 — signed in (amazonBedrock)",
    );
  });

  it("row 6: account null, requiresOpenaiAuth true -> signed_out", () => {
    const result = describeCodexReportStatus({ status: "signed_out", version: "0.144.3", requiresOpenaiAuth: true });
    expect(result).toEqual({ headline: "Sign in required", detail: "Codex 0.144.3 found but not signed in.", tone: "warn" });
  });

  it("row 7 (the NEW branch): account null, requiresOpenaiAuth FALSE -> Ready, WITHOUT fabricating a signed-in account suffix", () => {
    const result = describeCodexReportStatus({ status: "ready", version: "0.144.3", account: null, requiresOpenaiAuth: false });
    expect(result.headline).toBe("Ready");
    expect(result.tone).toBe("ok");
    expect(result.detail).toBe("Codex 0.144.3");
    expect(result.detail).not.toMatch(/signed in/);
  });

  it("row 8: account null, requiresOpenaiAuth absent -> signed_out (fail-closed)", () => {
    const result = describeCodexReportStatus({ status: "signed_out", version: "0.144.3" });
    expect(result.headline).toBe("Sign in required");
  });

  it("never renders an email in the primary headline/detail, even when the report carries one", () => {
    const result = describeCodexReportStatus({ status: "ready", version: "0.144.3", account: { type: "chatgpt", email: "sentinel-custody@example.com", plan: "plus" } });
    expect(result.detail).not.toMatch(/@/);
    expect(result.headline).not.toMatch(/@/);
  });
});

describe("formatBinarySourceLabel", () => {
  it("labels every discovery source, including the env dev-override and the picker rung", () => {
    expect(formatBinarySourceLabel("env")).toMatch(/dev override/);
    expect(formatBinarySourceLabel("settings")).toBe("saved path");
    expect(formatBinarySourceLabel("path")).toBe("found on PATH");
    expect(formatBinarySourceLabel("common")).toBe("found in a common install location");
    expect(formatBinarySourceLabel("picker")).toBe("chosen manually");
    expect(formatBinarySourceLabel("none")).toBe("not found");
  });
});

describe("canSignIn", () => {
  it("is true only for signed_out", () => {
    expect(canSignIn({ status: "signed_out", version: "0.144.3" })).toBe(true);
    expect(canSignIn({ status: "ready", version: "0.144.3", account: { type: "apiKey" } })).toBe(false);
    expect(canSignIn({ status: "not_installed" })).toBe(false);
    expect(canSignIn({ status: "update_required", version: "0.99.0" })).toBe(false);
    expect(canSignIn({ status: "error" })).toBe(false);
    expect(canSignIn(undefined)).toBe(false);
  });
});

// ── custody (cut §4.4 — the deliberate reversal: email RENDERS, but only as a secondary line, never fabricated in the primary status) ──

describe("describeAccountEmailLine", () => {
  it("surfaces a chatgpt account's email", () => {
    expect(describeAccountEmailLine({ status: "ready", account: { type: "chatgpt", email: "owner@example.com", plan: "plus" } })).toBe("owner@example.com");
  });

  it("hides the line for a chatgpt account with no email on the wire", () => {
    expect(describeAccountEmailLine({ status: "ready", account: { type: "chatgpt", email: null, plan: "plus" } })).toBeNull();
  });

  it("hides the line for apiKey/amazonBedrock/unknown-forward-compat accounts (none carry an email)", () => {
    expect(describeAccountEmailLine({ status: "ready", account: { type: "apiKey" } })).toBeNull();
    expect(describeAccountEmailLine({ status: "ready", account: { type: "amazonBedrock" } })).toBeNull();
    expect(describeAccountEmailLine({ status: "ready", account: { type: "somethingFuture" } })).toBeNull();
  });

  it("hides the line when there is no account or no report at all", () => {
    expect(describeAccountEmailLine({ status: "ready", account: null })).toBeNull();
    expect(describeAccountEmailLine({ status: "signed_out" })).toBeNull();
    expect(describeAccountEmailLine(undefined)).toBeNull();
  });
});

describe("sentinel-email custody PoC (cut §4.4): renders, but never leaks to console/log", () => {
  it("a sentinel email appears ONLY in the secondary email-line helper, never in status text, and never through console.*", () => {
    const consoleSpies = (["log", "warn", "error", "info", "debug"] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
    try {
      const report: CodexDoctorReport = { status: "ready", version: "0.144.3", account: { type: "chatgpt", email: "sentinel-custody@example.com", plan: "plus" } };

      // Rendered — this IS the intended behavior (cut §4.4: "e-mail показывается как ВТОРИЧНАЯ строка").
      expect(describeAccountEmailLine(report)).toBe("sentinel-custody@example.com");

      // Never fabricated into the primary status text.
      const status = describeCodexReportStatus(report);
      expect(JSON.stringify(status)).not.toContain("sentinel-custody@example.com");

      // Exercising every other pure export with the same sentinel-laden report
      // never routes it through console/log — this module owns no
      // disk/telemetry path at all, so console is the only surface it could
      // leak through.
      canSignIn(report);
      canRepairLink(profile({ authLink: "~/.codex/auth.json" }), report);
      codexQuotaLines(report.rateLimits);

      for (const spy of consoleSpies) {
        expect(spy).not.toHaveBeenCalled();
      }
    } finally {
      for (const spy of consoleSpies) spy.mockRestore();
    }
  });
});

// ── re-link credential gating (amended §A1.2) ──

describe("canRepairLink", () => {
  const linkedProfile = profile({ authLink: "~/.codex/auth.json" });
  const plainProfile = profile({ id: "no-link", label: "No link" });

  it("true only for an authLink profile whose error is the EXACT lstat-guard diagnosis", () => {
    const redirected: CodexDoctorReport = { status: "error", error: 'auth.json in the profile home points at an unexpected target (/tmp/x); use "Re-link credential" to repair it explicitly' };
    const detached: CodexDoctorReport = { status: "error", error: 'a detached copy of the credential appeared in the profile home (auth.json is a regular file, not the expected link); use "Re-link credential" to replace it explicitly' };
    expect(canRepairLink(linkedProfile, redirected)).toBe(true);
    expect(canRepairLink(linkedProfile, detached)).toBe(true);
  });

  it("false for an unrelated error on an authLink profile (a bad binary, a timeout) — never guessed from status alone", () => {
    expect(canRepairLink(linkedProfile, { status: "error", error: "codex doctor exceeded its watchdog" })).toBe(false);
  });

  it("false for a non-authLink profile, even with the exact phrase", () => {
    expect(canRepairLink(plainProfile, { status: "error", error: 'use "Re-link credential" to repair it explicitly' })).toBe(false);
  });

  it("false when the profile is fine (no error at all)", () => {
    expect(canRepairLink(linkedProfile, { status: "ready", version: "0.144.3", account: { type: "apiKey" } })).toBe(false);
    expect(canRepairLink(linkedProfile, undefined)).toBe(false);
  });
});

describe("hasMainAuthLinkProfile", () => {
  it("true only when a profile's authLink is the exact v1 sugar target", () => {
    expect(hasMainAuthLinkProfile([profile({ authLink: "~/.codex/auth.json" })])).toBe(true);
    expect(hasMainAuthLinkProfile([profile({ linkedHome: "/Users/x/.codex-accounts/personal" })])).toBe(false);
    expect(hasMainAuthLinkProfile([profile({})])).toBe(false);
    expect(hasMainAuthLinkProfile([])).toBe(false);
  });
});

describe("pickBinaryFailureMessage", () => {
  it("shows a message only for an invalid pick, silently accepts a cancelled dialog", () => {
    expect(pickBinaryFailureMessage("invalid")).toMatch(/valid, executable/);
    expect(pickBinaryFailureMessage("cancelled")).toBeNull();
  });
});

describe("loginFailureMessage", () => {
  it("maps every reason to an actionable message, cancelled is silent", () => {
    expect(loginFailureMessage("busy")).toMatch(/already in progress/);
    expect(loginFailureMessage("unsupported")).toMatch(/install/i);
    expect(loginFailureMessage("timeout")).toMatch(/timed out/i);
    expect(loginFailureMessage("failed")).toMatch(/failed/i);
    expect(loginFailureMessage("cancelled")).toBeNull();
  });
});

// ── quotas (cut §6.2 — labels derived from windowDurationMins, NEVER hardcoded; amended §A3 — resetsAt is epoch SECONDS, live form is single-window) ──

describe("deriveCodexQuotaWindowLabel", () => {
  it("maps every documented windowDurationMins to its label", () => {
    expect(deriveCodexQuotaWindowLabel({ usedPercent: 10, windowDurationMins: 60 })).toBe("1h");
    expect(deriveCodexQuotaWindowLabel({ usedPercent: 10, windowDurationMins: 300 })).toBe("5h");
    expect(deriveCodexQuotaWindowLabel({ usedPercent: 10, windowDurationMins: 1440 })).toBe("Daily");
    expect(deriveCodexQuotaWindowLabel({ usedPercent: 10, windowDurationMins: 10080 })).toBe("Weekly");
    expect(deriveCodexQuotaWindowLabel({ usedPercent: 10, windowDurationMins: 43200 })).toBe("Monthly");
  });

  it("rounds an undocumented duration to hours or whole days", () => {
    expect(deriveCodexQuotaWindowLabel({ usedPercent: 10, windowDurationMins: 120 })).toBe("2h");
    expect(deriveCodexQuotaWindowLabel({ usedPercent: 10, windowDurationMins: 2880 })).toBe("2d");
  });

  it("falls back to limitName, then the literal Limit, when the duration is null/absent — never hardcodes 5h/weekly", () => {
    expect(deriveCodexQuotaWindowLabel({ usedPercent: 10, windowDurationMins: null }, "Custom limit")).toBe("Custom limit");
    expect(deriveCodexQuotaWindowLabel({ usedPercent: 10 }, null)).toBe("Limit");
    expect(deriveCodexQuotaWindowLabel(undefined)).toBe("Limit");
  });
});

describe("formatCodexQuotaReset", () => {
  const now = new Date("2026-07-16T00:00:00.000Z");

  it("epoch SECONDS, not millis (amended §A3) — a live probe value 3d out resolves to 'in 3d', never 1970", () => {
    const threeDaysLater = Math.floor(now.getTime() / 1000) + 3 * 24 * 3600;
    expect(formatCodexQuotaReset(threeDaysLater, now)).toBe("resets in 3d");
  });

  it("scales the unit: minutes under an hour, hours under 2 days, days beyond that", () => {
    expect(formatCodexQuotaReset(Math.floor(now.getTime() / 1000) + 30 * 60, now)).toBe("resets in 30m");
    expect(formatCodexQuotaReset(Math.floor(now.getTime() / 1000) + 5 * 3600, now)).toBe("resets in 5h");
  });

  it("a past/now resetsAt reads 'resets now', never a negative duration", () => {
    expect(formatCodexQuotaReset(Math.floor(now.getTime() / 1000) - 60, now)).toBe("resets now");
  });

  it("null/absent resetsAt hides the line", () => {
    expect(formatCodexQuotaReset(null, now)).toBeNull();
    expect(formatCodexQuotaReset(undefined, now)).toBeNull();
  });
});

describe("formatCodexQuotaWindowLine", () => {
  const now = new Date("2026-07-16T00:00:00.000Z");

  it("null/absent window hides the line entirely — empty quota is NOT rendered as 0%", () => {
    expect(formatCodexQuotaWindowLine(null, null, now)).toBeNull();
    expect(formatCodexQuotaWindowLine(undefined, null, now)).toBeNull();
  });

  it("the live wire form (amended §A3.2: one populated window, real plus-account values)", () => {
    const resetsAt = Math.floor(now.getTime() / 1000) + 7 * 24 * 3600;
    expect(formatCodexQuotaWindowLine({ usedPercent: 8, windowDurationMins: 10080, resetsAt }, null, now)).toBe("Weekly · 92% left · resets in 7d");
  });
});

describe("formatCodexQuotaCreditsLine", () => {
  it("renders ONLY when hasCredits or unlimited — never for a plain zero-credits account", () => {
    expect(formatCodexQuotaCreditsLine({ hasCredits: true, unlimited: false, balance: "12" })).toBe("Credits: 12");
    expect(formatCodexQuotaCreditsLine({ hasCredits: false, unlimited: true })).toBe("Unlimited");
    expect(formatCodexQuotaCreditsLine({ hasCredits: false, unlimited: false })).toBeNull();
    expect(formatCodexQuotaCreditsLine(null)).toBeNull();
    expect(formatCodexQuotaCreditsLine(undefined)).toBeNull();
  });

  it("balance is a wire STRING, never coerced (live probe: \"0\")", () => {
    const credits: CodexQuotaCredits = { hasCredits: true, unlimited: false, balance: "0" };
    expect(formatCodexQuotaCreditsLine(credits)).toBe("Credits: 0");
  });
});

describe("codexQuotaLines", () => {
  const now = new Date("2026-07-16T00:00:00.000Z");

  it("no rateLimits at all -> hidden block (e.g. every non-ready status, which never fetches quotas)", () => {
    expect(codexQuotaLines(undefined, now)).toEqual([]);
  });

  it("the live wire shape (amended §A3.2): primary populated, secondary present-but-null, no hardcoded pair", () => {
    const rateLimits: CodexRateLimits = {
      primary: { usedPercent: 8, windowDurationMins: 10080, resetsAt: Math.floor(now.getTime() / 1000) + 3600 },
      secondary: null,
      credits: { hasCredits: false, unlimited: true },
      limitName: null,
      observedAt: now.toISOString(),
    };
    expect(codexQuotaLines(rateLimits, now)).toEqual(["Weekly · 92% left · resets in 1h", "Unlimited"]);
  });

  it("both windows absent and no credits -> empty (hidden), not a fabricated zero", () => {
    const rateLimits: CodexRateLimits = { observedAt: now.toISOString() };
    expect(codexQuotaLines(rateLimits, now)).toEqual([]);
  });
});
