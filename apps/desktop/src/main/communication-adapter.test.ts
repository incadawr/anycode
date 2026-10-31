import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureStdioAdapterCopy, nodeAdapterFs, resolveBundledStdioAdapter, type AdapterFs } from "./communication-adapter.js";

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

describe("refreshing the copy in user data after an app update (real fs)", () => {
  it("replaces an outdated copy with the bundled adapter and is idempotent after that", async () => {
    const root = await mkdtemp(join(tmpdir(), "anycode-adapter-"));
    try {
      const source = join(root, "bundled", "stdio.mjs");
      await mkdir(join(root, "bundled"), { recursive: true });
      await writeFile(source, "// bundled v2\n", { mode: 0o644 });
      const targetDir = join(root, "userData", "agent-communication");
      await mkdir(targetDir, { recursive: true, mode: 0o700 });
      const target = join(targetDir, "stdio.mjs");
      // A copy left behind by an older release (different content, stricter mode).
      await writeFile(target, "// stale v1\n", { mode: 0o600 });

      expect(ensureStdioAdapterCopy(nodeAdapterFs, source, targetDir)).toBe(target);
      expect(await readFile(target, "utf8")).toBe("// bundled v2\n");
      expect((await stat(target)).mode & 0o002).toBe(0);
      expect(existsSync(`${target}.tmp`)).toBe(false);

      const before = (await stat(target)).mtimeMs;
      expect(ensureStdioAdapterCopy(nodeAdapterFs, source, targetDir)).toBe(target);
      expect(await readFile(target, "utf8")).toBe("// bundled v2\n");
      expect((await stat(target)).mtimeMs).toBe(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("creates the missing target directory on a fresh profile", async () => {
    const root = await mkdtemp(join(tmpdir(), "anycode-adapter-"));
    try {
      const source = join(root, "stdio.mjs");
      await writeFile(source, "// bundled\n", { mode: 0o644 });
      const targetDir = join(root, "fresh-userData", "agent-communication");
      expect(ensureStdioAdapterCopy(nodeAdapterFs, source, targetDir)).toBe(join(targetDir, "stdio.mjs"));
      expect(await readFile(join(targetDir, "stdio.mjs"), "utf8")).toBe("// bundled\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("the host refreshes that copy on every start", () => {
  it("calls the adapter refresh unconditionally before wiring the Sessions API IPC", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const refresh = source.search(/^\s*stdioAdapterForHost\(app\.getPath\("userData"\)\);$/m);
    expect(refresh).toBeGreaterThan(-1);
    expect(refresh).toBeLessThan(source.indexOf("registerCommunicationIpc({"));
  });
});

describe("electron-builder ships the adapter (Taskana 4747 source test)", () => {
  it("lists agent-communication/stdio.mjs in extraResources", () => {
    const yml = readFileSync(new URL("../../electron-builder.yml", import.meta.url), "utf8");
    expect(yml).toMatch(/from: \.\.\/\.\.\/examples\/agent-communication\/stdio\.mjs\s*\n\s*to: agent-communication\/stdio\.mjs/);
  });
});
