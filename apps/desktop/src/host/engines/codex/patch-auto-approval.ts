/**
 * Taskana 4265: workspace-patch auto-accept policy for the Codex approval
 * bridge. A codex child clamped to preset `ask` still asks for EVERY
 * `apply_patch`, even a patch that lands inside its own workspace — a Claude
 * child in edit/auto/yolo gets `workspace` (acceptEdits) and a core child in
 * edit mode auto-allows contained Write/Edit. This module gives the codex
 * bridge the SAME rules, under the same fail-closed discipline: every target
 * path must be realpath-provably inside the session workspace (the exact
 * facts the core dispatcher mints via `resolveWorkspaceWriteFacts`), the
 * active preset must be workspace-write, every change must be an add/update
 * (the only kinds the parity rule covers — see AUTO_ACCEPTABLE_CHANGE_KINDS),
 * and either the inherited mode pre-authorises workspace writes or an
 * always-allow Edit/Write rule covers every target. Anything it cannot prove
 * with certainty fails closed to a normal ask.
 */

import { dirname } from "node:path";
import { isWithinWorkspace, resolveWorkspaceWriteFacts, type FileSystemPort } from "@anycode/core";
import type { PermissionRuleMatcher } from "../../permission-broker.js";

/** Presets whose sandbox is workspace-write; only these can auto-accept a contained patch (Taskana 4265). */
export const WORKSPACE_WRITE_PRESETS: ReadonlySet<string> = new Set(["ask", "approve-for-me"]);

/** What the host boot supplies (host/index.ts). */
export interface CodexPatchAutoApprovalPolicy {
  fs: FileSystemPort;
  /** True iff the session's inherited core mode pre-authorises writes inside the workspace (codex child in edit/auto/yolo). */
  workspaceWritesAllowed: boolean;
  /** Same always-allow rule instance the broker holds; null = none. */
  rules: PermissionRuleMatcher | null;
}

/** Full context the bridge needs (codex-engine.ts adds workspace + live preset). */
export interface CodexPatchAutoApprovalContext extends CodexPatchAutoApprovalPolicy {
  workspace: string;
  activePresetId(): string | null;
}

const CHANGE_KEYS = new Set(["path", "kind", "diff"]);

/**
 * Cross-review M1 (Taskana 4265): the pinned contract's `PatchChangeKind`
 * variants are exactly `add`, `update`, and `delete`. The parity rule this
 * module mirrors covers file EDITS only — core's edit-mode containment widens
 * just Write/Edit (`WORKSPACE_WRITE_TOOLS`) and Claude's `workspace` tier is
 * acceptEdits; in both, a delete rides an ASKED Bash, never a silent patch.
 * Auto-accepting a delete here would make the codex child the only posture
 * that silently deletes contained files, so `delete` (and any kind outside
 * this pinned set — unknown future kinds fail closed with it) falls back to
 * the ordinary ask.
 */
const AUTO_ACCEPTABLE_CHANGE_KINDS: ReadonlySet<string> = new Set(["add", "update"]);

/** True iff a `changes` entry's kind is on the auto-accept allowlist; a kind we cannot decode fails closed. */
function isAutoAcceptableChangeKind(kind: unknown): boolean {
  if (kind === undefined || kind === null) return false;
  if (typeof kind !== "object") return false;
  const record = kind as Record<string, unknown>;
  const type = record.type;
  if (typeof type !== "string" || !AUTO_ACCEPTABLE_CHANGE_KINDS.has(type)) return false;
  // Taskana 4265 review: an update carrying `move_path` is a RENAME — it removes
  // the source path, i.e. the same silent-delete M1 excludes. Neither core's
  // Write/Edit nor Claude's acceptEdits can rename silently, so it asks; any
  // other non-null kind field is likewise outside the arbitrated shape.
  return Object.entries(record).every(([key, value]) => key === "type" || value === null || value === undefined);
}

/** Every path a fileChange item would touch, or null when that cannot be enumerated with certainty (fail-closed). */
export function patchTargetPaths(item: Record<string, unknown> | undefined): string[] | null {
  if (item === undefined || item.type !== "fileChange" || !Array.isArray(item.changes) || item.changes.length === 0) return null;
  const paths: string[] = [];
  for (const entry of item.changes) {
    if (entry === null || typeof entry !== "object") return null;
    const change = entry as Record<string, unknown>;
    if (typeof change.path !== "string" || change.path.length === 0) return null;
    for (const [key, value] of Object.entries(change)) {
      if (!CHANGE_KEYS.has(key) && value !== null && value !== undefined) return null;
    }
    paths.push(change.path);
    const kind = change.kind;
    if (kind === undefined || kind === null) continue;
    if (typeof kind !== "object") return null;
    for (const [key, value] of Object.entries(kind as Record<string, unknown>)) {
      if (key === "type" || value === null || value === undefined) continue;
      if (typeof value === "string" && value.length > 0) { paths.push(value); continue; } // e.g. move_path
      return null;
    }
  }
  return paths;
}

/** Realpath-proved containment, same facts the core dispatcher mints (symlink/`..`/hard-link fail closed). */
export async function isPathProvablyInsideWorkspace(fs: FileSystemPort, workspace: string, target: string): Promise<boolean> {
  const facts = await resolveWorkspaceWriteFacts(fs, workspace, target);
  if (facts === undefined) return false;
  if (dirname(facts.root) === facts.root) return false; // filesystem root never anchors trust
  return isWithinWorkspace(facts.resolvedPath, facts.root);
}

/**
 * Taskana 4265: true iff a file-change approval may be accepted without asking, under the
 * SAME rules a core child gets: the patch lands provably inside the session workspace,
 * every change is an add/update (cross-review M1: a delete asks — the parity rule covers
 * file edits only, exactly core's Write/Edit-only containment and Claude's acceptEdits),
 * AND (the inherited mode allows workspace writes OR an always-allow Edit/Write rule
 * covers every target). Never for a grantRoot request, never outside a workspace-write
 * preset.
 */
export async function shouldAutoAcceptPatch(
  ctx: CodexPatchAutoApprovalContext,
  item: Record<string, unknown> | undefined,
  grantRoot: string | null,
): Promise<boolean> {
  if (grantRoot !== null) return false;
  const preset = ctx.activePresetId();
  if (preset === null || !WORKSPACE_WRITE_PRESETS.has(preset)) return false;
  const targets = patchTargetPaths(item);
  if (targets === null) return false;
  // Cross-review M1: an `undefined`/absent kind is NOT auto-acceptable either — the
  // pinned contract makes `kind` required, so a wire item without one is not a shape
  // this policy was arbitrated over; fail closed to the ask.
  const changes = item?.changes;
  if (!Array.isArray(changes) || !changes.every((entry) => isAutoAcceptableChangeKind((entry as Record<string, unknown> | null)?.kind))) {
    return false;
  }
  for (const target of targets) {
    if (!(await isPathProvablyInsideWorkspace(ctx.fs, ctx.workspace, target))) return false;
  }
  if (ctx.workspaceWritesAllowed) return true;
  const rules = ctx.rules;
  if (rules === null) return false;
  return targets.every((t) => rules.matches("Edit", { file_path: t }) || rules.matches("Write", { file_path: t }));
}
