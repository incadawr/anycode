/**
 * CLI render theme: semantic style roles -> SGR escapes (design slice-4.1-cut.md
 * §2.2/§3.2). Task 4.1.1 freezes this contract and ships the real
 * detectColorEnabled precedence plus an identity-paint stub (`color` is honoured
 * as a field but no SGR is written, so no-color output stays byte-identical to
 * today's). Task 4.1.3 rewrites paint() in place with the hand-rolled
 * 16-colour SGR palette — the signatures here are frozen for the wave.
 */

export type CliStyleRole =
  | "banner" // start-up line
  | "toolName" // tool name in [tool] lines
  | "toolResultOk" // status=ok
  | "toolResultError" // status!=ok
  | "error"
  | "warn"
  | "usage" // [usage]/[context] lines (dim)
  | "progress" // subagent_*/workflow_* lines
  | "ask" // ask header
  | "askHint" // y/n/a hint line
  | "dim"
  // Transcript UX v2 additions (design slice-4.2-cut.md §2.2). Additive roles:
  // color=false still degrades every one of them to identity paint.
  | "diffAdd" // "+" lines of an Edit/Write diff — green
  | "diffRemove" // "-" lines of an Edit diff — red
  | "reasoning" // reasoning header + streamed reasoning text — dim
  | "spinner"; // status-line spinner frame — cyan

export interface CliTheme {
  readonly color: boolean;
  /** Wraps `text` in the role's SGR when color is enabled; identity when not. */
  paint(role: CliStyleRole, text: string): string;
}

/**
 * Colour-enable precedence (design §3.2 — a frozen contract, not render):
 * explicit --no-color flag > NO_COLOR (any value) > FORCE_COLOR (not ""/"0") >
 * TERM=dumb > output stream isTTY. Implemented for real in 4.1.1; 4.1.3 only
 * adds the SGR palette on top.
 */
export function detectColorEnabled(opts: {
  env: NodeJS.ProcessEnv;
  outputIsTTY: boolean;
  noColorFlag: boolean;
}): boolean {
  if (opts.noColorFlag) {
    return false;
  }
  if (opts.env.NO_COLOR !== undefined) {
    return false;
  }
  const force = opts.env.FORCE_COLOR;
  if (force !== undefined && force !== "" && force !== "0") {
    return true;
  }
  if (opts.env.TERM === "dumb") {
    return false;
  }
  return opts.outputIsTTY;
}

/**
 * SGR palette (design §3.2), 16-colour basis — no 256/truecolor in v1. Values
 * are the semicolon-joined parameter(s) of a single `\x1b[<params>m` escape;
 * roles that combine a colour with bold (error, ask) still open exactly one
 * escape (roles are atomic — no nested painting).
 */
const SGR_CODES: Record<CliStyleRole, string> = {
  banner: "1", // bold
  toolName: "36", // cyan
  toolResultOk: "32", // green
  toolResultError: "31", // red
  error: "31;1", // red + bold
  warn: "33", // yellow
  usage: "2", // dim
  progress: "2", // dim
  ask: "35;1", // magenta + bold
  askHint: "2", // dim
  dim: "2", // dim
  diffAdd: "32", // green
  diffRemove: "31", // red
  reasoning: "2", // dim
  spinner: "36", // cyan
};

/**
 * Task 4.1.3: real SGR paint. `color=false` is a pure identity function (byte-

 * wraps `text` in exactly one `\x1b[<params>m` ... `\x1b[0m` pair per role.
 */
export function createCliTheme(opts: { color: boolean }): CliTheme {
  if (!opts.color) {
    return {
      color: false,
      paint(_role: CliStyleRole, text: string): string {
        return text;
      },
    };
  }
  return {
    color: true,
    paint(role: CliStyleRole, text: string): string {
      return `\x1b[${SGR_CODES[role]}m${text}\x1b[0m`;
    },
  };
}
