/**
 * config-write tests (Taskana 4743): upsert/delete patch ONLY the `lspServers`
 * array and preserve every other top-level key and every unrelated array item
 * (valid AND invalid ones — the array is user-editable); replace-by-name,
 * append, delete, delete-missing no-op; a non-array `lspServers` is refused
 * (`invalid_shape`) on upsert and left untouched on delete; a bad entry and a
 * dangerous name are refused. Mirrors mcp/config-write.test.ts's fake-fs style.
 */

import { describe, expect, it } from "vitest";
import { deleteLspServer, upsertLspServer } from "./config-write.js";
import type { LspServerEntry } from "./config.js";
import type { FileSystemPort } from "../ports/file-system.js";

const CONFIG = "/proj/.anycode/config.json";

/** In-memory fs with atomic rename support so config-write exercises tmp+rename. */
function makeFs(files: Record<string, string> = {}): { fs: FileSystemPort; files: Record<string, string> } {
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

function typescript(): LspServerEntry {
  return {
    name: "typescript",
    command: "typescript-language-server",
    args: ["--stdio"],
    extensions: [".ts", ".tsx", ".js", ".jsx"],
  };
}

function read(files: Record<string, string>): Record<string, unknown> {
  return JSON.parse(files[CONFIG]!);
}

describe("upsertLspServer", () => {
  it("creates the file (absent ⇒ {}) and appends the entry", async () => {
    const { fs, files } = makeFs();
    const result = await upsertLspServer(fs, CONFIG, typescript());
    expect(result).toEqual({ ok: true });
    expect(read(files)).toEqual({ lspServers: [typescript()] });
  });

  it("creates the lspServers array when the key is absent, preserving other keys", async () => {
    const { fs, files } = makeFs({
      [CONFIG]: JSON.stringify({ mcpServers: { context7: { command: "npx" } }, telemetry: { enabled: true } }),
    });
    await upsertLspServer(fs, CONFIG, typescript());
    const config = read(files);
    expect(config.mcpServers).toEqual({ context7: { command: "npx" } });
    expect(config.telemetry).toEqual({ enabled: true });
    expect(config.lspServers).toEqual([typescript()]);
  });

  it("replaces by name instead of appending a duplicate", async () => {
    const existing = { name: "typescript", command: "old-command", extensions: [".ts"] };
    const { fs, files } = makeFs({ [CONFIG]: JSON.stringify({ lspServers: [existing] }) });
    await upsertLspServer(fs, CONFIG, typescript());
    expect(read(files).lspServers).toEqual([typescript()]);
  });

  it("preserves every other top-level key AND every unrelated array item, including an invalid one", async () => {
    const unrelated = { name: "other", command: "other-server", extensions: [".zz"] };
    const invalid = { name: 42 }; // a hand-edit the loader would skip with an issue
    const { fs, files } = makeFs({
      [CONFIG]: JSON.stringify({
        skills: { disabled: ["example-skill"] },
        hooks: { preToolUse: [{ command: "make" }] },
        lspServers: [unrelated, invalid],
      }),
    });
    await upsertLspServer(fs, CONFIG, typescript());
    const config = read(files);
    expect(config.skills).toEqual({ disabled: ["example-skill"] });
    expect(config.hooks).toEqual({ preToolUse: [{ command: "make" }] });
    expect(config.lspServers).toEqual([unrelated, invalid, typescript()]);
  });

  it("replaces only the FIRST matching name (loader precedence dedups by name the same way)", async () => {
    const first = { name: "typescript", command: "first", extensions: [".ts"] };
    const second = { name: "typescript", command: "second", extensions: [".ts"] };
    const { fs, files } = makeFs({ [CONFIG]: JSON.stringify({ lspServers: [first, second] }) });
    await upsertLspServer(fs, CONFIG, typescript());
    expect(read(files).lspServers).toEqual([typescript(), second]);
  });

  it("preserves initializationOptions on the WRITTEN entry (the loader passes them through)", async () => {
    const entry: LspServerEntry = { ...typescript(), initializationOptions: { hostInfo: "anycode" } };
    const { fs, files } = makeFs();
    await upsertLspServer(fs, CONFIG, entry);
    expect(read(files).lspServers).toEqual([entry]);
  });

  it("refuses a non-array lspServers with invalid_shape and writes NOTHING", async () => {
    const raw = JSON.stringify({ lspServers: { typescript: { command: "x" } } });
    const { fs, files } = makeFs({ [CONFIG]: raw });
    const result = await upsertLspServer(fs, CONFIG, typescript());
    expect(result).toEqual({ ok: false, reason: "invalid_shape" });
    expect(files[CONFIG]).toBe(raw);
  });

  it("refuses a dangerous name (unsafe_name) — no phantom success, no prototype pollution", async () => {
    const { fs, files } = makeFs();
    const result = await upsertLspServer(fs, CONFIG, { name: "__proto__", command: "x", extensions: [".ts"] });
    expect(result).toEqual({ ok: false, reason: "unsafe_name" });
    expect(files[CONFIG]).toBeUndefined();
    expect(({} as Record<string, unknown>).lspServers).toBeUndefined();
  });

  it("refuses constructor and prototype too", async () => {
    const { fs } = makeFs();
    for (const name of ["constructor", "prototype"]) {
      const result = await upsertLspServer(fs, CONFIG, { name, command: "x", extensions: [".ts"] });
      expect(result).toEqual({ ok: false, reason: "unsafe_name" });
    }
  });

  it("refuses an entry that fails lspServerEntrySchema (invalid_shape)", async () => {
    const { fs, files } = makeFs();
    const result = await upsertLspServer(fs, CONFIG, { name: "bad", command: "x", extensions: [] });
    expect(result).toEqual({ ok: false, reason: "invalid_shape" });
    expect(files[CONFIG]).toBeUndefined();
  });
});

describe("deleteLspServer", () => {
  it("removes the named entry, preserving other keys and unrelated items", async () => {
    const keep = { name: "other", command: "other-server", extensions: [".zz"] };
    const invalid = { nope: true };
    const { fs, files } = makeFs({
      [CONFIG]: JSON.stringify({ telemetry: { enabled: true }, lspServers: [typescript(), keep, invalid] }),
    });
    await deleteLspServer(fs, CONFIG, "typescript");
    const config = read(files);
    expect(config.telemetry).toEqual({ enabled: true });
    expect(config.lspServers).toEqual([keep, invalid]);
  });

  it("delete of a missing name is a no-op that still rewrites nothing (byte-identical file)", async () => {
    const raw = JSON.stringify({ lspServers: [typescript()] });
    const { fs, files } = makeFs({ [CONFIG]: raw });
    await deleteLspServer(fs, CONFIG, "no-such-server");
    expect(files[CONFIG]).toBe(raw);
  });

  it("delete from an absent file is a no-op", async () => {
    const { fs, files } = makeFs();
    await deleteLspServer(fs, CONFIG, "typescript");
    expect(files[CONFIG]).toBeUndefined();
  });

  it("delete with a non-array lspServers leaves the file untouched (never clobbers the unknown)", async () => {
    const raw = JSON.stringify({ lspServers: "weird" });
    const { fs, files } = makeFs({ [CONFIG]: raw });
    await deleteLspServer(fs, CONFIG, "typescript");
    expect(files[CONFIG]).toBe(raw);
  });
});
