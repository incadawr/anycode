/**
 * config.test.ts (slice 6.6 B7): loadTelemetryConfig — env kill-switch,
 * single-object `telemetry` section, project-wins-WHOLESALE precedence,
 * fail-soft handling of invalid JSON/schema/relative dir (loader never
 * throws), and the default sink directory.
 */

import { tmpdir } from "node:os";
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

/**
 * Temporarily removes the ambient `VITEST` marker so a callback observes the
 * NON-test-runner code path. `loadTelemetryConfig`'s fail-closed test gate
 * (TASK.121) is keyed off this exact ambient value — never the injected `env`
 * argument — and this test file runs for real under vitest, so `VITEST` is
 * genuinely set on `process.env` here. Used to pin "no behavior change
 * without VITEST ambient" for the pre-existing home-fallback/default-dir
 * tests below, which would otherwise silently start exercising the gate.
 */
async function withoutVitestAmbient<T>(fn: () => Promise<T>): Promise<T> {
  const original = process.env.VITEST;
  delete process.env.VITEST;
  try {
    return await fn();
  } finally {
    if (original !== undefined) process.env.VITEST = original;
  }
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

  it("falls through to home when project has no telemetry key at all (outside the test gate)", async () => {
    // TASK.121: workspace !== home here, so under the ambient VITEST gate the
    // home-scope source is skipped entirely (see the gate describe block
    // below) — this test pins the underlying fallthrough logic still works
    // for a non-test-runner caller.
    await withoutVitestAmbient(async () => {
      const fs = makeFs({
        [PROJECT_CONFIG]: JSON.stringify({ other: 1 }),
        [USER_CONFIG]: JSON.stringify({ telemetry: { enabled: true, dir: "/home-tel" } }),
      });
      const result = await loadTelemetryConfig(fs, WORKSPACE, HOME, {});
      expect(result).toEqual({ telemetry: { dir: "/home-tel" }, issues: [] });
    });
  });
});

