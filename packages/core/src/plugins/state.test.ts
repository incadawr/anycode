/**
 * plugins/state tests (Taskana 4732 S1-A, design §3/§4): zod round-trip,
 * defaults, fail-soft reader (absent → empty+no problem; corrupt/invalid →
 * empty+exactly one problem), atomic writer over the real node adapter, and
 * the serversHash consent primitives (canonical JSON determinism, arg-change
 * sensitivity, per-plugin consent matching).
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFileSystemAdapter } from "../adapters/node/node-file-system.js";
import type { FileSystemPort } from "../ports/file-system.js";
import {
  PLUGIN_STATE_FILE,
  PLUGIN_STATE_VERSION,
  canonicalJson,
  emptyPluginState,
  hasMcpConsent,
  pluginsStateSchema,
  readPluginState,
  serversHash,
  servicesHash,
  hasServiceConsent,
  writePluginState,
  type McpConsentEntry,
  type PluginsState,
} from "./state.js";

/** Hermetic in-memory port (same shape as plugins/discovery.test.ts's makeFs). */
function makeFs(files: Record<string, string> = {}): FileSystemPort {
  return {
    readFile: async (path) => {
      const content = files[path];
      if (content === undefined) {
        throw new Error(`ENOENT: ${path}`);
      }
      return content;
    },
    writeFile: async (path, content) => {
      files[path] = content;
    },
    stat: async () => ({ size: 0, mtimeMs: 0, isFile: true, isDirectory: false }),
    exists: async (path) => path in files,
    mkdir: async () => {},
    readdir: async () => [],
  };
}

const STATE_PATH = "/home/u/.anycode/plugins/state.json";

