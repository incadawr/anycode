/**
 * CLI sessions/resume UX (design slice-4.4-cut.md §2.2). Task B1: pure
 * formatting helpers (shortSessionId/formatRelativeTime/renderSessionsTable)
 * and the boot-time resume-picker (promptSessionSelection), consumed by
 * B2's main.ts wiring (§2.4) and commands.ts's /sessions handler (§2.3).
 * Zero host imports: only the SessionMeta type (ports/persistence.js),
 * sanitizeTitleSource (context/session-title.js), CliTheme (theme.js), and
 * node:readline (design L3).
 */

import { createInterface } from "node:readline";
import type { SessionMeta } from "../ports/persistence.js";
import { sanitizeTitleSource } from "../context/session-title.js";
import type { CliTheme } from "./theme.js";

/** `/sessions` default row cap (design §2.3 — mirrors persistence.listSessions's limit param). */
export const SESSIONS_LIST_LIMIT = 20;
/* */
export const SESSIONS_PICKER_LIMIT = 10;
/** Title-cell character cap before an ellipsis is appended (design §2.2). */
export const SESSIONS_TITLE_MAX_CHARS = 48;
/** Mirror of CLI_ASK_MAX_REPROMPTS (terminal-broker.ts:120) — same re-prompt cap, applied to the picker's own UX loop (fail-soft to "new") rather than a security-relevant ask (fail-closed to deny). */
export const SESSIONS_PICKER_MAX_REPROMPTS = 3;

/** First 8 characters of `id` (the full id, unchanged, when it is 8 chars or shorter). */
export function shortSessionId(id: string): string {
  return id.length <= 8 ? id : id.slice(0, 8);
}

/**
 * Deterministic relative-time formatting (design §2.2): both `updatedAt` and
 * `now` are plain epoch-ms inputs — this function never reads the clock
 * itself, so it is trivially unit-testable on fixed inputs. Buckets:
 * <60s "just now" · <60m "Nm ago" · <24h "Nh ago" · <7d "Nd ago" · else the
 * UTC calendar date as `yyyy-mm-dd` (ISO 8601 date-only, always UTC because
 * `Date#toISOString` is UTC by definition).
 */
export function formatRelativeTime(updatedAt: number, now: number): string {
  const diffSec = Math.floor((now - updatedAt) / 1000);
  if (diffSec < 60) {
    return "just now";
  }
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) {
    return `${diffMin}m ago`;
  }
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) {
    return `${diffHour}h ago`;
  }
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 7) {
    return `${diffDay}d ago`;
  }
  return new Date(updatedAt).toISOString().slice(0, 10);
}

/**
 * Title-cell projection (design §2.2): sanitizeTitleSource strips paired
 * reminder/context tags a legacy or foreign-host row might carry (session-
 * title.ts, shared with the 4.4-T titling tiers) before the untitled-fallback
 * and length cap are applied, so a control-character-laden title can never
 * break the table's column alignment.
 */
function formatTitleCell(title: string | undefined): string {
  const sanitized = title !== undefined ? sanitizeTitleSource(title) : "";
  const display = sanitized.length > 0 ? sanitized : "(untitled)";
  return display.length > SESSIONS_TITLE_MAX_CHARS
    ? `${display.slice(0, SESSIONS_TITLE_MAX_CHARS)}…`
    : display;
}

export interface SessionsTableOptions {
  /** Injected "now" (epoch ms) so the table is pure/testable — never Date.now() internally. */
  now: number;
  /** Picker variant: a leading "#" column numbered 1..K. */
  numbered?: boolean;
  /** /sessions: suffixes "*" onto the id cell of the session matching this id. */
  currentId?: string;
  /** /sessions all: appends a workspace column. */
  showWorkspace?: boolean;
  /** Dim header role (paint-after-padEnd, design §2.2/A18). */
  theme?: CliTheme;
}

/**
 * Renders a SessionMeta[] snapshot as a fixed-width table (design §2.2,
 * mirrors renderMcpStatusTable/renderSkillsTable/renderWorkflowsTable in
 * render.ts, A18): columns `[#,] id, title, mode, updated [, workspace]`.
 * Empty input renders `"[sessions] none found\n"`. Column widths are computed
 * on the UNPAINTED row strings first; only the fully-formatted header line is
 * then wrapped in the `dim` role — SGR never perturbs alignment (A18/L8).
 */
