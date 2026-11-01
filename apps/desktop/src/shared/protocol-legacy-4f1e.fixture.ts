// Exact schema extracts from protocol.ts at 4f1e5f31; keep frozen for mixed-version tests.
import { z } from "zod";
const IMAGE_MAX_BYTES = 3_750_000;
const IMAGE_MAX_PER_MESSAGE = 8;
const IMAGE_BASE64_MAX_CHARS = Math.ceil(IMAGE_MAX_BYTES / 3) * 4 + 4;

export const uiReadySchema = z
  .object({
    type: z.literal("ui_ready"),
  })
  .strict();

export const userMessageSchema = z
  .object({
    type: z.literal("user_message"),
    requestId: z.string(),
    text: z.string(),
    images: z
      .array(
        z
          .object({
            mediaType: z.union([
              z.literal("image/png"),
              z.literal("image/jpeg"),
              z.literal("image/gif"),
              z.literal("image/webp"),
            ]),
            data: z.string().min(1).max(IMAGE_BASE64_MAX_CHARS),
            sourcePath: z.string().min(1).max(4096).optional(),
          })
          .strict(),
      )
      .max(IMAGE_MAX_PER_MESSAGE)
      .optional(),
    // срезы 2+3 (merged): renderer-set only when draining a queued
    // detached-child report (QueuedPrompt.origin). Validated here like every
    // other untrusted field — and unlike срез 2's original reading, a mis-set
    // value is NOT display-only: it also suppresses's human-presence
    // signal (see the UiToHostMessage union's own doc), so fail-closed
    // validation here is load-bearing, not just defense in depth.
    origin: z.literal("system").optional(),
  })
  .strict();

export const setOrchestrateSchema = z
  .object({
    type: z.literal("set_orchestrate"),
    enabled: z.boolean(),
  })
  .strict();
