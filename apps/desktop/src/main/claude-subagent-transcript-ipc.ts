import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { z } from "zod";
import { guardedIpcHandle } from "./ipc-guard.js";
import { parseClaudeSubagentTranscript, type ClaudeSubagentTranscriptResult } from "../shared/claude-subagent-transcript.js";

/**
 * Read-only view of the Claude CLI's own subagent transcript.
 *
 * Real layout (verified against CLI 2.1.x): `<config>/projects/<project>/<sessionRef>/subagents/agent-<id>.jsonl`
 * with a sibling `agent-<id>.meta.json` whose `toolUseId` is the parent's Agent tool_use id,
 * i.e. the card's `toolCallId`. The renderer sends only two validated ids; the path is built
 * and checked here and never comes from the renderer.
 */
const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const requestSchema = z.object({ sessionRef: idSchema, toolCallId: idSchema }).strict();
const READ_LIMIT = 2 * 1024 * 1024;
const META_LIMIT = 16 * 1024;
const AGENT_FILE = /^agent-[A-Za-z0-9_-]{1,128}\.jsonl$/;

export function defaultClaudeProjectRoots(): string[] {
  const roots = [join(homedir(), ".claude", "projects")];
  const configured = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (configured) roots.unshift(join(configured, "projects"));
  return roots;
}

async function safeDir(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

async function readBounded(path: string, limit: number, fromTail: boolean): Promise<{ text: string; truncatedHead: boolean } | null> {
  if (typeof constants.O_NOFOLLOW !== "number") return null;
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) return null;
    const start = fromTail && info.size > limit ? info.size - limit : 0;
    const length = Math.min(info.size - start, limit);
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, start);
    let text = buf.subarray(0, bytesRead).toString("utf8");
    if (start > 0) {
      // The window starts mid-line: drop the partial first line.
      const newline = text.indexOf("\n");
      text = newline === -1 ? "" : text.slice(newline + 1);
    }
    return { text, truncatedHead: start > 0 };
  } finally {
    await handle.close();
  }
}

/** Finds `agent-*.jsonl` whose meta names `toolCallId`, under `<root>/<project>/<sessionRef>/subagents`. */
export async function findClaudeSubagentTranscript(roots: readonly string[], sessionRef: string, toolCallId: string): Promise<string | undefined> {
  const matches: string[] = [];
  for (const root of roots) {
    if (!(await safeDir(root))) continue;
    let projects: string[];
    try {
      projects = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const project of projects) {
      const dir = join(root, project, sessionRef, "subagents");
      if (!(await safeDir(join(root, project))) || !(await safeDir(join(root, project, sessionRef))) || !(await safeDir(dir))) continue;
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!AGENT_FILE.test(name)) continue;
        try {
          const metaPath = join(dir, name.replace(/\.jsonl$/, ".meta.json"));
          const meta = await readBounded(metaPath, META_LIMIT, false);
          if (meta === null) continue;
          const parsed = JSON.parse(meta.text) as { toolUseId?: unknown };
          if (parsed.toolUseId === toolCallId) matches.push(join(dir, name));
        } catch { /* no/invalid meta: not this agent */ }
      }
    }
  }
  return matches.length === 1 ? matches[0] : undefined;
}

export async function readClaudeSubagentTranscript(raw: unknown, roots: readonly string[] = defaultClaudeProjectRoots()): Promise<ClaudeSubagentTranscriptResult> {
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "unavailable" };
  try {
    const file = await findClaudeSubagentTranscript(roots, parsed.data.sessionRef, parsed.data.toolCallId);
    if (file === undefined) return { ok: false, reason: "not_found" };
    // Containment: the resolved file must still live under one of the roots.
    const resolved = await realpath(file);
    const realRoots = await Promise.all(roots.map((root) => realpath(root).catch(() => null)));
    if (!realRoots.some((root) => root !== null && resolved.startsWith(root + sep))) return { ok: false, reason: "unavailable" };
    const body = await readBounded(file, READ_LIMIT, true);
    if (body === null) return { ok: false, reason: "unavailable" };
    const { entries, droppedEntries } = parseClaudeSubagentTranscript(body.text);
    return { ok: true, entries, droppedEntries, truncatedHead: body.truncatedHead };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

export function registerClaudeSubagentTranscriptIpc(): void {
  guardedIpcHandle("anycode:claude-subagent-transcript-read", (_event, request: unknown) => readClaudeSubagentTranscript(request));
}

