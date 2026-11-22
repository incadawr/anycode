import { shell } from "electron";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { guardedIpcHandle } from "./ipc-guard.js";

const readSchema = z.object({ taskId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), sessionRef: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), outputFile: z.string().min(1).max(1024).optional() }).strict();
const LIMIT = 64 * 1024;
export type ClaudeTaskOutputRead = { ok: true; content: string; truncated: boolean } | { ok: false; reason: "unavailable" };

/** Claude's own task root: `<CLAUDE_CODE_TMPDIR or /tmp>/claude-<uid>`. */
export function claudeTmpRoot(): string | undefined {
  const uid = process.getuid?.();
  if (uid === undefined || (process.platform !== "darwin" && process.platform !== "linux")) return undefined;
  const base = process.env.CLAUDE_CODE_TMPDIR;
  return `${base && isAbsolute(base) ? base.replace(/\/+$/, "") : "/tmp"}/claude-${uid}`;
}

/** Resolved paths per (session, task): polling must not rescan the root. Always re-validated before use. */
const resolvedCache = new Map<string, string>();
const CACHE_LIMIT = 200;
/** Keys that resolved to nothing recently: a poll of a not-yet-existing file must not rescan the root every time. */
const missingUntil = new Map<string, number>();
const MISSING_TTL_MS = 10_000;
export function clearClaudeTaskOutputCache(): void { resolvedCache.clear(); missingUntil.clear(); }
function remember(key: string, path: string): void {
  resolvedCache.delete(key);
  if (resolvedCache.size >= CACHE_LIMIT) resolvedCache.delete(resolvedCache.keys().next().value as string);
  resolvedCache.set(key, path);
  missingUntil.delete(key);
}

const ownedPlainFile = (info: { isFile(): boolean; nlink: number; uid: number; mode: number }): boolean => {
  const uid = process.getuid?.();
  return info.isFile() && info.nlink === 1 && (uid === undefined || info.uid === uid) && (info.mode & 0o111) === 0;
};

async function validate(candidate: string, taskId: string, sessionRef: string, realRoot: string): Promise<string | undefined> {
  try {
    if (!isAbsolute(candidate) || (await lstat(candidate)).isSymbolicLink()) return undefined;
    const resolved = await realpath(candidate);
    const tasks = dirname(resolved), session = dirname(tasks), project = dirname(session);
    if (basename(resolved) !== `${taskId}.output` || basename(tasks) !== "tasks" || basename(session) !== sessionRef || dirname(project) !== realRoot) return undefined;
    return ownedPlainFile(await lstat(resolved)) ? resolved : undefined;
  } catch { return undefined; }
}

/**
 * Resolve a task's output file to a real path that is provably inside Claude's own
 * `<root>/<project>/<session>/tasks/<taskId>.output` layout, owned by this user, a plain
 * non-executable file. A path hint (from the CLI's tool result or notification) is only a
 * candidate: when it fails validation the conventional scan is tried instead.
 */
export async function resolveClaudeTaskOutput(raw: unknown, root: string | undefined = claudeTmpRoot()): Promise<string | undefined> {
  const parsed = readSchema.safeParse(raw);
  if (!parsed.success || !root) return undefined;
  const { taskId, sessionRef, outputFile } = parsed.data;
  try {
    const rootInfo = await lstat(root);
    const uid = process.getuid?.();
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || (uid !== undefined && rootInfo.uid !== uid) || (rootInfo.mode & 0o022) !== 0) return undefined;
    const realRoot = await realpath(root);
    const key = `${realRoot}\0${sessionRef}\0${taskId}`;
    const hinted = outputFile ? await validate(outputFile, taskId, sessionRef, realRoot) : undefined;
    if (hinted) { remember(key, hinted); return hinted; }
    const cached = resolvedCache.get(key);
    if (cached) {
      const again = await validate(cached, taskId, sessionRef, realRoot);
      if (again) return again;
      resolvedCache.delete(key);
    }
    if ((missingUntil.get(key) ?? 0) > Date.now()) return undefined;
    const found = await findClaudeTaskOutputHint(realRoot, taskId, sessionRef);
    const resolved = found ? await validate(found, taskId, sessionRef, realRoot) : undefined;
    if (resolved) remember(key, resolved);
    else {
      if (missingUntil.size >= CACHE_LIMIT) missingUntil.delete(missingUntil.keys().next().value as string);
      missingUntil.set(key, Date.now() + MISSING_TTL_MS);
    }
    return resolved;
  } catch { return undefined; }
}