describe("pluginsStateSchema — shape and defaults", () => {
  it("parses the design's canonical example (§3) with defaults applied", () => {
    const result = pluginsStateSchema.safeParse({
      version: 1,
      plugins: {
        "anycode-essentials": {
          source: { kind: "official" },
          trust: "official",
          active: "1.4.2",
          previous: "1.4.1",
          enabled: true,
          pinned: false,
          sha256: "abc",
          installedAt: "2026-10-24T00:00:00Z",
          capabilities: ["skills", "agents"],
        },
        "my-tool": {
          source: { kind: "git", url: "https://example.com/repo", ref: "v1.2.0", commit: "abc123" },
          trust: "third-party",
          active: "1.2.0",
        },
        "dev-link": { source: { kind: "local", path: "/abs/dev" }, trust: "local", active: "0.0.1" },
      },
      removedDefaults: ["legacy-default"],
      disabled: ["unmanaged-plugin-name"],
      lastIndexSerial: 42,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.plugins["my-tool"]!.enabled).toBe(true); // default
      expect(result.data.plugins["my-tool"]!.pinned).toBe(false); // default
      expect(result.data.plugins["my-tool"]!.capabilities).toEqual([]); // default
    }
  });

  it("a minimal state (version only) parses with all-empty collections", () => {
    const result = pluginsStateSchema.safeParse({ version: 1 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.plugins).toEqual({});
      expect(result.data.removedDefaults).toEqual([]);
      expect(result.data.disabled).toEqual([]);
      expect(result.data.lastIndexSerial).toBeUndefined();
    }
  });

  it("rejects an unknown version and an unknown trust tier", () => {
    expect(pluginsStateSchema.safeParse({ version: 2 }).success).toBe(false);
    expect(
      pluginsStateSchema.safeParse({
        version: 1,
        plugins: { p: { source: { kind: "official" }, trust: "shady", active: "1.0.0" } },
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown source kind and a missing active pointer", () => {
    expect(
      pluginsStateSchema.safeParse({
        version: 1,
        plugins: { p: { source: { kind: "npm" }, trust: "official", active: "1.0.0" } },
      }).success,
    ).toBe(false);
    expect(
      pluginsStateSchema.safeParse({
        version: 1,
        plugins: { p: { source: { kind: "official" }, trust: "official" } },
      }).success,
    ).toBe(false);
  });

  it("emptyPluginState matches the canonical empty state", () => {
    expect(emptyPluginState()).toEqual({
      version: PLUGIN_STATE_VERSION,
      plugins: {},
      removedDefaults: [],
      disabled: [],
    });
  });
});

describe("readPluginState — fail-soft reader", () => {
  it("absent file ⇒ empty state, ZERO problems (the pre-4732 world)", async () => {
    const result = await readPluginState(makeFs(), STATE_PATH);
    expect(result.state).toEqual(emptyPluginState());
    expect(result.problems).toEqual([]);
  });

  it("corrupt JSON ⇒ empty state + exactly one problem", async () => {
    const fs = makeFs({ [STATE_PATH]: "{ not json" });
    const result = await readPluginState(fs, STATE_PATH);
    expect(result.state).toEqual(emptyPluginState());
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatch(/Invalid JSON in plugin state/);
  });

  it("schema-invalid state ⇒ empty state + one problem naming the file", async () => {
    const fs = makeFs({ [STATE_PATH]: JSON.stringify({ version: 1, plugins: { p: 7 } }) });
    const result = await readPluginState(fs, STATE_PATH);
    expect(result.state).toEqual(emptyPluginState());
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatch(/Invalid plugin state/);
  });

  it("an unreadable file ⇒ empty state + one problem; never throws", async () => {
    const fs = makeFs();
    (fs.exists as unknown) = async () => true;
    fs.readFile = async () => {
      throw new Error("EACCES");
    };
    const result = await readPluginState(fs, STATE_PATH);
    expect(result.state).toEqual(emptyPluginState());
    expect(result.problems[0]).toMatch(/Could not read plugin state/);
  });

  it("a valid state round-trips through writePluginState → readPluginState", async () => {
    const files: Record<string, string> = {};
    const fs = makeFs(files);
    const state: PluginsState = {
      version: 1,
      plugins: {
        "anycode-essentials": {
          source: { kind: "official" },
          trust: "official",
          active: "1.0.0",
          enabled: true,
          pinned: false,
          capabilities: ["skills"],
        },
      },
      removedDefaults: [],
      disabled: ["noisy"],
    };
    await writePluginState(fs, STATE_PATH, state);
    const back = await readPluginState(fs, STATE_PATH);
    expect(back.problems).toEqual([]);
    expect(back.state).toEqual(state);
  });
});

describe("writePluginState — atomic write over the REAL node adapter", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it("writes 2-space JSON + trailing newline, 0644, and round-trips", async () => {
    dir = await mkdtemp(join(tmpdir(), "anycode-plugin-state-"));
    const path = join(dir, PLUGIN_STATE_FILE);
    const fs = new NodeFileSystemAdapter();
    await writePluginState(fs, path, emptyPluginState());
    const raw = await readFile(path, "utf8");
    expect(raw).toBe(`${JSON.stringify(emptyPluginState(), null, 2)}\n`);
    const mode = (await stat(path)).mode & 0o777;
    expect(mode).toBe(0o644);
    const back = await readPluginState(fs, path);
    expect(back.state).toEqual(emptyPluginState());
  });

  it("overwriting an existing state replaces it atomically (single state.json, no tmp residue)", async () => {
    dir = await mkdtemp(join(tmpdir(), "anycode-plugin-state-"));
    const path = join(dir, PLUGIN_STATE_FILE);
    const fs = new NodeFileSystemAdapter();
    await writeFile(path, JSON.stringify({ version: 1, plugins: {}, disabled: ["old"] }), "utf8");
    const next: PluginsState = { ...emptyPluginState(), disabled: [] };
    await writePluginState(fs, path, next);
    const back = await readPluginState(fs, path);
    expect(back.state.disabled).toEqual([]);
    // No tmp files left behind next to the target.
    expect(await readdir(dir)).toEqual([PLUGIN_STATE_FILE]);
  });
});

describe("serversHash / consent (design §4)", () => {
  const servers = { alpha: { command: "node", args: ["a.js"] }, beta: { url: "https://x/y" } };

  it("is deterministic across key-insertion orders (canonical JSON)", () => {
    const reordered = { beta: servers.beta, alpha: servers.alpha };
    expect(serversHash(servers)).toBe(serversHash(reordered));
  });

  it("changes when ANY command/arg changes — fresh consent required", () => {
    expect(serversHash(servers)).not.toBe(
      serversHash({ alpha: { command: "node", args: ["b.js"] }, beta: servers.beta }),
    );
    expect(serversHash({ a: { command: "node" } })).not.toBe(serversHash({ a: { command: "nod" } }));
  });

  it("changes when the server SET changes (added/removed)", () => {
    expect(serversHash(servers)).not.toBe(serversHash({ ...servers, gamma: { command: "n" } }));
    expect(serversHash(servers)).not.toBe(serversHash({ alpha: servers.alpha }));
  });

  it("undefined and empty maps hash differently from each other and from null-marker collisions", () => {
    expect(serversHash(undefined)).toBe(serversHash(null));
    expect(serversHash(undefined)).not.toBe(serversHash({}));
    expect(serversHash({})).not.toBe(serversHash({ a: { command: "x" } }));
  });

  it("canonicalJson sorts keys recursively and drops nothing else", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: 3 } })).toBe(
      `{"a":{"c":3,"d":[2,{"y":2,"z":1}]},"b":1}`,
    );
  });

  it("hasMcpConsent matches per plugin AND hash", () => {
    const hash = serversHash(servers);
    const consent: McpConsentEntry[] = [
      { plugin: "p1", serversHash: hash, grantedAt: "2026-10-24T00:00:00Z" },
    ];
    expect(hasMcpConsent(consent, "p1", hash)).toBe(true);
    expect(hasMcpConsent(consent, "p1", "other-hash")).toBe(false);
    expect(hasMcpConsent(consent, "p2", hash)).toBe(false);
    expect(hasMcpConsent(undefined, "p1", hash)).toBe(false);
    expect(hasMcpConsent([], "p1", hash)).toBe(false);
  });
});

