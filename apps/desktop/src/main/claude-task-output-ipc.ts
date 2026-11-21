import { dialog } from "electron";
import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute } from "node:path";
import { z } from "zod";
import { guardedIpcHandle } from "./ipc-guard.js";

const requestSchema = z.object({ taskId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), sessionRef: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) }).strict();
const LIMIT = 64 * 1024;
interface Picker { showOpenDialog(options: { properties: ["openFile"]; filters: { name: string; extensions: string[] }[] }): Promise<{ canceled: boolean; filePaths: string[] }> }

/** An explicit, one-file user choice; a renderer-provided path is never read. */
export async function pickClaudeTaskOutput(raw: unknown, picker: Picker = dialog): Promise<{ ok: true; content: string } | { ok: false; reason: "cancelled" | "unavailable" }> {
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success || typeof constants.O_NOFOLLOW !== "number") return { ok: false, reason: "unavailable" };
  try {
    const choice = await picker.showOpenDialog({ properties: ["openFile"], filters: [{ name: "Claude task output", extensions: ["output"] }] });
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
