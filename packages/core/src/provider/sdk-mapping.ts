/**
 * Own-vocabulary -> AI SDK shape conversion (design §2.2). This module and the
 * stream translator are the ONLY places that know SDK message/tool shapes;
 * everything above the provider layer speaks ChatMessage/ToolDeclaration.
 *
 * The system prompt never enters the message list (ai@7 rejects system-role
 * entries inside `messages`); AiSdkModelPort forwards ModelRequest.system as
 * the `instructions` option.
 */

import { jsonSchema, tool, type ModelMessage, type ToolSet } from "ai";
import type {
  AssistantPart,
  ChatMessage,
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
 * (TASK.43 §5.1), so their factories bring their own tool-result policy here. The
 * anthropic-messages mapping below is the only live one and is byte-pinned by
 * sdk-mapping.test.ts / image-wire.integration.test.ts. Taking the transport as a
 * required parameter now means adding a protocol cannot forget this seam — a
 * silently image-free (or JSON-stringified-base64) tool result is a token bomb
 * that no type error would have caught.
 */
export function toSdkMessages(
  messages: readonly ChatMessage[],
  transport: ProviderTransport,
): ModelMessage[] {
  void transport;
  return messages.map((message): ModelMessage => {
    switch (message.role) {
      case "user": {
        // Image-free user messages keep the exact pre-slice shape (bare string
        // content). With images, content becomes [TextPart, ...FilePart(image)]:
        // a FilePart carries the base64 payload as a bare DataContent shorthand
        // (@ai-sdk/provider-utils FilePart.data), which @ai-sdk/anthropic
        // serializes to an anthropic image block {type:'image', source:{type:'base64'}}.
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
      case "assistant":
        return { role: "assistant", content: message.content.map(toSdkAssistantPart) };
      case "tool":
        return { role: "tool", content: message.content.map(toSdkToolResultPart) };
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

function toSdkAssistantPart(part: AssistantPart) {
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

function toSdkToolResultPart(part: ToolResultPart) {
  // Image-free tool results keep the exact pre-slice `{type:'text'}` output.
  // With images, the output becomes a `content` array of a text part plus one
  // FilePart per image. Unlike the user FilePart shorthand, a tool-result
  // content file uses the TAGGED FileData shape `{type:'data', data}`
  // (@ai-sdk/provider-utils ToolResultOutput content variant); @ai-sdk/anthropic
  // serializes it to an anthropic image block inside tool_result.content[].
  if (part.images === undefined || part.images.length === 0) {
    return {
      type: "tool-result" as const,
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      output: { type: "text" as const, value: part.text },
    };
  }
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
