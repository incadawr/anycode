import * as path from "node:path";

/**
 * Confinement predicate: true iff `candidatePath` is lexically within `workspaceRoot`.
 *
 * Policy-seed for 5.2 (OS-level sandbox profile is generated from this same policy). The
 * algorithm is purely lexical via `node:path`: both `workspaceRoot` and `candidatePath` are
 * resolved to absolute paths (relative `candidatePath` resolves against `workspaceRoot`), then
 * `path.relative(root, resolved)` is inspected — the candidate is confined iff the relative
 * path does not escape upward (does not start with `..`) and is not itself absolute (which
 * `path.relative` returns when the two paths share no common root, e.g. different drives on
 * Windows). The root resolving to itself (`relative === ""`) counts as confined.
 *
 * Known residual (R1): symlink escapes are NOT caught here. A path that is lexically inside
 * `workspaceRoot` but traverses a symlink pointing outside of it (e.g. `workspaceRoot/link`
 * where `link -> /etc`) is reported as confined by this predicate, because no filesystem I/O
 * or symlink resolution is performed — this module is pure string/path logic, zero `fs`. Real
 * inode-level enforcement (resolving symlinks against the actual filesystem) is the OS sandbox
 * layer's responsibility (5.2, Seatbelt). In 5.1 this predicate ships as a tested, exported
 * foundation with no runtime enforcer wired to it yet.
 */
export function isWithinWorkspace(candidatePath: string, workspaceRoot: string): boolean {
  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(root, candidatePath);
  const relative = path.relative(root, resolved);

  if (relative === "") return true;
  if (path.isAbsolute(relative)) return false;
  if (relative === "..") return false;
  const escapePrefix = ".." + path.sep;
  return !relative.startsWith(escapePrefix);
}
