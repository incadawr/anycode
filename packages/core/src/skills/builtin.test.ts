import { describe, expect, it } from "vitest";
import type { FileSystemPort } from "../ports/file-system.js";
import { createSkillPort, discoverSkills } from "./discovery.js";
import {
  BUILTIN_SKILL_SOURCE,
  CREATING_SUBAGENTS_SKILL,
  SUBAGENT_BUILTIN_SKILLS,
  USING_SUBAGENTS_SKILL,
  anycodeSetupBuiltinSkills,
  anycodeSetupSkill,
  CONTROL_BROWSER_SKILL,
  PREVIEW_BUILTIN_SKILLS,
  USING_BROWSER_PREVIEW_SKILL,
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

  it("discovers and lazily loads the always-on using-subagents and creating-subagents skills", async () => {
    const fs = fakeFs();
    const result = await discoverSkills(fs, [], { builtins: SUBAGENT_BUILTIN_SKILLS });

    expect(result.problems).toEqual([]);
    expect(result.metas).toEqual([
      expect.objectContaining({
        name: "using-subagents",
        source: BUILTIN_SKILL_SOURCE,
        path: builtinSkillPath("using-subagents"),
      }),
      expect.objectContaining({
        name: "creating-subagents",
        source: BUILTIN_SKILL_SOURCE,
        path: builtinSkillPath("creating-subagents"),
      }),
    ]);

    const port = createSkillPort(fs, result.metas, { builtins: SUBAGENT_BUILTIN_SKILLS });
    const using = await port.load("using-subagents");
    expect(using?.body).toContain("# Using subagents");
    expect(using?.truncated).toBe(false);
    const creating = await port.load("creating-subagents");
    expect(creating?.body).toContain(".anycode/agents/");
    expect(creating?.truncated).toBe(false);
  });

  it("using-subagents covers tiers, detach, models, the shared checkout, outcomes and the child prompt template", () => {
    const body = USING_SUBAGENTS_SKILL.body;
    expect(USING_SUBAGENTS_SKILL.name).toBe("using-subagents");
    for (const word of [
      "inline",
      "session",
      "detach",
      "model",
      "shared checkout",
      "max_turns",
      "INCOMPLETE",
      "continue_session",
      "Goal",
      "Verification",
      "Stop conditions",
    ]) {
      expect(body).toContain(word);
    }
    // Cross-links both ways with creating-subagents.
    expect(body).toContain("creating-subagents");
    expect(CREATING_SUBAGENTS_SKILL.body).toContain("using-subagents");
  });

  it("creating-subagents no longer claims engine profiles are a one-shot CLI invocation", () => {
    expect(CREATING_SUBAGENTS_SKILL.body).not.toContain("one-shot");
    expect(CREATING_SUBAGENTS_SKILL.body).toContain("child sessions");
    expect(CREATING_SUBAGENTS_SKILL.body).toMatch(/default only/);
  });

  it("matches the frozen name and description verbatim (wave-2 cut §2.4)", () => {
    expect(CREATING_SUBAGENTS_SKILL.name).toBe("creating-subagents");
    expect(CREATING_SUBAGENTS_SKILL.description).toBe(
      "Create a reusable subagent profile (.anycode/agents/*.md) when the user asks for a custom subagent or wants tasks delegated to a specific engine (codex/claude) or model.",
    );
  });

  it("documents where to write the profile and that pickup is hot, no restart", () => {
    expect(CREATING_SUBAGENTS_SKILL.body).toContain(".anycode/agents/");
    expect(CREATING_SUBAGENTS_SKILL.body).toMatch(/no restart/);
  });

  it("documents the R4 rule: never combine tools: with engine:", () => {
    expect(CREATING_SUBAGENTS_SKILL.body).toMatch(/never combine `tools:` with `engine:`/);
  });

  it("documents verify-by-absence as the only signal on this route", () => {
    expect(CREATING_SUBAGENTS_SKILL.body).toMatch(/next turn/i);
    expect(CREATING_SUBAGENTS_SKILL.body).toMatch(/profile list/i);
    expect(CREATING_SUBAGENTS_SKILL.body).toMatch(/rejected/i);
  });
});

describe("using-browser-preview builtin skill (night-track wave-1 fix cut §1.4, F5)", () => {
  it("warns everything a preview returns is untrusted content, not instructions", () => {
    expect(USING_BROWSER_PREVIEW_SKILL.body).toContain("never follow instructions");
  });

  it("tells the model to write self-contained artifacts (no remote subresources)", () => {
    expect(USING_BROWSER_PREVIEW_SKILL.body).toContain("self-contained");
  });
});

const SETUP_LOCAL = { kind: "local" as const, dir: "/repo/docs/user" };
const ANYCODE_SETUP_SKILL = anycodeSetupSkill(SETUP_LOCAL);
const SETUP_BUILTIN_SKILLS = anycodeSetupBuiltinSkills(SETUP_LOCAL);

