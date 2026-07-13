/**
 * Codex onboarding Settings pane (TASK.41, design/slice-codex-fixes-cut.md
 * §2(g)/§5.5): the Settings-owned surface that replaces "know a hidden env
 * var and restart Electron" with a discoverable status machine — Not
 * installed / Update required / Sign in / Ready — and a transition out of
 * every one of them from the UI alone (recheck, choose a binary, sign in).
 *
 * DATA FLOW: `bridge` (injectable, defaults to `window.anycode.codex`, same
 * DI ethic as every other pane in this directory — see McpServersPane.tsx's
 * own doc comment) fetches a fresh `CodexOnboardingSnapshot` on mount
 * (`recheck`, TASK.41 DoD "fresh user sees ... and can pass every
 * transition") and after every mutating action (`pickBinary`/`loginStart`
 * both resolve a NEW snapshot on success, never requiring a second
 * round-trip — the settings-ipc precedent this whole codebase follows).
 *
 * CUSTODY (cut §2(g)): this component only ever renders `CodexDoctorReport`'s
 * `status`/`version`/`account.{type,plan}`/`error` fields — never an email,
 * never a token. `account.plan`/`account.type` are the ONLY account-shaped
 * data that ever reaches this file; there is structurally nothing else to
 * leak (mirrors `describeOAuthStatus` in SettingsScreen.tsx, which carries
 * the same custody invariant for the AnyCode-provider OAuth flow).
 */
import { useCallback, useEffect, useState } from "react";
import type { CodexDoctorReport } from "../../../shared/codex-doctor.js";
import { useTabsStore } from "../tabs-store.js";

/** Mirrors `SUPPORTED_CODEX_VERSION` in main/codex-doctor.ts (and, upstream, host/engines/codex/protocol.ts) — duplicated across the main/renderer boundary, same reasoning as every other channel/constant in this track that crosses `shared/**`'s post-C0 freeze. */
export const CODEX_SUPPORTED_RANGE = ">=0.144.0 <0.145.0";

/**
 * Duplicated structurally from main/codex-ipc.ts's own `CodexOnboardingSnapshot`/
 * `CodexPickBinaryResult`/`CodexLoginStartResult` (also re-duplicated in
 * preload/index.ts and renderer/src/anycode-window.d.ts) — `shared/**` froze
 * read-only after block C0, so these small wire shapes cross that boundary
 * as plain duplicated types, kept in sync by contract, not by import
 * (a `.d.ts`-with-`declare global` module does not re-export cleanly through
 * a normal `import type` here). `CodexDoctorReport` itself IS the frozen
 * `shared/**` type, imported (never edited) above.
 */
export interface CodexOnboardingSnapshot {
  report: CodexDoctorReport;
  binaryPath: string | null;
  source: "env" | "settings" | "path" | "common" | "picker" | "none";
  checkedAt: string;
}

export type CodexPickBinaryResult =
  | { ok: true; snapshot: CodexOnboardingSnapshot }
  | { ok: false; reason: "cancelled" | "invalid" };

export type CodexLoginStartResult =
  | { ok: true; snapshot: CodexOnboardingSnapshot }
  | { ok: false; reason: "busy" | "unsupported" | "cancelled" | "timeout" | "failed" };

/** Subset of `window.anycode.codex` this pane drives, injectable so tests never touch a real `window`. */
export interface CodexBridge {
  recheck(): Promise<CodexOnboardingSnapshot>;
  pickBinary(): Promise<CodexPickBinaryResult>;
  loginStart(): Promise<CodexLoginStartResult>;
  loginCancel(): Promise<void>;
}

// ── pure helpers (unit-tested directly — see CodexEnginePane.test.ts) ──

export type CodexStatusTone = "ok" | "warn" | "muted" | "error";

/**
 * Headline/detail/tone for the current snapshot — `null` means "no check has
 * returned yet" (the pane's own mount-time `recheck()` is still in flight),
 * distinct from every `CodexDoctorReport.status`, which always has a report
 * to describe.
 */
export function describeCodexStatus(snapshot: CodexOnboardingSnapshot | null): { headline: string; detail: string; tone: CodexStatusTone } {
  if (snapshot === null) {
    return { headline: "Checking…", detail: "Looking for a compatible Codex CLI.", tone: "muted" };
  }
  const { report } = snapshot;
  switch (report.status) {
    case "ready": {
      const account = report.account;
      const accountText = account ? ` — signed in (${account.type}${account.plan ? ` · ${account.plan}` : ""})` : "";
      return { headline: "Ready", detail: `Codex ${report.version ?? ""}${accountText}`.trim(), tone: "ok" };
    }
    case "signed_out":
      return { headline: "Sign in required", detail: `Codex ${report.version ?? ""} found but not signed in.`.trim(), tone: "warn" };
    case "update_required":
      return {
        headline: "Update required",
        detail: `Codex ${report.version ?? "(unknown version)"} is not supported — AnyCode needs ${CODEX_SUPPORTED_RANGE}. Upgrade or downgrade Codex, then Recheck.`,
        tone: "warn",
      };
    case "not_installed":
      return { headline: "Not installed", detail: "No Codex CLI was found on PATH or in common install locations.", tone: "muted" };
    case "error":
      return { headline: "Error", detail: report.error ?? "Codex could not be checked.", tone: "error" };
    default: {
      const exhaustive: never = report.status;
      return exhaustive;
    }
  }
}

