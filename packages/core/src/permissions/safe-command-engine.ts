/** Auto-approve Bash commands proven read-only by the conservative classifier.
 * Build-mode asks are narrowed as before. In plan mode, only the mode table's
 * own Bash denial is narrowed; other denials remain authoritative.
 */

import { resolveTrustedPlanCommand } from "./plan-command.js";
import type { PermissionEngine, PermissionRequest, PermissionRuling } from "../types/permissions.js";
import { classifyBashCommandLine, type BashCommandClass } from "./safe-command.js";

/** Pipeline-aware classifier for build-mode asks. */
const defaultClassify = (command: string): BashCommandClass => classifyBashCommandLine(command).class;

export class SafeCommandPermissionEngine implements PermissionEngine {
  constructor(
    private readonly base: PermissionEngine,
    private readonly classify: (command: string) => BashCommandClass = defaultClassify,
  ) {}

  check(request: PermissionRequest): PermissionRuling {
    const ruling = this.base.check(request);
    if (request.toolName !== "Bash") return ruling;

    const planDeny = request.mode === "plan" && ruling.decision === "deny" &&
      ruling.reason === "Bash: only read-only tools are permitted in plan mode";
    if (ruling.decision !== "ask" && !planDeny) return ruling;

    const command = (request.input as { command?: unknown } | null)?.command;
    // Plan-mode denials are relaxed only by the actual classifier, regardless of
    // any injected classifier used for build-mode approval policy.
    const resolvedCommand = typeof command === "string" && request.mode === "plan"
      ? resolveTrustedPlanCommand(command, request.cwd) : undefined;
    const safe = typeof command === "string" && (request.mode === "plan"
      ? resolvedCommand !== undefined
      : this.classify(command) === "read-only");
    if (safe) {
      return { decision: "allow", reason: "Bash: auto-approved (provably read-only command)",
        ...(resolvedCommand !== undefined ? { resolvedCommand } : {}) };
    }
    if (planDeny) {
      return {
        decision: "deny",
        reason: "Bash: command is not proven read-only, its executable is not trusted, or it uses unsupported shell syntax (such as chains or redirects). Use Glob for listing, Read for files, or Git for status and history; only read-only commands and | pipelines are allowed in plan mode.",
      };
    }
    return ruling;
  }
}
