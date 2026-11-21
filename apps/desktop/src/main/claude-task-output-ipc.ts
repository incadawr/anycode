import { dialog } from "electron";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { guardedIpcHandle } from "./ipc-guard.js";

const requestSchema = z.object({ taskId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), sessionRef: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) }).strict();
const LIMIT = 64 * 1024;
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
  guardedIpcHandle("anycode:claude-task-output-pick", (_event, request: unknown) => pickClaudeTaskOutput(request));
}
