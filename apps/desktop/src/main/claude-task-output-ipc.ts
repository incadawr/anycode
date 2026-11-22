import { dialog, shell } from "electron";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { guardedIpcHandle } from "./ipc-guard.js";

const requestSchema = z.object({ taskId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), sessionRef: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) }).strict();
const readSchema = z.object({ taskId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), sessionRef: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), outputFile: z.string().min(1).max(1024).optional() }).strict();
const LIMIT = 64 * 1024;
export type ClaudeTaskOutputRead = { ok: true; content: string; truncated: boolean } | { ok: false; reason: "unavailable" };

function claudeTmpRoot(): string | undefined {
  const uid = process.getuid?.();
  return uid !== undefined && (process.platform === "darwin" || process.platform === "linux") ? `/tmp/claude-${uid}` : undefined;
}

/**
 * Resolve a task's output file to a real path that is provably inside Claude's own
 * `<root>/<project>/<session>/tasks/<taskId>.output` layout. A path hint (from the CLI's tool
 * result or notification) is only a candidate: it is re-checked, never trusted.
 */
export async function resolveClaudeTaskOutput(raw: unknown, root: string | undefined = claudeTmpRoot()): Promise<string | undefined> {
  const parsed = readSchema.safeParse(raw);
  if (!parsed.success || !root) return undefined;
  const { taskId, sessionRef, outputFile } = parsed.data;
  try {
    const realRoot = await realpath(root);
    const candidate = outputFile ?? await findClaudeTaskOutputHint(root, taskId, sessionRef);
    if (!candidate || !isAbsolute(candidate) || (await lstat(candidate)).isSymbolicLink()) return undefined;
    const resolved = await realpath(candidate);
    const tasks = dirname(resolved), session = dirname(tasks), project = dirname(session);
    if (basename(resolved) !== `${taskId}.output` || basename(tasks) !== "tasks" || basename(session) !== sessionRef || dirname(project) !== realRoot) return undefined;
    return resolved;
  } catch { return undefined; }
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
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== checked.dev || opened.ino !== checked.ino) return { ok: false, reason: "unavailable" };
      const start = Math.max(0, opened.size - LIMIT);
      const buf = Buffer.alloc(Math.min(opened.size, LIMIT));
      const { bytesRead } = await handle.read(buf, 0, buf.length, start);
      return { ok: true, content: buf.subarray(0, bytesRead).toString("utf8"), truncated: start > 0 };
    } finally { await handle.close(); }
  } catch { return { ok: false, reason: "unavailable" }; }
}

export async function openClaudeTaskOutput(raw: unknown, root?: string, opener: { openPath(path: string): Promise<string> } = shell): Promise<{ ok: boolean }> {
  const resolved = await resolveClaudeTaskOutput(raw, root);
  if (!resolved) return { ok: false };
  try { return { ok: (await opener.openPath(resolved)) === "" }; } catch { return { ok: false }; }
}
interface Picker { showOpenDialog(options: { properties: ["openFile"]; filters: { name: string; extensions: string[] }[]; defaultPath?: string }): Promise<{ canceled: boolean; filePaths: string[] }> }

/** Find a dialog hint in Claude's conventional temporary directory. Never grants access. */
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

/** An explicit, one-file user choice; a renderer-provided path is never read. */
export async function pickClaudeTaskOutput(raw: unknown, picker: Picker = dialog): Promise<{ ok: true; content: string } | { ok: false; reason: "cancelled" | "unavailable" }> {
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success || typeof constants.O_NOFOLLOW !== "number") return { ok: false, reason: "unavailable" };
  try {
    const uid = process.getuid?.();
    const root = uid !== undefined && (process.platform === "darwin" || process.platform === "linux") ? `/tmp/claude-${uid}` : undefined;
    const hint = root ? await findClaudeTaskOutputHint(root, parsed.data.taskId, parsed.data.sessionRef) : undefined;
    const choice = await picker.showOpenDialog({ properties: ["openFile"], filters: [{ name: "Claude task output", extensions: ["output"] }], ...(hint ? { defaultPath: hint } : {}) });
    if (choice.canceled || !choice.filePaths[0]) return { ok: false, reason: "cancelled" };
    const selected = choice.filePaths[0];
    if (!isAbsolute(selected) || (await lstat(selected)).isSymbolicLink()) return { ok: false, reason: "unavailable" };
    const resolved = await realpath(selected);
    if (basename(selected) !== `${parsed.data.taskId}.output` || basename(dirname(selected)) !== "tasks" || basename(dirname(dirname(selected))) !== parsed.data.sessionRef || basename(resolved) !== `${parsed.data.taskId}.output` || basename(dirname(resolved)) !== "tasks" || basename(dirname(dirname(resolved))) !== parsed.data.sessionRef) return { ok: false, reason: "unavailable" };
    const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = await handle.stat();
      const checked = await stat(resolved);
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== checked.dev || opened.ino !== checked.ino) return { ok: false, reason: "unavailable" };
      const buf = Buffer.alloc(LIMIT + 1);
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
      return { ok: true, content: buf.subarray(0, Math.min(bytesRead, LIMIT)).toString("utf8") + (bytesRead > LIMIT ? "\n[Output truncated]" : "") };
    } finally { await handle.close(); }
  } catch { return { ok: false, reason: "unavailable" }; }
}

export function registerClaudeTaskOutputIpc(): void {
  guardedIpcHandle("anycode:claude-task-output-read", (_event, request: unknown) => readClaudeTaskOutput(request));
  guardedIpcHandle("anycode:claude-task-output-open", (_event, request: unknown) => openClaudeTaskOutput(request));
  guardedIpcHandle("anycode:claude-task-output-pick", (_event, request: unknown) => pickClaudeTaskOutput(request));
}
