import { COMMAND_HELP } from "./commands.js";

/**
 * A single slash-command completion candidate: the command token (from
 * KNOWN_SLASH_COMMANDS, e.g. "/compact") plus its matching one-line summary
 * from COMMAND_HELP.
 */
export interface SlashCompletion {
  readonly command: string;
  readonly summary: string;
}

/**
 * Slash-command autocomplete candidates for a composer query.
 *
 * Rules (Taskana 4082, slice 1):
 * - Only slash queries qualify: `query` must start with `/`. Anything else
 *   (including the empty string and bare words like `help`) returns `[]` —
 *   autocomplete is opt-in for slash commands only.
 * - `/` alone returns every command.
 * - Otherwise `query` must be a case-sensitive prefix of `command` (commands
 *   are lowercase; `/Q` matches nothing).
 * - Order follows COMMAND_HELP (identical to KNOWN_SLASH_COMMANDS order).
 *
 * Pure and synchronous — no terminal access.
 */
export function slashCompletions(query: string): SlashCompletion[] {
  if (!query.startsWith("/")) {
    return [];
  }
  return COMMAND_HELP.filter((entry) => entry.command.startsWith(query)).map((entry) => ({
    command: entry.command,
    summary: entry.summary,
  }));
}
