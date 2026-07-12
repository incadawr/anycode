import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFileSystemAdapter } from "./node-file-system.js";

describe("NodeFileSystemAdapter", () => {
  let tmpDir: string;
  const adapter = new NodeFileSystemAdapter();

  afterEach(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  it("writes and reads a file round-trip", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "anycode-fs-"));
    const filePath = join(tmpDir, "a.txt");
    await adapter.writeFile(filePath, "hello world");
    expect(await adapter.readFile(filePath)).toBe("hello world");
  });

  it("creates parent directories on write", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "anycode-fs-"));
    const filePath = join(tmpDir, "nested", "deep", "b.txt");
    await adapter.writeFile(filePath, "nested content");
    expect(await adapter.readFile(filePath)).toBe("nested content");
  });

  it("overwrites existing content", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "anycode-fs-"));
    const filePath = join(tmpDir, "c.txt");
    await adapter.writeFile(filePath, "first");
    await adapter.writeFile(filePath, "second");
    expect(await adapter.readFile(filePath)).toBe("second");
  });

  it("rejects reading a missing file", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "anycode-fs-"));
    await expect(adapter.readFile(join(tmpDir, "missing.txt"))).rejects.toThrow();
  });

  it("readFileBytes round-trips a binary buffer verbatim", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "anycode-fs-"));
    const filePath = join(tmpDir, "blob.bin");
    // A byte sequence with a NUL and high bytes that UTF-8 decoding would mangle.
    const original = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x0d, 0x0a]);
    await writeFile(filePath, original);
    const bytes = await adapter.readFileBytes(filePath);
    expect(Buffer.from(bytes).equals(original)).toBe(true);
  });

  it("readFileBytes rejects a missing file (ENOENT)", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "anycode-fs-"));
    await expect(adapter.readFileBytes(join(tmpDir, "missing.bin"))).rejects.toThrow();
  });

  it("stat reports size/type for files and directories", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "anycode-fs-"));
    const filePath = join(tmpDir, "d.txt");
    await adapter.writeFile(filePath, "1234");
    const fileStat = await adapter.stat(filePath);
    expect(fileStat.isFile).toBe(true);
    expect(fileStat.isDirectory).toBe(false);
    expect(fileStat.size).toBe(4);

    const dirStat = await adapter.stat(tmpDir);
    expect(dirStat.isDirectory).toBe(true);
    expect(dirStat.isFile).toBe(false);
  });

  it("exists returns true/false correctly", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "anycode-fs-"));
    const filePath = join(tmpDir, "e.txt");
    expect(await adapter.exists(filePath)).toBe(false);
    await adapter.writeFile(filePath, "x");
    expect(await adapter.exists(filePath)).toBe(true);
  });

  it("mkdir creates recursively and is idempotent", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "anycode-fs-"));
    const dirPath = join(tmpDir, "x", "y", "z");
    await adapter.mkdir(dirPath);
    expect((await adapter.stat(dirPath)).isDirectory).toBe(true);
    await expect(adapter.mkdir(dirPath)).resolves.toBeUndefined();
  });

  it("readdir lists entry names", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "anycode-fs-"));
    await adapter.writeFile(join(tmpDir, "f1.txt"), "1");
    await adapter.writeFile(join(tmpDir, "f2.txt"), "2");
    await adapter.mkdir(join(tmpDir, "subdir"));
    const entries = await adapter.readdir(tmpDir);
    expect([...entries].sort()).toEqual(["f1.txt", "f2.txt", "subdir"]);
  });
});
