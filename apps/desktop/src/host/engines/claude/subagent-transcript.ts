import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { z } from "zod";
import { parseClaudeSubagentTranscript, type ClaudeSubagentTranscriptResult } from "../../../shared/claude-subagent-transcript.js";

/**
 * Read-only lookup of the Claude CLI's own subagent transcript, run in the host
 * next to the engine that knows the real session id, config dir and cwd.
 *
 * Real layout (verified against CLI 2.1.x): `<config>/projects/<project>/<sessionRef>/subagents/agent-<id>.jsonl`
 * with a sibling `agent-<id>.meta.json` whose `toolUseId` is the parent's Agent tool_use id,
 * i.e. the card's `toolCallId`. `<project>` is the session cwd with every non-alphanumeric
 * character replaced by "-". The renderer supplies only the tool call id.
 */
const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const requestSchema = z.object({ sessionRef: idSchema, toolCallId: idSchema }).strict();
const READ_LIMIT = 2 * 1024 * 1024;
const META_LIMIT = 16 * 1024;
const AGENT_FILE = /^agent-[A-Za-z0-9_-]{1,128}\.jsonl$/;

/** The CLI's folder name for a working directory. */
export function claudeProjectFolderName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
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

async function matchInProject(root: string, project: string, sessionRef: string, toolCallId: string): Promise<string[]> {
  const dir = join(root, project, sessionRef, "subagents");
  if (!(await safeDir(join(root, project))) || !(await safeDir(join(root, project, sessionRef))) || !(await safeDir(dir))) return [];
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const matches: string[] = [];
  for (const name of names) {
    if (!AGENT_FILE.test(name)) continue;
    try {
      const meta = await readBounded(join(dir, name.replace(/\.jsonl$/, ".meta.json")), META_LIMIT, false);
      if (meta === null) continue;
      const parsed = JSON.parse(meta.text) as { toolUseId?: unknown };
      if (parsed.toolUseId === toolCallId) matches.push(join(dir, name));
    } catch { /* no/invalid meta: not this agent */ }
  }
  return matches;
}

/**
 * Finds the `agent-*.jsonl` whose meta names `toolCallId`. Roots are
 * realpath'd (a symlinked `~/.claude/projects` works; descendants must still be
 * real directories) and de-duplicated by realpath. The project folder is built
 * from `cwd` when given; the projects/* scan is only a fallback.
 */
export async function findClaudeSubagentTranscript(
  roots: readonly string[],
  sessionRef: string,
  toolCallId: string,
  cwd?: string,
): Promise<string | undefined> {
  const real = new Set<string>();
  for (const root of roots) {
    try {
      const resolved = await realpath(root);
      if (await safeDir(resolved)) real.add(resolved);
    } catch { /* missing root */ }
  }
  const found = new Set<string>();
  for (const root of real) {
    const guesses = new Set<string>();
    if (cwd !== undefined && cwd.length > 0) {
      guesses.add(claudeProjectFolderName(cwd));
      try { guesses.add(claudeProjectFolderName(await realpath(cwd))); } catch { /* cwd gone */ }
    }
    for (const project of guesses) for (const file of await matchInProject(root, project, sessionRef, toolCallId)) found.add(file);
    if (found.size > 0) continue;
    let projects: string[];
    try {
      projects = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const project of projects) {
      if (guesses.has(project)) continue;
      for (const file of await matchInProject(root, project, sessionRef, toolCallId)) found.add(file);
    }
  }
  return found.size === 1 ? [...found][0] : undefined;
}

export interface ClaudeSubagentTranscriptLocation {
  roots: readonly string[];
  cwd?: string;
  /** Resolved-path cache shared across calls, keyed `<sessionRef>\0<toolCallId>`. */
  cache?: Map<string, string>;
}

export async function readClaudeSubagentTranscript(raw: unknown, location: ClaudeSubagentTranscriptLocation): Promise<ClaudeSubagentTranscriptResult> {
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "unavailable" };
  try {
    const key = `${parsed.data.sessionRef}\0${parsed.data.toolCallId}`;
    let file = location.cache?.get(key);
    if (file === undefined) {
      file = await findClaudeSubagentTranscript(location.roots, parsed.data.sessionRef, parsed.data.toolCallId, location.cwd);
      if (file === undefined) return { ok: false, reason: "not_found" };
    }
    // Containment: the resolved file must still live under one of the (real) roots.
    const resolved = await realpath(file);
    const realRoots = await Promise.all(location.roots.map((root) => realpath(root).catch(() => null)));
    if (!realRoots.some((root) => root !== null && resolved.startsWith(root + sep))) return { ok: false, reason: "unavailable" };
    const body = await readBounded(file, READ_LIMIT, true);
    if (body === null) {
      location.cache?.delete(key);
      return { ok: false, reason: "unavailable" };
    }
    location.cache?.set(key, file);
    const { entries, droppedEntries } = parseClaudeSubagentTranscript(body.text, { startedMidFile: body.truncatedHead });
    return { ok: true, entries, droppedEntries, truncatedHead: body.truncatedHead };
  } catch {
    location.cache?.delete(`${parsed.data.sessionRef}\0${parsed.data.toolCallId}`);
    return { ok: false, reason: "unavailable" };
  }
}
