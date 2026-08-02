/**
 * Unit tests for md-doc.ts's `readMdDoc` (TASK.99 CUT.md CONTRACTS, M1) —
 * exercised against a REAL node fs in scratch tmpdirs (no Electron), mirroring
 * artifacts-ipc.test.ts's own "real fs, fake containment resolver" pattern.
 * `getRecordRef`/`resolveArtifact` are hand-written fakes (the record/
 * containment lookups are PreviewHost's concern, not this module's); `stat`/
 * `readFileNoFollow` are the REAL O_NOFOLLOW read path so the cap/missing/
 * not-a-file/symlink-swap gates are proven against real fs behavior, not a
 * fake that could silently drift from it.
 */
import { constants as fsConstants } from "node:fs";
import { mkdir, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MD_PREVIEW_MAX_SOURCE_BYTES, readMdDoc, type MdDocDeps, type MdDocRecordRef } from "./md-doc.js";

const TAB = "tab-1";
const PREVIEW = "preview-1";
const dirs: string[] = [];

async function tmpDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "md-doc-test-"));
  dirs.push(d);
  return d;
}

afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

/** Real fs stat/read, mirroring NodeArtifactsFs (artifacts-ipc.ts) exactly. */
async function realStat(path: string): Promise<{ size: number; isFile: boolean; mtimeMs: number }> {
  const { stat } = await import("node:fs/promises");
  const s = await stat(path);
  return { size: s.size, isFile: s.isFile(), mtimeMs: s.mtimeMs };
}

