/**
 * Own-vocabulary -> AI SDK shape conversion (design §2.2). This module and the
 * stream translator are the ONLY places that know SDK message/tool shapes;
 * everything above the provider layer speaks ChatMessage/ToolDeclaration.
 *
 * The system prompt never enters the message list (ai@7 rejects system-role
 * entries inside `messages`); AiSdkModelPort forwards ModelRequest.system as
 * the `instructions` option.
 */

import { jsonSchema, tool, type ModelMessage, type ProviderMetadata, type ToolSet } from "ai";
import type {
  AssistantPart,
  AssistantReasoningPart,
  AssistantTextPart,
  AssistantToolCallPart,
  ChatMessage,
  ReasoningSource,
  ToolResultPart,
} from "../types/history.js";
import type { ToolDeclaration } from "../types/tools.js";
import type { ProviderTransport } from "./catalog.js";

/**
 * Converts the own envelope into SDK ModelMessage[] (user/assistant/tool only).
 *
 * `transport` is threaded through because message policy is NOT protocol-neutral
 * even though the SDK types are: an image inside a tool RESULT survives the
 * anthropic-messages wire but has no representation on the OpenAI transports
 * (§5.1), so `toSdkToolResultPart` below branches on it. The
 * anthropic-messages mapping is byte-pinned by sdk-mapping.test.ts /
 * image-wire.integration.test.ts and untouched by the OpenAI branch. Taking the
 * transport as a required parameter means adding a protocol cannot forget this
 * seam — a silently image-free (or JSON-stringified-base64) tool result is a
 * token bomb that no type error would have caught.
 *
 * `reasoningReplay` is the calling route's identity when it replays reasoning
 * (GitHub #41); absent = every reasoning part is dropped.
 */
export function toSdkMessages(
  messages: readonly ChatMessage[],
  transport: ProviderTransport,
  reasoningReplay?: ReasoningSource,
): ModelMessage[] {
  return messages.map((message): ModelMessage => {
    switch (message.role) {
      case "user": {
        // Image-free user messages keep the exact pre-slice shape (bare string
        // content). With images, content becomes [TextPart, ...FilePart(image)]:
        // a FilePart carries the base64 payload as a bare DataContent shorthand
        // (@ai-sdk/provider-utils FilePart.data), which @ai-sdk/anthropic
        // serializes to an anthropic image block {type:'image', source:{type:'base64'}}.
        // The OpenAI transports map the same shorthand to a data-URI `image_url`
        // part (@ai-sdk/openai-compatible dist index.js:168-176) — a user-message
        // image survives on every transport; only the tool-RESULT image below does not.
        if (message.images === undefined || message.images.length === 0) {
          return { role: "user", content: message.content };
        }
        return {
          role: "user",
          content: [
            { type: "text" as const, text: message.content },
            ...message.images.map((img) => ({
              type: "file" as const,
              data: img.data,
              mediaType: img.mediaType,
            })),
          ],
        };
      }
      case "assistant": {
        const content = toSdkAssistantContent(message.content, transport, reasoningReplay);
        // Chat-completions providers that preserve reasoning (DeepSeek) reject a
        // tool-call message without `reasoning_content`, and the SDK omits the
        // field when it is empty. Its message-level openaiCompatible options
        // are spread onto the wire message, so send "" there.
        if (
          transport === "openai-chat-completions" &&
          reasoningReplay !== undefined &&
          content.some((part) => part.type === "tool-call") &&
          !content.some((part) => part.type === "reasoning")
        ) {
          return { role: "assistant", content, providerOptions: { openaiCompatible: { reasoning_content: "" } } };
        }
        return { role: "assistant", content };
      }
      case "tool":
        return { role: "tool", content: message.content.map((part) => toSdkToolResultPart(part, transport)) };
    }
  });
}

/**
 * Wraps declarations into an SDK ToolSet: jsonSchema() around the prebuilt
 * JSON Schema, no `execute` attached — the SDK can only propose calls;
 * execution stays in the dispatch pipeline.
 */
export function toSdkTools(declarations: readonly ToolDeclaration[]): ToolSet {
  const toolSet: ToolSet = {};
  for (const declaration of declarations) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    toolSet[declaration.name] = tool<any, never, any>({
      description: declaration.description,
      inputSchema: jsonSchema(declaration.inputJsonSchema),
    });
  }
  return toolSet;
}

