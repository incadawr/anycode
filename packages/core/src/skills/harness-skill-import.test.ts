/**
 * skills/harness-skill-import (P7.20 W1): scan classifies foreign SKILL.md as
 * compatible-verbatim / needs-conversion / incompatible; apply converts
 * frontmatter, suffixes name conflicts (dir + frontmatter name), and copies the
 * support tree with symlink/size/depth guards. Symlink refusal + byte-preserve
 * are proven by REAL execution on node fs.
 */

import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanHarnessSkills, applySkillImport } from "./harness-skill-import.js";
import { ownSkillRoots } from "./admin-scan.js";
import { parseFrontmatter } from "./frontmatter.js";
import { NodeFileSystemAdapter } from "../adapters/node/node-file-system.js";

const fs = new NodeFileSystemAdapter();
const dirs: string[] = [];

async function tmp(prefix = "skimp-"): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

async function seed(path: string, content: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content, "utf-8");
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

describe("scanHarnessSkills", () => {
  it("classifies flat claude/zcode as compatible-verbatim and finds codex nested as needs-conversion", async () => {
    const home = await tmp("home-");
    const ws = await tmp("ws-");
    await seed(join(home, ".claude/skills/flatc/SKILL.md"), "---\nname: flatc\ndescription: flat claude\n---\nbody\n");
    await seed(join(home, ".zcode/skills/flatz/SKILL.md"), '---\nname: "flatz"\ndescription: "flat zcode"\n---\nbody z\n');
    await seed(
      join(home, ".codex/skills/nested/SKILL.md"),
      "---\nname: nested\ndescription: codex nested\nmetadata:\n  owner: taskana\n  tags:\n    - a\n---\nnested body\n",
    );

    const candidates = await scanHarnessSkills(fs, home, ws);
    const byName = Object.fromEntries(candidates.map((c) => [c.name, c]));

    expect(byName.flatc!.harness).toBe("claude");
    expect(byName.flatc!.compatible).toBe(true);
    expect(byName.flatc!.needsConversion).toBe(false);

    expect(byName.flatz!.harness).toBe("zcode");
    expect(byName.flatz!.needsConversion).toBe(false);

    expect(byName.nested!.harness).toBe("codex");
    expect(byName.nested!.compatible).toBe(true);
    expect(byName.nested!.needsConversion).toBe(true);
    expect(byName.nested!.conversionNotes.join(" ")).toContain("metadata");
  });
});

