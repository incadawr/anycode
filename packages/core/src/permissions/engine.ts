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
 */

import type { PermissionEngine, PermissionRequest, PermissionRuling } from "../types/permissions.js";

export class ModePermissionEngine implements PermissionEngine {
  check(request: PermissionRequest): PermissionRuling {
    const { mode, metadata, toolName } = request;
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
