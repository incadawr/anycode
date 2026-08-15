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
 *
 * TASK.35: the default classifier is now pipeline-aware (`classifyBashCommandLine`)
 * — single commands are routed bit-for-bit unchanged (D-S2-4), Bash `|`
 * pipelines additionally auto-narrow when every segment proves read-only. The
 * injected-classifier seam type is unchanged.
 */

import type { PermissionEngine, PermissionRequest, PermissionRuling } from "../types/permissions.js";
import { classifyBashCommandLine, type BashCommandClass } from "./safe-command.js";

/** Default classifier (TASK.35): pipeline-aware, single commands unchanged. */
const defaultClassify = (command: string): BashCommandClass => classifyBashCommandLine(command).class;

export class SafeCommandPermissionEngine implements PermissionEngine {
  constructor(
    private readonly base: PermissionEngine,
    private readonly classify: (command: string) => BashCommandClass = defaultClassify,
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
