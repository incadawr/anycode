/**
 * Claude onboarding Settings pane (SLICE-CC A4, cut §1.2 mirror of
 * CodexEnginePane.tsx, deliberately much smaller): status of the bounded
 * claude-doctor probe, the discovered binary path, and — while
 * `signed_out` — the manual terminal onboarding text (CC-A does not
 * orchestrate a native login; cut §1.2 "НЕ делаем").
 *
 * CUSTODY: `ClaudeDoctorReport` never carries an account/email/subscription
 * fact (shared/claude-doctor.ts's own header) — there is nothing to redact
 * here because nothing crosses this bridge to redact.
 *
 * DATA FLOW: `bridge` (injectable, defaults to `window.anycode.claude`, same
 * DI ethic as every other pane in this directory) rechecks on mount and on
 * the shared `engines-changed` push every onboarding surface already
 * subscribes to.
 */
import { useCallback, useEffect, useState } from "react";
import type { ClaudeDoctorReport } from "../../../shared/claude-doctor.js";

/**
 * Duplicated structurally from main/claude-ipc.ts's own
 * `ClaudeOnboardingSnapshot`/`ClaudePickBinaryResult` (also re-duplicated in
 * preload/index.ts and renderer/src/anycode-window.d.ts) — `shared/**` froze
 * read-only after block C0, so these small wire shapes cross that boundary
 * as plain duplicated types, kept in sync by contract.
 */
export interface ClaudeOnboardingSnapshot {
  report: ClaudeDoctorReport;
  binaryPath: string | null;
  source: "env" | "settings" | "path" | "common" | "picker" | "none";
  checkedAt: string;
}

export type ClaudePickBinaryResult =
  | { ok: true; snapshot: ClaudeOnboardingSnapshot }
  | { ok: false; reason: "cancelled" | "invalid" };

// ── pure helpers (unit-tested directly — see ClaudeEnginePane.test.ts) ──

export type ClaudeStatusTone = "ok" | "warn" | "muted" | "error";

/** Headline/detail/tone for the doctor's single default-profile report. `undefined` means "no check has returned yet". */
export function describeClaudeReportStatus(report: ClaudeDoctorReport | undefined): { headline: string; detail: string; tone: ClaudeStatusTone } {
  if (report === undefined) {
    return { headline: "Checking…", detail: "Diagnosing the Claude Code CLI.", tone: "muted" };
  }
  switch (report.status) {
    case "ready":
      return { headline: "Ready", detail: `Claude Code ${report.version ?? ""}`.trim(), tone: "ok" };
    case "signed_out":
      return {
        headline: "Sign in required",
        detail: `Claude Code ${report.version ?? ""} found but not signed in to the AnyCode profile.`.trim(),
        tone: "warn",
      };
    case "update_required":
      return {
        headline: "Update required",
        detail: `Claude Code ${report.version ?? "(unknown version)"} is older than AnyCode's minimum supported version (2.1.212). Upgrade Claude Code, then Recheck.`,
        tone: "warn",
      };
    case "not_installed":
      return { headline: "Not installed", detail: "No Claude Code CLI was found on PATH or in common install locations.", tone: "muted" };
    case "error":
      return { headline: "Error", detail: report.error ?? "Claude Code could not be checked.", tone: "error" };
    default: {
      const exhaustive: never = report.status;
      return exhaustive;
    }
  }
}

export function formatClaudeBinarySourceLabel(source: ClaudeOnboardingSnapshot["source"]): string {
  switch (source) {
    case "env":
      return "ANYCODE_CLAUDE_BIN (dev override)";
    case "settings":
      return "saved path";
    case "path":
      return "found on PATH";
    case "common":
      return "found in a common install location";
    case "picker":
      return "chosen manually";
    case "none":
      return "not found";
    default: {
      const exhaustive: never = source;
      return exhaustive;
    }
  }
}

export function pickClaudeBinaryFailureMessage(reason: "cancelled" | "invalid"): string | null {
  return reason === "invalid" ? "That file isn't a valid, executable Claude Code binary." : null;
}

/** The exact terminal command the onboarding text prescribes (mirrors main/claude-binary.ts's `defaultClaudeProfileDir` — CC-A's single fixed AnyCode profile). */
export const CLAUDE_PROFILE_LOGIN_COMMAND = "CLAUDE_CONFIG_DIR=~/.anycode/claude/profile-default claude";

// ── component ──

/** Subset of `window.anycode.claude` this pane drives, injectable so tests never touch a real `window`. */
export interface ClaudeBridge {
  recheck(): Promise<ClaudeOnboardingSnapshot>;
  pickBinary(): Promise<ClaudePickBinaryResult>;
}

export interface ClaudeEnginePaneProps {
  /** Injectable for tests / isolation; defaults to the app's real `window.anycode.claude` bridge. */
  bridge?: ClaudeBridge;
}

export function ClaudeEnginePane({ bridge = window.anycode.claude }: ClaudeEnginePaneProps) {
  const [snapshot, setSnapshot] = useState<ClaudeOnboardingSnapshot | null>(null);
  const [checking, setChecking] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    setChecking(true);
    try {
      const result = await bridge.recheck();
      setSnapshot(result);
    } finally {
      setChecking(false);
    }
  }, [bridge]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Shell-wide re-check-without-restart: the same `engines-changed` push
  // every onboarding surface subscribes to (main pushes it after every
  // codex AND claude onboarding step).
  useEffect(() => {
    return window.anycode.onEnginesChanged(() => {
      void refresh();
    });
  }, [refresh]);

  async function pick(): Promise<void> {
    setNotice(null);
    setBusy(true);
    try {
      const result = await bridge.pickBinary();
      if (result.ok) {
        setSnapshot(result.snapshot);
      } else {
        setNotice(pickClaudeBinaryFailureMessage(result.reason));
      }
    } finally {
      setBusy(false);
    }
  }

  const status = describeClaudeReportStatus(checking ? undefined : snapshot?.report);

  return (
    <section className="settings-section">
      <div className="settings-section-title">Claude</div>
      <div className="settings-field-row">
        <span className={`settings-secret-status settings-secret-status-${status.tone}`}>{status.headline}</span>
      </div>
      <p className="settings-page-description">{status.detail}</p>
      {snapshot?.binaryPath && (
        <p className="settings-page-description">
          <code>{snapshot.binaryPath}</code> ({formatClaudeBinarySourceLabel(snapshot.source)})
        </p>
      )}
      {notice && (
        <div className="settings-notice" role="alert">
          {notice}
        </div>
      )}
      {snapshot?.report.status === "signed_out" && (
        <p className="settings-page-description">
          Sign in to AnyCode's dedicated Claude profile from a terminal, then Recheck:
          <br />
          <code>{CLAUDE_PROFILE_LOGIN_COMMAND}</code> → <code>/login</code>
        </p>
      )}
      <div className="settings-field-row">
        <button type="button" className="settings-button" disabled={busy || checking} onClick={() => void refresh()}>
          Recheck
        </button>
        <button type="button" className="settings-button" disabled={busy} onClick={() => void pick()}>
          Choose binary…
        </button>
      </div>
    </section>
  );
}