export function formatBinarySourceLabel(source: CodexOnboardingSnapshot["source"]): string {
  switch (source) {
    case "env":
      return "ANYCODE_CODEX_BIN (dev override)";
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

/** Only a signed-out-but-otherwise-working CLI can start a sign-in — not_installed/update_required must be fixed first, and a check already in flight has no snapshot to act on either. */
export function canSignIn(snapshot: CodexOnboardingSnapshot | null): boolean {
  return snapshot?.report.status === "signed_out";
}

export function pickBinaryFailureMessage(reason: "cancelled" | "invalid"): string | null {
  return reason === "invalid" ? "That file isn't a valid, executable Codex binary." : null;
}

export function loginFailureMessage(reason: "busy" | "unsupported" | "cancelled" | "timeout" | "failed"): string | null {
  switch (reason) {
    case "busy":
      return "A Codex check is already in progress — try again in a moment.";
    case "unsupported":
      return "Codex isn't installed yet — install it or choose its binary first.";
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

// ── component ──

export interface CodexEnginePaneProps {
  /** Injectable for tests / isolation; defaults to the app's real `window.anycode.codex` bridge. */
  bridge?: CodexBridge;
}

export function CodexEnginePane({ bridge = window.anycode.codex }: CodexEnginePaneProps) {
  const [snapshot, setSnapshot] = useState<CodexOnboardingSnapshot | null>(null);
  const [checking, setChecking] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const runCheck = useCallback(async (): Promise<void> => {
    setChecking(true);
    try {
      const result = await bridge.recheck();
      setSnapshot(result);
    } finally {
      setChecking(false);
    }
  }, [bridge]);

  // Fresh-user DoD: a Settings visit alone must show the real status — no
  // manual "Recheck" click required to see an already-compatible, already
  // signed-in CLI.
  useEffect(() => {
    void runCheck();
  }, [runCheck]);

  // Re-check-without-restart, shell-wide (TASK.41 п.5): while this pane is
  // mounted, every `engines-changed` push (main fires one after ANY
  // onboarding step — recheck/pick/login, not only ones this pane itself
  // triggered) refreshes the shell-level tabs-store's `availableEngines` so
  // any other consumer of that store sees the same live truth main just
  // confirmed, without polling.
  useEffect(() => {
    return window.anycode.onEnginesChanged(() => {
      void window.anycode.listAvailableEngines().then(({ engineIds }) => {
        useTabsStore.getState().setAvailableEngines(engineIds);
      });
    });
  }, []);

  async function pick(): Promise<void> {
    setNotice(null);
    const result = await bridge.pickBinary();
    if (result.ok) {
      setSnapshot(result.snapshot);
    } else {
      setNotice(pickBinaryFailureMessage(result.reason));
    }
  }

  async function signIn(): Promise<void> {
    setNotice(null);
    setSigningIn(true);
    try {
      const result = await bridge.loginStart();
      if (result.ok) {
        setSnapshot(result.snapshot);
      } else {
        setNotice(loginFailureMessage(result.reason));
      }
    } finally {
      setSigningIn(false);
    }
  }

  function cancelSignIn(): void {
    void bridge.loginCancel();
  }

  const described = describeCodexStatus(snapshot);

  return (
    <section className="settings-section">
      <div className="settings-section-title">Codex</div>
      <div className="settings-field-row">
        <span className={`settings-secret-status settings-secret-status-${described.tone}`}>{described.headline}</span>
      </div>
      <p className="settings-page-description">{described.detail}</p>
      {snapshot?.binaryPath && (
        <p className="settings-page-description">
          <code>{snapshot.binaryPath}</code> ({formatBinarySourceLabel(snapshot.source)})
        </p>
      )}
      {notice && (
        <div className="settings-notice" role="alert">
          {notice}
        </div>
      )}
      <div className="settings-field-row">
        <button type="button" className="settings-button" disabled={checking || signingIn} onClick={() => void runCheck()}>
          {checking ? "Checking…" : "Recheck"}
        </button>
        <button type="button" className="settings-button" disabled={checking || signingIn} onClick={() => void pick()}>
          Choose binary…
        </button>
        {canSignIn(snapshot) && !signingIn && (
          <button type="button" className="settings-button settings-button-primary" onClick={() => void signIn()}>
            Sign in with ChatGPT
          </button>
        )}
      </div>
      {signingIn && (
        <div className="settings-field-row">
          <span className="settings-oauth-pending">Waiting for browser sign-in…</span>
          <button type="button" className="settings-button" onClick={cancelSignIn}>
            Cancel
          </button>
        </div>
      )}
      <p className="settings-page-description">
        Supported range: <code>{CODEX_SUPPORTED_RANGE}</code>. <code>ANYCODE_CODEX_BIN</code> remains a documented
        dev/diagnostic override with top priority over discovery — it is never saved to settings.
      </p>
    </section>
  );
}
