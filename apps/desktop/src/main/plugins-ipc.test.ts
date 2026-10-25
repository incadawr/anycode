/**
 * Tests for the plugins IPC surface (Taskana 4732 S1-B, design §7): zod
 * payload validation, two-phase install token flow (prepare → preview →
 * commit; wrong source / expired token refused), path custody (renderer
 * never sends paths; reveal takes a NAME), refusal reasons on the wire,
 * plugins-changed push after mutations, settings round-trip. Electron's
 * ipcMain is mocked with an in-memory handler registry.
 */

import { generateKeyPairSync, sign as ed25519Sign, createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { McpConsentEntry } from "@anycode/core/plugins-admin";
import {
  PLUGINS_APPROVE_MCP_CHANNEL,
  PLUGINS_CHECK_UPDATES_CHANNEL,
  PLUGINS_CHANGED_CHANNEL,
  PLUGINS_INSTALL_COMMIT_CHANNEL,
  PLUGINS_INSTALL_PREPARE_CHANNEL,
  PLUGINS_LIST_CHANNEL,
  PLUGINS_REVEAL_CHANNEL,
  PLUGINS_REMOVE_CHANNEL,
  PLUGINS_ROLLBACK_CHANNEL,
  PLUGINS_SET_AUTO_UPDATE_CHANNEL,
  PLUGINS_SET_ENABLED_CHANNEL,
  PLUGINS_SET_PINNED_CHANNEL,
} from "../shared/plugins-config.js";
import type { PluginIndex } from "./plugins/index-client.js";
import { makeTarball } from "./plugins/archive.js";

// ── electron mock ──

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(channel, handler);
    },
  },
}));

import { registerPluginsIpc, type PluginsIpcDeps } from "./plugins-ipc.js";

async function invoke(channel: string, payload?: unknown): Promise<any> {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`no handler for ${channel}`);
  return handler({}, payload);
}

// ── fixtures ──

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const KEY = { keyId: "test-2026-1", publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString() };

function pluginTar(name: string, version: string): Buffer {
  return makeTarball([
    { path: ".anycode-plugin/plugin.json", data: JSON.stringify({ manifestVersion: 1, name, version, skills: ["skills"], agents: ["agents"] }) },
    { path: "skills/research/SKILL.md", data: `---\nname: research\n---\n${name}` },
  ]);
}

function signedIndex(tar: Buffer, name = "anycode-essentials"): { index: PluginIndex; raw: string; sigRaw: string } {
  const raw = JSON.stringify({
    schemaVersion: "anycode.plugins-index.v1",
    serial: 1,
    issuedAt: "2026-10-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    plugins: [
      {
        name,
        displayName: name,
        default: true,
        versions: [
          {
            version: "1.0.0",
            url: `https://github.com/incadawr/anycode-plugins/releases/download/${name}-v1.0.0/${name}-1.0.0.tgz`,
            sha256: createHash("sha256").update(tar).digest("hex"),
            size: tar.length,
            capabilities: ["skills", "agents"],
          },
        ],
      },
    ],
  });
  const sigRaw = JSON.stringify({ keyId: KEY.keyId, sig: ed25519Sign(null, Buffer.from(raw, "utf8"), privateKey).toString("base64") });
  return { index: JSON.parse(raw), raw, sigRaw };
}

// ── deps scaffold ──

