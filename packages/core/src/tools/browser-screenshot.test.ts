import { describe, expect, it, vi } from "vitest";
import { browserScreenshotInputSchema, browserScreenshotTool } from "./browser-screenshot.js";
import type { ToolContext } from "../types/tools.js";
import type { MediaCapabilityPort } from "../ports/media.js";
import type { PreviewPort, PreviewScreenshotSuccess } from "../ports/preview.js";
import { IMAGE_MAX_BYTES } from "../types/config.js";

const mediaOn: MediaCapabilityPort = { imageInputEnabled: () => true };
const mediaOff: MediaCapabilityPort = { imageInputEnabled: () => false };

function context(opts?: { preview?: PreviewPort; media?: MediaCapabilityPort }): ToolContext {
  return {
    toolCallId: "call-1",
    abortSignal: new AbortController().signal,
    cwd: "/repo",
    ports: {},
    ...(opts?.preview ? { preview: opts.preview } : {}),
    ...(opts?.media ? { media: opts.media } : {}),
  } as ToolContext;
}

const screenshotSuccess: PreviewScreenshotSuccess = {
  previewId: "preview-1",
  url: "file:///repo/index.html",
  mediaType: "image/png",
  data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]).toString("base64"),
  width: 1100,
  height: 800,
};

function previewWith(
  screenshot: PreviewPort["screenshot"],
): PreviewPort {
  return {
    open: async () => ({ ok: false, error: "not built" }),
    read: async () => ({ ok: false, error: "not built" }),
    screenshot,
  };
}

