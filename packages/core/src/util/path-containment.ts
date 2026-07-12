/**
 * Symlink-RESOLVED own-root containment (P7.21 W1, design §2-D8). EXTRACTED
 * verbatim from `skills/admin-scan.ts` (W6-FIX-hardened, incl. the P1-1
 * dangling-symlink lstat fix and refused symlinked roots) so BOTH the skills
 * admin surface and the new subagents admin surface prove destructive-op custody
 * against ONE implementation. `skills/admin-scan.ts` re-exports these
 * byte-compatibly.
 *
 * ⚠ Main-safe leaf: node:path + FileSystemPort only — NO ai-SDK, no loop.
 *
 * P1-3 (ACCEPTED residual, inherited): containment is proven on a realpath
 * STRING, not a pinned directory handle (openat/O_DIRECTORY), so a purely-local
 * attacker who wins the race between this resolve and the subsequent write could
 * still redirect it. Fully closing it needs dir-fd handles the FileSystemPort
 * does not expose; the deterministic bypasses (dangling/symlinked roots,
 * P1-1/P1-2) are closed, leaving only an active local-attacker race.
 */

import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { FileSystemPort } from "../ports/file-system.js";

/**
 * Realpath of the DEEPEST existing ancestor of `path`, with any not-yet-existing
 * leaf segments appended lexically. Used so containment is checked on the REAL
 * (symlink-resolved) path even when the leaf (a fresh import/profile file) does
 * not exist yet. Returns undefined when the port cannot realpath (fail closed) or
 * nothing along the chain exists.
 *
 * P1-1 (W6-FIX): presence is probed with `lstat` (which does NOT follow a final
 * link), NOT `exists` (which does). A DANGLING symlink component
 * (`.anycode/agents -> /tmp/out` whose target is absent) reads as non-existent
 * under `exists`, so the old walk skipped past it and lexically reconstructed the
 * link's OWN path — letting a later `writeFile`/`mkdir -p` follow the link and
 * escape the catalog. With `lstat`, a dangling link IS "present" and `realpath`
 * on it THROWS, so we fail closed (undefined). A live symlink resolves to its
 * real target and is then containment-checked normally.
 */
export async function realpathExistingAncestor(
  fs: FileSystemPort,
  path: string,
): Promise<string | undefined> {
  if (typeof fs.realpath !== "function") {
    return undefined;
  }
  const probePresence = async (p: string): Promise<boolean> => {
    if (typeof fs.lstat === "function") {
      try {
        await fs.lstat(p);
        return true; // present as a regular file/dir OR a dangling symlink
      } catch {
        return false;
      }
    }
    return fs.exists(p);
  };
  let current = resolve(path);
  const tail: string[] = [];
  for (;;) {
    if (await probePresence(current)) {
      try {
        const real = await fs.realpath(current);
        return tail.length > 0 ? join(real, ...tail.slice().reverse()) : real;
      } catch {
        return undefined; // dangling / unresolvable symlink — fail closed
      }
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined; // reached the filesystem root with nothing existing
    }
    tail.push(basename(current));
    current = parent;
  }
}

/**
 * Resolves ONE own-catalog root to a trusted real path, or undefined when the
 * root must NOT be trusted. A root whose FINAL component is itself a symbolic
 * link is rejected (undefined): a `<ws>/.anycode/agents -> /tmp/outside` symlink
 * is not a legitimate own catalog and must never anchor a delete/import.
 * Parent-level symlinks (and macOS `/var -> /private/var`) are resolved
 * normally via realpath so genuine roots still match.
 */
export async function resolveTrustedRoot(
  fs: FileSystemPort,
  root: string,
): Promise<string | undefined> {
  if (typeof fs.realpath !== "function") {
    return undefined; // fail closed — cannot prove the root is real
  }
  const abs = resolve(root);
  if (await fs.exists(abs)) {
    if (typeof fs.lstat !== "function") {
      return undefined; // cannot verify the final component is not a symlink
    }
    try {
      const st = await fs.lstat(abs);
      if (st.isSymbolicLink) {
        return undefined; // a symlinked own root is untrusted
      }
    } catch {
      return undefined;
    }
    try {
      return await fs.realpath(abs);
    } catch {
      return undefined;
    }
  }
  // A not-yet-created root: resolve via its existing ancestor. A DANGLING symlink
  // at the final component reads as non-existent here (`exists` follows and finds
  // nothing), but realpathExistingAncestor now probes with `lstat` and fails
  // closed on it (P1-1), so a dangling own-root symlink cannot anchor a write.
  return realpathExistingAncestor(fs, abs);
}

