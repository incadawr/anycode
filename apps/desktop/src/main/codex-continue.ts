/**
 * "Continue this Codex thread on another account" — the action behind the
 * usage-limit banner.
 *
 * Why a rollout copy is needed at all: a Codex account IS a `CODEX_HOME`
 * (docs/…, main/codex-profiles.ts), and a native thread resume
 * (`thread/resume`) reads its conversation from `<CODEX_HOME>/sessions/`.
 * Rollouts are therefore NOT shared between accounts: the same thread id under
 * a different home is an unknown thread. Continuing on account B means putting
 * the thread's rollout where B's app-server will look for it, then opening a
 * tab that resumes the same thread id under B's home.
 *
 * Custody, all of it deliberate:
 *  - only the rollout file is read; no credential (`auth.json`) is opened,
 *    copied or echoed — the copy's source is a `rollout-*.jsonl` matched by
 *    thread id inside the account's own `sessions/` tree;
 *  - the target path is the SAME relative path under the target home, built
 *    from a validated relative path (never a caller-supplied absolute one);
 *  - an existing file at the target is never overwritten or assumed current;
 *    the operation stops without opening a tab;
 *  - the exhausted tab is left exactly as it is: a session's account cannot
 *    change under a live host, so this opens a NEW session row + tab.
 */
import * as fsp from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { ContinuationClaim, SessionMeta } from "@anycode/core";
import { SYSTEM_CODEX_ACCOUNT_ID } from "../shared/codex-account.js";
import type { CodexAccountOption } from "../shared/codex-account.js";

/** Mirrors the preload's literal (same duplicated-literal convention as the other codex channels). */
export const CODEX_CONTINUE_CHANNEL = "anycode:codex-continue";

/** Codex's own rollout file naming — the thread id is part of the basename. */
const ROLLOUT_FILE_PATTERN = /^rollout-[A-Za-z0-9._-]+\.jsonl$/;
/** A thread id is an opaque UUID-ish token; anything else is refused before it is used for matching. */
const THREAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** `sessions/YYYY/MM/DD/` is three levels deep; anything deeper is not a rollout tree. */
const MAX_SESSIONS_DEPTH = 3;

export type CodexContinueRefusal =
  /** The kill switch (`settings.codexContinueOnAnotherAccount`) is off. */
  | "temporarily_unavailable"
  | "unknown_tab"
  | "not_codex"
  | "not_resumable"
  | "unknown_session"
  | "no_thread"
  | "same_account"
  | "already_open"
  | "invalid_account"
  | "unknown_account"
  | "rollout_missing"
  /** The source could not be enumerated — NOT the same answer as "missing". */
  | "source_unreadable"
  /** More than one rollout in the source home claims this thread id. */
  | "rollout_ambiguous"
  /** A file already exists at the target path; it is never opened or replaced. */
  | "target_exists"
  /** The source changed while it was being copied: the snapshot is not a snapshot. */
  | "source_changed"
  | "copy_failed"
  | "tab_failed";

export type CodexContinueResult =
  | { ok: true; sessionId: string; tabId: string }
  | { ok: false; reason: CodexContinueRefusal; detail: string };

export interface CodexContinueRequest {
  tabId: string;
  /** Registry id (`system` for the ambient home) — resolved against main's own account list, never trusted as a path. */
  accountId: string;
}

