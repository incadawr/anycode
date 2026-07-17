/**
 * Trust policy for a CODEX_HOME directory we are about to hand to a spawned
 * `codex` child (codex-profiles cut §2.5) — the home holds `auth.json`, so it
 * is an object of protection no lesser than the binary itself. Structural
 * mirror of shared/codex-binary-trust.ts + main/codex-binary.ts: a pure
 * decision half (`checkCodexHomeTrust`, stat data in — verdict out) and a
 * filesystem read half (`checkCodexHomePathTrust`) kept in ONE main-side
 * module — main is the only process that asserts profile homes today; the
 * host asserts via the argv contract's own guard (amended §A1.2), not via a
 * main import.
 *
 * Policy (cut §2.5, read as two complementary rules):
 *  - REFUSAL rule — what we cannot fix: a home or any ancestor that is
 *    world-writable WITHOUT the sticky bit, or owned by a THIRD-PARTY uid, is
 *    refused. A linkedHome (external, not ours) with ANY group/other mode
 *    bits is refused too — a foreign directory is diagnosed, never chmod'ed.
 *  - REPAIR rule — what we can fix: OUR OWN profile home found wider than
 *    0700 is flagged for `chmod 0700` and the spawn continues ("чиним и
 *    продолжаем"). The lstat-guard (main/codex-profiles.ts, §A1.2)
 *    independently asserts `auth.json` afterwards, so a swap that happened
 *    while the home was briefly wide is still caught on its own terms.
 *
 * Checked on EVERY spawn (doctor / login / app-server resolve), not only at
 * profile creation — the same TOCTOU narrative as the binary trust gate.
 * Fail-closed: a refusing verdict means status `error` and NO spawn.
 *
 * win32 returns unchecked-ok (POSIX mode bits do not exist there) — an
 * UNCHECKED path, not a verified-safe one, exactly the stated residual of
 * shared/codex-binary-trust.ts.
 */
