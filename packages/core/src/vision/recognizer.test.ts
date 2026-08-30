/**
 * `ask()` primitive tests (TASK.198 slice A, plan §1/§10-A). Fake ModelPorts in
 * the same style as context/session-title.test.ts's ScriptedModelPort family:
 * ask() is a one-shot streamText call, so the same fakes (scripted/throwing/
 * hanging) exercise the same fail-quiet contract — except here failure surfaces
 * as `{ok:false, kind, error}` rather than `null`, because a tool result must
 * say WHY the recognizer didn't answer. Never-throws is load-bearing (the
 * fallback feature must never kill a turn), so every failure path below
 * asserts a resolved result, never a rejection.
 */

import { describe, expect, it } from "vitest";
import { ask, ASK_TIMEOUT_MS, OVERVIEW_QUESTION } from "./recognizer.js";
import type { AskOptions, RecognizerEndpoint } from "./recognizer.js";
import type { ModelPort, ModelRequest } from "../ports/model.js";
import type { ModelStreamEvent } from "../types/events.js";
import type { ImageAttachment } from "../types/images.js";

// ---------------------------------------------------------------------------
// Fake model ports (mirrors context/session-title.test.ts's fakes).

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

class ThrowingModelPort implements ModelPort {
  streamText(): AsyncIterable<ModelStreamEvent> {
    throw new Error("adapter exploded");
  }
}

/** Never yields/resolves on its own; only settles when its abortSignal fires. */
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
  { type: "finish", finishReason: "stop", usage: { inputTokens: 120, outputTokens: 12 } },
];

const chunkedTextScript = (chunks: string[]): ModelStreamEvent[] => [
  { type: "start" },
  ...chunks.map((text) => ({ type: "text_delta" as const, id: "t", text })),
  { type: "finish", finishReason: "stop", usage: {} },
];

const errorScript = (): ModelStreamEvent[] => [
  { type: "start" },
  { type: "error", error: new Error("provider blew up") },
];

const emptyScript = (): ModelStreamEvent[] => [
  { type: "start" },
  { type: "finish", finishReason: "stop", usage: {} },
];

const endpoint: RecognizerEndpoint = {
  transport: "anthropic-messages",
  baseUrl: "https://example.invalid",
  apiKey: "test-key",
  model: "vision-model",
};

const image: ImageAttachment = {
  mediaType: "image/png",
  data: "ZmFrZS1pbWFnZS1ieXRlcw==",
  sourcePath: "screenshot.png",
};

function baseOpts(overrides: Partial<AskOptions> = {}): AskOptions {
  return {
    endpoint,
    image,
    question: "What is in this image?",
    ...overrides,
  };
}

