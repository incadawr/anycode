/**
 * Model-visible result budget (TASK.93). Every tool result crosses exactly one
 * of these before it reaches the model, so a tool that declares nothing still
 * cannot put an unbounded payload into the request.
 *
 * Two properties the old `capText` lacked and the model depends on:
 *   - the budget is in UTF-8 bytes, measured the way the wire measures them
 *     (`capUtf8Bytes`), not in UTF-16 code units;
 *   - the truncation notice is paid for OUT of the budget, not appended past
 *     it, so the returned text really fits the declared number.
 */

import { capUtf8Bytes } from "./bytes.js";

export type ResultPreviewDirection = "head" | "tail";

/**
 * Keeps the last `maxBytes` UTF-8 bytes, starting at a code-point boundary.
 *
 * The boundary is found in the byte array rather than by decoding and stripping
 * a replacement glyph: a cut inside a 4-byte character leaves up to three stray
 * continuation bytes, and a lenient decoder turns EACH of them into its own
 * U+FFFD — three bytes apiece. Stripping one would still hand the model
 * replacement glyphs as content AND push the result past the byte cap. Skipping
 * forward to the next lead byte can only shrink the slice, never grow it.
 */
function capUtf8BytesTail(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const encoded = new TextEncoder().encode(text);
  if (encoded.length <= maxBytes) {
    return { text, truncated: false };
  }
  let start = encoded.length - maxBytes;
  while (start < encoded.length && ((encoded[start] ?? 0) & 0b1100_0000) === 0b1000_0000) {
    start += 1;
  }
  return { text: new TextDecoder("utf-8").decode(encoded.subarray(start)), truncated: true };
}

function fitUtf8(
  text: string,
  maxBytes: number,
  direction: ResultPreviewDirection,
): { text: string; truncated: boolean } {
  if (maxBytes <= 0) return { text: "", truncated: true };
  return direction === "tail" ? capUtf8BytesTail(text, maxBytes) : capUtf8Bytes(text, maxBytes);
}

/**
 * Notice appended to a truncated result. All three numbers are known before
 * fitting, which is what keeps the notice a fixed cost rather than a value that
 * depends on its own length.
 */
function truncationNotice(
  originalBytes: number,
  maxModelBytes: number,
  direction: ResultPreviewDirection,
): string {
  const kept = direction === "tail" ? "the tail" : "the head";
  return `\n\n[tool output truncated: ${originalBytes} bytes total, budget ${maxModelBytes} bytes, kept ${kept}]`;
}

/**
 * Fits `text` into `maxModelBytes` UTF-8 bytes. Text that already fits is
 * returned byte-identical. Otherwise the notice is reserved from the budget
 * first and the remainder is filled from the requested end of the payload; the
 * notice always trails, including in "tail" mode.
 */
export function applyResultBudget(
  text: string,
  maxModelBytes: number,
  direction: ResultPreviewDirection = "head",
): string {
  const originalBytes = Buffer.byteLength(text, "utf8");
  if (originalBytes <= maxModelBytes) return text;

  const notice = fitUtf8(
    truncationNotice(originalBytes, maxModelBytes, direction),
    maxModelBytes,
    "head",
  ).text;
  const remaining = maxModelBytes - Buffer.byteLength(notice, "utf8");
  if (remaining <= 0) return notice;

  return `${fitUtf8(text, remaining, direction).text}${notice}`;
}

/**
 * Preview of `text` for the artifact envelope (TASK.94): at most `maxBytes`
 * UTF-8 bytes taken from the requested end, snapped to a line boundary.
 *
 * Two cuts, in this order. The byte cut comes from applyResultBudget's own
 * helpers, so a preview can never split a code point. The line snap is then
 * cosmetic-but-load-bearing: a preview that begins or ends mid-line reads as
 * corrupted data rather than as an excerpt, and the model has no way to tell
 * the difference. The snap is SKIPPED when the nearest boundary would cost more
 * than half the preview — a payload with very long lines (a minified bundle,
 * one-line JSON) would otherwise snap away to nothing, and half a line of real
 * content beats an empty preview.
 *
 * Text that already fits is returned byte-identical, boundary or not: there is
 * nothing to signal, because nothing was cut.
 */
export function previewFirstChars(
  text: string,
  maxBytes: number,
  direction: ResultPreviewDirection = "head",
): string {
  const fitted = fitUtf8(text, maxBytes, direction);
  if (!fitted.truncated) return fitted.text;

  const kept = fitted.text;
  if (direction === "tail") {
    // A tail preview was cut at its START, so the first line is the partial one.
    const boundary = kept.indexOf("\n");
    return boundary >= 0 && boundary <= kept.length / 2 ? kept.slice(boundary + 1) : kept;
  }
  const boundary = kept.lastIndexOf("\n");
  return boundary >= kept.length / 2 ? kept.slice(0, boundary) : kept;
}
