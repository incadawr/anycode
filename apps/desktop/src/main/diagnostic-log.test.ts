import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDiagnosticLog, installConsoleLog, redactDiagnostic } from "./diagnostic-log.js";
import type { App } from "electron";
import { EventEmitter } from "node:events";
import { installProcessDiagnostics } from "./process-diagnostics.js";
import { readUserTelemetryRetention, type RetentionFs } from "./telemetry-retention.js";
import { loadSettings } from "../settings/files.js";
import { loadHookConfigs, NodeFileSystemAdapter } from "@anycode/core";
import { logHookConfigFailure } from "../host/hook-config-diagnostics.js";
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
    expect(text).toContain("[3 host output lines suppressed]");
    expect(redactDiagnostic("sk-abcdefghijklmnop")).toBe("[redacted]");
  });
  it("redacts complete authorization values and encoded parameter names", () => {
    for (const value of [
      "Authorization: Basic dXNlcjpwYXNzd29yZA==",
      '"Authorization": "Basic dXNlcjpwYXNzd29yZA=="',
      "authorization: Bearer bearerSecret",
      "Authorization: Custom schemeSecret",
      "https://example.test/?%61pi_key=urlsecret&ok=1",
      "https://example.test/?%41PI%5FKEY=urlsecret",
      "x-api-key: urlsecret",
      "OPENAI_API_KEY=urlsecret",
      "client_secret=urlsecret",
      "refresh_token=urlsecret",
      "Proxy-Authorization: Basic urlsecret",
      "https://user:urlsecret@example.test/path",
      "AIzaabcdefghijklmnopqrstuvwxyz123456789",
    ]) {
      const redacted = redactDiagnostic(value);
      for (const secret of ["dXNlcjpwYXNzd29yZA==", "bearerSecret", "schemeSecret", "urlsecret", "abcdefghijklmnopqrstuvwxyz123456789"]) {
        expect(redacted).not.toContain(secret);
      }
      expect(redacted).toContain("[redacted]");
    }
  });
  it("does not persist file content from a settings JSON parse error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "diagnostic-settings-"));
    const path = join(dir, "settings.json");
    await writeFile(path, "CONFIDENTIAL_FILE_CONTENT invalid JSON");
    const log = createDiagnosticLog(join(dir, "logs"));
    const target = { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Console;
    installConsoleLog(log, target);
    await loadSettings(path, { warn: (message, error) => target.warn(message, error) });
    await log.flush();
    const text = await readFile(join(dir, "logs", "anycode.log"), "utf8");
    expect(text).toContain("SyntaxError: details omitted");
    expect(text).not.toContain("CONFIDENTIAL_FILE_CONTENT");
    expect(text).not.toContain("invalid JSON");
  });
  it("filters host lines and records only safe shapes and suppressed counts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "diagnostic-host-"));
    const log = createDiagnosticLog(dir);
    const host = log.stream("host stdout");
    host(Buffer.from("[host] started. workspace=/private/path\n[host] arbitrary user secret\nraw text\n(node:123) Warning: sensitive details\n"));
    host.end();
    await log.flush();
    const text = await readFile(join(dir, "anycode.log"), "utf8");
    expect(text).toContain("[host] started");
    expect(text).toContain("[2 host output lines suppressed]");
    expect(text).toContain("Node warning (details suppressed)");
    expect(text).not.toContain("private/path");
    expect(text).not.toContain("user secret");
    expect(text).not.toContain("sensitive details");
  });
  it("keeps malformed hook config content out of the host log", async () => {
    const dir = await mkdtemp(join(tmpdir(), "diagnostic-hooks-"));
    await mkdir(join(dir, ".anycode"));
    await writeFile(join(dir, ".anycode", "config.json"), "CONFIDENTIAL_HOOK_CONTENT");
    const log = createDiagnosticLog(join(dir, "logs"));
    const host = log.stream("host stderr");
    const hostSource = await readFile(new URL("../host/index.ts", import.meta.url), "utf8");
    expect(hostSource).toContain("logHookConfigFailure(error)");
    try {
      await loadHookConfigs(new NodeFileSystemAdapter(), dir, dir, { projectTrusted: true });
      throw new Error("expected parse failure");
    } catch (error) {
      logHookConfigFailure(error, (line) => host(Buffer.from(line + "\n")));
    }
    host.end();
    await log.flush();
    const text = await readFile(join(dir, "logs", "anycode.log"), "utf8");
    expect(text).toContain("failed to load hook config; no command hooks registered: Error");
    expect(text).not.toContain("CONFIDENTIAL_HOOK_CONTENT");
  });
  it("handles adversarial URL-like input in bounded time", async () => {
    const dir = await mkdtemp(join(tmpdir(), "diagnostic-flood-"));
    const log = createDiagnosticLog(dir);
    const start = performance.now();
    const host = log.stream("host stderr");
    for (let i = 0; i < 32; i++) {
      log.write("main", "?".repeat(8192));
      host(Buffer.from("?".repeat(8192) + "\n"));
    }
    host.end();
    expect(performance.now() - start).toBeLessThan(1000);
    await log.flush();
  });
  it("logs process disappearance with only safe fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "diagnostic-process-"));
    const log = createDiagnosticLog(dir);
    const app = new EventEmitter();
    installProcessDiagnostics(app as unknown as Pick<App, "on">, (line) => log.write("main", line));
    app.emit("child-process-gone", {}, { type: "GPU", reason: "crashed", exitCode: 12, name: "secret" });
    app.emit("render-process-gone", {}, {}, { reason: "oom", exitCode: 9, serviceName: "secret" });
    app.emit("child-process-gone", {}, { type: "secret", reason: "secret", exitCode: "secret" });
    await log.flush();
    const text = await readFile(join(dir, "anycode.log"), "utf8");
    expect(text).toContain("type=GPU reason=crashed exitCode=12");
    expect(text).toContain("type=renderer reason=oom exitCode=9");
    expect(text).toContain("type=unknown reason=unknown exitCode=unknown");
    expect(text).not.toContain("secret");
  });
  it("keeps error type and code but no host error message", async () => {
    const dir = await mkdtemp(join(tmpdir(), "diagnostic-errors-"));
    const log = createDiagnosticLog(dir);
    const host = log.stream("host stderr");
    host(Buffer.from("TypeError [ERR_BAD_THING]: SECRET_VALUE\nFATAL ERROR: SECRET_VALUE\nSyntaxError: SECRET_VALUE\n"));
    host.end();
    await log.flush();
    const text = await readFile(join(dir, "anycode.log"), "utf8");
    expect(text).toContain("TypeError [ERR_BAD_THING] (details suppressed)");
    expect(text).toContain("FATAL ERROR (details suppressed)");
    expect(text).toContain("SyntaxError (details suppressed)");
    expect(text).not.toContain("SECRET_VALUE");
  });
  it("omits malformed telemetry config content from the log", async () => {
    const dir = await mkdtemp(join(tmpdir(), "diagnostic-telemetry-"));
    const log = createDiagnosticLog(dir);
    const target = { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Console;
    installConsoleLog(log, target);
    const spy = vi.spyOn(console, "warn").mockImplementation((...args) => target.warn(...args));
    try {
      const fs = { exists: async () => true, readFile: async () => "CONFIDENTIAL_TELEMETRY_CONTENT" } as unknown as RetentionFs;
      await readUserTelemetryRetention(fs, dir);
    } finally { spy.mockRestore(); }
    await log.flush();
    const text = await readFile(join(dir, "anycode.log"), "utf8");
    expect(text).toContain("SyntaxError: details omitted");
    expect(text).not.toContain("CONFIDENTIAL_TELEMETRY_CONTENT");
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