describe("ask", () => {
  it("accumulates text_delta chunks into the final answer", async () => {
    const port = new ScriptedModelPort(chunkedTextScript(["The image ", "shows a ", "button."]));
    const result = await ask(baseOpts({ portFactory: () => port }));
    expect(result).toEqual({ ok: true, text: "The image shows a button.", usage: {} });
  });

  it("sends exactly one user message carrying the image and the built prompt", async () => {
    const port = new ScriptedModelPort(textScript("ok"));
    await ask(baseOpts({ portFactory: () => port }));
    expect(port.requests).toHaveLength(1);
    const request = port.requests[0]!;
    expect(request.tools).toEqual([]);
    expect(request.temperature).toBe(0);
    expect(request.messages).toHaveLength(1);
    const message = request.messages[0]!;
    if (message.role !== "user") throw new Error("expected a user message");
    expect(message.images).toEqual([image]);
  });

  it("surfaces usage from the finish event on success", async () => {
    const port = new ScriptedModelPort(textScript("An answer"));
    const result = await ask(baseOpts({ portFactory: () => port }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 12 });
    }
  });

  it("includes the pixel dimensions in the prompt when scale is provided", async () => {
    const port = new ScriptedModelPort(textScript("ok"));
    await ask(
      baseOpts({
        portFactory: () => port,
        scale: { pixelWidth: 1280, pixelHeight: 800 },
      }),
    );
    const content = port.requests[0]!.messages[0]!.content as string;
    expect(content).toContain("1280");
    expect(content).toContain("800");
  });

  // The CSS half of the hint exists ONLY to be divided into the pixel half. A
  // zero or non-finite dimension therefore cannot be passed along as a smaller
  // number — it would instruct the model to divide by it. The pixel line still
  // goes out: it is independently true and useful on its own.
  it("omits the CSS viewport line — but keeps the pixel line — when a CSS dimension is zero or non-finite", async () => {
    for (const bad of [
      { cssWidth: 0, cssHeight: 717 },
      { cssWidth: 639, cssHeight: 0 },
      { cssWidth: Number.NaN, cssHeight: 717 },
      { cssWidth: 639, cssHeight: Number.POSITIVE_INFINITY },
      { cssWidth: -639, cssHeight: 717 },
    ]) {
      const port = new ScriptedModelPort(textScript("ok"));
      await ask(
        baseOpts({
          portFactory: () => port,
          scale: { pixelWidth: 1278, pixelHeight: 1434, ...bad },
        }),
      );
      const content = port.requests[0]!.messages[0]!.content as string;
      expect(content).toContain("1278x1434px");
      expect(content).not.toContain("Viewport CSS size");
    }
  });

  it("emits the CSS viewport line when both dimensions are usable", async () => {
    const port = new ScriptedModelPort(textScript("ok"));
    await ask(
      baseOpts({
        portFactory: () => port,
        scale: { pixelWidth: 1278, pixelHeight: 1434, cssWidth: 639, cssHeight: 717 },
      }),
    );
    const content = port.requests[0]!.messages[0]!.content as string;
    expect(content).toContain("Viewport CSS size: 639x717px");
  });

  it("includes prior question/answer pairs (threaded-by-value transcript) in the prompt", async () => {
    const port = new ScriptedModelPort(textScript("ok"));
    await ask(
      baseOpts({
        portFactory: () => port,
        transcript: [{ question: "what color is the button?", answer: "blue" }],
      }),
    );
    const content = port.requests[0]!.messages[0]!.content as string;
    expect(content).toContain("what color is the button?");
    expect(content).toContain("blue");
  });

  it("resolves ok:false kind:empty when the model returns no text", async () => {
    const port = new ScriptedModelPort(emptyScript());
    const result = await ask(baseOpts({ portFactory: () => port }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("empty");
    }
  });

  it("resolves ok:false kind:empty on a whitespace-only reply", async () => {
    const port = new ScriptedModelPort(textScript("   \n  "));
    const result = await ask(baseOpts({ portFactory: () => port }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("empty");
  });

  it("resolves ok:false kind:provider on a stream error event, never throws", async () => {
    const port = new ScriptedModelPort(errorScript());
    const result = await ask(baseOpts({ portFactory: () => port }));
    expect(result).toEqual({ ok: false, kind: "provider", error: "provider blew up" });
  });

  it("resolves ok:false kind:provider when the port throws synchronously, never throws", async () => {
    await expect(ask(baseOpts({ portFactory: () => new ThrowingModelPort() }))).resolves.toMatchObject({
      ok: false,
      kind: "provider",
    });
  });

  it("resolves ok:false kind:timeout against a hung stream past its deadline", async () => {
    const result = await ask(
      baseOpts({
        portFactory: () => new HangingModelPort(),
        signal: AbortSignal.timeout(5),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("timeout");
    }
  });

  it("resolves ok:false kind:aborted when the caller cancels for a reason other than a timeout", async () => {
    const controller = new AbortController();
    const pending = ask(
      baseOpts({ portFactory: () => new HangingModelPort(), signal: controller.signal }),
    );
    controller.abort("user cancelled");
    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("aborted");
    }
  });

  it("never rejects even when everything goes wrong at once", async () => {
    await expect(
      ask(baseOpts({ portFactory: () => new ThrowingModelPort() })),
    ).resolves.toBeDefined();
  });

  it("defaults to a 60s deadline when the caller supplies no signal", () => {
    expect(ASK_TIMEOUT_MS).toBe(60_000);
  });

  it("exposes a non-empty OVERVIEW_QUESTION constant for the bootstrap caption call", () => {
    expect(typeof OVERVIEW_QUESTION).toBe("string");
    expect(OVERVIEW_QUESTION.length).toBeGreaterThan(0);
  });
});
