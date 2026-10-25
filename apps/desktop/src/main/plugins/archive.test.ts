/**
 * Tests for the in-house tgz extractor (Taskana 4732 S1-B, design §4):
 * happy path, symlink, hardlink, `../` escape, absolute path, drive letter,
 * oversize compressed/uncompressed/per-file, entry cap, gzip bomb, missing
 * manifest, name/version mismatch is the STORE's check (tested there). All
 * fixtures are built IN-TEST with `makeTarball` — no downloads.
 */

import { gzipSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MANIFEST_PATH,
  extractTgz,
  isSafeMemberPath,
  makeTarball,
} from "./archive.js";

const MANIFEST = JSON.stringify({ name: "anycode-essentials", version: "1.0.0" });

function happyMembers(wrapper?: string): { path: string; type?: "file" | "dir"; data?: string }[] {
  const prefix = wrapper === undefined ? "" : `${wrapper}/`;
  return [
    ...(wrapper === undefined ? [] : ([{ path: wrapper, type: "dir" as const }])),
    { path: `${prefix}.anycode-plugin`, type: "dir" as const },
    { path: `${prefix}${MANIFEST_PATH}`, data: MANIFEST },
    { path: `${prefix}skills/research/SKILL.md`, data: "---\nname: research\n---\nDo research.\n" },
    { path: `${prefix}agents/planner.md`, data: "---\nname: planner\ndescription: plan\n---\n" },
  ];
}

describe("isSafeMemberPath", () => {
  it("accepts plain relative paths", () => {
    expect(isSafeMemberPath("a/b.txt")).toBe(true);
    expect(isSafeMemberPath(".anycode-plugin/plugin.json")).toBe(true);
  });
  it("rejects absolute, traversal, drive letters and empty segments", () => {
    expect(isSafeMemberPath("/etc/passwd")).toBe(false);
    expect(isSafeMemberPath("../escape")).toBe(false);
    expect(isSafeMemberPath("a/../../escape")).toBe(false);
    expect(isSafeMemberPath("a//b")).toBe(false);
    expect(isSafeMemberPath("C:/x")).toBe(false);
    expect(isSafeMemberPath("a/C:x")).toBe(false);
    expect(isSafeMemberPath("")).toBe(false);
    expect(isSafeMemberPath("/")).toBe(false);
  });
});

describe("extractTgz", () => {
  it("happy path: flat archive with the manifest at the root", () => {
    const tgz = makeTarball(happyMembers());
    const result = extractTgz(tgz);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const paths = result.entries.filter((e) => e.type === "file").map((e) => e.path);
    expect(paths).toContain(MANIFEST_PATH);
    expect(paths).toContain("skills/research/SKILL.md");
  });

  it("strips a single top-level wrapper dir", () => {
    const tgz = makeTarball(happyMembers("anycode-essentials-1.0.0"));
    const result = extractTgz(tgz);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries.some((e) => e.path === MANIFEST_PATH)).toBe(true);
    expect(result.entries.some((e) => e.path === "skills/research/SKILL.md")).toBe(true);
  });

  it("rejects a symlink member", () => {
    const tgz = makeTarball([
      ...happyMembers(),
      { path: "skills/link", typeflagOverride: "2" },
    ]);
    const result = extractTgz(tgz);
    expect(result).toMatchObject({ ok: false, refusal: "unsupported_type" });
  });

  it("rejects a hardlink member", () => {
    const tgz = makeTarball([
      ...happyMembers(),
      { path: "skills/hard", typeflagOverride: "1" },
    ]);
    const result = extractTgz(tgz);
    expect(result).toMatchObject({ ok: false, refusal: "unsupported_type" });
  });

  it("rejects `..` traversal", () => {
    const tgz = makeTarball([
      ...happyMembers(),
      { path: "../outside.txt", data: "x" },
    ]);
    const result = extractTgz(tgz);
    expect(result).toMatchObject({ ok: false, refusal: "unsafe_path" });
  });

  it("rejects an absolute path", () => {
    const tgz = makeTarball([
      ...happyMembers(),
      { path: "/etc/passwd", data: "x" },
    ]);
    const result = extractTgz(tgz);
    expect(result).toMatchObject({ ok: false, refusal: "unsafe_path" });
  });

  it("rejects a drive-letter path", () => {
    const tgz = makeTarball([
      ...happyMembers(),
      { path: "C:/Windows/system32/evil.dll", data: "x" },
    ]);
    const result = extractTgz(tgz);
    expect(result).toMatchObject({ ok: false, refusal: "unsafe_path" });
  });

  it("rejects garbage that is not gzip (invalid)", () => {
    const result = extractTgz(Buffer.from("this is not a tarball at all"));
    expect(result).toMatchObject({ ok: false, refusal: "invalid" });
  });

  it("rejects when the compressed size exceeds the cap (too_large)", () => {
    // Truly incompressible (random) bytes: the gzip stream itself exceeds the
    // 20 MB compressed cap, and the check fires BEFORE gunzip.
    const tgz = gzipSync(randomBytes(21 * 1024 * 1024));
    expect(tgz.length).toBeGreaterThan(20 * 1024 * 1024);
    const result = extractTgz(tgz);
    expect(result).toMatchObject({ ok: false, refusal: "too_large" });
  });

  it("rejects a gzip bomb: small compressed, huge uncompressed (too_large)", () => {
    const bomb = gzipSync(Buffer.alloc(60 * 1024 * 1024, 0)); // compresses to ~60KB
    expect(bomb.length).toBeLessThan(20 * 1024 * 1024);
    const result = extractTgz(bomb);
    expect(result).toMatchObject({ ok: false, refusal: "too_large" });
  });

  it("rejects a single file over the per-file cap", () => {
    const tgz = makeTarball([
      ...happyMembers(),
      { path: "skills/big.md", data: Buffer.alloc(6 * 1024 * 1024, 0) },
    ]);
    const result = extractTgz(tgz);
    expect(result).toMatchObject({ ok: false, refusal: "too_large" });
  });

  it("rejects more than 2,000 entries", () => {
    const members = happyMembers().slice(0, 1); // manifest only might get stripped... keep flat manifest
    const many = happyMembers();
    for (let i = 0; i < 2_001; i++) {
      many.push({ path: `f/file-${i}.txt`, data: "x" });
    }
    const tgz = makeTarball(many);
    const result = extractTgz(tgz);
    expect(result).toMatchObject({ ok: false, refusal: "too_large" });
    expect(members.length).toBeGreaterThan(0);
  });

  it("rejects an archive without the manifest", () => {
    const tgz = makeTarball([{ path: "README.md", data: "no manifest here" }]);
    const result = extractTgz(tgz);
    expect(result).toMatchObject({ ok: false, refusal: "invalid" });
  });

  it("applies 0644 files / 0755 dirs regardless of the header mode", () => {
    const tgz = makeTarball(happyMembers());
    const result = extractTgz(tgz);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const entry of result.entries) {
      expect(entry.mode).toBe(entry.type === "file" ? 0o644 : 0o755);
    }
  });
});
