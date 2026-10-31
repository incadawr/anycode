export { ModePermissionEngine } from "./engine.js";
export { AllowAllPermissionBroker, DenyPermissionBroker } from "./brokers.js";
export { RuleAwarePermissionEngine, SessionPermissionRules, ProfilePermissionEngine } from "./rules.js";
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
// Taskana 4702 Stage 1: ask-zone classifier (pure core) and its external-command implementation.
export {
  ASK_CLASSIFIER_DEFAULT_TIMEOUT_MS,
  ASK_CLASSIFIER_MAX_COMMAND_CHARS,
  ASK_CLASSIFIER_REASON_MAX_CHARS,
  ASK_CLASSIFIER_USER_TURNS,
  ASK_CLASSIFIER_USER_TURN_MAX_CHARS,
  FORCE_PUSH_FLAGS,
  NEVER_AUTO_BINARIES,
  SHELL_PIPE_TARGETS,
  classifyAsk,
  isClassifiableAsk,
  recentUserTurns,
  validateAskVerdict,
} from "./ask-classifier.js";
export type {
  AskClassifier,
  AskClassifierInput,
  AskClassifierVerdict,
  AskEligibility,
  ClassifyAskOptions,
  ClassifyAskResult,
} from "./ask-classifier.js";
export { createCommandAskClassifier, parseClassifierCommand } from "./command-classifier.js";
export type { CommandClassifierOptions } from "./command-classifier.js";
// Taskana 4730 (4702 remainder), implementation B: a model-completion classifier.
export {
  MODEL_CLASSIFIER_MAX_OUTPUT_TOKENS,
  MODEL_CLASSIFIER_MAX_REPLY_CHARS,
  MODEL_CLASSIFIER_SYSTEM_PROMPT,
  MODEL_CLASSIFIER_UNTRUSTED_CLOSE,
  MODEL_CLASSIFIER_UNTRUSTED_OPEN,
  createModelAskClassifier,
} from "./model-classifier.js";
export type { ModelClassifierOptions } from "./model-classifier.js";
// Taskana 4730: the ONE shared consultation + event shape (dispatcher and the
// engine-session broker decorator both emit through this).
export { consultAskClassifier, isPermissionAutoDecidedEvent } from "./ask-classifier-consult.js";
export type { AskClassifierConsultConfig, AskClassifierConsultation } from "./ask-classifier-consult.js";
