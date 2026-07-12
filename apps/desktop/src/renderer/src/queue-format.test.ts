/**
 * Pure-logic tests for the shared transcript-echo formatting (slice P7.14
 * §2.1). Moved out of Composer.test.ts when `transcriptTextWithImages` /
 * `imageAttachmentBadge` were extracted into `queue-format.ts` so both the
 * Composer send path and the prompt-queue drainer share one implementation;
 * the assertions themselves are unchanged (same function names, same output).
 */
import { describe, expect, it } from "vitest";
import { imageAttachmentBadge, transcriptTextWithImages } from "./queue-format.js";

describe("transcriptTextWithImages", () => {
  it("adds only a transcript badge for images, leaving the send text separate", () => {
    expect(transcriptTextWithImages("look", 0)).toBe("look");
    expect(transcriptTextWithImages("look", 1)).toBe("look\n\n[1 image attached]");
    expect(transcriptTextWithImages("", 2)).toBe("[2 images attached]");
  });

  it("leaves an empty draft with no images untouched", () => {
    expect(transcriptTextWithImages("", 0)).toBe("");
  });
});

describe("imageAttachmentBadge", () => {
  it("singularizes for one image and pluralizes otherwise", () => {
    expect(imageAttachmentBadge(1)).toBe("[1 image attached]");
    expect(imageAttachmentBadge(3)).toBe("[3 images attached]");
  });
});
