import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureStdioAdapterCopy, resolveBundledStdioAdapter, type AdapterFs } from "./communication-adapter.js";

function memoryFs(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial));
  const writes: string[] = [];
  const modes: number[] = [];
  const fs: AdapterFs = {
    readText: (path) => files.get(path) ?? null,
    writeTextAtomic: (path, text, mode) => { writes.push(path); modes.push(mode); files.set(path, text); },
  };
  return { fs, files, writes, modes };
}

describe("resolveBundledStdioAdapter (Taskana 4747)", () => {
  it("prefers the packaged Resources copy when it exists", () => {
    const found = resolveBundledStdioAdapter({ resourcesPath: "/App/Resources", moduleDir: "/x", exists: (p) => p === "/App/Resources/agent-communication/stdio.mjs" });
    expect(found).toBe("/App/Resources/agent-communication/stdio.mjs");
  });

  it("returns null when neither packaged nor repository copy exists (missing source)", () => {
    expect(resolveBundledStdioAdapter({ resourcesPath: "/App/Resources", moduleDir: "/repo/apps/desktop/out", exists: () => false })).toBeNull();
  });

  it("walks up to the repository copy in dev", () => {
    const repo = "/repo";
    const found = resolveBundledStdioAdapter({
      moduleDir: "/repo/apps/desktop/out/main",
      exists: (p) => p === join(repo, "examples", "agent-communication", "stdio.mjs") || p === join(repo, "packages", "core", "package.json"),
    });
    expect(found).toBe(join(repo, "examples", "agent-communication", "stdio.mjs"));
  });
});

describe("ensureStdioAdapterCopy (Taskana 4747)", () => {
  it("returns null without touching the disk when the source is missing", () => {
    const m = memoryFs();
    expect(ensureStdioAdapterCopy(m.fs, null, "/ud/agent-communication")).toBeNull();
    expect(m.writes).toEqual([]);
  });

  it("copies once to the stable userData path with mode 0644", () => {
    const m = memoryFs({ "/src/stdio.mjs": "console.log(1)" });
    const target = ensureStdioAdapterCopy(m.fs, "/src/stdio.mjs", "/ud/agent-communication");
    expect(target).toBe("/ud/agent-communication/stdio.mjs");
    expect(m.files.get(target!)).toBe("console.log(1)");
    expect(m.modes).toEqual([0o644]);
  });

  it("is idempotent: an identical copy is not rewritten", () => {
    const m = memoryFs({ "/src/stdio.mjs": "same", "/ud/agent-communication/stdio.mjs": "same" });
    expect(ensureStdioAdapterCopy(m.fs, "/src/stdio.mjs", "/ud/agent-communication")).toBe("/ud/agent-communication/stdio.mjs");
    expect(m.writes).toEqual([]);
  });

  it("rewrites a stale copy when the bundled source changed", () => {
    const m = memoryFs({ "/src/stdio.mjs": "new", "/ud/agent-communication/stdio.mjs": "old" });
    ensureStdioAdapterCopy(m.fs, "/src/stdio.mjs", "/ud/agent-communication");
    expect(m.files.get("/ud/agent-communication/stdio.mjs")).toBe("new");
    expect(m.writes).toHaveLength(1);
  });

  it("returns null (no throw) when the copy itself fails", () => {
    const fs: AdapterFs = { readText: (p) => (p === "/src/stdio.mjs" ? "x" : null), writeTextAtomic: () => { throw new Error("EACCES /secret"); } };
    expect(ensureStdioAdapterCopy(fs, "/src/stdio.mjs", "/ud")).toBeNull();
  });
});

describe("electron-builder ships the adapter (Taskana 4747 source test)", () => {
  it("lists agent-communication/stdio.mjs in extraResources", () => {
    const yml = readFileSync(new URL("../../electron-builder.yml", import.meta.url), "utf8");
    expect(yml).toMatch(/from: \.\.\/\.\.\/examples\/agent-communication\/stdio\.mjs\s*\n\s*to: agent-communication\/stdio\.mjs/);
  });
});
