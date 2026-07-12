/**
 * Shared UTF-8 byte cap (Phase 3 slice 3.3, design §2.9). Extracted from the
 * subagent runner's private `capOutputBytes` so skills (§3.3) and agent profiles
 * (§3.5) reuse the SAME truncation semantics; the runner now delegates here, and
 * its own tests are the byte-identity proof.
 */

/**
 * Caps `text` to `maxBytes` UTF-8 bytes, dropping any trailing partial multibyte
 * sequence, and reports whether truncation happened. Mirrors the WebFetch/3.1
 * output-cap precedent.
 */
export function capUtf8Bytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const encoded = new TextEncoder().encode(text);
  if (encoded.length <= maxBytes) {
    return { text, truncated: false };
  }
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(encoded.slice(0, maxBytes));
  // A trailing partial char decodes to U+FFFD; strip it so we never emit a
  // replacement glyph the model would read as content.
  const clean = decoded.endsWith("�") ? decoded.slice(0, -1) : decoded;
  return { text: clean, truncated: true };
}
