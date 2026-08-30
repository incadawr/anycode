/**
 * projectMessagesForMedia + createMediaProjectionPort (TASK.198 plan §3):
 * strips image bytes from every ChatMessage before they reach a blind
 * model's wire, so a live model switch (sighted -> blind) can never
 * silently re-send images the new model would 400 on.
 */

import { describe, expect, it } from "vitest";
import { createMediaProjectionPort, projectMessagesForMedia } from "./media-projection.js";
import type { ModelPort, ModelRequest } from "../ports/model.js";
import type { ModelStreamEvent } from "../types/events.js";
import type { ChatMessage } from "../types/history.js";
import type { ImageAttachment } from "../types/images.js";

const img: ImageAttachment = { mediaType: "image/png", data: "AAAA", sourcePath: "/x.png", ref: 3 };
const legacyImg: ImageAttachment = { mediaType: "image/png", data: "BBBB" };

describe("projectMessagesForMedia", () => {
  it("returns the SAME array reference when image input is allowed (identity pin)", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "hi", images: [img] }];
    expect(projectMessagesForMedia(messages, true)).toBe(messages);
  });

  it("returns the SAME array reference when nothing in the batch carries an image, even when blind", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "hey" }] },
    ];
    expect(projectMessagesForMedia(messages, false)).toBe(messages);
  });

  it("strips images from a user message and appends a numbered wire-only note when blind", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "look", images: [img] }];
    const [projected] = projectMessagesForMedia(messages, false);
    expect(projected).toMatchObject({ role: "user" });
    expect("images" in (projected as Record<string, unknown>)).toBe(false);
    expect((projected as { content: string }).content).toBe(
      "look\n[image #3 omitted: current model has no image input]",
    );
  });

  it("omits the ref from the note for a legacy image with no ref", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "look", images: [legacyImg] }];
    const [projected] = projectMessagesForMedia(messages, false);
    expect((projected as { content: string }).content).toBe(
      "look\n[image omitted: current model has no image input]",
    );
  });

  it("strips images from a tool-result part and appends the note to its text", () => {
    const messages: ChatMessage[] = [
      {
        role: "tool",
        content: [
          { type: "tool_result", toolCallId: "c1", toolName: "Read", text: "ok", status: "success", images: [img] },
        ],
      },
    ];
    const [projected] = projectMessagesForMedia(messages, false);
    if (projected?.role !== "tool") throw new Error("expected a tool message");
    const part = projected.content[0]!;
    expect("images" in part).toBe(false);
    expect(part.text).toBe("ok\n[image #3 omitted: current model has no image input]");
  });

  it("leaves assistant messages and image-free user/tool messages untouched", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "plain" },
      { role: "assistant", content: [{ type: "text", text: "plain reply" }] },
      {
        role: "tool",
        content: [{ type: "tool_result", toolCallId: "c1", toolName: "Read", text: "ok", status: "success" }],
      },
    ];
    const projected = projectMessagesForMedia(messages, false);
    expect(projected).toEqual(messages);
  });
});

class RecordingModelPort implements ModelPort {
  readonly requests: ModelRequest[] = [];
  constructor(
    readonly modelId?: string,
    readonly lastResponseModel?: string,
  ) {}
  streamText(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    return (async function* () {})();
  }
}

async function drain(iter: AsyncIterable<ModelStreamEvent>): Promise<void> {
  for await (const _ of iter) {
    // drain only
  }
}

describe("createMediaProjectionPort", () => {
  it("projects request.messages through the live imageInputAllowed() verdict on every call", async () => {
    let allowed = false;
    const inner = new RecordingModelPort();
    const port = createMediaProjectionPort(inner, () => allowed);

    await drain(port.streamText({ messages: [{ role: "user", content: "a", images: [img] }], tools: [] }));
    expect(inner.requests[0]?.messages[0]).not.toHaveProperty("images");

    allowed = true;
    await drain(port.streamText({ messages: [{ role: "user", content: "b", images: [img] }], tools: [] }));
    expect(inner.requests[1]?.messages[0]).toMatchObject({ images: [img] });
  });

  it("delegates modelId and lastResponseModel straight through to the wrapped port", () => {
    const inner = new RecordingModelPort("m-1", "m-1-raw");
    const port = createMediaProjectionPort(inner, () => true);
    expect(port.modelId).toBe("m-1");
    expect(port.lastResponseModel).toBe("m-1-raw");
  });

  it("passes the request through unchanged (same object) when sighted, avoiding a needless allocation", async () => {
    const inner = new RecordingModelPort();
    const port = createMediaProjectionPort(inner, () => true);
    const request: ModelRequest = { messages: [{ role: "user", content: "a", images: [img] }], tools: [] };
    await drain(port.streamText(request));
    expect(inner.requests[0]).toBe(request);
  });
});
