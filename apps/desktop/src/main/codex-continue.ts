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
 *  - an existing file at the target is never overwritten; an identical rollout
 *    already in place simply means "nothing to copy" and the tab is opened;
 *  - the exhausted tab is left exactly as it is: a session's account cannot
 *    change under a live host, so this opens a NEW session row + tab.
 */
import * as fsp from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, join } from "node:path";
import type { SessionMeta } from "@anycode/core";
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
  createSession(meta: Omit<SessionMeta, "createdAt" | "updatedAt">): Promise<SessionMeta>;
  /** Rolls back the new row when its tab could not be opened (best effort). */
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

export type CodexRolloutCopyResult =
  | { ok: true; relativePath: string; copied: boolean }
  | { ok: false; reason: "rollout_missing" | "copy_failed"; detail: string };

/**
 * Finds `threadId`'s rollout under `dir` and returns its path RELATIVE to that
 * directory. Depth-limited and read-only; an unreadable branch is simply not a
 * match (the caller reports "missing" rather than a filesystem error).
 */
async function findRolloutRelative(dir: string, threadId: string, depth: number): Promise<string | null> {
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  const sorted = [...entries].sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of sorted) {
    if (entry.isFile() && ROLLOUT_FILE_PATTERN.test(entry.name) && entry.name.includes(threadId)) return entry.name;
  }
  if (depth === 0) return null;
  for (const entry of sorted) {
    if (!entry.isDirectory()) continue;
    const nested = await findRolloutRelative(join(dir, entry.name), threadId, depth - 1);
    if (nested !== null) return join(entry.name, nested);
  }
  return null;
}

/**
 * Copies one thread's rollout into another account's home, same relative path.
 * Never overwrites: an existing target file is left untouched and reported as
 * "already in place" (`copied: false`), which is not an error — the caller just
 * opens the tab.
 */
export async function copyCodexRolloutForThread(request: CodexRolloutCopyRequest): Promise<CodexRolloutCopyResult> {
  if (!THREAD_ID_PATTERN.test(request.threadId)) {
    return { ok: false, reason: "rollout_missing", detail: "this session has no usable Codex thread id" };
  }
  const relativePath = await findRolloutRelative(request.sourceSessionsDir, request.threadId, MAX_SESSIONS_DEPTH);
  if (relativePath === null) {
    return {
      ok: false,
      reason: "rollout_missing",
      detail: `no rollout for thread ${request.threadId} in this account's sessions directory`,
    };
  }
  const source = join(request.sourceSessionsDir, relativePath);
  const target = join(request.targetSessionsDir, relativePath);
  try {
    await fsp.mkdir(dirname(target), { recursive: true });
    await fsp.copyFile(source, target, fsConstants.COPYFILE_EXCL);
    return { ok: true, relativePath, copied: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      // The rollout is already in the target home (a previous attempt, or the
      // user was pasted this conversation before). Leave the file alone.
      return { ok: true, relativePath, copied: false };
    }
    return { ok: false, reason: "copy_failed", detail: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The whole action: validate the tab and the account, put the thread's rollout
 * in the target home, create a session row that resumes that thread under the
 * target account, and open it through the app's normal resume path.
 */
export async function handleCodexContinueOnAccount(
  deps: CodexContinueDeps,
  request: CodexContinueRequest,
): Promise<CodexContinueResult> {
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
  const copied = await copyCodexRolloutForThread({ sourceSessionsDir, targetSessionsDir, threadId });
  if (!copied.ok) {
    return {
      ok: false,
      reason: copied.reason,
      detail:
        copied.reason === "rollout_missing"
          ? "the conversation's rollout file was not found under the current account; it cannot be continued elsewhere"
          : copied.detail,
    };
  }
  const sessionId = deps.randomUUID();
  try {
    await deps.createSession({
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
  } catch (error) {
    // The copy is ours, so undo it too — a stray rollout would otherwise show
    // up in the target account's "Import a session" list.
    if (copied.copied) {
      await fsp.rm(join(targetSessionsDir, copied.relativePath), { force: true }).catch(() => {});
    }
    return { ok: false, reason: "copy_failed", detail: error instanceof Error ? error.message : String(error) };
  }
  const opened = await deps.openResumeTab(sessionId);
  if (!opened.ok) {
    await deps.deleteSession(sessionId).catch(() => {});
    if (copied.copied) {
      await fsp.rm(join(targetSessionsDir, copied.relativePath), { force: true }).catch(() => {});
    }
    return { ok: false, reason: "tab_failed", detail: `the new tab could not be opened (${opened.reason})` };
  }
  return { ok: true, sessionId, tabId: opened.tabId };
}
