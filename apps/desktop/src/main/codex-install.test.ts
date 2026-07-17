import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexDoctorReport } from "../shared/codex-doctor.js";
import { BUNDLED_CODEX_MANIFEST } from "../shared/codex-support.js";
import {
  createCodexInstallController,
  downloadCodexTarball,
  extractCodexVendorSubtree,
  installCodexVersion,
  resolveCodexArtifact,
} from "./codex-install.js";
import { resetActiveCodexVersionPolicy, setActiveCodexVersionPolicy } from "./codex-manifest.js";

/** BM3 red-proof plumbing: a call-log of every `open(...).sync()` and `rename`
 * this whole test file's production code triggers, so ONE test (below) can
 * assert ordering — every extracted file and the staging directory synced
 * BEFORE the atomic rename, the destination's parent synced after — without
 * touching real fsync semantics (the wrapped calls still hit real fs). */
const { fsyncCallLog } = vi.hoisted(() => ({ fsyncCallLog: [] as string[] }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: any[]) => {
      const handle = await (actual.open as any)(...args);
      const path = String(args[0]);
      const originalSync = handle.sync.bind(handle);
      handle.sync = async () => {
        fsyncCallLog.push(`sync:${path}`);
        await originalSync();
      };
      return handle;
    },
    rename: async (...args: any[]) => {
      fsyncCallLog.push(`rename:${String(args[0])}->${String(args[1])}`);
      return (actual.rename as any)(...args);
    },
  };
});

afterEach(() => resetActiveCodexVersionPolicy());

const TRIPLE = "aarch64-apple-darwin";
const VERSION = "0.144.3";
const SUFFIX_VERSION = `${VERSION}-darwin-arm64`;
const METADATA_URL = `https://registry.npmjs.org/@openai/codex/${SUFFIX_VERSION}`;
const TARBALL_URL = `https://registry.npmjs.org/@openai/codex/-/codex-${SUFFIX_VERSION}.tgz`;

// ── minimal ustar builder: the ONLY way to synthesize the evil archives (traversal, symlinks, forged sizes) these tests must prove are refused ──

interface TarEntrySpec {
  name: string;
  data?: Buffer;
  typeflag?: string;
  mode?: number;
  linkname?: string;
}

function tarHeader(name: string, size: number, typeflag: string, mode: number, linkname: string): Buffer {
  const buf = Buffer.alloc(512);
  buf.write(name, 0, 100, "utf8");
  buf.write(`${mode.toString(8).padStart(7, "0")}\0`, 100, 8);
  buf.write("0000000\0", 108, 8); // uid
  buf.write("0000000\0", 116, 8); // gid
  buf.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12);
  buf.write("00000000000\0", 136, 12); // mtime
  buf.write("        ", 148, 8); // checksum placeholder: spaces while summing
  buf.write(typeflag, 156, 1);
  buf.write(linkname, 157, 100, "utf8");
  buf.write("ustar\0", 257, 6);
  buf.write("00", 263, 2);
  let sum = 0;
  for (const byte of buf) sum += byte;
  buf.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return buf;
}

function entryBytes(entry: TarEntrySpec): Buffer[] {
  const data = entry.data ?? Buffer.alloc(0);
  const parts = [tarHeader(entry.name, data.length, entry.typeflag ?? "0", entry.mode ?? 0o644, entry.linkname ?? "")];
  if (data.length > 0) {
    parts.push(data);
    const pad = 512 - (data.length % 512);
    if (pad < 512) parts.push(Buffer.alloc(pad));
  }
  return parts;
}

function buildTgz(entries: TarEntrySpec[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) parts.push(...entryBytes(entry));
  parts.push(Buffer.alloc(1024)); // end-of-archive: two zero blocks
  return gzipSync(Buffer.concat(parts));
}

