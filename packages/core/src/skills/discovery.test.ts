/**
 * Skills discovery + SkillPort matrix (Phase 3 slice 3.3, design §3.3 / §5.2
 * items 2 and 4): precedence across roots, name shadowing/dedup, name-regex
 * and description-required validation, description/MAX_SKILLS caps,
 * root-path dedup ("workspace === home" loads once), fail-soft readdir/read
 * errors, and SkillPort.load (fresh re-read, UTF-8 cap, vanished/unknown).
 *
 * Hermetic: an in-memory fake FileSystemPort (no real disk, no tmpdir).
 */

import { describe, expect, it } from "vitest";
import { createSkillPort, discoverSkills, type SkillRoot } from "./discovery.js";
import type { FileSystemPort } from "../ports/file-system.js";
import type { SkillMeta } from "../ports/skills.js";
import { MAX_SKILLS, SKILL_BODY_MAX_BYTES, SKILL_DESCRIPTION_MAX_CHARS } from "../types/config.js";

// ---------------------------------------------------------------------------
// In-memory fake FileSystemPort: a flat Map<absolute path, content>; a
// directory "exists" either as an explicit empty marker or implicitly when
// some file's path is prefixed by it (mirrors a real tree without touching
// node:fs).

interface FakeFs {
  fs: FileSystemPort;
  readdirCalls: string[];
  setFile(path: string, content: string): void;
  deleteFile(path: string): void;
  breakReaddir(path: string): void;
  breakReadFile(path: string): void;
}

function normalize(path: string): string {
  return path.replace(/\/+$/, "") || "/";
}

