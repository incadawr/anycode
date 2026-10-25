/**
 * Tests for the managed plugin store (Taskana 4732 S1-B, design §5 +
 * executor addendum): install, atomic swap (crash between rename and state
 * write keeps the OLD pointer), rollback+pin, tombstone, GC, capability
 * growth blocks auto-update, app-version reselect, state.json hardening
 * (name pattern / strict semver `active`), staging wipe, legacy MCP
 * grandfathering. All fixtures in-memory: a fake fs + a fetch that serves
 * fixture tars built with makeTarball.
 */

import { describe, expect, it } from "vitest";
import { makeTarball } from "./archive.js";
import type { PluginIndex, PluginIndexEntry } from "./index-client.js";
import {
  capabilitiesSubset,
  createArchiveFetch,
  gcStore,
  installFromBytes,
  installFromIndex,
  installLocalLink,
  legacyMcpGrandfathering,
  removePlugin,
  rollbackPlugin,
  runUpdatePass,
  reselectAfterAppUpdate,
  selectUpdate,
  setEnabled,
  setPinned,
  wipeStaging,
  type PluginStoreFs,
} from "./store.js";
import { statePath } from "./store.js";
import { isStoreNameSafe, isStoreVersionSafe, sanitizePluginState } from "./store-state.js";

// ── fake fs (directories tracked as a Set; files as a Map) ──

function makeFs() {
  const files = new Map<string, string>(); // text files
  const binaries = new Map<string, Buffer>();
  const dirs = new Set<string>();
  const ensured = (path: string) => {
    // register every ancestor
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      dirs.add(parts.slice(0, i).join("/"));
    }
  };
  const fs: PluginStoreFs = {
    readFile: async (path) => {
      const text = files.get(path);
      if (text !== undefined) return text;
      const bin = binaries.get(path);
      if (bin !== undefined) return bin.toString("utf8");
      throw new Error(`ENOENT ${path}`);
    },
    writeFile: async (path, content) => {
      ensured(path);
      files.set(path, content);
    },
    writeFileBytes: async (path, data) => {
      ensured(path);
      binaries.set(path, data);
    },
    exists: async (path) => files.has(path) || binaries.has(path) || dirs.has(path),
    stat: async (path) => {
      if (files.has(path) || binaries.has(path)) {
        return { size: (files.get(path) ?? binaries.get(path))!.length, mtimeMs: 0, isFile: true, isDirectory: false };
      }
      if (dirs.has(path)) return { size: 0, mtimeMs: 0, isFile: false, isDirectory: true };
      throw new Error(`ENOENT ${path}`);
    },
    mkdir: async (path) => {
      ensured(path);
      dirs.add(path);
    },
    readdir: async (path) => {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const names = new Set<string>();
      for (const key of [...files.keys(), ...binaries.keys(), ...dirs]) {
        if (key.startsWith(prefix) && !key.slice(prefix.length).includes("/")) {
          names.add(key.slice(prefix.length));
        } else if (key.startsWith(prefix)) {
          names.add(key.slice(prefix.length).split("/")[0]!);
        }
      }
      return [...names];
    },
    rename: async (from, to) => {
      // directory-tree move (staging -> store)
      const moves: [string, string][] = [];
      for (const key of [...files.keys()]) if (key === from || key.startsWith(`${from}/`)) moves.push([key, to + key.slice(from.length)]);
      for (const key of [...binaries.keys()]) if (key === from || key.startsWith(`${from}/`)) moves.push([key, to + key.slice(from.length)]);
      for (const [src, dest] of moves) {
        const text = files.get(src);
        if (text !== undefined) {
          files.delete(src);
          files.set(dest, text);
        } else {
          const bin = binaries.get(src)!;
          binaries.delete(src);
          binaries.set(dest, bin);
        }
        ensured(dest);
      }
      dirs.delete(from);
      ensured(to);
      dirs.add(to);
    },
    rm: async (path) => {
      files.delete(path);
      binaries.delete(path);
      dirs.delete(path);
      for (const key of [...files.keys()]) if (key.startsWith(`${path}/`)) files.delete(key);
      for (const key of [...binaries.keys()]) if (key.startsWith(`${path}/`)) binaries.delete(key);
      for (const key of [...dirs]) if (key.startsWith(`${path}/`)) dirs.delete(key);
    },
  };
  return { fs, files, binaries, dirs };
}

// ── fixture archives ──

