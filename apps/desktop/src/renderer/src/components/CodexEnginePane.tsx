/**
 * Codex onboarding Settings pane (TASK.41, design/slice-codex-fixes-cut.md
 * §2(g)/§5.5; redesigned for TASK.50/53, codex-profiles cut §2/§4/§5/§7,
 * amended §A1/§A4): the Settings-owned surface for the Codex engine.
 *
 * Readiness is now a function of (binary, profile) rather than one global
 * boolean (cut §2.1) — the binary/manifest block below is profile-
 * INDEPENDENT (not_installed/update_required), while the accounts list shows
 * one status-automaton verdict PER PROFILE (signed_out/ready/error), always
 * including the `system` pseudo-profile (cut §2.2: no `CODEX_HOME` override,
 * byte-identical to pre-profile behavior). Every profile is diagnosed
 * SEQUENTIALLY (cut §4.3: "не N параллельных app-server'ов"), never in
 * parallel.
 *
 * DATA FLOW: `bridge` (injectable, defaults to `window.anycode.codex`, same
 * DI ethic as every other pane in this directory) lists the profile registry
 * and re-diagnoses every row on mount, after any mutating action, and via the
 * explicit "Recheck all" button.
 *
 * CUSTODY (cut §4.4 — the deliberate reversal of the pre-profile invariant):
 * `account.email` is now READ and RENDERED (the owner wants to see which
 * ChatGPT account a profile is), but ONLY as a secondary line next to the
 * profile's own editable `label` — never the primary identifier, and it
 * never leaves this render tree for a log, a telemetry event, or disk (those
 * paths simply do not exist in this module — see CodexEnginePane.test.ts's
 * sentinel-leak PoC).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { CodexDoctorReport } from "../../../shared/codex-doctor.js";
import type { CodexQuotaCredits, CodexQuotaWindow, CodexRateLimits } from "../../../shared/codex-quota.js";
import { CODEX_MIN_FLOOR } from "../../../shared/codex-support.js";
import type { CodexProfileRecord } from "../../../shared/settings.js";
import { useTabsStore } from "../tabs-store.js";
import { CodexRolloutImportDialog } from "./CodexRolloutImportDialog.js";

/**
 * Duplicated structurally from main/codex-ipc.ts's own `CodexOnboardingSnapshot`/
 * `CodexPickBinaryResult`/`CodexLoginStartResult`/`CodexProfilesSnapshot`
 * (also re-duplicated in preload/index.ts and renderer/src/anycode-window.d.ts)
 * — `shared/**` froze read-only after block C0, so these small wire shapes
 * cross that boundary as plain duplicated types, kept in sync by contract.
 * `CodexDoctorReport`/`CodexProfileRecord` themselves ARE frozen `shared/**`
 * types, imported (never edited) above.
 */
export interface CodexOnboardingSnapshot {
  report: CodexDoctorReport;
  binaryPath: string | null;
  source: "env" | "settings" | "path" | "common" | "installed" | "picker" | "none";
  checkedAt: string;
}

export type CodexPickBinaryResult =
  | { ok: true; snapshot: CodexOnboardingSnapshot }
  | { ok: false; reason: "cancelled" | "invalid" };

export type CodexLoginStartResult =
  | { ok: true; snapshot: CodexOnboardingSnapshot }
  | { ok: false; reason: "busy" | "unsupported" | "cancelled" | "timeout" | "failed" };

export interface CodexProfilesSnapshot {
  profiles: Array<{ profile: CodexProfileRecord; report?: CodexDoctorReport }>;
  activeProfileId: string;
}

export interface CodexProfileCreateRequest {
  label: string;
  authLink?: string;
  linkedHome?: string;
}

export type CodexProfileCreateResult =
  | { ok: true; profile: CodexProfileRecord }
  | { ok: false; reason: "invalid" | "limit" | "failed"; message?: string };

export type CodexProfileGuardResult = { ok: true } | { ok: false; reason: string };

export type CodexInstallResult =
  | { ok: true; version: string; binaryPath: string; report: CodexDoctorReport }
  | { ok: false; error: string };

export interface CodexSupportStatusResult {
  supportedRange: string;
  recommended: string;
  riskAcceptedVersions: string[];
}

export interface CodexManifestRefreshResult {
  source: "network" | "cache" | "bundled";
  supportedRange: string;
}

// ── constants duplicated across the main/renderer boundary (main/codex-profiles.ts is the source of truth; see this file's own header for the "duplicated on purpose" convention) ──

/** Mirrors `SYSTEM_PROFILE_ID` (main/codex-profiles.ts) — the pseudo-profile row that always exists and is never deletable (cut §2.2). */
const SYSTEM_PROFILE_ID = "system";
/** Mirrors `MAX_CODEX_PROFILES` (main/codex-profiles.ts, cut §4.3) — disables the create actions client-side before the round trip fails. */
const MAX_CODEX_PROFILES = 8;
/** The exact `authLink` target the "Use current account" sugar button writes (amended §A1.1 п.2) — v1 never writes any other literal here. */
const MAIN_AUTH_LINK_TARGET = "~/.codex/auth.json";
/** The exact phrase `assertAuthLink` (main/codex-profiles.ts, amended §A1.2) puts in BOTH of its non-auto-repairable diagnoses — matched, not guessed, so an unrelated doctor error never surfaces the repair action. */
const REPAIR_LINK_MARKER = 'use "Re-link credential"';