/** Same shape as `buildTgz`, but with a SINGLE zero block spliced in between
 * `before` and `after` — the BM2 red-proof shape: a lone terminator-lookalike
 * that must NOT be mistaken for end-of-archive when a real entry follows it. */
function buildTgzWithLoneZeroBlock(before: TarEntrySpec[], after: TarEntrySpec[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of before) parts.push(...entryBytes(entry));
  parts.push(Buffer.alloc(512)); // lone zero block — NOT the real terminator
  for (const entry of after) parts.push(...entryBytes(entry));
  parts.push(Buffer.alloc(1024)); // the real end-of-archive terminator
  return gzipSync(Buffer.concat(parts));
}

function sri(bytes: Buffer): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

/** The canonical well-formed artifact these tests install: the W0-R2 layout (vendor subtree + shim wrapper files that must be skipped). */
function goodArchive(overrides: { layoutVersion?: number; entrypoint?: string } = {}): Buffer {
  const codexPackage = JSON.stringify({
    layoutVersion: overrides.layoutVersion ?? 1,
    version: VERSION,
    target: TRIPLE,
    variant: "codex",
    entrypoint: overrides.entrypoint ?? "bin/codex",
    resourcesDir: "codex-resources",
    pathDir: "codex-path",
  });
  return buildTgz([
    { name: "package/package.json", data: Buffer.from("{}") },
    { name: "package/README.md", data: Buffer.from("readme") },
    { name: `package/vendor/${TRIPLE}/codex-package.json`, data: Buffer.from(codexPackage) },
    { name: `package/vendor/${TRIPLE}/bin/`, typeflag: "5", mode: 0o755 },
    { name: `package/vendor/${TRIPLE}/bin/codex`, data: Buffer.from("#!/bin/sh\necho codex-cli 0.144.3\n"), mode: 0o755 },
    { name: `package/vendor/${TRIPLE}/codex-path/rg`, data: Buffer.from("rg-bytes"), mode: 0o755 },
    { name: `package/vendor/${TRIPLE}/codex-resources/zsh/bin/zsh`, data: Buffer.from("zsh-bytes"), mode: 0o755 },
  ]);
}

function metadataFor(tgz: Buffer, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: "@openai/codex",
    version: SUFFIX_VERSION,
    os: ["darwin"],
    cpu: ["arm64"],
    dist: { tarball: TARBALL_URL, integrity: sri(tgz) },
    ...overrides,
  });
}

/** Serves the two registry URLs from memory; anything else is a test bug. */
function registryFetch(routes: Record<string, () => Response>): { calls: string[]; fetchImpl: typeof fetch } {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const route = routes[url];
    if (route === undefined) return new Response("not found", { status: 404 });
    return route();
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function fetchServing(tgz: Buffer, metadataOverrides: Record<string, unknown> = {}): { calls: string[]; fetchImpl: typeof fetch } {
  return registryFetch({
    [METADATA_URL]: () => new Response(metadataFor(tgz, metadataOverrides), { status: 200 }),
    [TARBALL_URL]: () => new Response(new Uint8Array(tgz), { status: 200 }),
  });
}

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "anycode-codex-install-test-"));
}

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function home(): string {
  const dir = tmpHome();
  scratch.push(dir);
  return dir;
}

const DARWIN_ARM = { platform: "darwin" as NodeJS.Platform, arch: "arm64" };