describe("servicesHash / service consent (Taskana 4750a)", () => {
  const svc = (over: Record<string, unknown> = {}) => ({
    name: "relay",
    command: "node",
    args: ["./dist/relay.js"],
    env: { LOG_LEVEL: "debug" },
    ...over,
  });

  it("servicesHash changes with command", () => {
    expect(servicesHash([svc()])).not.toBe(servicesHash([svc({ command: "deno" })]));
  });

  it("servicesHash changes with args", () => {
    expect(servicesHash([svc()])).not.toBe(servicesHash([svc({ args: ["./other.js"] })]));
  });

  it("servicesHash changes with env KEY added but not with env VALUE changed", () => {
    const base = servicesHash([svc()]);
    expect(servicesHash([svc({ env: { LOG_LEVEL: "info" } })])).toBe(base);
    expect(servicesHash([svc({ env: { LOG_LEVEL: "debug", TOKEN_FILE: "/x" } })])).not.toBe(base);
  });

  it("servicesHash is independent of service order", () => {
    const a = svc({ name: "a" });
    const b = svc({ name: "b", command: "deno" });
    expect(servicesHash([a, b])).toBe(servicesHash([b, a]));
  });

  it("servicesHash treats absent args and empty args alike", () => {
    expect(servicesHash([{ name: "s", command: "node" }])).toBe(servicesHash([{ name: "s", command: "node", args: [] }]));
  });

  it("hasServiceConsent matches only the current hash for the plugin", () => {
    const hash = servicesHash([svc()]);
    const consent = [{ plugin: "p", servicesHash: hash, grantedAt: "2026-10-01T00:00:00.000Z" }];
    expect(hasServiceConsent(consent, "p", hash)).toBe(true);
    expect(hasServiceConsent(consent, "q", hash)).toBe(false);
    expect(hasServiceConsent(consent, "p", servicesHash([svc({ command: "deno" })]))).toBe(false);
    expect(hasServiceConsent(undefined, "p", hash)).toBe(false);
  });
});
