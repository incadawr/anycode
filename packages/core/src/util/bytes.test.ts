/**
 * capUtf8Bytes unit tests (Phase 3 slice 3.3, design §2.9). Pins the shared
 * UTF-8 cap the subagent runner delegates to and skills/profiles reuse.
 */

import { describe, expect, it } from "vitest";
import { capUtf8Bytes } from "./bytes.js";

const byteLen = (s: string): number => new TextEncoder().encode(s).length;

describe("capUtf8Bytes", () => {
  it("returns the text unchanged when it fits (truncated=false)", () => {
    const result = capUtf8Bytes("hello", 5);
    expect(result).toEqual({ text: "hello", truncated: false });
  });

  it("treats an exact-fit ASCII string as untruncated", () => {
    const text = "a".repeat(100);
    expect(capUtf8Bytes(text, 100)).toEqual({ text, truncated: false });
  });

  it("truncates ASCII past the cap and sets truncated", () => {
    const result = capUtf8Bytes("a".repeat(101), 100);
    expect(result.truncated).toBe(true);
    expect(result.text).toBe("a".repeat(100));
    expect(byteLen(result.text)).toBe(100);
  });

  it("empty string is never truncated", () => {
    expect(capUtf8Bytes("", 0)).toEqual({ text: "", truncated: false });
  });

  it("drops a trailing partial multibyte sequence rather than emitting U+FFFD", () => {
    // "é" (U+00E9) is 2 bytes in UTF-8. A cap of 1 byte lands mid-character.
    const result = capUtf8Bytes("é", 1);
    expect(result.truncated).toBe(true);
    expect(result.text).toBe("");
    expect(result.text.includes("�")).toBe(false);
  });

  it("keeps whole multibyte characters that fully fit and drops the split one", () => {
    // Each "€" (U+20AC) is 3 UTF-8 bytes. Cap of 4 keeps one whole euro, then a
    // 1-byte remnant of the second euro is dropped (no replacement glyph).
    const result = capUtf8Bytes("€€", 4);
    expect(result.truncated).toBe(true);
    expect(result.text).toBe("€");
    expect(result.text.includes("�")).toBe(false);
    expect(byteLen(result.text)).toBe(3);
  });

  it("multibyte content within the cap is preserved verbatim", () => {
    const text = "héllo €";
    expect(capUtf8Bytes(text, byteLen(text))).toEqual({ text, truncated: false });
  });
});
