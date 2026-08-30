/**
 * InspectImage tool tests (TASK.198 slice B2, plan §5). Fake ModelPorts follow
 * vision/recognizer.test.ts's ScriptedModelPort family — ask() calls are
 * exercised through the tool's portFactory test seam, never mocked directly.
 */

import { describe, expect, it } from "vitest";
import {
  createInspectImageTool,
  MAX_QUESTIONS_PER_IMAGE,
  QUESTION_LIMIT_MESSAGE,
} from "./inspect-image.js";
import type { ImageLookupPort, ToolContext } from "../types/tools.js";
import type { ImageAttachment } from "../types/images.js";
import type { ModelPort, ModelRequest } from "../ports/model.js";
import type { ModelStreamEvent } from "../types/events.js";
import type { RecognizerEndpoint } from "../vision/index.js";
import { AskCache } from "../vision/index.js";

class ScriptedModelPort implements ModelPort {
  readonly requests: ModelRequest[] = [];
  constructor(private readonly events: ModelStreamEvent[]) {}
  streamText(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    const { events } = this;
    return (async function* () {
      for (const event of events) yield event;
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
  { type: "error", error: new Error("recognizer exploded") },
];

const endpoint: RecognizerEndpoint = {
  transport: "anthropic-messages",
  baseUrl: "https://example.invalid",
  apiKey: "test-key",
  model: "vision-model",
};

// Real PNG magic bytes + IHDR-shaped payload so imageDimensions() has something
// to parse (not asserted here, but must not throw).
const PNG_BASE64 = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 5, 0, 0, 0, 3, 0x20,
]).toString("base64");

const IMAGE: ImageAttachment = {
  mediaType: "image/png",
  data: PNG_BASE64,
  sourcePath: "screenshot.png",
  ref: 3,
};

function contextWith(opts: {
  images?: ImageLookupPort;
  abortSignal?: AbortSignal;
}): ToolContext {
  return {
    toolCallId: "call-1",
    abortSignal: opts.abortSignal ?? new AbortController().signal,
    cwd: "/work",
    ports: {},
    ...(opts.images !== undefined ? { images: opts.images } : {}),
  } as ToolContext;
}

function registryOf(images: Record<number, ImageAttachment>): ImageLookupPort {
  return { resolve: (ref) => images[ref] };
}

describe("InspectImage — metadata", () => {
  it("PIN: concurrentSafe is false — a billed external endpoint must never be parallelized", () => {
    const tool = createInspectImageTool({ recognizer: { endpoint } });
    expect(tool.metadata.concurrentSafe).toBe(false);
  });

  it("declares itself readOnly, needs no approval, and scopes to network", () => {
    const tool = createInspectImageTool({ recognizer: { endpoint } });
    expect(tool.metadata).toMatchObject({
      name: "InspectImage",
      readOnly: true,
      destructive: false,
      needsApproval: false,
      sideEffectScope: "network",
    });
  });
});

describe("InspectImage — ref resolution", () => {
  it("resolves '#3' and '3' to the same image", async () => {
    const port = new ScriptedModelPort(textScript("answer"));
    const tool = createInspectImageTool({ recognizer: { endpoint, portFactory: () => port } });
    const ctx = contextWith({ images: registryOf({ 3: IMAGE }) });

    const byHash = await tool.handler({ image: "#3", question: "what is this?" }, ctx);
    const byBare = await tool.handler({ image: "3", question: "what else?" }, ctx);

    expect(byHash.ok).toBe(true);
    expect(byBare.ok).toBe(true);
    expect(port.requests).toHaveLength(2);
  });

  it("errors for a nonexistent ref without calling ask", async () => {
    const port = new ScriptedModelPort(textScript("unused"));
    const tool = createInspectImageTool({ recognizer: { endpoint, portFactory: () => port } });
    const ctx = contextWith({ images: registryOf({}) });

    const result = await tool.handler({ image: "#99", question: "?" }, ctx);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("no longer available");
    expect(port.requests).toHaveLength(0);
  });

  it("errors for a legacy image (no ref ever assigned, so resolve() always misses) without calling ask", async () => {
    const port = new ScriptedModelPort(textScript("unused"));
    const tool = createInspectImageTool({ recognizer: { endpoint, portFactory: () => port } });
    // A legacy pre-feature image was never keyed by any ref number — the lookup
    // port has nothing to return for ANY ref a model might try.
    const ctx = contextWith({ images: registryOf({}) });

    const result = await tool.handler({ image: "#1", question: "?" }, ctx);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("no longer available");
    expect(port.requests).toHaveLength(0);
  });

  it("fails closed with an 'unavailable' error when ToolContext carries no images port at all", async () => {
    const tool = createInspectImageTool({ recognizer: { endpoint } });
    const result = await tool.handler({ image: "#1", question: "?" }, contextWith({}));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("unavailable");
  });

  it("rejects a malformed reference without calling ask", async () => {
    const port = new ScriptedModelPort(textScript("unused"));
    const tool = createInspectImageTool({ recognizer: { endpoint, portFactory: () => port } });
    const ctx = contextWith({ images: registryOf({ 3: IMAGE }) });

    const result = await tool.handler({ image: "not-a-ref", question: "?" }, ctx);

    expect(result.ok).toBe(false);
    expect(port.requests).toHaveLength(0);
  });
});

describe("InspectImage — per-image question limit", () => {
  it(`allows exactly ${MAX_QUESTIONS_PER_IMAGE} questions then refuses with the exact limit message`, async () => {
    const port = new ScriptedModelPort(textScript("answer"));
    const tool = createInspectImageTool({ recognizer: { endpoint, portFactory: () => port } });
    const ctx = contextWith({ images: registryOf({ 3: IMAGE }) });

    for (let i = 0; i < MAX_QUESTIONS_PER_IMAGE; i += 1) {
      const result = await tool.handler({ image: "#3", question: `question ${i}` }, ctx);
      expect(result.ok).toBe(true);
    }
    const overLimit = await tool.handler({ image: "#3", question: "one too many" }, ctx);
    expect(overLimit.ok).toBe(false);
    expect(overLimit.error).toBe(QUESTION_LIMIT_MESSAGE);
    expect(port.requests).toHaveLength(MAX_QUESTIONS_PER_IMAGE);
  });

  it("tracks the limit per ref — exhausting one image does not block another", async () => {
    const port = new ScriptedModelPort(textScript("answer"));
    const tool = createInspectImageTool({ recognizer: { endpoint, portFactory: () => port } });
    const other: ImageAttachment = { ...IMAGE, ref: 4 };
    const ctx = contextWith({ images: registryOf({ 3: IMAGE, 4: other }) });

    for (let i = 0; i < MAX_QUESTIONS_PER_IMAGE; i += 1) {
      await tool.handler({ image: "#3", question: `q${i}` }, ctx);
    }
    const resultForOtherImage = await tool.handler({ image: "#4", question: "still fine?" }, ctx);
    expect(resultForOtherImage.ok).toBe(true);
  });
});

describe("InspectImage — transcript", () => {
  it("threads prior Q/A pairs about the SAME image into later ask() calls", async () => {
    // The fake port replays the SAME script on every call — the first
    // question's "answer" is what the transcript carries into the second
    // call's prompt.
    const port = new ScriptedModelPort(textScript("first answer"));
    const tool = createInspectImageTool({ recognizer: { endpoint, portFactory: () => port } });
    const ctx = contextWith({ images: registryOf({ 3: IMAGE }) });

    await tool.handler({ image: "#3", question: "first question" }, ctx);
    const secondResult = await tool.handler({ image: "#3", question: "second question" }, ctx);
    expect(secondResult.ok).toBe(true);

    expect(port.requests).toHaveLength(2);
    const secondRequest = port.requests[1]!;
    const message = secondRequest.messages[0]!;
    if (message.role !== "user") throw new Error("expected a user message");
    expect(message.content).toContain("first question");
    expect(message.content).toContain("first answer");
    expect(message.content).toContain("second question");
  });
});

describe("InspectImage — cache", () => {
  it("a cache hit answers without calling ask again", async () => {
    const cache = new AskCache();
    const port = new ScriptedModelPort(textScript("cached answer"));
    const tool = createInspectImageTool({ recognizer: { endpoint, cache, portFactory: () => port } });
    const ctx = contextWith({ images: registryOf({ 3: IMAGE }) });

    const first = await tool.handler({ image: "#3", question: "same question" }, ctx);
    expect(first.ok).toBe(true);
    expect(port.requests).toHaveLength(1);

    // Fresh tool instance sharing the SAME cache: no transcript yet accrued in
    // its own closure, so the cache key matches exactly and this is a hit.
    const port2 = new ScriptedModelPort(textScript("should never be seen"));
    const tool2 = createInspectImageTool({ recognizer: { endpoint, cache, portFactory: () => port2 } });
    const second = await tool2.handler({ image: "#3", question: "same question" }, ctx);

    expect(second.ok).toBe(true);
    if (second.ok) expect(second.output).toBe("cached answer");
    expect(port2.requests).toHaveLength(0);
  });
});

describe("InspectImage — ask() failure", () => {
  it("turns a provider error into a model-visible text error, not a thrown exception", async () => {
    const port = new ScriptedModelPort(errorScript());
    const tool = createInspectImageTool({ recognizer: { endpoint, portFactory: () => port } });
    const ctx = contextWith({ images: registryOf({ 3: IMAGE }) });

    const result = await tool.handler({ image: "#3", question: "?" }, ctx);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("recognizer exploded");
  });

  // A failure is a fact about one ATTEMPT, not about the question. Caching it
  // makes an aborted turn or a momentary provider blip permanent for the life
  // of the session: the exact same wording never reaches the network again, so
  // the recognizer coming back does not bring the question back with it.
  it("does NOT cache a failure — the same question retries against the network instead of replaying the error", async () => {
    const cache = new AskCache();
    const failing = new ScriptedModelPort(errorScript());
    const tool = createInspectImageTool({ recognizer: { endpoint, cache, portFactory: () => failing } });
    const ctx = contextWith({ images: registryOf({ 3: IMAGE }) });

    const first = await tool.handler({ image: "#3", question: "same question" }, ctx);
    expect(first.ok).toBe(false);
    expect(failing.requests).toHaveLength(1);

    // Same cache, same wording, recognizer now healthy: this must be a real
    // call, not a replay of the cached error.
    const healthy = new ScriptedModelPort(textScript("it is a red square"));
    const retryTool = createInspectImageTool({ recognizer: { endpoint, cache, portFactory: () => healthy } });
    const second = await retryTool.handler({ image: "#3", question: "same question" }, ctx);

    expect(healthy.requests).toHaveLength(1);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.output).toBe("it is a red square");
  });
});

