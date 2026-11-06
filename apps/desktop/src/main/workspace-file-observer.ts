import * as nativeFs from "node:fs/promises";
import { posix, win32 } from "node:path";
import { performance } from "node:perf_hooks";
import { normalizePeerWorkspaceKey } from "./session-peer-policy.js";

interface Metadata {
  size: number; mtimeMs: number; ctimeMs: number; ino: number; dev: number;
  isSymbolicLink(): boolean; isDirectory(): boolean; isFile(): boolean;
}
type DirectoryEntries = AsyncIterable<{ name: string }> & { close?(): Promise<void> };
/** Deliberately excludes content reads. Directory iteration must be streaming. */
export interface WorkspaceMetadataFs {
  realpath(path: string): Promise<string>;
  lstat(path: string): Promise<Metadata>;
  opendir(path: string): DirectoryEntries | Promise<DirectoryEntries>;
}
export interface WorkspaceFileSample {
  coverage: "complete" | "partial" | "unknown";
  reason?: "disabled" | "disposed" | "deadline" | "cap" | "error";
  startsAt: number;
  at: number;
  entries: number;
  baseline: boolean;
  /** Coverage of the prior snapshot; changes cannot prove a complete interval without it. */
  baselineCoverage: "complete" | "partial" | "unknown";
  changes: { path: string; kind: "created" | "modified" | "deleted" }[];
}
interface Fingerprint { path: string; size: number; mtimeMs: number; ctimeMs: number; ino: number; dev: number }
const excluded = new Set([".git", "node_modules", ".cache", "cache"]);

/** Explicit refresh only: no timers or filesystem work until enabled and called.
 * Callers supply a main-authorized, pinned canonical workspace per generation.
 * Partial scans retain unvisited metadata; only complete scans infer deletions.
 */