function pluginTar(name: string, version: string, extras: { mcpServers?: Record<string, unknown>; skills?: boolean; engines?: string } = {}): Buffer {
  const manifest: Record<string, unknown> = {
    manifestVersion: 1,
    name,
    version,
    displayName: name,
    description: "fixture",
    skills: ["skills"],
    agents: ["agents"],
    ...(extras.engines !== undefined ? { engines: { anycode: extras.engines } } : {}),
    ...(extras.mcpServers !== undefined ? { mcpServers: extras.mcpServers } : {}),
  };
  return makeTarball([
    { path: ".anycode-plugin/plugin.json", data: JSON.stringify(manifest) },
    { path: "skills", type: "dir" },
    { path: "skills/research/SKILL.md", data: `---\nname: research\n---\n${name} skill` },
    { path: "agents/planner.md", data: "---\nname: planner\ndescription: plan\n---\n" },
  ]);
}

function makeIndex(entries: Partial<PluginIndexEntry>[], serial = 42): PluginIndex {
  return {
    schemaVersion: "anycode.plugins-index.v1",
    serial,
    issuedAt: "2026-10-01T00:00:00.000Z",
    expiresAt: "2026-12-01T00:00:00.000Z",
    plugins: entries.map((entry) => ({
      name: entry.name!,
      default: entry.default ?? false,
      versions: entry.versions!,
      ...(entry.displayName !== undefined ? { displayName: entry.displayName } : {}),
      ...(entry.description !== undefined ? { description: entry.description } : {}),
    })),
  };
}

function versionEntry(version: string, tar: Buffer, capabilities: string[] = ["skills", "agents"], engines?: string) {
  return {
    version,
    ...(engines !== undefined ? { engines: { anycode: engines } } : {}),
    url: `https://github.com/incadawr/anycode-plugins/releases/download/x-v${version}/x-${version}.tgz`,
    sha256: sha256Of(tar),
    size: tar.length,
    capabilities,
  };
}

