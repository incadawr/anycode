import { describe, expect, it } from "vitest";
import type { FileSystemPort } from "../ports/file-system.js";
import { createSkillPort, discoverSkills } from "./discovery.js";
import {
  BUILTIN_SKILL_SOURCE,
  USING_GIT_WORKTREES_SKILL,
  WORKTREE_BUILTIN_SKILLS,
  builtinSkillPath,
} from "./builtin.js";

function fakeFs(files: Record<string, string> = {}): FileSystemPort {
  const entries = new Map(Object.entries(files));
  return {
    readFile: async (path) => {
      const value = entries.get(path);
      if (value === undefined) throw new Error(`ENOENT: ${path}`);
      return value;
    },
    writeFile: async (path, value) => {
      entries.set(path, value);
    },
    exists: async (path) =>
      entries.has(path) || [...entries.keys()].some((entry) => entry.startsWith(`${path}/`)),
    stat: async (path) => {
      if (entries.has(path)) {
        return { size: entries.get(path)?.length ?? 0, mtimeMs: 0, isFile: true, isDirectory: false };
      }
      if ([...entries.keys()].some((entry) => entry.startsWith(`${path}/`))) {
        return { size: 0, mtimeMs: 0, isFile: false, isDirectory: true };
      }
      throw new Error(`ENOENT: ${path}`);
    },
    mkdir: async () => {},
    readdir: async (path) => {
      const prefix = `${path}/`;
      return [
        ...new Set(
          [...entries.keys()]
            .filter((entry) => entry.startsWith(prefix))
            .map((entry) => entry.slice(prefix.length).split("/")[0])
            .filter((entry): entry is string => Boolean(entry)),
        ),
      ];
    },
  };
}

describe("in-memory built-in skills", () => {
  it("discovers and lazily loads the opted-in worktree skill without filesystem access", async () => {
    const fs = fakeFs();
    const result = await discoverSkills(fs, [], { builtins: WORKTREE_BUILTIN_SKILLS });

    expect(result.problems).toEqual([]);
    expect(result.metas).toEqual([
      expect.objectContaining({
        name: "using-git-worktrees",
        source: BUILTIN_SKILL_SOURCE,
        path: builtinSkillPath("using-git-worktrees"),
      }),
    ]);

    const port = createSkillPort(fs, result.metas, { builtins: WORKTREE_BUILTIN_SKILLS });
    const loaded = await port.load("using-git-worktrees");
    expect(loaded?.body).toContain("Call `EnterWorktree`");
    expect(loaded?.body).toContain("Call `ExitWorktree`");
    expect(loaded?.body).toContain("explicitly asks");
    expect(loaded?.body).toContain("`.anycode/worktrees/`");
    expect(loaded?.truncated).toBe(false);
  });

  it("lets a filesystem skill shadow a same-name builtin", async () => {
    const root = "/project/.anycode/skills";
    const skillPath = `${root}/local/SKILL.md`;
    const fs = fakeFs({
      [skillPath]:
        "---\nname: using-git-worktrees\ndescription: Project policy\n---\nproject body\n",
    });

    const result = await discoverSkills(
      fs,
      [{ dir: root, source: "project" }],
      { builtins: WORKTREE_BUILTIN_SKILLS },
    );
    expect(result.metas).toEqual([
      expect.objectContaining({
        name: "using-git-worktrees",
        source: "project",
        path: skillPath,
      }),
    ]);

    const port = createSkillPort(fs, result.metas, { builtins: WORKTREE_BUILTIN_SKILLS });
    expect((await port.load("using-git-worktrees"))?.body).toBe("project body\n");
  });

  it("honors the shared disabled-skills setting for a builtin", async () => {
    const result = await discoverSkills(fakeFs(), [], {
      builtins: WORKTREE_BUILTIN_SKILLS,
      disabled: new Set(["using-git-worktrees"]),
    });
    expect(result.metas).toEqual([]);
    expect(result.problems).toEqual([]);
  });

  it("contains guidance only and delegates Git/lifecycle work to the control tools", () => {
    expect(USING_GIT_WORKTREES_SKILL.body).toContain(
      "Do not reproduce these operations with shell Git commands",
    );
    expect(USING_GIT_WORKTREES_SKILL.body).not.toMatch(/\bgit\s+worktree\b/);
    expect(USING_GIT_WORKTREES_SKILL.body).toContain("successful call as a workspace transition");
  });
});
