/**
 * CLI status line / spinner (design slice-4.2-cut.md §2.5/§3.3). One
 * redraw-in-place line `<frame> <label> (<N>s)`, gated STRICTLY behind a real

 * so no PassThrough test ever sees a spinner byte. Task 4.2.1 froze the
 * interfaces + constants and shipped a full no-op stub; task 4.2.3 (this file)
 * implements the real tick-driven machinery:
 *
 *   - The line repaints ONLY on the interval tick (CLI_STATUS_INTERVAL_MS), never
 *     in set(). This is what resolves the stream conflict structurally (design

 *     does NOT repaint, so a fast text/reasoning stream keeps the status invisible
 *     (each chunk lands before the next tick) while a stall ≥ one tick lets the
 *     spinner surface — liveness with zero per-event suppress branches.
 *   - CLI_STATUS_ERASE (`\r` + EL2) is the SINGLE cursor-control sequence used —
 *     no alt-screen, no absolute positioning, no cursor save/restore.
 *   - color=true ⇒ braille frames + cyan `spinner` role; color=false ⇒ plain-ASCII
 *     frames and identity paint (the no-color visual invariant), read straight off
 *     the theme's own `color` flag.
 *   - The interval is unref()'d (never holds the process alive) AND dropped on an
 *     explicit dispose(); after dispose, set() is a no-op.
 *
 * `painted` is the only shared state; every call is synchronous on the single
 * event-loop thread, so no settle-race is possible. No new deps; no module
 * outside cli/ imports from here.
 */

import type { AgentEvent } from "../types/events.js";
import type { CliTheme } from "./theme.js";
import type { TerminalPrompter } from "./terminal-broker.js";

export interface StatusLine {
  readonly enabled: boolean;
  /** Set the label; the REDRAW is not immediate — it lands on the next tick (design §3.3). */
  set(label: string): void;
  /** Erase what was drawn and stop redrawing until the next set. */
  clear(): void;
  /** Wrap a transcript write so the status line is erased BEFORE the payload bytes. */
  wrapWrite(write: (text: string) => void): (text: string) => void;
  /** clear + drop the interval; after dispose, set is a no-op. */
  dispose(): void;
}

/** Redraw cadence (design §3.3): the status line repaints only on this tick, never in set(). */
export const CLI_STATUS_INTERVAL_MS = 120;
/* */
export const CLI_STATUS_ERASE = "\r\x1b[2K";
/** Spinner frames when color=true (braille). */
export const CLI_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** Spinner frames when color=false — plain ASCII, the no-color visual invariant (design §3.3). */
export const CLI_SPINNER_FRAMES_ASCII = ["-", "\\", "|", "/"];

/**
 * Creates a status line (design §2.5/§3.3). `enabled === false` ⇒ a full no-op:
 * `enabled` is honoured as a field but nothing is ever written, wrapWrite returns
 * the SAME write function (identity), and no interval is created — so a non-TTY
 * session stays byte-identical to today (zero status bytes). `enabled === true`
 * builds the real tick-driven redraw described in this module's header.
 */