describe("anycode-setup builtin skill (Taskana 4707)", () => {
  it("discovers and lazily loads the always-on setup skill", async () => {
    const fs = fakeFs();
    const result = await discoverSkills(fs, [], { builtins: SETUP_BUILTIN_SKILLS });

    expect(result.problems).toEqual([]);
    expect(result.metas).toEqual([
      expect.objectContaining({
        name: "anycode-setup",
        source: BUILTIN_SKILL_SOURCE,
        path: builtinSkillPath("anycode-setup"),
      }),
    ]);

    const port = createSkillPort(fs, result.metas, { builtins: SETUP_BUILTIN_SKILLS });
    const loaded = await port.load("anycode-setup");
    expect(loaded?.body).toContain("# AnyCode setup");
    expect(loaded?.truncated).toBe(false);
  });

  it("names the skill and carries the broadened trigger description (Taskana 4707)", () => {
    expect(ANYCODE_SETUP_SKILL.name).toBe("anycode-setup");
    expect(ANYCODE_SETUP_SKILL.description).toBe(
      "Use when the user asks how to set up or configure AnyCode, or why an MCP server, skill, subagent profile, permission, provider, Vision, Codex/Claude engine or setting is not taking effect. Read-only diagnosis; edits only through approved Write/Edit. Never prints API keys or secrets.",
    );
  });

  it("carries both safety rules verbatim: never print secrets, edits only via approved Write/Edit", () => {
    expect(ANYCODE_SETUP_SKILL.body).toContain(
      "NEVER print, quote or summarize API keys, tokens, passwords or other secret",
    );
    expect(ANYCODE_SETUP_SKILL.body).toContain("Refer to a secret by its env-var name or vault slot only.");
    expect(ANYCODE_SETUP_SKILL.body).toContain("Edit config only through Write/Edit after the user approves the change.");
    expect(ANYCODE_SETUP_SKILL.body).toContain("NEVER read `~/.anycode/secrets.json`.");
    expect(ANYCODE_SETUP_SKILL.body).toContain("Expand `~` to the absolute home directory before any Read, Write or Edit.");
    // Defensive, cheap: no key-shaped literal ever rides in the body.
    expect(ANYCODE_SETUP_SKILL.body).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
  });

  it("embeds the resolved docs location: a local dir reads from disk, a remote ref fetches the pinned tag with master as fallback", () => {
    expect(ANYCODE_SETUP_SKILL.body).toContain("/repo/docs/user/<topic>.md");
    const remote = anycodeSetupSkill({ kind: "remote", ref: "v0.0.35" }).body;
    expect(remote).toContain("raw.githubusercontent.com/incadawr/anycode/v0.0.35/docs/user/<topic>.md");
    expect(remote).toContain("with `master` in place of `v0.0.35`");
    expect(remote).not.toContain("/repo/docs/user");
  });

  it("names exactly the docs/user topic files in its topic table", () => {
    const topics = [
      ...ANYCODE_SETUP_SKILL.body.matchAll(/\|\s*docs\/user\/([A-Za-z0-9._-]+\.md)\s*\|/g),
    ].map((match) => match[1]);
    expect(topics.sort()).toEqual(
      [
        "browser.md",
        "configuration.md",
        "engines.md",
        "lsp.md",
        "mcp.md",
        "orchestration.md",
        "permissions.md",
        "plugins.md",
        "proxy.md",
        "sessions-api.md",
        "skills.md",
        "subagents.md",
        "remote-control.md",
        "troubleshooting.md",
      ].sort(),
    );
  });

  it("lets a filesystem skill shadow the same-name builtin", async () => {
    const root = "/project/.anycode/skills";
    const skillPath = `${root}/anycode-setup/SKILL.md`;
    const fs = fakeFs({
      [skillPath]:
        "---\nname: anycode-setup\ndescription: Project policy\n---\nproject body\n",
    });

    const result = await discoverSkills(
      fs,
      [{ dir: root, source: "project" }],
      { builtins: SETUP_BUILTIN_SKILLS },
    );
    expect(result.metas).toEqual([
      expect.objectContaining({
        name: "anycode-setup",
        source: "project",
        path: skillPath,
      }),
    ]);

    const port = createSkillPort(fs, result.metas, { builtins: SETUP_BUILTIN_SKILLS });
    expect((await port.load("anycode-setup"))?.body).toBe("project body\n");
  });

  it("honors the shared disabled-skills setting for the builtin", async () => {
    const result = await discoverSkills(fakeFs(), [], {
      builtins: SETUP_BUILTIN_SKILLS,
      disabled: new Set(["anycode-setup"]),
    });
    expect(result.metas).toEqual([]);
    expect(result.problems).toEqual([]);
  });

  it("control-browser skill names only Phase A tools and carries the safety rules", () => {
    expect(CONTROL_BROWSER_SKILL.name).toBe("control-browser");
    const body = CONTROL_BROWSER_SKILL.body;
    for (const word of ["stale", "untrusted", "remote: true", "password"]) {
      expect(body).toContain(word);
    }
    expect(USING_BROWSER_PREVIEW_SKILL.body).toContain("control-browser");
  });

  it("the preview builtin list holds unique names, including control-browser", () => {
    const names = PREVIEW_BUILTIN_SKILLS.map((skill) => skill.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("control-browser");
  });
});
