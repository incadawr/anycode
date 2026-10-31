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
import type { CodexDeviceCodeProgress, CodexLoginMode } from "../../../shared/codex-login.js";
import type { CodexDoctorReport } from "../../../shared/codex-doctor.js";
import type { CodexQuotaCredits, CodexQuotaWindow, CodexRateLimits } from "../../../shared/codex-quota.js";
import { CODEX_MIN_FLOOR } from "../../../shared/codex-support.js";
import { compareCodexVersions, parseCodexRange, parseCodexSemver, satisfiesCodexRange } from "../../../shared/codex-version-policy.js";
import type { CodexProfileRecord, SettingsMutationResult } from "../../../shared/settings.js";
import { describeMutationFailure } from "../settings-store.js";
import { useTabsStore } from "../tabs-store.js";
import { BinaryTrustDialog, binaryTrustRefusalOf } from "./BinaryTrustDialog.js";
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
  /** Taskana 4092 (TASK.85): alternate-binary candidates the error card may offer — absent when the ladder found none. */
  alternates?: Array<{ path: string; source: "env" | "settings" | "path" | "common" | "installed" | "picker" | "none" }>;
}

export type CodexPickBinaryResult =
  | { ok: true; snapshot: CodexOnboardingSnapshot }
  | { ok: false; reason: "cancelled" | "invalid" };

export type CodexUseBinaryResult =
  | { ok: true; snapshot: CodexOnboardingSnapshot }
  | { ok: false; reason: "busy" | "invalid" | "unlisted" };

export type CodexLoginStartResult =
  | { ok: true; snapshot: CodexOnboardingSnapshot }
  /**
   * Taskana 4884: `detail` is a short, non-secret explanation of a `failed`
   * outcome (which branch refused, and why) — it exists so the UI can say
   * something more useful than "Sign-in failed. Try again.", and so the main
   * log carries a breadcrumb. Never a token/credential; absent when there is
   * nothing to add (cancel, busy, a plain timeout).
   */
  | { ok: false; reason: "busy" | "unsupported" | "cancelled" | "timeout" | "failed"; detail?: string };

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
      // Taskana 4092 (TASK.85): the typed 127/node-shebang diagnosis carries
      // its own hint — rendered from the STRUCTURED field, never from
      // string-matching `error` (the same D-S4-6 rule the trust card follows).
      return {
        headline: "Error",
        detail: report.nodeUnavailable !== undefined ? report.nodeUnavailable.hint : report.error ?? "Codex could not be checked.",
        tone: "error",
      };
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
 * Taskana 4092 follow-up: the notice for a refused "Use <path>" click. Main
 * admits only a path it itself listed as an alternate in the latest doctor
 * report — `unlisted` means the offered list moved on (a recheck or another
 * Use replaced it), so the right next step is a recheck or the picker, not a
 * retry. `null` would be silent; every refusal surfaces.
 */