export interface CodexContinueDeps {
  /** Live tab facts; `undefined` for an unknown/closing tab. */
  tab(tabId: string): { sessionId: string; engine?: string; codexProfile?: { id?: string } | null; childOf?: unknown } | undefined;
  /** The root session row (children are refused earlier — they never resume). */
  session(sessionId: string): Promise<Pick<SessionMeta, "id" | "workspace" | "projectRoot" | "model" | "mode" | "title" | "engineId" | "externalSessionRef"> | null>;
  accounts(): Promise<CodexAccountOption[]>;
  /** Absolute `sessions/` directory of an account, `null` when the account has no home. */
  sessionsDir(accountId: string): Promise<string | null>;
  createSessionFromSource(sourceId: string, meta: Omit<SessionMeta, "createdAt" | "updatedAt">): Promise<SessionMeta | null>;
  /**
   * Kill switch without a rebuild (`settings.codexContinueOnAnotherAccount`).
   * REQUIRED, not optional: an absent switch would silently enable the action.
   */
  enabled(): boolean;
  /**
   * Cross-process claim on this `(thread, account)` transfer. Required for the
   * same reason: the in-process `isThreadOpen` check cannot see a second
   * AnyCode instance, and a missing claim would be a silent hole.
   */
  claimContinuation(threadId: string, accountId: string, ttlMs: number): Promise<ContinuationClaim>;
  releaseContinuation(threadId: string, accountId: string): Promise<void>;
  /** Deletion is not used when tab creation has an uncertain outcome. */
  deleteSession(sessionId: string): Promise<unknown>;
  /** Opens the app's normal resume path for a freshly created session row. */
  openResumeTab(sessionId: string): Promise<{ ok: true; tabId: string } | { ok: false; reason: string }>;
  /**
   * True when a live ROOT tab already resumes `threadId` on `accountId` (an
   * earlier continue, or the user opened the imported session there). Absent =
   * no guard; refusing here keeps one rollout from feeding two app-servers.
   */
  isThreadOpen?(threadId: string, accountId: string): Promise<boolean>;
  randomUUID(): string;
}

export interface CodexRolloutCopyRequest {
  sourceSessionsDir: string;
  targetSessionsDir: string;
  threadId: string;
}

export type CodexRolloutCopyRefusal =
  | "rollout_missing"
  | "source_unreadable"
  | "rollout_ambiguous"
  | "target_exists"
  | "source_changed"
  | "copy_failed";

export type CodexRolloutCopyResult =
  | { ok: true; relativePath: string }
  | { ok: false; reason: CodexRolloutCopyRefusal; detail: string };

/**
 * True when `name` is a rollout file for EXACTLY `threadId`.
 *
 * The id must be the final `-`-separated segment before `.jsonl`, because a
 * Codex rollout is named `rollout-<timestamp>-<threadId>.jsonl` and the thread
 * id is itself a hyphenated UUID. A substring test (`includes`) matched
 * `…-<other-id>-…` whenever one uuid happened to contain another, which copies
 * the WRONG conversation; it is not a cosmetic bug.
 */
function isThreadRollout(name: string, threadId: string): boolean {
  if (!ROLLOUT_FILE_PATTERN.test(name)) return false;
  const suffix = `-${threadId}.jsonl`;
  return name.length > suffix.length && name.endsWith(suffix);
}

/** Size + mtime of a file, the pair re-checked after the copy to prove it was stable. */
async function statSnapshot(path: string): Promise<{ size: number; mtimeMs: number }> {
  const info = await fsp.stat(path);
  return { size: info.size, mtimeMs: info.mtimeMs };
}

/**
 * True when the source kept changing while it was copied, so the copy is not a
 * snapshot of the conversation. Exported because it is the decision that makes
 * `source_changed` mean something; a resumed conversation with a truncated tail
 * is exactly the failure this refuses.
 */
export function snapshotChanged(
  before: { size: number; mtimeMs: number },
  after: { size: number; mtimeMs: number },
): boolean {
  return before.size !== after.size || before.mtimeMs !== after.mtimeMs;
}

/**
 * Collects EVERY rollout under `dir` whose thread-id segment is exactly
 * `threadId`, as paths relative to `dir`. Depth-limited.
 *
 * An unreadable branch THROWS rather than being skipped: "the directory could
 * not be listed" and "the rollout is not there" are different answers, and
 * only one of them may be reported as "missing" to a user whose history is at
 * stake. Collecting all matches (instead of returning the first) is what makes
 * `rollout_ambiguous` detectable at all.
 */
async function findRolloutsRelative(dir: string, threadId: string, depth: number): Promise<string[]> {
  const found: string[] = [];
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const sorted = [...entries].sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of sorted) {
    if (entry.isFile() && isThreadRollout(entry.name, threadId)) found.push(entry.name);
  }
  if (depth === 0) return found;
  for (const entry of sorted) {
    if (!entry.isDirectory()) continue;
    const nested = await findRolloutsRelative(join(dir, entry.name), threadId, depth - 1);
    for (const relative of nested) found.push(join(entry.name, relative));
  }
  return found;
}

