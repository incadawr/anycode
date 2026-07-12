/**
 * config.test.ts (slice 6.1 B7): loadLspServerSpecs — the `lspServers` array of
 * .anycode/config.json, project > user precedence (dedup by name), extension
 * normalization (lowercase + leading dot), and fail-soft handling of invalid
 * JSON / bad shape / malformed entries (issues collected, never thrown).
 */

import { describe, expect, it } from "vitest";
import { loadLspServerSpecs } from "./config.js";
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

describe("loadLspServerSpecs — empty / absent", () => {
  it("returns zero specs and issues when no config exists", async () => {
    const result = await loadLspServerSpecs(makeFs({}), WORKSPACE, HOME);
    expect(result).toEqual({ specs: [], issues: [] });
  });

  it("treats a config with no lspServers section as empty", async () => {
    const result = await loadLspServerSpecs(makeFs({ [PROJECT_CONFIG]: JSON.stringify({}) }), WORKSPACE, HOME);
    expect(result).toEqual({ specs: [], issues: [] });
  });
});

describe("loadLspServerSpecs — parsing and normalization", () => {
  it("parses a well-formed spec and normalizes extensions to lowercase dot-prefixed form", async () => {
    const fs = makeFs({
      [PROJECT_CONFIG]: JSON.stringify({
        lspServers: [
          { name: "typescript", command: "typescript-language-server", args: ["--stdio"], extensions: ["TS", ".Tsx"] },
        ],
      }),
    });
    const { specs, issues } = await loadLspServerSpecs(fs, WORKSPACE, HOME);
    expect(issues).toEqual([]);
    expect(specs).toHaveLength(1);
    expect(specs[0]).toEqual({
      name: "typescript",
      command: "typescript-language-server",
      args: ["--stdio"],
      extensions: [".ts", ".tsx"],
    });
  });

  it("defaults args to an empty array and carries initializationOptions through", async () => {
    const fs = makeFs({
      [PROJECT_CONFIG]: JSON.stringify({
        lspServers: [{ name: "x", command: "srv", extensions: [".ts"], initializationOptions: { hostInfo: "anycode" } }],
      }),
    });
    const { specs } = await loadLspServerSpecs(fs, WORKSPACE, HOME);
    expect(specs[0]!.args).toEqual([]);
    expect(specs[0]!.initializationOptions).toEqual({ hostInfo: "anycode" });
  });
});

describe("loadLspServerSpecs — precedence", () => {
  it("project wins over user for the same server name (records not merged)", async () => {
    const fs = makeFs({
      [PROJECT_CONFIG]: JSON.stringify({ lspServers: [{ name: "ts", command: "project-cmd", extensions: [".ts"] }] }),
      [USER_CONFIG]: JSON.stringify({ lspServers: [{ name: "ts", command: "user-cmd", extensions: [".ts"] }] }),
    });
    const { specs } = await loadLspServerSpecs(fs, WORKSPACE, HOME);
    expect(specs).toHaveLength(1);
    expect(specs[0]!.command).toBe("project-cmd");
  });

  it("merges distinct names across project and user", async () => {
    const fs = makeFs({
      [PROJECT_CONFIG]: JSON.stringify({ lspServers: [{ name: "ts", command: "a", extensions: [".ts"] }] }),
      [USER_CONFIG]: JSON.stringify({ lspServers: [{ name: "py", command: "b", extensions: [".py"] }] }),
    });
    const { specs } = await loadLspServerSpecs(fs, WORKSPACE, HOME);
    expect(specs.map((s) => s.name).sort()).toEqual(["py", "ts"]);
  });

  it("does not double-read when workspace and home resolve to the same path", async () => {
    let reads = 0;
    const files: Record<string, string> = {
      [USER_CONFIG]: JSON.stringify({ lspServers: [{ name: "ts", command: "a", extensions: [".ts"] }] }),
    };
    const fs: FileSystemPort = {
      ...makeFs(files),
      readFile: async (path) => {
        reads += 1;
        const c = files[path];
        if (c === undefined) throw new Error("ENOENT");
        return c;
      },
    };
    const { specs } = await loadLspServerSpecs(fs, HOME, HOME);
    expect(specs).toHaveLength(1);
    expect(reads).toBe(1);
  });
});

describe("loadLspServerSpecs — fail-soft", () => {
  it("records an issue and continues (no throw) on invalid JSON; other sources still load", async () => {
    const fs = makeFs({
      [PROJECT_CONFIG]: "{ not json",
      [USER_CONFIG]: JSON.stringify({ lspServers: [{ name: "ts", command: "a", extensions: [".ts"] }] }),
    });
    const { specs, issues } = await loadLspServerSpecs(fs, WORKSPACE, HOME);
    expect(specs.map((s) => s.name)).toEqual(["ts"]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/Invalid JSON in LSP config \/proj\/\.anycode\/config\.json/);
  });

  it("records an issue when lspServers is not an array", async () => {
    const fs = makeFs({ [PROJECT_CONFIG]: JSON.stringify({ lspServers: { ts: {} } }) });
    const { specs, issues } = await loadLspServerSpecs(fs, WORKSPACE, HOME);
    expect(specs).toEqual([]);
    expect(issues[0]).toMatch(/must be an array/);
  });

  it("skips only the malformed entry and keeps the valid ones", async () => {
    const fs = makeFs({
      [PROJECT_CONFIG]: JSON.stringify({
        lspServers: [
          { name: "good", command: "a", extensions: [".ts"] },
          { name: "bad", extensions: [".js"] }, // missing command
          { command: "c", extensions: [".py"] }, // missing name
          { name: "noext", command: "d", extensions: [] }, // empty extensions
        ],
      }),
    });
    const { specs, issues } = await loadLspServerSpecs(fs, WORKSPACE, HOME);
    expect(specs.map((s) => s.name)).toEqual(["good"]);
    expect(issues).toHaveLength(3);
    for (const issue of issues) expect(issue).toMatch(/Invalid LSP server/);
  });
});