describe("BrowserScreenshot", () => {
  it("declares the frozen §2.2 metadata literal", () => {
    expect(browserScreenshotTool.metadata).toMatchObject({
      name: "BrowserScreenshot",
      readOnly: true,
      destructive: false,
      concurrentSafe: false,
      riskLevel: "low",
      sideEffectScope: "none",
      needsApproval: false,
      timeoutMs: 20_000,
    });
  });

  it("accepts an optional preview_id and nothing else", () => {
    expect(browserScreenshotInputSchema.safeParse({}).success).toBe(true);
    expect(browserScreenshotInputSchema.safeParse({ preview_id: "preview-1" }).success).toBe(true);
    expect(browserScreenshotInputSchema.safeParse({ preview_id: "" }).success).toBe(false);
  });

  it("fails closed without a preview port (checked before the media gate)", async () => {
    const result = await browserScreenshotTool.handler(
      browserScreenshotInputSchema.parse({}),
      context({ media: mediaOff }),
    );
    expect(result).toMatchObject({ ok: false });
    expect(result.error).toBe("Browser preview is unavailable in this session.");
    expect(result.images).toBeUndefined();
  });

  describe("media gate (invariant owned by this slice)", () => {
    it("refuses in the read-image.ts wording shape, plus the BrowserRead fallback hint, when the model is not image-capable", async () => {
      const preview = previewWith(vi.fn<PreviewPort["screenshot"]>(async () => ({ ok: true, value: screenshotSuccess })));
      const result = await browserScreenshotTool.handler(
        browserScreenshotInputSchema.parse({}),
        context({ preview, media: mediaOff }),
      );
      expect(result.ok).toBe(false);
      // Same clause the image-capable Read gate uses (tools/read-image.ts:69-74).
      expect(result.error).toContain("is an image, and the current model is not marked image-capable");
      expect(result.error).toContain("ANYCODE_IMAGE_INPUT");
      expect(result.error).toContain("Use BrowserRead for a text fallback.");
      expect(result.images).toBeUndefined();
    });

    it("refuses when no MediaCapabilityPort is present at all (absence = fail-closed lock)", async () => {
      const preview = previewWith(vi.fn<PreviewPort["screenshot"]>(async () => ({ ok: true, value: screenshotSuccess })));
      const result = await browserScreenshotTool.handler(
        browserScreenshotInputSchema.parse({}),
        context({ preview }),
      );
      expect(result.ok).toBe(false);
      expect(result.error).toContain("ANYCODE_IMAGE_INPUT");
      expect(result.images).toBeUndefined();
    });

    it("never calls the port when the media gate refuses", async () => {
      const screenshot = vi.fn<PreviewPort["screenshot"]>(async () => ({ ok: true, value: screenshotSuccess }));
      const preview = previewWith(screenshot);
      await browserScreenshotTool.handler(browserScreenshotInputSchema.parse({}), context({ preview, media: mediaOff }));
      expect(screenshot).not.toHaveBeenCalled();
    });
  });

  it("forwards preview_id as previewId", async () => {
    const screenshot = vi.fn<PreviewPort["screenshot"]>(async () => ({ ok: true, value: screenshotSuccess }));
    const preview = previewWith(screenshot);
    await browserScreenshotTool.handler(
      browserScreenshotInputSchema.parse({ preview_id: "preview-9" }),
      context({ preview, media: mediaOn }),
    );
    expect(screenshot).toHaveBeenCalledWith(
      { previewId: "preview-9" },
      { signal: expect.any(AbortSignal), toolCallId: "call-1" },
    );
  });

  it("omits previewId when preview_id is not given", async () => {
    const screenshot = vi.fn<PreviewPort["screenshot"]>(async () => ({ ok: true, value: screenshotSuccess }));
    const preview = previewWith(screenshot);
    await browserScreenshotTool.handler(browserScreenshotInputSchema.parse({}), context({ preview, media: mediaOn }));
    expect(screenshot.mock.calls[0]?.[0]).toEqual({});
  });

  it("on success, returns images[0] shaped as a PNG attachment sourced from the preview url", async () => {
    const preview = previewWith(async () => ({ ok: true, value: screenshotSuccess }));
    const result = await browserScreenshotTool.handler(
      browserScreenshotInputSchema.parse({}),
      context({ preview, media: mediaOn }),
    );
    expect(result.ok).toBe(true);
    expect(result.images).toHaveLength(1);
    const [img] = result.images!;
    expect(img!.mediaType).toBe("image/png");
    expect(img!.data).toBe(screenshotSuccess.data);
    expect(img!.sourcePath).toBe(screenshotSuccess.url);
    expect(result.output).toEqual(screenshotSuccess);
  });

  it("rejects a screenshot over IMAGE_MAX_BYTES (decoded) with a size error and no images", async () => {
    const oversizedBytes = new Uint8Array(IMAGE_MAX_BYTES + 1);
    const oversized: PreviewScreenshotSuccess = {
      ...screenshotSuccess,
      data: Buffer.from(oversizedBytes).toString("base64"),
    };
    const preview = previewWith(async () => ({ ok: true, value: oversized }));
    const result = await browserScreenshotTool.handler(
      browserScreenshotInputSchema.parse({}),
      context({ preview, media: mediaOn }),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain(String(oversizedBytes.length));
    expect(result.error).toContain(String(IMAGE_MAX_BYTES));
    expect(result.images).toBeUndefined();
  });

  it("accepts a screenshot exactly at IMAGE_MAX_BYTES (boundary is inclusive)", async () => {
    const boundaryBytes = new Uint8Array(IMAGE_MAX_BYTES);
    const boundary: PreviewScreenshotSuccess = {
      ...screenshotSuccess,
      data: Buffer.from(boundaryBytes).toString("base64"),
    };
    const preview = previewWith(async () => ({ ok: true, value: boundary }));
    const result = await browserScreenshotTool.handler(
      browserScreenshotInputSchema.parse({}),
      context({ preview, media: mediaOn }),
    );
    expect(result.ok).toBe(true);
    expect(result.images).toHaveLength(1);
  });

  it("passes through a no-preview-open host error (errorKind unavailable) without an attachment", async () => {
    const preview = previewWith(async () => ({
      ok: false,
      error: "no preview open — use BrowserOpen",
      errorKind: "unavailable",
    }));
    const result = await browserScreenshotTool.handler(
      browserScreenshotInputSchema.parse({}),
      context({ preview, media: mediaOn }),
    );
    expect(result).toMatchObject({ ok: false, error: "no preview open — use BrowserOpen" });
    expect(result.errorKind).toBeUndefined();
    expect(result.images).toBeUndefined();
  });

  it("narrows a timeout errorKind to timed_out, and passes invalid_input/cancelled through unchanged", async () => {
    const timeoutPreview = previewWith(async () => ({ ok: false, error: "timed out", errorKind: "timeout" }));
    const timeoutResult = await browserScreenshotTool.handler(
      browserScreenshotInputSchema.parse({}),
      context({ preview: timeoutPreview, media: mediaOn }),
    );
    expect(timeoutResult).toMatchObject({ ok: false, errorKind: "timed_out" });

    const cancelledPreview = previewWith(async () => ({ ok: false, error: "cancelled", errorKind: "cancelled" }));
    const cancelledResult = await browserScreenshotTool.handler(
      browserScreenshotInputSchema.parse({}),
      context({ preview: cancelledPreview, media: mediaOn }),
    );
    expect(cancelledResult).toMatchObject({ ok: false, errorKind: "cancelled" });
  });

  it("formatResultForModel renders a short caption on success and the plain error on failure", () => {
    const rendered = browserScreenshotTool.formatResultForModel?.({ ok: true, output: screenshotSuccess });
    expect(rendered).toContain(screenshotSuccess.url);
    expect(rendered).toContain("1100x800");

    const failRendered = browserScreenshotTool.formatResultForModel?.({ ok: false, error: "boom" });
    expect(failRendered).toBe("boom");
  });
});
