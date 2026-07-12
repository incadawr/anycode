/**
 * Safe-command narrowing engine (Phase 5 slice-5.1-cut.md §2.2). A decorator
 * PermissionEngine composed OVER a base engine (typically ModePermissionEngine),
 * structurally mirroring RuleAwarePermissionEngine (rules.ts:83-99): it narrows
 * ONLY an "ask" ruling to "allow", and only when the request is a Bash command
 * the conservative classifier (safe-command.ts) proves read-only. "allow" and
 * "deny" rulings from the base pass through untouched — a plan-mode Bash deny

 * table (engine.ts) is never modified, only wrapped (L1).
 *
 * Fail-closed: a Bash request whose input has no string `command` field yields

 * `classify` dependency is injected (defaulting to the real classifyBashCommand)
 * so the engine can be unit-tested independently of the classifier and so a
 * configurable allowlist (U1-P5) can later supply an alternate policy.
 */

import type { PermissionEngine, PermissionRequest, PermissionRuling } from "../types/permissions.js";
import { classifyBashCommand, type BashCommandClass } from "./safe-command.js";

export class SafeCommandPermissionEngine implements PermissionEngine {
  constructor(
    private readonly base: PermissionEngine,
    private readonly classify: (command: string) => BashCommandClass = classifyBashCommand,
  ) {}

  check(request: PermissionRequest): PermissionRuling {
    const ruling = this.base.check(request);
    if (ruling.decision !== "ask") {

      // narrowing only ever downgrades "ask" -> "allow".
      return ruling;
    }
    if (request.toolName !== "Bash") {
      return ruling;
    }
    const command = (request.input as { command?: unknown } | null)?.command;
    if (typeof command !== "string") {
      // Fail-closed: no command subject to classify, so the ask is preserved.
      return ruling;
    }
    if (this.classify(command) === "read-only") {
      return { decision: "allow", reason: "Bash: auto-approved (provably read-only command)" };
    }
    return ruling;
  }
}
