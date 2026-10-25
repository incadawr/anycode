/**
 * plugins/admin tests (Taskana 4732 S1-A, design §7/§8): the Plugins-pane
 * scan enumerates every plugin with tier/status/capabilities/consent —
 * managed entries with bookkeeping, project + legacy dir plugins, corrupt
 * state fail-soft, and deterministic tier-then-name ordering.
 */

import { describe, expect, it } from "vitest";
import { defaultPluginStatePath, scanPluginsAdmin } from "./admin.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { serversHash, type McpConsentEntry } from "./state.js";

interface FakeFsSpec {
  dirs?: Record<string, string[]>;
  files?: Record<string, string>;
}

function makeFs(spec: FakeFsSpec): FileSystemPort {
  const dirs = spec.dirs ?? {};
  const files = spec.files ?? {};
  return {
    readFile: async (path: string) => {
      if (!(path in files)) {
        throw new Error(`ENOENT: ${path}`);
      }
      return files[path]!;
    },
    writeFile: async () => {},
    stat: async () => ({ size: 0, mtimeMs: 0, isFile: true, isDirectory: false }),
    exists: async (path: string) => path in files || path in dirs,
    mkdir: async () => {},
    readdir: async (path: string) => {
      if (!(path in dirs)) {
        throw new Error(`ENOENT: ${path}`);
      }
      return [...dirs[path]!];
    },
  };
}

const WORKSPACE = "/proj";
const HOME = "/home/u";
const USER_PLUGINS = "/home/u/.anycode/plugins";
const STATE_PATH = defaultPluginStatePath(HOME);

function manifestAt(root: string, manifest: unknown): Record<string, string> {
  return { [`${root}/.anycode-plugin/plugin.json`]: JSON.stringify(manifest) };
}