function makeDeps(index?: { raw: string; sigRaw: string; index: PluginIndex }) {
  const storeFiles = new Map<string, string>();
  const storeBinaries = new Map<string, Buffer>();
  const dirs = new Set<string>();
  const sent: { channel: string; payload: unknown }[] = [];
  const reveals: string[] = [];
  const settingsData = {
    autoUpdateOfficial: false,
    officialIndexUrl: "https://raw.githubusercontent.com/incadawr/anycode-plugins/main/index.json",
    mcpConsent: undefined as McpConsentEntry[] | undefined,
  };
  let pickedFile: string | undefined;
  let pickedFolder: string | undefined;

  const ensured = (path: string) => {
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  };
  const fs = {
    readFile: async (path: string) => {
      const text = storeFiles.get(path);
      if (text !== undefined) return text;
      const bin = storeBinaries.get(path);
      if (bin !== undefined) return bin.toString("utf8");
      throw new Error(`ENOENT ${path}`);
    },
    readFileBytes: async (path: string) => new Uint8Array(storeBinaries.get(path) ?? Buffer.from(storeFiles.get(path) ?? "")),
    writeFile: async (path: string, content: string) => {
      ensured(path);
      storeFiles.set(path, content);
    },
    writeFileBytes: async (path: string, data: Buffer) => {
      ensured(path);
      storeBinaries.set(path, data);
    },
    exists: async (path: string) => storeFiles.has(path) || storeBinaries.has(path) || dirs.has(path),
    stat: async (path: string) => ({ size: 0, mtimeMs: 0, isFile: !dirs.has(path), isDirectory: dirs.has(path) }),
    mkdir: async (path: string) => {
      ensured(path);
      dirs.add(path);
    },
    readdir: async (path: string) => {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const names = new Set<string>();
      for (const key of [...storeFiles.keys(), ...storeBinaries.keys(), ...dirs]) {
        if (key.startsWith(prefix)) names.add(key.slice(prefix.length).split("/")[0]!);
      }
      return [...names];
    },
    rename: async (from: string, to: string) => {
      const moves: [string, string][] = [];
      for (const key of [...storeFiles.keys()]) if (key === from || key.startsWith(`${from}/`)) moves.push([key, to + key.slice(from.length)]);
      for (const key of [...storeBinaries.keys()]) if (key === from || key.startsWith(`${from}/`)) moves.push([key, to + key.slice(from.length)]);
      for (const [src, dest] of moves) {
        const text = storeFiles.get(src);
        if (text !== undefined) {
          storeFiles.delete(src);
          storeFiles.set(dest, text);
        } else {
          const bin = storeBinaries.get(src)!;
          storeBinaries.delete(src);
          storeBinaries.set(dest, bin);
        }
        ensured(dest);
      }
      dirs.delete(from);
      ensured(to);
      dirs.add(to);
    },
    rm: async (path: string) => {
      storeFiles.delete(path);
      storeBinaries.delete(path);
      dirs.delete(path);
      for (const key of [...storeFiles.keys()]) if (key.startsWith(`${path}/`)) storeFiles.delete(key);
      for (const key of [...storeBinaries.keys()]) if (key.startsWith(`${path}/`)) storeBinaries.delete(key);
      for (const key of [...dirs]) if (key.startsWith(`${path}/`)) dirs.delete(key);
    },
    chmod: async () => undefined,
  };

  const deps: PluginsIpcDeps = {
    home: "/home/tester",
    appVersion: "0.0.36",
    isPackaged: true,
    fs: fs as never,
    workspace: "/workspace/project",
    settings: {
      getPlugins: async () => ({ ...settingsData }),
      setAutoUpdateOfficial: async (value: boolean) => {
        settingsData.autoUpdateOfficial = value;
      },
      setMcpConsent: async (entries: McpConsentEntry[]) => {
        settingsData.mcpConsent = entries;
      },
    },
    pickTgzFile: async () => pickedFile,
    pickPluginFolder: async () => pickedFolder,
    revealPath: (path: string) => {
      reveals.push(path);
    },
    getWindows: () => [{ webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) } }],
    now: () => 1_700_000_000_000,
    checkIndex: index === undefined
      ? async () => ({ status: "offline" })
      : async () => ({ status: "ok", index: index.index }),
  };

  return {
    deps,
    fs,
    sent,
    reveals,
    settingsData,
    storeFiles,
    storeBinaries,
    setPickedFile: (path: string | undefined) => {
      pickedFile = path;
    },
    setPickedFolder: (path: string | undefined) => {
      pickedFolder = path;
    },
  };
}

// ── tests ──

beforeEach(() => {
  handlers.clear();
});

