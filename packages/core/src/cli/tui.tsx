/**
 * Ink TUI shell — Taskana 4082 (TASK.26) slice 1: composer with history and
 * slash autocomplete over the existing KNOWN_SLASH_COMMANDS dispatcher.
 *
 * This module is the ONLY place in packages/core that imports `ink`/`react`.
 * main.ts loads it lazily (await import("./tui.js")) inside the --tui branch,
 * so non-TTY/--print runs never pay for it (see §2.6 of the slice-1 brief).
 * The file is .tsx because the components are authored in JSX; the .js import
 * specifier resolves to it under NodeNext/tsx/vitest/esbuild alike.
 *
 * Key semantics (frozen by the brief):
 * - Enter submits the line via onSubmit, EXCEPT when the popup is open with
 *   more than one visible item — then Enter commits the selection instead
 *   (Tab/Right commit unconditionally when the popup is open).
 * - ArrowUp/Down navigate the popup while it is open, history while closed.
 * - Esc clears the input; Ctrl+C is forwarded to opts.onInterrupt (main.ts
 *   maps it onto the existing SIGINT logic: abort-in-flight, else the
 *   double-press exit counter).
 * - The input is a minimal controlled TextInput built directly on useInput —
 *   ink-text-input is a separate package this slice does not add. Cursor
 *   editing (left/right/home/end) is slice-2 territory; characters append and
 *   Backspace deletes the tail.
 */

import { render, Text, useInput, useStdin, useStdout, type Instance, type Key } from "ink";
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";

import { slashCompletions, type SlashCompletion } from "./completions.js";
import {
  EMPTY_COMPOSER,
  reduceComposer,
  visibleCompletions,
  type ComposerEvent,
  type ComposerState,
} from "./composer-state.js";

export interface TuiOptions {
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
  /** Completion source; defaults to slashCompletions (§2.2 rule). */
  readonly completionsSource?: (query: string) => SlashCompletion[];
}

export interface TuiHandle {
  /** True between startTui and close(); guards against stale callbacks. */
  readonly isOpen: () => boolean;
  /** Unmounts the Ink app and restores the terminal. Idempotent. */
  close(): void;
  /**
   * Directly injects one input token through Ink's input pipeline (the same
   * path real keypresses take: parseKeypress -> useInput handlers). The
   * driver loop uses this instead of reading stdin, so real stdin is only a
   * fallback for raw terminals. No-op after close().
   */
  emit(key: string, data: string): void;
}

export type StartTuiOptions = TuiOptions & {
  /** Called exactly once per submitted line (never after close()). */
  readonly onSubmit: (line: string) => void;
  /** Ctrl+C forwarding — main.ts maps it onto the existing SIGINT logic. */
  readonly onInterrupt?: () => void;
};

/** Reads the terminal width for popup truncation (the reducer never sees it). */
function terminalWidth(stdout: NodeJS.WritableStream): number {
  const width = (stdout as NodeJS.WritableStream & { columns?: number }).columns;
  return typeof width === "number" && Number.isFinite(width) && width > 0 ? width : 80;
}

/** Ellipsised summary that fits the popup row: width − command − 3. */
function fitSummary(summary: string, command: string, width: number): string {
  const budget = Math.max(0, width - command.length - 3);
  if (summary.length <= budget) {
    return summary;
  }
  return budget <= 1 ? "" : `${summary.slice(0, Math.max(0, budget - 1))}…`;
}

interface PopupProps {
  readonly state: ComposerState;
  readonly completions: readonly SlashCompletion[];
}

function Popup({ state, completions }: PopupProps): React.ReactElement {
  const { stdout } = useStdout();
  const width = terminalWidth(stdout);
  const rows = visibleCompletions(state, completions);
  return (
    <>
      {rows.map((row, index) => (
        <Text key={row.command} inverse={index === state.selected}>
          {index === state.selected ? "❯ " : "  "}
          {row.command} <Text dimColor>{fitSummary(row.summary, row.command, width)}</Text>
        </Text>
      ))}
      <Text dimColor>↑↓ select · Tab/→ complete · Esc clear</Text>
    </>
  );
}

/**
 * Splits a raw input string into key tokens (single printable chars or whole
 * escape sequences). Conservative: an ESC always starts a sequence that runs
 * to the final byte of a CSI/SS3 sequence or, failing that, stands alone.
 */
