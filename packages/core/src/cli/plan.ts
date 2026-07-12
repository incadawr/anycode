/**
 * Plan-mode reminder (Phase 4 slice 4.3, design §2.7/§3.4). The system prompt is
 * static and shared with the desktop host, so it does not carry "you are in plan
 * mode"; the REPL appends this reminder to the user's prompt on every plan-mode
 * turn instead (the model does not remember the mode between turns). Pure string
 * function — no I/O, no state. The reminder rides inside a structural tag,
 * mirroring the <hook-context> tag the loop appends for UserPromptSubmit hooks;
 * it persists into history as part of the user message, which is honest about

 */

/** Plan-discipline text wrapped by withPlanModeReminder; original prose, never copied. */
export const PLAN_MODE_REMINDER =
  "You are in plan mode: only read-only tools are allowed — writes and commands are denied before they execute, so do not try. Investigate first: if the scope spans several files or is uncertain, launch up to 3 explore subagents in parallel — one Agent call each in the same response, each with its own focus; use Read, Grep, and Glob directly only for quick checks of known files. Then call ExitPlanMode with a complete implementation plan; if rejected, refine the plan or ask clarifying questions, and implement nothing until it is approved.";

/**
 * Appends the plan-mode reminder to a user prompt inside a <plan-mode-reminder>
 * tag. Called by the REPL only while the session mode is plan (design §2.8).
 */
export function withPlanModeReminder(userInput: string): string {
  return `${userInput}\n<plan-mode-reminder>\n${PLAN_MODE_REMINDER}\n</plan-mode-reminder>`;
}
