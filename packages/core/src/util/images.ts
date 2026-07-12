/**
 * Image extension routing + magic-byte sniffing + bounded loader (Phase 6 slice
 * 6.2, design §2-A7). Pure module: no node:path / no node:fs — the extension is
 * parsed by hand (lastIndexOf) and bytes arrive through FileSystemPort, so this
 * stays port-clean and unit-testable. mediaType is authoritative from the SNIFF;

 */

import type { FileSystemPort } from "../ports/file-system.js";
import type { ImageAttachment, ImageMediaType } from "../types/images.js";
import { IMAGE_MAX_BYTES } from "../types/config.js";

/** Lowercased, dot-prefixed extensions that route into the image path. */
export const IMAGE_EXTENSIONS: ReadonlyMap<string, ImageMediaType> = new Map<string, ImageMediaType>([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
]);

/**
 * Routes a path by its extension. Returns the mapped media type or null when the
 * extension is absent/unrecognized. Extension parsing is a bare lastIndexOf so
 * this module never touches node:path.
 */
export function imageExtensionOf(path: string): ImageMediaType | null {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return null;
  const ext = path.slice(dot).toLowerCase();
  return IMAGE_EXTENSIONS.get(ext) ?? null;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const GIF87A_MAGIC = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61];
const GIF89A_MAGIC = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];
const RIFF_MAGIC = [0x52, 0x49, 0x46, 0x46];
const WEBP_TAG = [0x57, 0x45, 0x42, 0x50];

/** True when `bytes` begins with every byte of `prefix` (false if too short). */
function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (bytes[i] !== prefix[i]) return false;
  }
  return true;
}

/**
 * Identifies the format from leading magic bytes. Returns null for anything that
 * is not one of the four supported formats, including truncated headers — a
 * short buffer is a valid input that answers null, never a crash.
 */
export function sniffImageMediaType(bytes: Uint8Array): ImageMediaType | null {
  if (startsWith(bytes, PNG_MAGIC)) return "image/png";
  if (startsWith(bytes, JPEG_MAGIC)) return "image/jpeg";
  if (startsWith(bytes, GIF87A_MAGIC) || startsWith(bytes, GIF89A_MAGIC)) return "image/gif";
  // WEBP: "RIFF" at 0-3, container size at 4-7, "WEBP" at 8-11.
  if (
    bytes.length >= 12 &&
    startsWith(bytes, RIFF_MAGIC) &&
    bytes[8] === WEBP_TAG[0] &&
    bytes[9] === WEBP_TAG[1] &&
    bytes[10] === WEBP_TAG[2] &&
    bytes[11] === WEBP_TAG[3]
  ) {
    return "image/webp";
  }
  return null;
}

export type LoadImageResult =
  | { ok: true; attachment: ImageAttachment; rawBytes: number }
  | { ok: false; reason: string };

/**
 * Loads a local file as an ImageAttachment through FileSystemPort, fail-closed at
 * every gate: no binary-read capability, a read error, an over-cap file, or a
 * non-image payload each return an honest reason and never an attachment. On
 * success the mediaType is taken from the sniff (not the extension) and the
 * payload is base64-encoded with no data: URI prefix.
 */
export async function loadImageAttachment(fs: FileSystemPort, path: string): Promise<LoadImageResult> {
  if (typeof fs.readFileBytes !== "function") {
    return { ok: false, reason: "binary read unavailable on this filesystem port" };
  }
  let bytes: Uint8Array;
  try {
    bytes = await fs.readFileBytes(path);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  if (bytes.length > IMAGE_MAX_BYTES) {
    return {
      ok: false,
      reason: `image is ${bytes.length} bytes, over the ${IMAGE_MAX_BYTES}-byte per-image limit`,
    };
  }
  const mediaType = sniffImageMediaType(bytes);
  if (mediaType === null) {
    return { ok: false, reason: "not a supported image (png/jpeg/gif/webp)" };
  }
  return {
    ok: true,
    attachment: {
      mediaType,
      data: Buffer.from(bytes).toString("base64"),
      sourcePath: path,
    },
    rawBytes: bytes.length,
  };
}
