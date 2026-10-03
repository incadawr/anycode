import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { recordErrorDiagnostic } from "./error-diagnostics.js";

it("writes only whitelisted diagnostics and refuses symlinks and traversal", () => {
  const dir = mkdtempSync(join(tmpdir(), "anycode-error-log-"));
  try {
    recordErrorDiagnostic(dir, "session", "auth", 401);
    recordErrorDiagnostic(dir, "session", "sk-poison-password", 99999);
    const content = readFileSync(join(dir, "session.jsonl"), "utf8");
    expect(content).toContain('"code":"auth"');
    expect(content).toContain('"statusCode":401');
    expect(content).not.toMatch(/poison|password|99999/);
    const target = join(dir, "untouched");
    writeFileSync(target, "original");
    symlinkSync(target, join(dir, "linked.jsonl"));
    recordErrorDiagnostic(dir, "linked", "auth");
    recordErrorDiagnostic(dir, "../untouched", "auth");
    expect(readFileSync(target, "utf8")).toBe("original");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
