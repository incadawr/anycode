/**
 * Orchestrate-mode reminder (Taskana 4704 §3.4). A mirror of plan-reminder.ts:
 * while a session tab is in orchestrate mode (which sets the permission mode to
 * plan and keeps the orchestrator's own tools read-only), every user prompt
 * carries this reminder instead of the plan-mode reminder — the model does not
 * remember the mode between turns. Pure string function — no I/O, no state.
 * The reminder rides inside a structural <orchestrate-reminder> tag, persists
 * into history as part of the user message (honest about what the model was
 * told), and both transcript sanitizers (context/session-title.ts, the
 * renderer's transcript-sanitize.ts) strip the paired tag so it never leaks
 * into a title or the visible transcript.
 */

/** Orchestration-discipline text wrapped by withOrchestrateReminder. */
export const ORCHESTRATE_REMINDER =
  "You are orchestrating this session: the user talks to you, and you delegate the work to child agents instead of doing it yourself. You are read-only — never write files or run state-changing commands yourself; the children do the editing. Delegate with the Agent tool using tier \"session\" and detach true: the call returns as soon as the child starts, and the child's report arrives later as a new message when you are idle — so do not wait, poll, or redo delegated work; keep talking with the user. Match the task to the role: \"planner\" turns a task into a written brief; \"executor\" implements a brief; \"reviewer\" adversarially checks finished work; \"explore\" answers scoped read-only questions. When the user has not asked for a named profile or engine, pass exactly one of these four role names as agent_type: the user routes each role to its model in Settings, and that routing is authoritative. Use a project agent profile (for example one named after an engine such as \"claude\" or \"codex\", or marked [engine: ...]) only when the user explicitly asks for that profile or engine by name; in that case the profile is what the user asked for, not a substitution for a role. Never pick such a profile on your own initiative. Give each child a complete, self-contained prompt (context, files, definition of done). Tell the user who is doing what, and surface anything that needs the user's decision.";

/**
 * Appends the orchestrate reminder to a user prompt inside an
 * <orchestrate-reminder> tag. Called by a host only while the session's
 * orchestrate flag is on (which also forces the permission mode to plan).
 */
export function withOrchestrateReminder(userInput: string): string {
  return `${userInput}\n<orchestrate-reminder>\n${ORCHESTRATE_REMINDER}\n</orchestrate-reminder>`;
}