describe("scanPluginsAdmin", () => {
  it("rows managed entries with tier/status/bookkeeping + dir plugins, ordered tier-then-name", async () => {
    const officialRoot = `${USER_PLUGINS}/.store/essentials/1.0.0`;
    const fs = makeFs({
      dirs: {
        [USER_PLUGINS]: [".store", "legacy-tool"],
        [`${WORKSPACE}/.anycode/plugins`]: ["proj-tool"],
      },
      files: {
        [STATE_PATH]: JSON.stringify({
          version: 1,
          plugins: {
            essentials: {
              source: { kind: "official" },
              trust: "official",
              active: "1.0.0",
              previous: "0.9.0",
              enabled: true,
              pinned: false,
              installedAt: "2026-10-24T00:00:00Z",
              capabilities: ["skills"],
            },
          },
          removedDefaults: [],
          disabled: [],
        }),
        ...manifestAt(officialRoot, {
          manifestVersion: 1,
          name: "essentials",
          version: "1.0.0",
          displayName: "AnyCode Essentials",
          skills: ["skills"],
          agents: [],
          workflows: [],
        }),
        ...manifestAt(`${WORKSPACE}/.anycode/plugins/proj-tool`, {
          name: "proj-tool",
          version: "2.0.0",
          skills: [],
          agents: [],
          workflows: [],
        }),
        ...manifestAt(`${USER_PLUGINS}/legacy-tool`, {
          name: "legacy-tool",
          skills: [],
          agents: [],
          workflows: [],
        }),
      },
    });

    const result = await scanPluginsAdmin(fs, { workspace: WORKSPACE, home: HOME });
    expect(result.problems).toEqual([]);

    const byName = new Map(result.rows.map((r) => [r.name, r]));
    expect(result.rows.map((r) => r.name)).toEqual([
      "proj-tool", // project tier first
      "essentials", // official
      "legacy-tool", // legacy-user
    ]);

    const official = byName.get("essentials")!;
    expect(official.tier).toBe("official");
    expect(official.status).toBe("active");
    expect(official.version).toBe("1.0.0");
    expect(official.displayName).toBe("AnyCode Essentials");
    expect(official.managed).toMatchObject({ active: "1.0.0", previous: "0.9.0", enabled: true });
    expect(official.capabilities).toMatchObject({ skills: 1, agents: 0, workflows: 0 });
    expect(official.root).toBe(officialRoot);

    const proj = byName.get("proj-tool")!;
    expect(proj.tier).toBe("project");
    expect(proj.source.kind).toBe("dir");
    expect(proj.managed).toBeUndefined();

    const legacy = byName.get("legacy-tool")!;
    expect(legacy.tier).toBe("legacy-user");
  });

  it("a disabled plugin row carries status disabled; consent state is per-plugin and hash-current", async () => {
    const servers = { alpha: { command: "node", args: ["a.js"] } };
    const officialRoot = `${USER_PLUGINS}/.store/essentials/1.0.0`;
    const consent: McpConsentEntry[] = [
      { plugin: "essentials", serversHash: serversHash(servers), grantedAt: "2026-10-24T00:00:00Z" },
    ];
    const fs = makeFs({
      dirs: { [USER_PLUGINS]: [".store"] },
      files: {
        [STATE_PATH]: JSON.stringify({
          version: 1,
          plugins: {
            essentials: {
              source: { kind: "official" },
              trust: "official",
              active: "1.0.0",
              enabled: true,
              pinned: false,
              capabilities: [],
            },
          },
          removedDefaults: [],
          disabled: ["essentials"],
        }),
        ...manifestAt(officialRoot, {
          name: "essentials",
          version: "1.0.0",
          skills: [],
          agents: [],
          workflows: [],
          mcpServers: servers,
        }),
      },
    });

    const result = await scanPluginsAdmin(fs, {
      workspace: WORKSPACE,
      home: HOME,
      mcpConsent: consent,
    });
    const row = result.rows.find((r) => r.name === "essentials")!;
    expect(row.status).toBe("disabled");
    expect(row.mcpServerNames).toEqual(["alpha"]);
    expect(row.mcpConsentGranted).toBe(true);

    // A stale hash flips consent off.
    const stale: McpConsentEntry[] = [
      { plugin: "essentials", serversHash: "deadbeef", grantedAt: "2026-10-24T00:00:00Z" },
    ];
    const result2 = await scanPluginsAdmin(fs, {
      workspace: WORKSPACE,
      home: HOME,
      mcpConsent: stale,
    });
    expect(result2.rows.find((r) => r.name === "essentials")!.mcpConsentGranted).toBe(false);
  });

  it("a state entry whose install dir is GONE rows as inactive (managed bookkeeping intact)", async () => {
    const fs = makeFs({
      dirs: { [USER_PLUGINS]: [] },
      files: {
        [STATE_PATH]: JSON.stringify({
          version: 1,
          plugins: {
            gone: {
              source: { kind: "url", url: "https://example.com/gone.tgz" },
              trust: "third-party",
              active: "1.2.3",
              enabled: true,
              pinned: false,
              capabilities: [],
            },
          },
          removedDefaults: [],
          disabled: [],
        }),
      },
    });
    const result = await scanPluginsAdmin(fs, { workspace: WORKSPACE, home: HOME });
    const row = result.rows.find((r) => r.name === "gone")!;
    expect(row.status).toBe("inactive");
    expect(row.tier).toBe("third-party");
    expect(row.source).toEqual({ kind: "url", url: "https://example.com/gone.tgz" });
    expect(row.managed?.active).toBe("1.2.3");
  });

  it("corrupt state.json is fail-soft: one problem, dir plugins still row", async () => {
    const fs = makeFs({
      dirs: {
        [USER_PLUGINS]: ["legacy-tool"],
        [`${WORKSPACE}/.anycode/plugins`]: ["proj-tool"],
      },
      files: {
        [STATE_PATH]: "{ corrupt",
        ...manifestAt(`${USER_PLUGINS}/legacy-tool`, { name: "legacy-tool", skills: [], agents: [], workflows: [] }),
        ...manifestAt(`${WORKSPACE}/.anycode/plugins/proj-tool`, { name: "proj-tool", skills: [], agents: [], workflows: [] }),
      },
    });
    const result = await scanPluginsAdmin(fs, { workspace: WORKSPACE, home: HOME });
    expect(result.problems.some((p) => p.includes("Invalid JSON in plugin state"))).toBe(true);
    expect(result.rows.map((r) => r.name).sort()).toEqual(["legacy-tool", "proj-tool"]);
  });

  it("an incompatible plugin (engines range vs appVersion) rows as inactive with the reason", async () => {
    const fs = makeFs({
      dirs: { [USER_PLUGINS]: ["future"] },
      files: {
        ...manifestAt(`${USER_PLUGINS}/future`, {
          name: "future",
          version: "9.0.0",
          engines: { anycode: ">=99.0.0" },
          skills: [],
          agents: [],
          workflows: [],
        }),
      },
    });
    const result = await scanPluginsAdmin(fs, {
      workspace: WORKSPACE,
      home: HOME,
      appVersion: "0.1.7",
    });
    const row = result.rows.find((r) => r.name === "future")!;
    expect(row.status).toBe("inactive");
    expect(row.problems.some((p) => p.includes("incompatible"))).toBe(true);
  });

  it("empty world: zero rows, zero problems", async () => {
    const result = await scanPluginsAdmin(makeFs({}), { workspace: WORKSPACE, home: HOME });
    expect(result.rows).toEqual([]);
    expect(result.problems).toEqual([]);
  });

  it("defaultPluginStatePath resolves under the user plugins root", () => {
    expect(defaultPluginStatePath(HOME)).toBe(`${USER_PLUGINS}/state.json`);
    expect(defaultPluginStatePath(`${HOME}/`)).toBe(`${USER_PLUGINS}/state.json`);
  });
});