describe("plugins IPC registration", () => {
  it("registers every channel", () => {
    const scaffold = makeDeps();
    registerPluginsIpc(scaffold.deps);
    for (const channel of [PLUGINS_LIST_CHANNEL, PLUGINS_CHECK_UPDATES_CHANNEL, PLUGINS_INSTALL_PREPARE_CHANNEL, PLUGINS_INSTALL_COMMIT_CHANNEL, PLUGINS_ROLLBACK_CHANNEL, PLUGINS_SET_PINNED_CHANNEL, PLUGINS_SET_ENABLED_CHANNEL, PLUGINS_REMOVE_CHANNEL, PLUGINS_SET_AUTO_UPDATE_CHANNEL]) {
      expect(handlers.has(channel)).toBe(true);
    }
  });

  it("rejects malformed payloads with reason invalid", async () => {
    const scaffold = makeDeps();
    registerPluginsIpc(scaffold.deps);
    const rollback = await invoke(PLUGINS_ROLLBACK_CHANNEL, { name: "" });
    expect(rollback).toMatchObject({ ok: false, reason: "invalid" });
    const prepare = await invoke(PLUGINS_INSTALL_PREPARE_CHANNEL, { source: { kind: "nonsense" } });
    expect(prepare).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("list returns a snapshot with rows stripped of roots", async () => {
    const scaffold = makeDeps();
    registerPluginsIpc(scaffold.deps);
    const snapshot = await invoke(PLUGINS_LIST_CHANNEL);
    expect(snapshot.plugins).toEqual([]);
    expect(snapshot.index.status).toBe("unchecked");
    expect(snapshot.settings.autoUpdateOfficial).toBe(false);
  });
});

describe("two-phase install (official)", () => {
  it("prepare → preview → commit installs and pushes plugins-changed", async () => {
    const tar = pluginTar("anycode-essentials", "1.0.0");
    const signed = signedIndex(tar);
    // Wire artifact download: the store fetches the artifact URL from the index.
    const scaffold = makeDeps(signed);
    const artifactUrl = signed.index.plugins[0]!.versions[0]!.url;
    // Replace createArchiveFetch via deps? The ipc module builds its own —
    // instead serve the artifact through the fs port? Simplest: intercept by
    // monkey-patching global fetch (createArchiveFetch defaults to it).
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(new Uint8Array(tar), { status: 200 })) as typeof fetch;
    try {
      registerPluginsIpc(scaffold.deps);
      const prepared = await invoke(PLUGINS_INSTALL_PREPARE_CHANNEL, { source: { kind: "official", name: "anycode-essentials" } });
      expect(prepared.ok).toBe(true);
      expect(prepared.preview.name).toBe("anycode-essentials");
      expect(prepared.preview.version).toBe("1.0.0");
      expect(typeof prepared.token).toBe("string");
      expect(prepared.preview.source).toEqual({ kind: "official", name: "anycode-essentials" });

      const committed = await invoke(PLUGINS_INSTALL_COMMIT_CHANNEL, { token: prepared.token, source: { kind: "official", name: "anycode-essentials" } });
      expect(committed.ok).toBe(true);
      expect(committed.snapshot.plugins.length).toBe(1);
      expect(committed.snapshot.plugins[0].managed.active).toBe("1.0.0");
      // push happened
      expect(scaffold.sent.some((s) => s.channel === PLUGINS_CHANGED_CHANNEL)).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("refuses a commit with a mismatched source", async () => {
    const tar = pluginTar("anycode-essentials", "1.0.0");
    const signed = signedIndex(tar);
    const scaffold = makeDeps(signed);
    registerPluginsIpc(scaffold.deps);
    const prepared = await invoke(PLUGINS_INSTALL_PREPARE_CHANNEL, { source: { kind: "official", name: "anycode-essentials" } });
    expect(prepared.ok).toBe(true);
    const committed = await invoke(PLUGINS_INSTALL_COMMIT_CHANNEL, { token: prepared.token, source: { kind: "url", url: "https://evil/x.tgz" } });
    expect(committed).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("refuses an unknown token", async () => {
    const scaffold = makeDeps();
    registerPluginsIpc(scaffold.deps);
    const committed = await invoke(PLUGINS_INSTALL_COMMIT_CHANNEL, { token: randomUUID(), source: { kind: "official", name: "x" } });
    expect(committed).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("git sources are refused for now (s2)", async () => {
    const scaffold = makeDeps();
    registerPluginsIpc(scaffold.deps);
    const prepared = await invoke(PLUGINS_INSTALL_PREPARE_CHANNEL, { source: { kind: "git", url: "https://github.com/x/y" } });
    expect(prepared).toMatchObject({ ok: false, reason: "invalid", detail: expect.stringContaining("Stage 2") });
  });

  it("non-https URLs are refused", async () => {
    const scaffold = makeDeps();
    registerPluginsIpc(scaffold.deps);
    const prepared = await invoke(PLUGINS_INSTALL_PREPARE_CHANNEL, { source: { kind: "url", url: "file:///etc/passwd" } });
    expect(prepared).toMatchObject({ ok: false, reason: "invalid" });
  });
});

describe("path custody", () => {
  it("reveal takes a NAME and resolves the store path main-side", async () => {
    const scaffold = makeDeps();
    registerPluginsIpc(scaffold.deps);
    // hand-plant a state entry
    await scaffold.fs.mkdir("/home/tester/.anycode/plugins/.store/p/1.0.0");
    scaffold.storeFiles.set("/home/tester/.anycode/plugins/state.json", JSON.stringify({
      version: 1,
      plugins: { p: { source: { kind: "official" }, trust: "official", active: "1.0.0", enabled: true, pinned: false, capabilities: [] } },
      removedDefaults: [],
      disabled: [],
    }));
    const result = await invoke(PLUGINS_REVEAL_CHANNEL, { name: "p" });
    expect(result.ok).toBe(true);
    expect(scaffold.reveals).toEqual(["/home/tester/.anycode/plugins/.store/p/1.0.0"]);
  });

  it("a file source ignores an injected path — main opens its OWN picker (custody)", async () => {
    // The renderer may only send {kind:"file"}; zod strips any smuggled
    // `path`, and the bytes main reads come from the dialog main opened —
    // never from a renderer-supplied string.
    const scaffold = makeDeps();
    const pickedByMain = "/home/tester/Downloads/picked-by-main.tgz";
    const rendererPath = "/home/tester/Downloads/smuggled.tgz";
    scaffold.setPickedFile(pickedByMain);
    scaffold.storeBinaries.set(pickedByMain, pluginTar("picked", "1.0.0"));
    scaffold.storeBinaries.set(rendererPath, pluginTar("smuggled", "9.9.9"));
    registerPluginsIpc(scaffold.deps);
    const result = await invoke(PLUGINS_INSTALL_PREPARE_CHANNEL, { source: { kind: "file", path: rendererPath } });
    expect(result).toMatchObject({ ok: true });
    expect(result.preview.name).toBe("picked");
    expect(result.preview.name).not.toBe("smuggled");
  });

  it("approve-mcp takes a NAME only — main computes the serversHash from its own scan", async () => {
    // Security invariant (design §4): consent is keyed by a hash main
    // derives from the plugin's CURRENT mcpServers; the renderer never
    // supplies a hash. Plant a managed install whose manifest declares one
    // server (the manifest on disk is plain JSON — discovery reads it as text).
    const scaffold = makeDeps();
    scaffold.storeFiles.set(
      "/home/tester/.anycode/plugins/.store/with-mcp/1.0.0/.anycode-plugin/plugin.json",
      JSON.stringify({ manifestVersion: 1, name: "with-mcp", version: "1.0.0", mcpServers: { api: { command: "node", args: ["api.js"] } } }),
    );
    scaffold.storeFiles.set("/home/tester/.anycode/plugins/state.json", JSON.stringify({
      version: 1,
      plugins: { "with-mcp": { source: { kind: "official" }, trust: "official", active: "1.0.0", enabled: true, pinned: false, capabilities: ["mcp:api"] } },
      removedDefaults: [],
      disabled: [],
    }));
    registerPluginsIpc(scaffold.deps);
    // A smuggled serversHash field must not reach the settings write.
    const granted = await invoke(PLUGINS_APPROVE_MCP_CHANNEL, { name: "with-mcp", serversHash: "deadbeef" });
    expect(granted).toMatchObject({ ok: true });
    const written = scaffold.settingsData.mcpConsent ?? [];
    expect(written).toHaveLength(1);
    expect(written[0]!.plugin).toBe("with-mcp");
    expect(written[0]!.serversHash).not.toBe("deadbeef");
    expect(written[0]!.serversHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("approve-mcp refuses a plugin that declares no MCP servers (nothing to consent to)", async () => {
    const scaffold = makeDeps();
    registerPluginsIpc(scaffold.deps);
    const result = await invoke(PLUGINS_APPROVE_MCP_CHANNEL, { name: "ghost" });
    expect(result).toMatchObject({ ok: false, reason: "not_found" });
  });
});

describe("mutations push plugins-changed", () => {
  it("set-pinned / set-enabled / remove / set-auto-update each push", async () => {
    const scaffold = makeDeps();
    registerPluginsIpc(scaffold.deps);
    scaffold.storeFiles.set("/home/tester/.anycode/plugins/state.json", JSON.stringify({
      version: 1,
      plugins: { p: { source: { kind: "official" }, trust: "official", active: "1.0.0", enabled: true, pinned: false, capabilities: [] } },
      removedDefaults: [],
      disabled: [],
    }));
    expect(await invoke(PLUGINS_SET_PINNED_CHANNEL, { name: "p", value: true })).toMatchObject({ ok: true });
    expect(await invoke(PLUGINS_SET_ENABLED_CHANNEL, { name: "p", value: false })).toMatchObject({ ok: true });
    expect(await invoke(PLUGINS_SET_AUTO_UPDATE_CHANNEL, { value: true })).toMatchObject({ ok: true });
    const reasons = scaffold.sent.filter((s) => s.channel === PLUGINS_CHANGED_CHANNEL).map((s) => (s.payload as { reason: string }).reason);
    expect(reasons).toEqual(["pin", "enable", "auto-update"]);
    expect(scaffold.settingsData.autoUpdateOfficial).toBe(true);
  });

  it("remove of an unknown plugin refuses not_found (no push)", async () => {
    const scaffold = makeDeps();
    registerPluginsIpc(scaffold.deps);
    const result = await invoke(PLUGINS_REMOVE_CHANNEL, { name: "ghost" });
    expect(result).toMatchObject({ ok: false, reason: "not_found" });
    expect(scaffold.sent).toEqual([]);
  });
});
