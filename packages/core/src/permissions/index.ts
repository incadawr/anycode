export { ModePermissionEngine } from "./engine.js";
export { AllowAllPermissionBroker, DenyPermissionBroker } from "./brokers.js";
export { RuleAwarePermissionEngine, SessionPermissionRules } from "./rules.js";
export { SafeCommandPermissionEngine } from "./safe-command-engine.js";
export { classifyBashCommand } from "./safe-command.js";
export type { BashCommandClass } from "./safe-command.js";
export { isWithinWorkspace } from "./workspace-policy.js";
export { classifyBashCommandLine } from "./safe-command.js";
export type { BashCommandLineClassification } from "./safe-command.js";
// Taskana 4070: the shared classification-to-plaque mapping (CLI terminal
// broker, desktop modal, Codex commandExecution approvals).
export {
  BASH_RISK_PLAQUE,
  bashRiskFacts,
  bashRiskPlaque,
  bashWriteCapablePlaque,
  isPlaqueCommandLineTool,
  WRITE_CAPABLE_BINARIES,
} from "./bash-risk-plaque.js";
export type { BashRiskFacts, BashRiskPlaque } from "./bash-risk-plaque.js";
// TASK.36 handoff (invariant 2): the ONE Bash segment splitter, exported.
export { splitBashSegments } from "./rules.js";
export type { BashSegments, BashSeparatorKind } from "./rules.js";
// TASK.138 slice 2: per-run Bash allow-list decorator (ANYCODE_RUN_ALLOW_BASH).
export { parseRunAllowBash, RunAllowBashPermissionEngine } from "./run-allow-bash.js";
export type { RunAllowBashEntry } from "./run-allow-bash.js";
