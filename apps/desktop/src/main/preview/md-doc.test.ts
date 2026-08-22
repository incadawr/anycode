/**
 * Unit tests for md-doc.ts's `readMdDoc`/`navigateMdDoc` (TASK.99 CUT.md
 * CONTRACTS — M1 READ, M2 NAVIGATE) — exercised against a REAL node fs in
 * scratch tmpdirs (no Electron), mirroring artifacts-ipc.test.ts's own "real
 * fs, fake containment resolver" pattern. `getRecordRef`/`resolveArtifact`/
 * `commitNavigate` are hand-written fakes (the record lookup/mutation is
 * PreviewHost's concern, not this module's — see preview-host.test.ts's own
 * "commitMdNavigate" suite for the REAL implementation); `stat`/
 * `readFileNoFollow` are the REAL O_NOFOLLOW read path so the cap/missing/
 * not-a-file/symlink-swap gates are proven against real fs behavior, not a
 * fake that could silently drift from it.
 */
import { constants as fsConstants } from "node:fs";
import { mkdir, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MD_PREVIEW_MAX_SOURCE_BYTES, navigateMdDoc, readMdDoc, type MdDocDeps, type MdDocRecordRef } from "./md-doc.js";

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
    // Default fake mirrors PreviewHost.commitMdNavigate's own contract
    // (bumps the record's CURRENT docVersion by one) without exercising the
    // real PreviewHost — that class's OWN commitMdNavigate logic is covered
    // by preview-host.test.ts's dedicated suite.
    commitNavigate: overrides.commitNavigate ?? vi.fn(() => (overrides.ref?.docVersion ?? 0) + 1),
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

