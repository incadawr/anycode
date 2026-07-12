/**
 * util/images unit tests (Phase 6 slice 6.2, design §2-A7). Pins the frozen
 * sniff/route/load contract: magic bytes are authoritative, truncated headers
 * answer null without crashing, the extension only routes, and the loader is
 * fail-closed at every gate.
 */

import { describe, expect, it } from "vitest";
import type { FileSystemPort } from "../ports/file-system.js";
import { IMAGE_MAX_BYTES } from "../types/config.js";
import {
  IMAGE_EXTENSIONS,
  imageExtensionOf,
  loadImageAttachment,
  sniffImageMediaType,
} from "./images.js";

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const JPEG_HEADER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const GIF87A_HEADER = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x37, 0x61, 0x01, 0x00]);
const GIF89A_HEADER = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00]);
const WEBP_HEADER = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50,
]);

/** Builds a FileSystemPort stub whose only real method is readFileBytes. */
function fsWith(readFileBytes?: (path: string) => Promise<Uint8Array>): FileSystemPort {
  const port: Partial<FileSystemPort> = {};
  if (readFileBytes) port.readFileBytes = readFileBytes;
  return port as FileSystemPort;
}

describe("sniffImageMediaType", () => {
  it("identifies PNG magic", () => {
    expect(sniffImageMediaType(PNG_HEADER)).toBe("image/png");
  });

  it("identifies JPEG magic", () => {
    expect(sniffImageMediaType(JPEG_HEADER)).toBe("image/jpeg");
  });

  it("identifies GIF87a and GIF89a magic", () => {
    expect(sniffImageMediaType(GIF87A_HEADER)).toBe("image/gif");
    expect(sniffImageMediaType(GIF89A_HEADER)).toBe("image/gif");
  });

  it("identifies WEBP (RIFF....WEBP) magic", () => {
    expect(sniffImageMediaType(WEBP_HEADER)).toBe("image/webp");
  });

  it("returns null for a truncated (<12 byte) header without crashing", () => {
    expect(sniffImageMediaType(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00]))).toBeNull();
    expect(sniffImageMediaType(new Uint8Array([]))).toBeNull();
    expect(sniffImageMediaType(new Uint8Array([0x89]))).toBeNull();
  });

  it("returns null for a RIFF container that is not WEBP", () => {
    // "RIFF....WAVE" — RIFF but the wrong four-cc at bytes 8-11.
    const wave = Buffer.from([
      0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
    ]);
    expect(sniffImageMediaType(wave)).toBeNull();
  });

  it("returns null for plain text bytes", () => {
    expect(sniffImageMediaType(Buffer.from("hello, world, not an image", "utf-8"))).toBeNull();
  });
});

describe("imageExtensionOf", () => {
  it("maps each known extension case-insensitively", () => {
    expect(imageExtensionOf("a.png")).toBe("image/png");
    expect(imageExtensionOf("a.PNG")).toBe("image/png");
    expect(imageExtensionOf("a.jpg")).toBe("image/jpeg");
    expect(imageExtensionOf("a.jpeg")).toBe("image/jpeg");
    expect(imageExtensionOf("a.gif")).toBe("image/gif");
    expect(imageExtensionOf("dir/deep/photo.webp")).toBe("image/webp");
  });

  it("returns null for a non-image extension or no extension", () => {
    expect(imageExtensionOf("notes.txt")).toBeNull();
    expect(imageExtensionOf("README")).toBeNull();
  });

  it("IMAGE_EXTENSIONS covers the five canonical spellings", () => {
    expect([...IMAGE_EXTENSIONS.keys()].sort()).toEqual([".gif", ".jpeg", ".jpg", ".png", ".webp"]);
  });
});

describe("loadImageAttachment", () => {
  it("fails when the port has no readFileBytes", async () => {
    const result = await loadImageAttachment(fsWith(undefined), "x.png");
    expect(result).toEqual({ ok: false, reason: "binary read unavailable on this filesystem port" });
  });

  it("returns the read error reason verbatim", async () => {
    const result = await loadImageAttachment(
      fsWith(async () => {
        throw new Error("ENOENT: no such file or directory, open 'x.png'");
      }),
      "x.png",
    );
    expect(result).toEqual({
      ok: false,
      reason: "ENOENT: no such file or directory, open 'x.png'",
    });
  });

  it("fails with a non-image reason when the bytes do not sniff", async () => {
    const result = await loadImageAttachment(
      fsWith(async () => Buffer.from("just some text", "utf-8")),
      "note.png",
    );
    expect(result).toEqual({ ok: false, reason: "not a supported image (png/jpeg/gif/webp)" });
  });

  it("encodes base64 and takes the mediaType from the sniff (magic wins over extension)", async () => {
    // JPEG bytes behind a .png path — the sniff must win.
    const result = await loadImageAttachment(fsWith(async () => JPEG_HEADER), "mislabeled.png");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.attachment.mediaType).toBe("image/jpeg");
      expect(result.attachment.data).toBe(JPEG_HEADER.toString("base64"));
      expect(result.attachment.sourcePath).toBe("mislabeled.png");
      expect(result.rawBytes).toBe(JPEG_HEADER.length);
      // base64 round-trips back to the original bytes.
      expect(Buffer.from(result.attachment.data, "base64").equals(JPEG_HEADER)).toBe(true);
    }
  });

  it("rejects a file over IMAGE_MAX_BYTES with an honest reason and zero attach", async () => {
    const oversize = Buffer.alloc(IMAGE_MAX_BYTES + 1);
    // Give it a real PNG header so the failure is cap-driven, not sniff-driven.
    PNG_HEADER.copy(oversize, 0);
    const result = await loadImageAttachment(fsWith(async () => oversize), "big.png");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain(String(IMAGE_MAX_BYTES));
      expect(result.reason).toContain(String(oversize.length));
    }
  });
});
