/**
 * Canonicalization of the file-subresource policy's broad roots
 * (preview/file-resource-policy.ts).
 *
 * WHY THIS EXISTS — the policy compares a REALPATH'd request against the
 * broad roots, so the roots must be canonical too. On macOS the OS temp dir
 * is `/var/folders/…/T` while its realpath is `/private/var/folders/…/T`:
 * an UNCANONICAL root never matches a realpath'd path, the "document sits
 * directly in a broad root" rule silently stops applying, and a document
 * that lives directly in the temp dir can read the WHOLE temp tree
 * (nested secrets included).
 *
 * The rule is: canonicalize every root with `fs.realpathSync` (falling back
 * to the raw path when it does not exist / cannot be read) AND KEEP the raw
 * spelling as well — a realpath'd request may carry either one (a symlinked
 * home, a temp dir spelled `/tmp` vs `/private/tmp`), and a broad root that
 * is only known in one spelling is a broad root that can be walked past.
 */

import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** The broad roots the file-subresource policy compares against. */
export interface FileResourceRoots {
  /** CANONICAL (realpath'd) home dir — a broad root, and the parent of the app profile. */
  home: string;
  /** CANONICAL (realpath'd) app profile dir (`<home>/.anycode`) — a broad root, and the tree rule (d) protects. */
  profileDir: string;
  /** The temp roots — BOTH the raw and the canonical spelling of each. */
  tmpdirs: string[];
}

/**
 * The canonical form of a root path: `fs.realpathSync` when it resolves,
 * the raw path otherwise (a root that does not exist yet contains nothing,
 * but its spelling must still be comparable).
 */
export function canonicalizeRootPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Adapts a live tab workspace lookup for the realpath-based file policy. */
export function canonicalWorkspaceForTab(lookup: (tabId: string) => string | undefined): (tabId: string) => string | undefined {
  return (tabId) => {
    const workspace = lookup(tabId);
    return workspace === undefined ? undefined : canonicalizeRootPath(workspace);
  };
}

/**
 * The OS temp roots. On darwin `/tmp` is a SYMLINK to `/private/tmp`, so
 * both spellings are listed (a realpath'd request carries either).
 */
export function defaultTempRoots(): string[] {
  const roots: string[] = [tmpdir()];
  if (process.platform === "darwin") {
    roots.push("/tmp");
    roots.push(canonicalizeRootPath("/tmp"));
  }
  return roots;
}

/**
 * Canonicalizes the roots and KEEPS the raw spellings alongside them.
 *
 * @param home the user's home dir (raw — it is canonicalized here)
 * @param tmpdirs the temp roots (raw — they are canonicalized here)
 */
export function buildFileResourceRoots(home: string, tmpdirs: string[]): FileResourceRoots {
  const canonicalHome = canonicalizeRootPath(home);
  const profileDir = canonicalizeRootPath(join(canonicalHome, ".anycode"));
  const roots = [...tmpdirs];
  for (const dir of tmpdirs) {
    roots.push(canonicalizeRootPath(dir));
  }
  return {
    home: canonicalHome,
    profileDir,
    tmpdirs: [...new Set(roots)],
  };
}

/** The default roots: the real user's home plus the OS temp dirs. */
export function defaultFileResourceRoots(): FileResourceRoots {
  return buildFileResourceRoots(homedir(), defaultTempRoots());
}
