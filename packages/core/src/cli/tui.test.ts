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

describe("startTui Static transcript (Taskana 4082 rework, defect 1)", () => {
  it("5. print() renders lines that survive composer redraws (Static)", async () => {
    const h = harness();
    h.handle.print("AnyCode CLI — banner line\n");
    h.handle.print("[help] the very last help line\n");
    await h.waitForText("AnyCode CLI — banner line");
    await h.waitForText("[help] the very last help line");

    // Composer activity after the prints must NOT erase them: type and
    // submit, then check the printed lines are still present in the stream.
    h.key("hello\r");
    await h.flush();
    expect(h.submit).toHaveBeenCalledTimes(1);
    h.key("more\r");
    await h.flush();
    expect(h.text()).toContain("AnyCode CLI — banner line");
    expect(h.text()).toContain("[help] the very last help line");
  });

  it("6. multiline rendering: trailing backslash + Enter continues the line", async () => {
    const h = harness();
    h.key("line1\\\r"); // trailing backslash: Enter continues (backslash dropped, newline inserted)
    h.key("line2\r"); // Enter submits "line1\nline2"
    await h.flush();
    expect(h.submit).toHaveBeenCalledTimes(1);
    expect(h.submit).toHaveBeenLastCalledWith("line1\nline2");
  });

  it("7. cursor editing: Backspace deletes at the cursor after ArrowLeft", async () => {
    const h = harness();
    h.key("ab\u001b[D\u007f"); // "ab", ArrowLeft (cursor over 'b'), Backspace deletes 'a' -> "b"
    await h.waitForText("> b");
    h.key("\r");
    await h.flush();
    expect(h.submit).toHaveBeenLastCalledWith("b");
  });
});

describe("startTui confirm mode (Taskana 4082 rework, defect 2)", () => {
  it("8. ask() renders the question; 'n' answers it and never reaches onSubmit", async () => {
    const h = harness();
    const answer = h.handle.ask("stage everything and commit? [y/N]");
    await h.waitForText("stage everything and commit?");

    h.key("n"); // one-key answer
    await expect(answer).resolves.toBe("n");

    // The composer must be back and the answer must never have submitted.
    h.key("hello\r");
    await h.flush();
    expect(h.submit).toHaveBeenCalledTimes(1);
    expect(h.submit).toHaveBeenLastCalledWith("hello");
  });

  it("9. Enter answers with the default; the question echoes into the transcript", async () => {
    const h = harness();
    const answer = h.handle.ask("stage everything and commit? [y/N]");
    await h.waitForText("stage everything and commit?");
    h.key("\r"); // Enter -> default "n"
    await expect(answer).resolves.toBe("n");
    // Answered confirms scroll into the transcript (question + answer).
    await h.waitForText("stage everything and commit? [y/N] n");
  });

  it("10. Esc picks the non-default side; [Y/n] defaults to yes", async () => {
    const h = harness();
    const answer = h.handle.ask("approve plan? [Y/n]");
    await h.waitForText("approve plan?");
    h.key("\u001b"); // Esc: flips the [Y/n] default -> "n"
    await expect(answer).resolves.toBe("n");
  });

  it("11. a confirm answer typed during the question never starts a model turn", async () => {
    const h = harness();
    const answer = h.handle.ask("rewind to checkpoint? [y/N]");
    await h.waitForText("rewind to checkpoint?");
    h.key("y");
    await expect(answer).resolves.toBe("y");
    expect(h.submit).not.toHaveBeenCalled();
    // The composer resumes empty (its pre-question input stayed untouched):
    h.key("\r");
    await h.flush();
    expect(h.submit).not.toHaveBeenCalled(); // empty input never submits
  });

  it("12. ask() rejects with AbortError when the signal aborts", async () => {
    const h = harness();
    const controller = new AbortController();
    const answer = h.handle.ask("question? [y/N]", { signal: controller.signal });
    await h.waitForText("question?");
    controller.abort();
    await expect(answer).rejects.toMatchObject({ name: "AbortError" });
    // The composer is usable again afterwards.
    h.key("hello\r");
    await h.flush();
    expect(h.submit).toHaveBeenLastCalledWith("hello");
  });

  it("13. close() rejects a pending ask and stops all callbacks", async () => {
    const h = harness();
    const answer = h.handle.ask("question? [y/N]");
    await h.waitForText("question?");
    h.handle.close();
    await expect(answer).rejects.toMatchObject({ name: "AbortError" });
    h.key("y\r");
    await h.flush();
    expect(h.submit).not.toHaveBeenCalled();
  });

  it("14. print() after close() is a no-op (writer fell back to raw output)", async () => {
    const h = harness();
    h.handle.close();
    await h.flush(); // let Ink's final unmount frame flush
    const before = h.text();
    h.handle.print("ghost line\n");
    await h.flush();
    expect(h.text()).toBe(before); // no new bytes at all
    expect(h.text()).not.toContain("ghost line");
  });
});
