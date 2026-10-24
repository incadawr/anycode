/**
 * Ink TUI shell — Taskana 4082 (TASK.26). Slice 1 shipped the composer with
 * history and slash autocomplete; the review rework adds what TASK.26 requires
 * from day one plus the two defects found in the wild:
 *
 * - `<Static>` transcript (defect 1): every REPL byte written while the TUI is
 *   mounted lands in a transcript store rendered via Ink's `<Static>` — Ink
 *   never erases those lines when it redraws the composer, so the banner, the
 *   tail of /help and tool output survive every frame. main.ts routes its
 *   writer/print sink through `handle.print()` while mounted; nothing but Ink
 *   itself writes to the terminal.
 * - Confirm mode (defect 2): y/N questions (permission asks, /commit, /rewind)
 *   render INSIDE the TUI as a dedicated composer mode — Enter answers with
 *   the highlighted default, y/n pick directly, Esc cancels. The answer is
 *   produced by the TUI itself, so it can never leak into the prompt path the
 *   way a double-captured rl.question line did.
 * - Multiline + cursor editing (defect 4): Enter submits, a trailing
 *   backslash continues onto a new line, and left/right/home/end/backspace
 *   edit at the cursor (reducer events, unit-tested in composer-state.test.ts).
 *
 * This module is the ONLY place in packages/core that imports `ink`/`react`.
 * main.ts loads it lazily (dynamic `await import("./tui.js")`) inside the
 * --tui branch, and the esbuild bundle emits it as a SEPARATE chunk
 * (dist/cli/tui.js) so non-TUI runs never even parse the ink/react code
 * (defect 3; see apps/cli/scripts/build.mjs).
 *
 * Key semantics (frozen by the slice-1 brief, extended by the rework):
 * - Enter submits the line via onSubmit, EXCEPT (a) the popup is open with
 *   more than one visible item — then Enter commits the selection — or (b)
 *   the input ends with a backslash — then it continues onto a new line.
 * - ArrowUp/Down navigate the popup while it is open, history while closed.
 * - Esc clears the input (or answers a confirm with the default "no" side:
 *   cancels to the non-default answer); Ctrl+C is forwarded to
 *   opts.onInterrupt (main.ts maps it onto the existing SIGINT logic).
 * - While a confirm question is pending, every key is routed to the confirm
 *   handler — the composer is suspended, nothing can reach onSubmit.
 */

import { render, Static, Text, useInput, useStdin, useStdout, type Instance, type Key } from "ink";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