describe("InspectImage — TASK.198 slice G (CSS viewport scale hint)", () => {
  it("forwards the attachment's cssSize into ask()'s scale as a Viewport CSS size prompt line", async () => {
    const port = new ScriptedModelPort(textScript("answer"));
    const tool = createInspectImageTool({ recognizer: { endpoint, portFactory: () => port } });
    const imageWithCss: ImageAttachment = { ...IMAGE, cssSize: { width: 550, height: 400 } };
    const ctx = contextWith({ images: registryOf({ 3: imageWithCss }) });

    const result = await tool.handler({ image: "#3", question: "?" }, ctx);

    expect(result.ok).toBe(true);
    expect(port.requests).toHaveLength(1);
    const prompt = port.requests[0]!.messages[0]!.content as string;
    expect(prompt).toContain("Image pixel size: 1280x800px.");
    expect(prompt).toContain("Viewport CSS size: 550x400px");
  });

  it("additivity pin: an attachment with no cssSize omits the Viewport CSS size line entirely (byte-identical to pre-slice prompt)", async () => {
    const port = new ScriptedModelPort(textScript("answer"));
    const tool = createInspectImageTool({ recognizer: { endpoint, portFactory: () => port } });
    // IMAGE itself carries no cssSize (a plain pre-slice-G attachment).
    const ctx = contextWith({ images: registryOf({ 3: IMAGE }) });

    const result = await tool.handler({ image: "#3", question: "?" }, ctx);

    expect(result.ok).toBe(true);
    const prompt = port.requests[0]!.messages[0]!.content as string;
    expect(prompt).toContain("Image pixel size: 1280x800px.");
    expect(prompt).not.toContain("Viewport CSS size");
  });
});