/** Drop terminal control sequences and collapse carriage-return progress rewrites to the final state of each line. */
export function cleanTaskOutput(text: string): string {
  return text
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r\n/g, "\n")
    .split("\n").map(line => line.slice(line.lastIndexOf("\r") + 1)).join("\n");
}

/** Last `LIMIT` bytes of a validated task output; never follows links or reads devices. */
export async function readClaudeTaskOutput(raw: unknown, root?: string): Promise<ClaudeTaskOutputRead> {
  if (typeof constants.O_NOFOLLOW !== "number") return { ok: false, reason: "unavailable" };
  const resolved = await resolveClaudeTaskOutput(raw, root);
  if (!resolved) return { ok: false, reason: "unavailable" };
  try {
    const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = await handle.stat();
      const checked = await stat(resolved);
      if (!ownedPlainFile(opened) || opened.dev !== checked.dev || opened.ino !== checked.ino) return { ok: false, reason: "unavailable" };
      const start = Math.max(0, opened.size - LIMIT);
      const buf = Buffer.alloc(Math.min(opened.size, LIMIT));
      const { bytesRead } = await handle.read(buf, 0, buf.length, start);
      let text = buf.subarray(0, bytesRead).toString("utf8");
      // A tail starts mid-line (possibly mid-character): drop the partial first line.
      if (start > 0) { const newline = text.indexOf("\n"); text = newline < 0 ? "" : text.slice(newline + 1); }
      return { ok: true, content: cleanTaskOutput(text), truncated: start > 0 };
    } finally { await handle.close(); }
  } catch { return { ok: false, reason: "unavailable" }; }
}

/** Open with the OS handler; a `.output` file often has none, so fall back to revealing it in the file manager. */
export async function openClaudeTaskOutput(raw: unknown, root?: string, opener: { openPath(path: string): Promise<string>; showItemInFolder(path: string): void } = shell): Promise<{ ok: boolean }> {
  const resolved = await resolveClaudeTaskOutput(raw, root);
  if (!resolved) return { ok: false };
  try { if ((await opener.openPath(resolved)) === "") return { ok: true }; } catch { /* fall through to reveal */ }
  try { opener.showItemInFolder(resolved); return { ok: true }; } catch { return { ok: false }; }
}

/** Find the file in Claude's conventional temporary directory. Never grants access by itself: the result is re-validated. */
export async function findClaudeTaskOutputHint(root: string, taskId: string, sessionRef: string): Promise<string | undefined> {
  try {
    if ((await lstat(root)).isSymbolicLink()) return undefined;
    const entries = await readdir(root, { withFileTypes: true });
    const matches: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const project = join(root, entry.name);
      const session = join(project, sessionRef);
      const tasks = join(session, "tasks");
      const file = join(tasks, `${taskId}.output`);
      try {
        if (!(await lstat(project)).isDirectory() || !(await lstat(session)).isDirectory() || !(await lstat(tasks)).isDirectory()) continue;
        const info = await lstat(file);
        if (!info.isFile() || info.nlink !== 1) continue;
        matches.push(file);
        if (matches.length > 1) return undefined;
      } catch { /* A project may not contain this session. */ }
    }
    return matches[0];
  } catch { return undefined; }
}

export function registerClaudeTaskOutputIpc(): void {
  guardedIpcHandle("anycode:claude-task-output-read", (_event, request: unknown) => readClaudeTaskOutput(request));
  guardedIpcHandle("anycode:claude-task-output-open", (_event, request: unknown) => openClaudeTaskOutput(request));
}
