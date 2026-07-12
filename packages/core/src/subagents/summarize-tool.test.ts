/**
 * summarizeChildToolCall unit tests (slice P7.18/F16b). Pure helper: proves the
 * per-tool subject extraction and the hard 160-char cap that keeps raw child
 * input off the parent activity stream.
 */

import { describe, expect, it } from "vitest";
import {
  SUBAGENT_ACTIVITY_SUMMARY_MAX_CHARS,
  summarizeChildToolCall,
} from "./summarize-tool.js";

describe("summarizeChildToolCall", () => {
  it("Bash → first non-empty line of command", () => {
    expect(summarizeChildToolCall("Bash", { command: "npm run build" })).toBe("npm run build");
    // Multi-line command collapses to the first meaningful line.
    expect(summarizeChildToolCall("Bash", { command: "\n\n  ls -la  \nrm x" })).toBe("ls -la");
  });

  it("Read/Write/Edit → file_path", () => {
    expect(summarizeChildToolCall("Read", { file_path: "/a/b.ts" })).toBe("/a/b.ts");
    expect(summarizeChildToolCall("Write", { file_path: "/a/c.ts", content: "x" })).toBe("/a/c.ts");
    expect(summarizeChildToolCall("Edit", { file_path: "/a/d.ts" })).toBe("/a/d.ts");
  });

  it("Grep/Glob → pattern", () => {
    expect(summarizeChildToolCall("Grep", { pattern: "TODO" })).toBe("TODO");
    expect(summarizeChildToolCall("Glob", { pattern: "src/**/*.ts" })).toBe("src/**/*.ts");
  });

  it("Agent → description", () => {
    expect(summarizeChildToolCall("Agent", { description: "explore the repo", prompt: "p" })).toBe(
      "explore the repo",
    );
  });

  it("TodoWrite → in-progress subject + done/total", () => {
    const todos = [
      { content: "step one", status: "completed" },
      { content: "step two", status: "in_progress" },
      { content: "step three", status: "pending" },
    ];
    expect(summarizeChildToolCall("TodoWrite", { todos })).toBe("step two 1/3");
  });

  it("TodoWrite with no in-progress item → just done/total counts", () => {
    const todos = [
      { content: "a", status: "completed" },
      { content: "b", status: "completed" },
    ];
    expect(summarizeChildToolCall("TodoWrite", { todos })).toBe("2/2");
  });

  it("fallback (unknown tool) → empty string (tool name alone shown by the UI)", () => {
    expect(summarizeChildToolCall("WebFetch", { url: "https://x" })).toBe("");
    expect(summarizeChildToolCall("TodoRead", {})).toBe("");
  });

  it("missing / malformed input never throws and yields empty", () => {
    expect(summarizeChildToolCall("Bash", {})).toBe("");
    expect(summarizeChildToolCall("Read", null)).toBe("");
    expect(summarizeChildToolCall("Grep", "not-an-object")).toBe("");
    expect(summarizeChildToolCall("TodoWrite", { todos: "nope" })).toBe("");
  });

  it("hard-caps the summary at ~160 chars, never shipping raw child input", () => {
    const long = "x".repeat(500);
    const out = summarizeChildToolCall("Bash", { command: long });
    expect(out.length).toBe(SUBAGENT_ACTIVITY_SUMMARY_MAX_CHARS);
    expect(out.endsWith("…")).toBe(true);
    expect(SUBAGENT_ACTIVITY_SUMMARY_MAX_CHARS).toBe(160);
  });

  // ---------------------------------------------------------------------------
  // W1-FIX (P3, hardening): control-byte sanitization + code-point-safe
  // truncation. Whitespace-only collapsing does not strip ESC/other C0-C1
  // control bytes, and a raw slice(0,159) can split a surrogate pair into an
  // invalid lone surrogate. Control bytes below are built via String.fromCharCode
  // (never typed as literal source bytes) so the test source itself stays clean.

  const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  function hasControlByte(s: string): boolean {
    for (const ch of s) {
      const code = ch.codePointAt(0) ?? 0;
      if ((code <= 0x1f) || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
        return true;
      }
    }
    return false;
  }

  it("strips C0 control bytes (incl. ESC) and C1 control bytes from the summary", () => {
    const ESC = String.fromCharCode(0x1b);
    const BEL = String.fromCharCode(0x07);
    const NUL = String.fromCharCode(0x00);
    // A raw terminal escape sequence from a Bash command must never reach the feed.
    const withControls = "echo " + ESC + "[31mred" + ESC + "[0m " + BEL + "bell" + NUL + "null";
    const out = summarizeChildToolCall("Bash", { command: withControls });
    expect(hasControlByte(out)).toBe(false);
    expect(out).toBe("echo [31mred [0m bell null");
  });

  it("strips a DEL byte and a C1 control byte from the summary", () => {
    const DEL = String.fromCharCode(0x7f);
    const C1 = String.fromCharCode(0x9b); // CSI in 8-bit form
    const withDelAndC1 = "a" + DEL + "b" + C1 + "c";
    const out = summarizeChildToolCall("Bash", { command: withDelAndC1 });
    expect(hasControlByte(out)).toBe(false);
    expect(out).toBe("a b c");
  });

  it("truncates on a code-point boundary — a surrogate pair straddling the cap is never split", () => {
    const astral = String.fromCodePoint(0x1f600); // one code point, TWO UTF-16 code units
    // 158 plain chars + the astral char lands the pair's code units at raw
    // string indices 158/159 — exactly where the OLD slice(0, 159) cut, which
    // would have kept the high surrogate and dropped the low one (invalid lone
    // surrogate). 50 trailing chars push the total well past the 160-char cap.
    const raw = "a".repeat(158) + astral + "b".repeat(50);
    const out = summarizeChildToolCall("Bash", { command: raw });

    expect(out.endsWith("…")).toBe(true);
    // No unpaired surrogate anywhere in the output.
    expect(LONE_SURROGATE_RE.test(out)).toBe(false);
    // The astral character survived intact (not split into a lone surrogate).
    expect(out).toContain(astral);
    // Exactly SUBAGENT_ACTIVITY_SUMMARY_MAX_CHARS - 1 code points before the
    // ellipsis: 158 'a's + the astral char counted as ONE code point.
    expect(Array.from(out.slice(0, -1)).length).toBe(SUBAGENT_ACTIVITY_SUMMARY_MAX_CHARS - 1);
  });
});
