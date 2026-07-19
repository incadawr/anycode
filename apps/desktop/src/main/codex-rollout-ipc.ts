/**
 * Rollout import IPC (cut §8.8, TASK.52 lane D): the three endpoints behind
 * "Settings -> Codex -> Import a Codex session" — list a profile's rollouts,
 * preview one (full `RolloutImportReport`, nothing persisted), and import one
 * (persist a NEW core session + its converted history, ready for the
 * existing `--resume`/`kind:"resume"` tab path — zero new host/wire code).
 *
 * PATH CUSTODY (mirrors subagents-ipc.ts's own invariant): the renderer NEVER
 * supplies a filesystem path. It sends a `profileId` + a `fileName` — the
 * relative `YYYY/MM/DD/rollout-*.jsonl` shape rollouts are actually stored
 * under (§1.3) — validated here against a strict pattern (rejects `..` and
 * absolute paths by construction, not by stripping). `resolveProfileSessionsDir`
 * is an INJECTED resolver, not an import of `main/codex-profiles.ts`: that
 * file is lane A's zone (cut §13.1 row D lists only this file + codex-rollout.ts
 * + fixtures), and lane A builds after this one in the plan (§13, "D зависит
 * только от C0"). The orchestrator wires the real resolver at integration
 * time — see this lane's final report for the ready snippet.
 *
 * Channel constants/request/result types live HERE rather than in
 * `shared/**` because that directory is frozen for the whole track once C0
 * lands (cut §13/§15: "после него ни один лейн не редактирует shared/**").
 * `main/codex-rollout.ts`'s own `RolloutImportReport` already sets this
 * precedent (cut §3.7 places it in `main/`, not `shared/`) — see the final
 * report's ESCALATE note on how a later preload wire-up should consume these.
 */

import { ipcMain } from "electron";
import { constants as fsConstants } from "node:fs";
import * as fsp from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { deriveSessionTitle, sanitizeTitleSource, type HistoryItem, type PermissionMode, type PersistencePort } from "@anycode/core";
import { importCodexRollout, type ImportCodexRolloutOptions, type RolloutImportReport } from "./codex-rollout.js";

export const CODEX_ROLLOUT_LIST_CHANNEL = "anycode:codex-rollout-list";
export const CODEX_ROLLOUT_PREVIEW_CHANNEL = "anycode:codex-rollout-preview";
export const CODEX_ROLLOUT_IMPORT_CHANNEL = "anycode:codex-rollout-import";

const MAX_ITEMS_DEFAULT = 5000;
const MAX_OUTPUT_CHARS_DEFAULT = 8192;
/** §8.7: cap on the rollout file itself. */
const MAX_FILE_BYTES = 32 * 1024 * 1024;
/** Bytes read from the START of a file only, to cheaply surface `cwd`/first user line in the list view without reading multi-MB rollouts in full. */
const HEAD_PEEK_BYTES = 16 * 1024;
/** §4.3-style sanity cap: a picker listing hundreds of files is a UI bug, not a feature. */
const MAX_ROLLOUTS_LISTED = 500;

/** `YYYY/MM/DD/rollout-<anything safe>.jsonl` — the exact on-disk shape (§1.3). Anchored, so `..`/absolute paths never match. */
const ROLLOUT_FILE_NAME_PATTERN = /^\d{4}\/\d{2}\/\d{2}\/rollout-[A-Za-z0-9._-]+\.jsonl$/;

export interface CodexRolloutListRequest {
  profileId: string;
}

export interface CodexRolloutEntry {
  /** Relative to the profile's `sessions/` directory — the identifier the renderer round-trips back for preview/import, never an absolute path. */
  fileName: string;
  sizeBytes: number;
  mtimeMs: number;
  cwd?: string;
  firstUserMessage?: string;
}

export type CodexRolloutListResult = { ok: true; rollouts: CodexRolloutEntry[] } | { ok: false; reason: "profile_not_found" | "not_readable" };

export interface CodexRolloutPreviewRequest {
  profileId: string;
  fileName: string;
}