describe("resolveCodexArtifact (amended §A4.1 — strict validation, fail-closed)", () => {
  it("resolves version+platform to the registry tarball/integrity via ONE version-suffix request", async () => {
    const tgz = goodArchive();
    const { calls, fetchImpl } = fetchServing(tgz);
    const resolved = await resolveCodexArtifact(VERSION, { ...DARWIN_ARM, fetchImpl });
    expect(resolved).toEqual({ ok: true, tarballUrl: TARBALL_URL, integrity: sri(tgz) });
    expect(calls).toEqual([METADATA_URL]);
  });

  it("fails closed on an unsupported platform/arch combination without any network call", async () => {
    const { calls, fetchImpl } = fetchServing(goodArchive());
    const resolved = await resolveCodexArtifact(VERSION, { platform: "sunos" as NodeJS.Platform, arch: "sparc", fetchImpl });
    expect(resolved.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it.each([
    ["wrong package name", { name: "@evil/codex" }],
    ["wrong version echo", { version: "9.9.9-darwin-arm64" }],
    ["os mismatch", { os: ["linux"] }],
    ["cpu mismatch", { cpu: ["x64"] }],
    ["missing integrity", { dist: { tarball: TARBALL_URL } }],
    ["non-sha512 integrity", { dist: { tarball: TARBALL_URL, integrity: "sha1-AAAA" } }],
    ["tarball on a foreign host", { dist: { tarball: "https://evil.example.com/codex.tgz", integrity: "sha512-AAAA" } }],
    ["non-https tarball", { dist: { tarball: "http://registry.npmjs.org/x.tgz", integrity: "sha512-AAAA" } }],
  ])("refuses metadata with %s", async (_label, overrides) => {
    const { fetchImpl } = fetchServing(goodArchive(), overrides);
    const resolved = await resolveCodexArtifact(VERSION, { ...DARWIN_ARM, fetchImpl });
    expect(resolved.ok).toBe(false);
  });

  it("refuses a non-200 metadata response and malformed JSON", async () => {
    for (const response of [() => new Response("nope", { status: 500 }), () => new Response("{oops", { status: 200 })]) {
      const { fetchImpl } = registryFetch({ [METADATA_URL]: response });
      const resolved = await resolveCodexArtifact(VERSION, { ...DARWIN_ARM, fetchImpl });
      expect(resolved.ok).toBe(false);
    }
  });

  it("refuses a version string that is not strict X.Y.Z (path/URL injection guard)", async () => {
    const { calls, fetchImpl } = fetchServing(goodArchive());
    for (const bad of ["../evil", "0.144", "0.144.3-darwin-arm64", "latest", ""]) {
      const resolved = await resolveCodexArtifact(bad, { ...DARWIN_ARM, fetchImpl });
      expect(resolved.ok).toBe(false);
    }
    expect(calls).toEqual([]);
  });
});

describe("downloadCodexTarball (sha512 BEFORE anything else, gate B)", () => {
  it("streams the body to disk (mode 0600, never executable) and passes on an exact integrity match", async () => {
    const dir = home();
    const tgz = goodArchive();
    const dest = join(dir, "artifact.tgz");
    const { fetchImpl } = fetchServing(tgz);
    const result = await downloadCodexTarball(TARBALL_URL, { integrity: sri(tgz), destFile: dest, fetchImpl });
    expect(result).toEqual({ ok: true });
    expect(readFileSync(dest).equals(tgz)).toBe(true);
    expect(statSync(dest).mode & 0o111).toBe(0);
  });

  it("deletes the file on an integrity mismatch — it never survives, executable or otherwise (red-proof target)", async () => {
    const dir = home();
    const dest = join(dir, "artifact.tgz");
    const { fetchImpl } = fetchServing(goodArchive());
    const result = await downloadCodexTarball(TARBALL_URL, {
      integrity: `sha512-${createHash("sha512").update("something else").digest("base64")}`,
      destFile: dest,
      fetchImpl,
    });
    expect(result.ok).toBe(false);
    expect(existsSync(dest)).toBe(false);
  });

  it("aborts and deletes when the body exceeds the size cap", async () => {
    const dir = home();
    const dest = join(dir, "artifact.tgz");
    const big = Buffer.alloc(64 * 1024, 7);
    const { fetchImpl } = registryFetch({ [TARBALL_URL]: () => new Response(new Uint8Array(big), { status: 200 }) });
    const result = await downloadCodexTarball(TARBALL_URL, { integrity: sri(big), destFile: dest, fetchImpl, maxBytes: 16 * 1024 });
    expect(result.ok).toBe(false);
    expect(existsSync(dest)).toBe(false);
  });

  it("refuses a non-200 and a redirect instead of following it off-host", async () => {
    const dir = home();
    for (const status of [500, 302]) {
      const dest = join(dir, `artifact-${status}.tgz`);
      const { fetchImpl } = registryFetch({
        [TARBALL_URL]: () => new Response(null, { status, headers: status === 302 ? { location: "https://evil.example.com/x.tgz" } : {} }),
      });
      const result = await downloadCodexTarball(TARBALL_URL, { integrity: "sha512-AAAA", destFile: dest, fetchImpl });
      expect(result.ok).toBe(false);
      expect(existsSync(dest)).toBe(false);
    }
  });
});

describe("extractCodexVendorSubtree (per-entry sanitization, amended §A4.3)", () => {
  function extractTo(archive: Buffer, opts: { caps?: Parameters<typeof extractCodexVendorSubtree>[3] } = {}) {
    const dir = home();
    const tgzPath = join(dir, "a.tgz");
    writeFileSync(tgzPath, archive);
    const dest = join(dir, "out");
    return { dest, run: () => extractCodexVendorSubtree(tgzPath, dest, TRIPLE, opts.caps) };
  }

  it("extracts the WHOLE vendor/<triple>/ subtree, skipping shim wrapper files outside it silently", async () => {
    const { dest, run } = extractTo(goodArchive());
    const result = await run();
    expect(result.ok).toBe(true);
    expect(existsSync(join(dest, "codex-package.json"))).toBe(true);
    expect(existsSync(join(dest, "bin", "codex"))).toBe(true);
    expect(existsSync(join(dest, "codex-path", "rg"))).toBe(true);
    expect(existsSync(join(dest, "codex-resources", "zsh", "bin", "zsh"))).toBe(true);
    // Wrapper files were skipped, not installed.
    expect(existsSync(join(dest, "package.json"))).toBe(false);
    expect(existsSync(join(dest, "README.md"))).toBe(false);
  });

  it("preserves exec bits and strips setuid/setgid/sticky (mode & 0755)", async () => {
    const archive = buildTgz([
      { name: `package/vendor/${TRIPLE}/codex-package.json`, data: Buffer.from(JSON.stringify({ layoutVersion: 1, entrypoint: "bin/codex" })) },
      { name: `package/vendor/${TRIPLE}/bin/codex`, data: Buffer.from("bin"), mode: 0o4755 },
      { name: `package/vendor/${TRIPLE}/plain.txt`, data: Buffer.from("x"), mode: 0o644 },
    ]);
    const { dest, run } = extractTo(archive);
    expect((await run()).ok).toBe(true);
    expect(statSync(join(dest, "bin", "codex")).mode & 0o7777).toBe(0o755);
    expect(statSync(join(dest, "plain.txt")).mode & 0o7777).toBe(0o644);
  });

  it.each([
    ["a symlink entry ANYWHERE in the archive", { name: "package/innocent-link", typeflag: "2", linkname: "/etc/passwd" }],
    ["a symlink entry inside the subtree", { name: `package/vendor/${TRIPLE}/bin/codex`, typeflag: "2", linkname: "../../../escape" }],
    ["a hardlink entry", { name: `package/vendor/${TRIPLE}/hard`, typeflag: "1", linkname: "package/other" }],
    ["a character-device entry", { name: `package/vendor/${TRIPLE}/dev`, typeflag: "3" }],
    ["a fifo entry", { name: `package/vendor/${TRIPLE}/fifo`, typeflag: "6" }],
  ])("refuses the WHOLE archive on %s — not a skip (gate B red-proof target)", async (_label, evil) => {
    const archive = buildTgz([
      { name: `package/vendor/${TRIPLE}/codex-package.json`, data: Buffer.from(JSON.stringify({ layoutVersion: 1, entrypoint: "bin/codex" })) },
      { name: `package/vendor/${TRIPLE}/bin/codex`, data: Buffer.from("bin"), mode: 0o755 },
      evil as TarEntrySpec,
    ]);
    const { dest, run } = extractTo(archive);
    const result = await run();
    expect(result.ok).toBe(false);
    // Refusal of the whole install: nothing of the archive survives, including
    // the well-formed entries extracted before the evil one was reached.
    expect(existsSync(dest)).toBe(false);
  });

  it.each([
    ["a .. path component", `package/vendor/${TRIPLE}/../../escape`],
    ["an absolute path", `/etc/cron.d/evil`],
    ["a backslash separator", `package\\vendor\\${TRIPLE}\\evil`],
  ])("refuses the whole archive on %s", async (_label, name) => {
    const archive = buildTgz([
      { name: `package/vendor/${TRIPLE}/bin/codex`, data: Buffer.from("bin"), mode: 0o755 },
      { name, data: Buffer.from("evil") },
    ]);
    const { dest, run } = extractTo(archive);
    const result = await run();
    expect(result.ok).toBe(false);
    expect(existsSync(dest)).toBe(false);
  });

  it("enforces the entry-count, per-entry and total-unpacked caps (fail-closed)", async () => {
    const entry = (index: number): TarEntrySpec => ({ name: `package/vendor/${TRIPLE}/file-${index}`, data: Buffer.alloc(1024, 1) });
    const archive = buildTgz([entry(0), entry(1), entry(2), entry(3)]);

    const capped = extractTo(archive, { caps: { maxEntries: 3 } });
    expect((await capped.run()).ok).toBe(false);
    expect(existsSync(capped.dest)).toBe(false);

    const perEntry = extractTo(archive, { caps: { maxEntryBytes: 512 } });
    expect((await perEntry.run()).ok).toBe(false);

    const total = extractTo(archive, { caps: { maxUnpackedBytes: 2048 } });
    expect((await total.run()).ok).toBe(false);
  });

  it("refuses an archive with a lone zero block followed by another real entry, instead of silently truncating (BM2)", async () => {
    const archive = buildTgzWithLoneZeroBlock(
      [{ name: `package/vendor/${TRIPLE}/codex-package.json`, data: Buffer.from(JSON.stringify({ layoutVersion: 1, entrypoint: "bin/codex" })) }],
      [{ name: `package/vendor/${TRIPLE}/bin/codex`, data: Buffer.from("bin"), mode: 0o755 }],
    );
    const { dest, run } = extractTo(archive);
    const result = await run();
    expect(result.ok).toBe(false);
    // On base, this lone zero block reads as end-of-archive: extraction stops
    // after codex-package.json and reports { ok: true } with bin/codex simply
    // missing — a silent truncation. The fix must refuse the whole install.
    expect(existsSync(dest)).toBe(false);
  });

  it("refuses a truncated/corrupt archive rather than keeping a partial tree", async () => {
    const dir = home();
    const tgzPath = join(dir, "corrupt.tgz");
    writeFileSync(tgzPath, gzipSync(Buffer.concat([tarHeader(`package/vendor/${TRIPLE}/bin/codex`, 4096, "0", 0o755, ""), Buffer.alloc(512, 1)])));
    const dest = join(dir, "out");
    const result = await extractCodexVendorSubtree(tgzPath, dest, TRIPLE);
    expect(result.ok).toBe(false);
    expect(existsSync(dest)).toBe(false);
  });
});

/** BM3 red-proof plumbing: walks a directory tree on disk and returns the
 * relative (POSIX-joined) path of every regular file found, so the fsync
 * assertion below is pinned to whatever the extractor ACTUALLY wrote — an
 * enumerate-good check, not a fixed guess at the fixture's shape. */
function collectRegularFiles(root: string, rel = ""): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
    const entryRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) files.push(...collectRegularFiles(root, entryRel));
    else if (entry.isFile()) files.push(entryRel);
  }
  return files;
}

