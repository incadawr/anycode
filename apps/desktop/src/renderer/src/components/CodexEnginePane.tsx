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
import { useCallback, useEffect, useState } from "react";
import type { CodexDoctorReport } from "../../../shared/codex-doctor.js";
import type { CodexQuotaCredits, CodexQuotaWindow, CodexRateLimits } from "../../../shared/codex-quota.js";
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
  source: "env" | "settings" | "path" | "common" | "picker" | "none";
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

/** Only a signed-out-but-otherwise-working profile can start a sign-in — every other status must be fixed (or is already fine) first. */
export function canSignIn(report: CodexDoctorReport | undefined): boolean {
  return report?.status === "signed_out";
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

// ── component ──

/** Subset of `window.anycode.codex` this pane drives, injectable so tests never touch a real `window`. */
export interface CodexBridge {
  recheck(profileId?: string): Promise<CodexOnboardingSnapshot>;
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
}

interface CodexProfileRowProps {
  label: string;
  profile?: CodexProfileRecord;
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
          canSignIn(props.report) && (
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

export function CodexEnginePane({ bridge = window.anycode.codex }: CodexEnginePaneProps) {
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

  // Every row diagnosed SEQUENTIALLY (cut §4.3: "не N параллельных
  // app-server'ов") — `system` first (it always exists), then every
  // registered profile in registry order.
  const refreshAll = useCallback(async (): Promise<void> => {
    const listed = await bridge.listProfiles();
    setProfiles(listed.profiles.map((row) => row.profile));
    setReportsById((prev) => {
      const next = { ...prev };
      for (const row of listed.profiles) {
        if (row.report !== undefined) next[row.profile.id] = row.report;
      }
      return next;
    });
    const ids = [SYSTEM_PROFILE_ID, ...listed.profiles.map((row) => row.profile.id)];
    for (const id of ids) {
      setCheckingIds((prev) => new Set(prev).add(id));
      try {
        const snapshot = await bridge.recheck(id);
        setReportsById((prev) => ({ ...prev, [id]: snapshot.report }));
        if (id === SYSTEM_PROFILE_ID) setBinarySnapshot(snapshot);
      } finally {
        setCheckingIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    }
  }, [bridge]);

  useEffect(() => {
    void refreshAll();
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
      if (request.authLink === undefined) {
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
        const fresh = await bridge.recheck(id);
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
  const untestedVersion = binaryReport?.version !== undefined && (support?.riskAcceptedVersions.includes(binaryReport.version) ?? false) ? binaryReport.version : null;
  const atProfileLimit = profiles.length >= MAX_CODEX_PROFILES;

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
      {untestedVersion && (
        <div className="settings-notice" role="alert">
          Untested Codex version {untestedVersion} — running outside the supported range on your own risk acceptance.
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
        {binaryReport?.status === "not_installed" && support && (
          <button type="button" className="settings-button settings-button-primary" disabled={busy} onClick={() => void installBinary(support.recommended)}>
            Install Codex {support.recommended}
          </button>
        )}
        {binaryReport?.status === "update_required" && support && (
          <>
            <button type="button" className="settings-button settings-button-primary" disabled={busy} onClick={() => void installBinary(support.recommended)}>
              Update to {support.recommended}
            </button>
            <button type="button" className="settings-button" disabled={busy} onClick={() => void acceptRiskForBinary()}>
              Use anyway
            </button>
          </>
        )}
        <button type="button" className="settings-button" disabled={busy} onClick={() => void refreshManifest()}>
          Refresh manifest
        </button>
      </div>

      <div className="settings-section-title">Accounts</div>
      <ul className="settings-mcp-list">
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
        {profiles.map((profile) => (
          <CodexProfileRow
            key={profile.id}
            label={profile.label}
            profile={profile}
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
      {importOpen && <CodexRolloutImportDialog open={importOpen} onClose={() => setImportOpen(false)} profiles={profiles} />}
    </section>
  );
}
