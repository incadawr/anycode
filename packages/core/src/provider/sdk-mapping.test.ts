/**
 * sdk-mapping image tests (Phase 6 slice 6.2, design §2-B1 / L5). The
 * image-free path is locked byte-for-byte against a pre-slice snapshot (double
 * early-return); the image path is asserted at the own->SDK boundary shape
 * (the anthropic HTTP wire shape is proven separately in
 * image-wire.integration.test.ts).
 */

import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../types/history.js";
import type { ImageAttachment } from "../types/images.js";
import { toSdkMessages } from "./sdk-mapping.js";

const IMG: ImageAttachment = { mediaType: "image/png", data: "QUJD" };

/** The exact SDK ModelMessage[] the PRE-SLICE mapping produced for these inputs. */
const IMAGE_FREE_INPUT: ChatMessage[] = [
  { role: "user", content: "hello" },
  {
    role: "assistant",
    content: [
      { type: "text", text: "hi" },
      { type: "tool_call", toolCallId: "call_1", toolName: "Read", input: { file_path: "/a.txt" } },
    ],
  },
  {
    role: "tool",
    content: [{ type: "tool_result", toolCallId: "call_1", toolName: "Read", text: "contents", status: "success" }],
  },
];

const PRE_SLICE_SNAPSHOT = [
  { role: "user", content: "hello" },
  {
    role: "assistant",
    content: [
      { type: "text", text: "hi" },
      { type: "tool-call", toolCallId: "call_1", toolName: "Read", input: { file_path: "/a.txt" } },
    ],
  },
  {
    role: "tool",
    content: [
      { type: "tool-result", toolCallId: "call_1", toolName: "Read", output: { type: "text", value: "contents" } },
    ],
  },
];

describe("toSdkMessages image-free lock (slice 6.2 L5)", () => {
  it("deep-equals the pre-slice snapshot for image-free messages", () => {
    expect(toSdkMessages(IMAGE_FREE_INPUT, "anthropic-messages")).toEqual(PRE_SLICE_SNAPSHOT);
  });

  it("keeps the bare-string user content when images is an empty array", () => {
    const [userMsg] = toSdkMessages([{ role: "user", content: "hi", images: [] }], "anthropic-messages");
    expect(userMsg).toEqual({ role: "user", content: "hi" });
  });
});

describe("toSdkMessages with images (slice 6.2 §2-B1)", () => {
  it("maps a user message to [TextPart, ...FilePart] with the bare-base64 shorthand", () => {
    const [userMsg] = toSdkMessages([{ role: "user", content: "look", images: [IMG] }], "anthropic-messages");
    expect(userMsg).toEqual({
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "file", data: "QUJD", mediaType: "image/png" },
      ],
    });
  });

  it("maps a tool result to a content output with the tagged FileData shape", () => {
    const [toolMsg] = toSdkMessages(
      [
        {
          role: "tool",
          content: [
            { type: "tool_result", toolCallId: "call_9", toolName: "Read", text: "[image attached]", images: [IMG], status: "success" },
          ],
        },
      ],
      "anthropic-messages",
    );
    expect(toolMsg).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_9",
          toolName: "Read",
          output: {
            type: "content",
            value: [
              { type: "text", text: "[image attached]" },
              { type: "file", data: { type: "data", data: "QUJD" }, mediaType: "image/png" },
            ],
          },
        },
      ],
    });
  });

  it("preserves every image in order for a multi-image user message", () => {
    const jpeg: ImageAttachment = { mediaType: "image/jpeg", data: "SkpK" };
    const [userMsg] = toSdkMessages([{ role: "user", content: "two", images: [IMG, jpeg] }], "anthropic-messages");
    expect(userMsg).toEqual({
      role: "user",
      content: [
        { type: "text", text: "two" },
        { type: "file", data: "QUJD", mediaType: "image/png" },
        { type: "file", data: "SkpK", mediaType: "image/jpeg" },
      ],
    });
  });
});
