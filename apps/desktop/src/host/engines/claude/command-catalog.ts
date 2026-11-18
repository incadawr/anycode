import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";

export interface ClaudeCommandRow {
  name: string;
  scope: "project" | "personal";
  description: string;
  argumentHint?: string;
}

/** Parse only the small, single-line frontmatter subset used by the menu. */
export function readClaudeCommandFrontmatter(text: string): { description: string; argumentHint?: string; hidden: boolean } {
  const fallback = { description: "Custom command", hidden: false };
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return fallback;
  const end = lines.indexOf("---", 1);
  if (end < 0) return fallback;
  const fields = new Map<string, string>();
  for (const line of lines.slice(1, end)) {
    const match = /^(description|argument-hint|user-invocable):\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2]!;
    if (value.startsWith('"') || value.startsWith("'")) {
      if (value.length < 2 || value.at(-1) !== value[0]) return fallback;
      value = value.slice(1, -1);
    } else if (/^[|>{}\[\]&*!]/.test(value)) return fallback;
    fields.set(match[1]!, value.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim());
  }
  const description = fields.get("description")?.slice(0, 320) || fallback.description;
  const argumentHint = fields.get("argument-hint")?.slice(0, 120);
  return { description, ...(argumentHint ? { argumentHint } : {}), hidden: fields.get("user-invocable") === "false" };
}

/** Bounded, best-effort scan. An overflowing root is discarded in full. */
export async function scanClaudeCommandRoot(root: string, scope: ClaudeCommandRow["scope"]): Promise<ClaudeCommandRow[]> {
  let entries = 0, files = 0;
  const rows: ClaudeCommandRow[] = [];
  class Overflow extends Error {}
  async function walk(dir: string, parts: string[]): Promise<void> {
    const stat = await lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (++entries > 2048) throw new Overflow();
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (parts.length < 6 && /^[A-Za-z0-9_-]+$/.test(entry.name)) await walk(full, [...parts, entry.name]);
      } else if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "SKILL.md") {
        const stem = entry.name.slice(0, -3);
        if (!/^[A-Za-z0-9_-]+$/.test(stem)) continue;
        const name = [...parts, stem].join(":");
        if (name.length > 160 || name.startsWith("anthropic-skills")) continue;
        if (++files > 256) throw new Overflow();
        try {
          const info = await lstat(full);
          if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) continue;
          const handle = await open(full, "r");
          try {
            const buffer = Buffer.alloc(16 * 1024);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            const metadata = readClaudeCommandFrontmatter(buffer.subarray(0, bytesRead).toString("utf8"));
            if (!metadata.hidden) rows.push({ name, scope, description: metadata.description, ...(metadata.argumentHint ? { argumentHint: metadata.argumentHint } : {}) });
          } finally { await handle.close(); }
        } catch { /* inaccessible or replaced file */ }
      }
    }
  }
  try { await walk(root, []); } catch { return []; }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

/** Cache is owned by one runtime; invalidation also retires in-flight scans. */
export function createClaudeCommandCatalog(roots: { project?: string; personal?: string }) {
  let generation = 0;
  let cached: { at: number; rows: ClaudeCommandRow[] } | undefined;
  let pending: Promise<ClaudeCommandRow[]> | undefined;
  return {
    invalidate() { generation++; cached = undefined; pending = undefined; },
    list(): Promise<ClaudeCommandRow[]> {
      if (cached && Date.now() - cached.at < 2000) return Promise.resolve(cached.rows);
      if (pending) return pending;
      const current = generation;
      const promise = (async () => {
        const [project, personal] = await Promise.all([
          roots.project ? scanClaudeCommandRoot(roots.project, "project") : [],
          roots.personal ? scanClaudeCommandRoot(roots.personal, "personal") : [],
        ]);
        const names = new Set(personal.map(row => row.name));
        const rows = [...project.filter(row => !names.has(row.name)), ...personal];
        if (generation === current) cached = { at: Date.now(), rows };
        return generation === current ? rows : [];
      })();
      pending = promise;
      void promise.finally(() => { if (pending === promise) pending = undefined; });
      return promise;
    },
  };
}
