/**
 * Taskana 4070 (TASK.105 §2): the per-command risk plaque for a Bash-shaped
 * permission ask, derived from the SAME lexical classifier that powers
 * auto-allow (`classifyBashCommandLine`). Presentation only — the allow
 * decision never reads this.
 *
 * This module is the ONE canonical home of the classification-to-plaque
 * mapping. It was born in the desktop PermissionModal (7d633a64, hardened in
 * 4ebfbe12) and moved here verbatim so the CLI terminal broker and the Codex
 * `commandExecution` approval path render the SAME note as the desktop modal;
 * the desktop re-exports keep every existing import working unchanged.
 *
 * Input discipline (mirrors the modal's `bashUnknownShellHint` exactly):
 * fail-closed — a non-command tool or a missing/non-string `command` gets
 * nothing. The plaque and the TASK.35 «unknown shell expression» hint never
 * co-occur: a shell expression that is not provably read-only is the hint's
 * case alone.
 *
 * - proven read-only line (pipeline or single command) → `readOnly` plaque;
 * - unknown single command whose leading binary (looked up by BASENAME, so
 *   `/bin/rm` is named like `rm`) is in WRITE_CAPABLE_BINARIES → the
 *   write-capable plaque naming that binary as written;
 * - unknown single command with any other binary → `unknownBinary` plaque;
 * - unknown shell expression → no plaque (the shell hint already covers it).
 *
 * `toolName` membership (Bash / CodexExec) mirrors `isCommandLineTool` in
 * rules.ts — the plaque is about the shape of the subject (a shell command
 * line), not about which engine produced the ask.
 */

import { classifyBashCommandLine } from "./safe-command.js";

/** Taskana 4070 (TASK.105 §2): per-command risk note for a Bash ask, derived
 * from the SAME lexical classifier that powers auto-allow (presentation only;
 * the allow decision never reads this). `writeCapable` is NOT in this object —
 * its text names the concrete binary, so it is built by
 * `bashWriteCapablePlaque(binary)` below. */
export const BASH_RISK_PLAQUE = {
  readOnly:
    "This exact command line is provably read-only — every segment passed the same classifier that auto-allows in Auto mode. It asks only because of the session mode, a hook, or an engine bridge.",
  unknownBinary:
    "This command's binary is not on AnyCode's read-only list, so it asks. Not-on-the-list is not a verdict of danger; review the exact command before allowing.",
} as const;

export type BashRiskPlaque = (typeof BASH_RISK_PLAQUE)[keyof typeof BASH_RISK_PLAQUE];

/** The write-capable plaque names the binary, so it is a function, not a
 * const slot (Taskana 4070). Exported for the copy-pinning test. */
export function bashWriteCapablePlaque(binary: string): string {
  return `This command runs ${binary}, which can write or execute — the classifier cannot prove it read-only. Allow only if you intended this exact command.`;
}

/** Binaries the plaque names in the write-capable note (Taskana 4070).
 * Presentation-only superset of core's deny-lists: not consulted by any engine. */
export const WRITE_CAPABLE_BINARIES: ReadonlySet<string> = new Set([
  "rm", "rmdir", "mv", "cp", "ln", "mkdir", "touch", "tee", "truncate", "shred",
  "chmod", "chown", "chgrp", "dd", "install",
  "sed", "awk", "perl", "python", "python3", "node", "bun", "deno",
  "git", "pnpm", "npm", "yarn", "curl", "wget", "ssh", "scp", "rsync",
  "find", "xargs", "sort", "splice",
  // Wrappers, shells and privilege escalators run ANOTHER command: `sudo rm`,
  // `bash -c '…'`, `env rm` must never get the softer unknown-binary note.
  "sudo", "doas", "su", "env", "nohup", "nice", "timeout", "time", "command", "exec", "eval",
  "bash", "sh", "zsh", "dash", "fish", "ksh", "source", ".",
  "kill", "pkill", "killall", "npx", "pnpx", "bunx", "pip", "pip3", "cargo", "go", "make",
  "ruby", "php", "docker", "kubectl", "tar", "unzip", "osascript", "open",
]);

/** Presentation facts about a Bash-shaped ask's command line (Taskana 4070). */
export interface BashRiskFacts {
  /** Command-line tool with a string command; otherwise false. */
  applies: boolean;
  plaque: BashRiskPlaque | string | null;
  /** Leading binary of the first plain segment, when extractable. */
  binary: string | null;
}

/** Command-line tools whose ask subject is a shell command line (Taskana
 * 4070). Mirrors `isCommandLineTool` in rules.ts and the desktop's
 * permission-pattern.ts: `CodexExec` is the Codex approval bridge's name for a
 * `commandExecution` approval, and its input carries the same `command`
 * string. */
export function isPlaqueCommandLineTool(toolName: string): boolean {
  return toolName === "Bash" || toolName === "CodexExec";
}

/** Taskana 4070 (TASK.105 §2): the per-command risk plaque for a Bash-shaped
 * ask. Pure function of (toolName, input) — see the module doc for the exact
 * split and the fail-closed discipline. */
export function bashRiskFacts(toolName: string, input: unknown): BashRiskFacts {
  if (!isPlaqueCommandLineTool(toolName)) return { applies: false, plaque: null, binary: null };
  const command =
    input !== null && typeof input === "object" ? (input as { command?: unknown }).command : undefined;
  if (typeof command !== "string") return { applies: false, plaque: null, binary: null };
  const verdict = classifyBashCommandLine(command);
  if (verdict.class === "read-only") return { applies: true, plaque: BASH_RISK_PLAQUE.readOnly, binary: null };
  if (verdict.shellExpression) return { applies: true, plaque: null, binary: null }; // the shell hint already covers it
  // plain single command, unknown class: name the binary if we can
  const binary = /^[^ \t]+/.exec(command.trim())?.[0] ?? null;
  // Look up by basename so `/bin/rm` is named like `rm`, never softened.
  const lookup = binary === null ? null : (binary.split("/").pop() ?? binary);
  return {
    applies: true,
    plaque:
      lookup !== null && WRITE_CAPABLE_BINARIES.has(lookup) ? bashWriteCapablePlaque(binary!) : BASH_RISK_PLAQUE.unknownBinary,
    binary,
  };
}

/** The plaque string for an ask (Taskana 4070); null for everything the
 * plaque does not apply to. Thin wrapper so callers never depend on the facts
 * struct. */
export function bashRiskPlaque(toolName: string, input: unknown): string | null {
  return bashRiskFacts(toolName, input).plaque;
}
