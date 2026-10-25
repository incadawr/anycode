import { describe, expect, it } from "vitest";
import { redactSecrets } from "./redact.js";

describe("redactSecrets (Taskana 4752, C-12)", () => {
  it("replaces every occurrence of each value with [redacted]", () => {
    expect(redactSecrets("token=ghp_abcd1234 and again ghp_abcd1234", ["ghp_abcd1234"])).toBe(
      "token=[redacted] and again [redacted]",
    );
  });

  it("ignores values shorter than 4 characters", () => {
    expect(redactSecrets("a=abc, b=abcd", ["abc"])).toBe("a=abc, b=abcd");
  });

  it("redacts a 4-character value", () => {
    expect(redactSecrets("pin 1234", ["1234"])).toBe("pin [redacted]");
  });

  it("handles several values, longest first so a prefix does not leave a tail", () => {
    expect(redactSecrets("x=secretlongvalue", ["secret", "secretlongvalue"])).toBe("x=[redacted]");
  });

  it("returns the text unchanged when there is nothing to redact", () => {
    expect(redactSecrets("plain text", [])).toBe("plain text");
  });

  it("does not treat the value as a regular expression", () => {
    expect(redactSecrets("a.*b.*c", [".*b.*"])).toBe("a[redacted]c");
  });
});