// ── pure helpers (unit-tested directly — see CodexEnginePane.test.ts) ──

export type CodexStatusTone = "ok" | "warn" | "muted" | "error";

/**
 * Headline/detail/tone for ONE profile's doctor report — the status-automaton
 * projection (cut §4.2). `undefined` means "no check has returned yet for
 * this row", distinct from every `CodexDoctorReport.status`. Row 7 (the new
 * branch — `account:null`, `requiresOpenaiAuth:false` ⇒ `ready`) renders
 * identically to row 5's "Ready" headline but WITHOUT an account suffix,
 * since there is no account to name — the switch below never fabricates one.
 */
export function describeCodexReportStatus(report: CodexDoctorReport | undefined): { headline: string; detail: string; tone: CodexStatusTone } {
  if (report === undefined) {
    return { headline: "Checking…", detail: "Diagnosing this profile.", tone: "muted" };
  }
  switch (report.status) {
    case "ready": {
      const account = report.account;
      // `plan` only exists on the `chatgpt` variant of the widened
      // `CodexAccount` union (codex-profiles cut §3.1) — `apiKey`/
      // `amazonBedrock`/unknown variants carry no plan, and a null account
      // (row 7) carries no account text at all.
      const plan = account && "plan" in account ? account.plan : undefined;
      const accountText = account ? ` — signed in (${account.type}${plan ? ` · ${plan}` : ""})` : "";
      return { headline: "Ready", detail: `Codex ${report.version ?? ""}${accountText}`.trim(), tone: "ok" };
    }
    case "signed_out":
      return { headline: "Sign in required", detail: `Codex ${report.version ?? ""} found but not signed in.`.trim(), tone: "warn" };
    case "update_required":
      return {
        headline: "Update required",
        detail: `Codex ${report.version ?? "(unknown version)"} is not supported — AnyCode needs ${report.supportedRange ?? "a supported version"}. Upgrade or downgrade Codex, then Recheck.`,
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
    case "installed":
      return "installed by AnyCode";
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

/**
 * Only a signed-out-but-otherwise-working profile can start a sign-in — every
 * other status must be fixed (or is already fine) first. An `authLink`
 * profile mirrors an external `CODEX_HOME`'s credential rather than owning
 * one of its own (amended §A1.2: "Login-флоу для authLink-профиля в UI НЕ
 * предлагается") — the server-side `loginStart` gate already refuses it
 * (main/codex-ipc.ts), so the button is withheld here too rather than
 * inviting a click that can only fail.
 */
export function canSignIn(report: CodexDoctorReport | undefined, profile?: CodexProfileRecord): boolean {
  return report?.status === "signed_out" && profile?.authLink === undefined;
}

/**
 * The secondary account line (cut §4.4 п.4: "e-mail показывается как
 * ВТОРИЧНАЯ строка ... никогда как единственный идентификатор"). `null` hides
 * the line entirely — an `apiKey`/`amazonBedrock`/unknown account, or a
 * `chatgpt` account with no email on the wire, has nothing to show here.
 */
export function describeAccountEmailLine(report: CodexDoctorReport | undefined): string | null {
  const account = report?.account;
  // Structural narrowing (`"email" in account`), not `account.type === "chatgpt"` —
  // mirrors the `"plan" in account` narrowing above, which handles the
  // forward-compat catch-all variant (`{type: string}`) the same way.
  if (account && "email" in account && account.email) {
    return account.email;
  }
  return null;
}

/**
 * The explicit "Re-link credential" action (amended §A1.2) is only ever
 * offered for an `authLink` profile whose doctor error is the EXACT
 * lstat-guard diagnosis it exists to repair — never for an unrelated failure
 * (a bad binary, a timeout) on an otherwise-linked profile.
 */
export function canRepairLink(profile: CodexProfileRecord, report: CodexDoctorReport | undefined): boolean {
  return profile.authLink !== undefined && report?.status === "error" && (report.error?.includes(REPAIR_LINK_MARKER) ?? false);
}

/** Hides the "Use current account" sugar button once a profile already mirrors it (amended §A1.1 п.2: "кнопка скрывается, если профиль с той же целью уже существует"). */
export function hasMainAuthLinkProfile(profiles: readonly CodexProfileRecord[]): boolean {
  return profiles.some((profile) => profile.authLink === MAIN_AUTH_LINK_TARGET);
}

export interface CodexAccountRowPlan {
  /** False once a saved profile has been confirmed to mirror the same signed-in account — the pseudo-row would otherwise be an exact duplicate. */
  showSystemRow: boolean;
  /** The one profile (first match in registry order) annotated as the current environment; `null` when nothing matched. */
  currentEnvironmentProfileId: string | null;
}

/**
 * Collapses the "System (current environment)" pseudo-row into a matching
 * saved profile's own card when the two report the SAME signed-in account
 * (TASK.57 — owner: "когда мы даём системному аккаунту профиль, то он должен
 * иметь это имя и не дублироваться"). Identity is compared off
 * `describeAccountEmailLine`'s already-custody-cleared email (trimmed,
 * case-insensitive) since no stable account id exists on the wire. A `null`
 * email on either side (report still pending, signed out, or a non-chatgpt
 * account) leaves System showing on its own — the safe default, never a
 * guessed match. When several profiles happen to share the account, only the
 * FIRST one in registry order is marked; the rest render as ordinary rows.
 */
export function resolveAccountRows(
  systemReport: CodexDoctorReport | undefined,
  profiles: readonly CodexProfileRecord[],
  reportsById: Record<string, CodexDoctorReport | undefined>,
): CodexAccountRowPlan {
  const systemEmail = describeAccountEmailLine(systemReport);
  if (systemEmail === null) {
    return { showSystemRow: true, currentEnvironmentProfileId: null };
  }
  const normalizedSystemEmail = systemEmail.trim().toLowerCase();
  const match = profiles.find((profile) => {
    const profileEmail = describeAccountEmailLine(reportsById[profile.id]);
    return profileEmail !== null && profileEmail.trim().toLowerCase() === normalizedSystemEmail;
  });
  if (match === undefined) {
    return { showSystemRow: true, currentEnvironmentProfileId: null };
  }
  return { showSystemRow: false, currentEnvironmentProfileId: match.id };
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

/**
 * `bridge.manifestRefresh()` is fail-closed by contract (never throws — a
 * network failure falls back to `cache`/`bundled` rather than widening the
 * supported range). That fail-closed behavior was already correct; the
 * defect (S2-2) was purely in observability — a user hitting "Refresh
 * manifest" behind a dead proxy saw no feedback at all. `null` on a genuine
 * `network` refresh keeps the happy path silent.
 */
export function manifestRefreshNotice(source: CodexManifestRefreshResult["source"]): string | null {
  if (source === "network") return null;
  return `Could not reach the manifest server — using the ${source} version.`;
}

/** authLink profiles mirror an external credential (amended §A1.2) — creating one must never kick off this pane's own interactive browser sign-in. */
export function shouldAutoSignIn(request: CodexProfileCreateRequest): boolean {
  return request.authLink === undefined;
}

interface ParsedCodexSemver {
  major: number;
  minor: number;
  patch: number;
}

function parseCodexSemverForRangeCheck(version: string): ParsedCodexSemver | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function compareCodexSemverForRangeCheck(a: ParsedCodexSemver, b: ParsedCodexSemver): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/** One space-separated `>= <= > < =` conjunction (main/codex-manifest.ts's grammar, mirrored minimally) — unparsable syntax fails closed (never matches). */
function versionSatisfiesConjunction(version: ParsedCodexSemver, conjunction: string): boolean {
  const tokens = conjunction.trim().split(/\s+/).filter((token) => token !== "");
  if (tokens.length === 0) return false;
  return tokens.every((token) => {
    const match = /^(>=|<=|>|<|=)?(\d+\.\d+\.\d+)$/.exec(token);
    if (!match) return false;
    const bound = parseCodexSemverForRangeCheck(match[2]!);
    if (bound === null) return false;
    const cmp = compareCodexSemverForRangeCheck(version, bound);
    switch (match[1] ?? "=") {
      case ">=":
        return cmp >= 0;
      case "<=":
        return cmp <= 0;
      case ">":
        return cmp > 0;
      case "<":
        return cmp < 0;
      default:
        return cmp === 0;
    }
  });
}

/**
 * A deliberately-minimal, renderer-local mirror of main/codex-manifest.ts's
 * range grammar (`>= <= > < =` conjunctions, `||`-joined disjunctions, the
 * exact join `manifestSupportedRange` produces) — main/** stays byte-frozen
 * (S2-2 mandate) so this is a read-only-reference reimplementation, not an
 * import, and it exists purely to gate the untested-version banner (R3-9)
 * against a manifest that has since widened. Fails closed (`false`, i.e.
 * "still needs the banner") on anything unparsable — it only ever narrows
 * which risk-accepted versions are treated as no-longer-untested, never
 * silently drops a real warning.
 */
export function isCodexVersionWithinSupportedRange(version: string, supportedRange: string): boolean {
  const parsed = parseCodexSemverForRangeCheck(version);
  if (parsed === null) return false;
  return supportedRange.split("||").some((conjunction) => versionSatisfiesConjunction(parsed, conjunction));
}

/**
 * Mirrors main's compile-time floor rejection (`codex-manifest.ts`'s "risk
 * acceptance cannot override the compiled floor") so the untested-banner gate
 * below never claims risk-acceptance saved a version main will refuse
 * unconditionally. Fails closed like `isCodexVersionWithinSupportedRange`:
 * unparsable input is never treated as below-floor.
 */
function isCodexVersionBelowCompileTimeFloor(version: string): boolean {
  const parsed = parseCodexSemverForRangeCheck(version);
  const floor = parseCodexSemverForRangeCheck(CODEX_MIN_FLOOR);
  if (parsed === null || floor === null) return false;
  return compareCodexSemverForRangeCheck(parsed, floor) < 0;
}

export interface CodexBinaryActions {
  showInstall: boolean;
  showUpdate: boolean;
  showUseAnyway: boolean;
  untestedVersion: string | null;
}

/**
 * Install/update/use-anyway button visibility + the untested-version banner
 * text, all derived from the same (report, support) pair — extracted so the
 * mutation classes R3b-11/R3-9 named (swapped not_installed/update_required
 * conditions, a stale-risk-acceptance false positive once the manifest
 * widens) are pinned by a direct input->output test, not left to inline JSX
 * no test exercises.
 */
export function deriveBinaryActions(report: CodexDoctorReport | undefined, support: CodexSupportStatusResult | null): CodexBinaryActions {
  const showInstall = support !== null && report?.status === "not_installed";
  const showUpdate = support !== null && report?.status === "update_required";
  const version = report?.version;
  const untestedVersion =
    support !== null &&
    version !== undefined &&
    support.riskAcceptedVersions.includes(version) &&
    !isCodexVersionWithinSupportedRange(version, support.supportedRange) &&
    !isCodexVersionBelowCompileTimeFloor(version)
      ? version
      : null;
  return { showInstall, showUpdate, showUseAnyway: showUpdate, untestedVersion };
}

// ── quota formatting (cut §6.2: labels are ALWAYS derived from `windowDurationMins`, never hardcoded) ──

/** `windowDurationMins` -> display label (cut §6.2's table, verbatim). `null`/absent falls back to `limitName`, then the literal "Limit". */
export function deriveCodexQuotaWindowLabel(window: CodexQuotaWindow | null | undefined, limitName?: string | null): string {
  const minutes = window?.windowDurationMins;
  if (minutes === null || minutes === undefined) {
    return limitName ?? "Limit";
  }
  switch (minutes) {
    case 60:
      return "1h";
    case 300:
      return "5h";
    case 1440:
      return "Daily";
    case 10080:
      return "Weekly";
    case 43200:
      return "Monthly";
    default:
      return minutes % 1440 === 0 ? `${minutes / 1440}d` : `${Math.round(minutes / 60)}h`;
  }
}

/** `resetsAt` is epoch SECONDS (amended §A3, verified against the live probe) — multiplied by 1000 exactly here, nowhere else. */
export function formatCodexQuotaReset(resetsAt: number | null | undefined, now: Date = new Date()): string | null {
  if (resetsAt === null || resetsAt === undefined) return null;
  const diffMs = resetsAt * 1000 - now.getTime();
  if (diffMs <= 0) return "resets now";
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 60) return `resets in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `resets in ${hours}h`;
  return `resets in ${Math.round(hours / 24)}d`;
}

/** One quota-window line, or `null` when the window itself is absent (cut §6.2: "Ничего не рисуем, если поле не пришло. Пустая квота = блок скрыт, не «0%»"). */
export function formatCodexQuotaWindowLine(window: CodexQuotaWindow | null | undefined, limitName: string | null | undefined, now: Date = new Date()): string | null {
  if (window === null || window === undefined) return null;
  const label = deriveCodexQuotaWindowLabel(window, limitName);
  const left = Math.max(0, 100 - window.usedPercent);
  const reset = formatCodexQuotaReset(window.resetsAt, now);
  return `${label} · ${left}% left${reset ? ` · ${reset}` : ""}`;
}

/** Credits line, rendered ONLY when `hasCredits` (or `unlimited`) — cut §6.2. */
export function formatCodexQuotaCreditsLine(credits: CodexQuotaCredits | null | undefined): string | null {
  if (credits === null || credits === undefined) return null;
  if (credits.unlimited) return "Unlimited";
  if (credits.hasCredits) return `Credits: ${credits.balance ?? "0"}`;
  return null;
}

/** Every non-empty quota line for one report's `rateLimits` snapshot, in display order (primary, secondary, credits). An empty array means "hide the block" — quotas only ever populate on a `ready` report (main/codex-doctor.ts fetches them post-account-check). */
export function codexQuotaLines(rateLimits: CodexRateLimits | undefined, now: Date = new Date()): string[] {
  if (rateLimits === undefined) return [];
  const lines: string[] = [];
  const primary = formatCodexQuotaWindowLine(rateLimits.primary, rateLimits.limitName, now);
  if (primary !== null) lines.push(primary);
  const secondary = formatCodexQuotaWindowLine(rateLimits.secondary, rateLimits.limitName, now);
  if (secondary !== null) lines.push(secondary);
  const credits = formatCodexQuotaCreditsLine(rateLimits.credits);
  if (credits !== null) lines.push(credits);
  return lines;
}

/**
 * The cut §4.3 iteration ("не N параллельных app-server'ов") extracted as a
 * pure async helper: exactly one `recheck` call in flight at a time, `id` by
 * `id`, in order. `isStale` (checked before each id, not mid-await) lets a
 * caller abandon a superseded chain — a newer `refreshAll` invocation stops
 * this one from issuing any FURTHER recheck calls, though the one already
 * awaited when staleness was detected still completes and reports its
 * result/settle (its own write, if any, is the caller's responsibility to
 * gate — this helper only controls which ids get STARTED).
 */
export async function diagnoseProfilesSequentially(
  ids: readonly string[],
  recheck: (id: string) => Promise<CodexOnboardingSnapshot>,
  callbacks: {
    onStart: (id: string) => void;
    onResult: (id: string, snapshot: CodexOnboardingSnapshot) => void;
    onSettle: (id: string) => void;
    isStale?: () => boolean;
  },
): Promise<void> {
  for (const id of ids) {
    if (callbacks.isStale?.()) return;
    callbacks.onStart(id);
    try {
      const snapshot = await recheck(id);
      callbacks.onResult(id, snapshot);
    } finally {
      callbacks.onSettle(id);
    }
  }
}

// ── component ──

/** Subset of `window.anycode.codex` this pane drives, injectable so tests never touch a real `window`. */
export interface CodexBridge {
  /** TASK.65: `force` bypasses main's doctor TTL cache (the explicit "Recheck all"); a mount-time refresh omits it so a re-check inside the TTL reuses the cached verdict. */
  recheck(profileId?: string, force?: boolean): Promise<CodexOnboardingSnapshot>;
  pickBinary(): Promise<CodexPickBinaryResult>;
  loginStart(profileId?: string): Promise<CodexLoginStartResult>;
  loginCancel(): Promise<void>;
  listProfiles(): Promise<CodexProfilesSnapshot>;
  createProfile(request: CodexProfileCreateRequest): Promise<CodexProfileCreateResult>;
  deleteProfile(id: string): Promise<CodexProfileGuardResult>;
  repairProfileLink(id: string): Promise<CodexProfileGuardResult>;
  install(version?: string): Promise<CodexInstallResult>;
  acceptRisk(version: string): Promise<{ ok: boolean; error?: string }>;
  supportStatus(): Promise<CodexSupportStatusResult>;
  manifestRefresh(): Promise<CodexManifestRefreshResult>;
}

export interface CodexEnginePaneProps {
  /** Injectable for tests / isolation; defaults to the app's real `window.anycode.codex` bridge. */
  bridge?: CodexBridge;
  /**
   * Closes the WHOLE Settings dialog (TASK.57) — `SettingsScreen`'s own
   * `onClose`, forwarded down through this pane to
   * `CodexRolloutImportDialog`. Fired only once "Import & open" has actually
   * landed the user on the freshly-imported tab; a failed import/open leaves
   * the user in Settings with the error visible, so this is never called on
   * that path. Absent when this pane is mounted somewhere with no owning
   * dialog to close.
   */
  onRequestCloseSettings?: () => void;
}

interface CodexProfileRowProps {
  label: string;
  profile?: CodexProfileRecord;
  /** Muted parenthetical shown next to the label (TASK.57) — currently only "current environment", for the profile `resolveAccountRows` matched to the collapsed System row. */
  annotation?: string;
  report: CodexDoctorReport | undefined;
  checking: boolean;
  signingIn: boolean;
  confirmingDelete: boolean;
  busy: boolean;
  onSignIn: () => void;
  onCancelSignIn: () => void;
  onRepairLink: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
  onDelete: () => void;
}

function CodexProfileRow(props: CodexProfileRowProps) {
  const status = props.checking ? { headline: "Checking…", detail: "", tone: "muted" as const } : describeCodexReportStatus(props.report);
  const email = describeAccountEmailLine(props.report);
  const quotaLines = codexQuotaLines(props.report?.rateLimits);
  const showRepair = props.profile !== undefined && canRepairLink(props.profile, props.report);
  return (
    <li className="settings-mcp-row codex-profile-row">
      <span className="settings-mcp-name">{props.label}</span>
      {props.annotation && <span className="codex-profile-annotation">({props.annotation})</span>}
      <span className={`settings-secret-status settings-secret-status-${status.tone}`}>{status.headline}</span>
      <div className="settings-mcp-detail">{status.detail}</div>
      {email && <div className="codex-profile-email">{email}</div>}
      {quotaLines.map((line) => (
        <div key={line} className="codex-profile-quota-line">
          {line}
        </div>
      ))}
      <div className="settings-field-row">
        {props.signingIn ? (
          <>
            <span className="settings-oauth-pending">Waiting for browser sign-in…</span>
            <button type="button" className="settings-button" onClick={props.onCancelSignIn}>
              Cancel
            </button>
          </>
        ) : (
          canSignIn(props.report, props.profile) && (
            <button type="button" className="settings-button settings-button-primary" disabled={props.busy} onClick={props.onSignIn}>
              Sign in
            </button>
          )
        )}
        {showRepair && (
          <button type="button" className="settings-button" disabled={props.busy} onClick={props.onRepairLink}>
            Re-link credential
          </button>
        )}
        {props.profile !== undefined &&
          (props.confirmingDelete ? (
            <>
              <span>Delete this profile?</span>
              <button type="button" className="settings-button settings-button-danger" disabled={props.busy} onClick={props.onDelete}>
                Confirm delete
              </button>
              <button type="button" className="settings-button" onClick={props.onCancelDelete}>
                Cancel
              </button>
            </>
          ) : (
            <button type="button" className="settings-button" disabled={props.busy} onClick={props.onConfirmDelete}>
              Delete
            </button>
          ))}
      </div>
    </li>
  );
}

export function CodexEnginePane({ bridge = window.anycode.codex, onRequestCloseSettings }: CodexEnginePaneProps) {
  const [profiles, setProfiles] = useState<CodexProfileRecord[]>([]);
  const [reportsById, setReportsById] = useState<Record<string, CodexDoctorReport | undefined>>({});
  const [checkingIds, setCheckingIds] = useState<ReadonlySet<string>>(new Set());
  const [binarySnapshot, setBinarySnapshot] = useState<CodexOnboardingSnapshot | null>(null);
  const [support, setSupport] = useState<CodexSupportStatusResult | null>(null);
  const [manifestSource, setManifestSource] = useState<CodexManifestRefreshResult["source"] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [addingAccount, setAddingAccount] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [signingInId, setSigningInId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  // TASK.52 (cut §8.8, lane W3-H): this pane is ONLY the entry point for the
  // rollout-import wizard — all of its own logic/state lives in
  // CodexRolloutImportDialog.tsx.
  const [importOpen, setImportOpen] = useState(false);
  // R3-3/R3b-9 (cut §4.3): a second `refreshAll` invocation overlapping an
  // in-flight one (double-click "Recheck all", or a click during the
  // mount-triggered run) must not spawn a second interleaved sequential
  // chain — that regresses `reportsById` with stale writes and doubles the
  // per-profile app-server checks. An epoch counter (not `busy`) supersedes
  // the older chain: every write below is gated on `refreshEpochRef` still
  // matching the epoch this call started with, and the superseded chain
  // itself stops issuing further recheck calls (`diagnoseProfilesSequentially`'s
  // `isStale`) rather than racing the new one to completion. `busy` is left
  // alone here on purpose — several callers (createAndSignIn in particular)
  // already wrap their OWN `await refreshAll()` in a `busy` scope that must
  // stay true until well after refreshAll resolves (e.g. through the
  // following browser sign-in wait); folding a second `setBusy` into
  // refreshAll itself would clear that flag early and re-enable the toolbar
  // mid-flow.
  const refreshEpochRef = useRef(0);

  // Every row diagnosed SEQUENTIALLY (cut §4.3: "не N параллельных
  // app-server'ов") — `system` first (it always exists), then every
  // registered profile in registry order.
  // TASK.65: `force` defaults TRUE so every explicit trigger (the "Recheck all"
  // button, a post-mutation refresh) still gets a fresh doctor pass exactly as
  // before the TTL existed; ONLY the mount effect below passes `false`, so a
  // Settings re-entry inside the TTL reuses main's cached verdict instead of
  // re-spawning the doctor per profile (the owner's repeat-recheck symptom).
  const refreshAll = useCallback(async (force = true): Promise<void> => {
    const epoch = ++refreshEpochRef.current;
    const isStale = () => refreshEpochRef.current !== epoch;
    const listed = await bridge.listProfiles();
    if (isStale()) return;
    setProfiles(listed.profiles.map((row) => row.profile));
    setReportsById((prev) => {
      const next = { ...prev };
      for (const row of listed.profiles) {
        if (row.report !== undefined) next[row.profile.id] = row.report;
      }
      return next;
    });
    const ids = [SYSTEM_PROFILE_ID, ...listed.profiles.map((row) => row.profile.id)];
    await diagnoseProfilesSequentially(ids, (id) => bridge.recheck(id, force), {
      isStale,
      onStart: (id) => {
        if (isStale()) return;
        setCheckingIds((prev) => new Set(prev).add(id));
      },
      onResult: (id, snapshot) => {
        if (isStale()) return;
        setReportsById((prev) => ({ ...prev, [id]: snapshot.report }));
        if (id === SYSTEM_PROFILE_ID) setBinarySnapshot(snapshot);
      },
      onSettle: (id) => {
        if (isStale()) return;
        setCheckingIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      },
    });
  }, [bridge]);

  useEffect(() => {
    // TASK.65: mount refresh is TTL-guarded (force=false) — re-opening Settings
    // inside the doctor TTL window reuses the cached verdict, no re-spawn.
    void refreshAll(false);
    void bridge.supportStatus().then(setSupport);
  }, [refreshAll, bridge]);

  // Shell-wide re-check-without-restart (TASK.41 п.5): unrelated to this
  // pane's own row refresh above — only keeps the tabs-store's
  // `availableEngines` in sync, the same listener every onboarding surface
  // has always registered.
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
      setBinarySnapshot(result.snapshot);
      await refreshAll();
    } else {
      setNotice(pickBinaryFailureMessage(result.reason));
    }
  }

  async function installBinary(version?: string): Promise<void> {
    setNotice(null);
    setBusy(true);
    try {
      const result = await bridge.install(version);
      if (!result.ok) {
        setNotice(result.error);
      } else {
        await refreshAll();
      }
    } finally {
      setBusy(false);
    }
  }

  async function acceptRiskForBinary(): Promise<void> {
    const version = binarySnapshot?.report.version;
    if (version === undefined) return;
    setNotice(null);
    setBusy(true);
    try {
      const result = await bridge.acceptRisk(version);
      if (!result.ok) {
        setNotice(result.error ?? "Could not accept the risk for this version.");
      } else {
        setSupport(await bridge.supportStatus());
        await refreshAll();
      }
    } finally {
      setBusy(false);
    }
  }

  async function refreshManifest(): Promise<void> {
    setNotice(null);
    setBusy(true);
    try {
      const result = await bridge.manifestRefresh();
      setManifestSource(result.source);
      setNotice(manifestRefreshNotice(result.source));
      setSupport((prev) => (prev !== null ? { ...prev, supportedRange: result.supportedRange } : prev));
      await refreshAll();
    } finally {
      setBusy(false);
    }
  }

  async function createAndSignIn(request: CodexProfileCreateRequest): Promise<void> {
    setNotice(null);
    setBusy(true);
    try {
      const created = await bridge.createProfile(request);
      if (!created.ok) {
        setNotice(created.message ?? `Could not create the profile (${created.reason}).`);
        return;
      }
      await refreshAll();
      if (shouldAutoSignIn(request)) {
        setSigningInId(created.profile.id);
        try {
          const login = await bridge.loginStart(created.profile.id);
          if (login.ok) {
            setReportsById((prev) => ({ ...prev, [created.profile.id]: login.snapshot.report }));
          } else {
            setNotice(loginFailureMessage(login.reason));
          }
        } finally {
          setSigningInId(null);
        }
      }
    } finally {
      setBusy(false);
    }
  }

  async function submitAddAccount(): Promise<void> {
    const label = newLabel.trim();
    if (label === "") return;
    setAddingAccount(false);
    setNewLabel("");
    await createAndSignIn({ label });
  }

  async function useCurrentAccount(): Promise<void> {
    await createAndSignIn({ label: "main", authLink: MAIN_AUTH_LINK_TARGET });
  }

  async function signInProfile(id: string): Promise<void> {
    setNotice(null);
    setSigningInId(id);
    try {
      const result = await bridge.loginStart(id);
      if (result.ok) {
        setReportsById((prev) => ({ ...prev, [id]: result.snapshot.report }));
      } else {
        setNotice(loginFailureMessage(result.reason));
      }
    } finally {
      setSigningInId(null);
    }
  }

  async function repairLink(id: string): Promise<void> {
    setNotice(null);
    setBusy(true);
    try {
      const result = await bridge.repairProfileLink(id);
      if (!result.ok) {
        setNotice(result.reason);
      } else {
        // TASK.65: the re-link just changed the credential, so force past the
        // TTL for a genuinely fresh verdict rather than a moments-old cache hit.
        const fresh = await bridge.recheck(id, true);
        setReportsById((prev) => ({ ...prev, [id]: fresh.report }));
      }
    } finally {
      setBusy(false);
    }
  }

  async function removeProfile(id: string): Promise<void> {
    setNotice(null);
    setBusy(true);
    try {
      const result = await bridge.deleteProfile(id);
      if (!result.ok) {
        setNotice(result.reason);
      } else {
        setConfirmDeleteId(null);
        await refreshAll();
      }
    } finally {
      setBusy(false);
    }
  }

  const binaryReport = reportsById[SYSTEM_PROFILE_ID];
  const binaryStatus = describeCodexReportStatus(checkingIds.has(SYSTEM_PROFILE_ID) ? undefined : binaryReport);
  const binaryActions = deriveBinaryActions(binaryReport, support);
  const atProfileLimit = profiles.length >= MAX_CODEX_PROFILES;
  const accountRows = resolveAccountRows(binaryReport, profiles, reportsById);

  return (
    <section className="settings-section">
      <div className="settings-section-title">Codex</div>
      <div className="settings-field-row">
        <span className={`settings-secret-status settings-secret-status-${binaryStatus.tone}`}>{binaryStatus.headline}</span>
      </div>
      <p className="settings-page-description">{binaryStatus.detail}</p>
      {binarySnapshot?.binaryPath && (
        <p className="settings-page-description">
          <code>{binarySnapshot.binaryPath}</code> ({formatBinarySourceLabel(binarySnapshot.source)})
        </p>
      )}
      {support && (
        <p className="settings-page-description">
          Supported range: <code>{support.supportedRange}</code>
          {manifestSource ? ` (${manifestSource})` : ""}. Recommended: <code>{support.recommended}</code>.
        </p>
      )}
      {binaryActions.untestedVersion && (
        <div className="settings-notice" role="alert">
          Untested Codex version {binaryActions.untestedVersion} — running outside the supported range on your own risk acceptance.
        </div>
      )}
      {notice && (
        <div className="settings-notice" role="alert">
          {notice}
        </div>
      )}
      <div className="settings-field-row">
        <button type="button" className="settings-button" disabled={busy} onClick={() => void refreshAll()}>
          Recheck all
        </button>
        <button type="button" className="settings-button" disabled={busy} onClick={() => void pick()}>
          Choose binary…
        </button>
        {binaryActions.showInstall && support && (
          <button type="button" className="settings-button settings-button-primary" disabled={busy} onClick={() => void installBinary(support.recommended)}>
            Install Codex {support.recommended}
          </button>
        )}
        {binaryActions.showUpdate && support && (
          <button type="button" className="settings-button settings-button-primary" disabled={busy} onClick={() => void installBinary(support.recommended)}>
            Update to {support.recommended}
          </button>
        )}
        {binaryActions.showUseAnyway && (
          <button type="button" className="settings-button" disabled={busy} onClick={() => void acceptRiskForBinary()}>
            Use anyway
          </button>
        )}
        <button type="button" className="settings-button" disabled={busy} onClick={() => void refreshManifest()}>
          Refresh manifest
        </button>
      </div>

      <div className="settings-section-title">Accounts</div>
      <ul className="settings-mcp-list codex-profile-grid">
        {accountRows.showSystemRow && (
          <CodexProfileRow
            label="System (current environment)"
            report={reportsById[SYSTEM_PROFILE_ID]}
            checking={checkingIds.has(SYSTEM_PROFILE_ID)}
            signingIn={signingInId === SYSTEM_PROFILE_ID}
            confirmingDelete={false}
            busy={busy}
            onSignIn={() => void signInProfile(SYSTEM_PROFILE_ID)}
            onCancelSignIn={() => void bridge.loginCancel()}
            onRepairLink={() => {}}
            onConfirmDelete={() => {}}
            onCancelDelete={() => {}}
            onDelete={() => {}}
          />
        )}
        {profiles.map((profile) => (
          <CodexProfileRow
            key={profile.id}
            label={profile.label}
            profile={profile}
            annotation={accountRows.currentEnvironmentProfileId === profile.id ? "current environment" : undefined}
            report={reportsById[profile.id]}
            checking={checkingIds.has(profile.id)}
            signingIn={signingInId === profile.id}
            confirmingDelete={confirmDeleteId === profile.id}
            busy={busy}
            onSignIn={() => void signInProfile(profile.id)}
            onCancelSignIn={() => void bridge.loginCancel()}
            onRepairLink={() => void repairLink(profile.id)}
            onConfirmDelete={() => setConfirmDeleteId(profile.id)}
            onCancelDelete={() => setConfirmDeleteId(null)}
            onDelete={() => void removeProfile(profile.id)}
          />
        ))}
      </ul>
      <div className="settings-field-row">
        {!hasMainAuthLinkProfile(profiles) && (
          <button type="button" className="settings-button" disabled={busy || atProfileLimit} onClick={() => void useCurrentAccount()}>
            Use current account
          </button>
        )}
        {addingAccount ? (
          <>
            <input
              className="settings-field-input"
              type="text"
              placeholder="Account label"
              value={newLabel}
              onChange={(event) => setNewLabel(event.target.value)}
              autoFocus
            />
            <button type="button" className="settings-button settings-button-primary" disabled={busy || newLabel.trim() === ""} onClick={() => void submitAddAccount()}>
              Create & sign in
            </button>
            <button
              type="button"
              className="settings-button"
              onClick={() => {
                setAddingAccount(false);
                setNewLabel("");
              }}
            >
              Cancel
            </button>
          </>
        ) : (
          <button type="button" className="settings-button" disabled={busy || atProfileLimit} onClick={() => setAddingAccount(true)}>
            Add account…
          </button>
        )}
      </div>
      {atProfileLimit && <p className="settings-page-description">At most {MAX_CODEX_PROFILES} profiles are supported.</p>}
      <div className="settings-field-row">
        <button type="button" className="settings-button" onClick={() => setImportOpen(true)}>
          Import a Codex session…
        </button>
      </div>
      {importOpen && (
        <CodexRolloutImportDialog open={importOpen} onClose={() => setImportOpen(false)} profiles={profiles} onRequestCloseSettings={onRequestCloseSettings} />
      )}
    </section>
  );
}