import { chmodSync, lstatSync, realpathSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { CodexPathStat } from "../shared/codex-binary-trust.js";

/** `0` is root: a root-owned ANCESTOR is trusted (root already owns the machine). The home itself must be OURS. */
const ROOT_UID = 0;

export interface CodexHomeTrustInput {
  /** The CODEX_HOME directory itself, symlinks resolved. */
  home: CodexPathStat;
  /** Full ancestor chain up to the filesystem root (same rationale as the binary gate: a writable grandparent swaps the child). */
  ancestors: readonly CodexPathStat[];
  /** `process.getuid()`. */
  uid: number;
  platform: NodeJS.Platform;
  /** true = our own `~/.anycode/codex/profile-<id>` (repairable); false = an external linkedHome (diagnose-only). */
  owned: boolean;
}

export type CodexHomeTrustVerdict =
  | { ok: true; /** true when an OWNED home was found wider than 0700 and must be chmod'ed back before the spawn. */ needsChmod: boolean }
  | { ok: false; reason: string };

/** Pure decision half — callers pass already-read stat data in. */
export function checkCodexHomeTrust(input: CodexHomeTrustInput): CodexHomeTrustVerdict {
  if (input.platform === "win32") return { ok: true, needsChmod: false };

  const home = input.home;
  const homeMode = home.mode & 0o7777;
  if (!home.isDirectory) {
    return { ok: false, reason: `Codex profile home is not a directory (${home.path})` };
  }
  if (home.uid !== input.uid) {
    return { ok: false, reason: `Codex profile home (${home.path}) is owned by another user (uid ${home.uid})` };
  }
  const homeWiderThanPrivate = (homeMode & 0o077) !== 0;
  if (homeWiderThanPrivate && !input.owned) {
    return {
      ok: false,
      reason: `Linked CODEX_HOME (${home.path}) has permissions wider than 0700 (mode ${(homeMode & 0o777).toString(8)}); it holds credentials and is not ours to chmod — remedy: chmod 700 ${home.path}`,
    };
  }

  for (const ancestor of input.ancestors) {
    if (!ancestor.isDirectory) {
      return { ok: false, reason: `Codex profile home ancestor is not a directory (${ancestor.path})` };
    }
    const mode = ancestor.mode & 0o7777;
    const worldWritable = (mode & 0o002) !== 0;
    const sticky = (mode & 0o1000) !== 0;
    if (worldWritable && !sticky) {
      return { ok: false, reason: `Codex profile home ancestor (${ancestor.path}) is world-writable without the sticky bit` };
    }
    if (ancestor.uid !== input.uid && ancestor.uid !== ROOT_UID) {
      return { ok: false, reason: `Codex profile home ancestor (${ancestor.path}) is owned by another user (uid ${ancestor.uid})` };
    }
  }

  return { ok: true, needsChmod: homeWiderThanPrivate };
}

/** The subset of filesystem reads the path half needs — a DI seam mirroring `CodexBinaryFs`. */
export interface CodexHomeFs {
  lstat(path: string): { isDirectory(): boolean; isSymbolicLink(): boolean; mode: number; uid: number };
  stat(path: string): { isDirectory(): boolean; mode: number; uid: number };
  realpath(path: string): string;
  chmod(path: string, mode: number): void;
}

const nodeFs: CodexHomeFs = {
  lstat(path) {
    return lstatSync(path);
  },
  stat(path) {
    return statSync(path);
  },
  realpath(path) {
    return realpathSync(path);
  },
  chmod(path, mode) {
    chmodSync(path, mode);
  },
};

export interface CheckCodexHomePathOptions {
  /** true = our own profile home (symlinked-away homes refused; wider modes chmod-repaired). */
  owned: boolean;
  fs?: CodexHomeFs;
  platform?: NodeJS.Platform;
  uid?: number;
}

/** Ancestor chain (exclusive of the home itself) up to the filesystem root, resolved-path based. */
function ancestorChain(resolvedHome: string): string[] {
  const ordered: string[] = [];
  let current = dirname(resolvedHome);
  for (;;) {
    ordered.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return ordered;
}

function toPathStat(path: string, stat: { isDirectory(): boolean; mode: number; uid: number }): CodexPathStat {
  return { path, isFile: !stat.isDirectory(), isDirectory: stat.isDirectory(), mode: stat.mode, uid: stat.uid, gid: 0 };
}

/**
 * Filesystem read half: stats the home + its full ancestor chain, runs the
 * pure policy, applies the chmod repair for an owned home. Returns a
 * human-readable refusal reason, or `null` when the home is safe to hand to
 * a spawn. Never throws — an unreadable/missing path is a refusal.
 */
export function checkCodexHomePathTrust(homeDir: string, options: CheckCodexHomePathOptions): string | null {
  const fs = options.fs ?? nodeFs;
  const platform = options.platform ?? process.platform;
  const uid = options.uid ?? process.getuid?.() ?? -1;
  if (platform === "win32") return null;
  try {
    // An OWN profile home replaced by a symlink is a redirection of everything
    // codex will write there (auth.json included) — refused outright, never
    // followed. A linkedHome is an explicit external pointer; resolve it.
    if (options.owned && fs.lstat(homeDir).isSymbolicLink()) {
      return `Codex profile home (${homeDir}) is a symlink — a profile home must be a real directory`;
    }
    const resolved = fs.realpath(homeDir);
    const verdict = checkCodexHomeTrust({
      home: toPathStat(resolved, fs.stat(resolved)),
      ancestors: ancestorChain(resolved).map((dir) => toPathStat(dir, fs.stat(dir))),
      uid,
      platform,
      owned: options.owned,
    });
    if (!verdict.ok) return verdict.reason;
    if (verdict.needsChmod) {
      fs.chmod(resolved, 0o700);
    }
    return null;
  } catch {
    return `Codex profile home does not exist or is unreadable (${homeDir})`;
  }
}
