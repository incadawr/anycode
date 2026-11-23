/**
 * Code Mode reminder. While the REPL tool is offered, a client appends this to
 * the user's prompt, the same way it appends the plan-mode reminder. In the user
 * turn it lowers input tokens and cost; the same text in the system prompt shifted
 * calls into REPL without saving tokens. It rides in a <system-reminder> tag, which
 * both transcript sanitizers already strip from titles and the visible transcript.
 */
export const CODE_MODE_REMINDER =
  "Please use the REPL tool for this task to combine steps: in one REPL call, search for the relevant code, read the matching files and return only the lines you need. Inside REPL scripts keep searches narrow (specific directories, specific patterns, head_limit) and return only the lines you need, not whole files or whole tool outputs. A REPL call that runs a single tool and returns its output unfiltered gains nothing; call that tool directly instead.";

/** Appends the Code Mode reminder to a user prompt inside a <system-reminder> tag. */
export function withCodeModeReminder(userInput: string): string {
  return `${userInput}\n<system-reminder>\n${CODE_MODE_REMINDER}\n</system-reminder>`;
}
