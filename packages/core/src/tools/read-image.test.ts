/**

 * identity (same metadata OBJECT / same inputSchema as the inner Read),
 * byte-equivalent delegation on every non-image path, the fail-closed
 * capability gate (explicit error + zero images), the per-image byte cap, and
 * sniff-authoritative routing (magic beats extension).
 */

import { describe, expect, it } from "vitest";
import type { ToolContext } from "../types/tools.js";
import type { CorePorts } from "../ports/index.js";
import type { MediaCapabilityPort } from "../ports/media.js";
import { IMAGE_MAX_BYTES } from "../types/config.js";
import { readTool } from "./read.js";
import { imageCapableReadTool } from "./read-image.js";

// Real magic-byte payloads (design §2-A7).
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 5, 6, 7, 8]);
const TRUNCATED_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a]); // 7 bytes
const TEXT_BYTES = new TextEncoder().encode("hello\nworld\nthird line");

const mediaOn: MediaCapabilityPort = { imageInputEnabled: () => true };
const mediaOff: MediaCapabilityPort = { imageInputEnabled: () => false };

function makeFs(files: Record<string, Uint8Array>, opts?: { withBytes?: boolean }) {
  const fs: Record<string, unknown> = {
    readFile: async (p: string) => {
      const b = files[p];
      if (b === undefined) throw new Error(`ENOENT: ${p}`);
      return Buffer.from(b).toString("utf-8");
    },
  };
  if (opts?.withBytes !== false) {
    fs.readFileBytes = async (p: string) => {
      const b = files[p];
      if (b === undefined) throw new Error(`ENOENT: ${p}`);
      return b;
    };
  }
  return fs;
}

function ctxFor(
  files: Record<string, Uint8Array>,
  opts?: { media?: MediaCapabilityPort; withBytes?: boolean },
): ToolContext {
  return {
    toolCallId: "t1",
    abortSignal: new AbortController().signal,
    cwd: "/work",
    ports: { fs: makeFs(files, { withBytes: opts?.withBytes }) } as unknown as CorePorts,
    ...(opts?.media ? { media: opts.media } : {}),
  };
}

describe("imageCapableReadTool — R5 identity", () => {
  it("shares the exact metadata OBJECT and inputSchema of the inner Read", () => {
    expect(imageCapableReadTool.metadata).toBe(readTool.metadata);
    expect(imageCapableReadTool.inputSchema).toBe(readTool.inputSchema);
  });
});

describe("imageCapableReadTool — delegation is byte-equivalent to the inner Read", () => {
  it("delegates a non-image extension (media on)", async () => {
    const files = { "/work/a.txt": TEXT_BYTES };
    const input = { file_path: "/work/a.txt" };
    const wrapped = await imageCapableReadTool.handler(input, ctxFor(files, { media: mediaOn }));
    const inner = await readTool.handler(input, ctxFor(files, { media: mediaOn }));
    expect(wrapped).toEqual(inner);
    expect(wrapped.images).toBeUndefined();
  });

  it("delegates a real PNG under a .txt extension (image path never activates)", async () => {
    const files = { "/work/secret.txt": PNG_BYTES };
    const input = { file_path: "/work/secret.txt" };
    const wrapped = await imageCapableReadTool.handler(input, ctxFor(files, { media: mediaOn }));
    const inner = await readTool.handler(input, ctxFor(files, { media: mediaOn }));
    expect(wrapped).toEqual(inner);
    expect(wrapped.images).toBeUndefined();
  });

  it("delegates when the filesystem port has no readFileBytes (fail-soft)", async () => {
    const files = { "/work/shot.png": PNG_BYTES };
    const input = { file_path: "/work/shot.png" };
    const wrapped = await imageCapableReadTool.handler(
      input,
      ctxFor(files, { media: mediaOn, withBytes: false }),
    );
    const inner = await readTool.handler(input, ctxFor(files, { withBytes: false }));
    expect(wrapped).toEqual(inner);
    expect(wrapped.images).toBeUndefined();
  });

  it("delegates text under a .png extension (sniff wins, today's behavior)", async () => {
    const files = { "/work/note.png": TEXT_BYTES };
    const input = { file_path: "/work/note.png" };
    const wrapped = await imageCapableReadTool.handler(input, ctxFor(files, { media: mediaOn }));
    const inner = await readTool.handler(input, ctxFor(files, { media: mediaOn }));
    expect(wrapped).toEqual(inner);
    expect(wrapped.images).toBeUndefined();
  });

  it("delegates a truncated 7-byte PNG header without crashing", async () => {
    const files = { "/work/trunc.png": TRUNCATED_PNG };
    const input = { file_path: "/work/trunc.png" };
    const wrapped = await imageCapableReadTool.handler(input, ctxFor(files, { media: mediaOn }));
    const inner = await readTool.handler(input, ctxFor(files, { media: mediaOn }));
    expect(wrapped).toEqual(inner);
    expect(wrapped.images).toBeUndefined();
  });

  it("returns the inner Read error shape on a read failure", async () => {
    const input = { file_path: "/work/missing.png" };
    const wrapped = await imageCapableReadTool.handler(input, ctxFor({}, { media: mediaOn }));
    const inner = await readTool.handler(input, ctxFor({}, { media: mediaOn }));
    expect(wrapped).toEqual(inner);
    expect(wrapped.ok).toBe(false);
    expect(wrapped.images).toBeUndefined();
  });
});