export type CodexRolloutPreviewResult =
  | { ok: true; report: RolloutImportReport }
  | { ok: false; reason: "profile_not_found" | "invalid_file_name" | "not_readable" | "too_large" };

export interface CodexRolloutImportRequest {
  profileId: string;
  fileName: string;
  /** Model for the NEW core session — chosen by the user (§8.8: "продолжить на другой модели" is the whole point of the feature). */
  model: string;
  mode?: PermissionMode;
}

export type CodexRolloutImportResult =
  | { ok: true; sessionId: string; workspace: string; report: RolloutImportReport }
  | { ok: false; reason: "profile_not_found" | "invalid_file_name" | "not_readable" | "too_large" | "invalid_model" };

export interface CodexRolloutIpcDeps {
  persistence: Pick<PersistencePort, "createSession" | "appendHistory">;
  /** `profileId` -> absolute path of THAT profile's `sessions/` directory (§1.3: "rollout лежит в доме своего профиля"); `null` = unknown profile. Owned by lane A's profile registry — injected so this file never imports it. */
  resolveProfileSessionsDir(profileId: string): Promise<string | null>;
  /**
   * The active provider connection at the moment of `import & apply` (S4-1 arm 1,
   * W4-F1). The imported session's model was picked from THIS connection's
   * catalog (§8.1: import = a NEW core session), so the new session is pinned to
   * it — otherwise a default-switch between import and open would resolve the
   * per-fork model override (arm 2) against a DIFFERENT provider. Absent OR
   * returning `undefined` (no active connection) ⇒ the row is persisted without a
   * pin, byte-identical to pre-S4-1. Mirrors tab-ipc's own `activeConnectionId`
   * (the source is the same active-connection getter in main/index.ts).
   */
  activeConnectionId?: () => string | undefined;
  /**
   * Records the user's picked model against the freshly created session id
   * (S4-1 arm 2). The first resume of that session consumes it (consume-once)
   * and stamps it over the fork env's ANYCODE_MODEL, so the imported tab boots on
   * the CHOSEN model instead of the active connection's default (§8.8: the whole
   * point of the picker). `registerCodexRolloutIpc` binds this to its own ephemeral
   * map; absent = no ephemeral model plane (legacy wiring / unit fixtures).
   */
  recordPendingImportModel?: (sessionId: string, model: string) => void;
  maxItems?: number;
  maxOutputChars?: number;
}

function importOptions(deps: CodexRolloutIpcDeps): ImportCodexRolloutOptions {
  return { maxItems: deps.maxItems ?? MAX_ITEMS_DEFAULT, maxOutputChars: deps.maxOutputChars ?? MAX_OUTPUT_CHARS_DEFAULT };
}

/** Cheap, bounded peek at a rollout's `cwd` + first user message, reading only the head of the file (never the whole thing) for the list view. Tolerant of anything — a peek that fails just yields an entry with no preview fields, never a thrown error. */
async function peekRolloutMeta(path: string): Promise<{ cwd?: string; firstUserMessage?: string }> {
  let head = "";
  try {
    const handle = await fsp.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const buffer = Buffer.alloc(HEAD_PEEK_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, HEAD_PEEK_BYTES, 0);
      head = buffer.toString("utf8", 0, bytesRead);
    } finally {
      await handle.close();
    }
  } catch {
    return {};
  }
  const result: { cwd?: string; firstUserMessage?: string } = {};
  // The head read may end mid-line; every line is parsed independently and a
  // trailing partial one simply fails JSON.parse and is skipped — exactly the
  // importer's own malformed-line tolerance, reused here at a smaller scale.
  for (const line of head.split("\n")) {
    if (line.trim() === "") continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof record !== "object" || record === null) continue;
    const rec = record as { type?: unknown; payload?: unknown };
    if (rec.type === "session_meta" && result.cwd === undefined) {
      const payload = rec.payload as { cwd?: unknown } | undefined;
      if (typeof payload?.cwd === "string") result.cwd = payload.cwd;
    }
    if (rec.type === "response_item" && result.firstUserMessage === undefined) {
      const payload = rec.payload as { type?: unknown; role?: unknown; content?: unknown } | undefined;
      if (payload?.type === "message" && payload.role === "user" && Array.isArray(payload.content)) {
        const texts = payload.content
          .map((part) => (typeof part === "object" && part !== null && (part as { type?: unknown }).type === "input_text" ? (part as { text?: unknown }).text : undefined))
          .filter((text): text is string => typeof text === "string");
        if (texts.length > 0) result.firstUserMessage = texts.join("\n");
      }
    }
    if (result.cwd !== undefined && result.firstUserMessage !== undefined) break;
  }
  return result;
}