/**
 * Copies one thread's rollout into another account's home, same relative path.
 * Never overwrites or reuses an existing target: it may be stale or in use.
 */
export async function copyCodexRolloutForThread(request: CodexRolloutCopyRequest): Promise<CodexRolloutCopyResult> {
  if (!THREAD_ID_PATTERN.test(request.threadId)) {
    return { ok: false, reason: "rollout_missing", detail: "this session has no usable Codex thread id" };
  }
  let candidates: string[];
  try {
    candidates = await findRolloutsRelative(request.sourceSessionsDir, request.threadId, MAX_SESSIONS_DEPTH);
  } catch (error) {
    return {
      ok: false,
      reason: "source_unreadable",
      detail: `the current account's sessions directory could not be read (${errorCode(error)}); it was NOT assumed to be empty, so nothing was changed`,
    };
  }
  if (candidates.length === 0) {
    return {
      ok: false,
      reason: "rollout_missing",
      detail: `no rollout for thread ${request.threadId} in this account's sessions directory`,
    };
  }
  if (candidates.length > 1) {
    return {
      ok: false,
      reason: "rollout_ambiguous",
      detail: `${candidates.length} rollouts in this account's sessions directory claim this conversation; refusing to guess which one is current`,
    };
  }
  const relativePath = candidates[0]!;
  const source = join(request.sourceSessionsDir, relativePath);
  const target = join(request.targetSessionsDir, relativePath);

  let before: { size: number; mtimeMs: number };
  try {
    before = await statSnapshot(source);
  } catch (error) {
    return {
      ok: false,
      reason: "source_unreadable",
      detail: `the conversation's rollout could not be stat'ed (${errorCode(error)}); nothing was changed`,
    };
  }

  // Publication is temp + fsync + `link`, never `copyFile` straight onto the
  // final name: a half-written file at the target path would look like a
  // complete conversation forever after. The temp name is unique, so an
  // existing file at the FINAL name can only mean a real prior transfer.
  const tmpPath = join(request.targetSessionsDir, "tmp", `continue-${randomUUID()}.jsonl`);
  let tmpCreated = false;
  try {
    await fsp.mkdir(dirname(tmpPath), { recursive: true });
    await fsp.mkdir(dirname(target), { recursive: true });
    await fsp.copyFile(source, tmpPath, fsConstants.COPYFILE_EXCL);
    tmpCreated = true;
    const handle = await fsp.open(tmpPath, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    // Re-check BEFORE publishing: a source that grew while it was copied did
    // not yield a snapshot, and a truncated tail would resume as a corrupted
    // conversation. Nothing has been placed at the target yet, so the only
    // cleanup is the temp file.
    const after = await statSnapshot(source);
    if (snapshotChanged(before, after)) {
      return {
        ok: false,
        reason: "source_changed",
        detail: "the conversation was still being written while it was copied; nothing was placed on the target account — try again once the session is idle",
      };
    }
    await fsp.link(tmpPath, target);
    return { ok: true, relativePath };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST" && tmpCreated) {
      return {
        ok: false,
        reason: "target_exists",
        detail: "This conversation already exists on the target account and may be outdated or in use. It was not opened or changed. Choose another account or review the existing conversation.",
      };
    }
    return { ok: false, reason: "copy_failed", detail: describeError(error) };
  } finally {
    if (tmpCreated) await fsp.unlink(tmpPath).catch(() => {});
  }
}

/** `ENOENT`/`EACCES`/… for a refusal detail, without ever echoing a path. */
function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" ? code : "unknown error";
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Life of one continuation claim. It covers ONE copy plus ONE insert, so it has
 * to outlive a slow filesystem, not a user's session; an expiry therefore means
 * the holder died mid-transfer rather than that the work is merely slow.
 */
export const CONTINUATION_CLAIM_TTL_MS = 10 * 60_000;

