import * as path from "node:path";
import type { PermissionWorkspaceFacts } from "../types/permissions.js";

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
 * or symlink resolution is performed — this module is pure string/path logic, zero `fs`. In
 * 5.1 this predicate shipped as a tested, exported foundation; it is now enforced via
 * `isProvablyInsideWorkspace`, and symlinks are resolved upstream by the dispatcher's
 * realpath facts (the OS sandbox layer, 5.2 Seatbelt, remains the inode-level backstop).
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

/**
 * File-write tools whose always-allow rules are confined to the session
 * workspace (Taskana 4294). The dispatcher mints workspace facts for exactly
 * these; RuleAwarePermissionEngine refuses to downgrade their "ask" unless the
 * facts prove the target inside. NOT the edit-mode widening set (engine.ts
 * keeps its literal Write/Edit pair).
 */
export const WORKSPACE_CONFINED_WRITE_TOOLS: ReadonlySet<string> = new Set(["Write", "Edit", "MultiEdit"]);

/**
 * True iff dispatcher-minted facts PROVE the resolved target sits inside the
 * workspace root. Fail-closed: absent facts, non-absolute root/target, or a
 * degenerate root (filesystem root — its own dirname) => false.
 */
export function isProvablyInsideWorkspace(facts: PermissionWorkspaceFacts | undefined): boolean {
  if (facts === undefined) return false;
  if (!path.isAbsolute(facts.root) || !path.isAbsolute(facts.resolvedPath)) return false;
  const r = path.resolve(facts.root);
  if (path.dirname(r) === r) return false;
  return isWithinWorkspace(facts.resolvedPath, facts.root);
}