function makeFakeFs(initialFiles: Record<string, string> = {}): FakeFs {
  const files = new Map<string, string>(
    Object.entries(initialFiles).map(([path, content]) => [normalize(path), content]),
  );
  const brokenReaddirs = new Set<string>();
  const brokenReads = new Set<string>();
  const readdirCalls: string[] = [];

  function isDirectory(path: string): boolean {
    if (files.has(path)) return false;
    const prefix = path === "/" ? "/" : `${path}/`;
    for (const p of files.keys()) {
      if (p.startsWith(prefix)) return true;
    }
    return false;
  }

  const fs: FileSystemPort = {
    readFile: async (path) => {
      const n = normalize(path);
      if (brokenReads.has(n)) throw new Error(`EIO: ${path}`);
      const content = files.get(n);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    writeFile: async (path, content) => {
      files.set(normalize(path), content);
    },
    stat: async (path) => {
      const n = normalize(path);
      const content = files.get(n);
      if (content !== undefined) {
        return { size: content.length, mtimeMs: 0, isFile: true, isDirectory: false };
      }
      if (isDirectory(n)) {
        return { size: 0, mtimeMs: 0, isFile: false, isDirectory: true };
      }
      throw new Error(`ENOENT: ${path}`);
    },
    exists: async (path) => {
      const n = normalize(path);
      return files.has(n) || isDirectory(n);
    },
    mkdir: async () => {},
    readdir: async (path) => {
      const n = normalize(path);
      readdirCalls.push(n);
      if (brokenReaddirs.has(n)) throw new Error(`EACCES: ${path}`);
      const prefix = n === "/" ? "/" : `${n}/`;
      const names = new Set<string>();
      for (const p of files.keys()) {
        if (!p.startsWith(prefix)) continue;
        const name = p.slice(prefix.length).split("/")[0];
        if (name) names.add(name);
      }
      return [...names];
    },
  };

  return {
    fs,
    readdirCalls,
    setFile: (path, content) => files.set(normalize(path), content),
    deleteFile: (path) => files.delete(normalize(path)),
    breakReaddir: (path) => brokenReaddirs.add(normalize(path)),
    breakReadFile: (path) => brokenReads.add(normalize(path)),
  };
}

function skillMd(fields: Record<string, string>, body = "Body text.\n"): string {
  const front = Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  return `---\n${front}\n---\n${body}`;
}

const PROJECT_ANYCODE = "/proj/.anycode/skills";
const PROJECT_AGENTS = "/proj/.agents/skills";
const USER_ANYCODE = "/home/u/.anycode/skills";
const USER_AGENTS = "/home/u/.agents/skills";
const PLUGIN_ROOT = "/proj/.anycode/plugins/demo/skills";

describe("discoverSkills — precedence, shadowing, validation", () => {
  it("discovers skills from all five source kinds and tags each with its source", async () => {
    const { fs } = makeFakeFs({
      [`${PROJECT_ANYCODE}/proj-skill/SKILL.md`]: skillMd({ description: "From project .anycode" }),
      [`${PROJECT_AGENTS}/proj-agents-skill/SKILL.md`]: skillMd({ description: "From project .agents" }),
      [`${USER_ANYCODE}/user-skill/SKILL.md`]: skillMd({ description: "From user .anycode" }),
      [`${USER_AGENTS}/user-agents-skill/SKILL.md`]: skillMd({ description: "From user .agents" }),
      [`${PLUGIN_ROOT}/plugin-skill/SKILL.md`]: skillMd({ description: "From a plugin" }),
    });
    const roots: SkillRoot[] = [
      { dir: PROJECT_ANYCODE, source: "project" },
      { dir: PROJECT_AGENTS, source: "project" },
      { dir: USER_ANYCODE, source: "user" },
      { dir: USER_AGENTS, source: "user" },
      { dir: PLUGIN_ROOT, source: "plugin:demo" },
    ];

    const { metas, problems } = await discoverSkills(fs, roots);
    expect(problems).toEqual([]);
    const byName = new Map(metas.map((m) => [m.name, m]));
    expect(byName.get("proj-skill")).toMatchObject({ source: "project", description: "From project .anycode" });
    expect(byName.get("proj-agents-skill")).toMatchObject({ source: "project" });
    expect(byName.get("user-skill")).toMatchObject({ source: "user" });
    expect(byName.get("user-agents-skill")).toMatchObject({ source: "user" });
    expect(byName.get("plugin-skill")).toMatchObject({ source: "plugin:demo" });
    expect(metas).toHaveLength(5);
  });

  it("shadows a lower-precedence duplicate name silently (claimed-set semantics, no problem)", async () => {
    const { fs } = makeFakeFs({
      [`${PROJECT_ANYCODE}/shared/SKILL.md`]: skillMd({ name: "shared", description: "project wins" }),
      [`${USER_ANYCODE}/shared/SKILL.md`]: skillMd({ name: "shared", description: "user loses" }),
    });
    const roots: SkillRoot[] = [
      { dir: PROJECT_ANYCODE, source: "project" },
      { dir: USER_ANYCODE, source: "user" },
    ];

    const { metas, problems } = await discoverSkills(fs, roots);
    expect(problems).toEqual([]);
    expect(metas).toHaveLength(1);
    expect(metas[0]).toMatchObject({ name: "shared", source: "project", description: "project wins" });
  });

  it("falls back to the directory name when frontmatter has no name field", async () => {
    const { fs } = makeFakeFs({
      [`${PROJECT_ANYCODE}/my-tool/SKILL.md`]: skillMd({ description: "no explicit name" }),
    });
    const { metas } = await discoverSkills(fs, [{ dir: PROJECT_ANYCODE, source: "project" }]);
    expect(metas).toHaveLength(1);
    expect(metas[0]?.name).toBe("my-tool");
  });

  it("skips + reports a problem for a name that fails the ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$ regex", async () => {
    const { fs } = makeFakeFs({
      [`${PROJECT_ANYCODE}/bad/SKILL.md`]: skillMd({ name: "not a valid name!", description: "x" }),
    });
    const { metas, problems } = await discoverSkills(fs, [{ dir: PROJECT_ANYCODE, source: "project" }]);
    expect(metas).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("not a valid name!");
  });

  it("skips + reports a problem when description is absent", async () => {
    const { fs } = makeFakeFs({
      [`${PROJECT_ANYCODE}/no-desc/SKILL.md`]: "---\nname: no-desc\n---\nbody\n",
    });
    const { metas, problems } = await discoverSkills(fs, [{ dir: PROJECT_ANYCODE, source: "project" }]);
    expect(metas).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("description");
  });

  it("caps a description at SKILL_DESCRIPTION_MAX_CHARS without a problem", async () => {
    const longDescription = "d".repeat(SKILL_DESCRIPTION_MAX_CHARS + 500);
    const { fs } = makeFakeFs({
      [`${PROJECT_ANYCODE}/long-desc/SKILL.md`]: skillMd({ description: longDescription }),
    });
    const { metas, problems } = await discoverSkills(fs, [{ dir: PROJECT_ANYCODE, source: "project" }]);
    expect(problems).toEqual([]);
    expect(metas[0]?.description).toHaveLength(SKILL_DESCRIPTION_MAX_CHARS);
  });

  it("caps the total at MAX_SKILLS after dedup and reports one overflow problem", async () => {
    const files: Record<string, string> = {};
    const total = MAX_SKILLS + 5;
    for (let i = 0; i < total; i += 1) {
      const dirName = `skill-${String(i).padStart(3, "0")}`;
      files[`${PROJECT_ANYCODE}/${dirName}/SKILL.md`] = skillMd({ description: `desc ${i}` });
    }
    const { fs } = makeFakeFs(files);
    const { metas, problems } = await discoverSkills(fs, [{ dir: PROJECT_ANYCODE, source: "project" }]);
    expect(metas).toHaveLength(MAX_SKILLS);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(String(total - MAX_SKILLS));
    // Sorted alphabetically within the root -> the first MAX_SKILLS survive, the
    // highest-numbered (lowest precedence in-root) ones are dropped.
    expect(metas.map((m) => m.name)).toContain("skill-000");
    expect(metas.map((m) => m.name)).not.toContain(`skill-${String(total - 1).padStart(3, "0")}`);
  });

  it("silently ignores non-directory entries and directories without a SKILL.md", async () => {
    const { fs, setFile } = makeFakeFs({
      [`${PROJECT_ANYCODE}/real-skill/SKILL.md`]: skillMd({ description: "x" }),
      [`${PROJECT_ANYCODE}/empty-dir/placeholder.txt`]: "not a skill",
    });
    setFile(`${PROJECT_ANYCODE}/stray-file`, "just a file, not a directory");
    const { metas, problems } = await discoverSkills(fs, [{ dir: PROJECT_ANYCODE, source: "project" }]);
    expect(problems).toEqual([]);
    expect(metas.map((m) => m.name)).toEqual(["real-skill"]);
  });

  it("loads a root directory only once when two roots resolve to the identical path (workspace === home)", async () => {
    const { fs, readdirCalls } = makeFakeFs({
      [`${PROJECT_ANYCODE}/only-skill/SKILL.md`]: skillMd({ description: "x" }),
    });
    const roots: SkillRoot[] = [
      { dir: PROJECT_ANYCODE, source: "project" },
      { dir: PROJECT_ANYCODE, source: "user" },
    ];
    const { metas } = await discoverSkills(fs, roots);
    expect(metas).toHaveLength(1);
    expect(readdirCalls.filter((p) => p === normalize(PROJECT_ANYCODE))).toHaveLength(1);
  });

  it("is a zero-cost no-op when a root directory does not exist", async () => {
    const { fs, readdirCalls } = makeFakeFs({});
    const { metas, problems } = await discoverSkills(fs, [{ dir: PROJECT_ANYCODE, source: "project" }]);
    expect(metas).toEqual([]);
    expect(problems).toEqual([]);
    expect(readdirCalls).toEqual([]);
  });

  it("fail-soft: a readdir error on an existing root is reported, discovery does not throw", async () => {
    const { fs, breakReaddir } = makeFakeFs({
      [`${PROJECT_ANYCODE}/placeholder/SKILL.md`]: skillMd({ description: "x" }),
    });
    breakReaddir(PROJECT_ANYCODE);
    const { metas, problems } = await discoverSkills(fs, [{ dir: PROJECT_ANYCODE, source: "project" }]);
    expect(metas).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(PROJECT_ANYCODE);
  });

  it("fail-soft: a readFile error on a discovered SKILL.md is reported, other skills survive", async () => {
    const { fs, breakReadFile } = makeFakeFs({
      [`${PROJECT_ANYCODE}/broken/SKILL.md`]: skillMd({ description: "x" }),
      [`${PROJECT_ANYCODE}/fine/SKILL.md`]: skillMd({ description: "y" }),
    });
    breakReadFile(`${PROJECT_ANYCODE}/broken/SKILL.md`);
    const { metas, problems } = await discoverSkills(fs, [{ dir: PROJECT_ANYCODE, source: "project" }]);
    expect(metas.map((m) => m.name)).toEqual(["fine"]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("broken/SKILL.md");
  });
});

// ---------------------------------------------------------------------------
// SkillPort (design §5.2 item 4)

function meta(overrides: Partial<SkillMeta> = {}): SkillMeta {
  return {
    name: "demo",
    description: "A demo skill",
    source: "project",
    path: "/proj/.anycode/skills/demo/SKILL.md",
    ...overrides,
  };
}

describe("createSkillPort", () => {
  it("list() returns the exact boot snapshot", () => {
    const { fs } = makeFakeFs();
    const metas = [meta({ name: "a" }), meta({ name: "b" })];
    const port = createSkillPort(fs, metas);
    expect(port.list()).toEqual(metas);
    // Defensive copy: mutating the returned array must not affect the port.
    port.list().pop();
    expect(port.list()).toHaveLength(2);
  });

  it("load() strips the frontmatter and returns only the body", async () => {
    const path = "/proj/.anycode/skills/demo/SKILL.md";
    const { fs } = makeFakeFs({
      [path]: skillMd({ description: "x" }, "Line one.\nLine two.\n"),
    });
    const port = createSkillPort(fs, [meta({ path })]);
    const loaded = await port.load("demo");
    expect(loaded?.body).toBe("Line one.\nLine two.\n");
    expect(loaded?.body).not.toContain("---");
    expect(loaded?.truncated).toBe(false);
  });

  it("caps the body at SKILL_BODY_MAX_BYTES (UTF-8 safe) and reports truncated", async () => {
    const path = "/proj/.anycode/skills/demo/SKILL.md";
    const bigBody = "a".repeat(SKILL_BODY_MAX_BYTES + 1000);
    const { fs } = makeFakeFs({ [path]: skillMd({ description: "x" }, bigBody) });
    const port = createSkillPort(fs, [meta({ path })]);
    const loaded = await port.load("demo");
    expect(loaded?.truncated).toBe(true);
    expect(new TextEncoder().encode(loaded?.body ?? "").length).toBeLessThanOrEqual(SKILL_BODY_MAX_BYTES);
  });

  it("re-reads fresh on every call — an edit between calls is visible without a restart", async () => {
    const path = "/proj/.anycode/skills/demo/SKILL.md";
    const { fs, setFile } = makeFakeFs({
      [path]: skillMd({ description: "x" }, "version 1\n"),
    });
    const port = createSkillPort(fs, [meta({ path })]);
    expect((await port.load("demo"))?.body).toBe("version 1\n");
    setFile(path, skillMd({ description: "x" }, "version 2\n"));
    expect((await port.load("demo"))?.body).toBe("version 2\n");
  });

  it("returns undefined for a name outside the snapshot", async () => {
    const { fs } = makeFakeFs();
    const port = createSkillPort(fs, [meta({ name: "known" })]);
    expect(await port.load("unknown")).toBeUndefined();
  });

  it("returns undefined when the file has vanished since discovery", async () => {
    const path = "/proj/.anycode/skills/demo/SKILL.md";
    const { fs, deleteFile } = makeFakeFs({ [path]: skillMd({ description: "x" }) });
    const port = createSkillPort(fs, [meta({ path })]);
    deleteFile(path);
    expect(await port.load("demo")).toBeUndefined();
  });
});
