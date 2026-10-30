import { describe, expect, it } from "vitest";
import { scrubApprovalText } from "./scrub-approval-text.js";

describe("scrubApprovalText", () => {
  it.each([
    "Authorization: Basic dXNlcjpwYXNz",
    '{"password":"first second',
    '--password="first second"',
    "Cookie: session=short value",
    "X-API-Key: arbitrary scheme and value",
    "api key: arbitrary scheme and value",
    "access_token=short, other=still hidden",
  ])("redacts the remainder of a sensitive line: %s", (line) => {
    const result = scrubApprovalText(`before ${line}\r\nafter`);
    expect(result).toMatch(/\[redacted\]\r\nafter$/);
    expect(result).not.toContain("second");
    expect(result).not.toContain("dXNlcjpwYXNz");
    expect(result).not.toContain("still hidden");
    expect(result).not.toContain("short value");
    expect(result).not.toContain("arbitrary scheme");
  });

  it("redacts even when the sensitive name ends the current snapshot", () => {
    expect(scrubApprovalText('progress {"password')).toBe('progress {"password[redacted]');
    expect(scrubApprovalText("ordinary progress\nnext line")).toBe("ordinary progress\nnext line");
  });
});
