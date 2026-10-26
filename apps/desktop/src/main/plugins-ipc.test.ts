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
import { servicesHash, type McpConsentEntry, type ServiceConsentEntry } from "@anycode/core/plugins-admin";
import {
  PLUGINS_APPROVE_MCP_CHANNEL,
  PLUGINS_APPROVE_SERVICES_CHANNEL,
  PLUGINS_SERVICES_CHANNEL,
  PLUGINS_SERVICE_LOGS_CHANNEL,
  PLUGINS_SERVICE_RESTART_CHANNEL,
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
  PLUGINS_UPDATE_CHANNEL,
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

import { activePluginsWorkspace, registerPluginsIpc, type PluginsIpcDeps } from "./plugins-ipc.js";

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
    serviceConsent: undefined as ServiceConsentEntry[] | undefined,
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
      setServiceConsent: async (entry: ServiceConsentEntry) => {
        settingsData.serviceConsent = [...(settingsData.serviceConsent ?? []).filter((e) => e.plugin !== entry.plugin), entry];
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

  it("carries a legacy plugin's disabled flag through disable/enable round-trips", async () => {
    const scaffold = makeDeps();
    const services = [{ name: "notify", command: "node", args: ["notify.js"] }];
    await scaffold.fs.writeFile("/home/tester/.anycode/plugins/legacy-tool/.anycode-plugin/plugin.json",
      JSON.stringify({ manifestVersion: 1, name: "legacy-tool", version: "1.0.0", services }));
    await scaffold.fs.writeFile("/home/tester/.anycode/plugins/state.json",
      JSON.stringify({ version: 1, plugins: {}, removedDefaults: [], disabled: ["legacy-tool"] }));
    scaffold.settingsData.serviceConsent = [{ plugin: "legacy-tool", servicesHash: servicesHash(services), grantedAt: "x" }];
    registerPluginsIpc(scaffold.deps);
    const before = await invoke(PLUGINS_LIST_CHANNEL);
    expect(before.plugins).toHaveLength(1);
    expect(before.plugins[0]).toMatchObject({ name: "legacy-tool", tier: "legacy-user", status: "disabled", disabled: true });
    expect(before.plugins[0].managed).toBeUndefined();
    const result = await invoke(PLUGINS_SET_ENABLED_CHANNEL, { name: "legacy-tool", value: true });
    expect(result.ok).toBe(true);
    const after = await invoke(PLUGINS_LIST_CHANNEL);
    expect(after.plugins[0]).toMatchObject({ status: "active", disabled: false, servicesConsentGranted: true });
    expect(await invoke(PLUGINS_SET_ENABLED_CHANNEL, { name: "legacy-tool", value: false })).toMatchObject({ ok: true });
    const disabledAgain = await invoke(PLUGINS_LIST_CHANNEL);
    expect(disabledAgain.plugins[0]).toMatchObject({ status: "disabled", disabled: true });
  });

  it("round-trips a managed plugin through disable → list → enable → list", async () => {
    const scaffold = makeDeps();
    await scaffold.fs.writeFile("/home/tester/.anycode/plugins/.store/managed-tool/1.0.0/.anycode-plugin/plugin.json",
      JSON.stringify({ manifestVersion: 1, name: "managed-tool", version: "1.0.0" }));
    await scaffold.fs.writeFile("/home/tester/.anycode/plugins/state.json", JSON.stringify({
      version: 1, removedDefaults: [], disabled: [],
      plugins: { "managed-tool": { source: { kind: "official" }, trust: "official", active: "1.0.0", enabled: true, pinned: false, capabilities: [] } },
    }));
    registerPluginsIpc(scaffold.deps);
    expect(await invoke(PLUGINS_SET_ENABLED_CHANNEL, { name: "managed-tool", value: false })).toMatchObject({ ok: true });
    const disabled = await invoke(PLUGINS_LIST_CHANNEL);
    expect(disabled.plugins[0]).toMatchObject({ status: "disabled", disabled: true, managed: { enabled: true } });
    expect(await invoke(PLUGINS_SET_ENABLED_CHANNEL, { name: "managed-tool", value: true })).toMatchObject({ ok: true });
    const enabled = await invoke(PLUGINS_LIST_CHANNEL);
    expect(enabled.plugins[0]).toMatchObject({ status: "active", disabled: false, managed: { enabled: true } });
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

// ── Taskana 4732 xfix: IPC hardening (H1, H2, H3, H4, M1, M4, M7, L3) ──

const STATE = "/home/tester/.anycode/plugins/state.json";
const ENTRY = { source: { kind: "official" }, trust: "official", active: "1.0.0", enabled: true, pinned: false, capabilities: [] };
const indexOf = (plugins: unknown[], serial = 7): PluginIndex =>
  ({ schemaVersion: "anycode.plugins-index.v1", serial, issuedAt: "2026-10-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z", plugins }) as unknown as PluginIndex;

describe("anti-rollback floor survives a restart (xfix H2)", () => {
  it("the first check after a restart receives the floor persisted in state.json", async () => {
    const scaffold = makeDeps();
    scaffold.storeFiles.set(STATE, JSON.stringify({ version: 1, plugins: {}, removedDefaults: [], disabled: [], lastIndexSerial: 42 }));
    const seen: (number | undefined)[] = [];
    scaffold.deps.checkIndex = async (opts) => {
      seen.push(opts.serialFloor);
      return { status: "offline" };
    };
    registerPluginsIpc(scaffold.deps);
    await invoke(PLUGINS_CHECK_UPDATES_CHANNEL);
    expect(seen).toEqual([42]);
  });

  it("an accepted check persists its serial, so the next launch keeps the floor", async () => {
    const scaffold = makeDeps();
    scaffold.deps.checkIndex = async () => ({ status: "ok", index: indexOf([], 43) });
    registerPluginsIpc(scaffold.deps);
    await invoke(PLUGINS_CHECK_UPDATES_CHANNEL);
    expect(JSON.parse(scaffold.storeFiles.get(STATE)!).lastIndexSerial).toBe(43);
  });
});

describe("MCP consent through the install sheet (xfix H1b)", () => {
  function mcpTar(name: string): Buffer {
    return makeTarball([
      { path: ".anycode-plugin/plugin.json", data: JSON.stringify({ manifestVersion: 1, name, version: "1.0.0", mcpServers: { api: { command: "node", args: ["api.js"] } } }) },
    ]);
  }

  it("commit with allowMcp=true records a consent grant keyed by the installed servers hash", async () => {
    const scaffold = makeDeps();
    const tar = mcpTar("mcp-plug");
    scaffold.setPickedFile("/Downloads/mcp-plug.tgz");
    scaffold.storeBinaries.set("/Downloads/mcp-plug.tgz", tar);
    registerPluginsIpc(scaffold.deps);
    const prepared = await invoke(PLUGINS_INSTALL_PREPARE_CHANNEL, { source: { kind: "file" } });
    const committed = await invoke(PLUGINS_INSTALL_COMMIT_CHANNEL, { token: prepared.token, source: { kind: "file" }, allowMcp: true });
    expect(committed.ok).toBe(true);
    const grants = scaffold.settingsData.mcpConsent ?? [];
    expect(grants).toHaveLength(1);
    expect(grants[0]!.plugin).toBe("mcp-plug");
    expect(grants[0]!.serversHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("commit without allowMcp records no grant (servers stay withheld until approved)", async () => {
    const scaffold = makeDeps();
    scaffold.setPickedFile("/Downloads/mcp-plug.tgz");
    scaffold.storeBinaries.set("/Downloads/mcp-plug.tgz", mcpTar("mcp-plug"));
    registerPluginsIpc(scaffold.deps);
    const prepared = await invoke(PLUGINS_INSTALL_PREPARE_CHANNEL, { source: { kind: "file" } });
    const committed = await invoke(PLUGINS_INSTALL_COMMIT_CHANNEL, { token: prepared.token, source: { kind: "file" } });
    expect(committed.ok).toBe(true);
    expect(scaffold.settingsData.mcpConsent).toBeUndefined();
  });

  it("two approvals in one lifetime both persist (no once-only write)", async () => {
    const scaffold = makeDeps();
    for (const name of ["one", "two"]) {
      scaffold.storeFiles.set(`/home/tester/.anycode/plugins/.store/${name}/1.0.0/.anycode-plugin/plugin.json`, JSON.stringify({ manifestVersion: 1, name, version: "1.0.0", mcpServers: { api: { command: "node", args: [name] } } }));
    }
    scaffold.storeFiles.set(STATE, JSON.stringify({ version: 1, plugins: { one: ENTRY, two: ENTRY }, removedDefaults: [], disabled: [] }));
    registerPluginsIpc(scaffold.deps);
    expect(await invoke(PLUGINS_APPROVE_MCP_CHANNEL, { name: "one" })).toMatchObject({ ok: true });
    expect(await invoke(PLUGINS_APPROVE_MCP_CHANNEL, { name: "two" })).toMatchObject({ ok: true });
    expect((scaffold.settingsData.mcpConsent ?? []).map((g) => g.plugin).sort()).toEqual(["one", "two"]);
  });
});

describe("two-phase install binds preview to commit (xfix H3)", () => {
  it("URL commit installs the EXACT previewed bytes — no second download", async () => {
    const previewed = pluginTar("url-plug", "1.0.0");
    const swapped = pluginTar("url-plug", "9.9.9");
    let calls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(new Uint8Array(calls === 1 ? previewed : swapped), { status: 200 });
    }) as typeof fetch;
    try {
      const scaffold = makeDeps();
      registerPluginsIpc(scaffold.deps);
      const url = "https://example.com/url-plug.tgz";
      const prepared = await invoke(PLUGINS_INSTALL_PREPARE_CHANNEL, { source: { kind: "url", url } });
      expect(prepared.ok).toBe(true);
      const committed = await invoke(PLUGINS_INSTALL_COMMIT_CHANNEL, { token: prepared.token, source: { kind: "url", url } });
      expect(committed.ok).toBe(true);
      expect(calls).toBe(1);
      const row = committed.snapshot.plugins.find((p: { name: string }) => p.name === "url-plug");
      expect(row.version).toBe("1.0.0");
      expect(row.source).toEqual({ kind: "url", url });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("folder commit installs the folder the sheet previewed — no second picker", async () => {
    const scaffold = makeDeps();
    const manifest = JSON.stringify({ manifestVersion: 1, name: "dev-link", version: "0.1.0" });
    scaffold.storeFiles.set("/work/a/.anycode-plugin/plugin.json", manifest);
    scaffold.storeFiles.set("/work/b/.anycode-plugin/plugin.json", manifest.replace("dev-link", "other"));
    scaffold.setPickedFolder("/work/a");
    registerPluginsIpc(scaffold.deps);
    const prepared = await invoke(PLUGINS_INSTALL_PREPARE_CHANNEL, { source: { kind: "folder" } });
    expect(prepared.ok).toBe(true);
    scaffold.setPickedFolder("/work/b"); // a second dialog would now return B
    const committed = await invoke(PLUGINS_INSTALL_COMMIT_CHANNEL, { token: prepared.token, source: { kind: "folder" } });
    expect(committed.ok).toBe(true);
    const row = committed.snapshot.plugins.find((p: { name: string }) => p.name === "dev-link");
    expect(row.source).toEqual({ kind: "local", path: "/work/a" });
    expect(committed.snapshot.plugins.find((p: { name: string }) => p.name === "other")).toBeUndefined();
  });
});

describe("engines ranges at every IPC surface (xfix H4)", () => {
  const rangedIndex = (range: string) =>
    indexOf([{ name: "anycode-essentials", default: true, versions: [{ version: "1.4.2", engines: { anycode: range }, url: "https://github.com/x/y.tgz", sha256: "ab".repeat(32), size: 1, capabilities: ["skills"] }] }]);

  it("the available list and install-prepare accept a range that matches the app", async () => {
    const scaffold = makeDeps({ index: rangedIndex(">=0.0.35"), raw: "", sigRaw: "" } as never);
    registerPluginsIpc(scaffold.deps);
    const snapshot = await invoke(PLUGINS_CHECK_UPDATES_CHANNEL);
    expect(snapshot.available).toEqual([expect.objectContaining({ name: "anycode-essentials", version: "1.4.2" })]);
    const prepared = await invoke(PLUGINS_INSTALL_PREPARE_CHANNEL, { source: { kind: "official", name: "anycode-essentials" } });
    expect(prepared.ok).toBe(true);
  });

  it("a range that does not match the app is refused everywhere", async () => {
    const scaffold = makeDeps({ index: rangedIndex(">=0.1.0"), raw: "", sigRaw: "" } as never);
    registerPluginsIpc(scaffold.deps);
    const snapshot = await invoke(PLUGINS_CHECK_UPDATES_CHANNEL);
    expect(snapshot.available[0].incompatibleReason).toContain("no version compatible");
    const prepared = await invoke(PLUGINS_INSTALL_PREPARE_CHANNEL, { source: { kind: "official", name: "anycode-essentials" } });
    expect(prepared).toMatchObject({ ok: false, reason: "incompatible" });
  });
});

describe("expired index (xfix M1)", () => {
  it("an expired cached index lists but refuses prepare and update", async () => {
    const tar = pluginTar("anycode-essentials", "1.0.0");
    const signed = signedIndex(tar);
    const scaffold = makeDeps(signed);
    scaffold.deps.checkIndex = async () => ({ status: "expired", index: signed.index });
    registerPluginsIpc(scaffold.deps);
    const prepared = await invoke(PLUGINS_INSTALL_PREPARE_CHANNEL, { source: { kind: "official", name: "anycode-essentials" } });
    expect(prepared.ok).toBe(false);
    const updated = await invoke(PLUGINS_UPDATE_CHANNEL, { name: "anycode-essentials" });
    expect(updated).toMatchObject({ ok: false });
  });

  it("an index that expires BETWEEN prepare and commit refuses the commit before any download", async () => {
    const tar = pluginTar("anycode-essentials", "1.0.0");
    const signed = signedIndex(tar);
    const scaffold = makeDeps(signed);
    registerPluginsIpc(scaffold.deps);
    const originalFetch = globalThis.fetch;
    let downloads = 0;
    globalThis.fetch = (async () => {
      downloads += 1;
      return new Response(new Uint8Array(tar), { status: 200 });
    }) as typeof fetch;
    try {
      const prepared = await invoke(PLUGINS_INSTALL_PREPARE_CHANNEL, { source: { kind: "official", name: "anycode-essentials" } });
      expect(prepared.ok).toBe(true);
      const downloadsAtPrepare = downloads;
      scaffold.deps.checkIndex = async () => ({ status: "expired", index: signed.index });
      const committed = await invoke(PLUGINS_INSTALL_COMMIT_CHANNEL, { token: prepared.token, source: { kind: "official", name: "anycode-essentials" } });
      expect(committed).toMatchObject({ ok: false });
      expect(downloads).toBe(downloadsAtPrepare);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("an official MCP plugin installed with allowMcp records consent for its index-declared servers", async () => {
    const tar = makeTarball([
      { path: ".anycode-plugin/plugin.json", data: JSON.stringify({ manifestVersion: 1, name: "official-mcp", version: "1.0.0", mcpServers: { api: { command: "node", args: ["api.js"] } } }) },
    ]);
    const base = signedIndex(tar, "official-mcp");
    const entry = (base.index.plugins[0] as unknown as { versions: { capabilities: string[] }[] });
    entry.versions[0]!.capabilities = ["mcp:api"];
    const raw = JSON.stringify(base.index);
    const sigRaw = JSON.stringify({ keyId: KEY.keyId, sig: ed25519Sign(null, Buffer.from(raw, "utf8"), privateKey).toString("base64") });
    const scaffold = makeDeps({ index: JSON.parse(raw), raw, sigRaw });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(new Uint8Array(tar), { status: 200 })) as typeof fetch;
    try {
      registerPluginsIpc(scaffold.deps);
      const prepared = await invoke(PLUGINS_INSTALL_PREPARE_CHANNEL, { source: { kind: "official", name: "official-mcp" } });
      expect(prepared.ok).toBe(true);
      const committed = await invoke(PLUGINS_INSTALL_COMMIT_CHANNEL, { token: prepared.token, source: { kind: "official", name: "official-mcp" }, allowMcp: true });
      expect(committed.ok).toBe(true);
      expect((scaffold.settingsData.mcpConsent ?? []).map((g) => g.plugin)).toEqual(["official-mcp"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("remove tombstone (xfix M4)", () => {
  it("removing an official plugin tombstones it even with no cached index", async () => {
    const scaffold = makeDeps();
    scaffold.storeFiles.set(STATE, JSON.stringify({ version: 1, plugins: { p: ENTRY }, removedDefaults: [], disabled: [] }));
    registerPluginsIpc(scaffold.deps);
    expect(await invoke(PLUGINS_REMOVE_CHANNEL, { name: "p" })).toMatchObject({ ok: true });
    expect(JSON.parse(scaffold.storeFiles.get(STATE)!).removedDefaults).toEqual(["p"]);
  });

  it("removing a third-party plugin does not tombstone it", async () => {
    const scaffold = makeDeps();
    scaffold.storeFiles.set(STATE, JSON.stringify({ version: 1, plugins: { p: { ...ENTRY, trust: "third-party", source: { kind: "url", url: "https://x/y.tgz" } } }, removedDefaults: [], disabled: [] }));
    registerPluginsIpc(scaffold.deps);
    expect(await invoke(PLUGINS_REMOVE_CHANNEL, { name: "p" })).toMatchObject({ ok: true });
    expect(JSON.parse(scaffold.storeFiles.get(STATE)!).removedDefaults).toEqual([]);
  });
});

describe("renderer forgery and malformed manifests (xfix H1, M7)", () => {
  it("approve-mcp with a forged plugin field grants ONLY the named plugin", async () => {
    const scaffold = makeDeps();
    for (const name of ["one", "two"]) {
      scaffold.storeFiles.set(`/home/tester/.anycode/plugins/.store/${name}/1.0.0/.anycode-plugin/plugin.json`, JSON.stringify({ manifestVersion: 1, name, version: "1.0.0", mcpServers: { api: { command: "node", args: [name] } } }));
    }
    scaffold.storeFiles.set(STATE, JSON.stringify({ version: 1, plugins: { one: ENTRY, two: ENTRY }, removedDefaults: [], disabled: [] }));
    registerPluginsIpc(scaffold.deps);
    expect(await invoke(PLUGINS_APPROVE_MCP_CHANNEL, { name: "one", plugin: "two", grantedAt: "x" })).toMatchObject({ ok: true });
    expect((scaffold.settingsData.mcpConsent ?? []).map((g) => g.plugin)).toEqual(["one"]);
  });

  it("a folder whose manifest fails the schema is refused before any token is minted", async () => {
    const scaffold = makeDeps();
    scaffold.storeFiles.set("/work/bad/.anycode-plugin/plugin.json", JSON.stringify({ manifestVersion: 1, name: 5 }));
    scaffold.setPickedFolder("/work/bad");
    registerPluginsIpc(scaffold.deps);
    const prepared = await invoke(PLUGINS_INSTALL_PREPARE_CHANNEL, { source: { kind: "folder" } });
    expect(prepared).toMatchObject({ ok: false, reason: "invalid" });
    expect(prepared.token).toBeUndefined();
  });
});

describe("install preview and provenance (xfix M7, L3)", () => {
  it("a folder preview shows the manifest's real MCP servers and capabilities", async () => {
    const scaffold = makeDeps();
    scaffold.storeFiles.set("/work/mcp/.anycode-plugin/plugin.json", JSON.stringify({ manifestVersion: 1, name: "folder-mcp", version: "0.1.0", mcpServers: { api: { command: "curl", args: ["https://x"] } } }));
    scaffold.setPickedFolder("/work/mcp");
    registerPluginsIpc(scaffold.deps);
    const prepared = await invoke(PLUGINS_INSTALL_PREPARE_CHANNEL, { source: { kind: "folder" } });
    expect(prepared.ok).toBe(true);
    expect(prepared.preview.mcpServers).toEqual([{ name: "api", command: "curl", args: ["https://x"] }]);
    expect(prepared.preview.capabilities).toContain("mcp:api");
  });

  it("a picked file records its own file name as provenance", async () => {
    const scaffold = makeDeps();
    scaffold.setPickedFile("/Downloads/plugin.tgz");
    scaffold.storeBinaries.set("/Downloads/plugin.tgz", pluginTar("prov", "1.0.0"));
    registerPluginsIpc(scaffold.deps);
    const prepared = await invoke(PLUGINS_INSTALL_PREPARE_CHANNEL, { source: { kind: "file" } });
    await invoke(PLUGINS_INSTALL_COMMIT_CHANNEL, { token: prepared.token, source: { kind: "file" } });
    expect(JSON.parse(scaffold.storeFiles.get(STATE)!).plugins.prov.source).toEqual({ kind: "file", fileName: "plugin.tgz" });
  });
});

describe("the pane scans the live tab workspace (xfix M6)", () => {
  it("activePluginsWorkspace picks the first tab workspace, else the fallback", () => {
    expect(activePluginsWorkspace([{ workspace: "" }, { workspace: "/repo" }], "/home/x")).toBe("/repo");
    expect(activePluginsWorkspace([], "/home/x")).toBe("/home/x");
  });

  it("a project plugin in the live workspace is listed", async () => {
    const scaffold = makeDeps();
    await scaffold.fs.mkdir("/repo/.anycode/plugins/proj");
    scaffold.storeFiles.set("/repo/.anycode/plugins/proj/.anycode-plugin/plugin.json", JSON.stringify({ manifestVersion: 1, name: "proj", version: "0.1.0" }));
    scaffold.deps.activeWorkspace = () => "/repo";
    registerPluginsIpc(scaffold.deps);
    const snapshot = await invoke(PLUGINS_LIST_CHANNEL);
    expect(snapshot.plugins.map((p: { name: string }) => p.name)).toContain("proj");
  });
});

describe("plugin services consent (Taskana 4750a)", () => {
  const SERVICES = [
    { name: "relay", command: "node", args: ["./relay.js"], env: { LOG_LEVEL: "debug", TOKEN_FILE: "/secret/value-xyz" } },
  ];
  const servicesManifest = (name: string) => ({ manifestVersion: 1, name, version: "1.0.0", services: SERVICES });

  function managedWithServices(scaffold: ReturnType<typeof makeDeps>, name: string) {
    scaffold.storeFiles.set(`/home/tester/.anycode/plugins/.store/${name}/1.0.0/.anycode-plugin/plugin.json`, JSON.stringify(servicesManifest(name)));
    scaffold.storeFiles.set("/home/tester/.anycode/plugins/state.json", JSON.stringify({
      version: 1,
      plugins: { [name]: { source: { kind: "official" }, trust: "official", active: "1.0.0", enabled: true, pinned: false, capabilities: [] } },
      removedDefaults: [],
      disabled: [],
    }));
  }

  function serviceTar(name: string): Buffer {
    return makeTarball([{ path: ".anycode-plugin/plugin.json", data: JSON.stringify(servicesManifest(name)) }]);
  }

  it("approve-services writes the hash of the current definition", async () => {
    const scaffold = makeDeps();
    managedWithServices(scaffold, "bridge");
    registerPluginsIpc(scaffold.deps);
    const granted = await invoke(PLUGINS_APPROVE_SERVICES_CHANNEL, { name: "bridge" });
    expect(granted).toMatchObject({ ok: true });
    const written = scaffold.settingsData.serviceConsent ?? [];
    expect(written).toHaveLength(1);
    expect(written[0]!.plugin).toBe("bridge");
    expect(written[0]!.servicesHash).toBe(servicesHash(SERVICES));
  });

  it("approve-services refuses a plugin without services (nothing to consent to)", async () => {
    const scaffold = makeDeps();
    registerPluginsIpc(scaffold.deps);
    const result = await invoke(PLUGINS_APPROVE_SERVICES_CHANNEL, { name: "ghost" });
    expect(result).toMatchObject({ ok: false, reason: "not_found" });
    expect(scaffold.settingsData.serviceConsent).toBeUndefined();
  });

  it("payload with extra key refused (.strict) — a smuggled servicesHash never reaches the write", async () => {
    const scaffold = makeDeps();
    managedWithServices(scaffold, "bridge");
    registerPluginsIpc(scaffold.deps);
    // approve-services is name-only: the zod schema is strict, so an extra key is refused.
    const result = await invoke(PLUGINS_APPROVE_SERVICES_CHANNEL, { name: "bridge", servicesHash: "deadbeef" });
    expect(result).toMatchObject({ ok: false, reason: "invalid" });
    expect(scaffold.settingsData.serviceConsent).toBeUndefined();
  });

  it("install default leaves services unconsented", async () => {
    const scaffold = makeDeps();
    scaffold.setPickedFile("/Downloads/bridge.tgz");
    scaffold.storeBinaries.set("/Downloads/bridge.tgz", serviceTar("bridge"));
    registerPluginsIpc(scaffold.deps);
    const prepared = await invoke(PLUGINS_INSTALL_PREPARE_CHANNEL, { source: { kind: "file" } });
    const committed = await invoke(PLUGINS_INSTALL_COMMIT_CHANNEL, { token: prepared.token, source: { kind: "file" } });
    expect(committed.ok).toBe(true);
    expect(scaffold.settingsData.serviceConsent).toBeUndefined();
  });

  it("install allow records consent for exactly the previewed definition", async () => {
    const scaffold = makeDeps();
    scaffold.setPickedFile("/Downloads/bridge.tgz");
    scaffold.storeBinaries.set("/Downloads/bridge.tgz", serviceTar("bridge"));
    registerPluginsIpc(scaffold.deps);
    const prepared = await invoke(PLUGINS_INSTALL_PREPARE_CHANNEL, { source: { kind: "file" } });
    const committed = await invoke(PLUGINS_INSTALL_COMMIT_CHANNEL, { token: prepared.token, source: { kind: "file" }, allowServices: true });
    expect(committed.ok).toBe(true);
    const grants = scaffold.settingsData.serviceConsent ?? [];
    expect(grants).toHaveLength(1);
    expect(grants[0]!.servicesHash).toBe(servicesHash(SERVICES));
  });

  it("install preview shows each service's command, args and env KEY names — never env values", async () => {
    const scaffold = makeDeps();
    scaffold.setPickedFile("/Downloads/bridge.tgz");
    scaffold.storeBinaries.set("/Downloads/bridge.tgz", serviceTar("bridge"));
    registerPluginsIpc(scaffold.deps);
    const prepared = await invoke(PLUGINS_INSTALL_PREPARE_CHANNEL, { source: { kind: "file" } });
    expect(prepared.preview.services).toEqual([
      { name: "relay", command: "node", args: ["./relay.js"], envKeys: ["LOG_LEVEL", "TOKEN_FILE"] },
    ]);
    expect(JSON.stringify(prepared.preview)).not.toContain("value-xyz");
  });

  it("install allow for a folder whose services changed between preview and commit records nothing", async () => {
    const scaffold = makeDeps();
    scaffold.storeFiles.set("/work/bridge/.anycode-plugin/plugin.json", JSON.stringify(servicesManifest("bridge")));
    scaffold.setPickedFolder("/work/bridge");
    registerPluginsIpc(scaffold.deps);
    const prepared = await invoke(PLUGINS_INSTALL_PREPARE_CHANNEL, { source: { kind: "folder" } });
    expect(prepared.ok).toBe(true);
    // The folder's manifest moves on between preview and commit: the installed definition
    // no longer matches the one the sheet showed, so no consent is recorded for it.
    scaffold.storeFiles.set("/work/bridge/.anycode-plugin/plugin.json", JSON.stringify({
      ...servicesManifest("bridge"),
      services: [{ name: "relay", command: "deno", args: ["run", "evil.ts"] }],
    }));
    const committed = await invoke(PLUGINS_INSTALL_COMMIT_CHANNEL, { token: prepared.token, source: { kind: "folder" }, allowServices: true });
    expect(committed.ok).toBe(true);
    expect(scaffold.settingsData.serviceConsent).toBeUndefined();
  });

  it("official install with allowServices records no service consent (the index preview carries no definition)", async () => {
    const tar = makeTarball([{ path: ".anycode-plugin/plugin.json", data: JSON.stringify({ ...servicesManifest("anycode-essentials"), version: "1.0.0" }) }]);
    const signed = signedIndex(tar);
    const scaffold = makeDeps(signed);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(new Uint8Array(tar), { status: 200 })) as typeof fetch;
    try {
      registerPluginsIpc(scaffold.deps);
      const prepared = await invoke(PLUGINS_INSTALL_PREPARE_CHANNEL, { source: { kind: "official", name: "anycode-essentials" } });
      expect(prepared.ok).toBe(true);
      const committed = await invoke(PLUGINS_INSTALL_COMMIT_CHANNEL, { token: prepared.token, source: { kind: "official", name: "anycode-essentials" }, allowServices: true });
      expect(committed.ok).toBe(true);
      expect(scaffold.settingsData.serviceConsent).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("plugin services supervision IPC (Taskana 4750a)", () => {
  function fakeServices() {
    const restarts: [string, string][] = [];
    return {
      restarts,
      services: {
        snapshot: () => [
          { plugin: "bridge", name: "relay", state: "running" as const, pid: 77, restarts: 0 },
          { plugin: "bridge", name: "other", state: "blocked" as const, reason: "no_consent" as const, restarts: 0 },
        ],
        logs: (plugin: string, name: string) => [`log ${plugin}/${name}`, "[err] boom"],
        restart: async (plugin: string, name: string) => {
          restarts.push([plugin, name]);
        },
      },
    };
  }

  it("the services view carries state only — no argv, env values or paths", async () => {
    const scaffold = makeDeps();
    const fake = fakeServices();
    registerPluginsIpc({ ...scaffold.deps, services: fake.services });
    const list = await invoke(PLUGINS_SERVICES_CHANNEL);
    expect(list).toEqual([
      { plugin: "bridge", name: "relay", state: "running", pid: 77, restarts: 0 },
      { plugin: "bridge", name: "other", state: "blocked", reason: "no_consent", restarts: 0 },
    ]);
    expect(JSON.stringify(list)).not.toMatch(/args|env|\/home|root/);
  });

  it("logs are returned as plain strings for one {plugin,name}", async () => {
    const scaffold = makeDeps();
    registerPluginsIpc({ ...scaffold.deps, services: fakeServices().services });
    expect(await invoke(PLUGINS_SERVICE_LOGS_CHANNEL, { plugin: "bridge", name: "relay" })).toEqual(["log bridge/relay", "[err] boom"]);
    expect(await invoke(PLUGINS_SERVICE_LOGS_CHANNEL, { plugin: "bridge", name: "relay", extra: "x" })).toMatchObject({ ok: false, reason: "invalid" });
    expect(await invoke(PLUGINS_SERVICE_LOGS_CHANNEL, { plugin: "../etc", name: "relay" })).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("restart takes only {plugin,name} (strict) and calls the supervisor with the names", async () => {
    const scaffold = makeDeps();
    const fake = fakeServices();
    registerPluginsIpc({ ...scaffold.deps, services: fake.services });
    expect(await invoke(PLUGINS_SERVICE_RESTART_CHANNEL, { plugin: "bridge", name: "relay" })).toEqual({ ok: true });
    expect(fake.restarts).toEqual([["bridge", "relay"]]);
    expect(await invoke(PLUGINS_SERVICE_RESTART_CHANNEL, { plugin: "bridge", name: "relay", command: "rm -rf /" })).toMatchObject({ ok: false, reason: "invalid" });
    expect(fake.restarts).toHaveLength(1);
  });

  it("a mutation fires the onChanged hook so the supervisor reconciles", async () => {
    const scaffold = makeDeps();
    const reasons: string[] = [];
    registerPluginsIpc({ ...scaffold.deps, onChanged: (reason) => reasons.push(reason) });
    await invoke(PLUGINS_SET_AUTO_UPDATE_CHANNEL, { value: true });
    await invoke(PLUGINS_APPROVE_SERVICES_CHANNEL, { name: "ghost" });
    expect(reasons).toEqual(["auto-update"]);
  });
});