async function realReadFileNoFollow(path: string): Promise<Buffer> {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/** `resolveArtifact` fake: anything under `root` resolves as contained; everything else refuses `outside_roots`. Missing files refuse `not_found` first. */
function makeResolveArtifact(root: string) {
  return vi.fn(async (_tabId: string, path: string): Promise<{ realPath: string } | { failure: "not_found" | "outside_roots" }> => {
    if (!path.startsWith(root)) {
      return { failure: "outside_roots" };
    }
    return { realPath: path };
  });
}

function makeDeps(overrides: Partial<MdDocDeps> & { ref?: MdDocRecordRef | undefined; root?: string } = {}): MdDocDeps {
  const root = overrides.root ?? "/workspace";
  return {
    getRecordRef: vi.fn(() => overrides.ref),
    resolveArtifact: overrides.resolveArtifact ?? makeResolveArtifact(root),
    stat: overrides.stat ?? realStat,
    readFileNoFollow: overrides.readFileNoFollow ?? realReadFileNoFollow,
  };
}

describe("readMdDoc — no_preview", () => {
  it("refuses when getRecordRef finds nothing (no such preview / wrong tab / not a dom-md record)", async () => {
    const deps = makeDeps({ ref: undefined });
    const result = await readMdDoc(deps, TAB, PREVIEW);
    expect(result).toEqual({ ok: false, reason: "no_preview" });
  });
});

describe("readMdDoc — containment re-check", () => {
  it("refuses outside_roots when the fresh resolve says uncontained (a workspace/symlink change since open time)", async () => {
    const ref: MdDocRecordRef = { sourcePath: "/elsewhere/doc.md", realSourcePath: "/elsewhere/doc.md", docDir: "/elsewhere", docVersion: 0 };
    const deps = makeDeps({ ref, root: "/workspace" });
    const result = await readMdDoc(deps, TAB, PREVIEW);
    expect(result).toEqual({ ok: false, reason: "outside_roots" });
  });

  it("refuses not_found when the fresh resolve says the file no longer exists", async () => {
    const ref: MdDocRecordRef = { sourcePath: "/workspace/gone.md", realSourcePath: "/workspace/gone.md", docDir: "/workspace", docVersion: 0 };
    const deps = makeDeps({ ref, resolveArtifact: vi.fn(async () => ({ failure: "not_found" as const })) });
    const result = await readMdDoc(deps, TAB, PREVIEW);
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("re-resolves the record's ORIGINAL sourcePath, not a cached realSourcePath", async () => {
    const resolveArtifact = vi.fn(async () => ({ realPath: "/workspace/doc.md" }));
    const ref: MdDocRecordRef = { sourcePath: "doc.md", realSourcePath: "/workspace/doc.md", docDir: "/workspace", docVersion: 0 };
    const dir = await tmpDir();
    const file = join(dir, "doc.md");
    await writeFile(file, "hi");
    resolveArtifact.mockResolvedValue({ realPath: file });
    const deps = makeDeps({ ref, resolveArtifact });
    await readMdDoc(deps, TAB, PREVIEW);
    expect(resolveArtifact).toHaveBeenCalledWith(TAB, "doc.md");
  });
});

describe("readMdDoc — not_md", () => {
  it("refuses when the resolved realPath does not end in .md", async () => {
    const ref: MdDocRecordRef = { sourcePath: "/workspace/doc.txt", realSourcePath: "/workspace/doc.txt", docDir: "/workspace", docVersion: 0 };
    const deps = makeDeps({ ref, resolveArtifact: vi.fn(async () => ({ realPath: "/workspace/doc.txt" })) });
    const result = await readMdDoc(deps, TAB, PREVIEW);
    expect(result).toEqual({ ok: false, reason: "not_md" });
  });
});

describe("readMdDoc — missing / not-a-file", () => {
  it("refuses not_found when stat throws (deleted between resolve and stat)", async () => {
    const dir = await tmpDir();
    const missing = join(dir, "doc.md");
    const ref: MdDocRecordRef = { sourcePath: missing, realSourcePath: missing, docDir: dir, docVersion: 0 };
    const deps = makeDeps({ ref, resolveArtifact: vi.fn(async () => ({ realPath: missing })) });
    const result = await readMdDoc(deps, TAB, PREVIEW);
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("refuses not_found when the resolved path is a directory, not a file", async () => {
    const dir = await tmpDir();
    const subdir = join(dir, "doc.md");
    await mkdir(subdir);
    const ref: MdDocRecordRef = { sourcePath: subdir, realSourcePath: subdir, docDir: dir, docVersion: 0 };
    const deps = makeDeps({ ref, resolveArtifact: vi.fn(async () => ({ realPath: subdir })) });
    const result = await readMdDoc(deps, TAB, PREVIEW);
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("readMdDoc — size cap", () => {
  it("refuses too_large when the file exceeds MD_PREVIEW_MAX_SOURCE_BYTES", async () => {
    const dir = await tmpDir();
    const file = join(dir, "doc.md");
    await writeFile(file, Buffer.alloc(MD_PREVIEW_MAX_SOURCE_BYTES + 1, "a"));
    const ref: MdDocRecordRef = { sourcePath: file, realSourcePath: file, docDir: dir, docVersion: 0 };
    const deps = makeDeps({ ref, resolveArtifact: vi.fn(async () => ({ realPath: file })) });
    const result = await readMdDoc(deps, TAB, PREVIEW);
    expect(result).toEqual({ ok: false, reason: "too_large" });
  });

  it("allows a file exactly at the cap", async () => {
    const dir = await tmpDir();
    const file = join(dir, "doc.md");
    await writeFile(file, Buffer.alloc(MD_PREVIEW_MAX_SOURCE_BYTES, "a"));
    const ref: MdDocRecordRef = { sourcePath: file, realSourcePath: file, docDir: dir, docVersion: 0 };
    const deps = makeDeps({ ref, resolveArtifact: vi.fn(async () => ({ realPath: file })) });
    const result = await readMdDoc(deps, TAB, PREVIEW);
    expect(result.ok).toBe(true);
  });
});

describe("readMdDoc — symlink-swap (O_NOFOLLOW)", () => {
  it("refuses io_error when the final path component is a symlink at read time", async () => {
    const dir = await tmpDir();
    const target = join(dir, "real.md");
    await writeFile(target, "hi");
    const link = join(dir, "doc.md");
    await symlink(target, link);
    const ref: MdDocRecordRef = { sourcePath: link, realSourcePath: link, docDir: dir, docVersion: 0 };
    // `stat` follows symlinks (matches the real fs.stat semantics) so the
    // file "exists" from the cap-check's point of view — it is the
    // NOFOLLOW read that must refuse.
    const deps = makeDeps({ ref, resolveArtifact: vi.fn(async () => ({ realPath: link })) });
    const result = await readMdDoc(deps, TAB, PREVIEW);
    expect(result).toEqual({ ok: false, reason: "io_error" });
  });
});

describe("readMdDoc — success", () => {
  it("returns the doc payload with fresh source text, size, mtime, and the record's docVersion", async () => {
    const dir = await tmpDir();
    const file = join(dir, "doc.md");
    await writeFile(file, "# Hello\n");
    const ref: MdDocRecordRef = { sourcePath: file, realSourcePath: file, docDir: dir, docVersion: 3 };
    const deps = makeDeps({ ref, resolveArtifact: vi.fn(async () => ({ realPath: file })) });
    const result = await readMdDoc(deps, TAB, PREVIEW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.doc).toMatchObject({
        previewId: PREVIEW,
        sourcePath: file,
        realSourcePath: file,
        docDir: dir,
        sourceText: "# Hello\n",
        sizeBytes: 8,
        docVersion: 3,
      });
      expect(result.doc.mtimeMs).toBeGreaterThan(0);
    }
  });

  it("no cache — a second call (Reload) observes a file edited between calls", async () => {
    const dir = await tmpDir();
    const file = join(dir, "doc.md");
    await writeFile(file, "first");
    const ref: MdDocRecordRef = { sourcePath: file, realSourcePath: file, docDir: dir, docVersion: 0 };
    const deps = makeDeps({ ref, resolveArtifact: vi.fn(async () => ({ realPath: file })) });

    const first = await readMdDoc(deps, TAB, PREVIEW);
    expect(first.ok && first.doc.sourceText).toBe("first");

    await writeFile(file, "second, edited on disk");
    const second = await readMdDoc(deps, TAB, PREVIEW);
    expect(second.ok && second.doc.sourceText).toBe("second, edited on disk");
  });
});