describe("imageCapableReadTool — capability gate (fail-closed, poison-proof)", () => {
  it("refuses with an explicit override-naming error and ZERO images when the model is not image-capable", async () => {
    const files = { "/work/shot.png": PNG_BYTES };
    const result = await imageCapableReadTool.handler(
      { file_path: "/work/shot.png" },
      ctxFor(files, { media: mediaOff }),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("image-capable");
    expect(result.error).toContain("ANYCODE_IMAGE_INPUT");
    expect(result.images).toBeUndefined();
  });

  it("refuses when no MediaCapabilityPort is present at all (absence = fail-closed lock)", async () => {
    const files = { "/work/shot.png": PNG_BYTES };
    const result = await imageCapableReadTool.handler(
      { file_path: "/work/shot.png" },
      ctxFor(files),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("ANYCODE_IMAGE_INPUT");
    expect(result.images).toBeUndefined();
  });
});

describe("imageCapableReadTool — attach path", () => {
  it("attaches a real PNG with a ReadOutput-shaped placeholder and base64 round-trip", async () => {
    const files = { "/work/shot.png": PNG_BYTES };
    const result = await imageCapableReadTool.handler(
      { file_path: "/work/shot.png" },
      ctxFor(files, { media: mediaOn }),
    );
    expect(result.ok).toBe(true);
    expect(result.output).toMatchObject({ totalLines: 0, truncated: false });
    expect(result.output?.content).toContain("shot.png");
    expect(result.output?.content).toContain("image/png");
    expect(result.output?.content).toContain("attached");
    expect(result.images).toHaveLength(1);
    const [img] = result.images!;
    expect(img!.mediaType).toBe("image/png");
    expect(img!.sourcePath).toBe("/work/shot.png");
    // Sniff authoritative; base64 decodes byte-for-byte back to the source.
    expect(new Uint8Array(Buffer.from(img!.data, "base64"))).toEqual(PNG_BYTES);
  });

  it("routes by sniff, not extension: JPEG bytes under a .png name attach as image/jpeg", async () => {
    const files = { "/work/mislabeled.png": JPEG_BYTES };
    const result = await imageCapableReadTool.handler(
      { file_path: "/work/mislabeled.png" },
      ctxFor(files, { media: mediaOn }),
    );
    expect(result.ok).toBe(true);
    expect(result.images![0]!.mediaType).toBe("image/jpeg");
    expect(result.output?.content).toContain("image/jpeg");
  });
});

describe("imageCapableReadTool — byte cap", () => {
  it("rejects a file over IMAGE_MAX_BYTES with an explicit size+limit error and zero images", async () => {
    const oversized = new Uint8Array(IMAGE_MAX_BYTES + 1);
    oversized.set(PNG_BYTES.slice(0, 8), 0); // real PNG magic, over the cap
    const files = { "/work/huge.png": oversized };
    const result = await imageCapableReadTool.handler(
      { file_path: "/work/huge.png" },
      ctxFor(files, { media: mediaOn }),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain(String(oversized.length));
    expect(result.error).toContain(String(IMAGE_MAX_BYTES));
    expect(result.images).toBeUndefined();
  });
});
