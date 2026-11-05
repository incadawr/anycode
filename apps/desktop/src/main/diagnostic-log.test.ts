import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDiagnosticLog, redactDiagnostic } from "./diagnostic-log.js";
import { startLocalCrashReporting } from "./crash-reporting.js";

describe("local crash reporting", () => {
  it("sets the local directory before starting with uploads disabled", () => {
    const app = { getPath: () => "/profile", setPath: vi.fn() };
    const reporter = { start: vi.fn() };
    startLocalCrashReporting(app, reporter, () => {});
    expect(app.setPath).toHaveBeenCalledWith("crashDumps", join("/profile", "crash-dumps"));
    expect(app.setPath.mock.invocationCallOrder[0]).toBeLessThan(reporter.start.mock.invocationCallOrder[0]!);
    expect(reporter.start).toHaveBeenCalledWith({ uploadToServer: false });
  });
  it("starts with the default directory when the override fails", () => {
    const reporter = { start: vi.fn() };
    startLocalCrashReporting({ getPath: () => "/bad", setPath: vi.fn() }, reporter, () => { throw Error(); });
    expect(reporter.start).toHaveBeenCalledWith({ uploadToServer: false });
  });
});

describe("diagnostic log", () => {
  it("redacts common credentials including split host output", async () => {
    const dir = await mkdtemp(join(tmpdir(), "diagnostic-"));
    const log = createDiagnosticLog(dir);
    const host = log.stream("host stderr");
    host(Buffer.from("Authorization: Bear"));
    host(Buffer.from("er abcdefghijklmnop\nhttps://example.test/?api_key=secret123&ok=1\n"));
    host(Buffer.from('{"api_key":"anothersecret"}'));
    host.end();
    await log.flush();
    const text = await readFile(join(dir, "anycode.log"), "utf8");
    expect(text).not.toContain("abcdefghijklmnop");
    expect(text).not.toContain("secret123");
    expect(text).not.toContain("anothersecret");
    expect(text).toContain("[redacted]");
    expect(redactDiagnostic("sk-abcdefghijklmnop")).toBe("[redacted]");
  });
  it("rotates and bounds lines; disk errors never reject", async () => {
    const dir = await mkdtemp(join(tmpdir(), "diagnostic-"));
    await writeFile(join(dir, "anycode.log"), "x".repeat(1024 * 1024));
    const log = createDiagnosticLog(dir);
    log.write("main", "a".repeat(10000));
    await log.flush();
    expect((await readFile(join(dir, "anycode.log"))).length).toBeLessThan(5000);
    expect((await readFile(join(dir, "anycode.log.1"))).length).toBe(1024 * 1024);
    const bad = createDiagnosticLog(join(dir, "anycode.log", "invalid"));
    expect(() => bad.write("main", "message")).not.toThrow();
    await expect(bad.flush()).resolves.toBeUndefined();
  });
});
