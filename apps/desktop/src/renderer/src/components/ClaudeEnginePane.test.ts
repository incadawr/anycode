/**
 * Pure-logic tests for ClaudeEnginePane's exported helpers (SLICE-CC A4).
 * Same `.test.ts`-only, no-jsdom rationale as CodexEnginePane.test.ts: this
 * package's vitest config runs `environment: "node"`.
 */
import { describe, expect, it } from "vitest";
import type { ClaudeDoctorReport } from "../../../shared/claude-doctor.js";
import {
  CLAUDE_PROFILE_LOGIN_COMMAND,
  describeClaudeReportStatus,
  formatClaudeBinarySourceLabel,
  pickClaudeBinaryFailureMessage,
  type ClaudeOnboardingSnapshot,
} from "./ClaudeEnginePane.js";

describe("describeClaudeReportStatus", () => {
  it("renders a checking placeholder when no report has arrived yet", () => {
    expect(describeClaudeReportStatus(undefined)).toEqual({ headline: "Checking…", detail: "Diagnosing the Claude Code CLI.", tone: "muted" });
  });

  it("ready", () => {
    const report: ClaudeDoctorReport = { status: "ready", version: "2.1.212" };
    expect(describeClaudeReportStatus(report)).toEqual({ headline: "Ready", detail: "Claude Code 2.1.212", tone: "ok" });
  });

  it("signed_out never leaks any account fact — it isn't on the type at all", () => {
    const report: ClaudeDoctorReport = { status: "signed_out", version: "2.1.212" };
    const result = describeClaudeReportStatus(report);
    expect(result.tone).toBe("warn");
    expect(result.detail).toContain("not signed in");
    expect(JSON.stringify(result)).not.toMatch(/@|subscription|email/i);
  });

  it("update_required names the 2.1.212 floor explicitly", () => {
    const report: ClaudeDoctorReport = { status: "update_required", version: "2.0.9" };
    expect(describeClaudeReportStatus(report).detail).toContain("2.1.212");
  });

  it("not_installed", () => {
    expect(describeClaudeReportStatus({ status: "not_installed" }).tone).toBe("muted");
  });

  it("error surfaces the diagnostic string", () => {
    expect(describeClaudeReportStatus({ status: "error", error: "boom" }).detail).toBe("boom");
  });
});

describe("formatClaudeBinarySourceLabel", () => {
  const cases: Array<[ClaudeOnboardingSnapshot["source"], string]> = [
    ["env", "ANYCODE_CLAUDE_BIN (dev override)"],
    ["settings", "saved path"],
    ["path", "found on PATH"],
    ["common", "found in a common install location"],
    ["picker", "chosen manually"],
    ["none", "not found"],
  ];
  it.each(cases)("%s -> %s", (source, label) => {
    expect(formatClaudeBinarySourceLabel(source)).toBe(label);
  });
});

describe("pickClaudeBinaryFailureMessage", () => {
  it("invalid has a message, cancelled is silent", () => {
    expect(pickClaudeBinaryFailureMessage("invalid")).toMatch(/executable Claude Code binary/);
    expect(pickClaudeBinaryFailureMessage("cancelled")).toBeNull();
  });
});

describe("CLAUDE_PROFILE_LOGIN_COMMAND", () => {
  it("names the exact AnyCode default profile dir", () => {
    expect(CLAUDE_PROFILE_LOGIN_COMMAND).toBe("CLAUDE_CONFIG_DIR=~/.anycode/claude/profile-default claude");
  });
});