/** Regular (non-directory) file count inside goodArchive()'s vendor/<triple>/
 * subtree: codex-package.json, bin/codex, codex-path/rg,
 * codex-resources/zsh/bin/zsh. A floor guarding against a trivially-true
 * empty-directory walk, not a ceiling — goodArchive() growing more files only
 * makes this assertion stricter. */
const GOOD_ARCHIVE_REGULAR_FILE_COUNT = 4;

describe("installCodexVersion (atomic dir-rename + layout cross-check)", () => {
  it("installs into ~/.anycode/codex/bin/<version>/ atomically and reports the vendor binary path", async () => {
    const dir = home();
    const { fetchImpl } = fetchServing(goodArchive());
    const result = await installCodexVersion(VERSION, { home: dir, ...DARWIN_ARM, fetchImpl });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const expectedDir = join(dir, ".anycode", "codex", "bin", VERSION);
    expect(result.installDir).toBe(expectedDir);
    expect(result.binaryPath).toBe(join(expectedDir, "vendor", TRIPLE, "bin", "codex"));
    expect(statSync(result.binaryPath).mode & 0o111).not.toBe(0);
    // No temp litter left behind in bin/.
    expect(readdirSync(join(dir, ".anycode", "codex", "bin"))).toEqual([VERSION]);
  });

  it("an integrity mismatch leaves NO partial directory under the final name and NO executable file anywhere (gate B)", async () => {
    const dir = home();
    const tgz = goodArchive();
    const { fetchImpl } = registryFetch({
      [METADATA_URL]: () =>
        new Response(metadataFor(tgz, { dist: { tarball: TARBALL_URL, integrity: `sha512-${createHash("sha512").update("forged").digest("base64")}` } }), {
          status: 200,
        }),
      [TARBALL_URL]: () => new Response(new Uint8Array(tgz), { status: 200 }),
    });
    const result = await installCodexVersion(VERSION, { home: dir, ...DARWIN_ARM, fetchImpl });
    expect(result.ok).toBe(false);
    const binRoot = join(dir, ".anycode", "codex", "bin");
    expect(existsSync(join(binRoot, VERSION))).toBe(false);
    expect(!existsSync(binRoot) || readdirSync(binRoot).length === 0).toBe(true);
  });

  it("a mid-archive refusal (traversal entry) leaves no partial install and no temp directory", async () => {
    const dir = home();
    const evil = buildTgz([
      { name: `package/vendor/${TRIPLE}/codex-package.json`, data: Buffer.from(JSON.stringify({ layoutVersion: 1, entrypoint: "bin/codex" })) },
      { name: `package/vendor/${TRIPLE}/bin/codex`, data: Buffer.from("bin"), mode: 0o755 },
      { name: `package/vendor/${TRIPLE}/../../../escape`, data: Buffer.from("evil") },
    ]);
    const { fetchImpl } = fetchServing(evil);
    const result = await installCodexVersion(VERSION, { home: dir, ...DARWIN_ARM, fetchImpl });
    expect(result.ok).toBe(false);
    const binRoot = join(dir, ".anycode", "codex", "bin");
    expect(!existsSync(binRoot) || readdirSync(binRoot).length === 0).toBe(true);
    expect(existsSync(join(dir, ".anycode", "codex", "bin", VERSION))).toBe(false);
  });

  it("refuses an archive whose codex-package.json cross-check fails (layoutVersion !== 1 / entrypoint drift)", async () => {
    for (const overrides of [{ layoutVersion: 2 }, { entrypoint: "bin/other" }]) {
      const dir = home();
      const { fetchImpl } = fetchServing(goodArchive(overrides));
      const result = await installCodexVersion(VERSION, { home: dir, ...DARWIN_ARM, fetchImpl });
      expect(result.ok).toBe(false);
      expect(existsSync(join(dir, ".anycode", "codex", "bin", VERSION))).toBe(false);
    }
  });

  it("refuses an archive that carries no main binary at the expected vendor path", async () => {
    const dir = home();
    const noBinary = buildTgz([
      { name: `package/vendor/${TRIPLE}/codex-package.json`, data: Buffer.from(JSON.stringify({ layoutVersion: 1, entrypoint: "bin/codex" })) },
    ]);
    const { fetchImpl } = fetchServing(noBinary);
    const result = await installCodexVersion(VERSION, { home: dir, ...DARWIN_ARM, fetchImpl });
    expect(result.ok).toBe(false);
  });

  it("returns the existing install idempotently when the version directory is already present", async () => {
    const dir = home();
    const { calls, fetchImpl } = fetchServing(goodArchive());
    const first = await installCodexVersion(VERSION, { home: dir, ...DARWIN_ARM, fetchImpl });
    expect(first.ok).toBe(true);
    const callsAfterFirst = calls.length;
    const second = await installCodexVersion(VERSION, { home: dir, ...DARWIN_ARM, fetchImpl });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.alreadyInstalled).toBe(true);
    expect(calls.length).toBe(callsAfterFirst); // no second download
  });

  it("refuses a non-semver version string outright (path traversal via version)", async () => {
    const dir = home();
    const { fetchImpl } = fetchServing(goodArchive());
    const result = await installCodexVersion("../escape", { home: dir, ...DARWIN_ARM, fetchImpl });
    expect(result.ok).toBe(false);
    expect(existsSync(join(dir, ".anycode"))).toBe(false);
  });

  it("fsyncs every extracted file and the staging directory BEFORE the atomic rename, and the destination's parent AFTER (amendment-1 §262, BM3)", async () => {
    fsyncCallLog.length = 0;
    const dir = home();
    const { fetchImpl } = fetchServing(goodArchive());
    const result = await installCodexVersion(VERSION, { home: dir, ...DARWIN_ARM, fetchImpl });
    expect(result.ok).toBe(true);

    const binRoot = join(dir, ".anycode", "codex", "bin");
    const renameEntry = fsyncCallLog.find((entry) => entry.startsWith("rename:"));
    expect(renameEntry).toBeDefined();
    const stagingRoot = renameEntry!.slice("rename:".length).split("->")[0]!;
    const renameIndex = fsyncCallLog.indexOf(renameEntry!);
    const beforeRename = fsyncCallLog.slice(0, renameIndex);
    const afterRename = fsyncCallLog.slice(renameIndex + 1);
    const installedRoot = renameEntry!.slice("rename:".length).split("->")[1]!;

    // Every regular file actually extracted (enumerated from disk post-rename,
    // not assumed from the fixture) was synced before the rename — not merely SOME file.
    const extractedFiles = collectRegularFiles(installedRoot);
    expect(extractedFiles.length).toBeGreaterThan(0);
    expect(extractedFiles.length).toBeGreaterThanOrEqual(GOOD_ARCHIVE_REGULAR_FILE_COUNT);
    for (const rel of extractedFiles) {
      expect(beforeRename).toContain(`sync:${stagingRoot}/${rel}`);
    }
    // The staging directory ITSELF (not a file inside it) was also synced before the rename.
    expect(beforeRename).toContain(`sync:${stagingRoot}`);
    // The destination's parent directory is synced strictly AFTER the rename, never before.
    expect(afterRename).toContain(`sync:${binRoot}`);
    expect(beforeRename).not.toContain(`sync:${binRoot}`);
  });
});

