/**
 * sdk-mapping image tests (Phase 6 slice 6.2, design §2-B1 / L5). The
 * image-free path is locked byte-for-byte against a pre-slice snapshot (double
 * early-return); the image path is asserted at the own->SDK boundary shape
 * (the anthropic HTTP wire shape is proven separately in
 * image-wire.integration.test.ts).
 */

import { describe, expect, it } from "vitest";
import type { AssistantPart, AssistantReasoningPart, ChatMessage, ReasoningSource } from "../types/history.js";
import type { ImageAttachment } from "../types/images.js";
import { OPENAI_TOOL_RESULT_IMAGE_OMITTED_NOTE, sameReasoningSource, toSdkMessages } from "./sdk-mapping.js";

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

describe("toSdkMessages tool-result image strip on the openai-chat-completions transport (§5.1)", () => {
  const toolResultWithImage: ChatMessage = {
    role: "tool",
    content: [
      { type: "tool_result", toolCallId: "call_9", toolName: "Read", text: "[image attached]", images: [IMG], status: "success" },
    ],
  };

  it("drops the FilePart and appends the omitted-image note as plain text, never a `content` array", () => {
    const [toolMsg] = toSdkMessages([toolResultWithImage], "openai-chat-completions");
    expect(toolMsg).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_9",
          toolName: "Read",
          output: { type: "text", value: `[image attached]\n${OPENAI_TOOL_RESULT_IMAGE_OMITTED_NOTE}` },
        },
      ],
    });
    // No base64 payload and no `content`-typed OUTPUT (the anthropic image-carrying
    // variant) anywhere for this message; the outer `content` array key is fine.
    expect(JSON.stringify(toolMsg)).not.toContain("QUJD");
    expect(JSON.stringify(toolMsg)).not.toContain('"type":"content"');
  });

  it("keeps the image-free tool-result path byte-identical on the openai-chat-completions transport", () => {
    const imageFree: ChatMessage = {
      role: "tool",
      content: [{ type: "tool_result", toolCallId: "call_1", toolName: "Read", text: "contents", status: "success" }],
    };
    const [anthropicShape] = toSdkMessages([imageFree], "anthropic-messages");
    const [openaiShape] = toSdkMessages([imageFree], "openai-chat-completions");
    expect(openaiShape).toEqual(anthropicShape);
  });

  it("leaves a user-message image untouched on the openai-chat-completions transport (only tool-result images are stripped)", () => {
    const [userMsg] = toSdkMessages([{ role: "user", content: "look", images: [IMG] }], "openai-chat-completions");
    expect(userMsg).toEqual({
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "file", data: "QUJD", mediaType: "image/png" },
      ],
    });
  });
});

describe("toSdkMessages presentation invisibility (slice S1 W3, CUT-S1 §3 W3 item 3)", () => {
  const toolResultWithPresentation: ChatMessage = {
    role: "tool",
    content: [
      {
        type: "tool_result",
        toolCallId: "call_42",
        toolName: "Agent",
        text: "child done",
        status: "success",
        presentation: {
          subagent: {
            kind: "subagent",
            version: 1,
            target: { kind: "inline" },
            identity: { agentType: "explore", description: "d", model: null, engine: null },
            counters: { turns: 1, toolCalls: 1, lastTool: "Bash" },
            activity: { entries: [{ toolName: "Bash", summary: "echo hi" }], dropped: 0 },
            final: { status: "completed", durationMs: 5 },
          },
        },
      },
    ],
  };

  it.each(["anthropic-messages", "openai-chat-completions"] as const)(
    "never surfaces the word 'presentation' on the %s transport",
    (transport) => {
      const sdkMessages = toSdkMessages([toolResultWithPresentation], transport);
      expect(JSON.stringify(sdkMessages)).not.toContain("presentation");
      // Nor any of the card's own payload words, in case a future refactor
      // inlines the object without the key name surviving.
      expect(JSON.stringify(sdkMessages)).not.toContain("subagent");
    },
  );

  it("the mapped tool-result output is otherwise byte-identical to the presentation-free path", () => {
    const withPresentation = toSdkMessages([toolResultWithPresentation], "anthropic-messages");
    const withoutPresentation = toSdkMessages(
      [
        {
          role: "tool",
          content: [{ type: "tool_result", toolCallId: "call_42", toolName: "Agent", text: "child done", status: "success" }],
        },
      ],
      "anthropic-messages",
    );
    expect(withPresentation).toEqual(withoutPresentation);
  });
});

