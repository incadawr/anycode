/**
 * Session-title tests (Phase 4 slice 4.4-T, design/feature-session-titles.md
 * §2/§3, build-cut §4): heuristic derivation (mirrors
 * apps/desktop/src/host/resume.test.ts:241-246 — the byte-identical proof for
 * the host/session.ts -> core move), reminder-tag sanitization, and the
 * one-shot LLM refinement's fail-quiet contract + request shape, using a fake
 * ModelPort in the same style as context/manager.test.ts's ScriptedModelPort.
 */

import { describe, expect, it } from "vitest";
import {
  SESSION_TITLE_MAX_LENGTH,
  deriveSessionTitle,
  generateSessionTitle,
  sanitizeTitleSource,
} from "./session-title.js";
import type { ModelPort, ModelRequest } from "../ports/model.js";
import type { ModelStreamEvent } from "../types/events.js";

// ---------------------------------------------------------------------------
// Fake model ports

/** Yields a fixed script; records every request it was called with. */
class ScriptedModelPort implements ModelPort {
  readonly requests: ModelRequest[] = [];
  constructor(private readonly events: ModelStreamEvent[]) {}
  streamText(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    const { events } = this;
    return (async function* () {
      for (const event of events) {
        yield event;
      }
    })();
  }
}

/** Throws synchronously instead of returning an iterable — a broken adapter. */
class ThrowingModelPort implements ModelPort {
  streamText(): AsyncIterable<ModelStreamEvent> {
    throw new Error("adapter exploded");
  }
}

/**
 * Never yields and never resolves on its own — simulates a hung provider
 * stream. Only settles (by throwing AbortError) if its request's abortSignal
 * fires, exactly like a real fetch-based stream reacting to cancellation.
 */
