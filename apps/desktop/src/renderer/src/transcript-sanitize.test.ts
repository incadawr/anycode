import { describe, expect, it } from "vitest";
import { stripReminderBlocks } from "./transcript-sanitize.js";

describe("stripReminderBlocks", () => {
  it("strips a single system-reminder block", () => {
    expect(stripReminderBlocks("hello\n<system-reminder>ignored</system-reminder>")).toBe("hello");
  });

  it("strips a single hook-context block", () => {
    expect(stripReminderBlocks("hello\n<hook-context>ignored</hook-context>")).toBe("hello");
  });

  it("strips a single plan-mode-reminder block", () => {
    expect(stripReminderBlocks("hello\n<plan-mode-reminder>ignored</plan-mode-reminder>")).toBe("hello");
  });

  it("strips multiple blocks independently", () => {
    const text =
      "before\n<system-reminder>one</system-reminder>\nmiddle\n<hook-context>two</hook-context>\nafter";
    expect(stripReminderBlocks(text)).toBe("before\nmiddle\nafter");
  });

  it("strips a block in the middle of text, preserving surroundings", () => {
    expect(stripReminderBlocks("start\n<system-reminder>x</system-reminder> end")).toBe("start end");
  });

  it("returns empty string when the whole message is a single reminder block", () => {
    expect(stripReminderBlocks("<system-reminder>only content</system-reminder>")).toBe("");
  });

  it("leaves an unclosed/unpaired tag untouched", () => {
    const text = "hello <system-reminder>never closed";
    expect(stripReminderBlocks(text)).toBe(text);
  });

  it("does not special-case nested identical tags (non-greedy cuts at first close)", () => {
    const text = "<system-reminder>outer<system-reminder>inner</system-reminder>tail</system-reminder>";
    expect(stripReminderBlocks(text)).toBe("tail</system-reminder>");
  });

  it("leaves a tag with attributes untouched", () => {
    const text = "hello <system-reminder foo=\"bar\">content</system-reminder> world";
    expect(stripReminderBlocks(text)).toBe(text);
  });

  it("strips all three known tags in one message", () => {
    const text =
      "<system-reminder>a</system-reminder>\n<hook-context>b</hook-context>\n<plan-mode-reminder>c</plan-mode-reminder>done";
    expect(stripReminderBlocks(text)).toBe("done");
  });

  it("passes plain text without tags through byte-for-byte", () => {
    const text = "just a normal message, nothing to strip.";
    expect(stripReminderBlocks(text)).toBe(text);
  });

  it("passes multiline text without tags through byte-for-byte", () => {
    const text = "line one\nline two\n\nline four";
    expect(stripReminderBlocks(text)).toBe(text);
  });

  it("passes text with emoji and whitespace through byte-for-byte", () => {
    const text = "  hi \u{1F600} there   \n\t trailing whitespace \n";
    expect(stripReminderBlocks(text)).toBe(text);
  });

  it("passes whitespace-only text through byte-for-byte", () => {
    const text = "   \n\t  \n";
    expect(stripReminderBlocks(text)).toBe(text);
  });

  it("consumes exactly one leading newline separator before a tag", () => {
    expect(stripReminderBlocks("a\n\n<system-reminder>x</system-reminder>")).toBe("a\n");
  });

  it("handles cross-tag malformed nesting per the core tag processing order", () => {
    const text = "<hook-context><system-reminder></hook-context></system-reminder>";
    // hook-context is processed first and greedily pairs with the first
    // </hook-context> it finds, regardless of the system-reminder tag in
    // between; the leftover </system-reminder> has no matching opener.
    expect(stripReminderBlocks(text)).toBe("</system-reminder>");
  });

  it("strips ~200KB of unpaired reminder tags in well under a second (no quadratic blowup)", () => {
    const chunk = "<system-reminder>".repeat(2000);
    const text = `prefix ${chunk} suffix`;
    const start = performance.now();
    const result = stripReminderBlocks(text);
    const elapsed = performance.now() - start;
    expect(result).toBe(text);
    expect(elapsed).toBeLessThan(5000);
  });
});
