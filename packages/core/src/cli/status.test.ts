/**
 * cli/status.ts unit tests (design slice-4.2-cut.md §3.3, §5.2 item 6). The
 * tick-driven redraw is exercised with vi.useFakeTimers + an injected `now`
 * clock + a synchronous string-sink stream, so every assertion is deterministic
 * with zero sleeps. Covers: nothing before the first tick; ERASE + frame + label
 * + (Ns) on a tick; wrapWrite erase-before-payload with no repaint; clear erases
 * and silences; set-after-clear resumes with a fresh elapsed origin; dispose
 * drops the interval (no further ticks, set becomes a no-op); the unref invariant
 * (real timer, hasRef()==false); ASCII frames with color=false; the pure
 * statusLabelFor table incl. undefined/null; applyStatus routing; and
 * withStatusClear ordering (clear before the delegated ask).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../types/events.js";
import type { TerminalPrompter } from "./terminal-broker.js";
import {
  CLI_SPINNER_FRAMES,
  CLI_SPINNER_FRAMES_ASCII,
  CLI_STATUS_ERASE,
  CLI_STATUS_INTERVAL_MS,
  applyStatus,
  createStatusLine,
  statusLabelFor,
  withStatusClear,
  type StatusLine,
} from "./status.js";
import { createCliTheme } from "./theme.js";

/** A synchronous string sink — the only stream surface createStatusLine touches. */
function makeSink(): { output: NodeJS.WritableStream; read: () => string; reset: () => void } {
  let buf = "";
  const output = {
    write(chunk: string | Uint8Array): boolean {
      buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  return { output, read: () => buf, reset: () => (buf = "") };
}

describe("createStatusLine — tick-driven redraw (fake timers, injected clock)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(opts?: { color?: boolean }): {
    sink: ReturnType<typeof makeSink>;
    status: StatusLine;
    setClock: (v: number) => void;
  } {
    const sink = makeSink();
    const theme = createCliTheme({ color: opts?.color ?? true });
    let clock = 0;
    const status = createStatusLine({
      output: sink.output,
      enabled: true,
      theme,
      intervalMs: CLI_STATUS_INTERVAL_MS,
      now: () => clock,
    });
    return {
      sink,
      status,
      setClock: (v: number) => {
        clock = v;
      },
    };
  }

  it("writes nothing before the first tick (set does not redraw immediately)", () => {
    const { sink, status } = setup();
    status.set("thinking");
    expect(sink.read()).toBe("");
  });

  it("an idle interval (no label) writes nothing", () => {
    const { sink } = setup();
    vi.advanceTimersByTime(CLI_STATUS_INTERVAL_MS * 5);
    expect(sink.read()).toBe("");
  });

  it("on a tick emits ERASE + spinner frame + dim label + (0s)", () => {
    const { sink, status } = setup({ color: true });
    status.set("thinking");
    vi.advanceTimersByTime(CLI_STATUS_INTERVAL_MS);
    // frame in the cyan `spinner` role (\x1b[36m), label+elapsed in dim (\x1b[2m),
    // the whole line prefixed with the single cursor-control sequence.
    expect(sink.read()).toBe(
      `${CLI_STATUS_ERASE}\x1b[36m${CLI_SPINNER_FRAMES[0]}\x1b[0m \x1b[2mthinking (0s)\x1b[0m`,
    );
  });

  it("rotates the frame and tracks elapsed via the injected clock on later ticks", () => {
    const { sink, status, setClock } = setup({ color: true });
    status.set("thinking");
    vi.advanceTimersByTime(CLI_STATUS_INTERVAL_MS); // frame 0, 0s
    sink.reset();
    setClock(2000); // +2s on the injected clock (independent of the fake timer)
    vi.advanceTimersByTime(CLI_STATUS_INTERVAL_MS); // frame 1, 2s
    expect(sink.read()).toBe(
      `${CLI_STATUS_ERASE}\x1b[36m${CLI_SPINNER_FRAMES[1]}\x1b[0m \x1b[2mthinking (2s)\x1b[0m`,
    );
  });

  it("wrapWrite erases the painted line before the payload and does not repaint until the next tick", () => {
    const { sink, status } = setup();
    status.set("thinking");
    vi.advanceTimersByTime(CLI_STATUS_INTERVAL_MS); // painted
    sink.reset();

    const wrapped = status.wrapWrite((t) => {
      sink.output.write(t);
    });
    wrapped("payload\n");
    // erase THEN payload through the SAME sink, no repaint appended.
    expect(sink.read()).toBe(`${CLI_STATUS_ERASE}payload\n`);

    // A second write does NOT erase again — painted is already false.
    sink.reset();
    wrapped("second\n");
    expect(sink.read()).toBe("second\n");

    // The next tick surfaces the spinner again (label is still set).
    sink.reset();
    vi.advanceTimersByTime(CLI_STATUS_INTERVAL_MS);
    expect(sink.read().startsWith(CLI_STATUS_ERASE)).toBe(true);
    expect(sink.read()).toContain("thinking");
  });

  it("clear erases the painted line and silences the redraw until the next set", () => {
    const { sink, status } = setup();
    status.set("thinking");
    vi.advanceTimersByTime(CLI_STATUS_INTERVAL_MS);
    sink.reset();

    status.clear();
    expect(sink.read()).toBe(CLI_STATUS_ERASE);

    // No further ticks draw anything while the label is null.
    sink.reset();
    vi.advanceTimersByTime(CLI_STATUS_INTERVAL_MS * 5);
    expect(sink.read()).toBe("");
  });

  it("set after clear resumes drawing with a fresh elapsed origin", () => {
    const { sink, status, setClock } = setup({ color: true });
    status.set("thinking"); // startMs = 0
    setClock(5000);
    vi.advanceTimersByTime(CLI_STATUS_INTERVAL_MS); // draws "thinking (5s)"
    expect(sink.read()).toContain("thinking (5s)");

    status.clear(); // resets label + elapsed anchor
    sink.reset();

    status.set("responding"); // startMs = 5000 (fresh)
    setClock(8000); // +3s since the fresh origin
    vi.advanceTimersByTime(CLI_STATUS_INTERVAL_MS);
    expect(sink.read()).toContain("responding (3s)");
  });

  it("dispose erases, drops the interval (no more ticks), and makes set a no-op", () => {
    const { sink, status } = setup();
    status.set("thinking");
    vi.advanceTimersByTime(CLI_STATUS_INTERVAL_MS);
    expect(vi.getTimerCount()).toBe(1); // the redraw interval is live
    sink.reset();

    status.dispose();
    expect(sink.read()).toBe(CLI_STATUS_ERASE); // teardown erase
    expect(vi.getTimerCount()).toBe(0); // interval removed

    sink.reset();
    vi.advanceTimersByTime(CLI_STATUS_INTERVAL_MS * 10);
    expect(sink.read()).toBe(""); // no ticks after dispose

    status.set("thinking"); // no-op post-dispose
    vi.advanceTimersByTime(CLI_STATUS_INTERVAL_MS * 10);
    expect(sink.read()).toBe("");
  });

  it("uses plain-ASCII frames and no color SGR when color=false (erase still present)", () => {
    const { sink, status } = setup({ color: false });
    status.set("thinking");
    vi.advanceTimersByTime(CLI_STATUS_INTERVAL_MS);
    const out = sink.read();
    // Identity paint: ASCII frame, no SGR color pairs — the no-color visual invariant.
    expect(out).toBe(`${CLI_STATUS_ERASE}${CLI_SPINNER_FRAMES_ASCII[0]} thinking (0s)`);
    expect(out).not.toContain("\x1b[36m"); // no cyan (spinner role)
    expect(out).not.toContain("\x1b[2m"); // no dim (label role)
    // EL2 (`\x1b[2K`) is cursor control, not color — it is present even with no color.
    expect(out).toContain("\x1b[2K");
  });
});