async function walkRolloutFileNames(sessionsDir: string): Promise<string[]> {
  const fileNames: string[] = [];
  const years = await fsp.readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
  outer: for (const year of years) {
    if (!year.isDirectory()) continue;
    const yearPath = join(sessionsDir, year.name);
    const months = await fsp.readdir(yearPath, { withFileTypes: true }).catch(() => []);
    for (const month of months) {
      if (!month.isDirectory()) continue;
      const monthPath = join(yearPath, month.name);
      const days = await fsp.readdir(monthPath, { withFileTypes: true }).catch(() => []);
      for (const day of days) {
        if (!day.isDirectory()) continue;
        const dayPath = join(monthPath, day.name);
        const entries = await fsp.readdir(dayPath, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
          const relative = `${year.name}/${month.name}/${day.name}/${entry.name}`;
          if (!ROLLOUT_FILE_NAME_PATTERN.test(relative)) continue;
          fileNames.push(relative);
          if (fileNames.length >= MAX_ROLLOUTS_LISTED) break outer;
        }
      }
    }
  }
  return fileNames;
}

export async function handleCodexRolloutList(deps: CodexRolloutIpcDeps, raw: unknown): Promise<CodexRolloutListResult> {
  const request = raw as Partial<CodexRolloutListRequest> | null;
  const profileId = typeof request?.profileId === "string" ? request.profileId : "";
  if (profileId === "") return { ok: false, reason: "profile_not_found" };
  const sessionsDir = await deps.resolveProfileSessionsDir(profileId);
  if (sessionsDir === null) return { ok: false, reason: "profile_not_found" };
  let fileNames: string[];
  try {
    fileNames = await walkRolloutFileNames(sessionsDir);
  } catch {
    return { ok: false, reason: "not_readable" };
  }
  const rollouts: CodexRolloutEntry[] = [];
  for (const fileName of fileNames) {
    const fullPath = join(sessionsDir, fileName);
    const stat = await fsp.lstat(fullPath).catch(() => null);
    if (stat === null || !stat.isFile()) continue;
    const peek = await peekRolloutMeta(fullPath);
    rollouts.push({ fileName, sizeBytes: stat.size, mtimeMs: stat.mtimeMs, ...peek });
  }
  // Newest first by mtime; equal mtimes (coarse fs timestamps, back-to-back
  // writes) fall back to the date-encoded path so the order never depends on
  // readdir enumeration order.
  rollouts.sort((a, b) => b.mtimeMs - a.mtimeMs || b.fileName.localeCompare(a.fileName));
  return { ok: true, rollouts };
}