import { createHash } from "node:crypto";
function sha256Of(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function storeFetch(routes: Record<string, Buffer>) {
  return async (url: string) => {
    const bytes = routes[url];
    if (bytes === undefined) return { ok: false as const, reason: "network" as const };
    return { ok: true as const, bytes };
  };
}

const HOME = "/home/tester";

function opts(overrides: Partial<Parameters<typeof installFromIndex>[0]> = {}) {
  const { fs } = makeFs();
  return {
    home: HOME,
    appVersion: "0.0.36",
    fs,
    fetchImpl: storeFetch({}),
    now: () => Date.parse("2026-10-10T00:00:00.000Z"),
    randomId: () => "fixed-id",
    ...overrides,
  };
}

describe("store-state hardening (addendum)", () => {
  it("isStoreVersionSafe rejects path-bearing junk", () => {
    expect(isStoreVersionSafe("1.4.2")).toBe(true);
    expect(isStoreVersionSafe("1.4.2-beta.1")).toBe(true);
    expect(isStoreVersionSafe("../../etc")).toBe(false);
    expect(isStoreVersionSafe("1.4.2/../../x")).toBe(false);
    expect(isStoreVersionSafe("..")).toBe(false);
    expect(isStoreVersionSafe("v1.4.2")).toBe(false); // not strict semver
    expect(isStoreVersionSafe("1.4")).toBe(false);
    expect(isStoreVersionSafe("1.4.2.4")).toBe(false);
  });

  it("isStoreNameSafe enforces the manifest name pattern", () => {
    expect(isStoreNameSafe("anycode-essentials")).toBe(true);
    expect(isStoreNameSafe("../evil")).toBe(false);
    expect(isStoreNameSafe("a/b")).toBe(false);
    expect(isStoreNameSafe(".hidden")).toBe(false);
    expect(isStoreNameSafe("")).toBe(false);
  });

  it("sanitizePluginState drops invalid entries with problems and keeps valid ones", () => {
    const state = {
      version: 1 as const,
      plugins: {
        ok: {
          source: { kind: "official" as const },
          trust: "official" as const,
          active: "1.0.0",
          enabled: true,
          pinned: false,
          capabilities: [],
        },
        "bad/name": {
          source: { kind: "official" as const },
          trust: "official" as const,
          active: "1.0.0",
          enabled: true,
          pinned: false,
          capabilities: [],
        },
        escape: {
          source: { kind: "official" as const },
          trust: "official" as const,
          active: "../../../etc",
          enabled: true,
          pinned: false,
          capabilities: [],
        },
        badPrev: {
          source: { kind: "official" as const },
          trust: "official" as const,
          active: "1.0.0",
          previous: "1.0.0/..",
          enabled: true,
          pinned: false,
          capabilities: [],
        },
      },
      removedDefaults: [],
      disabled: ["fine", "../bad"],
    };
    const result = sanitizePluginState(state, []);
    expect(Object.keys(result.state.plugins)).toEqual(["ok"]);
    expect(result.state.disabled).toEqual(["fine"]);
    expect(result.problems.length).toBeGreaterThanOrEqual(4);
  });

  it("a hand-corrupted state.json never yields an escaping store path (readSanitizedState)", async () => {
    const { fs, files } = makeFs();
    files.set(`${HOME}/.anycode/plugins/state.json`, JSON.stringify({
      version: 1,
      plugins: {
        evil: { source: { kind: "official" }, trust: "official", active: "../../..", enabled: true, pinned: false, capabilities: [] },
      },
      removedDefaults: [],
      disabled: [],
    }));
    const { readSanitizedState } = await import("./store.js");
    const { state, problems } = await readSanitizedState(fs, HOME);
    expect(state.plugins.evil).toBeUndefined();
    expect(problems.some((p) => p.includes("evil"))).toBe(true);
  });
});

describe("installFromIndex", () => {
  it("installs a pinned official artifact into .store and writes state", async () => {
    const tar = pluginTar("anycode-essentials", "1.0.0");
    const index = makeIndex([{ name: "anycode-essentials", default: true, versions: [versionEntry("1.0.0", tar)] }]);
    const store = opts({ fetchImpl: storeFetch({ [index.plugins[0]!.versions[0]!.url]: tar }) });
    const result = await installFromIndex(store, index, { name: "anycode-essentials" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.name).toBe("anycode-essentials");
    expect(result.value.version).toBe("1.0.0");
    // store dir exists with the manifest
    const manifest = await store.fs.readFile(`${HOME}/.anycode/plugins/.store/anycode-essentials/1.0.0/.anycode-plugin/plugin.json`);
    expect(JSON.parse(manifest).name).toBe("anycode-essentials");
    // state entry
    const state = JSON.parse(await store.fs.readFile(`${HOME}/.anycode/plugins/state.json`));
    expect(state.plugins["anycode-essentials"].active).toBe("1.0.0");
    expect(state.plugins["anycode-essentials"].trust).toBe("official");
  });

  it("refuses a sha256 mismatch (integrity)", async () => {
    const tar = pluginTar("p", "1.0.0");
    const tampered = pluginTar("p", "1.0.0"); // same bytes... make different
    const different = makeTarball([
      { path: ".anycode-plugin/plugin.json", data: JSON.stringify({ name: "p", version: "1.0.0", skills: ["skills"], agents: ["agents"] }) },
      { path: "skills/extra/SKILL.md", data: "---\nname: extra\n---\nchanged bytes" },
    ]);
    const index = makeIndex([{ name: "p", versions: [versionEntry("1.0.0", different)] }]);
    const store = opts({ fetchImpl: storeFetch({ [index.plugins[0]!.versions[0]!.url]: tar }) });
    const result = await installFromIndex(store, index, { name: "p" });
    expect(result).toMatchObject({ ok: false, reason: "integrity" });
  });

  it("refuses a name mismatch between request and manifest", async () => {
    const tar = pluginTar("other-name", "1.0.0");
    const index = makeIndex([{ name: "wanted", versions: [versionEntry("1.0.0", tar)] }]);
    const store = opts({ fetchImpl: storeFetch({ [index.plugins[0]!.versions[0]!.url]: tar }) });
    const result = await installFromIndex(store, index, { name: "wanted" });
    expect(result).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("refuses an incompatible version (engines)", async () => {
    const tar = pluginTar("p", "2.0.0", { engines: ">=99.0.0" });
    const index = makeIndex([{ name: "p", versions: [versionEntry("2.0.0", tar, ["skills"], ">=99.0.0")] }]);
    const store = opts({ fetchImpl: storeFetch({ [index.plugins[0]!.versions[0]!.url]: tar }) });
    const result = await installFromIndex(store, index, { name: "p" });
    expect(result).toMatchObject({ ok: false, reason: "incompatible" });
  });
});

describe("atomic swap + crash safety", () => {
  it("crash between rename and state write keeps the old pointer", async () => {
    const v1 = pluginTar("p", "1.0.0");
    const v2 = pluginTar("p", "1.1.0");
    const index = makeIndex([
      { name: "p", versions: [versionEntry("1.0.0", v1), versionEntry("1.1.0", v2)] },
    ]);
    const store = opts({ fetchImpl: storeFetch({
      [index.plugins[0]!.versions[0]!.url]: v1,
      [index.plugins[0]!.versions[1]!.url]: v2,
    }) });
    await installFromIndex(store, index, { name: "p", version: "1.0.0" });

    // Simulate the crash: wrap fs so the STATE WRITE after the rename throws.
    // atomicWriteText writes `state.json.tmp-...` then renames — fail the RENAME.
    const statePath = `${HOME}/.anycode/plugins/state.json`;
    const originalWrite = store.fs.writeFile.bind(store.fs);
    const originalRename = store.fs.rename.bind(store.fs);
    let renameCount = 0;
    const crashingFs: PluginStoreFs = {
      ...store.fs,
      writeFile: async (path, content, o) => {
        if (path.startsWith(`${statePath}.tmp-`)) {
          renameCount += 1;
          throw new Error("simulated crash after plugin rename, before state write");
        }
        return originalWrite(path, content, o);
      },
      rename: async (from, to) => {
        await originalRename(from, to);
      },
    };
    const result = await installFromIndex({ ...store, fs: crashingFs }, index, { name: "p", version: "1.1.0" });
    expect(result).toMatchObject({ ok: false, reason: "io_error" });
    expect(renameCount).toBeGreaterThan(0);
    // The OLD pointer survived...
    const state = JSON.parse(await store.fs.readFile(statePath));
    expect(state.plugins.p.active).toBe("1.0.0");
    // ...and the 1.1.0 dir landed in the store anyway (GC material, next boot).
    expect(await store.fs.exists(`${HOME}/.anycode/plugins/.store/p/1.1.0/.anycode-plugin/plugin.json`)).toBe(true);
  });

  it("an update rewrites state with previous=old active", async () => {
    const v1 = pluginTar("p", "1.0.0");
    const v2 = pluginTar("p", "1.1.0");
    const index = makeIndex([{ name: "p", versions: [versionEntry("1.0.0", v1), versionEntry("1.1.0", v2)] }]);
    const store = opts({ fetchImpl: storeFetch({
      [index.plugins[0]!.versions[0]!.url]: v1,
      [index.plugins[0]!.versions[1]!.url]: v2,
    }) });
    await installFromIndex(store, index, { name: "p", version: "1.0.0" });
    await installFromIndex(store, index, { name: "p", version: "1.1.0" });
    const state = JSON.parse(await store.fs.readFile(`${HOME}/.anycode/plugins/state.json`));
    expect(state.plugins.p.active).toBe("1.1.0");
    expect(state.plugins.p.previous).toBe("1.0.0");
  });
});

describe("rollback + GC", () => {
  async function installedTwoVersions() {
    const v1 = pluginTar("p", "1.0.0");
    const v2 = pluginTar("p", "1.1.0");
    const v3 = pluginTar("p", "1.2.0");
    const index = makeIndex([{ name: "p", versions: [versionEntry("1.0.0", v1), versionEntry("1.1.0", v2), versionEntry("1.2.0", v3)] }]);
    const store = opts({ fetchImpl: storeFetch({
      [index.plugins[0]!.versions[0]!.url]: v1,
      [index.plugins[0]!.versions[1]!.url]: v2,
      [index.plugins[0]!.versions[2]!.url]: v3,
    }) });
    await installFromIndex(store, index, { name: "p", version: "1.0.0" });
    await installFromIndex(store, index, { name: "p", version: "1.1.0" });
    return { store, index, v3, v2, v1 };
  }

  it("rollback swaps active/previous and pins", async () => {
    const { store } = await installedTwoVersions();
    const result = await rollbackPlugin(store, "p");
    expect(result.ok).toBe(true);
    const state = JSON.parse(await store.fs.readFile(`${HOME}/.anycode/plugins/state.json`));
    expect(state.plugins.p.active).toBe("1.0.0");
    expect(state.plugins.p.previous).toBe("1.1.0");
    expect(state.plugins.p.pinned).toBe(true);
  });

  it("GC removes versions not in {active, previous} and orphans", async () => {
    const { store } = await installedTwoVersions();
    // hand-plant an extra version dir
    await store.fs.mkdir(`${HOME}/.anycode/plugins/.store/p/0.9.0`);
    // and an orphan plugin dir with no state entry
    await store.fs.mkdir(`${HOME}/.anycode/plugins/.store/ghost/1.0.0`);
    const result = await gcStore(store.fs, HOME);
    expect(result.removed).toContain("p/0.9.0");
    expect(await store.fs.exists(`${HOME}/.anycode/plugins/.store/p/1.0.0`)).toBe(true); // previous kept
    expect(await store.fs.exists(`${HOME}/.anycode/plugins/.store/p/1.1.0`)).toBe(true); // active kept
    expect(await store.fs.exists(`${HOME}/.anycode/plugins/.store/ghost`)).toBe(false);
  });

  it("wipeStaging clears staging residue", async () => {
    const { fs } = makeFs();
    await fs.mkdir(`${HOME}/.anycode/plugins/.staging/leftover`);
    await fs.writeFile(`${HOME}/.anycode/plugins/.staging/leftover/x.txt`, "x");
    await wipeStaging(fs, HOME);
    expect(await fs.exists(`${HOME}/.anycode/plugins/.staging/leftover`)).toBe(false);
  });
});

describe("remove + tombstone", () => {
  it("remove of a default plugin tombstones it (no silent reinstall)", async () => {
    const tar = pluginTar("p", "1.0.0");
    const index = makeIndex([{ name: "p", default: true, versions: [versionEntry("1.0.0", tar)] }]);
    const store = opts({ fetchImpl: storeFetch({ [index.plugins[0]!.versions[0]!.url]: tar }) });
    await installFromIndex(store, index, { name: "p" });
    const removed = await removePlugin(store, "p", true);
    expect(removed.ok).toBe(true);
    const state = JSON.parse(await store.fs.readFile(`${HOME}/.anycode/plugins/state.json`));
    expect(state.plugins.p).toBeUndefined();
    expect(state.removedDefaults).toContain("p");
    // the update pass must NOT reinstall it
    const pass = await runUpdatePass({ ...store, checkIndex: async () => ({ status: "ok", index }), autoUpdateOfficial: true });
    expect(pass.installed).toEqual([]);
  });
});

describe("auto-update policy", () => {
  it("capability growth blocks auto-update (needs approval)", async () => {
    const v1 = pluginTar("p", "1.0.0");
    const v2 = pluginTar("p", "1.1.0", { mcpServers: { server: { command: "npx", args: ["-y", "evil"] } } });
    const index = makeIndex([
      { name: "p", default: true, versions: [versionEntry("1.0.0", v1, ["skills", "agents"]), versionEntry("1.1.0", v2, ["skills", "agents", "mcp:server"])] },
    ]);
    const store = opts({ fetchImpl: storeFetch({
      [index.plugins[0]!.versions[0]!.url]: v1,
      [index.plugins[0]!.versions[1]!.url]: v2,
    }) });
    await installFromIndex(store, index, { name: "p", version: "1.0.0" });
    const pass = await runUpdatePass({ ...store, checkIndex: async () => ({ status: "ok", index }), autoUpdateOfficial: true });
    expect(pass.installed).toEqual([]);
    expect(pass.needsApproval).toEqual([{ name: "p", version: "1.1.0", needsApproval: true }]);
  });

  it("non-growing capability set auto-updates within one check", async () => {
    const v1 = pluginTar("p", "1.0.0");
    const v2 = pluginTar("p", "1.0.1");
    const index = makeIndex([
      { name: "p", default: true, versions: [versionEntry("1.0.0", v1), versionEntry("1.0.1", v2)] },
    ]);
    const store = opts({ fetchImpl: storeFetch({
      [index.plugins[0]!.versions[0]!.url]: v1,
      [index.plugins[0]!.versions[1]!.url]: v2,
    }) });
    await installFromIndex(store, index, { name: "p", version: "1.0.0" });
    const pass = await runUpdatePass({ ...store, checkIndex: async () => ({ status: "ok", index }), autoUpdateOfficial: true });
    expect(pass.installed).toEqual([{ name: "p", from: "1.0.0", to: "1.0.1" }]);
  });

  it("auto-update honours autoUpdateOfficial=false", async () => {
    const v1 = pluginTar("p", "1.0.0");
    const v2 = pluginTar("p", "1.0.1");
    const index = makeIndex([{ name: "p", default: true, versions: [versionEntry("1.0.0", v1), versionEntry("1.0.1", v2)] }]);
    const store = opts({ fetchImpl: storeFetch({
      [index.plugins[0]!.versions[0]!.url]: v1,
      [index.plugins[0]!.versions[1]!.url]: v2,
    }) });
    await installFromIndex(store, index, { name: "p", version: "1.0.0" });
    const pass = await runUpdatePass({ ...store, checkIndex: async () => ({ status: "ok", index }), autoUpdateOfficial: false });
    expect(pass.installed).toEqual([]);
    expect(pass.needsApproval.length).toBe(1);
  });

  it("a default plugin with MCP does NOT auto-install silently", async () => {
    const tar = pluginTar("p", "1.0.0", { mcpServers: { server: { command: "npx", args: [] } } });
    const index = makeIndex([{ name: "p", default: true, versions: [versionEntry("1.0.0", tar, ["skills", "mcp:server"])] }]);
    const store = opts({ fetchImpl: storeFetch({ [index.plugins[0]!.versions[0]!.url]: tar }) });
    const pass = await runUpdatePass({ ...store, checkIndex: async () => ({ status: "ok", index }), autoUpdateOfficial: true });
    expect(pass.installed).toEqual([]);
  });

  it("a clean default plugin auto-installs silently", async () => {
    const tar = pluginTar("p", "1.0.0");
    const index = makeIndex([{ name: "p", default: true, versions: [versionEntry("1.0.0", tar)] }]);
    const store = opts({ fetchImpl: storeFetch({ [index.plugins[0]!.versions[0]!.url]: tar }) });
    const pass = await runUpdatePass({ ...store, checkIndex: async () => ({ status: "ok", index }), autoUpdateOfficial: true });
    expect(pass.installed).toEqual([{ name: "p", from: "(none)", to: "1.0.0" }]);
  });

  it("records lastIndexSerial for anti-rollback", async () => {
    const tar = pluginTar("p", "1.0.0");
    const index = makeIndex([{ name: "p", default: false, versions: [versionEntry("1.0.0", tar)] }], 77);
    const store = opts({ fetchImpl: storeFetch({ [index.plugins[0]!.versions[0]!.url]: tar }) });
    await runUpdatePass({ ...store, checkIndex: async () => ({ status: "ok", index }), autoUpdateOfficial: true });
    const state = JSON.parse(await store.fs.readFile(`${HOME}/.anycode/plugins/state.json`));
    expect(state.lastIndexSerial).toBe(77);
  });

  it("selectUpdate skips pinned plugins", () => {
    const index = makeIndex([{ name: "p", versions: [versionEntry("1.0.0", pluginTar("p", "1.0.0")), versionEntry("1.1.0", pluginTar("p", "1.1.0"))] }]);
    expect(selectUpdate(index, { name: "p", active: "1.0.0", pinned: true }, "0.0.36")).toBeUndefined();
    expect(selectUpdate(index, { name: "p", active: "1.0.0", pinned: false }, "0.0.36")).toMatchObject({ version: "1.1.0" });
    expect(selectUpdate(index, { name: "p", active: "1.1.0", pinned: false }, "0.0.36")).toBeUndefined();
  });

  it("capabilitiesSubset is the auto gate", () => {
    expect(capabilitiesSubset(["skills", "agents"], ["skills"])).toBe(true);
    expect(capabilitiesSubset(["skills"], ["skills", "mcp:x"])).toBe(false);
  });
});

describe("app-version reselect", () => {
  it("switches an incompatible active to a compatible version after an app update", async () => {
    const oldTar = pluginTar("p", "1.0.0", { engines: ">=0.0.30 <0.1.0" });
    const newTar = pluginTar("p", "1.1.0", { engines: ">=0.1.0" });
    const index = makeIndex([{ name: "p", versions: [versionEntry("1.0.0", oldTar, ["skills"], ">=0.0.30 <0.1.0"), versionEntry("1.1.0", newTar, ["skills"], ">=0.1.0")] }]);
    // install under an OLD app version
    const store = opts({ appVersion: "0.0.36", fetchImpl: storeFetch({
      [index.plugins[0]!.versions[0]!.url]: oldTar,
      [index.plugins[0]!.versions[1]!.url]: newTar,
    }) });
    await installFromIndex(store, index, { name: "p", version: "1.0.0" });
    // app updated to 0.1.0: active 1.0.0 now incompatible
    const result = await reselectAfterAppUpdate({ ...store, appVersion: "0.1.0", checkIndex: async () => ({ status: "ok", index }) });
    expect(result.switched).toEqual([{ name: "p", from: "1.0.0", to: "1.1.0" }]);
    const state = JSON.parse(await store.fs.readFile(`${HOME}/.anycode/plugins/state.json`));
    expect(state.plugins.p.active).toBe("1.1.0");
  });
});

describe("file / local sources", () => {
  it("installFromBytes installs a picked tgz as third-party", async () => {
    const tar = pluginTar("handmade", "0.2.0");
    const store = opts({});
    const result = await installFromBytes(store, tar, { fileName: "handmade-0.2.0.tgz" });
    expect(result.ok).toBe(true);
    const state = JSON.parse(await store.fs.readFile(`${HOME}/.anycode/plugins/state.json`));
    expect(state.plugins.handmade.trust).toBe("third-party");
    expect(state.plugins.handmade.source).toEqual({ kind: "file", fileName: "handmade-0.2.0.tgz" });
  });

  it("installLocalLink records the absolute path without copying", async () => {
    const { fs } = makeFs();
    await fs.mkdir("/dev/plugin-x/.anycode-plugin");
    await fs.writeFile("/dev/plugin-x/.anycode-plugin/plugin.json", JSON.stringify({ name: "plugin-x", version: "9.9.9", skills: ["skills"], agents: ["agents"] }));
    const store = opts({ fs });
    const result = await installLocalLink(store, "/dev/plugin-x");
    expect(result.ok).toBe(true);
    const state = JSON.parse(await store.fs.readFile(`${HOME}/.anycode/plugins/state.json`));
    expect(state.plugins["plugin-x"]).toMatchObject({ trust: "local", active: "9.9.9", source: { kind: "local", path: "/dev/plugin-x" } });
    // nothing was copied into .store
    expect(await fs.exists(`${HOME}/.anycode/plugins/.store/plugin-x`)).toBe(false);
  });

  it("local links refuse rollback (read_only_source)", async () => {
    const { fs } = makeFs();
    await fs.mkdir("/dev/plugin-x/.anycode-plugin");
    await fs.writeFile("/dev/plugin-x/.anycode-plugin/plugin.json", JSON.stringify({ name: "plugin-x", version: "9.9.9", skills: ["skills"], agents: ["agents"] }));
    const store = opts({ fs });
    await installLocalLink(store, "/dev/plugin-x");
    const result = await rollbackPlugin(store, "plugin-x");
    expect(result).toMatchObject({ ok: false, reason: "read_only_source" });
  });
});

describe("enable/pin state", () => {
  it("setEnabled toggles the user-global disabled list", async () => {
    const tar = pluginTar("p", "1.0.0");
    const index = makeIndex([{ name: "p", default: true, versions: [versionEntry("1.0.0", tar)] }]);
    const store = opts({ fetchImpl: storeFetch({ [index.plugins[0]!.versions[0]!.url]: tar }) });
    await installFromIndex(store, index, { name: "p" });
    await setEnabled(store, "p", false);
    let state = JSON.parse(await store.fs.readFile(`${HOME}/.anycode/plugins/state.json`));
    expect(state.disabled).toContain("p");
    await setEnabled(store, "p", true);
    state = JSON.parse(await store.fs.readFile(`${HOME}/.anycode/plugins/state.json`));
    expect(state.disabled).not.toContain("p");
    await setPinned(store, "p", true);
    state = JSON.parse(await store.fs.readFile(`${HOME}/.anycode/plugins/state.json`));
    expect(state.plugins.p.pinned).toBe(true);
  });
});

describe("legacy MCP grandfathering", () => {
  it("grants consent for existing legacy user-dir MCP plugins once", async () => {
    const { fs, files } = makeFs();
    const legacyManifest = {
      name: "old-faithful",
      skills: ["skills"],
      agents: ["agents"],
      mcpServers: { helper: { command: "node", args: ["helper.js"] } },
    };
    await fs.mkdir(`${HOME}/.anycode/plugins/old-faithful/.anycode-plugin`);
    files.set(`${HOME}/.anycode/plugins/old-faithful/.anycode-plugin/plugin.json`, JSON.stringify(legacyManifest));
    let written: unknown;
    const store = opts({ fs });
    const result = await legacyMcpGrandfathering({
      ...store,
      readMcpConsent: async () => undefined,
      writeMcpConsent: async (entries) => {
        written = entries;
      },
    });
    expect(result.granted).toEqual(["old-faithful"]);
    expect(Array.isArray(written) && written.length === 1).toBe(true);
    // second run: consent exists, skipped
    const second = await legacyMcpGrandfathering({
      ...store,
      readMcpConsent: async () => written as never[],
      writeMcpConsent: async () => {
        throw new Error("must not rewrite");
      },
    });
    expect(second.skipped).toBe(true);
    expect(files.size).toBeGreaterThan(0);
  });
});

// ── Taskana 4732 xfix: store hardening (H3, M2, M3, L2, L7, grandfathering) ──

const ENTRY = { source: { kind: "official" }, trust: "official", active: "1.0.0", enabled: true, pinned: false, capabilities: [] };

describe("installFromBytes pins the previewed bytes (xfix H3)", () => {
  it("refuses bytes that differ from the previewed sha256 and installs the previewed ones", async () => {
    const { fs, files } = makeFs();
    const previewed = pluginTar("p", "1.0.0");
    const swapped = pluginTar("p", "1.0.1");
    const store = opts({ fs });
    const bad = await installFromBytes(store, swapped, { fileName: "p.tgz", expectedSha256: sha256Of(previewed) });
    expect(bad).toMatchObject({ ok: false, reason: "integrity" });
    expect(files.has(statePath(HOME))).toBe(false);

    const good = await installFromBytes(store, previewed, {
      fileName: "p.tgz",
      expectedSha256: sha256Of(previewed),
      source: { kind: "url", url: "https://github.com/a/p.tgz" },
    });
    expect(good.ok).toBe(true);
    const state = JSON.parse(files.get(statePath(HOME))!);
    expect(state.plugins.p.source).toEqual({ kind: "url", url: "https://github.com/a/p.tgz" });
    expect(state.plugins.p.sha256).toBe(sha256Of(previewed));
  });
});

describe("selectUpdate picks the newest compatible version (xfix M3)", () => {
  it("an ascending index list still yields the highest version", () => {
    const t1 = pluginTar("p", "1.0.0");
    const t2 = pluginTar("p", "2.0.0");
    const index = makeIndex([{ name: "p", versions: [versionEntry("1.0.0", t1), versionEntry("2.0.0", t2)] }]);
    expect(selectUpdate(index, { name: "p", active: "0.9.0", pinned: false }, "0.0.36")?.version).toBe("2.0.0");
  });
});

describe("artifact download bounds (xfix M2)", () => {
  it("refuses a body that streams past the compressed cap, without reading the rest", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= 60) {
          controller.close();
          return;
        }
        pulled += 1;
        controller.enqueue(chunk);
      },
    });
    const fetchImpl = async () => new Response(body, { status: 200 });
    const result = await createArchiveFetch(fetchImpl as unknown as typeof fetch)("https://github.com/a/p.tgz");
    // Compare the reason only: a failing run must not dump a 60 MB buffer.
    expect(result.ok ? "ok" : result.reason).toBe("too_large");
    expect(pulled).toBeLessThan(60);
  });

  it("refuses up front when content-length already exceeds the cap", async () => {
    const fetchImpl = async () =>
      new Response(new Uint8Array(8), { status: 200, headers: { "content-length": String(30 * 1024 * 1024) } });
    const result = await createArchiveFetch(fetchImpl as unknown as typeof fetch)("https://github.com/a/p.tgz");
    expect(result).toEqual({ ok: false, reason: "too_large" });
  });

  it("still returns the bytes of an in-cap download", async () => {
    const tar = pluginTar("p", "1.0.0");
    const fetchImpl = async () => new Response(new Uint8Array(tar), { status: 200 });
    const result = await createArchiveFetch(fetchImpl as unknown as typeof fetch)("https://github.com/a/p.tgz");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bytes.equals(tar)).toBe(true);
  });
});