/** The single refusal used when the kill switch is off. */
export function codexContinueTemporarilyUnavailable(): CodexContinueResult {
  return {
    ok: false,
    reason: "temporarily_unavailable",
    detail:
      "Continuing this conversation on another account is temporarily unavailable. You can start a new session on another Codex account.",
  };
}

/**
 * The whole action: validate the tab and the account, take the cross-process
 * claim, put the thread's rollout in the target home, create a session row that
 * resumes that thread under the target account, and open it through the app's
 * normal resume path.
 */
export async function handleCodexContinueOnAccount(
  deps: CodexContinueDeps,
  request: CodexContinueRequest,
): Promise<CodexContinueResult> {
  if (!deps.enabled()) return codexContinueTemporarilyUnavailable();
  const tab = deps.tab(request.tabId);
  if (tab === undefined) return { ok: false, reason: "unknown_tab", detail: "this tab is no longer open" };
  if (tab.engine !== "codex") return { ok: false, reason: "not_codex", detail: "only a Codex session has a Codex account" };
  if (tab.childOf !== undefined) {
    return { ok: false, reason: "not_resumable", detail: "a subagent's session cannot be continued on its own" };
  }
  const meta = await deps.session(tab.sessionId);
  if (meta === null || meta.engineId !== "codex") {
    return { ok: false, reason: "unknown_session", detail: "this session has no stored Codex identity" };
  }
  const threadId = meta.externalSessionRef;
  if (threadId === undefined || threadId.length === 0) {
    return { ok: false, reason: "no_thread", detail: "this session has not started a Codex thread yet" };
  }
  const currentAccountId = tab.codexProfile?.id ?? SYSTEM_CODEX_ACCOUNT_ID;
  const accounts = await deps.accounts();
  const target = accounts.find((account) => account.id === request.accountId);
  if (target === undefined) {
    return {
      ok: false,
      reason: "invalid_account",
      detail: `no account ${JSON.stringify(request.accountId)}; known accounts: ${accounts.map((account) => `${account.label} (${account.id})`).join(", ")}`,
    };
  }
  if (target.id === currentAccountId) {
    return { ok: false, reason: "same_account", detail: "this session already runs on that account" };
  }
  // Idempotence: continuing a thread that is already open on the target would
  // put two app-servers on one rollout (two live tabs resuming one thread) and
  // leave a second session row behind.
  if ((await deps.isThreadOpen?.(threadId, target.id)) === true) {
    return { ok: false, reason: "already_open", detail: "this conversation is already open on that account" };
  }
  const [sourceSessionsDir, targetSessionsDir] = await Promise.all([
    deps.sessionsDir(currentAccountId),
    deps.sessionsDir(target.id),
  ]);
  if (sourceSessionsDir === null || targetSessionsDir === null) {
    return { ok: false, reason: "unknown_account", detail: "one of the two accounts has no usable home" };
  }

  // `isThreadOpen` only sees THIS process's tabs, so a second AnyCode instance
  // could start the same transfer at the same moment: two writers into one
  // rollout. The persisted claim is what makes that impossible.
  let claim: ContinuationClaim;
  try {
    claim = await deps.claimContinuation(threadId, target.id, CONTINUATION_CLAIM_TTL_MS);
  } catch {
    return {
      ok: false,
      reason: "copy_failed",
      detail: "Could not confirm that this conversation is not already being transferred to that account. Nothing was changed.",
    };
  }
  if (claim === "held") {
    return {
      ok: false,
      reason: "already_open",
      detail: "this conversation is already being continued on that account by another window",
    };
  }
  // An expired claim means the previous transfer never reported an outcome, so
  // its copy may be incomplete. Saying nothing would let the user trust a
  // truncated conversation; every refusal below therefore carries this note.
  const staleNote =
    claim === "taken_over"
      ? " An earlier transfer to that account did not report success, so a copy there may be incomplete."
      : "";
  const refuse = (reason: CodexContinueRefusal, detail: string): CodexContinueResult => ({
    ok: false,
    reason,
    detail: `${detail}${staleNote}`,
  });

  try {
    const copied = await copyCodexRolloutForThread({ sourceSessionsDir, targetSessionsDir, threadId });
    if (!copied.ok) {
      return refuse(
        copied.reason,
        copied.reason === "rollout_missing"
          ? "the conversation's rollout file was not found under the current account; it cannot be continued elsewhere"
          : copied.detail,
      );
    }
    const sessionId = deps.randomUUID();
    try {
      const created = await deps.createSessionFromSource(tab.sessionId, {
        id: sessionId,
        workspace: meta.workspace,
        ...(meta.projectRoot !== undefined ? { projectRoot: meta.projectRoot } : {}),
        model: meta.model,
        mode: meta.mode,
        engineId: "codex",
        externalSessionRef: threadId,
        ...(target.id !== SYSTEM_CODEX_ACCOUNT_ID ? { codexProfileId: target.id } : {}),
        ...(meta.title !== undefined ? { title: meta.title } : {}),
      });
      if (created === null) {
        return refuse(
          "unknown_session",
          "The original session is no longer available. A copy was left on the target account and may be outdated or in use. A retry on that account will be blocked; choose another account or review the existing conversation.",
        );
      }
    } catch {
      // A copied rollout is already published and another continuation may use it.
      // Retain it even on failure; creating it does not grant exclusive ownership.
      return refuse(
        "copy_failed",
        "Could not register the new session. A copy was left on the target account and may be outdated or in use. A retry on that account will be blocked; choose another account or review the existing conversation.",
      );
    }
    let opened: Awaited<ReturnType<CodexContinueDeps["openResumeTab"]>>;
    try {
      opened = await deps.openResumeTab(sessionId);
    } catch {
      // A callback or port delivery can throw after the host was spawned. The
      // row exists: destroying it would trade a duplicate for a lost session.
      return refuse(
        "tab_failed",
        "Could not confirm whether the new tab opened. The session WAS created on that account and was not deleted — open it from the session list before retrying.",
      );
    }
    if (!opened.ok) {
      // A refusal such as already_open is not proof that no host uses this row.
      return refuse(
        "tab_failed",
        `Opening was refused (${opened.reason}). The session WAS created on that account and was not deleted — open it from the session list before retrying.`,
      );
    }
    return { ok: true, sessionId, tabId: opened.tabId };
  } finally {
    // The claim guards the TRANSFER, not the session's lifetime. Releasing it on
    // success too keeps a finished continue from blocking the next one for a
    // whole TTL (a re-run is refused by `target_exists`, which is the real gate).
    await deps.releaseContinuation(threadId, target.id).catch(() => {});
  }
}

