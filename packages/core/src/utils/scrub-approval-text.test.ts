import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { scrubApprovalText, scrubFailureText } from "./scrub-approval-text.js";

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


describe("scrubFailureText", () => {
  it.each(["Authorization", "Proxy-Authorization"])("redacts the entire %s header", (header) => {
    expect(scrubFailureText(`${header}: Digest username="alice", response="hunter2"\nnext`)).toBe(`${header}: [redacted]\nnext`);
  });
  it.each(["password", "passwd", "secret"])("redacts multiword %s values up to a delimiter", (name) => {
    expect(scrubFailureText(`${name}: first second; next`)).toBe(`${name}: [redacted]; next`);
  });
  it("redacts a leading-slash token while preserving paths", () => {
    expect(scrubFailureText("Rejected /abcdefghijklmnopqrstuvwxyz1234567890")).toBe("Rejected [redacted]");
    const path = "/usr/local/lib/abcdefghijklmnopqrstuvwxyz1234567890/file";
    expect(scrubFailureText(path)).toBe(path);
  });
  it("handles long inputs within a hard process timeout", () => {
    const script = `
      const fs = require('node:fs');
      const ts = require('typescript');
      const source = fs.readFileSync(process.argv[1], 'utf8');
      const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
      const mod = { exports: {} }; new Function('exports', 'module', js)(mod.exports, mod);
      for (const input of ['a'.repeat(1e6), 'a.'.repeat(500000), 'Authorization: '.repeat(1e5), 'password: '.repeat(1e5)]) mod.exports.scrubFailureText(input);
    `;
    execFileSync(process.execPath, ["-e", script, fileURLToPath(new URL("./scrub-approval-text.ts", import.meta.url))], { timeout: 5000, killSignal: "SIGKILL" });
  }, 10000);
  it.each([
    "packages/core/src/utils/a-very-long-filename-with-many-characters.ts",
    "/Users/me/.anycode/sessions/12345678-1234-1234-1234-123456789abc.json",
    "~/.codex/sessions/12345678-1234-1234-1234-123456789abc.json",
    "12345678-1234-1234-1234-123456789abc",
  ])("preserves diagnostic path or UUID %s", (value) => {
    expect(scrubFailureText(value)).toBe(value);
  });
  it.each(["socks5", "ws", "postgres", "custom+scheme.1"])("redacts %s userinfo through the last at sign", (scheme) => {
    expect(scrubFailureText(`${scheme}://bob:hunter2@other@proxy/path`)).toBe(`${scheme}://[redacted]@proxy/path`);
  });
  it("redacts all URL userinfo up to the final at sign", () => {
    expect(scrubFailureText("http://alice:prefix@private-suffix@proxy.local/path")).toBe("http://[redacted]@proxy.local/path");
  });
  it("redacts escaped JSON quotes", () => {
    expect(scrubFailureText('{"password":"prefix\\"private-suffix"}')).not.toContain("private-suffix");
  });
  it("redacts key-provided long tokens", () => {
    expect(scrubFailureText("Incorrect API key provided: abcdefghijklmnopqrstuvwxyz1234567890")).not.toContain("abcdefghijklmnopqrstuvwxyz1234567890");
  });
  it.each(["pass=short", "auth=short", "session=short"])("redacts legacy sensitive name %s", (value) => {
    expect(scrubFailureText(value)).not.toContain("short");
  });
  it.each(["https://alice:hunter2@proxy.local", "Bearer abc123", "sk-abcdefghijklmnopqrstuvwx", "sk-short", "API_KEY=secret123", "key=secret123", 'password="secret value"'])('redacts credentials in %s', (value) => {
    expect(scrubFailureText(value)).toContain("[redacted]");
    expect(scrubFailureText(value)).not.toContain("secret123");
    expect(scrubFailureText(value)).not.toContain("hunter2");
  });
  it("preserves useful failure text and long paths", () => {
    const reason = "session authentication failed at /a/very-long-path-with-more-than-thirty-two-characters/file: connection refused";
    expect(scrubFailureText(reason)).toBe(reason);
  });
});
