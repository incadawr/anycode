/**
 * Image-capable Read wrapper (Phase 6 slice 6.2, design §2-C5). Registered by the
 * CLI wiring OVER the default Read (same name "Read"); the default tool registry,
 * the desktop model-facing surface, and every subagent registry never see it


 * needsApproval, hooks, rules — is byte-identical and no new tool NAME exists.
 *
 * Handler routing (design §2-C5, in order):
 *   1. non-image extension                 -> delegate to inner Read byte-for-byte.
 *   2. no binary-read capability on the fs -> delegate (fail-soft to today).
 *   3. read bytes; a read error returns the inner Read's error shape (read.ts:24-26).
 *   4. bytes do not sniff as a supported image (text under a .png) -> delegate.
 *   5. the current model is not image-capable -> explicit, actionable error
 *      naming the ANYCODE_IMAGE_INPUT override (fail-closed, never a silent drop).
 *   6. over the per-image byte cap -> explicit size+limit error.
 *   7. otherwise attach: a ReadOutput-shaped placeholder (so the default
 *      formatResultForModel renders it unchanged) + the ImageAttachment on

 *

 */

import type { ToolDefinition } from "../types/tools.js";
import type { ImageAttachment } from "../types/images.js";
import { IMAGE_MAX_BYTES } from "../types/config.js";
import { imageExtensionOf, sniffImageMediaType } from "../util/images.js";
import { readTool } from "./read.js";
import type { ReadInput, ReadOutput } from "./schemas.js";

/** Basename via a bare separator scan — no node:path, so this file stays fs-import-free. */
function basenameOf(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return slash === -1 ? path : path.slice(slash + 1);
}

/* */
export const imageCapableReadTool: ToolDefinition<ReadInput, ReadOutput> = {

  // tool name. NOT a copy — the shared reference makes the invariant structural
  // (the test asserts imageCapableReadTool.metadata === readTool.metadata).
  metadata: readTool.metadata,
  // Input surface untouched: the inner Read's schema is reused verbatim.
  inputSchema: readTool.inputSchema,
  handler: async (input, ctx) => {

    if (imageExtensionOf(input.file_path) === null) {
      return readTool.handler(input, ctx);
    }
    // No binary-read capability on this filesystem port: fail-soft to text Read.
    if (typeof ctx.ports.fs.readFileBytes !== "function") {
      return readTool.handler(input, ctx);
    }
    let bytes: Uint8Array;
    try {
      bytes = await ctx.ports.fs.readFileBytes(input.file_path);
    } catch (err) {
      // Inner-error shape of the text Read path (read.ts:24-26).
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    // Text/binary under an image extension: today's behavior — delegate to text

    const mediaType = sniffImageMediaType(bytes);
    if (mediaType === null) {
      return readTool.handler(input, ctx);
    }

    // history, with an actionable error naming the override.
    if (!ctx.media?.imageInputEnabled()) {
      return {
        ok: false,
        error: `${input.file_path} is an image, and the current model is not marked image-capable (switch /model, or set ANYCODE_IMAGE_INPUT=on to override)`,
      };
    }
    if (bytes.length > IMAGE_MAX_BYTES) {
      return {
        ok: false,
        error: `${input.file_path} is ${bytes.length} bytes, over the ${IMAGE_MAX_BYTES}-byte per-image limit`,
      };
    }
    const attachment: ImageAttachment = {
      mediaType,
      data: Buffer.from(bytes).toString("base64"),
      sourcePath: input.file_path,
    };
    return {
      ok: true,
      output: {
        content: `[image ${basenameOf(input.file_path)} (${mediaType}, ${Math.round(bytes.length / 1024)} KB) attached]`,
        totalLines: 0,
        truncated: false,
      },
      images: [attachment],
    };
  },
};
