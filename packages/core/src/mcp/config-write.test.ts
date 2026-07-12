/**
 * config-write (design slice-P7.19-cut.md §4 W1): upsert/delete patch ONLY the
 * mcpServers subtree and preserve every other top-level key byte-semantically;
 * applyMcpImport FORCES enabled:false, strips secrets unless consented, and skips
 * name collisions. Sentinel test proves secret custody by execution.
 */

import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyMcpImport, deleteMcpServer, setMcpServerEnabled, upsertMcpServer } from "./config-write.js";
import type { HarnessImportCandidate } from "./harness-import.js";
import { NodeFileSystemAdapter } from "../adapters/node/node-file-system.js";
import type { FileSystemPort } from "../ports/file-system.js";

const CONFIG = "/proj/.anycode/config.json";
const SENTINEL = "SENTINEL_MCP_SECRET_93F1";

/** In-memory fs with atomic rename support so config-write exercises tmp+rename. */
function makeFs(files: Record<string, string> = {}): {
  fs: FileSystemPort;
  files: Record<string, string>;
} {
  const store: Record<string, string> = { ...files };
  const fs: FileSystemPort = {
    readFile: async (path) => {
      const content = store[path];
      if (content === undefined) {
        throw new Error(`ENOENT: ${path}`);
      }
      return content;
    },
    writeFile: async (path, content) => {
      store[path] = content;
    },
    stat: async () => ({ size: 0, mtimeMs: 0, isFile: true, isDirectory: false }),
    exists: async (path) => path in store,
    mkdir: async () => {},
    readdir: async () => [],
    rename: async (from, to) => {
      const content = store[from];
      if (content === undefined) {
        throw new Error(`ENOENT: ${from}`);
      }
      store[to] = content;
      delete store[from];
    },
  };
  return { fs, files: store };
}

function candidate(
  name: string,
  entry: HarnessImportCandidate["entry"],
  harness: HarnessImportCandidate["harness"] = "claude",
): HarnessImportCandidate {
  const envKeys = [...Object.keys(entry.env ?? {}), ...Object.keys(entry.headers ?? {})];
  return { harness, sourcePath: "/src", name, entry, envKeys };
}

/** Non-null raw read of the config file (strict indexed access). */
function raw(files: Record<string, string>): string {
  const content = files["/proj/.anycode/config.json"];
  if (content === undefined) {
    throw new Error("config file not written");
  }
  return content;
}