export function renderSessionsTable(metas: SessionMeta[], opts: SessionsTableOptions): string {
  if (metas.length === 0) {
    return "[sessions] none found\n";
  }
  const numbered = opts.numbered ?? false;
  const showWorkspace = opts.showWorkspace ?? false;
  const header = [
    ...(numbered ? ["#"] : []),
    "id",
    "title",
    "mode",
    "updated",
    ...(showWorkspace ? ["workspace"] : []),
  ];
  const rows = metas.map((meta, index) => {
    const idCell = shortSessionId(meta.id) + (meta.id === opts.currentId ? "*" : "");
    return [
      ...(numbered ? [String(index + 1)] : []),
      idCell,
      formatTitleCell(meta.title),
      meta.mode,
      formatRelativeTime(meta.updatedAt, opts.now),
      ...(showWorkspace ? [meta.workspace] : []),
    ];
  });
  const widths = header.map((label, i) => Math.max(label.length, ...rows.map((row) => row[i]!.length)));
  const formatRow = (cols: string[]): string =>
    cols.map((col, i) => col.padEnd(widths[i]!)).join("  ").trimEnd();
  const headerLine = formatRow(header);
  return [opts.theme?.paint("dim", headerLine) ?? headerLine, ...rows.map(formatRow)].join("\n") + "\n";
}

export type SessionPickResult =
  | { kind: "resume"; session: SessionMeta }
  | { kind: "new" }
  | { kind: "abort" };

export interface SessionPickerOptions {
  /* */
  sessions: SessionMeta[];
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  theme: CliTheme;
  /** Default Date.now(); injectable for tests. */
  now?: number;
}

/**

 * `renderSessionsTable(sessions, {numbered: true, now})`, then opens its OWN
 * short-lived `readline.Interface` (the main REPL's rl does not exist yet at
 * this point in boot, design A13/A14) and asks
 * `pick a session (1-K), Enter = new, q = quit: ` (K = sessions.length).
 *
 * Answers: ""/"n"/"new" -> {kind:"new"}; an integer in 1..K -> {kind:"resume"}
 * (1-indexed into `sessions`); "q"/"quit" -> {kind:"abort"}; anything else
 * re-prompts, up to SESSIONS_PICKER_MAX_REPROMPTS unrecognised answers, after
 * which it fails soft to {kind:"new"} (a UX cap, not a security boundary —
 * unlike CLI_ASK_MAX_REPROMPTS's fail-closed deny). A `SIGINT` on the picker's
 * rl, or a `close` with no answer yet (EOF / a PassThrough's `end()`), both
 * resolve {kind:"abort"}. The picker's rl is ALWAYS closed before returning
 * (try/finally) so its input stream is immediately safe for the main rl to
 * take over.
 */
export async function promptSessionSelection(opts: SessionPickerOptions): Promise<SessionPickResult> {
  const { sessions, input, output, theme } = opts;
  const now = opts.now ?? Date.now();
  const total = sessions.length;
  output.write(renderSessionsTable(sessions, { numbered: true, now, theme }));

  const rl = createInterface({ input, output });
  try {
    return await new Promise<SessionPickResult>((resolve) => {
      let settled = false;
      let unrecognized = 0;

      const settle = (result: SessionPickResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(result);
      };

      rl.on("SIGINT", () => settle({ kind: "abort" }));
      rl.on("close", () => settle({ kind: "abort" }));

      const ask = (): void => {
        rl.question(`pick a session (1-${total}), Enter = new, q = quit: `, (answer) => {
          if (settled) {
            return;
          }
          const normalized = answer.trim().toLowerCase();
          if (normalized === "" || normalized === "n" || normalized === "new") {
            settle({ kind: "new" });
            return;
          }
          if (normalized === "q" || normalized === "quit") {
            settle({ kind: "abort" });
            return;
          }
          const asIndex = Number(normalized);
          if (Number.isInteger(asIndex) && asIndex >= 1 && asIndex <= total) {
            settle({ kind: "resume", session: sessions[asIndex - 1]! });
            return;
          }
          unrecognized += 1;
          if (unrecognized >= SESSIONS_PICKER_MAX_REPROMPTS) {
            settle({ kind: "new" });
            return;
          }
          ask();
        });
      };
      ask();
    });
  } finally {
    rl.close();
  }
}
