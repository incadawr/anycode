import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, posix, win32 } from "node:path";
import { z } from "zod";

/** Lexical canonicalisation only; access additionally requires successful realpath/stat. */
export function normalizePeerWorkspaceKey(value: string, platform = process.platform): string | null {
  if (!value || value.includes("\0")) return null;
  const paths = platform === "win32" ? win32 : posix;
  if (!paths.isAbsolute(value)) return null;
  if (platform === "win32") {
    const windows = value.replaceAll("/", "\\");
    if (windows.startsWith("\\\\?\\") || windows.startsWith("\\\\.\\")) return null;
    if (!/^(?:[a-z]:\\|\\\\[^\\]+\\[^\\]+(?:\\|$))/i.test(windows)) return null;
    if (windows.slice(2).includes(":")) return null;
  }
  const normalized = paths.normalize(value);
  const root = paths.parse(normalized).root;
  const trailing = platform === "win32" ? /[/\\]+$/ : /\/+$/;
  const key = normalized.length > root.length ? normalized.replace(trailing, "") : normalized;
  return platform === "win32" ? key.toLowerCase() : key;
}

const schema = z.strictObject({
  version: z.literal(1), off: z.array(z.string()), grants: z.array(z.tuple([z.string(), z.string()])),
});
type Policy = z.infer<typeof schema>;
export interface SessionPeerPolicyStore {
  isNativeEnabled(key: string): boolean;
  hasPairGrant(a: string, b: string): boolean;
  /** Main/UI only: never pass a model request to these mutators. */
  setNativeEnabled(key: string, enabled: boolean): boolean;
  setPairGrant(a: string, b: string, granted: boolean): boolean;
}

/** Missing file uses trusted-workspace defaults; corrupt/unreadable storage disables access. */
export function createSessionPeerPolicyStore(deps: { file: string; platform?: NodeJS.Platform }): SessionPeerPolicyStore {
  const validKey = (key: string) => normalizePeerWorkspaceKey(key, deps.platform) === key;
  let state: Policy = { version: 1, off: [], grants: [] };
  let healthy = true;
  try {
    const parsed = schema.parse(JSON.parse(readFileSync(deps.file, "utf8")));
    if (!parsed.off.every(validKey) || !parsed.grants.every(([a, b]) => validKey(a) && validKey(b) && a !== b)) throw new Error("Invalid workspace key");
    state = parsed;
  } catch (error) {
    healthy = (error as NodeJS.ErrnoException).code === "ENOENT";
  }
  const pair = (a: string, b: string): [string, string] => a < b ? [a, b] : [b, a];
  const has = (a: string, b: string) => state.grants.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
  const save = (next: Policy): boolean => {
    if (!healthy) return false;
    const temporary = `${deps.file}.${randomUUID()}.tmp`;
    try {
      mkdirSync(dirname(deps.file), { recursive: true, mode: 0o700 });
      writeFileSync(temporary, JSON.stringify(next), { mode: 0o600, flag: "wx" });
      renameSync(temporary, deps.file);
      state = next;
      return true;
    } catch { return false; }
    finally { try { rmSync(temporary, { force: true }); } catch { /* no authority from cleanup */ } }
  };
  return {
    isNativeEnabled: key => healthy && validKey(key) && !state.off.includes(key),
    hasPairGrant: (a, b) => healthy && validKey(a) && validKey(b) && has(a, b),
    setNativeEnabled(key, enabled) {
      if (!validKey(key)) return false;
      return save({ ...state, off: enabled ? state.off.filter(p => p !== key) : [...new Set([...state.off, key])] });
    },
    setPairGrant(a, b, granted) {
      if (!validKey(a) || !validKey(b) || a === b) return false;
      const grants = state.grants.filter(([x, y]) => !((x === a && y === b) || (x === b && y === a)));
      if (granted) grants.push(pair(a, b));
      return save({ ...state, grants });
    },
  };
}
