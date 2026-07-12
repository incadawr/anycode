/**
 * config.test.ts (slice 6.6 B7): loadTelemetryConfig — env kill-switch,
 * single-object `telemetry` section, project-wins-WHOLESALE precedence,
 * fail-soft handling of invalid JSON/schema/relative dir (loader never
 * throws), and the default sink directory.
 */

import { describe, expect, it } from "vitest";
import { loadTelemetryConfig } from "./config.js";
import type { FileSystemPort } from "../ports/file-system.js";

const WORKSPACE = "/proj";
const HOME = "/home/u";
const PROJECT_CONFIG = "/proj/.anycode/config.json";
const USER_CONFIG = "/home/u/.anycode/config.json";

function makeFs(files: Record<string, string>): FileSystemPort {
  return {
    readFile: async (path) => {
      const content = files[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    writeFile: async () => {},
    stat: async () => ({ size: 0, mtimeMs: 0, isFile: true, isDirectory: false }),
    exists: async (path) => path in files,
    mkdir: async () => {},
    readdir: async () => [],
  };
}

function throwingFs(): FileSystemPort {
  return {
    readFile: async () => {
      throw new Error("fs must not be touched");
    },
    writeFile: async () => {},
    stat: async () => {
      throw new Error("fs must not be touched");
    },
    exists: async () => {
      throw new Error("fs must not be touched");
    },
    mkdir: async () => {},
    readdir: async () => [],
  };
}

describe("loadTelemetryConfig — env kill-switch", () => {
  it.each(["0", "false", "off", "FALSE", "OFF"])(
    "env ANYCODE_TELEMETRY=%s disables telemetry silently WITHOUT touching the filesystem",
    async (value) => {
      const result = await loadTelemetryConfig(throwingFs(), WORKSPACE, HOME, { ANYCODE_TELEMETRY: value });
      expect(result).toEqual({ telemetry: null, issues: [] });
    },
  );

  it.each(["1", "true", "on", "yes"])(
    "env ANYCODE_TELEMETRY=%s is NOT a kill-switch value (config still consulted)",
    async (value) => {
      const fs = makeFs({
        [PROJECT_CONFIG]: JSON.stringify({ telemetry: { enabled: true, dir: "/abs/tel" } }),
      });
      const result = await loadTelemetryConfig(fs, WORKSPACE, HOME, { ANYCODE_TELEMETRY: value });
      expect(result).toEqual({ telemetry: { dir: "/abs/tel" }, issues: [] });
    },
  );

  it("no ANYCODE_TELEMETRY env var — config still consulted normally", async () => {
    const fs = makeFs({
      [PROJECT_CONFIG]: JSON.stringify({ telemetry: { enabled: true, dir: "/abs/tel" } }),
    });
    const result = await loadTelemetryConfig(fs, WORKSPACE, HOME, {});
    expect(result).toEqual({ telemetry: { dir: "/abs/tel" }, issues: [] });
  });
});

describe("loadTelemetryConfig — absent", () => {
  it("returns null and zero issues silently when no config exists anywhere", async () => {
    const result = await loadTelemetryConfig(makeFs({}), WORKSPACE, HOME, {});
    expect(result).toEqual({ telemetry: null, issues: [] });
  });

  it("treats a config with no telemetry key as absent (silent, falls through to home)", async () => {
    const fs = makeFs({ [PROJECT_CONFIG]: JSON.stringify({ other: true }) });
    const result = await loadTelemetryConfig(fs, WORKSPACE, HOME, {});
    expect(result).toEqual({ telemetry: null, issues: [] });
  });

  it("enabled:false is silent (no issue)", async () => {
    const fs = makeFs({ [PROJECT_CONFIG]: JSON.stringify({ telemetry: { enabled: false } }) });
    const result = await loadTelemetryConfig(fs, WORKSPACE, HOME, {});
    expect(result).toEqual({ telemetry: null, issues: [] });
  });
});

describe("loadTelemetryConfig — project wins WHOLESALE", () => {
  it("a claimed project section wins outright, even if invalid — home is never consulted", async () => {
    const fs = makeFs({
      [PROJECT_CONFIG]: JSON.stringify({ telemetry: { enabled: true, dir: "relative/tel" } }),
      [USER_CONFIG]: JSON.stringify({ telemetry: { enabled: true, dir: "/abs/home-tel" } }),
    });
    const result = await loadTelemetryConfig(fs, WORKSPACE, HOME, {});
    expect(result.telemetry).toBeNull();
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatch(/absolute path/);
  });

  it("a valid project section wins over a different valid home section", async () => {
    const fs = makeFs({
      [PROJECT_CONFIG]: JSON.stringify({ telemetry: { enabled: true, dir: "/proj-tel" } }),
      [USER_CONFIG]: JSON.stringify({ telemetry: { enabled: true, dir: "/home-tel" } }),
    });
    const result = await loadTelemetryConfig(fs, WORKSPACE, HOME, {});
    expect(result).toEqual({ telemetry: { dir: "/proj-tel" }, issues: [] });
  });

  it("falls through to home when project has no telemetry key at all", async () => {
    const fs = makeFs({
      [PROJECT_CONFIG]: JSON.stringify({ other: 1 }),
      [USER_CONFIG]: JSON.stringify({ telemetry: { enabled: true, dir: "/home-tel" } }),
    });
    const result = await loadTelemetryConfig(fs, WORKSPACE, HOME, {});
    expect(result).toEqual({ telemetry: { dir: "/home-tel" }, issues: [] });
  });
});

describe("loadTelemetryConfig — fail-soft malformed input", () => {
  it("invalid JSON in project falls through to home (with an issue recorded)", async () => {
    const fs = makeFs({
      [PROJECT_CONFIG]: "{ not valid json",
      [USER_CONFIG]: JSON.stringify({ telemetry: { enabled: true, dir: "/home-tel" } }),
    });
    const result = await loadTelemetryConfig(fs, WORKSPACE, HOME, {});
    expect(result.telemetry).toEqual({ dir: "/home-tel" });
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatch(/Invalid JSON/);
  });

  it("schema violation (enabled missing) claims the section and disables — issue + null, no fallthrough", async () => {
    const fs = makeFs({
      [PROJECT_CONFIG]: JSON.stringify({ telemetry: { dir: "/abs/tel" } }),
      [USER_CONFIG]: JSON.stringify({ telemetry: { enabled: true, dir: "/home-tel" } }),
    });
    const result = await loadTelemetryConfig(fs, WORKSPACE, HOME, {});
    expect(result.telemetry).toBeNull();
    expect(result.issues).toHaveLength(1);
  });

  it("never throws even when readFile rejects mid-load", async () => {
    const fs: FileSystemPort = {
      readFile: async () => {
        throw new Error("boom");
      },
      writeFile: async () => {},
      stat: async () => ({ size: 0, mtimeMs: 0, isFile: true, isDirectory: false }),
      exists: async () => true,
      mkdir: async () => {},
      readdir: async () => [],
    };
    const result = await loadTelemetryConfig(fs, WORKSPACE, HOME, {});
    expect(result.telemetry).toBeNull();
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues.every((issue) => issue.includes("boom"))).toBe(true);
  });
});

describe("loadTelemetryConfig — dir resolution", () => {
  it("relative dir is an issue + disabled, never resolved against cwd", async () => {
    const fs = makeFs({
      [PROJECT_CONFIG]: JSON.stringify({ telemetry: { enabled: true, dir: "relative/path" } }),
    });
    const result = await loadTelemetryConfig(fs, WORKSPACE, HOME, {});
    expect(result.telemetry).toBeNull();
    expect(result.issues[0]).toMatch(/absolute path/);
  });

  it("defaults dir to <home>/.anycode/telemetry when omitted", async () => {
    const fs = makeFs({ [PROJECT_CONFIG]: JSON.stringify({ telemetry: { enabled: true } }) });
    const result = await loadTelemetryConfig(fs, WORKSPACE, HOME, {});
    expect(result).toEqual({ telemetry: { dir: "/home/u/.anycode/telemetry" }, issues: [] });
  });

  it("tolerates a trailing separator on home when defaulting", async () => {
    const fs = makeFs({ [PROJECT_CONFIG]: JSON.stringify({ telemetry: { enabled: true } }) });
    const result = await loadTelemetryConfig(fs, WORKSPACE, "/home/u/", {});
    expect(result).toEqual({ telemetry: { dir: "/home/u/.anycode/telemetry" }, issues: [] });
  });

  it("accepts a Windows-style absolute dir", async () => {
    const fs = makeFs({
      [PROJECT_CONFIG]: JSON.stringify({ telemetry: { enabled: true, dir: "C:\\Users\\me\\telemetry" } }),
    });
    const result = await loadTelemetryConfig(fs, WORKSPACE, HOME, {});
    expect(result).toEqual({ telemetry: { dir: "C:\\Users\\me\\telemetry" }, issues: [] });
  });

  it("accepts a Windows-style absolute dir with forward slashes", async () => {
    const fs = makeFs({
      [PROJECT_CONFIG]: JSON.stringify({ telemetry: { enabled: true, dir: "C:/Users/me/telemetry" } }),
    });
    const result = await loadTelemetryConfig(fs, WORKSPACE, HOME, {});
    expect(result).toEqual({ telemetry: { dir: "C:/Users/me/telemetry" }, issues: [] });
  });
});
