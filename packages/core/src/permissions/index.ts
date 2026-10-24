export { ModePermissionEngine } from "./engine.js";
export { AllowAllPermissionBroker, DenyPermissionBroker } from "./brokers.js";
export { RuleAwarePermissionEngine, SessionPermissionRules } from "./rules.js";
export { SafeCommandPermissionEngine } from "./safe-command-engine.js";
export { classifyBashCommand } from "./safe-command.js";
export type { BashCommandClass } from "./safe-command.js";
export { isWithinWorkspace, isProvablyInsideWorkspace, WORKSPACE_CONFINED_WRITE_TOOLS } from "./workspace-policy.js";
// Taskana 4294 (cross-review F1): the desktop's claude/codex approval bridges
// mint the SAME dispatch-site workspace facts the core dispatcher does, so a
// foreign engine's Write/Edit approvals can be workspace-confined by
// IpcPermissionBroker's rule seam. Exported through the permissions barrel
// (root index re-exports it) rather than a new subpath — the exports map is
// frozen outside this task's allowed paths.
export { resolveWorkspaceWriteFacts } from "../util/path-containment.js";
export { classifyBashCommandLine } from "./safe-command.js";
export type { BashCommandLineClassification } from "./safe-command.js";
// TASK.36 handoff (invariant 2): the ONE Bash segment splitter, exported.
export { splitBashSegments } from "./rules.js";
export type { BashSegments, BashSeparatorKind } from "./rules.js";
// TASK.138 slice 2: per-run Bash allow-list decorator (ANYCODE_RUN_ALLOW_BASH).
export { parseRunAllowBash, RunAllowBashPermissionEngine } from "./run-allow-bash.js";
export type { RunAllowBashEntry } from "./run-allow-bash.js";
