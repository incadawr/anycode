/** Continuation is temporarily disabled at the IPC boundary. */
import * as fsp from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, join } from "node:path";
import type { SessionMeta } from "@anycode/core";
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

/** Fixed refusal for all callers, independent of request contents and application state. */
export function codexContinueTemporarilyUnavailable(): CodexContinueResult {
  return {ok:false, reason:"temporarily_unavailable", detail:"Continuing this conversation on another account is temporarily unavailable. You can start a new session on another Codex account."};
}

/** Register a refusal-only IPC handler; no account, storage, file, or tab dependencies are consulted. */
export function registerCodexContinueIpc(ipc: {handle(channel: string, listener: () => CodexContinueResult): unknown}): void {
  ipc.handle(CODEX_CONTINUE_CHANNEL, codexContinueTemporarilyUnavailable);
}

/** Preserve the existing internal entry point as a refusal-only boundary. */
export async function handleCodexContinueOnAccount(_deps: CodexContinueDeps, _request: CodexContinueRequest): Promise<CodexContinueResult> {
  return codexContinueTemporarilyUnavailable();
}