describe("toSdkMessages: reasoning replay (GitHub #41)", () => {
  const zai: ReasoningSource = { transport: "anthropic-messages", provider: "Z.AI (GLM)", baseUrl: "https://api.z.ai/api/anthropic", model: "glm-5.3" };
  const signed: AssistantReasoningPart = { type: "reasoning", text: "think", providerMetadata: { anthropic: { signature: "sig" } }, source: zai };
  const call = { type: "tool_call" as const, toolCallId: "c1", toolName: "Read", input: {} };
  const assistant = (...content: AssistantPart[]): ChatMessage =>
    ({ role: "assistant", content });

  it("emits a signed reasoning part, in order, when the source matches", () => {
    const [message] = toSdkMessages([assistant(signed, call)], "anthropic-messages", zai);
    expect(message).toEqual({
      role: "assistant",
      content: [
        { type: "reasoning", text: "think", providerOptions: { anthropic: { signature: "sig" } } },
        { type: "tool-call", toolCallId: "c1", toolName: "Read", input: {} },
      ],
    });
  });

  it("keeps redacted thinking", () => {
    const redacted: AssistantReasoningPart = { type: "reasoning", text: "", providerMetadata: { anthropic: { redactedData: "blob" } }, source: zai };
    const [message] = toSdkMessages([assistant(redacted, call)], "anthropic-messages", zai);
    expect((message!.content as unknown[])[0]).toEqual({ type: "reasoning", text: "", providerOptions: { anthropic: { redactedData: "blob" } } });
  });

  it("drops reasoning when replay is off for the route", () => {
    const [message] = toSdkMessages([assistant(signed, call)], "anthropic-messages");
    expect(message!.content).toEqual([{ type: "tool-call", toolCallId: "c1", toolName: "Read", input: {} }]);
  });

  it("drops reasoning from another model, endpoint, provider or transport", () => {
    for (const current of [
      { ...zai, model: "glm-5.3-flash" },
      { ...zai, baseUrl: "https://other.example/anthropic" },
      { ...zai, provider: "MiniMax" },
      { transport: "anthropic-messages", baseUrl: zai.baseUrl, model: zai.model },
    ]) {
      const [message] = toSdkMessages([assistant(signed, call)], "anthropic-messages", current);
      expect(message!.content, JSON.stringify(current)).toHaveLength(1);
    }
  });

  it("drops unsigned reasoning on anthropic-messages and parts with no source", () => {
    const unsigned: AssistantReasoningPart = { type: "reasoning", text: "think", source: zai };
    const sourceless: AssistantReasoningPart = { type: "reasoning", text: "think", providerMetadata: { anthropic: { signature: "sig" } } };
    const [message] = toSdkMessages([assistant(unsigned, sourceless, call)], "anthropic-messages", zai);
    expect(message!.content).toHaveLength(1);
  });

  it("replays unsigned MiMo thinking with an empty signature on an enabled route", () => {
    const mimo = { transport: "anthropic-messages", provider: "Xiaomi MiMo", baseUrl: "https://mimo", model: "mimo-v2.6-pro", replayUnsigned: true };
    const unsigned: AssistantReasoningPart = { type: "reasoning", text: "think", source: mimo };
    const [message] = toSdkMessages([assistant(unsigned, signed, call)], "anthropic-messages", mimo);
    expect(message!.content).toEqual([
      { type: "reasoning", text: "think", providerOptions: { anthropic: { signature: "" } } },
      { type: "tool-call", toolCallId: "c1", toolName: "Read", input: {} },
    ]);
  });

  it("drops all Anthropic reasoning when the first block is not replayable", () => {
    const unsigned: AssistantReasoningPart = { type: "reasoning", text: "unsigned", source: zai };
    const [message] = toSdkMessages([assistant(unsigned, signed, call)], "anthropic-messages", zai);
    expect(message!.content).toEqual([{ type: "tool-call", toolCallId: "c1", toolName: "Read", input: {} }]);
  });

  it("emits plain reasoning on openai-chat-completions, never on openai-responses", () => {
    const chat: ReasoningSource = { transport: "openai-chat-completions", baseUrl: "http://gw/v1", model: "glm-5.3" };
    const part: AssistantReasoningPart = { type: "reasoning", text: "think", source: chat };
    const [onChat] = toSdkMessages([assistant(part, call)], "openai-chat-completions", chat);
    expect((onChat!.content as unknown[])[0]).toEqual({ type: "reasoning", text: "think" });

    const responses: ReasoningSource = { ...chat, transport: "openai-responses" };
    const [onResponses] = toSdkMessages([assistant({ ...part, source: responses }, call)], "openai-responses", responses);
    expect(onResponses!.content).toHaveLength(1);
  });

  it("chat-completions with replay on: a tool-call message without reasoning gets reasoning_content \"\"", () => {
    const chat: ReasoningSource = { transport: "openai-chat-completions", baseUrl: "http://gw/v1", model: "deepseek" };
    const [toolTurn] = toSdkMessages([assistant(call)], "openai-chat-completions", chat);
    expect(toolTurn).toMatchObject({ providerOptions: { openaiCompatible: { reasoning_content: "" } } });
    // Text-only turns, routes with replay off and anthropic are untouched.
    expect(toSdkMessages([assistant({ type: "text", text: "hi" })], "openai-chat-completions", chat)[0]).not.toHaveProperty("providerOptions");
    expect(toSdkMessages([assistant(call)], "openai-chat-completions")[0]).not.toHaveProperty("providerOptions");
    expect(toSdkMessages([assistant(call)], "anthropic-messages", zai)[0]).not.toHaveProperty("providerOptions");
    // With real reasoning the SDK sends it; no override that could blank it.
    const withReasoning = toSdkMessages([assistant({ type: "reasoning", text: "t", source: chat }, call)], "openai-chat-completions", chat)[0];
    expect(withReasoning).not.toHaveProperty("providerOptions");
  });

  it("sameReasoningSource compares every field", () => {
    expect(sameReasoningSource(zai, { ...zai })).toBe(true);
    expect(sameReasoningSource(zai, { ...zai, model: "x" })).toBe(false);
    expect(sameReasoningSource(zai, { ...zai, baseUrl: zai.baseUrl + "///" })).toBe(true);
  });
});