export function createWorkspaceFileObserver(deps: {
  workspace: string;
  enabled(): boolean;
  fs?: WorkspaceMetadataFs;
  now?: () => number;
  platform?: NodeJS.Platform;
  maxEntries?: number;
  deadlineMs?: number;
}) {
  const fs = deps.fs ?? nativeFs;
  const now = deps.now ?? (() => performance.now());
  const platform = deps.platform ?? process.platform;
  const paths = platform === "win32" ? win32 : posix;
  const normalize = (path: string) => normalizePeerWorkspaceKey(path, platform);
  const root = normalize(deps.workspace);
  const limit = Math.max(1, Math.min(10000, Math.floor(deps.maxEntries ?? 10000) || 10000));
  const budget = Math.max(1, Math.min(2000, deps.deadlineMs ?? 2000));
  let baseline = new Map<string, Fingerprint>();
  let initialized = false, completeBaseline = false, disposed = false;
  let startsAt: number | undefined;
  let flight: Promise<WorkspaceFileSample> | undefined;
  let cancel: (() => void) | undefined;
  const relative = (path: string): string | null => {
    if (!root || path.length > 4096 || path.includes("\0")) return null;
    const canonical = normalize(path);
    if (!canonical) return null;
    const rel = paths.relative(root, canonical);
    if (paths.isAbsolute(rel) || rel === ".." || rel.startsWith(`..${paths.sep}`)) return null;
    if (rel.split(paths.sep).some(part => excluded.has(part))) return null;
    return rel;
  };
  function refresh(): Promise<WorkspaceFileSample> {
    if (flight && !disposed) return flight;
    const start = now();
    const result: WorkspaceFileSample = {
      coverage: "complete", startsAt: startsAt ?? start, at: start, entries: 0,
      baseline: !initialized, baselineCoverage: !initialized ? "unknown" : completeBaseline ? "complete" : "partial",
      changes: [],
    };
    if (disposed || !deps.enabled()) {
      return Promise.resolve({ ...result, coverage: "unknown", reason: disposed ? "disposed" : "disabled" });
    }
    startsAt ??= start;
    const seen = new Map<string, Fingerprint>();
    let stopped = false;
    const partial = (reason: WorkspaceFileSample["reason"]) => {
      if (stopped) return;
      result.coverage = "partial";
      result.reason ??= reason;
    };
    const alive = () => {
      if (stopped || disposed) return false;
      if (now() - start >= budget) { partial("deadline"); return false; }
      return true;
    };
    async function scan(directory: string): Promise<void> {
      if (!alive()) return;
      try {
        const stat = await fs.lstat(directory);
        if (!alive()) return;
        if (stat.isSymbolicLink() || !stat.isDirectory()) { partial("error"); return; }
        const canonical = await fs.realpath(directory);
        if (!alive()) return;
        if (relative(canonical) === null || normalize(canonical) !== normalize(directory)) { partial("error"); return; }
        const entries = await fs.opendir(directory);
        if (!alive()) { await entries.close?.(); return; }
        for await (const entry of entries) {
          if (!alive()) return;
          if (result.entries >= limit) { partial("cap"); return; }
          result.entries++;
          const name = entry.name;
          if (!name || name === "." || name === ".." || name.includes("\0") || name.includes("/") ||
            (platform === "win32" && /[\\:]/.test(name))) { partial("error"); continue; }
          if (excluded.has(platform === "win32" ? name.toLowerCase() : name)) continue;
          const file = paths.join(directory, name);
          if (relative(file) === null) { partial("error"); continue; }
          try {
            const metadata = await fs.lstat(file);
            if (!alive()) return;
            if (metadata.isSymbolicLink()) continue;
            if (metadata.isDirectory()) await scan(file);
            else if (metadata.isFile()) {
              const canonicalFile = await fs.realpath(file);
              if (!alive()) return;
              const key = relative(canonicalFile);
              if (!key || normalize(canonicalFile) !== normalize(file)) { partial("error"); continue; }
              seen.set(key, { path: paths.relative(deps.workspace, canonicalFile),
                size: metadata.size, mtimeMs: metadata.mtimeMs, ctimeMs: metadata.ctimeMs,
                ino: metadata.ino, dev: metadata.dev });
            }
          } catch { partial("error"); }
          if (!alive() || result.reason === "cap") return;
        }
      } catch { partial("error"); }
    }
    let workSettled = false;
    const work = scan(deps.workspace).finally(() => { workSettled = true; });
    let timer: ReturnType<typeof setTimeout>;
    const interrupt = new Promise<void>(resolve => {
      cancel = () => { stopped = true; result.coverage = "unknown"; result.reason = "disposed"; resolve(); };
      timer = setTimeout(() => { partial("deadline"); stopped = true; resolve(); }, budget);
    });
    flight = Promise.race([work, interrupt]).then(() => {
      stopped = true;
      clearTimeout(timer);
      cancel = undefined;
      result.at = now();
      if (disposed || !deps.enabled()) {
        result.coverage = "unknown"; result.reason = disposed ? "disposed" : "disabled";
        return result;
      }
      if (initialized) {
        for (const [key, value] of seen) {
          const old = baseline.get(key);
          if (!old) {
            if (completeBaseline) result.changes.push({ path: value.path, kind: "created" });
          } else if (["size", "mtimeMs", "ctimeMs", "ino", "dev"].some(field =>
            old[field as keyof Fingerprint] !== value[field as keyof Fingerprint])) {
            result.changes.push({ path: value.path, kind: "modified" });
          }
        }
        if (result.coverage === "complete") for (const [key, old] of baseline) {
          if (!seen.has(key)) result.changes.push({ path: old.path, kind: "deleted" });
        }
      }
      result.changes.sort((a, b) => a.path.localeCompare(b.path));
      if (result.coverage === "complete") baseline = seen;
      else for (const [key, value] of seen) {
        if (baseline.has(key) || baseline.size < limit) baseline.set(key, value);
      }
      initialized = true;
      completeBaseline = result.coverage === "complete";
      return result;
    }).finally(() => {
      // Native metadata IO cannot be aborted. Keep single-flight until it drains.
      if (workSettled) flight = undefined;
      else void work.then(() => { flight = undefined; }, () => { flight = undefined; });
    });
    return flight;
  }
  return {
    refresh,
    dispose() { disposed = true; cancel?.(); baseline.clear(); },
  };
}
