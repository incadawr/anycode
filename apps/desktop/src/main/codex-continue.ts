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
/** Length of the `YYYY-MM-DDThh-mm-ss` prefix in a rollout file name. */
const TIMESTAMP_PREFIX_LENGTH = 19;

export type CodexContinueRefusal =
  /** The kill switch (`settings.codexContinueOnAnotherAccount`) is off. */
  | "temporarily_unavailable"
  /** Every copy refusal is also a refusal of the whole action. */
  | CodexRolloutCopyRefusal
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
  /** `warning` is present when the transfer succeeded but an earlier attempt had died midway. */
  | { ok: true; sessionId: string; tabId: string; warning?: string }
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
  /** Re-confirms ownership just before publishing; a lost claim must not publish. */
  holdsContinuation(threadId: string, accountId: string, token: string): Promise<boolean>;
  releaseContinuation(threadId: string, accountId: string, token: string): Promise<void>;
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
  /**
   * Asked once, immediately BEFORE the copy is published. Returning false
   * aborts: a transfer that outlived its claim must not publish, because the
   * claim it is holding no longer excludes anyone (it was taken over, and the
   * new owner may now be writing the same paths).
   */
  beforePublish?(): Promise<boolean>;
}

export type CodexRolloutCopyRefusal =
  | "rollout_missing"
  | "source_unreadable"
  | "rollout_ambiguous"
  | "target_exists"
  | "target_unreadable"
  | "source_changed"
  /** The claim was lost (expired and taken over) while the copy was in flight. */
  | "claim_lost"
  | "copy_failed";

export type CodexRolloutCopyResult =
  | { ok: true; relativePath: string }
  | { ok: false; reason: CodexRolloutCopyRefusal; detail: string };

/** The thread id a rollout file CLAIMS to hold, or `null` if the name is not one. */
function rolloutThreadId(name: string): string | null {
  if (!ROLLOUT_FILE_PATTERN.test(name)) return null;
  const rest = name.slice("rollout-".length, -".jsonl".length);
  // A thread id is a hyphenated UUID, so the uuid at the END of the name is the
  // id — take it as a whole, never as a suffix test. `endsWith("-" + id)` was
  // wrong: with a NON-uuid id (`abc`), `rollout-…-other-abc.jsonl` matched and
  // the wrong conversation was copied.
  const uuid = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(rest);
  if (uuid !== null) {
    const before = rest.slice(0, rest.length - uuid[1]!.length);
    return before.endsWith("-") ? uuid[1]! : null;
  }
  // Not a uuid: the only other shape we accept is `rollout-<19-char timestamp>-<id>`.
  return rest.length > TIMESTAMP_PREFIX_LENGTH + 1 && rest[TIMESTAMP_PREFIX_LENGTH] === "-"
    ? rest.slice(TIMESTAMP_PREFIX_LENGTH + 1)
    : null;
}

/**
 * True when `name` is a rollout file for EXACTLY `threadId`: the id is compared
 * whole, never as a substring or a loose suffix.
 */
function isThreadRollout(name: string, threadId: string): boolean {
  return rolloutThreadId(name) === threadId;
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

  // The same thread may already sit in the target home under a DIFFERENT
  // timestamp or date directory (a previous continue at another moment, or a
  // native import). Checking only the source-relative pathname would create a
  // SECOND rollout for one thread while a host may already be resuming the
  // first — two histories for one conversation. Any match is a refusal.
  let existingTargets: string[];
  try {
    existingTargets = await findRolloutsRelative(request.targetSessionsDir, request.threadId, MAX_SESSIONS_DEPTH);
  } catch (error) {
    // A missing target home is simply "nothing there yet"; any other read
    // failure means we cannot prove the thread is absent, so we refuse.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      existingTargets = [];
    } else {
      return {
        ok: false,
        reason: "target_unreadable",
        detail: `the target account's sessions directory could not be read (${errorCode(error)}); it was NOT assumed to be empty, so nothing was changed`,
      };
    }
  }
  if (existingTargets.length > 0) {
    return {
      ok: false,
      reason: "target_exists",
      detail:
        "This conversation already exists on the target account and may be outdated or in use. It was not opened or changed. Choose another account or review the existing conversation.",
    };
  }

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
  try {
    await fsp.mkdir(dirname(tmpPath), { recursive: true });
    await fsp.mkdir(dirname(target), { recursive: true });
    await fsp.copyFile(source, tmpPath, fsConstants.COPYFILE_EXCL);
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
    // Ownership is re-confirmed at the LAST possible moment: after a takeover
    // this process holds nothing, and publishing would race the new owner.
    if (request.beforePublish !== undefined && !(await request.beforePublish())) {
      return {
        ok: false,
        reason: "claim_lost",
        detail:
          "the transfer took too long and another window took it over; nothing was placed on the target account — check that account before trying again",
      };
    }
    await fsp.link(tmpPath, target);
    return { ok: true, relativePath };
  } catch (error) {
    // `EEXIST` can only come from the exclusive temp create or from `link`, and
    // by now the temp name is ours: the meaning is always "the final name is
    // taken", never "the copy failed".
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return {
        ok: false,
        reason: "target_exists",
        detail: "This conversation already exists on the target account and may be outdated or in use. It was not opened or changed. Choose another account or review the existing conversation.",
      };
    }
    return { ok: false, reason: "copy_failed", detail: describeError(error) };
  } finally {
    // Unconditional: a copy that died halfway leaves a partial temp file, and a
    // partial file under `tmp/` is exactly what a later enumeration could pick
    // up as a rollout. Best-effort, because throwing from `finally` would mask
    // the real refusal.
    await fsp.unlink(tmpPath).catch(() => {});
  }
}