describe("applySkillImport", () => {
  it("flat-compatible round-trips byte-identical", async () => {
    const home = await tmp("home-");
    const ws = await tmp("ws-");
    const src = "---\nname: flatc\ndescription: flat claude\n---\nbody line 1\nbody line 2\n";
    await seed(join(home, ".claude/skills/flatc/SKILL.md"), src);

    const candidates = await scanHarnessSkills(fs, home, ws);
    const target = join(ws, ".anycode/skills");
    const results = await applySkillImport(fs, target, candidates);

    expect(results[0]!.applied).toBe(true);
    const written = await readFile(join(target, "flatc", "SKILL.md"), "utf-8");
    expect(written).toBe(src);
  });

  it("converts nested codex frontmatter, re-parses with our parser, body byte-preserved", async () => {
    const home = await tmp("home-");
    const ws = await tmp("ws-");
    const body = "nested body\nwith two lines\n";
    await seed(
      join(home, ".codex/skills/nested/SKILL.md"),
      `---\nname: nested\ndescription: codex nested\nmetadata:\n  owner: taskana\n  tags:\n    - a\n---\n${body}`,
    );

    const candidates = await scanHarnessSkills(fs, home, ws);
    const target = join(ws, ".anycode/skills");
    await applySkillImport(fs, target, candidates);

    const written = await readFile(join(target, "nested", "SKILL.md"), "utf-8");
    const parsed = parseFrontmatter(written);
    expect("error" in parsed).toBe(false);
    if (!("error" in parsed)) {
      expect(parsed.fields.name).toBe("nested");
      expect(parsed.fields.description).toBe("codex nested");
      expect(parsed.fields.metadata).toBeUndefined(); // nested block dropped
      expect(parsed.body).toBe(body); // body byte-preserved
    }
  });

  it("folds a block-scalar description to one line on conversion", async () => {
    const home = await tmp("home-");
    const ws = await tmp("ws-");
    await seed(
      join(home, ".codex/skills/blockdesc/SKILL.md"),
      "---\nname: blockdesc\ndescription: >-\n  first part\n  second part\n---\nbody\n",
    );
    const candidates = await scanHarnessSkills(fs, home, ws);
    expect(candidates[0]!.needsConversion).toBe(true);
    const target = join(ws, ".anycode/skills");
    await applySkillImport(fs, target, candidates);
    const parsed = parseFrontmatter(await readFile(join(target, "blockdesc", "SKILL.md"), "utf-8"));
    expect("error" in parsed).toBe(false);
    if (!("error" in parsed)) {
      expect(parsed.fields.description).toBe("first part second part");
    }
  });

  it("marks a description-less skill incompatible and never writes it", async () => {
    const home = await tmp("home-");
    const ws = await tmp("ws-");
    await seed(
      join(home, ".codex/skills/nodesc/SKILL.md"),
      "---\nname: nodesc\nmetadata:\n  x: 1\n---\nbody\n",
    );
    const candidates = await scanHarnessSkills(fs, home, ws);
    expect(candidates[0]!.compatible).toBe(false);
    const target = join(ws, ".anycode/skills");
    const results = await applySkillImport(fs, target, candidates);
    expect(results[0]!.skipped).toBe("incompatible");
    expect(await exists(join(target, "nodesc"))).toBe(false);
  });

  it("refuses a proto-key name (constructor) as incompatible", async () => {
    const home = await tmp("home-");
    const ws = await tmp("ws-");
    await seed(
      join(home, ".claude/skills/constructor/SKILL.md"),
      "---\nname: constructor\ndescription: evil\n---\nbody\n",
    );
    const candidates = await scanHarnessSkills(fs, home, ws);
    expect(candidates[0]!.compatible).toBe(false);
  });

  it("suffixes a name conflict, renaming BOTH the dir and the frontmatter name", async () => {
    const home = await tmp("home-");
    const ws = await tmp("ws-");
    // Our workspace catalog already has 'dup' -> alreadyPresent true.
    await seed(join(ws, ".anycode/skills/dup/SKILL.md"), "---\nname: dup\ndescription: ours\n---\nours\n");
    await seed(join(home, ".claude/skills/dup/SKILL.md"), "---\nname: dup\ndescription: theirs\n---\ntheirs body\n");

    const candidates = await scanHarnessSkills(fs, home, ws);
    expect(candidates[0]!.alreadyPresent).toBe(true);

    const target = join(ws, ".anycode/skills");
    const results = await applySkillImport(fs, target, candidates);
    expect(results[0]!.name).toBe("dup-2");
    expect(results[0]!.suffixed).toBe(true);

    // Original untouched.
    expect(await readFile(join(target, "dup", "SKILL.md"), "utf-8")).toContain("description: ours");
    // Suffixed copy: dir dup-2 exists AND its frontmatter name is dup-2.
    const parsed = parseFrontmatter(await readFile(join(target, "dup-2", "SKILL.md"), "utf-8"));
    expect("error" in parsed).toBe(false);
    if (!("error" in parsed)) {
      expect(parsed.fields.name).toBe("dup-2");
    }
  });

  it("copies the support tree but NEVER follows a symlink (real symlink)", async () => {
    const home = await tmp("home-");
    const ws = await tmp("ws-");
    const skillDir = join(home, ".zcode/skills/withtree");
    await seed(join(skillDir, "SKILL.md"), "---\nname: withtree\ndescription: has tree\n---\nbody\n");
    await mkdir(join(skillDir, "references"), { recursive: true });
    await writeFile(join(skillDir, "references", "extra.md"), "support content\n", "utf-8");

    // A secret file OUTSIDE the skill dir, and a symlink to it inside the tree.
    const secret = join(home, "SECRET.txt");
    await writeFile(secret, "TOP_SECRET_DO_NOT_EXFILTRATE\n", "utf-8");
    await symlink(secret, join(skillDir, "leak.txt"));

    const candidates = await scanHarnessSkills(fs, home, ws);
    const target = join(ws, ".anycode/skills");
    const results = await applySkillImport(fs, target, candidates);

    expect(results[0]!.applied).toBe(true);
    // Support file copied...
    expect(await readFile(join(target, "withtree", "references", "extra.md"), "utf-8")).toBe("support content\n");
    // ...but the symlink is NOT present in our catalog.
    expect(await exists(join(target, "withtree", "leak.txt"))).toBe(false);
    expect(results[0]!.notes.some((n) => n.includes("symlink"))).toBe(true);
  });

  it("skips an oversize support file (> 2 MB) with a note", async () => {
    const home = await tmp("home-");
    const ws = await tmp("ws-");
    const skillDir = join(home, ".claude/skills/big");
    await seed(join(skillDir, "SKILL.md"), "---\nname: big\ndescription: big tree\n---\nbody\n");
    await writeFile(join(skillDir, "huge.bin"), Buffer.alloc(2 * 1024 * 1024 + 10, 0x41));

    const candidates = await scanHarnessSkills(fs, home, ws);
    const target = join(ws, ".anycode/skills");
    const results = await applySkillImport(fs, target, candidates);

    expect(results[0]!.applied).toBe(true);
    expect(await exists(join(target, "big", "huge.bin"))).toBe(false);
    expect(results[0]!.notes.some((n) => n.includes("oversize"))).toBe(true);
  });
});