describe("loadTelemetryConfig — fail-soft malformed input", () => {
  it("invalid JSON in project falls through to home (with an issue recorded, outside the test gate)", async () => {
    // TASK.121: workspace !== home; see the gate note on the sibling test above.
    await withoutVitestAmbient(async () => {
      const fs = makeFs({
        [PROJECT_CONFIG]: "{ not valid json",
        [USER_CONFIG]: JSON.stringify({ telemetry: { enabled: true, dir: "/home-tel" } }),
      });
      const result = await loadTelemetryConfig(fs, WORKSPACE, HOME, {});
      expect(result.telemetry).toEqual({ dir: "/home-tel" });
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0]).toMatch(/Invalid JSON/);
    });
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

  it("defaults dir to <home>/.anycode/telemetry when omitted (outside the test gate)", async () => {
    // TASK.121: an enabled section without an explicit dir is exactly what the
    // ambient-VITEST gate refuses (see the gate describe block below) — this
    // test pins the underlying default-dir logic still works for a
    // non-test-runner caller.
    await withoutVitestAmbient(async () => {
      const fs = makeFs({ [PROJECT_CONFIG]: JSON.stringify({ telemetry: { enabled: true } }) });
      const result = await loadTelemetryConfig(fs, WORKSPACE, HOME, {});
      expect(result).toEqual({ telemetry: { dir: "/home/u/.anycode/telemetry" }, issues: [] });
    });
  });

  it("tolerates a trailing separator on home when defaulting (outside the test gate)", async () => {
    await withoutVitestAmbient(async () => {
      const fs = makeFs({ [PROJECT_CONFIG]: JSON.stringify({ telemetry: { enabled: true } }) });
      const result = await loadTelemetryConfig(fs, WORKSPACE, "/home/u/", {});
      expect(result).toEqual({ telemetry: { dir: "/home/u/.anycode/telemetry" }, issues: [] });
    });
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

describe("loadTelemetryConfig — TASK.121/TASK.165 ANYCODE_TELEMETRY_DIR override", () => {
  // TASK.165: the override REDIRECTS an already-enabled sink; it must never
  // enable telemetry on its own. This is the red->green pin for that defect —
  // on the pre-fix code this returned an ENABLED telemetry object even with
  // zero config files present anywhere.
  it("an override alone, with no config claiming enabled:true anywhere, does NOT enable telemetry", async () => {
    const result = await loadTelemetryConfig(makeFs({}), WORKSPACE, HOME, {
      ANYCODE_TELEMETRY_DIR: "/abs/override-tel",
    });
    expect(result).toEqual({ telemetry: null, issues: [] });
  });

  it("an absolute override wins over the dir written in an already-enabled file config", async () => {
    const fs = makeFs({
      [PROJECT_CONFIG]: JSON.stringify({ telemetry: { enabled: true, dir: "/proj-tel" } }),
    });
    const result = await loadTelemetryConfig(fs, WORKSPACE, HOME, {
      ANYCODE_TELEMETRY_DIR: "/abs/override-tel",
    });
    expect(result).toEqual({ telemetry: { dir: "/abs/override-tel" }, issues: [] });
  });

  it("an absolute override also redirects an enabled section that omits its own dir", async () => {
    const fs = makeFs({
      [PROJECT_CONFIG]: JSON.stringify({ telemetry: { enabled: true } }),
    });
    const result = await loadTelemetryConfig(fs, WORKSPACE, HOME, {
      ANYCODE_TELEMETRY_DIR: "/abs/override-tel",
    });
    expect(result).toEqual({ telemetry: { dir: "/abs/override-tel" }, issues: [] });
  });

  it.each(["relative/tel", ""])(
    "a relative/empty override %j fails closed with an issue, without touching the filesystem",
    async (value) => {
      const result = await loadTelemetryConfig(throwingFs(), WORKSPACE, HOME, {
        ANYCODE_TELEMETRY_DIR: value,
      });
      expect(result.telemetry).toBeNull();
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0]).toMatch(/ANYCODE_TELEMETRY_DIR/);
    },
  );

  it("the kill-switch still wins over the dir override", async () => {
    const result = await loadTelemetryConfig(throwingFs(), WORKSPACE, HOME, {
      ANYCODE_TELEMETRY: "0",
      ANYCODE_TELEMETRY_DIR: "/abs/override-tel",
    });
    expect(result).toEqual({ telemetry: null, issues: [] });
  });
});

describe("loadTelemetryConfig — TASK.121 fail-closed test gate (ambient VITEST)", () => {
  it("skips the home-scope source entirely when workspace !== home — home is never touched", async () => {
    let homeTouched = false;
    const fs: FileSystemPort = {
      readFile: async (path) => {
        if (path === USER_CONFIG) homeTouched = true;
        throw new Error(`ENOENT: ${path}`);
      },
      writeFile: async () => {},
      stat: async () => ({ size: 0, mtimeMs: 0, isFile: true, isDirectory: false }),
      exists: async (path) => {
        if (path === USER_CONFIG) homeTouched = true;
        return false;
      },
      mkdir: async () => {},
      readdir: async () => [],
    };
    const result = await loadTelemetryConfig(fs, WORKSPACE, HOME, {});
    expect(homeTouched).toBe(false);
    expect(result).toEqual({ telemetry: null, issues: [] });
  });

  // TASK.166: a default-dir resolution under the gate must not vanish — it
  // redirects to a stable, discoverable temp dir instead. This is the
  // red->green pin for that defect: on the pre-fix code this resolved to
  // `{telemetry: null, issues: [...]}` (the fixture data was simply lost).
  it("an enabled section without an explicit dir redirects to a stable temp dir instead of vanishing, and the path is discoverable via issues", async () => {
    const fs = makeFs({ [PROJECT_CONFIG]: JSON.stringify({ telemetry: { enabled: true } }) });
    const result = await loadTelemetryConfig(fs, WORKSPACE, HOME, {});
    const expectedDir = `${tmpdir().replace(/[/\\]+$/, "")}/anycode-telemetry-vitest`;
    expect(result.telemetry).toEqual({ dir: expectedDir });
    // Never the real default — this is the whole point of the gate and must not weaken.
    expect(result.telemetry?.dir).not.toBe(`${HOME}/.anycode/telemetry`);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toContain(expectedDir);
  });

  it("an explicit absolute dir in a project config still resolves normally under the gate", async () => {
    const fs = makeFs({
      [PROJECT_CONFIG]: JSON.stringify({ telemetry: { enabled: true, dir: "/abs/tel" } }),
    });
    const result = await loadTelemetryConfig(fs, WORKSPACE, HOME, {});
    expect(result).toEqual({ telemetry: { dir: "/abs/tel" }, issues: [] });
  });

  it("workspace === home still consults that single source (desktop profile-ipc dedup pattern)", async () => {
    const fs = makeFs({
      [USER_CONFIG]: JSON.stringify({ telemetry: { enabled: true, dir: "/abs/tel" } }),
    });
    const result = await loadTelemetryConfig(fs, HOME, HOME, {});
    expect(result).toEqual({ telemetry: { dir: "/abs/tel" }, issues: [] });
  });

  it("kill-switch is still checked first, even under the gate", async () => {
    const result = await loadTelemetryConfig(throwingFs(), WORKSPACE, HOME, { ANYCODE_TELEMETRY: "off" });
    expect(result).toEqual({ telemetry: null, issues: [] });
  });
});