import { slashCompletions, type SlashCompletion } from "./completions.js";
import {
  EMPTY_COMPOSER,
  isContinuation,
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

/** One pending y/N question (defect 2): asked through ask(), answered in-TUI. */
interface ConfirmEntry {
  /** Raw question text (already formatted by the caller, no trailing space). */
  readonly question: string;
  /** Default answer: "y" or "n" — what Enter submits and the bold option. */
  readonly defaultAnswer: "y" | "n";
  resolve: (answer: string) => void;
  /** Fail path: signal abort or TUI close — rejects the asker's promise. */
  abort: () => void;
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
  /**
   * REPL transcript sink (defect 1): every byte the CLI wants on screen while
   * the TUI is mounted goes through here and is rendered via `<Static>` —
   * never written straight to stdout, which Ink's frame clear would eat.
   * Formatted text (already themed/newlined by the caller); the TUI only
   * appends. No-op after close() (the writer fell back to raw output).
   */
  print(text: string): void;
  /**
   * Asks one y/N question INSIDE the TUI (defect 2): the composer switches to
   * confirm mode until answered; keys route to the confirm, never to onSubmit.
   * Resolves with the raw answer line ("y"/"n"/"" — the caller keeps its own
   * default semantics), or rejects with an AbortError-named Error when the
   * signal aborts or the TUI closes. Never writes to stdout: the question
   * renders as part of the live frame; once answered it is appended to the
   * transcript ("<question> <answer>") so it scrolls into history.
   */
  ask(question: string, opts?: { signal?: AbortSignal }): Promise<string>;
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
  /** The pending y/N question, or null (display only — drives confirm rendering). */
  readonly confirm: ConfirmEntry | null;
  /**
   * LIVE confirm source (stable object identity, mutated outside React):
   * the key handler reads this synchronously, so a confirm answered a
   * microtask ago is already gone even before React commits the re-render —
   * without it, keys typed right after an answer would be eaten by the dead
   * confirm (and keys typed right after ask() would leak into the composer).
   */
  readonly confirmLive: { current: { entry: ConfirmEntry | null; answer: (answer: string) => void } };
}

function Composer({
  completionsSource,
  onSubmit,
  onInterrupt,
  openRef,
  onRegisterInjector,
  confirm,
  confirmLive,
}: ComposerProps): React.ReactElement {
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

  const submitNow = (raw: string): void => {
    // Submitted lines are normalized like readline: the trailing continuation
    // backslash was already been replaced by a newline at Enter-time, so a
    // raw backslash remaining here only unescapes whitespace.
    const normalized = raw.replace(/\\\s+$/, "").replace(/\s+$/, "");
    if (normalized !== "" && openRef.current) {
      onSubmit(normalized);
    }
  };

  const handleToken = (input: string, key: Key): void => {
    const current = stateRef.current;
    // Synchronously mirror what the reducer will produce so tokens emitted
    // within one React batch (before commit) still see each other's effects:
    // every input-changing branch computes the next input value up front and
    // dispatches an event carrying it (the reducer applies the value verbatim
    // or its own semantics for submit/clear/popup events).
    const advance = (event: ComposerEvent, nextInput: (state: ComposerState) => string, nextCursor?: (state: ComposerState) => number): void => {
      const value = nextInput(current);
      const cursor = nextCursor ? nextCursor(current) : value.length;
      stateRef.current = { ...current, input: value, cursor };
      dispatch(event);
    };

    if (key.ctrl && input === "c") {
      onInterrupt?.();
      return;
    }

    // Defect 2: while a y/N question is pending, EVERY key routes to the
    // confirm — the composer never sees it, so an answer can never leak into
    // the prompt path. Read through confirmLive (synchronous, outside React)
    // so the routing decision never lags a render behind the store.
    if (confirmLive.current.entry !== null) {
      if (key.ctrl || key.meta || key.tab || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.home || key.end || key.pageUp || key.pageDown) {
        return; // navigation/modifier keys are not answers
      }
      if (key.return) {
        confirmLive.current.answer("");
        return;
      }
      if (key.escape) {
        confirmLive.current.answer("esc");
        return;
      }
      if (key.backspace || key.delete) {
        return;
      }
      if (input.length > 0 && !input.startsWith("\u001b") && !input.startsWith("\r")) {
        // Keep the first printable char only: confirms are one-key dialogs.
        confirmLive.current.answer(input.toLowerCase());
      }
      return;
    }

    if (key.return) {
      const open = current.popupOpen && visibleCompletions(current, completions).length > 1;
      if (open) {
        advance({ type: "popup-commit" }, (s) => {
          const chosen = visibleCompletions(s, completions)[s.selected] ?? visibleCompletions(s, completions)[0];
          return chosen ? `${chosen.command} ` : s.input;
        });
      } else if (isContinuation(current.input)) {
        // Trailing backslash: continue onto a new line (readline convention).
        advance(
          { type: "newline" },
          (s) => `${s.input.slice(0, -1)}\n`,
          (s) => s.input.length, // cursor at end: same slot the backslash occupied
        );
      } else {
        const value = current.input;
        advance({ type: "submit" }, () => "", () => 0);
        if (value.trim() !== "") {
          submitNow(value);
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
      advance({ type: "clear" }, () => "", () => 0);
      return;
    }
    if (key.backspace || key.delete) {
      advance(key.backspace ? { type: "backspace" } : { type: "delete" }, (s) =>
        key.backspace
          ? s.cursor > 0
            ? s.input.slice(0, s.cursor - 1) + s.input.slice(s.cursor)
            : s.input
          : s.cursor < s.input.length
            ? s.input.slice(0, s.cursor) + s.input.slice(s.cursor + 1)
            : s.input,
        (s) => (key.backspace ? Math.max(0, s.cursor - 1) : s.cursor),
      );
      return;
    }
    if (key.leftArrow) {
      advance({ type: "cursor-left" }, (s) => s.input, (s) => Math.max(0, s.cursor - 1));
      return;
    }
    if (key.rightArrow) {
      advance({ type: "cursor-right" }, (s) => s.input, (s) => Math.min(s.input.length, s.cursor + 1));
      return;
    }
    if (key.home) {
      advance({ type: "cursor-home" }, (s) => s.input, () => 0);
      return;
    }
    if (key.end) {
      advance({ type: "cursor-end" }, (s) => s.input, (s) => s.input.length);
      return;
    }
    if (key.pageUp || key.pageDown) {
      return;
    }
    if (key.ctrl || key.meta) {
      return; // ctrl/meta combos are not composer input
    }
    if (input.length > 0 && !input.startsWith("\u001b") && !input.startsWith("\r")) {
      advance({ type: "insert", value: input }, (s) => s.input.slice(0, s.cursor) + input + s.input.slice(s.cursor), (s) => s.cursor + input.length);
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

  const before = state.input.slice(0, state.cursor);
  const at = state.input.slice(state.cursor, state.cursor + 1);
  const after = state.input.slice(state.cursor + (at.length > 0 ? 1 : 0));

  return (
    <>
      {confirm !== null ? (
        <>
          <Text>{confirm.question}</Text>
          <Text>
            {"answer ["}
            <Text bold={confirm.defaultAnswer === "y"}>Y</Text>
            {"/"}
            <Text bold={confirm.defaultAnswer === "n"}>n</Text>
            {"] "}
            <Text dimColor>(Enter = {confirm.defaultAnswer === "y" ? "yes" : "no"} · Esc = {confirm.defaultAnswer === "y" ? "no" : "yes"})</Text>
          </Text>
        </>
      ) : (
        <>
          <Text>
            {"> "}
            {before}
            <Text inverse>{at.length > 0 ? at : " "}</Text>
            {after}
          </Text>
          {state.popupOpen ? <Popup state={state} completions={completions} /> : null}
        </>
      )}
    </>
  );
}

/** An Error whose `name` is "AbortError", so the broker recognises the abort path. */
function abortError(): Error {
  const error = new Error("The TUI confirm was aborted");
  error.name = "AbortError";
  return error;
}

/**
 * Derives the default answer from the question's trailing [y/N]-style marker
 * (the CLI's confirm formatter appends one): "[Y/n]" -> "y", anything else
 * (including "[y/N]" and no marker) -> "n".
 */
function defaultAnswerOf(question: string): "y" | "n" {
  return /\[Y\/n\]/.test(question) ? "y" : "n";
}

/**
 * Mounts the Ink composer + `<Static>` transcript. Input reaches the app
 * either through Ink's stdin read loop (real terminals, raw mode) or through
 * the handle's emit() (tests drive it with ANSI tokens) — both paths go
 * through the same parseKeypress -> useInput pipeline. The returned handle's
 * close() unmounts the app and marks it closed; after close() no further
 * onSubmit/onInterrupt callbacks fire and emit()/print()/ask() are no-ops.
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

  // ---- Shared stores (mutated by the handle, read by the shell component) ----
  // Transcript store (defect 1): strings are immutable once appended; the
  // array itself is swapped so React sees a new reference per append.
  const store: { transcript: string[]; confirm: ConfirmEntry | null; closed: boolean } = {
    transcript: [],
    confirm: null,
    closed: false,
  };
  const wake: { listeners: Set<() => void> } = { listeners: new Set() };
  const notify = (): void => {
    for (const listener of [...wake.listeners]) {
      listener();
    }
  };
  // LIVE confirm source: read synchronously by the key handler (outside
  // React's commit cycle) so confirm routing never lags a render behind the
  // store. `answer` performs the whole settle side effect: normalize the key
  // (""=default, "esc"=flip), append the echo line, clear, wake, resolve.
  const confirmLive: { current: { entry: ConfirmEntry | null; answer: (answer: string) => void } } = {
    current: {
      entry: null,
      answer: (answer: string): void => {
        const entry = store.confirm;
        if (entry === null) {
          return;
        }
        const normalized =
          answer === ""
            ? entry.defaultAnswer
            : answer === "esc"
              ? entry.defaultAnswer === "y"
                ? "n"
                : "y"
              : answer;
        store.confirm = null;
        confirmLive.current.entry = null;
        store.transcript = [...store.transcript, `${entry.question} ${normalized}`];
        notify();
        entry.resolve(normalized);
      },
    },
  };

  function Shell(): React.ReactElement {
    const [, setTick] = useState(0);
    const rerender = useCallback((): void => setTick((t) => t + 1), []);
    useEffect(() => {
      wake.listeners.add(rerender);
      return () => {
        wake.listeners.delete(rerender);
      };
    }, [rerender]);
    const items = store.transcript;
    return (
      <>
        <Static items={items}>
          {(line, index) => (
            <Text key={index}>{line}</Text>
          )}
        </Static>
        <Composer
          completionsSource={completionsSource}
          onSubmit={guardedSubmit}
          onInterrupt={opts.onInterrupt ? guardedInterrupt : undefined}
          openRef={openRef}
          onRegisterInjector={onRegisterInjector}
          confirm={store.confirm}
          confirmLive={confirmLive}
        />
      </>
    );
  }

  const instance: Instance = render(<Shell />, {
    stdin: opts.input,
    stdout: opts.output,
    patchConsole: false,
    exitOnCtrlC: false,
    // Ink auto-detects non-TTY stdout as "non-interactive" and defers every
    // frame until unmount. Tests (PassThrough) need live frames; on a real
    // TTY this option is a no-op (already interactive).
    interactive: true,
  });

  return {
    isOpen: () => !store.closed,
    close(): void {
      if (store.closed) {
        return;
      }
      store.closed = true;
      openRef.current = false;
      // Defect 2 hygiene: a pending confirm must never dangle past close().
      store.confirm?.abort();
      confirmLive.current.entry = null;
      instance.unmount();
      notify();
    },
    emit(_key: string, data: string): void {
      if (store.closed) {
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
    print(text: string): void {
      if (store.closed) {
        return;
      }
      store.transcript = [...store.transcript, text];
      notify();
    },
    ask(question: string, askOpts?: { signal?: AbortSignal }): Promise<string> {
      if (store.closed) {
        return Promise.reject(abortError());
      }
      const signal = askOpts?.signal;
      if (signal?.aborted) {
        return Promise.reject(abortError());
      }
      return new Promise<string>((resolve, reject) => {
        let settled = false;
        const onAbort = (): void => {
          if (settled) {
            return;
          }
          settled = true;
          signal?.removeEventListener("abort", onAbort);
          if (store.confirm === entry) {
            store.confirm = null;
            confirmLive.current.entry = null;
            notify();
          }
          reject(abortError());
        };
        const entry: ConfirmEntry = {
          question: question.trimEnd(),
          defaultAnswer: defaultAnswerOf(question),
          resolve: (answer: string): void => {
            if (settled) {
              return;
            }
            settled = true;
            signal?.removeEventListener("abort", onAbort);
            resolve(answer);
          },
          abort: onAbort,
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        store.confirm = entry;
        confirmLive.current.entry = entry;
        notify();
      });
    },
  };
}
