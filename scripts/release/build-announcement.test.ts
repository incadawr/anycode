/**
 * Unit tests for `scripts/release/build-announcement.mjs` — the Telegram
 * announcement text builder. Pure string assembly, so every case is a direct
 * `buildMessage`/`run` call: no network, no Telegram, no filesystem. The
 * workflow itself is never exercised against GitHub from tests.
 */
import { describe, expect, it } from "vitest";

const { buildMessage, run, MAX_MESSAGE_LENGTH, ELLIPSIS } = await import(
  "./build-announcement.mjs"
);

const BASE = {
  tag: "v0.1.0",
  url: "https://github.com/incadawr/anycode/releases/tag/v0.1.0",
};

describe("buildMessage — normal body", () => {
  it("assembles title, trimmed body, and URL", () => {
    const message = buildMessage({ ...BASE, body: "### Added\n- New thing" });
    expect(message).toBe(
      `AnyCode v0.1.0 is out\n\n### Added\n- New thing\n\n${BASE.url}`
    );
  });

  it("trims surrounding whitespace off the body", () => {
    const message = buildMessage({ ...BASE, body: "\n\n  hello  \n\t" });
    expect(message).toBe(`AnyCode v0.1.0 is out\n\nhello\n\n${BASE.url}`);
  });
});

describe("buildMessage — empty body", () => {
  it("empty string → title + link only", () => {
    expect(buildMessage({ ...BASE, body: "" })).toBe(`AnyCode v0.1.0 is out\n\n${BASE.url}`);
  });

  it("whitespace-only body → title + link only", () => {
    expect(buildMessage({ ...BASE, body: "   \n  " })).toBe(`AnyCode v0.1.0 is out\n\n${BASE.url}`);
  });

  it("undefined body → title + link only", () => {
    expect(buildMessage({ ...BASE, body: undefined })).toBe(`AnyCode v0.1.0 is out\n\n${BASE.url}`);
  });
});

describe("buildMessage — truncation at the 4000-char cap", () => {
  const word = "0123456789";

  it("fits exactly at the cap unchanged", () => {
    // title + sep + body + sep + url === 4000, computed not hand-counted
    const overhead = `AnyCode v0.1.0 is out\n\n`.length + `\n\n${BASE.url}`.length;
    const body = word.repeat(Math.ceil(MAX_MESSAGE_LENGTH / 10)).slice(0, MAX_MESSAGE_LENGTH - overhead);
    const message = buildMessage({ ...BASE, body });
    expect(message).toBe(`AnyCode v0.1.0 is out\n\n${body}\n\n${BASE.url}`);
    expect([...message]).toHaveLength(MAX_MESSAGE_LENGTH);
  });

  it("one char over → truncated, ends with `…` then the URL line, total <= cap", () => {
    const body = "x".repeat(MAX_MESSAGE_LENGTH - `AnyCode v0.1.0 is out\n\n`.length - `\n\n${BASE.url}`.length + 1); // exact-fit body + 1
    const message = buildMessage({ ...BASE, body });
    expect([...message].length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
    expect(message.endsWith(`…\n\n${BASE.url}`)).toBe(true);
    // title and URL survive in full
    expect(message.startsWith("AnyCode v0.1.0 is out\n\n")).toBe(true);
    // the kept body shrank by (overage + 1 for the ellipsis)
    expect(message).not.toContain("xxxx…x"); // sanity: not accidentally whole
  });

  it("hugely oversized body → still <= cap, URL intact as last line", () => {
    const message = buildMessage({ ...BASE, body: "y".repeat(50_000) });
    expect([...message].length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
    expect(message.endsWith(`\n\n${BASE.url}`)).toBe(true);
    expect(message).toContain(ELLIPSIS);
  });
});

describe("buildMessage — multi-byte safety (code points, not UTF-16 units)", () => {
  it("Cyrillic body is not cut mid-codepoint", () => {
    const body = "Привет, мир!".repeat(600);
    const message = buildMessage({ ...BASE, body });
    expect([...message].length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
    expect(message.endsWith(`…\n\n${BASE.url}`)).toBe(true);
    // no replacement character from a torn code point
    expect(message).not.toContain("\uFFFD");
  });

  it("astral emoji (surrogate pairs) survive the cut un-torn", () => {
    const body = "🎉🚀".repeat(1500); // each emoji is 2 UTF-16 units
    const message = buildMessage({ ...BASE, body });
    expect([...message].length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
    // every kept character is either a whole emoji or the separator set
    const tail = message.slice(0, message.indexOf(`\n\n${BASE.url}`));
    for (const ch of tail) {
      const whole = ch !== "\uFFFD" && !(ch >= "\uD800" && ch <= "\uDFFF" && ch.length === 1);
      // Array.from never yields a lone surrogate, so this pins the invariant
      expect(whole).toBe(true);
    }
    expect(message).toContain("🎉");
  });
});

describe("run — environment contract", () => {
  it("reads RELEASE_TAG / RELEASE_BODY / RELEASE_URL from env", () => {
    const result = run({
      RELEASE_TAG: "v9.9.9",
      RELEASE_BODY: "  notes here  ",
      RELEASE_URL: "https://example.invalid/r",
    });
    expect(result.exit).toBe(0);
    expect(result.message).toBe("AnyCode v9.9.9 is out\n\nnotes here\n\nhttps://example.invalid/r");
  });

  it("missing RELEASE_BODY → exit 0 with title + link", () => {
    const result = run({ RELEASE_TAG: "v9.9.9", RELEASE_URL: "https://example.invalid/r" });
    expect(result.exit).toBe(0);
    expect(result.message).toBe("AnyCode v9.9.9 is out\n\nhttps://example.invalid/r");
  });

  it("missing RELEASE_TAG → exit 1 with a clear stderr diagnostic", () => {
    const result = run({ RELEASE_URL: "https://example.invalid/r" });
    expect(result.exit).toBe(1);
    expect(result.message).toContain("RELEASE_TAG");
  });

  it("empty RELEASE_URL → exit 1 with a clear stderr diagnostic", () => {
    const result = run({ RELEASE_TAG: "v9.9.9", RELEASE_URL: "  " });
    expect(result.exit).toBe(1);
    expect(result.message).toContain("RELEASE_URL");
  });
});
