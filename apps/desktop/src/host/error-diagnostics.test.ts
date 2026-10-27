import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { recordErrorDiagnostic, recordHostBootFailure, recordHostFailure } from "./error-diagnostics.js";

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

it("recordHostBootFailure writes a safe classified reason and never the raw error", () => {
  const dir = mkdtempSync(join(tmpdir(), "anycode-boot-log-"));
  try {
    recordHostBootFailure(dir, "session-1", new Error("authentication failed: Bearer sk-poison-password"));
    const content = readFileSync(join(dir, "session-1.jsonl"), "utf8");
    expect(content).toContain('"code":"auth"');
    expect(content).not.toMatch(/poison|password|Bearer/);
    expect(content).toContain("Sign-in failed or expired");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("recordHostBootFailure falls back to a host-keyed file when no session id is known", () => {
  const dir = mkdtempSync(join(tmpdir(), "anycode-boot-log-"));
  try {
    recordHostBootFailure(dir, undefined, new Error("network error"));
    const content = readFileSync(join(dir, "host.jsonl"), "utf8");
    expect(content).toContain('"code":"network"');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("recordHostFailure records the two main-side dead-host causes in the same safe vocabulary", () => {
  const dir = mkdtempSync(join(tmpdir(), "anycode-host-failure-log-"));
  try {
    recordHostFailure(dir, "sess-glm", "connection_env_unavailable");
    recordHostFailure(dir, "sess-loop", "host_crash_loop");
    const envMiss = readFileSync(join(dir, "sess-glm.jsonl"), "utf8");
    expect(envMiss).toContain('"code":"connection_env_unavailable"');
    expect(envMiss).toContain("connection is unavailable");
    const loop = readFileSync(join(dir, "sess-loop.jsonl"), "utf8");
    expect(loop).toContain('"code":"host_crash_loop"');
    expect(loop).toContain("kept exiting right after it started");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
