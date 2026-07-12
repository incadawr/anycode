/**
 * jsonrpc.test.ts (slice 6.1 B7, pure): byte-framing round-trip and the
 * decoder's hostile-input survival — chunk boundaries mid-multi-byte-UTF-8 and
 * mid-header, several messages coalesced in one chunk, the giant-header /
 * oversize Content-Length cap (fires before body allocation), and non-JSON /
 * malformed-header protocol death. No processes.
 */

import { describe, expect, it } from "vitest";
import { encodeMessage, FrameDecoder } from "./jsonrpc.js";
import { LSP_MESSAGE_MAX_BYTES } from "../types/config.js";

function collector(): { decoder: FrameDecoder; messages: unknown[]; errors: Error[] } {
  const messages: unknown[] = [];
  const errors: Error[] = [];
  const decoder = new FrameDecoder(
    (msg) => messages.push(msg),
    (err) => errors.push(err),
  );
  return { decoder, messages, errors };
}

describe("encodeMessage", () => {
  it("frames a message as Content-Length header + UTF-8 JSON body with the byte length", () => {
    const buf = encodeMessage({ jsonrpc: "2.0", method: "ping" });
    const text = buf.toString("utf-8");
    const [header, body] = text.split("\r\n\r\n") as [string, string];
    expect(header).toBe(`Content-Length: ${Buffer.byteLength('{"jsonrpc":"2.0","method":"ping"}', "utf-8")}`);
    expect(JSON.parse(body)).toEqual({ jsonrpc: "2.0", method: "ping" });
  });

  it("counts BYTES not characters for a multi-byte body", () => {
    const buf = encodeMessage({ text: "café→π" });
    const header = buf.toString("utf-8").split("\r\n\r\n")[0]!;
    const declared = Number(header.replace("Content-Length: ", ""));
    const bodyBytes = buf.length - Buffer.byteLength(`${header}\r\n\r\n`, "ascii");
    expect(declared).toBe(bodyBytes);
  });
});

describe("FrameDecoder — round-trip", () => {
  it("decodes a single whole message", () => {
    const { decoder, messages, errors } = collector();
    decoder.feed(encodeMessage({ id: 1, result: "ok" }));
    expect(messages).toEqual([{ id: 1, result: "ok" }]);
    expect(errors).toEqual([]);
  });

  it("decodes several messages coalesced in one chunk", () => {
    const { decoder, messages } = collector();
    const combined = Buffer.concat([
      encodeMessage({ id: 1 }),
      encodeMessage({ id: 2 }),
      encodeMessage({ id: 3 }),
    ]);
    decoder.feed(combined);
    expect(messages).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  it("reassembles a message split across a mid-HEADER boundary", () => {
    const { decoder, messages } = collector();
    const framed = encodeMessage({ method: "split/header" });
    // Cut in the middle of the "Content-Length" header line.
    decoder.feed(framed.subarray(0, 8));
    expect(messages).toEqual([]);
    decoder.feed(framed.subarray(8));
    expect(messages).toEqual([{ method: "split/header" }]);
  });

  it("reassembles a message split mid-multi-byte-UTF-8 (byte-counted, no string corruption)", () => {
    const { decoder, messages } = collector();
    const framed = encodeMessage({ text: "snow☃café" });
    // Split at every single byte to stress multi-byte-boundary reassembly.
    for (let i = 0; i < framed.length; i++) {
      decoder.feed(framed.subarray(i, i + 1));
    }
    expect(messages).toEqual([{ text: "snow☃café" }]);
  });

  it("is tolerant of an extra Content-Type header line", () => {
    const { decoder, messages, errors } = collector();
    const body = Buffer.from(JSON.stringify({ ok: true }), "utf-8");
    const framed = Buffer.concat([
      Buffer.from(
        `Content-Length: ${body.length}\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n`,
        "ascii",
      ),
      body,
    ]);
    decoder.feed(framed);
    expect(messages).toEqual([{ ok: true }]);
    expect(errors).toEqual([]);
  });
});

describe("FrameDecoder — protocol death", () => {
  it("rejects an oversize Content-Length via the cap and dies, WITHOUT buffering the declared body", () => {
    const { decoder, messages, errors } = collector();
    // Only the header is fed — no 100MB body. The cap must fire on the header alone.
    decoder.feed(Buffer.from(`Content-Length: ${LSP_MESSAGE_MAX_BYTES + 1}\r\n\r\n`, "ascii"));
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/exceeds cap/);
    expect(decoder.isDead).toBe(true);
    expect(messages).toEqual([]);
    // Dead decoder ignores further input.
    decoder.feed(encodeMessage({ id: 1 }));
    expect(messages).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it("rejects a header with no Content-Length", () => {
    const { decoder, errors } = collector();
    decoder.feed(Buffer.from("Content-Type: text/plain\r\n\r\n{}", "ascii"));
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/no valid Content-Length/);
    expect(decoder.isDead).toBe(true);
  });

  it("rejects a garbage header with no colon lines", () => {
    const { decoder, errors } = collector();
    decoder.feed(Buffer.from("!!!garbage!!!\r\n\r\nbody", "ascii"));
    expect(errors).toHaveLength(1);
    expect(decoder.isDead).toBe(true);
  });

  it("rejects a well-framed but non-JSON body", () => {
    const { decoder, messages, errors } = collector();
    const body = Buffer.from("this is not json", "utf-8");
    decoder.feed(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]));
    expect(messages).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/not valid JSON/);
    expect(decoder.isDead).toBe(true);
  });

  it("dies on an endless header stream with no terminator", () => {
    const { decoder, errors } = collector();
    // Feed >64KB of header bytes with no \r\n\r\n.
    decoder.feed(Buffer.alloc(70_000, 0x41)); // 'A' repeated
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/header exceeded/);
    expect(decoder.isDead).toBe(true);
  });
});