/**
 * Realpath of an EXISTING directory (a trusted workspace/home base), or undefined
 * when it cannot be resolved (fail closed). Unlike `resolveTrustedRoot` this does
 * NOT reject a symlinked final component: the base itself may legitimately sit
 * under system symlinks (macOS `/var -> /private/var`); we only need its canonical
 * path to anchor containment.
 */
async function realpathIfExists(fs: FileSystemPort, dir: string): Promise<string | undefined> {
  if (typeof fs.realpath !== "function") {
    return undefined;
  }
  if (!(await fs.exists(dir))) {
    return undefined;
  }
  try {
    return await fs.realpath(dir);
  } catch {
    return undefined;
  }
}

/**
 * The trusted base of an own-catalog root. Every own root has the shape
 * `<base>/<catalog>/<leaf>` (`<ws>/.anycode/agents`, `<home>/.anycode/skills`,
 * `<ws>/.agents/skills`), so the base is the root's grandparent. Anchoring
 * containment to the REAL base (below) defeats an intermediate-symlink escape.
 */
function ownRootBase(root: string): string {
  return dirname(dirname(resolve(root)));
}

/** True when `candidate` is a strict descendant of `base` (never `base` itself). */
function isStrictlyUnder(base: string, candidate: string): boolean {
  const rel = relative(base, candidate);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Async, symlink-RESOLVED own-root containment. Unlike a lexical prefix check,
 * this realpaths BOTH the candidate (via its existing ancestor) and each own root
 * (rejecting a symlinked root outright), so neither a symlinked child directory
 * (escaping child) nor a symlinked catalog root (escaping root) can slip a
 * destructive op outside the real catalog. `opts.allowEqual` lets an import/create
 * target equal a root; delete requires a strict child. Fail-closed: any unresolved
 * path yields false.
 *
 * P7.21 W1-FIX #1 (intermediate-symlink escape): `resolveTrustedRoot`'s lstat only
 * inspects the root's FINAL component, so an INTERMEDIATE symlink
 * (`<base>/.anycode -> /tmp/out`, with a REAL `agents`/`skills` dir inside the
 * link target) is invisible to it — there the candidate AND the root both resolve
 * THROUGH the link and agree, so the under-root check alone passes while the write
 * escapes the real base. The fix anchors every root to the REALPATH of its
 * workspace/home base and additionally requires the resolved candidate to sit
 * physically under that base. This closes the deterministic escape for BOTH the
 * subagents and the skills admin surfaces (shared helper); the realpath-string
 * TOCTOU race stays ACCEPTED (module header P1-3, no dir-fd in the port).
 */
export async function isUnderOwnRootsResolved(
  fs: FileSystemPort,
  candidatePath: string,
  ownRoots: readonly string[],
  opts: { allowEqual?: boolean } = {},
): Promise<boolean> {
  const cand = await realpathExistingAncestor(fs, candidatePath);
  if (cand === undefined) {
    return false;
  }
  for (const root of ownRoots) {
    const realRoot = await resolveTrustedRoot(fs, root);
    if (realRoot === undefined) {
      continue;
    }
    // Base anchor: the resolved candidate must ALSO physically live under the REAL
    // workspace/home base — rejects an intermediate-symlink escape that agrees
    // with the (also symlink-traversed) root. Fail-closed: an unresolvable base
    // skips this root.
    const realBase = await realpathIfExists(fs, ownRootBase(root));
    if (realBase === undefined) {
      continue;
    }
    if (!isStrictlyUnder(realBase, cand)) {
      continue;
    }
    const rel = relative(realRoot, cand);
    if (rel === "") {
      if (opts.allowEqual) {
        return true;
      }
      continue;
    }
    if (!rel.startsWith("..") && !isAbsolute(rel)) {
      return true;
    }
  }
  return false;
}