/**
 * Reasoning parts go out only when replay is on for this route
 * (`reasoningReplay` set), the transport can carry them, and the part was
 * produced by this same route. Anthropic needs a signature or redacted data;
 * a bare thinking block would be rejected or dropped by the SDK anyway.
 */
function toSdkAssistantContent(
  parts: readonly AssistantPart[],
  transport: ProviderTransport,
  reasoningReplay: ReasoningSource | undefined,
) {
  const out = [];
  for (const part of parts) {
    if (part.type === "reasoning") {
      if (shouldReplayReasoning(part, transport, reasoningReplay)) {
        out.push({
          type: "reasoning" as const,
          text: part.text,
          ...(part.providerMetadata !== undefined
            ? { providerOptions: part.providerMetadata as ProviderMetadata }
            : {}),
        });
      }
      continue;
    }
    out.push(toSdkAssistantPart(part));
  }
  return out;
}

function shouldReplayReasoning(
  part: AssistantReasoningPart,
  transport: ProviderTransport,
  current: ReasoningSource | undefined,
): boolean {
  if (current === undefined || part.source === undefined) return false;
  if (!sameReasoningSource(part.source, current)) return false;
  if (transport === "anthropic-messages") {
    const anthropic = part.providerMetadata?.anthropic;
    return typeof anthropic?.signature === "string" || typeof anthropic?.redactedData === "string";
  }
  if (transport === "openai-chat-completions") return part.text.length > 0;
  return false;
}

export function sameReasoningSource(a: ReasoningSource, b: ReasoningSource): boolean {
  return a.transport === b.transport && a.provider === b.provider && a.baseUrl === b.baseUrl && a.model === b.model;
}

function toSdkAssistantPart(part: AssistantTextPart | AssistantToolCallPart) {
  if (part.type === "text") {
    return { type: "text" as const, text: part.text };
  }
  return {
    type: "tool-call" as const,
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    input: part.input,
  };
}

/**
 * Placeholder text substituted for an omitted tool-result image on the OpenAI
 * transports (§5.1). Exported for tests asserting the strip is
 * observable, not silent.
 */
export const OPENAI_TOOL_RESULT_IMAGE_OMITTED_NOTE =
  "[image omitted: not supported by chat-completions tool results]";

function toSdkToolResultPart(part: ToolResultPart, transport: ProviderTransport) {
  // Image-free tool results keep the exact pre-slice `{type:'text'}` output on
  // EVERY transport — there is nothing protocol-specific to branch on here.
  if (part.images === undefined || part.images.length === 0) {
    return {
      type: "tool-result" as const,
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      output: { type: "text" as const, value: part.text },
    };
  }
  if (transport !== "anthropic-messages") {
    // Chat Completions (and Responses) have no wire representation for an
    // image inside a tool result. Left alone, @ai-sdk/openai-compatible would
    // JSON.stringify() the FilePart's base64 payload straight into the tool
    // message's text (dist index.js:305-308) — a token bomb the model can't
    // even read as a picture. Drop the images, keep the text verbatim, and
    // append a note so the model isn't left wondering why text like "[image
    // attached]" has no accompanying image.
    return {
      type: "tool-result" as const,
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      output: { type: "text" as const, value: `${part.text}\n${OPENAI_TOOL_RESULT_IMAGE_OMITTED_NOTE}` },
    };
  }
  // anthropic-messages: with images, the output becomes a `content` array of a
  // text part plus one FilePart per image. Unlike the user FilePart shorthand,
  // a tool-result content file uses the TAGGED FileData shape `{type:'data', data}`
  // (@ai-sdk/provider-utils ToolResultOutput content variant); @ai-sdk/anthropic
  // serializes it to an anthropic image block inside tool_result.content[].
  return {
    type: "tool-result" as const,
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    output: {
      type: "content" as const,
      value: [
        { type: "text" as const, text: part.text },
        ...part.images.map((img) => ({
          type: "file" as const,
          data: { type: "data" as const, data: img.data },
          mediaType: img.mediaType,
        })),
      ],
    },
  };
}