describe("state.json read-modify-write is serialized (xfix L7)", () => {
  it("overlapping mutations all persist (none is lost to a stale snapshot)", async () => {
    const { fs, files } = makeFs();
    files.set(statePath(HOME), JSON.stringify({ version: 1, plugins: { p: ENTRY, q: ENTRY }, removedDefaults: [], disabled: [] }));
    // Reads snapshot the file, then writes land later: unserialized writers
    // would each rewrite the stale snapshot and drop the earlier change.
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const slow: PluginStoreFs = {
      ...fs,
      readFile: async (path) => {
        await pause(2);
        return fs.readFile(path);
      },
      writeFile: async (path, content, o) => {
        await pause(5);
        return fs.writeFile(path, content, o);
      },
    };
    const store = opts({ fs: slow });
    await Promise.all([
      setPinned(store, "p", true),
      setEnabled(store, "p", false),
      setPinned(store, "q", true),
    ]);
    const state = JSON.parse(files.get(statePath(HOME))!);
    expect(state.plugins.p.pinned).toBe(true);
    expect(state.disabled).toContain("p");
    expect(state.plugins.q.pinned).toBe(true);
  });
});

describe("concurrent install and uninstall (xfix L7)", () => {
  it("two installs racing a remove all land in state.json", async () => {
    const { fs, files } = makeFs();
    files.set(statePath(HOME), JSON.stringify({ version: 1, plugins: { gone: ENTRY }, removedDefaults: [], disabled: [] }));
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const slow: PluginStoreFs = {
      ...fs,
      readFile: async (path) => {
        await pause(2);
        return fs.readFile(path);
      },
      writeFile: async (path, content, o) => {
        await pause(5);
        return fs.writeFile(path, content, o);
      },
    };
    const store = opts({ fs: slow });
    const a = pluginTar("alpha", "1.0.0");
    const b = pluginTar("beta", "1.0.0");
    const results = await Promise.all([
      installFromBytes(store, a, { fileName: "a.tgz" }),
      installFromBytes(store, b, { fileName: "b.tgz" }),
      removePlugin(store, "gone", false),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    const state = JSON.parse(files.get(statePath(HOME))!);
    expect(Object.keys(state.plugins).sort()).toEqual(["alpha", "beta"]);
  });
});

describe("update pass policy (xfix L2)", () => {
  it("a user-disabled official plugin is not auto-updated", async () => {
    const { fs, files } = makeFs();
    const t1 = pluginTar("p", "1.0.0");
    const t2 = pluginTar("p", "2.0.0");
    // Capabilities match the index's (no growth) so ONLY the disabled flag can block it.
    const caps = ["skills", "agents"];
    files.set(statePath(HOME), JSON.stringify({ version: 1, plugins: { p: { ...ENTRY, active: "1.0.0", capabilities: caps } }, removedDefaults: [], disabled: ["p"] }));
    const index = makeIndex([{ name: "p", versions: [versionEntry("1.0.0", t1), versionEntry("2.0.0", t2)] }], 50);
    const url2 = index.plugins[0]!.versions[1]!.url;
    const store = opts({ fs, fetchImpl: storeFetch({ [url2]: t2 }) });
    const result = await runUpdatePass({
      ...store,
      checkIndex: async () => ({ status: "ok", index }),
      autoUpdateOfficial: true,
    });
    expect(result.installed).toEqual([]);
    expect(JSON.parse(files.get(statePath(HOME))!).plugins.p.active).toBe("1.0.0");
  });
});

describe("legacy grandfathering marks the migration done (xfix H1)", () => {
  it("writes an empty consent list when there are no legacy MCP plugins", async () => {
    const { fs } = makeFs();
    let written: unknown = "not-called";
    await legacyMcpGrandfathering({
      ...opts({ fs }),
      readMcpConsent: async () => undefined,
      writeMcpConsent: async (entries) => {
        written = entries;
      },
    });
    expect(written).toEqual([]);
  });
});
