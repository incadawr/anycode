/**
 * JSON-RPC / LSP byte-framing codec (slice 6.1 B1). Pure module — no processes,
 * no imports beyond the message-size cap constant.
 *
 * Framing per the LSP base protocol: each message is `Content-Length: N\r\n\r\n`
 * (optionally preceded/followed by other header lines such as `Content-Type`)
 * followed by exactly N bytes of a UTF-8 JSON body. The decoder is byte-counted
 * end to end: it accumulates raw Buffers and slices the body by byte length, so a
 * multi-byte UTF-8 sequence split across chunk boundaries is reassembled intact

 *

 * Content-Length above LSP_MESSAGE_MAX_BYTES, a header region with no terminator
 * within MAX_HEADER_BYTES, a missing/garbage Content-Length, or a non-JSON body
 * all fire `onError` once and mark the decoder dead — the cap is checked at
 * header-parse time, BEFORE any body allocation, so a hostile `Content-Length:
 * 100MB` never allocates 100MB.
 */

import { LSP_MESSAGE_MAX_BYTES } from "../types/config.js";

/** Cap on the header region (up to and including the `\r\n\r\n`); LSP headers are tiny, so a header this large is a hostile/garbage stream. */
const MAX_HEADER_BYTES = 65_536;

const HEADER_TERMINATOR = "\r\n\r\n";

/** Serializes `message` into a single framed Buffer (`Content-Length` header + UTF-8 JSON body). */
export function encodeMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf-8");
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii");
  return Buffer.concat([header, body]);
}

/**
 * Parses the raw header block (text before the `\r\n\r\n`). Tolerant of extra
 * lines (`Content-Type`) and header-name case. Returns the declared body length,
 * or null when there is no valid non-negative integer `Content-Length`.
 */
function parseContentLength(headerText: string): number | null {
  for (const line of headerText.split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    if (line.slice(0, colon).trim().toLowerCase() !== "content-length") continue;
    const value = line.slice(colon + 1).trim();
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed >= 0) return parsed;
    return null;
  }
  return null;
}

/**
 * Incremental frame decoder. `feed` accepts arbitrary raw Buffer chunks and
 * invokes `onMessage` once per complete framed message (parsed JSON) and
 * `onError` at most once on the first protocol violation, after which the
 * decoder is permanently dead (later `feed` calls are no-ops).
 */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  private expectedLength: number | null = null;
  private dead = false;

  constructor(
    private readonly onMessage: (message: unknown) => void,
    private readonly onError: (error: Error) => void,
  ) {}

  /** True once a protocol error has killed the decoder. */
  get isDead(): boolean {
    return this.dead;
  }

  feed(chunk: Buffer): void {
    if (this.dead) return;
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    this.drain();
  }

  private fail(error: Error): void {
    if (this.dead) return;
    this.dead = true;
    this.buffer = Buffer.alloc(0);
    this.expectedLength = null;
    this.onError(error);
  }

  private drain(): void {
    while (!this.dead) {
      if (this.expectedLength === null) {
        const headerEnd = this.buffer.indexOf(HEADER_TERMINATOR);
        if (headerEnd === -1) {
          // Header not yet complete. Guard against an endless header stream.
          if (this.buffer.length > MAX_HEADER_BYTES) {
            this.fail(new Error(`LSP header exceeded ${MAX_HEADER_BYTES} bytes with no terminator`));
          }
          return;
        }
        const headerText = this.buffer.subarray(0, headerEnd).toString("ascii");
        const contentLength = parseContentLength(headerText);
        if (contentLength === null) {
          this.fail(new Error(`LSP frame has no valid Content-Length header: ${JSON.stringify(headerText)}`));
          return;
        }

        // is rejected on the header alone, never by buffering the declared bytes.
        if (contentLength > LSP_MESSAGE_MAX_BYTES) {
          this.fail(
            new Error(`LSP message Content-Length ${contentLength} exceeds cap ${LSP_MESSAGE_MAX_BYTES}`),
          );
          return;
        }
        this.expectedLength = contentLength;
        this.buffer = this.buffer.subarray(headerEnd + HEADER_TERMINATOR.length);
      }

      if (this.buffer.length < this.expectedLength) return;

      const body = this.buffer.subarray(0, this.expectedLength);
      this.buffer = this.buffer.subarray(this.expectedLength);
      this.expectedLength = null;

      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString("utf-8"));
      } catch (error) {
        this.fail(new Error(`LSP frame body is not valid JSON: ${error instanceof Error ? error.message : String(error)}`));
        return;
      }
      this.onMessage(parsed);
    }
  }
}