function tokenizeInput(data: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < data.length) {
    const ch = data[i];
    if (ch === undefined) {
      break;
    }
    if (ch === "\u001b") {
      // CSI: ESC [ params byte ; a lone ESC at the end is its own token.
      const rest = data.slice(i);
      const csi = /^\u001b\[[0-9;?]*[A-Za-z]/.exec(rest);
      if (csi) {
        tokens.push(csi[0]);
        i += csi[0].length;
        continue;
      }
      const ss3 = /^\u001bO[A-Za-z]/.exec(rest);
      if (ss3) {
        tokens.push(ss3[0]);
        i += ss3[0].length;
        continue;
      }
      if (rest.length > 1 && data[i + 1] !== "[") {
        // Alt-modified key: treat ESC+char as one token, consumed as the char.
        tokens.push(rest.slice(0, 2));
        i += 2;
        continue;
      }
      tokens.push("\u001b");
      i += 1;
      continue;
    }
    // Combine an emoji/combining cluster cheaply: single UTF-16 code unit is
    // the common case; surrogate pairs stay together.
    const code = ch.codePointAt(0) ?? 0;
    const size = code > 0xffff ? 2 : 1;
    tokens.push(data.slice(i, i + size));
    i += size;
  }
  return tokens;
}

/** Maps a raw token to the (input, key) pair ink's useInput would report. */
function parseTokenKey(token: string): { input: string; key: Key } {
  const base = {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    home: false,
    end: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    super: false,
    hyper: false,
    capsLock: false,
    numLock: false,
  };
  switch (token) {
    case "\r":
      return { input: "", key: { ...base, return: true } };
    case "\t":
      return { input: "", key: { ...base, tab: true } };
    case "\u007f":
    case "\b":
      return { input: "", key: { ...base, backspace: true } };
    case "\u001b":
      return { input: "", key: { ...base, escape: true } };
    case "\u0003":
      return { input: "c", key: { ...base, ctrl: true } };
    case "\u001b[A":
      return { input: "", key: { ...base, upArrow: true } };
    case "\u001b[B":
      return { input: "", key: { ...base, downArrow: true } };
    case "\u001b[C":
      return { input: "", key: { ...base, rightArrow: true } };
    case "\u001b[D":
      return { input: "", key: { ...base, leftArrow: true } };
    case "\u001b[H":
    case "\u001b[1~":
      return { input: "", key: { ...base, home: true } };
    case "\u001b[F":
    case "\u001b[4~":
      return { input: "", key: { ...base, end: true } };
    default: {
      if (token.startsWith("\u001b") && token.length === 2) {
        // Alt+char: meta with the char payload (ink reports sequence minus ESC).
        return { input: token[1] ?? "", key: { ...base, meta: true } };
      }
      const upper = /^[A-Z]$/.test(token);
      return { input: token, key: { ...base, shift: upper } };
    }
  }
}

interface ComposerProps {
  readonly completionsSource: (query: string) => SlashCompletion[];
  readonly onSubmit: (line: string) => void;
  readonly onInterrupt?: () => void;
  readonly openRef: { readonly current: boolean };
  /** Registers the raw-token injector handle.emit() drives (non-TTY stdin). */
  readonly onRegisterInjector: (inject: ((data: string) => void) | null) => void;
}