/** Parsed config as a loose shape for assertions. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function cfg(files: Record<string, string>): any {
  return JSON.parse(raw(files));
}

// ---------------------------------------------------------------------------
// upsert / delete + preserve-unknown-keys

describe("upsertMcpServer / deleteMcpServer", () => {
  it("creates the file (absent ⇒ {}) and writes mcpServers.<name>", async () => {
    const { fs, files } = makeFs();
    await upsertMcpServer(fs, CONFIG, "srv", { command: "node", args: ["s.js"] });
    const written = cfg(files);
    expect(written).toEqual({ mcpServers: { srv: { command: "node", args: ["s.js"] } } });
    // 2-space pretty
    expect(raw(files)).toContain('\n  "mcpServers"');
    // no leftover tmp file
    expect(Object.keys(files)).toEqual([CONFIG]);
  });

  it("preserves every other top-level key byte-semantically across upsert AND delete", async () => {
    const original = {
      hooks: { PreToolUse: [{ matcher: "Bash", command: "echo hi" }] },
      telemetry: { enabled: true, endpoint: "https://t.example" },
      repoMap: { maxFiles: 500 },
      mcpServers: { existing: { command: "old" } },
    };
    const { fs, files } = makeFs({ [CONFIG]: JSON.stringify(original, null, 2) });

    await upsertMcpServer(fs, CONFIG, "added", { url: "https://x/mcp" });
    let now = cfg(files);
    expect(now.hooks).toEqual(original.hooks);
    expect(now.telemetry).toEqual(original.telemetry);
    expect(now.repoMap).toEqual(original.repoMap);
    expect(now.mcpServers).toEqual({ existing: { command: "old" }, added: { url: "https://x/mcp" } });

    await deleteMcpServer(fs, CONFIG, "added");
    now = cfg(files);
    // Non-mcp subtree round-trips byte-identically to the original stringify.
    const originalNonMcp = { ...original } as Record<string, unknown>;
    delete originalNonMcp.mcpServers;
    const nowNonMcp = { ...now } as Record<string, unknown>;
    delete nowNonMcp.mcpServers;
    expect(JSON.stringify(nowNonMcp)).toBe(JSON.stringify(originalNonMcp));
    expect(now.mcpServers).toEqual({ existing: { command: "old" } });
  });

  it("delete is a no-op when the name is absent (still preserves the rest)", async () => {
    const { fs, files } = makeFs({ [CONFIG]: JSON.stringify({ hooks: {}, mcpServers: {} }) });
    await deleteMcpServer(fs, CONFIG, "ghost");
    expect(cfg(files)).toEqual({ hooks: {}, mcpServers: {} });
  });
});

// ---------------------------------------------------------------------------
// setMcpServerEnabled: patches ONLY .enabled, preserves cwd/secrets (W3-FIX)

describe("setMcpServerEnabled", () => {
  it("patches ONLY enabled — cwd, secret env values, args, and other top-level keys all survive verbatim", async () => {
    const original = {
      hooks: { PreToolUse: [{ matcher: "Bash", command: "echo hi" }] },
      telemetry: { enabled: true },
      mcpServers: {
        srv: {
          command: "node",
          args: ["s.js"],
          cwd: "/work/srv",
          env: { SECRET_X: SENTINEL },
          enabled: true,
        },
      },
    };
    const { fs, files } = makeFs({ [CONFIG]: JSON.stringify(original, null, 2) });

    const result = await setMcpServerEnabled(fs, CONFIG, "srv", false);
    expect(result).toEqual({ ok: true });

    const written = cfg(files);
    expect(written.mcpServers.srv).toEqual({
      command: "node",
      args: ["s.js"],
      cwd: "/work/srv",
      env: { SECRET_X: SENTINEL },
      enabled: false,
    });
    expect(written.hooks).toEqual(original.hooks);
    expect(written.telemetry).toEqual(original.telemetry);
  });

  it("returns not_found for a name absent from mcpServers", async () => {
    const { fs } = makeFs({
      [CONFIG]: JSON.stringify({ mcpServers: { other: { command: "node" } } }),
    });
    const result = await setMcpServerEnabled(fs, CONFIG, "ghost", true);
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("returns not_found when the config file itself is absent", async () => {
    const { fs } = makeFs();
    const result = await setMcpServerEnabled(fs, CONFIG, "srv", true);
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });
});

// ---------------------------------------------------------------------------
// applyMcpImport: forced-disabled, exists-skip, secret custody

describe("applyMcpImport", () => {
  it("FORCES enabled:false on every written entry even when the source had enabled:true", async () => {
    const { fs, files } = makeFs();
    const results = await applyMcpImport(
      fs,
      CONFIG,
      [candidate("a", { command: "node", enabled: true })],
      { includeEnvValues: false },
    );
    expect(results).toEqual([{ name: "a", harness: "claude", applied: true }]);
    const written = cfg(files);
    expect(written.mcpServers.a.enabled).toBe(false);
  });

  it("skips a candidate whose name already exists in the target (no overwrite)", async () => {
    const { fs, files } = makeFs({
      [CONFIG]: JSON.stringify({ mcpServers: { dup: { command: "keep-me" } } }),
    });
    const results = await applyMcpImport(
      fs,
      CONFIG,
      [candidate("dup", { command: "incoming" }), candidate("fresh", { command: "node" })],
      { includeEnvValues: false },
    );
    expect(results).toEqual([
      { name: "dup", harness: "claude", applied: false, skipped: "exists" },
      { name: "fresh", harness: "claude", applied: true },
    ]);
    const written = cfg(files);
    expect(written.mcpServers.dup.command).toBe("keep-me"); // untouched
    expect(written.mcpServers.fresh.enabled).toBe(false);
  });

  it("sentinel: without consent the written file omits the secret VALUE; with consent it includes it", async () => {
    const cand = candidate("secretSrv", { command: "node", env: { API_TOKEN: SENTINEL } });

    // Candidate itself carries the value (import-apply needs it main-side).
    expect(JSON.stringify(cand)).toContain("API_TOKEN");
    expect(JSON.stringify(cand)).toContain(SENTINEL);

    // includeEnvValues:false ⇒ value stripped, env key removed.
    const noConsent = makeFs();
    await applyMcpImport(noConsent.fs, CONFIG, [cand], { includeEnvValues: false });
    const withoutSecret = raw(noConsent.files);
    expect(withoutSecret).not.toContain(SENTINEL);
    expect(cfg(noConsent.files).mcpServers.secretSrv.env).toBeUndefined();
    expect(cfg(noConsent.files).mcpServers.secretSrv.enabled).toBe(false);

    // includeEnvValues:true ⇒ value preserved, still enabled:false.
    const consent = makeFs();
    await applyMcpImport(consent.fs, CONFIG, [cand], { includeEnvValues: true });
    const withSecret = raw(consent.files);
    expect(withSecret).toContain(SENTINEL);
    expect(cfg(consent.files).mcpServers.secretSrv.env).toEqual({ API_TOKEN: SENTINEL });
    expect(cfg(consent.files).mcpServers.secretSrv.enabled).toBe(false);
  });

  it("strips http header values too when consent is withheld", async () => {
    const cand = candidate("httpSrv", {
      url: "https://x/mcp",
      headers: { Authorization: `Bearer ${SENTINEL}` },
    });
    const { fs, files } = makeFs();
    await applyMcpImport(fs, CONFIG, [cand], { includeEnvValues: false });
    expect(raw(files)).not.toContain(SENTINEL);
    expect(cfg(files).mcpServers.httpSrv.headers).toBeUndefined();
  });

  it("preserves unrelated top-level keys when applying an import", async () => {
    const { fs, files } = makeFs({
      [CONFIG]: JSON.stringify({ telemetry: { enabled: false }, mcpServers: {} }),
    });
    await applyMcpImport(fs, CONFIG, [candidate("a", { command: "node" })], {
      includeEnvValues: false,
    });
    const written = cfg(files);
    expect(written.telemetry).toEqual({ enabled: false });
    expect(written.mcpServers.a.enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// W5-FIX (finding 7): __proto__ / reserved-key injection

describe("W5-FIX finding 7 — reserved prototype-key names", () => {
  it("upsertMcpServer refuses a `__proto__` name with a typed refusal (not a phantom success)", async () => {
    const { fs, files } = makeFs();
    const result = await upsertMcpServer(fs, CONFIG, "__proto__", { command: "node" });
    expect(result).toEqual({ ok: false, reason: "unsafe_name" });
    // Nothing was written, and the prototype was not polluted.
    expect(files[CONFIG]).toBeUndefined();
    expect(({} as Record<string, unknown>).command).toBeUndefined();
  });

  it("upsertMcpServer refuses `constructor` and `prototype` too", async () => {
    const { fs } = makeFs();
    expect(await upsertMcpServer(fs, CONFIG, "constructor", { command: "node" })).toEqual({ ok: false, reason: "unsafe_name" });
    expect(await upsertMcpServer(fs, CONFIG, "prototype", { command: "node" })).toEqual({ ok: false, reason: "unsafe_name" });
  });

  it("applyMcpImport skips a `__proto__` candidate (skipped:unsafe_name) and never pollutes the prototype", async () => {
    const { fs, files } = makeFs();
    const results = await applyMcpImport(
      fs,
      CONFIG,
      [candidate("__proto__", { command: "node" }), candidate("ok", { command: "node" })],
      { includeEnvValues: false },
    );
    expect(results).toEqual([
      { name: "__proto__", harness: "claude", applied: false, skipped: "unsafe_name" },
      { name: "ok", harness: "claude", applied: true },
    ]);
    expect(Object.keys(cfg(files).mcpServers)).toEqual(["ok"]);
    expect(({} as Record<string, unknown>).command).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// W5-FIX (finding 6): per-path write serialization (no lost updates)

describe("W5-FIX finding 6 — concurrent writes are serialized", () => {
  it("two concurrent upserts of different names on the same path both survive", async () => {
    const { fs, files } = makeFs();
    await Promise.all([
      upsertMcpServer(fs, CONFIG, "alpha", { command: "a" }),
      upsertMcpServer(fs, CONFIG, "beta", { command: "b" }),
    ]);
    const written = cfg(files);
    expect(Object.keys(written.mcpServers).sort()).toEqual(["alpha", "beta"]);
  });

  it("a concurrent upsert + import both land (read-modify-write does not clobber)", async () => {
    const { fs, files } = makeFs();
    await Promise.all([
      upsertMcpServer(fs, CONFIG, "manual", { command: "m" }),
      applyMcpImport(fs, CONFIG, [candidate("imported", { command: "i" })], { includeEnvValues: false }),
    ]);
    const written = cfg(files);
    expect(Object.keys(written.mcpServers).sort()).toEqual(["imported", "manual"]);
  });
});

// ---------------------------------------------------------------------------
// W5-FIX (finding 4): atomic write preserves an existing file's private mode

describe("W5-FIX finding 4 — atomic write does not widen file mode", () => {
  const skipMode = process.platform === "win32";

  it.skipIf(skipMode)("keeps an existing 0600 secrets-bearing config at 0600 across upsert (tmp+rename)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-mode-"));
    try {
      const path = join(dir, "config.json");
      await writeFile(path, JSON.stringify({ mcpServers: { s: { command: "node", env: { API_TOKEN: SENTINEL } } } }), "utf-8");
      await chmod(path, 0o600);
      const fs = new NodeFileSystemAdapter();
      const result = await upsertMcpServer(fs, path, "added", { command: "node" });
      expect(result).toEqual({ ok: true });
      const mode = (await stat(path)).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(skipMode)("creates a brand-new config file 0600 (may carry secrets)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-mode-new-"));
    try {
      const path = join(dir, "config.json");
      const fs = new NodeFileSystemAdapter();
      await upsertMcpServer(fs, path, "s", { command: "node", env: { API_TOKEN: SENTINEL } });
      const mode = (await stat(path)).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
