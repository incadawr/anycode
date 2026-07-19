/**
 * Claude onboarding Settings pane (SLICE-CC A4, cut §1.2 mirror of
 * CodexEnginePane.tsx, deliberately much smaller): status of the bounded
 * claude-doctor probe, the discovered binary path, the SLICE-CC-LOGIN
 * (TASK.66, cut §3) native "Use my Claude subscription" flow, and — while
 * `signed_out` — the manual terminal onboarding text as a fallback.
 *
 * CUSTODY: `ClaudeDoctorReport` never carries an account/email/subscription
 * fact (shared/claude-doctor.ts's own header) — there is nothing to redact
 * here because nothing crosses this bridge to redact. `ClaudeLoginStartResult`
 * carries the same credential-free `ClaudeOnboardingSnapshot` on success and
 * only a closed reason enum on failure — no token ever reaches this pane.
 *
 * DATA FLOW: `bridge` (injectable, defaults to `window.anycode.claude`, same
 * DI ethic as every other pane in this directory) rechecks once on mount,
 * then applies every subsequent snapshot straight from the dedicated
 * `onSnapshotChanged` push (doctor-spawn-loop fix) — it deliberately does NOT
 * react to the shared `engines-changed` push: answering that push with a
 * fresh recheck is what caused an infinite doctor-spawn loop (each recheck's
 * own `onSnapshot` fired another `engines-changed` push, which triggered
 * another recheck, forever).
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

// SLICE-CC-LOGIN (TASK.66, cut §4): duplicated from main/claude-ipc.ts's own
// `ClaudeLoginStartResult` (same "shared/** froze read-only" reasoning as
// every shape above).
export type ClaudeLoginStartResult =
  | { ok: true; snapshot: ClaudeOnboardingSnapshot }
  | { ok: false; reason: "busy" | "unsupported" | "cancelled" | "timeout" | "failed" };

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

/** The exact terminal command the onboarding text prescribes — ambient by default (owner pivot): no `CLAUDE_CONFIG_DIR`, so it signs into the SAME `~/.claude` the doctor diagnoses. */
export const CLAUDE_PROFILE_LOGIN_COMMAND = "claude auth login";

// SLICE-CC-LOGIN (TASK.66, cut §3): the "Use my Claude subscription" flow.

/** Cut §3's exact in-progress copy — a real terminal window opened, not ours to poll manually. */
export const CLAUDE_LOGIN_IN_PROGRESS_COPY = "A Terminal window has opened — complete sign-in there (your browser will open). Waiting…";

/** The sign-in button is only ever offered while the report is exactly `signed_out` — every other status is either already fine or needs a different fix first (cut §3). */
export function canShowSignInButton(report: ClaudeDoctorReport | undefined): boolean {
  return report?.status === "signed_out";
}

/**
 * UX un-lock: the sign-in button is disabled — never left clickable to
 * produce the busy-failure banner — while a recheck, a binary pick, or a
 * login attempt already occupies the exclusive main-process slot.
 */
export function signInButtonDisabled(checking: boolean, busy: boolean, signingIn: boolean): boolean {
  return checking || busy || signingIn;
}

// TASK.76 (owner directive 2026-07-19): an honest, non-blocking informational
// note — this is Claude Code's own OAuth login and quota, spawned as-is, not
// a separate AnyCode account or a separate usage pool, and using a
// subscription through a third-party UI sits in a gray area of Anthropic's
// terms even though no enforcement precedent against as-is CLI wrappers is
// known (see TASK.76.md's verdict for the source citations).
export const CLAUDE_SUBSCRIPTION_RISK_NOTE =
  "AnyCode spawns the official Claude Code CLI as-is and signs in with your own Claude Code login — we never read or store your tokens. " +
  "This usage shares the same subscription quota as claude.ai and the terminal, not a separate pool. " +
  "Anthropic steers third-party tools toward API keys, so using a subscription here is a gray area of their terms; enforcement without notice is possible, though no action against as-is CLI wrappers is known.";

/** Ready-state echo of {@link CLAUDE_SUBSCRIPTION_RISK_NOTE} — the disclosure doesn't vanish once sign-in succeeds, just compresses to one line. */
export const CLAUDE_READY_QUOTA_TRACE = "Official Claude Code CLI, used as-is — usage draws from your shared Claude subscription quota.";

/** The compact Ready-state trace is shown only once the doctor reports `ready` — the fuller note lives alongside the sign-in button above, in the `signed_out` state. */
export function canShowReadyTrace(report: ClaudeDoctorReport | undefined): boolean {
  return report?.status === "ready";
}

/**
 * Cut §3's per-outcome notice: `cancelled` stays silent (the terminal window
 * is not ours to close, so there is nothing actionable to say — the pane just
 * falls back to `idle`); `busy`/`unsupported` both point at the manual
 * fallback command still visible on screen.
 */