describe("harness-skill-import security hardening (P7.20 W5-FIX)", () => {
  it("P1-a: scan skips a symlinked skill dir and a symlinked SKILL.md (fail-closed)", async () => {
    const home = await tmp("home-");
    const ws = await tmp("ws-");
    const outside = await tmp("outside-");
    // A real, valid skill — must be found.
    await seed(join(home, ".claude/skills/good/SKILL.md"), "---\nname: good\ndescription: real\n---\nbody\n");
    // An outside skill dir exposed via a symlinked catalog entry — must NOT be followed.
    await seed(join(outside, "evilskill/SKILL.md"), "---\nname: evil\ndescription: exfil\n---\nbody\n");
    await symlink(join(outside, "evilskill"), join(home, ".claude/skills/evil"));
    // A skill dir whose SKILL.md is itself a symlink to an outside file — must NOT be read.
    await mkdir(join(home, ".claude/skills/linked"), { recursive: true });
    await writeFile(join(outside, "target.md"), "---\nname: linked\ndescription: x\n---\nbody\n", "utf-8");
    await symlink(join(outside, "target.md"), join(home, ".claude/skills/linked/SKILL.md"));

    const names = (await scanHarnessSkills(fs, home, ws)).map((c) => c.name);
    expect(names).toContain("good");
    expect(names).not.toContain("evil");
    expect(names).not.toContain("linked");
  });

  it("P1-c: import refuses a symlinked targetRoot escaping the catalog", async () => {
    const home = await tmp("home-");
    const ws = await tmp("ws-");
    const outside = await tmp("outside-");
    await seed(join(home, ".claude/skills/payload/SKILL.md"), "---\nname: payload\ndescription: p\n---\nbody\n");
    // <ws>/.anycode/skills is a symlink to an outside directory.
    await mkdir(join(ws, ".anycode"), { recursive: true });
    await symlink(outside, join(ws, ".anycode/skills"));

    const candidates = await scanHarnessSkills(fs, home, ws);
    const targetRoot = join(ws, ".anycode/skills");
    const results = await applySkillImport(fs, targetRoot, candidates, ownSkillRoots(ws, home));

    expect(results.every((r) => !r.applied)).toBe(true);
    // NOTHING written into the escaped-to directory.
    expect(await exists(join(outside, "payload"))).toBe(false);
  });

  it("P2-d: rejects a plugin installPath that uses .. to escape the plugins cache", async () => {
    const home = await tmp("home-");
    const ws = await tmp("ws-");
    const cache = join(home, ".claude/plugins/cache");
    // Legit plugin under the cache (layout B): must be found.
    await seed(join(cache, "good-plugin/skills/tool/SKILL.md"), "---\nname: plugtool\ndescription: ok\n---\nbody\n");
    // Malicious plugin whose installPath escapes the cache via a literal `..`.
    await seed(join(home, ".claude/plugins/secrets/skills/SKILL.md"), "---\nname: sneaky\ndescription: evil\n---\nbody\n");
    await seed(
      join(home, ".claude/plugins/installed_plugins.json"),
      JSON.stringify({
        plugins: {
          good: [{ installPath: join(cache, "good-plugin") }],
          evil: [{ installPath: `${cache}/../secrets` }],
        },
      }),
    );

    const names = (await scanHarnessSkills(fs, home, ws)).map((c) => c.name);
    expect(names).toContain("plugtool");
    expect(names).not.toContain("sneaky");
  });

  it("P2-e: a source swapped to malformed frontmatter after scan fails apply with no catalog residue", async () => {
    const home = await tmp("home-");
    const ws = await tmp("ws-");
    const src = join(home, ".claude/skills/swap/SKILL.md");
    await seed(src, "---\nname: swap\ndescription: valid at scan\n---\nbody\n");

    const candidates = await scanHarnessSkills(fs, home, ws);
    expect(candidates[0]!.compatible).toBe(true);
    expect(candidates[0]!.needsConversion).toBe(false);

    // Swap the source to frontmatter that OUR strict parser rejects (indented line).
    await writeFile(src, "---\nname: swap\ndescription: x\n  nested: bad\n---\nbody\n", "utf-8");

    const target = join(ws, ".anycode/skills");
    const results = await applySkillImport(fs, target, candidates);
    expect(results[0]!.applied).toBe(false);
    expect(results[0]!.skipped).toBe("incompatible");
    // No half-written skill left behind.
    expect(await exists(join(target, "swap"))).toBe(false);
  });
});


