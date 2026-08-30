/**
 * Image metadata: pixel-dimension parsing and the model-visible stub text for
 * a blind-model image fallback (TASK.198 plan §2/§0a). Format detection
 * deliberately reuses `sniffImageMediaType` (util/images.ts) instead of
 * re-implementing magic-byte matching — one format detector for the whole
 * codebase.
 */

import { sniffImageMediaType } from "../util/images.js";
import type { ImageMediaType } from "../types/images.js";

export interface ImageDimensions {
  width: number;
  height: number;
}

/** Reads a big-endian uint32 at `offset`, or undefined if it runs past the end. */
function readUint32BE(bytes: Uint8Array, offset: number): number | undefined {
  if (offset + 4 > bytes.length) return undefined;
  return ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0;
}

/** Reads a big-endian uint16 at `offset`, or undefined if it runs past the end. */
function readUint16BE(bytes: Uint8Array, offset: number): number | undefined {
  if (offset + 2 > bytes.length) return undefined;
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

/** Reads a little-endian uint16 at `offset`, or undefined if it runs past the end. */
function readUint16LE(bytes: Uint8Array, offset: number): number | undefined {
  if (offset + 2 > bytes.length) return undefined;
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

/** PNG: width/height live in the IHDR chunk, which is always the first chunk (offsets 16-23). */
function pngDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  const width = readUint32BE(bytes, 16);
  const height = readUint32BE(bytes, 20);
  if (width === undefined || height === undefined) return undefined;
  return { width, height };
}

/**
 * JPEG: dimensions live in the SOF (start-of-frame) marker segment, which can
 * sit anywhere after other markers (APPn/EXIF/quantization tables, etc.) — so
 * this walks the marker chain rather than assuming a fixed offset. SOF0-SOF15
 * except the DHT/JPG/DAC markers (0xC4/0xC8/0xCC) are all valid SOF variants.
 */
function jpegDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  let offset = 2; // skip the SOI marker (FFD8)
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return undefined; // not a marker boundary — malformed
    const marker = bytes[offset + 1]!;
    // Markers with no payload (RSTn, SOI/EOI, TEM) carry no length field.
    if (marker === 0x01 || marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const segmentLength = readUint16BE(bytes, offset + 2);
    if (segmentLength === undefined) return undefined;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      const height = readUint16BE(bytes, offset + 5);
      const width = readUint16BE(bytes, offset + 7);
      if (height === undefined || width === undefined) return undefined;
      return { width, height };
    }
    offset += 2 + segmentLength;
  }
  return undefined;
}

/** GIF: fixed-offset logical screen descriptor (width/height, little-endian) right after the 6-byte magic. */
function gifDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  const width = readUint16LE(bytes, 6);
  const height = readUint16LE(bytes, 8);
  if (width === undefined || height === undefined) return undefined;
  return { width, height };
}

/**
 * WEBP: dimensions live inside the first RIFF sub-chunk, whose 4-byte tag at
 * offset 12 selects one of three encodings — each with its own bit layout
 * (lossy VP8, lossless VP8L, or extended VP8X, which is the only variant that
 * carries an explicit canvas size independent of the bitstream).
 */
function webpDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  if (bytes.length < 16) return undefined;
  const tag = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!);
  if (tag === "VP8 ") {
    // Lossy: chunk data (from offset 20) is [frame tag:3][sync code:3][dims:4].
    if (bytes.length < 30) return undefined;
    const width = readUint16LE(bytes, 26);
    const height = readUint16LE(bytes, 28);
    if (width === undefined || height === undefined) return undefined;
    return { width: width & 0x3fff, height: height & 0x3fff };
  }
  if (tag === "VP8L") {
    // Lossless: 1 signature byte (0x2f) then a packed 14-bit width-1/height-1 pair.
    if (bytes.length < 25) return undefined;
    const b0 = bytes[21]!;
    const b1 = bytes[22]!;
    const b2 = bytes[23]!;
    const b3 = bytes[24]!;
    const width = 1 + (((b1 & 0x3f) << 8) | b0);
    const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
    return { width, height };
  }
  if (tag === "VP8X") {
    // Extended: [flags:1][reserved:3][canvas width-1:3 LE][canvas height-1:3 LE].
    if (bytes.length < 30) return undefined;
    const width = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16));
    const height = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16));
    return { width, height };
  }
  return undefined;
}

/**
 * Pixel dimensions of an image, or undefined for an unrecognized/truncated
 * header — never throws. Format is decided by `sniffImageMediaType`, the same
 * detector the attachment loader uses, so a byte stream this function accepts
 * is always one of the four formats the rest of the pipeline already handles.
 */
export function imageDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  const mediaType = sniffImageMediaType(bytes);
  if (mediaType === null) return undefined;
  switch (mediaType) {
    case "image/png":
      return pngDimensions(bytes);
    case "image/jpeg":
      return jpegDimensions(bytes);
    case "image/gif":
      return gifDimensions(bytes);
    case "image/webp":
      return webpDimensions(bytes);
  }
}

/**
 * Decoded byte length of a base64 payload computed from its string length
 * alone (no actual decode) — cheap enough to run on every stub render.
 */
function decodedByteLength(base64: string): number {
  if (base64.length === 0) return 0;
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

export interface ImageStubInput {
  ref: number;
  mediaType: ImageMediaType;
  /** Base64 payload — read only for its length (size estimate), never logged. */
  data: string;
  dimensions?: ImageDimensions;
  sourcePath?: string;
}

/**
 * Renders the model-visible stand-in for a blind model's image, e.g.
 * `[image #3 — png, 1280×800, 240 KB, screenshot.png]` (plan §2). This text is
 * the strongest signal that gets a model to call InspectImage — the format
 * name, size and dims are cheap author-time evidence that something real sits
 * behind the reference, before the model ever asks a question about it.
 */
export function formatImageStub(input: ImageStubInput): string {
  const format = input.mediaType.slice("image/".length);
  const segments = [format];
  if (input.dimensions !== undefined) {
    segments.push(`${input.dimensions.width}×${input.dimensions.height}`);
  }
  const kilobytes = Math.round(decodedByteLength(input.data) / 1024);
  segments.push(`${kilobytes} KB`);
  if (input.sourcePath !== undefined && input.sourcePath.length > 0) {
    segments.push(input.sourcePath);
  }
  return `[image #${input.ref} — ${segments.join(", ")}]`;
}