function Composer({ completionsSource, onSubmit, onInterrupt, openRef, onRegisterInjector }: ComposerProps): React.ReactElement {
  const completions = useMemo(() => completionsSource("/"), [completionsSource]);
  const [state, dispatch] = useReducer(
    (state: ComposerState, event: ComposerEvent) => reduceComposer(state, event, completions),
    EMPTY_COMPOSER,
  );
  // Ink's useInput calls setRawMode(true) on mount, which throws when stdin is
  // not a TTY (tests, pipes). Gate it: on real terminals isActive is true and
  // nothing changes; on non-TTY stdin the driver feeds keys via handle.emit.
  const { isRawModeSupported } = useStdin();
  const stateRef = useRef(state);
  stateRef.current = state;

  const handleToken = (input: string, key: Key): void => {
    const current = stateRef.current;
    // Synchronously mirror what the reducer will produce so tokens emitted
    // within one React batch (before commit) still see each other's effects:
    // every input-changing branch computes the next input value up front and
    // dispatches a `text` event carrying it (the reducer's text branch applies
    // the value verbatim; submit/clear/popup events carry their own semantics).
    const advance = (event: ComposerEvent, nextInput: (state: ComposerState) => string): void => {
      const value = nextInput(current);
      stateRef.current = { ...current, input: value };
      dispatch(event.type === "text" ? { type: "text", value } : event);
    };

    if (key.ctrl && input === "c") {
      onInterrupt?.();
      return;
    }
    if (key.return) {
      const open = current.popupOpen && visibleCompletions(current, completions).length > 1;
      if (open) {
        advance({ type: "popup-commit" }, (s) => {
          const chosen = visibleCompletions(s, completions)[s.selected] ?? visibleCompletions(s, completions)[0];
          return chosen ? `${chosen.command} ` : s.input;
        });
      } else {
        const trimmed = current.input.trim();
        advance({ type: "submit" }, () => "");
        if (trimmed !== "" && openRef.current) {
          onSubmit(trimmed);
        }
      }
      return;
    }
    if (key.tab || key.rightArrow) {
      if (current.popupOpen) {
        advance({ type: "popup-commit" }, (s) => {
          const chosen = visibleCompletions(s, completions)[s.selected] ?? visibleCompletions(s, completions)[0];
          return chosen ? `${chosen.command} ` : s.input;
        });
      }
      return;
    }
    if (key.upArrow) {
      dispatch(current.popupOpen ? { type: "popup-up" } : { type: "history-prev" });
      return;
    }
    if (key.downArrow) {
      dispatch(current.popupOpen ? { type: "popup-down" } : { type: "history-next" });
      return;
    }
    if (key.escape) {
      advance({ type: "clear" }, () => "");
      return;
    }
    if (key.backspace || key.delete) {
      advance({ type: "text", value: "" }, (s) => s.input.slice(0, Math.max(0, s.input.length - 1)));
      return;
    }
    if (key.leftArrow || key.home || key.end || key.pageUp || key.pageDown) {
      return; // cursor editing arrives in slice 2
    }
    if (key.ctrl || key.meta) {
      return; // ctrl/meta combos are not composer input
    }
    if (input.length > 0 && !input.startsWith("\u001b") && !input.startsWith("\r")) {
      advance({ type: "text", value: "" }, (s) => s.input + input);
    }
  };

  useInput(handleToken, { isActive: isRawModeSupported });

  // Non-TTY stdin: handle.emit() feeds raw tokens through the exact same
  // parseKeypress + handler path real keypresses take (the parser is a tiny
  // pure function vendored from ink's parse-keypress for the sequences we
  // care about: chars, CR, TAB, ESC, arrows, Ctrl+C).
  useEffect(() => {
    onRegisterInjector((data: string) => {
      for (const token of tokenizeInput(data)) {
        const parsed = parseTokenKey(token);
        handleToken(parsed.input, parsed.key);
      }
    });
    return () => {
      onRegisterInjector(null);
    };
  }, [onRegisterInjector]);

  return (
    <>
      <Text>
        {"> "}
        {state.input}
        <Text inverse> </Text>
      </Text>
      {state.popupOpen ? <Popup state={state} completions={completions} /> : null}
    </>
  );
}

/**
 * Mounts the Ink composer. Input reaches the app either through Ink's stdin
 * read loop (real terminals, raw mode) or through the handle's emit()
 * (main.ts drives it from readline line events when raw mode is not
 * available, and tests drive it with ANSI tokens) — both paths go through
 * the same parseKeypress -> useInput pipeline. The returned handle's
 * close() unmounts the app and marks it closed; after close() no further
 * onSubmit/onInterrupt callbacks fire and emit() is a no-op.
 */
export function startTui(opts: StartTuiOptions): TuiHandle {
  const completionsSource = opts.completionsSource ?? slashCompletions;
  const openRef: { current: boolean } = { current: true };
  const injectorRef: { current: ((data: string) => void) | null } = { current: null };
  const onRegisterInjector = (inject: ((data: string) => void) | null): void => {
    injectorRef.current = inject;
  };
  const guardedSubmit = (line: string): void => {
    if (openRef.current) {
      opts.onSubmit(line);
    }
  };
  const guardedInterrupt = (): void => {
    if (openRef.current) {
      opts.onInterrupt?.();
    }
  };

  const instance: Instance = render(
    <Composer
      completionsSource={completionsSource}
      onSubmit={guardedSubmit}
      onInterrupt={opts.onInterrupt ? guardedInterrupt : undefined}
      openRef={openRef}
      onRegisterInjector={onRegisterInjector}
    />,
    {
      stdin: opts.input,
      stdout: opts.output,
      patchConsole: false,
      exitOnCtrlC: false,
      // Ink auto-detects non-TTY stdout as "non-interactive" and defers every
      // frame until unmount. Tests (PassThrough) need live frames; on a real
      // TTY this option is a no-op (already interactive).
      interactive: true,
    },
  );

  let closed = false;
  return {
    isOpen: () => !closed,
    close(): void {
      if (closed) {
        return;
      }
      closed = true;
      openRef.current = false;
      instance.unmount();
    },
    emit(_key: string, data: string): void {
      if (closed) {
        return;
      }
      // Ink 8 exposes no public input-injection API. The Composer registers
      // a raw-token listener (injectorRef) fed through the same
      // parseKeypress -> useInput path as real keys; stdin is only a fallback
      // for the rare case where the read loop owns input.
      const injector = injectorRef.current;
      if (injector) {
        injector(data);
        return;
      }
      opts.input.emit("data", data);
    },
  };
}