/** The slice of `ipcMain` this module needs; a seam, not the whole Electron type. */
export interface CodexContinueIpc {
  handle(
    channel: string,
    listener: (event: unknown, raw: unknown) => CodexContinueResult | Promise<CodexContinueResult>,
  ): unknown;
}

/**
 * Registers the usage-limit banner's action. The payload is validated HERE, so
 * `index.ts` stays pure dependency wiring and a malformed frame never reaches
 * an account lookup or the filesystem.
 *
 * `resolveDeps` is a thunk because persistence may not be open yet at
 * registration time — the refusal for that case is `unknown_session`, exactly
 * as it was when the handler was inlined.
 */
export function registerCodexContinueIpc(
  ipc: CodexContinueIpc,
  resolveDeps: () => CodexContinueDeps | null,
): void {
  ipc.handle(CODEX_CONTINUE_CHANNEL, async (_event: unknown, raw: unknown): Promise<CodexContinueResult> => {
    const malformed: CodexContinueResult = { ok: false, reason: "unknown_tab", detail: "malformed request" };
    if (raw === null || typeof raw !== "object") return malformed;
    const value = raw as { tabId?: unknown; accountId?: unknown };
    if (typeof value.tabId !== "string" || value.tabId === "" || typeof value.accountId !== "string" || value.accountId === "") {
      return malformed;
    }
    const deps = resolveDeps();
    if (deps === null) return { ok: false, reason: "unknown_session", detail: "storage is not ready yet" };
    return handleCodexContinueOnAccount(deps, { tabId: value.tabId, accountId: value.accountId });
  });
}