describe("createCodexInstallController (IPC surface — verdict gate, doctor gate, settings persistence)", () => {
  function controllerWith(overrides: Partial<Parameters<typeof createCodexInstallController>[0]> = {}) {
    const dir = home();
    const written: Array<Record<string, unknown>> = [];
    const { fetchImpl } = fetchServing(goodArchive());
    const readyReport: CodexDoctorReport = { status: "ready", version: VERSION };
    const controller = createCodexInstallController({
      home: dir,
      ...DARWIN_ARM,
      fetchImpl,
      trust: () => null,
      runDoctor: async () => readyReport,
      readRiskAcceptedVersions: async () => [],
      writeCodexSettings: async (patch) => {
        written.push(patch as Record<string, unknown>);
        return { ok: true } as never;
      },
      ...overrides,
    });
    return { dir, written, controller };
  }

  it("installs the manifest-recommended version by default, runs the doctor, persists binaryPath", async () => {
    setActiveCodexVersionPolicy({
      manifest: { ...BUNDLED_CODEX_MANIFEST, supported: [{ range: ">=0.144.0 <0.145.0", status: "tested" }], recommended: VERSION },
    });
    const { dir, written, controller } = controllerWith();
    const result = await controller.install();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.version).toBe(VERSION);
    expect(written).toEqual([{ binaryPath: join(dir, ".anycode", "codex", "bin", VERSION, "vendor", TRIPLE, "bin", "codex") }]);
  });

  it("refuses to install a version the policy rejects (outside manifest, not risk-accepted)", async () => {
    const { written, controller } = controllerWith();
    const result = await controller.install("0.150.0");
    expect(result.ok).toBe(false);
    expect(written).toEqual([]);
  });

  it("a failing doctor removes the installed tree and persists nothing", async () => {
    const { dir, written, controller } = controllerWith({ runDoctor: async () => ({ status: "error", error: "spawn failed" }) });
    const result = await controller.install(VERSION);
    expect(result.ok).toBe(false);
    expect(existsSync(join(dir, ".anycode", "codex", "bin", VERSION))).toBe(false);
    expect(written).toEqual([]);
  });

  it("a failing trust gate removes the installed tree and persists nothing", async () => {
    const { dir, written, controller } = controllerWith({ trust: () => "codex binary is not trusted" });
    const result = await controller.install(VERSION);
    expect(result.ok).toBe(false);
    expect(existsSync(join(dir, ".anycode", "codex", "bin", VERSION))).toBe(false);
    expect(written).toEqual([]);
  });

  it("signed_out is an acceptable post-install doctor verdict (binary works; login is a separate step)", async () => {
    const { written, controller } = controllerWith({ runDoctor: async () => ({ status: "signed_out", version: VERSION }) });
    const result = await controller.install(VERSION);
    expect(result.ok).toBe(true);
    expect(written).toHaveLength(1);
  });

  it("acceptRisk persists the version per-version, updates the active policy, and fires onChanged", async () => {
    let changed = 0;
    const { written, controller } = controllerWith({
      readRiskAcceptedVersions: async () => ["0.150.0"],
      onChanged: () => {
        changed += 1;
      },
    });
    const result = await controller.acceptRisk("0.151.0");
    expect(result.ok).toBe(true);
    expect(written).toEqual([{ riskAcceptedVersions: ["0.150.0", "0.151.0"] }]);
    expect(changed).toBe(1);
    // The doctor's default policy seam sees the acceptance immediately.
    const { activeCodexVersionPolicy } = await import("./codex-manifest.js");
    expect(activeCodexVersionPolicy().riskAcceptedVersions).toContain("0.151.0");
  });

  it("acceptRisk refuses a version below the compile-time floor and a malformed version", async () => {
    const { written, controller } = controllerWith();
    expect((await controller.acceptRisk("0.100.0")).ok).toBe(false);
    expect((await controller.acceptRisk("../evil")).ok).toBe(false);
    expect(written).toEqual([]);
  });

  it("serializes installs: a concurrent second install reports busy instead of double-downloading", async () => {
    const { controller } = controllerWith();
    const first = controller.install(VERSION);
    const second = await controller.install(VERSION);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toMatch(/in progress/i);
    expect((await first).ok).toBe(true);
  });
});