describe("harness-skill-import security hardening (P7.20 W6-FIX)", () => {
  it("P1-1: import refuses a DANGLING symlinked own-root and writes nothing to its target", async () => {
    const home = await tmp("home-");
    const ws = await tmp("ws-");
    const outsideBase = await tmp("outside-");
    // Symlink target that does NOT exist yet → the own-root symlink is dangling.
    const danglingTarget = join(outsideBase, "does-not-exist-yet");
    await seed(join(home, ".claude/skills/payload/SKILL.md"), "---\nname: payload\ndescription: p\n---\nbody\n");
    await mkdir(join(ws, ".anycode"), { recursive: true });
    await symlink(danglingTarget, join(ws, ".anycode/skills"));

    const candidates = await scanHarnessSkills(fs, home, ws);
    const targetRoot = join(ws, ".anycode/skills");
    const results = await applySkillImport(fs, targetRoot, candidates, ownSkillRoots(ws, home));

    expect(results.every((r) => !r.applied)).toBe(true);
    // The dangling link was never followed → its target was not created/written.
    expect(await exists(danglingTarget)).toBe(false);
    expect(await exists(join(danglingTarget, "payload"))).toBe(false);
  });

  it("P2-5: a port without no-follow methods refuses foreign read (scan) and copy (apply), never follows", async () => {
    const home = await tmp("home-");
    const ws = await tmp("ws-");
    await seed(join(home, ".claude/skills/foreign/SKILL.md"), "---\nname: foreign\ndescription: f\n---\nbody\n");

    // A port that delegates everything to the real fs but exposes NEITHER
    // readFileNoFollow NOR copyFileNoFollow — the fail-closed path must engage.
    const noFollow = new Proxy(fs, {
      get(target, prop, receiver) {
        if (prop === "readFileNoFollow" || prop === "copyFileNoFollow") {
          return undefined;
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as unknown as typeof fs;

    // scan: readForeignFile fails closed → the candidate is skipped entirely.
    const stubScan = await scanHarnessSkills(noFollow, home, ws);
    expect(stubScan.map((c) => c.name)).not.toContain("foreign");

    // apply: get the candidate via the safe fs, then apply with the stub port →
    // io_error, nothing written (no link-following fallback copy/read).
    const candidates = await scanHarnessSkills(fs, home, ws);
    expect(candidates.map((c) => c.name)).toContain("foreign");
    const target = join(ws, ".anycode/skills");
    const results = await applySkillImport(noFollow, target, candidates);
    expect(results.every((r) => !r.applied)).toBe(true);
    expect(results[0]!.skipped).toBe("io_error");
    expect(await exists(join(target, "foreign"))).toBe(false);
  });
});