export function createStatusLine(opts: {
  output: NodeJS.WritableStream;
  /** Computed in runCli (design §2.6): false ⇒ full no-op, wrapWrite = identity. */
  enabled: boolean;
  theme: CliTheme;
  /** Redraw cadence; default CLI_STATUS_INTERVAL_MS. */
  intervalMs?: number;
  /** Injectable clock for elapsed-second rendering (unit tests). */
  now?: () => number;
}): StatusLine {
  if (!opts.enabled) {

    return {
      enabled: false,
      set(_label: string): void {},
      clear(): void {},
      wrapWrite(write: (text: string) => void): (text: string) => void {
        return write;
      },
      dispose(): void {},
    };
  }

  const { output, theme } = opts;
  const now = opts.now ?? ((): number => Date.now());
  const intervalMs = opts.intervalMs ?? CLI_STATUS_INTERVAL_MS;
  // Read the theme's own color flag (design §3.3): braille frames when color is on,
  // plain ASCII when off — the no-color visual invariant. No SGR-probe needed.
  const frames = theme.color ? CLI_SPINNER_FRAMES : CLI_SPINNER_FRAMES_ASCII;

  /** Current label, or null when there is nothing to show (post clear / pre first set). */
  let label: string | null = null;
  /** The only shared state: whether a status line is currently on screen. */
  let painted = false;
  /** Time of the first set after the last clear — the elapsed anchor (injectable clock). */
  let startMs: number | null = null;
  /** Advances every tick so the spinner frame rotates. */
  let frameIndex = 0;
  /** After dispose, set() is a no-op and no tick draws. */
  let disposed = false;

  /** Elapsed whole seconds since the current label's first set (design §3.3). */
  const elapsedSeconds = (): number =>
    startMs === null ? 0 : Math.floor((now() - startMs) / 1000);

  /** Erase the on-screen line (if any) and drop the label + elapsed anchor. */
  const eraseAndReset = (): void => {
    if (painted) {
      output.write(CLI_STATUS_ERASE);
      painted = false;
    }
    label = null;
    startMs = null;
  };

  /**
   * One redraw (design §3.3): erase the previous line and paint
   * `<frame> <label> (<N>s)` — the frame in the `spinner` role, the label + elapsed
   * in `dim`. Fires only from the interval, never from set(); a no-op while there
   * is no label so an idle interval writes nothing.
   */
  const tick = (): void => {
    if (disposed || label === null) {
      return;
    }
    // frames is a compile-time non-empty constant, so the modulo is always in range.
    const frame = frames[frameIndex % frames.length]!;
    frameIndex += 1;
    const line = `${theme.paint("spinner", frame)} ${theme.paint("dim", `${label} (${elapsedSeconds()}s)`)}`;
    output.write(`${CLI_STATUS_ERASE}${line}`);
    painted = true;
  };

  const timer = setInterval(tick, intervalMs);

  // also clears it explicitly (double defense). unref is optional-chained so a
  // fake-timer handle without it is tolerated.
  (timer as { unref?: () => void }).unref?.();

  return {
    enabled: true,
    set(nextLabel: string): void {
      if (disposed) {
        return;
      }
      label = nextLabel;
      // Start the elapsed clock only if it is not already running: consecutive
      // labels within one turn share a single elapsed origin until a clear resets it.
      if (startMs === null) {
        startMs = now();
      }
      // Deliberately no immediate redraw — the next tick paints it (design §3.3).
    },
    clear(): void {
      // Erase the on-screen line (if any) and silence the redraw until the next
      // set. Runs even after dispose so the final teardown erase is not swallowed.
      eraseAndReset();
    },
    wrapWrite(write: (text: string) => void): (text: string) => void {
      // Erase the status line through the SAME sink as the payload so the bytes
      // stay ordered, then do NOT repaint — the next tick surfaces the spinner if

      return (text: string): void => {
        if (painted) {
          write(CLI_STATUS_ERASE);
          painted = false;
        }
        write(text);
      };
    },
    dispose(): void {
      // Erase the line + reset, then drop the interval so no timer outlives the
      // REPL (design §3.3). `disposed` makes a later set() a no-op.
      disposed = true;
      eraseAndReset();
      clearInterval(timer);
    },
  };
}

/**
 * Pure event -> label table (design §3.3): a string is a new label, null is a
 * clear, undefined leaves the current label untouched. Tested without timers or
 * streams. Every event type not listed falls through to undefined (leave as-is),
 * so streamed deltas and turn/finish bookkeeping never disturb the shown label.
 */
export function statusLabelFor(event: AgentEvent): string | null | undefined {
  switch (event.type) {
    case "turn_start":
      return "thinking";
    case "reasoning_start":
      return "thinking";
    case "text_start":
      return "responding";
    case "tool_input_start":
      return `calling ${event.toolName}`;
    case "tool_execution_start":
      return `running ${event.toolName}`;
    case "tool_result":
      return "thinking";
    case "compaction_start":
      return "compacting context";
    case "compaction_end":
      return "thinking";
    case "error":
      return null;
    case "loop_end":
      return null;
    default:
      return undefined;
  }
}

/**
 * Applies the label table to an instance — the only three lines the REPL loop
 * calls per event (design §2.5). string -> set, null -> clear, undefined -> no-op
 * (leave the current label untouched).
 */
export function applyStatus(status: StatusLine, event: AgentEvent): void {
  const label = statusLabelFor(event);
  if (label === undefined) {
    return;
  }
  if (label === null) {
    status.clear();
    return;
  }
  status.set(label);
}

/**
 * Decorates a prompter so the status line is cleared BEFORE the ask is delegated

 * output, bypassing wrapWrite, so this decorator is the only place that can erase
 * the status line ahead of a `[permission]` prompt. The clear() runs first, then
 * the original ask — an order the broker relies on for a garbage-free prompt.
 */
export function withStatusClear(prompter: TerminalPrompter, status: StatusLine): TerminalPrompter {
  return {
    ask(question: string, opts?: { signal?: AbortSignal }): Promise<string> {
      status.clear();
      return prompter.ask(question, opts);
    },
  };
}
