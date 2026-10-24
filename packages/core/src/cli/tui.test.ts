/**
 * Ink smoke tests for the TUI shell (Taskana 4082 slice 1, §3.4).
 *
 * Drives startTui with PassThrough stdin/stdout and injects ANSI tokens
 * ("\r" Enter, "\t" Tab, "\u001b[A" ArrowUp, printable chars) through the
 * handle's emit() — the same parseKeypress -> useInput pipeline real
 * keypresses take. No real TTY, no fake timers: each token is emitted, then
 * the test awaits a couple of setImmediate ticks for React to commit and Ink
 * to flush the frame into the output stream.
 */

import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startTui, type TuiHandle } from "./tui.js";

interface Harness {
  input: PassThrough;
  output: PassThrough;
  handle: TuiHandle;
  submit: ReturnType<typeof vi.fn>;
  interrupt: ReturnType<typeof vi.fn>;
  /** Emits one input token (data) on the given channel (conventionally "input"). */
  key: (data: string) => void;
  /** Output written so far, with ANSI escapes stripped. */
  text: () => string;
  /** Lets React commit + Ink flush the pending frame into the output stream. */
  flush: () => Promise<void>;
  /** Polls (vi.waitFor) until the stripped output contains `expected`. */
  waitForText: (expected: string) => Promise<void>;
}

function openHarness(): Harness {
  const input = new PassThrough();
  const output = new PassThrough();
  const submit = vi.fn();
  const interrupt = vi.fn();
  const handle = startTui({ input, output, onSubmit: submit, onInterrupt: interrupt });
  const chunks: Buffer[] = [];
  output.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
  });
  const text = (): string => {
    const raw = Buffer.concat(chunks).toString("utf8");
    return raw
      .replace(/\u001b\][^\u0007]*(\u0007|\u001b\\)/g, "")
      .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
      .replace(/\u001b/g, "");
  };
  const h: Harness = {
    input,
    output,
    handle,
    submit,
    interrupt,
    key: (data: string) => {
      handle.emit("input", data);
    },
    text,
    flush: async () => {
      // Yield a macrotask so Ink's ~30fps frame throttle can commit pending
      // frames; assertions that need the pixels use waitForText below.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setImmediate(resolve));
    },
    waitForText: async (expected: string): Promise<void> => {
      // Ink's frame throttle fires on a 33ms timer; a single fixed sleep
      // misses it under parallel-suite CPU contention, so poll instead.
      await vi.waitFor(
        () => {
          if (!text().includes(expected)) {
            throw new Error(`output does not contain ${JSON.stringify(expected)} yet`);
          }
        },
        { timeout: 2000, interval: 25 },
      );
    },
  };
  return h;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

function harness(): Harness {
  const h = openHarness();
  cleanups.push(h.handle.close);
  return h;
}

describe("startTui ink smoke (Taskana 4082)", () => {
  it("1. '/c' renders the popup, Tab commits '/compact ' and Enter submits it", async () => {
    const h = harness();
    h.key("/c");
    await h.waitForText("/compact");
    await h.waitForText("/context");
    expect(h.submit).not.toHaveBeenCalled();

    h.key("\t"); // Tab: commit selection (/compact) -> "/compact "
    await h.waitForText("/compact ");
    expect(h.submit).not.toHaveBeenCalled();

    h.key("\r"); // Enter: popup closed after commit -> submit
    await h.flush();
    expect(h.submit).toHaveBeenCalledTimes(1);
    expect(h.submit).toHaveBeenLastCalledWith("/compact");
  });

  it("2. plain 'hello' submits without a popup; ArrowUp recalls it from history", async () => {
    const h = harness();
    h.key("hello\r");
    await h.flush();
    expect(h.submit).toHaveBeenCalledTimes(1);
    expect(h.submit).toHaveBeenLastCalledWith("hello");

    h.key("hello\r"); // again -> consecutive duplicate deduped in history
    await h.flush();
    expect(h.submit).toHaveBeenCalledTimes(2);

    h.key("\u001b[A"); // ArrowUp (popup closed): history-prev
    await h.waitForText("hello");
    expect(h.submit).toHaveBeenCalledTimes(2); // navigation never submits
  });

  it("2b. Enter with a popup showing a single match submits the typed line", async () => {
    const h = harness();
    h.key("/con"); // matches only /context -> 1 visible item
    await h.waitForText("/context");

    h.key("\r"); // single-match popup: Enter submits, not commits
    await h.flush();
    expect(h.submit).toHaveBeenCalledTimes(1);
    expect(h.submit).toHaveBeenLastCalledWith("/con");
  });

  it("3. close() stops submissions: later keys never reach onSubmit", async () => {
    const h = harness();
    h.key("hello\r");
    await h.flush();
    expect(h.submit).toHaveBeenCalledTimes(1);

    h.handle.close();
    h.key("world\r");
    await h.flush();
    for (let i = 0; i < 4; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(h.submit).toHaveBeenCalledTimes(1);

    // The output stream stays live and unclosed; emit after close is a no-op.
    expect(h.output.destroyed).toBe(false);
  });

  it("4. Ctrl+C is forwarded to onInterrupt instead of submitting", async () => {
    const h = harness();
    h.key("hello");
    await h.flush();
    h.key(""); // Ctrl+C
    await h.flush();
    expect(h.interrupt).toHaveBeenCalledTimes(1);
    expect(h.submit).not.toHaveBeenCalled();
  });
});
