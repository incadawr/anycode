/**
 * Mode-based permission engine (Phase 0 rule table; pattern/rule persistence
 * arrives in Phase 1):
 *   yolo        -> allow everything
 *   auto        -> allow, except riskLevel === "high" -> ask
 *   build, edit -> readOnly -> allow; otherwise -> ask
 *   plan        -> readOnly -> allow; otherwise -> deny
 * "ask" is resolved by the broker; with DenyPermissionBroker wired (the
 * default) every "ask" becomes deny — fail-closed. Pure function, no I/O.
 *
 * Phase 1 addition (design §2.8): in plan/build/edit, an `allow` verdict from
 * the base table is escalated to `ask` when `metadata.needsApproval === true`
 * (this is the rule that makes WebFetch — a readOnly network tool — ask).
 * yolo/auto are untouched. The existing five tools are unaffected: their
 * write tools already resolve to ask/deny before this step ever sees
 * "allow", and their read-only tools all have needsApproval === false.
 *
 * TASK.32 addition (honest Edit mode): in edit mode, a Write/Edit whose
 * dispatch-site-resolved target provably sits inside the workspace
 * (`request.workspace`, computed by the dispatcher — see path-containment.ts)
 * is allowed TERMINALLY, before baseRuling and the needsApproval escalation
 * above ever run. The early return is load-bearing: Write/Edit carry
 * needsApproval:true, so an allow produced later in this method would be
 * re-escalated to ask by the block above.
 */

import type { PermissionEngine, PermissionRequest, PermissionRuling } from "../types/permissions.js";
import { isProvablyInsideWorkspace } from "./workspace-policy.js";

export class ModePermissionEngine implements PermissionEngine {
  check(request: PermissionRequest): PermissionRuling {
    const { mode, metadata, toolName } = request;

    // TASK.32 honest Edit mode: a Write/Edit whose dispatch-site-resolved
    // target provably sits inside the workspace is allowed TERMINALLY. The
    // early return (before baseRuling and before the needsApproval escalation
    // below) is load-bearing (DV-4): Write/Edit carry needsApproval:true, so
    // an allow produced later in this method would be re-escalated to ask.
    if (mode === "edit" && isContainedWorkspaceWrite(request)) {
      return {
        decision: "allow",
        reason: `${toolName}: allowed in edit mode (target inside workspace)`,
      };
    }

    const ruling = this.baseRuling(request);

    if (
      ruling.decision === "allow" &&
      metadata.needsApproval &&
      (mode === "plan" || mode === "build" || mode === "edit")
    ) {
      return {
        decision: "ask",
        reason: `${toolName}: requires approval in ${mode} mode`,
      };
    }

    return ruling;
  }

  private baseRuling(request: PermissionRequest): PermissionRuling {
    const { mode, metadata, toolName } = request;

    switch (mode) {
      case "yolo":
        return { decision: "allow" };

      case "auto":
        if (metadata.riskLevel === "high") {
          return {
            decision: "ask",
            reason: `${toolName}: high-risk tool requires approval in auto mode`,
          };
        }
        return { decision: "allow" };

      case "build":
      case "edit":
        return metadata.readOnly
          ? { decision: "allow" }
          : {
              decision: "ask",
              reason: `${toolName}: write/side-effecting tool requires approval in ${mode} mode`,
            };

      case "plan":
        return metadata.readOnly
          ? { decision: "allow" }
          : {
              decision: "deny",
              reason: `${toolName}: only read-only tools are permitted in plan mode`,
            };

      default:
        // Fail-closed safety net for an unexpected mode value.
        return {
          decision: "deny",
          reason: `${toolName}: unknown permission mode "${String(mode)}"`,
        };
    }
  }
}

/** Tools the edit-mode workspace containment may widen. Literal names, exactly
 * these two (TASK.32 boundary 2): bridged mcp__* write tools, Bash, and any
 * future NotebookEdit-class tool keep today's ruling. */
const WORKSPACE_WRITE_TOOLS: ReadonlySet<string> = new Set(["Write", "Edit"]);

function isContainedWorkspaceWrite(request: PermissionRequest): boolean {
  if (!WORKSPACE_WRITE_TOOLS.has(request.toolName)) return false;
  // The fact proof lives in workspace-policy (shared with the always-allow
  // rule confinement, Taskana 4294): facts must be absolute real paths
  // (fail-closed against a sloppy caller's relative resolvedPath), a
  // degenerate root — its own dirname, POSIX "/", "//", "/x/..", a Windows
  // drive/UNC root — proves nothing (lexical containment would be vacuously
  // true for EVERY absolute path), and containment itself is the lexical
  // isWithinWorkspace over the realpath-resolved facts. Symlinks were
  // resolved upstream by the dispatcher; unprovable => false => the ordinary
  // edit-mode ask stands.
  return isProvablyInsideWorkspace(request.workspace);
}
