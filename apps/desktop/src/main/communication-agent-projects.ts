/**
 * Main-owned per-project "agents may open tasks here" switch (Taskana 4768).
 * The unit is the PROJECT, keyed by the canonical workspace key (symlink-safe,
 * see `canonicalWorkspaceKey`). Stored in a 0600 file beside the other
 * Sessions API switches and written only by main. Default is OFF everywhere.
 *
 * Fail closed: a corrupt or unreadable file reads as empty; a non-`true` entry
 * is dropped; a failed write keeps the previous state.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { z } from "zod";
import { canonicalWorkspaceKey } from "@anycode/core/workspace-trust";

const fileSchema = z.record(z.string(), z.unknown());

export interface AgentProjectsStoreDeps {
  /** Absolute path of the switch file (under the user-data directory). */
  file: string;
  /** Used to canonicalise a workspace to its realpath key. */
  realpathSync(path: string): string;
}

export interface AgentProjectsStore {
  /** True only when the canonical key of `workspace` was switched on. */
  isAllowed(workspace: string): boolean;
  /** Switches the canonical key of `workspace`; false (state unchanged) when the write failed. */
  setAllowed(workspace: string, allowed: boolean): boolean;
  /** Exact stored keys that are ON (main-listed only; the renderer never supplies these as paths). */
  allowedKeys(): string[];
  hasExactKey(key: string): boolean;
  /** Removes an EXACT stored key; false for an unknown key or a failed write. */
  forgetExactKey(key: string): boolean;
}

function load(file: string): Set<string> {
  const keys = new Set<string>();
  try {
    const parsed = fileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (parsed.success) for (const [key, value] of Object.entries(parsed.data)) if (value === true) keys.add(key);
  } catch { /* corrupt or absent: empty (fail closed) */ }
  return keys;
}

function persist(file: string, keys: Set<string>): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(Object.fromEntries([...keys].map((key) => [key, true]))), { mode: 0o600, flag: "wx" });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function createAgentProjectsStore(deps: AgentProjectsStoreDeps): AgentProjectsStore {
  const keys = load(deps.file);
  const keyOf = (workspace: string) => canonicalWorkspaceKey(workspace, deps.realpathSync);
  const write = (mutate: () => void, revert: () => void): boolean => {
    mutate();
    try {
      persist(deps.file, keys);
      return true;
    } catch {
      revert();
      return false;
    }
  };
  return {
    isAllowed(workspace) {
      return keys.has(keyOf(workspace));
    },
    setAllowed(workspace, allowed) {
      const key = keyOf(workspace);
      const had = keys.has(key);
      if (had === allowed) return true;
      return write(() => { if (allowed) keys.add(key); else keys.delete(key); }, () => { if (had) keys.add(key); else keys.delete(key); });
    },
    allowedKeys() {
      return [...keys];
    },
    hasExactKey(key) {
      return keys.has(key);
    },
    forgetExactKey(key) {
      if (!keys.has(key)) return false;
      return write(() => { keys.delete(key); }, () => { keys.add(key); });
    },
  };
}