describe("readMdDoc — .markdown (TASK.112)", () => {
  it("reads a `.markdown` document — the realPath gate accepts it exactly like `.md`", async () => {
    const dir = await tmpDir();
    const file = join(dir, "doc.markdown");
    await writeFile(file, "# hi", "utf8");
    const ref: MdDocRecordRef = { sourcePath: file, realSourcePath: file, docDir: dir, docVersion: 0 };
    const deps = makeDeps({ ref, resolveArtifact: vi.fn(async () => ({ realPath: file })) });
    const result = await readMdDoc(deps, TAB, PREVIEW);
    expect(result).toMatchObject({ ok: true });
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

describe("navigateMdDoc — no_preview", () => {
  it("refuses when getRecordRef finds nothing (no such preview / wrong tab / not a dom-md record)", async () => {
    const deps = makeDeps({ ref: undefined });
    const result = await navigateMdDoc(deps, TAB, PREVIEW, "other.md");
    expect(result).toEqual({ ok: false, reason: "no_preview" });
  });

  it("refuses no_preview when commitNavigate reports the record vanished mid-call (race)", async () => {
    const dir = await tmpDir();
    const file = join(dir, "other.md");
    await writeFile(file, "hi");
    const ref: MdDocRecordRef = { sourcePath: join(dir, "doc.md"), realSourcePath: join(dir, "doc.md"), docDir: dir, docVersion: 0 };
    const deps = makeDeps({
      ref,
      resolveArtifact: vi.fn(async () => ({ realPath: file })),
      commitNavigate: vi.fn(() => undefined),
    });
    const result = await navigateMdDoc(deps, TAB, PREVIEW, "other.md");
    expect(result).toEqual({ ok: false, reason: "no_preview" });
  });
});

describe("navigateMdDoc — doc-relative join", () => {
  it("joins a bare relative href against the record's CURRENT docDir, not sourcePath's dirname", async () => {
    const dir = await tmpDir();
    const sub = join(dir, "sub");
    await mkdir(sub);
    const file = join(sub, "other.md");
    await writeFile(file, "hi");
    const ref: MdDocRecordRef = { sourcePath: join(dir, "doc.md"), realSourcePath: join(dir, "doc.md"), docDir: sub, docVersion: 0 };
    const resolveArtifact = vi.fn(async () => ({ realPath: file }));
    const deps = makeDeps({ ref, resolveArtifact });
    await navigateMdDoc(deps, TAB, PREVIEW, "other.md");
    expect(resolveArtifact).toHaveBeenCalledWith(TAB, file);
  });

  it("joins a ../-prefixed relative href, walking up from docDir", async () => {
    const dir = await tmpDir();
    const sub = join(dir, "sub");
    await mkdir(sub);
    const target = join(dir, "sibling.md");
    await writeFile(target, "hi");
    const ref: MdDocRecordRef = { sourcePath: join(sub, "doc.md"), realSourcePath: join(sub, "doc.md"), docDir: sub, docVersion: 0 };
    const resolveArtifact = vi.fn(async () => ({ realPath: target }));
    const deps = makeDeps({ ref, resolveArtifact });
    await navigateMdDoc(deps, TAB, PREVIEW, "../sibling.md");
    expect(resolveArtifact).toHaveBeenCalledWith(TAB, target);
  });

  it("passes an absolute href straight to resolveArtifact, without joining against docDir", async () => {
    const dir = await tmpDir();
    const target = join(dir, "elsewhere.md");
    await writeFile(target, "hi");
    const ref: MdDocRecordRef = { sourcePath: join(dir, "doc.md"), realSourcePath: join(dir, "doc.md"), docDir: dir, docVersion: 0 };
    const resolveArtifact = vi.fn(async () => ({ realPath: target }));
    const deps = makeDeps({ ref, resolveArtifact });
    await navigateMdDoc(deps, TAB, PREVIEW, target);
    expect(resolveArtifact).toHaveBeenCalledWith(TAB, target);
  });

  it("strips a trailing fragment/query before joining", async () => {
    const dir = await tmpDir();
    const target = join(dir, "other.md");
    await writeFile(target, "hi");
    const ref: MdDocRecordRef = { sourcePath: join(dir, "doc.md"), realSourcePath: join(dir, "doc.md"), docDir: dir, docVersion: 0 };
    const resolveArtifact = vi.fn(async () => ({ realPath: target }));
    const deps = makeDeps({ ref, resolveArtifact });
    await navigateMdDoc(deps, TAB, PREVIEW, "other.md?x=1#section");
    expect(resolveArtifact).toHaveBeenCalledWith(TAB, target);
  });

  it("refuses not_md when the href is nothing but a fragment/query (no path portion)", async () => {
    const ref: MdDocRecordRef = { sourcePath: "/workspace/doc.md", realSourcePath: "/workspace/doc.md", docDir: "/workspace", docVersion: 0 };
    const deps = makeDeps({ ref });
    const result = await navigateMdDoc(deps, TAB, PREVIEW, "#section");
    expect(result).toEqual({ ok: false, reason: "not_md" });
  });
});

describe("navigateMdDoc — containment refusal", () => {
  it("refuses outside_roots when the joined target is not contained", async () => {
    const ref: MdDocRecordRef = { sourcePath: "/workspace/doc.md", realSourcePath: "/workspace/doc.md", docDir: "/workspace", docVersion: 0 };
    const deps = makeDeps({ ref, resolveArtifact: vi.fn(async () => ({ failure: "outside_roots" as const })) });
    const result = await navigateMdDoc(deps, TAB, PREVIEW, "../../../etc/passwd.md");
    expect(result).toEqual({ ok: false, reason: "outside_roots" });
  });

  it("refuses not_found when the joined target does not exist", async () => {
    const ref: MdDocRecordRef = { sourcePath: "/workspace/doc.md", realSourcePath: "/workspace/doc.md", docDir: "/workspace", docVersion: 0 };
    const deps = makeDeps({ ref, resolveArtifact: vi.fn(async () => ({ failure: "not_found" as const })) });
    const result = await navigateMdDoc(deps, TAB, PREVIEW, "gone.md");
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("navigateMdDoc — not_md", () => {
  it("refuses when the resolved realPath does not end in .md, even though the href did", async () => {
    // A symlink/rename edge: the href SAID .md but the resolved realpath
    // does not — the extension check runs against the REALPATH (matching
    // readMdDoc), never trusting the raw href.
    const ref: MdDocRecordRef = { sourcePath: "/workspace/doc.md", realSourcePath: "/workspace/doc.md", docDir: "/workspace", docVersion: 0 };
    const deps = makeDeps({ ref, resolveArtifact: vi.fn(async () => ({ realPath: "/workspace/other.txt" })) });
    const result = await navigateMdDoc(deps, TAB, PREVIEW, "other.md");
    expect(result).toEqual({ ok: false, reason: "not_md" });
  });
});

describe("navigateMdDoc — size cap / symlink-swap", () => {
  it("refuses too_large when the target exceeds MD_PREVIEW_MAX_SOURCE_BYTES", async () => {
    const dir = await tmpDir();
    const file = join(dir, "other.md");
    await writeFile(file, Buffer.alloc(MD_PREVIEW_MAX_SOURCE_BYTES + 1, "a"));
    const ref: MdDocRecordRef = { sourcePath: join(dir, "doc.md"), realSourcePath: join(dir, "doc.md"), docDir: dir, docVersion: 0 };
    const deps = makeDeps({ ref, resolveArtifact: vi.fn(async () => ({ realPath: file })) });
    const result = await navigateMdDoc(deps, TAB, PREVIEW, "other.md");
    expect(result).toEqual({ ok: false, reason: "too_large" });
  });

  it("refuses io_error when the final path component is a symlink at read time (O_NOFOLLOW)", async () => {
    const dir = await tmpDir();
    const target = join(dir, "real.md");
    await writeFile(target, "hi");
    const link = join(dir, "other.md");
    await symlink(target, link);
    const ref: MdDocRecordRef = { sourcePath: join(dir, "doc.md"), realSourcePath: join(dir, "doc.md"), docDir: dir, docVersion: 0 };
    const deps = makeDeps({ ref, resolveArtifact: vi.fn(async () => ({ realPath: link })) });
    const result = await navigateMdDoc(deps, TAB, PREVIEW, "other.md");
    expect(result).toEqual({ ok: false, reason: "io_error" });
  });
});

describe("navigateMdDoc — replace semantics / commit wiring", () => {
  it("commits sourcePath (the JOINED path)/realSourcePath/docDir/title to the SAME previewId, no history stack", async () => {
    const dir = await tmpDir();
    const sub = join(dir, "sub");
    await mkdir(sub);
    const target = join(sub, "other.md");
    await writeFile(target, "# Other\n");
    const ref: MdDocRecordRef = { sourcePath: join(dir, "doc.md"), realSourcePath: join(dir, "doc.md"), docDir: dir, docVersion: 5 };
    const commitNavigate = vi.fn(() => 6);
    const deps = makeDeps({ ref, resolveArtifact: vi.fn(async () => ({ realPath: target })), commitNavigate });

    const result = await navigateMdDoc(deps, TAB, PREVIEW, "sub/other.md");

    expect(commitNavigate).toHaveBeenCalledWith(TAB, PREVIEW, {
      sourcePath: join(dir, "sub/other.md"),
      realSourcePath: target,
      docDir: sub,
      title: "other.md",
    });
    expect(result).toEqual({
      ok: true,
      doc: {
        previewId: PREVIEW,
        sourcePath: join(dir, "sub/other.md"),
        realSourcePath: target,
        docDir: sub,
        sourceText: "# Other\n",
        sizeBytes: 8,
        mtimeMs: expect.any(Number),
        docVersion: 6,
      },
    });
  });

  it("returns the record's docVersion from commitNavigate's own return value, not a local increment", async () => {
    const dir = await tmpDir();
    const target = join(dir, "other.md");
    await writeFile(target, "hi");
    const ref: MdDocRecordRef = { sourcePath: join(dir, "doc.md"), realSourcePath: join(dir, "doc.md"), docDir: dir, docVersion: 0 };
    const deps = makeDeps({ ref, resolveArtifact: vi.fn(async () => ({ realPath: target })), commitNavigate: vi.fn(() => 42) });
    const result = await navigateMdDoc(deps, TAB, PREVIEW, "other.md");
    expect(result.ok && result.doc.docVersion).toBe(42);
  });

  it("reads the NEW target's fresh content, not the record's previous doc", async () => {
    const dir = await tmpDir();
    const target = join(dir, "other.md");
    await writeFile(target, "brand new content");
    const ref: MdDocRecordRef = { sourcePath: join(dir, "doc.md"), realSourcePath: join(dir, "doc.md"), docDir: dir, docVersion: 0 };
    const deps = makeDeps({ ref, resolveArtifact: vi.fn(async () => ({ realPath: target })) });
    const result = await navigateMdDoc(deps, TAB, PREVIEW, "other.md");
    expect(result.ok && result.doc.sourceText).toBe("brand new content");
  });
});