export function loginFailureMessage(reason: "busy" | "unsupported" | "cancelled" | "timeout" | "failed"): string | null {
  switch (reason) {
    case "busy":
      return "A Claude check is already in progress — try again in a moment.";
    case "unsupported":
      return `Native sign-in isn't available here — sign in manually instead: ${CLAUDE_PROFILE_LOGIN_COMMAND}`;
    case "cancelled":
      return null;
    case "timeout":
      return "Sign-in timed out. Try again.";
    case "failed":
      return "Sign-in failed. Try again.";
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

export interface ClaudeSignInCallbacks {
  onStart: () => void;
  onSuccess: (snapshot: ClaudeOnboardingSnapshot) => void;
  onFailure: (message: string | null) => void;
  onSettle: () => void;
}

/**
 * The sign-in sequence extracted as a pure async helper (mirrors
 * CodexEnginePane.tsx's `diagnoseProfilesSequentially` precedent — this
 * codebase's component tests run in a jsdom-less `node` environment, so
 * interactive logic is unit-tested through an injected-callback helper like
 * this one, never a rendered DOM). Success hands the caller the fresh
 * snapshot directly — the pane applies it with no separate manual Recheck
 * (cut §3: "статус сам флипается в Ready").
 */
export async function runClaudeSignIn(bridge: Pick<ClaudeBridge, "loginStart">, callbacks: ClaudeSignInCallbacks): Promise<void> {
  callbacks.onStart();
  try {
    const result = await bridge.loginStart();
    if (result.ok) {
      callbacks.onSuccess(result.snapshot);
    } else {
      callbacks.onFailure(loginFailureMessage(result.reason));
    }
  } finally {
    callbacks.onSettle();
  }
}

/** Cancel forwards to the bridge and nothing else (cut §3: the terminal window itself is not ours to close) — extracted so the one meaningful line of the click handler is unit-tested without a DOM. */
export function cancelClaudeSignIn(bridge: Pick<ClaudeBridge, "loginCancel">): void {
  void bridge.loginCancel();
}

/**
 * Doctor-spawn-loop fix: forwards each fresh snapshot straight into state —
 * zero IPC round-trip, zero doctor spawn. Replaces the old `engines-changed`-
 * triggered recheck, whose own `onSnapshot` fired another `engines-changed`
 * push that triggered another recheck, forever. Extracted so the one
 * meaningful line of the subscription is unit-tested without a DOM (mirrors
 * `cancelClaudeSignIn` above).
 */
export function subscribeToClaudeSnapshotPush(
  bridge: Pick<ClaudeBridge, "onSnapshotChanged">,
  setSnapshot: (snapshot: ClaudeOnboardingSnapshot) => void,
): () => void {
  return bridge.onSnapshotChanged(setSnapshot);
}

// ── component ──

/** Subset of `window.anycode.claude` this pane drives, injectable so tests never touch a real `window`. */
export interface ClaudeBridge {
  recheck(): Promise<ClaudeOnboardingSnapshot>;
  pickBinary(): Promise<ClaudePickBinaryResult>;
  loginStart(): Promise<ClaudeLoginStartResult>;
  loginCancel(): Promise<void>;
  /** Doctor-spawn-loop fix: pushes a fresh snapshot after every recheck/pick/login step. */
  onSnapshotChanged(callback: (snapshot: ClaudeOnboardingSnapshot) => void): () => void;
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
  const [signingIn, setSigningIn] = useState(false);

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

  // Doctor-spawn-loop fix: apply every subsequent snapshot straight from the
  // dedicated push — deliberately NOT the shared `engines-changed` push (see
  // file header).
  useEffect(() => {
    return subscribeToClaudeSnapshotPush(bridge, setSnapshot);
  }, [bridge]);

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

  async function signIn(): Promise<void> {
    setNotice(null);
    await runClaudeSignIn(bridge, {
      onStart: () => setSigningIn(true),
      onSuccess: (fresh) => setSnapshot(fresh),
      onFailure: (message) => setNotice(message),
      onSettle: () => setSigningIn(false),
    });
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
      {canShowSignInButton(checking ? undefined : snapshot?.report) && (
        <>
          <div className="settings-field-row">
            {signingIn ? (
              <>
                <span className="settings-oauth-pending">{CLAUDE_LOGIN_IN_PROGRESS_COPY}</span>
                <button type="button" className="settings-button" onClick={() => cancelClaudeSignIn(bridge)}>
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                className="settings-button settings-button-primary"
                disabled={signInButtonDisabled(checking, busy, signingIn)}
                onClick={() => void signIn()}
              >
                Use my Claude subscription
              </button>
            )}
          </div>
          <p className="settings-page-description">
            …or sign in manually:
            <br />
            <code>{CLAUDE_PROFILE_LOGIN_COMMAND}</code>
          </p>
          <p className="settings-page-description">{CLAUDE_SUBSCRIPTION_RISK_NOTE}</p>
        </>
      )}
      {canShowReadyTrace(checking ? undefined : snapshot?.report) && <p className="settings-page-description">{CLAUDE_READY_QUOTA_TRACE}</p>}
      <div className="settings-field-row">
        <button type="button" className="settings-button" disabled={busy || checking || signingIn} onClick={() => void refresh()}>
          Recheck
        </button>
        <button type="button" className="settings-button" disabled={busy || signingIn} onClick={() => void pick()}>
          Choose binary…
        </button>
      </div>
    </section>
  );
}