/** Shared by preview/import: validates the fileName, re-resolves the profile dir, reads and imports the rollout. */
async function readAndImport(
  deps: CodexRolloutIpcDeps,
  profileId: string,
  fileName: string,
): Promise<{ ok: true; report: RolloutImportReport } | { ok: false; reason: "profile_not_found" | "invalid_file_name" | "not_readable" | "too_large" }> {
  if (!ROLLOUT_FILE_NAME_PATTERN.test(fileName)) return { ok: false, reason: "invalid_file_name" };
  const sessionsDir = await deps.resolveProfileSessionsDir(profileId);
  if (sessionsDir === null) return { ok: false, reason: "profile_not_found" };
  const fullPath = join(sessionsDir, fileName);
  let content: string;
  try {
    // BH2: O_NOFOLLOW below only guards the FINAL path component. An
    // intermediate component (e.g. the YYYY dir) can itself be a symlink
    // pointing outside sessionsDir, with a perfectly ordinary file sitting at
    // the far end — that would sail through O_NOFOLLOW untouched. Requiring
    // the resolved parent directory to land exactly where sessionsDir +
    // fileName's own directory would (no symlink detour anywhere upstream)
    // closes that gap.
    const realSessionsDir = await fsp.realpath(sessionsDir);
    const realParentDir = await fsp.realpath(dirname(fullPath));
    if (realParentDir !== join(realSessionsDir, dirname(fileName))) {
      return { ok: false, reason: "not_readable" };
    }
    // O_NOFOLLOW: open fails (ELOOP) if the final path component is a symlink; fstat-ing
    // the HANDLE (not the path) closes the swap window between the size check and the read.
    // O_NONBLOCK (BM1): a FIFO with no writer would otherwise block this
    // open() call itself — isFile() below would never even run. Non-blocking
    // open returns immediately regardless of writer state; it is a no-op for
    // a regular file's read.
    const handle = await fsp.open(fullPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | (fsConstants.O_NONBLOCK ?? 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return { ok: false, reason: "not_readable" };
      if (stat.size > MAX_FILE_BYTES) return { ok: false, reason: "too_large" };
      content = await handle.readFile("utf-8");
    } finally {
      await handle.close();
    }
  } catch {
    return { ok: false, reason: "not_readable" };
  }
  const lines = content.split("\n");
  const report = importCodexRollout(lines, importOptions(deps));
  return { ok: true, report };
}

export async function handleCodexRolloutPreview(deps: CodexRolloutIpcDeps, raw: unknown): Promise<CodexRolloutPreviewResult> {
  const request = raw as Partial<CodexRolloutPreviewRequest> | null;
  const profileId = typeof request?.profileId === "string" ? request.profileId : "";
  const fileName = typeof request?.fileName === "string" ? request.fileName : "";
  if (profileId === "") return { ok: false, reason: "profile_not_found" };
  return readAndImport(deps, profileId, fileName);
}

/** First user-authored turn in the CONVERTED history (`report.items`, never the raw rollout text) — the session-title source, mirroring `host/session.ts`'s own `maybeDeriveTitle` which titles off the first real user turn, never an assistant/tool one. `undefined` when the rollout carries no user message at all. */
function firstImportedUserMessageText(items: readonly HistoryItem[]): string | undefined {
  for (const item of items) {
    if (item.message.role === "user") return item.message.content;
  }
  return undefined;
}

export async function handleCodexRolloutImport(deps: CodexRolloutIpcDeps, raw: unknown): Promise<CodexRolloutImportResult> {
  const request = raw as Partial<CodexRolloutImportRequest> | null;
  const profileId = typeof request?.profileId === "string" ? request.profileId : "";
  const fileName = typeof request?.fileName === "string" ? request.fileName : "";
  const model = typeof request?.model === "string" ? request.model : "";
  if (profileId === "") return { ok: false, reason: "profile_not_found" };
  // Split from profile_not_found (F2 review lane FXH): a custom-provider
  // connection with no models resolves the picker to "" (resolveDefaultImportModel),
  // which previously refused with a misleading "that profile no longer exists".
  if (model === "") return { ok: false, reason: "invalid_model" };
  const imported = await readAndImport(deps, profileId, fileName);
  if (!imported.ok) return imported;
  // §8.1: a brand-new core session, never a link back to the source codex
  // session — no `externalSessionRef`, so it is never mistaken for a
  // resumable codex thread.
  //
  // R2-M3 (W4-F1): `meta.cwd` is UNTRUSTED content read verbatim from the
  // rollout file. A relative fallback (`"."`) resolves against the Electron
  // process cwd — `/` when launched from Finder — silently rooting the resumed
  // session in an unpredictable place; a garbage/relative string from the file
  // would ride into the session row as-is. Only an ABSOLUTE cwd is trusted;
  // anything else (absent head, relative, junk) falls back to the user's home.
  const rawCwd = imported.report.meta.cwd;
  const workspace = typeof rawCwd === "string" && isAbsolute(rawCwd) ? rawCwd : homedir();
  // S4-1 arm 1 (W4-F1): pin the NEW session to the connection active at apply
  // time. `undefined` (no active connection) ⇒ no pin field, byte-as-today.
  const connectionId = deps.activeConnectionId?.();
  // TASK.57: an imported session otherwise lands with no title at all (this
  // handler never passed one) — derived the same way a live session's first
  // turn titles itself (`deriveSessionTitle(sanitizeTitleSource(...))`), off
  // the imported conversation's own first user message. No user message (or
  // one that derives to an empty heuristic title) ⇒ leave `title` unset,
  // byte-as-today.
  const firstUserText = firstImportedUserMessageText(imported.report.items);
  const title = firstUserText !== undefined ? deriveSessionTitle(sanitizeTitleSource(firstUserText)) : "";
  const session = await deps.persistence.createSession({
    id: randomUUID(),
    workspace,
    model,
    mode: request?.mode ?? "build",
    engineId: "core",
    ...(connectionId !== undefined ? { connectionId } : {}),
    ...(title.length > 0 ? { title } : {}),
  });
  // S4-1 arm 2 (W4-F1): register the picked model so the first resume overrides
  // the fork env's ANYCODE_MODEL. Recorded AFTER a successful createSession so a
  // failed create never leaves a stale pending entry.
  deps.recordPendingImportModel?.(session.id, model);
  await deps.persistence.appendHistory(session.id, imported.report.items);
  return { ok: true, sessionId: session.id, workspace: session.workspace, report: imported.report };
}

/** The handle returned by `registerCodexRolloutIpc` so main can wire the import model plane into tab-ipc. */
export interface CodexRolloutIpcHandle {
  /**
   * Reads-and-deletes the model an import pinned for `sessionId` (S4-1 arm 2,
   * consume-once). Main injects this as tab-ipc's `consumePendingImportModel`, so
   * the FIRST resume of an imported session overrides the fork env's ANYCODE_MODEL
   * to the user's pick; a second resume of the same session (already consumed), a
   * new tab, or any non-imported resume gets `undefined` — the map is only ever
   * populated by import, so those paths are byte-identical to today.
   */
  consumePendingImportModel(sessionId: string): string | undefined;
  /**
   * Reads WITHOUT deleting the model an import pinned for `sessionId` (S4-1 arm 2;
   * L4·1 peek-then-confirm). tab-ipc's resume path peeks the pick to stamp
   * ANYCODE_MODEL, then calls `consumePendingImportModel` ONLY after createTab
   * commits — so a refused resume (max_tabs / not_ready / already_open) leaves the
   * pick intact for a later retry instead of spending it on a tab that never opened.
   */
  peekPendingImportModel(sessionId: string): string | undefined;
}

export function registerCodexRolloutIpc(deps: CodexRolloutIpcDeps): CodexRolloutIpcHandle {
  // S4-1 arm 2 (W4-F1): the ephemeral pending-model map lives in THIS closure —
  // never persisted, never a session-row field. Import writes the pick; the
  // first resume (via the returned consumer, wired into tab-ipc) reads-and-deletes.
  const pendingImportModels = new Map<string, string>();
  const wired: CodexRolloutIpcDeps = {
    ...deps,
    recordPendingImportModel: (sessionId, model) => {
      pendingImportModels.set(sessionId, model);
    },
  };
  ipcMain.handle(CODEX_ROLLOUT_LIST_CHANNEL, (_event, raw: unknown) => handleCodexRolloutList(wired, raw));
  ipcMain.handle(CODEX_ROLLOUT_PREVIEW_CHANNEL, (_event, raw: unknown) => handleCodexRolloutPreview(wired, raw));
  ipcMain.handle(CODEX_ROLLOUT_IMPORT_CHANNEL, (_event, raw: unknown) => handleCodexRolloutImport(wired, raw));
  return {
    consumePendingImportModel(sessionId: string): string | undefined {
      const model = pendingImportModels.get(sessionId);
      if (model !== undefined) pendingImportModels.delete(sessionId);
      return model;
    },
    peekPendingImportModel(sessionId: string): string | undefined {
      return pendingImportModels.get(sessionId);
    },
  };
}