describe("createStatusLine — disabled (full no-op)", () => {
  it("writes zero bytes and wrapWrite returns the identical write function", () => {
    const sink = makeSink();
    const theme = createCliTheme({ color: true });
    const status = createStatusLine({ output: sink.output, enabled: false, theme });

    expect(status.enabled).toBe(false);
    status.set("thinking");
    status.clear();
    const write = (t: string): void => {
      sink.output.write(t);
    };
    const wrapped = status.wrapWrite(write);
    expect(wrapped).toBe(write); // identity — same reference, no erase wrapper

    wrapped("hello");
    status.dispose();
    // The only byte in the sink is the caller's own payload; zero status bytes.
    expect(sink.read()).toBe("hello");
  });

  it("creates no interval when disabled", () => {
    vi.useFakeTimers();
    try {
      const sink = makeSink();
      const theme = createCliTheme({ color: true });
      createStatusLine({ output: sink.output, enabled: false, theme });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createStatusLine — interval does not hold the process (unref)", () => {
  it("unref's the redraw interval so hasRef() is false", () => {
    // Real timers here: capture the actual Node Timeout handle to inspect hasRef().
    const sink = makeSink();
    const theme = createCliTheme({ color: true });
    const realSetInterval = globalThis.setInterval;
    let handle: NodeJS.Timeout | undefined;
    const spy = vi
      .spyOn(globalThis, "setInterval")
      .mockImplementation(((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
        handle = realSetInterval(fn, ms, ...args);
        return handle;
      }) as typeof globalThis.setInterval);
    try {
      const status = createStatusLine({ output: sink.output, enabled: true, theme });
      expect(handle).toBeDefined();
      // unref() flips hasRef() to false — the timer no longer keeps the event loop alive.
      expect(handle?.hasRef()).toBe(false);
      status.dispose(); // clearInterval — leave no live timer behind
    } finally {
      spy.mockRestore();
    }
  });
});

describe("statusLabelFor — pure event→label table (§3.3)", () => {
  const ev = (e: Record<string, unknown>): AgentEvent => e as unknown as AgentEvent;

  it("maps string-label events", () => {
    expect(statusLabelFor(ev({ type: "turn_start", turn: 0 }))).toBe("thinking");
    expect(statusLabelFor(ev({ type: "reasoning_start", id: "r" }))).toBe("thinking");
    expect(statusLabelFor(ev({ type: "text_start", id: "t" }))).toBe("responding");
    expect(statusLabelFor(ev({ type: "tool_input_start", id: "x", toolName: "Bash" }))).toBe(
      "calling Bash",
    );
    expect(
      statusLabelFor(ev({ type: "tool_execution_start", toolCallId: "c", toolName: "Edit", input: {} })),
    ).toBe("running Edit");
    expect(statusLabelFor(ev({ type: "tool_result", outcome: {} }))).toBe("thinking");
    expect(statusLabelFor(ev({ type: "compaction_start", trigger: "auto" }))).toBe(
      "compacting context",
    );
    expect(
      statusLabelFor(ev({ type: "compaction_end", ok: true, preTokens: 0, durationMs: 0 })),
    ).toBe("thinking");
  });

  it("maps clear (null) events", () => {
    expect(statusLabelFor(ev({ type: "error", error: new Error("boom") }))).toBeNull();
    expect(statusLabelFor(ev({ type: "loop_end", reason: "completed", turns: 1 }))).toBeNull();
  });

  it("leaves the current label untouched (undefined) for every other event", () => {
    expect(statusLabelFor(ev({ type: "text_delta", id: "t", text: "hi" }))).toBeUndefined();
    expect(statusLabelFor(ev({ type: "reasoning_delta", id: "r", text: "x" }))).toBeUndefined();
    expect(statusLabelFor(ev({ type: "turn_end", turn: 0, finishReason: "stop" }))).toBeUndefined();
    expect(statusLabelFor(ev({ type: "finish", finishReason: "stop", usage: {} }))).toBeUndefined();
    expect(
      statusLabelFor(ev({ type: "subagent_start", toolCallId: "s", agentType: "explore", description: "d" })),
    ).toBeUndefined();
  });
});

describe("applyStatus — table applied to a StatusLine", () => {
  it("routes string→set, null→clear, undefined→no-op", () => {
    const calls: string[] = [];
    const fake: StatusLine = {
      enabled: true,
      set: (l) => {
        calls.push(`set:${l}`);
      },
      clear: () => {
        calls.push("clear");
      },
      wrapWrite: (w) => w,
      dispose: () => {},
    };
    applyStatus(fake, { type: "turn_start", turn: 0 } as AgentEvent); // -> set thinking
    applyStatus(fake, { type: "text_delta", id: "t", text: "x" } as AgentEvent); // -> no-op
    applyStatus(fake, { type: "loop_end", reason: "completed", turns: 1 } as AgentEvent); // -> clear
    expect(calls).toEqual(["set:thinking", "clear"]);
  });
});

describe("withStatusClear — clears before delegating the ask", () => {
  function fakeStatus(log: string[]): StatusLine {
    return {
      enabled: true,
      set: () => {},
      clear: () => {
        log.push("clear");
      },
      wrapWrite: (w) => w,
      dispose: () => {},
    };
  }

  it("calls status.clear() BEFORE the wrapped prompter.ask (order observable)", async () => {
    const log: string[] = [];
    const prompter: TerminalPrompter = {
      ask: async (q) => {
        log.push(`ask:${q}`);
        return "y";
      },
    };
    const wrapped = withStatusClear(prompter, fakeStatus(log));
    const answer = await wrapped.ask("proceed?");
    expect(answer).toBe("y");
    expect(log).toEqual(["clear", "ask:proceed?"]);
  });

  it("forwards the abort-signal option to the original prompter", async () => {
    const seen: Array<{ signal?: AbortSignal } | undefined> = [];
    const status: StatusLine = {
      enabled: true,
      set: () => {},
      clear: () => {},
      wrapWrite: (w) => w,
      dispose: () => {},
    };
    const prompter: TerminalPrompter = {
      ask: async (_q, opts) => {
        seen.push(opts);
        return "n";
      },
    };
    const controller = new AbortController();
    const wrapped = withStatusClear(prompter, status);
    await wrapped.ask("q", { signal: controller.signal });
    expect(seen[0]?.signal).toBe(controller.signal);
  });
});
