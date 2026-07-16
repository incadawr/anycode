/**
 * Pure-logic tests for CodexEnginePane's exported helpers (TASK.41, design
 * slice-codex-fixes-cut.md §5.5). Same `.test.ts`-only, no-jsdom rationale as
 * every other component test in this directory (SettingsScreen.test.ts's own
 * docstring): this package's vitest config runs `environment: "node"" — the
 * component's status-machine derivation is exercised through its exported
 * pure builders, not a rendered DOM.
 */
import { describe, expect, it } from "vitest";
import {
  canSignIn,
  describeCodexStatus,
  formatBinarySourceLabel,
  loginFailureMessage,
  pickBinaryFailureMessage,
  type CodexOnboardingSnapshot,
} from "./CodexEnginePane.js";

function snapshotWith(report: CodexOnboardingSnapshot["report"], overrides: Partial<CodexOnboardingSnapshot> = {}): CodexOnboardingSnapshot {
  return { report, binaryPath: "/usr/local/bin/codex", source: "path", checkedAt: "2026-07-13T00:00:00.000Z", ...overrides };
}

describe("describeCodexStatus", () => {
  it("renders a checking placeholder when no snapshot has arrived yet", () => {
    expect(describeCodexStatus(null)).toEqual({ headline: "Checking…", detail: "Looking for a compatible Codex CLI.", tone: "muted" });
  });

  it("renders Ready with account type+plan, never an email", () => {
    const result = describeCodexStatus(snapshotWith({ status: "ready", version: "0.144.3", account: { type: "chatgpt", plan: "plus" }, models: [] }));
    expect(result.tone).toBe("ok");
    expect(result.headline).toBe("Ready");
    expect(result.detail).toBe("Codex 0.144.3 — signed in (chatgpt · plus)");
    expect(result.detail).not.toMatch(/@/); // no email ever rendered
  });

  it("renders Ready gracefully when account is present but plan is empty", () => {
    const result = describeCodexStatus(snapshotWith({ status: "ready", version: "0.144.3", account: { type: "apiKey" }, models: [] }));
    expect(result.detail).toBe("Codex 0.144.3 — signed in (apiKey)");
  });

  it("renders Sign in required for signed_out", () => {
    const result = describeCodexStatus(snapshotWith({ status: "signed_out", version: "0.144.3" }));
    expect(result).toEqual({ headline: "Sign in required", detail: "Codex 0.144.3 found but not signed in.", tone: "warn" });
  });

  it("renders an actionable update_required message with the supported range", () => {
    const result = describeCodexStatus(snapshotWith({ status: "update_required", version: "0.99.0" }));
    expect(result.tone).toBe("warn");
    expect(result.detail).toContain("0.99.0");
    expect(result.detail).toContain(">=0.144.0 <0.145.0");
    expect(result.detail).toMatch(/upgrade or downgrade/i);
  });

  it("renders not_installed with a discovery hint, no version to show", () => {
    const result = describeCodexStatus(snapshotWith({ status: "not_installed" }, { binaryPath: null, source: "none" }));
    expect(result).toEqual({ headline: "Not installed", detail: "No Codex CLI was found on PATH or in common install locations.", tone: "muted" });
  });

  it("renders the doctor's own diagnostic message for status:error, falling back to a generic one", () => {
    expect(describeCodexStatus(snapshotWith({ status: "error", error: "spawn EACCES" })).detail).toBe("spawn EACCES");
    expect(describeCodexStatus(snapshotWith({ status: "error" })).detail).toBe("Codex could not be checked.");
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
    expect(canSignIn(snapshotWith({ status: "signed_out", version: "0.144.3" }))).toBe(true);
    expect(canSignIn(snapshotWith({ status: "ready", version: "0.144.3", account: { type: "chatgpt", plan: "plus" }, models: [] }))).toBe(false);
    expect(canSignIn(snapshotWith({ status: "not_installed" }))).toBe(false);
    expect(canSignIn(snapshotWith({ status: "update_required", version: "0.99.0" }))).toBe(false);
    expect(canSignIn(snapshotWith({ status: "error" }))).toBe(false);
    expect(canSignIn(null)).toBe(false);
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
