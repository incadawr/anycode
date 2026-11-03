/**
 * Orchestrate-mode reminder (§3.4). A mirror of plan-reminder.ts:
 * while a session tab is in orchestrate mode (which sets the permission mode to
 * plan and uses a separate approval posture), every user prompt
 * carries this reminder instead of the plan-mode reminder — the model does not
 * remember the mode between turns. Pure string function — no I/O, no state.
 * The reminder rides inside a structural <orchestrate-reminder> tag, persists
 * into history as part of the user message (honest about what the model was
 * told), and both transcript sanitizers (context/session-title.ts, the
 * renderer's transcript-sanitize.ts) strip the paired tag so it never leaks
 * into a title or the visible transcript.
 */

/** Orchestration-discipline text wrapped by withOrchestrateReminder. */
export type OrchestrationDialect = "core" | "codex";

function agentInvocation(dialect: OrchestrationDialect): string {
  return dialect === "core" ? 'Agent tool using tier "session" and detach true' : "anycode_agent tool using detach true";
}

/** Shared discipline, with only the Agent invocation varying by transport. */
export function orchestrationInstructions(dialect: OrchestrationDialect): string {
  const invocation = agentInvocation(dialect);
  return "You are orchestrating this session: the user talks to you, and you delegate the work to child agents instead of doing it yourself. You are read-only — never write files or run state-changing commands yourself; the children do the editing. Delegate with the " + invocation + ": the call returns as soon as the child starts, and the child's report arrives later as a new message when you are idle — so do not wait, poll, or redo delegated work; keep talking with the user. Match the task to the role: \"planner\" turns a task into a written brief; \"executor\" implements a brief; \"reviewer\" adversarially checks finished work; \"explore\" answers scoped read-only questions. When the user has not asked for a named profile or engine, pass exactly one of these four role names as agent_type: the user routes each role to its model in Settings, and that routing is authoritative. Use a project agent profile (for example one named after an engine such as \"claude\" or \"codex\", or marked [engine: ...]) only when the user explicitly asks for that profile or engine by name; in that case the profile is what the user asked for, not a substitution for a role. Never pick such a profile on your own initiative. Do not write implementation plans yourself; delegate planning to the planner and relay its brief to the user. Give each child a complete, self-contained prompt (context, files, definition of done). Tell the user who is doing what, and surface anything that needs the user's decision.";
}

export const ORCHESTRATE_REMINDER = orchestrationInstructions("core");

/** Full developer block and concise turn reminder share the same discipline. */
export function orchestrationDeveloperBlock(dialect: OrchestrationDialect): string {
  return orchestrationInstructions(dialect);
}

export function orchestrationTurnReminder(dialect: OrchestrationDialect): string {
  const invocation = agentInvocation(dialect);
  return `Remain read-only and delegate through the ${invocation}. Do not wait, poll, or redo delegated work; follow the role-routing and named-profile rules.`;
}

/**
 * Appends the orchestrate reminder to a user prompt inside an
 * <orchestrate-reminder> tag. Called by a host only while the session's
 * orchestrate flag is on (which also forces the permission mode to plan).
 */
export function withOrchestrateReminder(userInput: string): string {
  return `${userInput}\n<orchestrate-reminder>\n${ORCHESTRATE_REMINDER}\n</orchestrate-reminder>`;
}
