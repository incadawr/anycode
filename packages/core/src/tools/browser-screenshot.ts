/**
 * BrowserScreenshot (night-track wave-1 cut §2.2, frozen metadata). Separate
 * file from tools/browser-preview.ts by design (§3 96-C: "a parallel slice")
 * so 96-C and 96-B stay disjoint merge points; this module never touches
 * BrowserOpen/BrowserRead.
 *
 * Fails closed the same way every other optional-port tool does: absent
 * `ctx.preview` (types/tools.ts) => an explicit "unavailable" error, never a
 * silent no-op.
 *
 * Media-gate invariant this file owns: a screenshot IS an image attachment,
 * so it is refused before ever calling the port when the current model is
 * not image-capable — same wording shape as the image-capable Read gate
 * (tools/read-image.ts:69-74), with an extra sentence pointing at BrowserRead
 * as the text-only fallback (§2.2).
 */

import { z } from "zod";
import type { ToolDefinition, ToolMetadata, ToolResult } from "../types/tools.js";
import type { ImageAttachment } from "../types/images.js";
import { IMAGE_MAX_BYTES } from "../types/config.js";
import type { PreviewScreenshotSuccess } from "../ports/preview.js";

const BROWSER_SCREENSHOT_TIMEOUT_MS = 20_000;

export const browserScreenshotInputSchema = z.object({
  preview_id: z.string().trim().min(1).optional(),
});

export type BrowserScreenshotInput = z.output<typeof browserScreenshotInputSchema>;

const browserScreenshotMetadata: ToolMetadata = {
  name: "BrowserScreenshot",
  description:
    "Captures a screenshot of the currently open session preview window (visible area only, no scroll-stitch).",
  readOnly: true,
  destructive: false,
  concurrentSafe: false,
  riskLevel: "low",
  sideEffectScope: "none",
  needsApproval: false,
  timeoutMs: BROWSER_SCREENSHOT_TIMEOUT_MS,
};

/**
 * Same clause as read-image.ts:69-74 ("is an image, and the current model is
 * not marked image-capable...") with the BrowserRead fallback sentence this
 * slice owns appended. There is no file_path here (a preview, not a file), so
 * the subject names the screenshot itself rather than a path.
 */
const MEDIA_GATE_ERROR =
  "This browser preview screenshot is an image, and the current model is not marked image-capable " +
  "(switch /model, or set ANYCODE_IMAGE_INPUT=on to override). Use BrowserRead for a text fallback.";

/**
 * PreviewResult.errorKind is a wider union than ToolResult.errorKind (types/
 * tools.ts): only "invalid_input"/"cancelled" pass through unchanged,
 * "timeout" narrows to the dispatcher's "timed_out" status, and the
 * host-security kinds ("unavailable"/"load_failed"/"crashed") have no
 * ToolCallStatus equivalent — they still carry their message, just as a plain
 * "error" outcome instead of a manufactured status the type doesn't have.
 * Mirrors tools/browser-preview.ts's toToolErrorKind (kept local: this file is
 * a deliberately separate slice, §3 96-C).
 */
function toToolErrorKind(
  kind: "invalid_input" | "cancelled" | "unavailable" | "load_failed" | "crashed" | "timeout" | undefined,
): ToolResult["errorKind"] {
  switch (kind) {
    case "invalid_input":
    case "cancelled":
      return kind;
    case "timeout":
      return "timed_out";
    default:
      return undefined;
  }
}

export const browserScreenshotTool: ToolDefinition<BrowserScreenshotInput, PreviewScreenshotSuccess> = {
  metadata: browserScreenshotMetadata,
  inputSchema: browserScreenshotInputSchema,
  handler: async (input, ctx) => {
    if (!ctx.preview) {
      return { ok: false, error: "Browser preview is unavailable in this session." };
    }
    if (!ctx.media?.imageInputEnabled()) {
      return { ok: false, error: MEDIA_GATE_ERROR };
    }
    const result = await ctx.preview.screenshot(
      { ...(input.preview_id !== undefined ? { previewId: input.preview_id } : {}) },
      { signal: ctx.abortSignal, toolCallId: ctx.toolCallId },
    );
    if (!result.ok) {
      const errorKind = toToolErrorKind(result.errorKind);
      return { ok: false, error: result.error, ...(errorKind ? { errorKind } : {}) };
    }
    const { value } = result;
    // The port hands back base64 text; the per-image cap (design §2-A8) is
    // defined in raw DECODED bytes, so it is enforced here on the decoded
    // length rather than trusting the encoded string's size as a proxy.
    const decodedBytes = Buffer.from(value.data, "base64").length;
    if (decodedBytes > IMAGE_MAX_BYTES) {
      return {
        ok: false,
        error: `Browser preview screenshot of ${value.url} is ${decodedBytes} bytes, over the ${IMAGE_MAX_BYTES}-byte per-image limit`,
      };
    }
    const attachment: ImageAttachment = {
      mediaType: value.mediaType,
      data: value.data,
      sourcePath: value.url,
    };
    return {
      ok: true,
      output: value,
      images: [attachment],
    };
  },
  formatResultForModel: (result) => {
    if (!result.ok) {
      return result.error ?? "BrowserScreenshot: failed to capture the preview.";
    }
    const output = result.output;
    if (!output) {
      return "";
    }
    return `Screenshot of ${output.url} (${output.width}x${output.height}) attached.`;
  },
};