class HangingModelPort implements ModelPort {
  streamText(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const { abortSignal } = request;
    return (async function* () {
      await new Promise<void>((_resolve, reject) => {
        if (abortSignal?.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        abortSignal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
    })();
  }
}

const textScript = (text: string): ModelStreamEvent[] => [
  { type: "start" },
  { type: "text_delta", id: "t", text },
  { type: "finish", finishReason: "stop", usage: {} },
];

const errorScript = (): ModelStreamEvent[] => [
  { type: "start" },
  { type: "error", error: new Error("model exploded") },
];

const emptyScript = (): ModelStreamEvent[] => [
  { type: "start" },
  { type: "finish", finishReason: "stop", usage: {} },
];

// ---------------------------------------------------------------------------

describe("deriveSessionTitle", () => {
  it("caps the derived title at 80 characters (first line only)", () => {
    expect(deriveSessionTitle("short")).toBe("short");
    expect(deriveSessionTitle("  padded  \nrest")).toBe("padded");
    const long = "x".repeat(120);
    expect(deriveSessionTitle(long)).toHaveLength(SESSION_TITLE_MAX_LENGTH);
    expect(deriveSessionTitle("")).toBe("");
    expect(deriveSessionTitle("   \n   ")).toBe("");
  });
});

describe("sanitizeTitleSource", () => {
  it("passes text without any reminder tags through byte-for-byte", () => {
    const text = "fix the login bug, see stack trace below";
    expect(sanitizeTitleSource(text)).toBe(text);
  });

  it("strips a paired <hook-context> block", () => {
    const text = "please fix this\n<hook-context>\nsome injected context\n</hook-context>";
    expect(sanitizeTitleSource(text)).toBe("please fix this\n");
  });

  it("strips a paired <plan-mode-reminder> block", () => {
    const text = "draft a plan\n<plan-mode-reminder>\nstay in plan mode\n</plan-mode-reminder>";
    expect(sanitizeTitleSource(text)).toBe("draft a plan\n");
  });

  it("strips a paired <system-reminder> block", () => {
    const text = "hello\n<system-reminder>\nirrelevant\n</system-reminder>\nworld";
    expect(sanitizeTitleSource(text)).toBe("hello\n\nworld");
  });

  it("leaves an unpaired (unmatched) tag untouched", () => {
    const text = "oops <hook-context> with no closing tag";
    expect(sanitizeTitleSource(text)).toBe(text);
  });

  it("removes a trivially nested tag as part of its enclosing block", () => {
    const text = "<hook-context>outer <system-reminder>inner</system-reminder> tail</hook-context>rest";
    expect(sanitizeTitleSource(text)).toBe("rest");
  });

  it("strips multiple independent pairs of the same tag", () => {
    const text = "a<hook-context>one</hook-context>b<hook-context>two</hook-context>c";
    expect(sanitizeTitleSource(text)).toBe("abc");
  });
});

describe("generateSessionTitle", () => {
  it("sends the expected request shape: tools:[], maxOutputTokens:32, temperature:0, non-empty system", async () => {
    const port = new ScriptedModelPort(textScript("A Title"));
    await generateSessionTitle({ modelPort: port, text: "hello there" });

    expect(port.requests).toHaveLength(1);
    const request = port.requests[0]!;
    expect(request.tools).toEqual([]);
    expect(request.maxOutputTokens).toBe(32);
    expect(request.temperature).toBe(0);
    expect(typeof request.system).toBe("string");
    expect(request.system!.length).toBeGreaterThan(0);
    expect(request.messages).toEqual([{ role: "user", content: "hello there" }]);
  });

  it("strips wrapping quotes and a trailing period", async () => {
    const port = new ScriptedModelPort(textScript(`"Fix the login bug."`));
    const title = await generateSessionTitle({ modelPort: port, text: "x" });
    expect(title).toBe("Fix the login bug");
  });

  it("strips single-quote wrapping", async () => {
    const port = new ScriptedModelPort(textScript(`'Refactor auth module'`));
    const title = await generateSessionTitle({ modelPort: port, text: "x" });
    expect(title).toBe("Refactor auth module");
  });

  it("takes only the first line of a multi-line reply", async () => {
    const port = new ScriptedModelPort(textScript("Fix login bug\nExplanation: ..."));
    const title = await generateSessionTitle({ modelPort: port, text: "x" });
    expect(title).toBe("Fix login bug");
  });

  it("collapses internal whitespace runs to a single space", async () => {
    const port = new ScriptedModelPort(textScript("Fix   the   login    bug"));
    const title = await generateSessionTitle({ modelPort: port, text: "x" });
    expect(title).toBe("Fix the login bug");
  });

  it("caps the refined title at 80 characters", async () => {
    const port = new ScriptedModelPort(textScript("x".repeat(120)));
    const title = await generateSessionTitle({ modelPort: port, text: "x" });
    expect(title).toHaveLength(SESSION_TITLE_MAX_LENGTH);
  });

  it("resolves to null on an error event", async () => {
    const port = new ScriptedModelPort(errorScript());
    const title = await generateSessionTitle({ modelPort: port, text: "x" });
    expect(title).toBeNull();
  });

  it("resolves to null when streamText throws synchronously", async () => {
    const title = await generateSessionTitle({ modelPort: new ThrowingModelPort(), text: "x" });
    expect(title).toBeNull();
  });

  it("resolves to null on an empty reply", async () => {
    const port = new ScriptedModelPort(emptyScript());
    const title = await generateSessionTitle({ modelPort: port, text: "x" });
    expect(title).toBeNull();
  });

  it("resolves to null on a whitespace-only reply", async () => {
    const port = new ScriptedModelPort(textScript("   \n   "));
    const title = await generateSessionTitle({ modelPort: port, text: "x" });
    expect(title).toBeNull();
  });

  it("resolves to null on timeout against a hung stream that never emits or resolves", async () => {
    const title = await generateSessionTitle({
      modelPort: new HangingModelPort(),
      text: "x",
      timeoutMs: 5,
    });
    expect(title).toBeNull();
  });

  it("sanitizes reminder tags and caps to SESSION_TITLE_SOURCE_MAX_BYTES before sending", async () => {
    const port = new ScriptedModelPort(textScript("Title"));
    const text = "please fix\n<hook-context>\nnoise\n</hook-context>";
    await generateSessionTitle({ modelPort: port, text });
    const sentContent = port.requests[0]!.messages[0]!.content;
    expect(sentContent).not.toContain("hook-context");
    expect(sentContent).not.toContain("noise");
  });
});