/** `ENOENT`/`EACCES`/… for a refusal detail, without ever echoing a path. */
function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" ? code : "unknown error";
}

/**
 * A refusal sentence for a failed copy that never echoes a PATH. Node's
 * `copyFile`/`link`/`mkdir` messages routinely contain both the source and the
 * destination (`ENOENT: no such file or directory, copyfile '/Users/...' ->
 * '/Users/...'`), and this string is forwarded verbatim to the renderer and
 * shown in the banner.
 */
function describeError(error: unknown): string {
  return `the conversation could not be copied (${errorCode(error)}); nothing was placed on the target account`;
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
  //
  // BOTH ends are claimed, not just the target: a second process could
  // otherwise continue FROM the same source concurrently, and whichever copy
  // landed last would be resuming a rollout the other one was reading while it
  // grew. `isThreadOpen` cannot see that process either.
  let targetClaim: ContinuationClaim;
  let sourceClaim: ContinuationClaim;
  try {
    sourceClaim = await deps.claimContinuation(threadId, currentAccountId, CONTINUATION_CLAIM_TTL_MS);
    if (sourceClaim.status === "held") {
      return {
        ok: false,
        reason: "already_open",
        detail: "this conversation is already being continued from this account by another window",
      };
    }
    targetClaim = await deps.claimContinuation(threadId, target.id, CONTINUATION_CLAIM_TTL_MS);
  } catch {
    // Whatever was taken so far must not be left behind; the source claim is
    // released defensively because we cannot tell which step threw.
    if (sourceClaim! !== undefined && sourceClaim.token !== null) {
      await deps.releaseContinuation(threadId, currentAccountId, sourceClaim.token).catch(() => {});
    }
    return {
      ok: false,
      reason: "copy_failed",
      detail: "Could not confirm that this conversation is not already being transferred. Nothing was changed.",
    };
  }
  if (targetClaim.status === "held") {
    await deps.releaseContinuation(threadId, currentAccountId, sourceClaim.token!).catch(() => {});
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
    targetClaim.status === "taken_over" || sourceClaim.status === "taken_over"
      ? " An earlier transfer of this conversation did not report success, so a copy may be incomplete."
      : "";
  const staleWarning = staleNote.trim();
  const refuse = (reason: CodexContinueRefusal, detail: string): CodexContinueResult => ({
    ok: false,
    reason,
    detail: `${detail}${staleNote}`,
  });

  try {
    const copied = await copyCodexRolloutForThread({
      sourceSessionsDir,
      targetSessionsDir,
      threadId,
      beforePublish: async () =>
        (await deps.holdsContinuation(threadId, target.id, targetClaim.token!)) &&
        (await deps.holdsContinuation(threadId, currentAccountId, sourceClaim.token!)),
    });
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
    // A takeover is not a refusal, but it is not silent either: it means an
    // earlier attempt died midway, so the conversation the user is about to
    // open may itself be truncated. Carrying it on the SUCCESS result is the
    // only way that fact reaches someone whose transfer worked.
    return staleWarning === ""
      ? { ok: true, sessionId, tabId: opened.tabId }
      : { ok: true, sessionId, tabId: opened.tabId, warning: staleWarning };
  } finally {
    // The claim guards the TRANSFER, not the session's lifetime. Releasing it on
    // success too keeps a finished continue from blocking the next one for a
    // whole TTL (a re-run is refused by `target_exists`, which is the real gate).
    //
    // Released BY TOKEN: a process whose claim already expired and was taken
    // over must not delete its successor's claim, or a third attempt would find
    // the pair free while the second process is still transferring.
    if (sourceClaim.token !== null) {
      await deps.releaseContinuation(threadId, currentAccountId, sourceClaim.token).catch(() => {});
    }
    if (targetClaim.token !== null) {
      await deps.releaseContinuation(threadId, target.id, targetClaim.token).catch(() => {});
    }
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