export function useBinaryFailureMessage(reason: Extract<CodexUseBinaryResult, { ok: false }>["reason"]): string | null {
  switch (reason) {
    case "busy":
      return "A Codex check is already in progress — try again in a moment.";
    case "invalid":
      return "That file is not a usable codex executable.";
    case "unlisted":
      return "That executable is no longer one of the listed candidates — recheck, or choose it with the file picker.";
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

/** The alternate-binary list a card may offer: snapshot alternates minus the currently-saved path, max 3, winner-shaped. */
export function alternateBinaryChoices(snapshot: CodexOnboardingSnapshot | null): Array<{ path: string; source: CodexOnboardingSnapshot["source"] }> {
  const current = snapshot?.binaryPath ?? null;
  return (snapshot?.alternates ?? []).filter((alt) => alt.path !== current).slice(0, 3);
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

/**
 * Settings → Codex per-row default state: `settings.codex.activeProfileId`
 * and its IPC existed with no UI, so a pick-less tab (start screen,
 * Sessions API) always ran on `system` — the user's personal plan.
 * The active id IS the default, `system` included: "use the ambient ~/.codex"
 * is a real choice, not an absence of one, so the System row can carry the
 * marker too.
 */
export function codexDefaultAccountAction(
  profileId: string,
  activeProfileId: string,
): { isDefault: boolean; showMakeDefault: boolean } {
  const isDefault = profileId === activeProfileId;
  return { isDefault, showMakeDefault: !isDefault };
}

/**
 * Whether the System pseudo-row is on screen, and whether "use System again"
 * must be offered separately.
 *
 * The System row collapses into a profile that mirrors the same signed-in
 * account (TASK.57 — no duplicate cards). That collapse must not hide the
 * DEFAULT: while `system` IS the default the row stays, so its "Default" pill
 * remains visible; and while a collapsed System row is hidden (the default is
 * a profile), the pane offers a "Use the System account" action instead, so
 * the ambient account is never unreachable.
 */
export function codexSystemRowVisibility(
  plan: CodexAccountRowPlan,
  activeProfileId: string,
): { showSystemRow: boolean; offerMakeSystemDefault: boolean } {
  if (activeProfileId === SYSTEM_PROFILE_ID) return { showSystemRow: true, offerMakeSystemDefault: false };
  return { showSystemRow: plan.showSystemRow, offerMakeSystemDefault: !plan.showSystemRow };
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

/**
 * Taskana 4884: a failed sign-in carries main's own non-secret `detail` (which
 * branch refused and why). When it is there, SHOW it — the generic "Try again"
 * line told the user nothing and made every distinct failure look identical.
 */
export function loginFailureMessage(
  reason: "busy" | "unsupported" | "cancelled" | "timeout" | "failed",
  detail?: string,
): string | null {
  const explanation = detail !== undefined && detail.trim() !== "" ? detail.trim() : undefined;
  switch (reason) {
    case "busy":
      return "A Codex check is already in progress — try again in a moment.";
    case "unsupported":
      return "Codex isn't installed yet — install it or choose its binary first.";
    case "cancelled":
      return null;
    case "timeout":
      return explanation !== undefined ? `Sign-in timed out: ${explanation}` : "Sign-in timed out. Try again.";
    case "failed":
      return explanation !== undefined ? `Sign-in failed: ${explanation}` : "Sign-in failed. Try again.";
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

/**
 * `supportedRange` is the same grammar the shared policy evaluates
 * (`>= <= > < =` conjunctions, `||`-joined disjunctions — the exact join
 * `manifestSupportedRange` produces; the parser now lives in
 * `shared/codex-version-policy.ts`, TASK.213). Fails closed (`false`, i.e.
 * "still needs the banner") on anything unparsable — it only ever narrows
 * which risk-accepted versions are treated as no-longer-untested, never
 * silently drops a real warning.
 */
export function isCodexVersionWithinSupportedRange(version: string, supportedRange: string): boolean {
  const parsed = parseCodexSemver(version);
  if (parsed === null) return false;
  return supportedRange.split("||").some((conjunction) => {
    const comparators = parseCodexRange(conjunction);
    // null conjunction (empty/unparsable syntax) never matches — fail closed.
    return comparators !== null && satisfiesCodexRange(parsed, comparators);
  });
}

/**
 * Mirrors main's compile-time floor rejection (`codex-manifest.ts`'s "risk
 * acceptance cannot override the compiled floor") so the untested-banner gate
 * below never claims risk-acceptance saved a version main will refuse
 * unconditionally. Fails closed like `isCodexVersionWithinSupportedRange`:
 * unparsable input is never treated as below-floor. Parsing/comparison come
 * from the shared policy module (TASK.213) — the same code main runs.
 */
function isCodexVersionBelowCompileTimeFloor(version: string): boolean {
  const parsed = parseCodexSemver(version);
  const floor = parseCodexSemver(CODEX_MIN_FLOOR);
  if (parsed === null || floor === null) return false;
  return compareCodexVersions(parsed, floor) < 0;
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

/** Soft-allow warning text from the doctor report, or null (owner decision 10.10) — unit-tested like every other pure helper here. */
export function codexVersionWarningNotice(report: CodexDoctorReport | undefined): string | null {
  return report?.versionWarning ?? null;
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
  /** Taskana 4092 (TASK.85): adopt a path main itself listed as an alternate in its latest doctor report — the error card's "Use <path>" buttons. A user gesture per switch; never a silent substitution. */
  useBinary(binaryPath: string): Promise<CodexUseBinaryResult>;
  loginStart(profileId?: string, mode?: CodexLoginMode): Promise<CodexLoginStartResult>;
  onLoginProgress?(callback: (progress: CodexDeviceCodeProgress) => void): () => void;
  loginCancel(): Promise<void>;
  /** Opens the verification page of the pending device-code login (main holds the URL). */
  loginOpenDevicePage?(): Promise<void>;
  listProfiles(): Promise<CodexProfilesSnapshot>;
  /**
   * writes `settings.codex.activeProfileId` — the account every
   * pick-less new session starts on. The IPC existed long before the UI did;
   * "Make default" is its first wired caller.
   */
  setActiveProfile(id: string): Promise<CodexProfileGuardResult>;
  createProfile(request: CodexProfileCreateRequest): Promise<CodexProfileCreateResult>;
  deleteProfile(id: string): Promise<CodexProfileGuardResult>;
  repairProfileLink(id: string): Promise<CodexProfileGuardResult>;
  install(version?: string): Promise<CodexInstallResult>;
  acceptRisk(version: string): Promise<{ ok: boolean; error?: string }>;
  supportStatus(): Promise<CodexSupportStatusResult>;
  manifestRefresh(): Promise<CodexManifestRefreshResult>;
  /** TASK.103 (D-S4-8): grants a per-path binary-trust consent. `path` ONLY — the fingerprint is computed entirely main-side. */
  trustBinary(path: string): Promise<SettingsMutationResult>;
}

export interface CodexEnginePaneProps {
  onboarding?: boolean;
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
  /**
   * This account is the DEFAULT for new sessions (`settings.codex.activeProfileId`,
   * the IPC that previously existed with no UI). New tabs without an explicit
   * pick — start screen, Sessions API — start on it, so the
   * marker is the answer to "which account is my next tab going to spend".
   */
  isDefault?: boolean;
  /** Wired on every NON-default row; "Make default" writes `activeProfileId` through `codex-profile-set-active`. */
  onMakeDefault?: () => void;
  report: CodexDoctorReport | undefined;
  checking: boolean;
  signingIn: boolean;
  confirmingDelete: boolean;
  busy: boolean;
  onSignIn: () => void;
  onDeviceSignIn: () => void;
  deviceCode?: CodexDeviceCodeProgress | null;
  onCancelSignIn: () => void;
  onOpenDevicePage?: () => void;
  onCopyDeviceText?: (text: string, what: string) => void;
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
      {props.isDefault === true && <span className="codex-profile-default" title="New sessions start on this account">Default</span>}
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
            {props.deviceCode && <div role="status">
              Open {props.deviceCode.verificationUrl} and enter <code>{props.deviceCode.userCode}</code> there.
              <span className="settings-field-row">
                <button type="button" className="settings-button" onClick={props.onOpenDevicePage}>Open page</button>
                <button type="button" className="settings-button" onClick={() => props.onCopyDeviceText?.(props.deviceCode!.verificationUrl, "link")}>Copy link</button>
                <button type="button" className="settings-button" onClick={() => props.onCopyDeviceText?.(props.deviceCode!.userCode, "code")}>Copy code</button>
              </span>
            </div>}
            <button type="button" className="settings-button" onClick={props.onCancelSignIn}>
              Cancel
            </button>
          </>
        ) : (
          canSignIn(props.report, props.profile) && (
            <>
            <button type="button" className="settings-button settings-button-primary" disabled={props.busy} onClick={props.onSignIn}>
              Sign in
            </button>
            <button type="button" className="settings-button" disabled={props.busy} onClick={props.onDeviceSignIn}>Sign in with a code</button>
            </>
          )
        )}
        {showRepair && (
          <button type="button" className="settings-button" disabled={props.busy} onClick={props.onRepairLink}>
            Re-link credential
          </button>
        )}
        {props.onMakeDefault !== undefined && props.isDefault !== true && (
          <button type="button" className="settings-button" disabled={props.busy} onClick={props.onMakeDefault}>
            Make default
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

export function CodexEnginePane({ bridge = window.anycode.codex, onRequestCloseSettings, onboarding = false }: CodexEnginePaneProps) {
  const [activeProfileId, setActiveProfileId] = useState(SYSTEM_PROFILE_ID);
  const [deviceCode, setDeviceCode] = useState<CodexDeviceCodeProgress | null>(null);
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
  // TASK.103 (D-S4-8): the binary-trust consent dialog's open state.
  const [trustDialogOpen, setTrustDialogOpen] = useState(false);
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
    setActiveProfileId(listed.activeProfileId);
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
  useEffect(() => bridge.onLoginProgress?.(setDeviceCode), [bridge]);

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

  // Taskana 4092 (TASK.85): adopt one of the snapshot's alternate candidates.
  // An EXPLICIT user gesture per click — never a silent substitution (the
  // TASK.85 trust invariant): main persists it as source "picker", the same
  // rung a file-dialog choice lands on.
  async function useAlternate(path: string): Promise<void> {
    setNotice(null);
    setBusy(true);
    try {
      const result = await bridge.useBinary(path);
      if (result.ok) {
        setBinarySnapshot(result.snapshot);
        setReportsById((prev) => ({ ...prev, [SYSTEM_PROFILE_ID]: result.snapshot.report }));
        await refreshAll();
      } else {
        setNotice(useBinaryFailureMessage(result.reason));
      }
    } finally {
      setBusy(false);
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

  /**
   * TASK.103 (D-S4-8, §4 step 4): Accept ⇒ grant IPC (path only — main
   * computes the fingerprint) ⇒ on `ok` the pane fires its existing recheck
   * so the card resolves through the SAME path every other pane action uses
   * (the `pick()`/`installBinary()` precedent above: set the fresh binary
   * snapshot directly, no full profile re-diagnose needed for a binary-level
   * change). A refusal never closes the dialog silently — it surfaces via
   * the pane's own notice (§8's "Could not trust this binary: {error}").
   */
  async function acceptTrust(): Promise<void> {
    const refusal = binaryTrustRefusalOf(binarySnapshot?.report);
    if (refusal === null) return;
    setNotice(null);
    setBusy(true);
    try {
      const result = await bridge.trustBinary(refusal.binaryPath);
      if (result.ok) {
        setTrustDialogOpen(false);
        const snapshot = await bridge.recheck(undefined, true);
        setBinarySnapshot(snapshot);
        setReportsById((prev) => ({ ...prev, [SYSTEM_PROFILE_ID]: snapshot.report }));
      } else {
        setNotice(`Could not trust this binary: ${describeMutationFailure(result.reason)}`);
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
            setNotice(loginFailureMessage(login.reason, login.detail));
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

  function copyDeviceText(text: string, what: string): void {
    void navigator.clipboard.writeText(text).catch(() => setNotice(`Could not copy the ${what}. Select and copy it manually.`));
  }

  async function signInProfile(id: string, mode: CodexLoginMode = "browser"): Promise<void> {
    setNotice(null);
    setDeviceCode(null);
    setSigningInId(id);
    try {
      const result = await bridge.loginStart(id, mode);
      if (result.ok) {
        setReportsById((prev) => ({ ...prev, [id]: result.snapshot.report }));
      } else {
        setNotice(loginFailureMessage(result.reason, result.detail));
      }
    } finally {
      setSigningInId(null);
      setDeviceCode(null);
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

  /**
   * "Make default" — writes `settings.codex.activeProfileId`
   * through the profile IPC that already existed but had no UI. From then on
   * every pick-less tab (start screen, Sessions API) starts on
   * this account. The marker moves immediately; the per-row diagnoses are
   * untouched (the TTL-guarded refresh re-reads the registry only).
   */
  async function makeDefault(id: string): Promise<void> {
    setNotice(null);
    setBusy(true);
    try {
      const result = await bridge.setActiveProfile(id);
      if (!result.ok) {
        setNotice(result.reason);
      } else {
        setActiveProfileId(id);
        await refreshAll(false);
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
  // The collapse into a matching profile must not hide the Default marker (and
  // must leave the ambient account reachable): see codexSystemRowVisibility.
  const systemRow = codexSystemRowVisibility(accountRows, activeProfileId);
  // TASK.103 (D-S4-6): the consent card source — the structured field only,
  // never a string-match on `binaryStatus.detail`.
  const trustRefusal = binaryTrustRefusalOf(binarySnapshot?.report);

  if (onboarding) {
    const report = reportsById[activeProfileId] ?? binaryReport;
    const checking = binarySnapshot === null || checkingIds.size > 0;
    const status = describeCodexReportStatus(checking ? undefined : report);
    const profile = profiles.find((candidate) => candidate.id === activeProfileId);
    return <section className="settings-section" aria-label="Connect ChatGPT / Codex">
      <h2 className="settings-section-title">Connect ChatGPT / Codex</h2>
      <p role="status">{status.headline}</p>
      <p className="settings-page-description">{report?.status === "signed_out" ? "Sign in with your ChatGPT account. If the browser cannot return to this app, use a code instead." : status.detail}</p>
      {notice && <p className="settings-notice" role="alert">{notice}</p>}
      <div className="settings-field-row">
        {signingInId ? <>
          <span role="status">Waiting for sign-in…</span>
          <button type="button" className="settings-button" onClick={() => void bridge.loginCancel()}>Cancel</button>
        </> : <>
          {(binaryActions.showInstall || binaryActions.showUpdate) ?
            <button type="button" className="settings-button settings-button-primary" disabled={busy || checking} onClick={() => void installBinary()}>{busy ? "Installing…" : binaryActions.showUpdate ? "Update Codex" : "Install Codex"}</button> :
            canSignIn(report, profile) ? <>
              <button type="button" className="settings-button settings-button-primary" disabled={busy || checking} onClick={() => void signInProfile(activeProfileId)}>Sign in with ChatGPT</button>
              <button type="button" className="settings-button" disabled={busy || checking} onClick={() => void signInProfile(activeProfileId, "device")}>Sign in with a code</button>
            </> : <button type="button" className="settings-button settings-button-primary" disabled={busy || checking} onClick={() => void refreshAll()}>Check again</button>}
        </>}
      </div>
      {signingInId && deviceCode?.profileId === signingInId && <div className="settings-section" role="status">
        <p>Open <strong>{deviceCode.verificationUrl}</strong> and enter this code on that page:</p>
        <code>{deviceCode.userCode}</code>
        <div className="settings-field-row">
          <button type="button" className="settings-button settings-button-primary" onClick={() => void bridge.loginOpenDevicePage?.()}>Open page</button>
          <button type="button" className="settings-button" onClick={() => copyDeviceText(deviceCode.verificationUrl, "link")}>Copy link</button>
          <button type="button" className="settings-button" onClick={() => copyDeviceText(deviceCode.userCode, "code")}>Copy code</button>
        </div>
        <p className="settings-field-hint">Device-code login may need to be enabled in your ChatGPT security or workspace settings.</p>
      </div>}
      <details className="connection-drawer-advanced"><summary>Advanced troubleshooting</summary>
        <p>{binarySnapshot?.binaryPath ?? "No Codex executable found"}</p>
        <p>{support ? `Supported: ${support.supportedRange}. Recommended: ${support.recommended}.` : "Checking supported versions…"}</p>
        <button type="button" className="settings-button" disabled={busy || !!signingInId} onClick={() => void pick()}>Choose executable…</button>
        {trustRefusal && <button type="button" className="settings-button" onClick={() => setTrustDialogOpen(true)}>Review executable trust…</button>}
      </details>
      <BinaryTrustDialog open={trustDialogOpen && trustRefusal !== null} binaryPath={trustRefusal?.binaryPath ?? ""} reason={trustRefusal?.reason ?? ""} staleConsent={trustRefusal?.staleConsent ?? false} onAccept={() => void acceptTrust()} onDecline={() => setTrustDialogOpen(false)} />
    </section>;
  }

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
      {alternateBinaryChoices(binarySnapshot).length > 0 && (binarySnapshot?.report.status === "error" || binarySnapshot?.report.status === "update_required") && (
        <div className="settings-field-row">
          {alternateBinaryChoices(binarySnapshot).map((alt) => (
            <button key={alt.path} type="button" className="settings-button" disabled={busy} onClick={() => void useAlternate(alt.path)}>
              Use {alt.path}
            </button>
          ))}
        </div>
      )}
      {support && (
        <p className="settings-page-description">
          Supported range: <code>{support.supportedRange}</code>
          {manifestSource ? ` (${manifestSource})` : ""}. Recommended: <code>{support.recommended}</code>.
        </p>
      )}
      {codexVersionWarningNotice(binarySnapshot?.report) && (
        <div className="settings-notice" role="alert">
          {codexVersionWarningNotice(binarySnapshot?.report)}
        </div>
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
        {trustRefusal !== null && (
          <button
            type="button"
            className="settings-button"
            disabled={busy}
            // TASK.103: structured facts for the automation facade
            // (`realCodexPaneDom().trust()`) — never read by string-matching
            // the rendered reason text (D-S4-6's "no string-matching" carried
            // into the automation surface too).
            data-trust-binary-path={trustRefusal.binaryPath}
            data-trust-reason={trustRefusal.reason}
            data-trust-stale-consent={String(trustRefusal.staleConsent)}
            onClick={() => setTrustDialogOpen(true)}
          >
            Trust this binary…
          </button>
        )}
        <button type="button" className="settings-button" disabled={busy} onClick={() => void refreshManifest()}>
          Refresh manifest
        </button>
      </div>

      <div className="settings-section-title">Accounts</div>
      {/* the default is a visible, changeable choice. New tabs
          without an explicit pick (start screen, Sessions API) start on the
          account marked Default. */}
      <div className="settings-mcp-detail codex-default-account-hint">
        New sessions start on the account marked Default.
        {systemRow.offerMakeSystemDefault && (
          <button type="button" className="settings-button" disabled={busy} onClick={() => void makeDefault(SYSTEM_PROFILE_ID)}>
            Use the System account instead
          </button>
        )}
      </div>
      <ul className="settings-mcp-list codex-profile-grid">
        {systemRow.showSystemRow && (
          <CodexProfileRow
            label="System (current environment)"
            isDefault={codexDefaultAccountAction(SYSTEM_PROFILE_ID, activeProfileId).isDefault}
            onMakeDefault={() => void makeDefault(SYSTEM_PROFILE_ID)}
            report={reportsById[SYSTEM_PROFILE_ID]}
            checking={checkingIds.has(SYSTEM_PROFILE_ID)}
            signingIn={signingInId === SYSTEM_PROFILE_ID}
            confirmingDelete={false}
            busy={busy}
            onSignIn={() => void signInProfile(SYSTEM_PROFILE_ID)}
            onDeviceSignIn={() => void signInProfile(SYSTEM_PROFILE_ID, "device")}
            deviceCode={deviceCode?.profileId === SYSTEM_PROFILE_ID ? deviceCode : null}
            onCancelSignIn={() => void bridge.loginCancel()}
            onOpenDevicePage={() => void bridge.loginOpenDevicePage?.()}
            onCopyDeviceText={copyDeviceText}
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
            isDefault={codexDefaultAccountAction(profile.id, activeProfileId).isDefault}
            onMakeDefault={() => void makeDefault(profile.id)}
            annotation={accountRows.currentEnvironmentProfileId === profile.id ? "current environment" : undefined}
            report={reportsById[profile.id]}
            checking={checkingIds.has(profile.id)}
            signingIn={signingInId === profile.id}
            confirmingDelete={confirmDeleteId === profile.id}
            busy={busy}
            onSignIn={() => void signInProfile(profile.id)}
            onDeviceSignIn={() => void signInProfile(profile.id, "device")}
            deviceCode={deviceCode?.profileId === profile.id ? deviceCode : null}
            onCancelSignIn={() => void bridge.loginCancel()}
            onOpenDevicePage={() => void bridge.loginOpenDevicePage?.()}
            onCopyDeviceText={copyDeviceText}
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
      <BinaryTrustDialog
        open={trustDialogOpen && trustRefusal !== null}
        binaryPath={trustRefusal?.binaryPath ?? ""}
        reason={trustRefusal?.reason ?? ""}
        staleConsent={trustRefusal?.staleConsent ?? false}
        onAccept={() => void acceptTrust()}
        onDecline={() => setTrustDialogOpen(false)}
      />
    </section>
  );
}
