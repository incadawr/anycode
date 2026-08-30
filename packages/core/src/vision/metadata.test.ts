/**
 * Image metadata parser tests (TASK.198 slice A, plan §2/§10-A). Pins: pixel
 * dimensions recovered from fixture headers for all four sniffable formats,
 * garbage bytes resolving to undefined rather than throwing, format detection
 * routed through the existing `sniffImageMediaType` (util/images.ts) instead of
 * a re-implementation, and the image-stub formatter's fixed shape.
 */

import { describe, expect, it, vi } from "vitest";
import * as imageSniffer from "../util/images.js";
import { formatImageStub, imageDimensions } from "./metadata.js";

// ---------------------------------------------------------------------------
// Fixture builders — minimal-but-valid headers for each of the four formats.
// Only the bytes the parser actually reads are meaningful; padding data is
// zeroed. Byte offsets follow each format's public spec (PNG IHDR, JPEG SOF0,
// GIF logical screen descriptor, WEBP RIFF/VP8X).

function pngFixture(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0); // PNG signature
  bytes.set([0, 0, 0, 13], 8); // IHDR chunk length (13)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return bytes;
}

function jpegFixture(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(11);
  bytes[0] = 0xff;
  bytes[1] = 0xd8; // SOI
  bytes[2] = 0xff;
  bytes[3] = 0xc0; // SOF0
  bytes[4] = 0x00;
  bytes[5] = 0x11; // segment length (17), unused by the reader beyond presence
  bytes[6] = 0x08; // precision
  bytes[7] = (height >> 8) & 0xff;
  bytes[8] = height & 0xff;
  bytes[9] = (width >> 8) & 0xff;
  bytes[10] = width & 0xff;
  return bytes;
}

function gifFixture(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(10);
  bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0); // "GIF89a"
  bytes[6] = width & 0xff;
  bytes[7] = (width >> 8) & 0xff;
  bytes[8] = height & 0xff;
  bytes[9] = (height >> 8) & 0xff;
  return bytes;
}

function webpFixture(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  bytes.set([0, 0, 0, 0], 4); // container size, unused
  bytes.set([0x57, 0x45, 0x42, 0x50], 8); // "WEBP"
  bytes.set([0x56, 0x50, 0x38, 0x58], 12); // "VP8X"
  bytes.set([10, 0, 0, 0], 16); // chunk size (10)
  bytes[20] = 0; // flags
  bytes[21] = 0;
  bytes[22] = 0;
  bytes[23] = 0; // reserved
  const w1 = width - 1;
  const h1 = height - 1;
  bytes[24] = w1 & 0xff;
  bytes[25] = (w1 >> 8) & 0xff;
  bytes[26] = (w1 >> 16) & 0xff;
  bytes[27] = h1 & 0xff;
  bytes[28] = (h1 >> 8) & 0xff;
  bytes[29] = (h1 >> 16) & 0xff;
  return bytes;
}

describe("imageDimensions", () => {
  it("reads width/height from a PNG IHDR chunk", () => {
    expect(imageDimensions(pngFixture(1280, 800))).toEqual({ width: 1280, height: 800 });
  });

  it("reads width/height from a JPEG SOF0 segment", () => {
    expect(imageDimensions(jpegFixture(640, 480))).toEqual({ width: 640, height: 480 });
  });

  it("reads width/height from a GIF logical screen descriptor", () => {
    expect(imageDimensions(gifFixture(320, 200))).toEqual({ width: 320, height: 200 });
  });

  it("reads width/height from an extended (VP8X) WEBP header", () => {
    expect(imageDimensions(webpFixture(1024, 768))).toEqual({ width: 1024, height: 768 });
  });

  it("returns undefined for garbage bytes that match no supported format", () => {
    expect(imageDimensions(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBeUndefined();
  });

  it("returns undefined (never throws) for a truncated header claiming a known magic", () => {
    const truncated = pngFixture(100, 100).slice(0, 10);
    expect(() => imageDimensions(truncated)).not.toThrow();
    expect(imageDimensions(truncated)).toBeUndefined();
  });

  it("detects the format through the existing sniffImageMediaType rather than re-sniffing", () => {
    const spy = vi.spyOn(imageSniffer, "sniffImageMediaType");
    imageDimensions(pngFixture(10, 20));
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("formatImageStub", () => {
  it("formats a stub with format, dimensions, size and source name", () => {
    // 240 KB of raw bytes, base64-encoded (4/3 expansion), no padding chars.
    const rawBytes = 240 * 1024;
    const data = "A".repeat(Math.ceil(rawBytes / 3) * 4);
    const stub = formatImageStub({
      ref: 3,
      mediaType: "image/png",
      data,
      dimensions: { width: 1280, height: 800 },
      sourcePath: "screenshot.png",
    });
    expect(stub).toBe("[image #3 — png, 1280×800, 240 KB, screenshot.png]");
  });

  it("omits the dimensions segment when none were recoverable", () => {
    const stub = formatImageStub({ ref: 1, mediaType: "image/jpeg", data: "AAAA" });
    expect(stub).not.toMatch(/×/);
    expect(stub.startsWith("[image #1 — jpeg,")).toBe(true);
  });

  it("omits the name segment when there is no sourcePath", () => {
    const stub = formatImageStub({ ref: 2, mediaType: "image/gif", data: "AAAA" });
    expect(stub.endsWith("]")).toBe(true);
    expect(stub).not.toContain("undefined");
  });
});
