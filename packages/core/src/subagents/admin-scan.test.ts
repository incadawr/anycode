/**
 * subagents/admin-scan (P7.21 W1): buildAgentProfileRoots recipe, ownAgentRoots,
 * and scanAgentProfilesAdmin (rows with source/path/bodyBytes + fail-soft
 * problems, dedupe/cap mirroring discovery). Real node fs over tmpdirs.
 */

import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildAgentProfileRoots,
  ownAgentRoots,
  resolveWorktreeMainRootSync,
  scanAgentProfilesAdmin,
} from "./admin-scan.js";
import { discoverAgentProfiles } from "./profiles.js";
import { NodeFileSystemAdapter } from "../adapters/node/node-file-system.js";
import type { FileStat, FileSystemPort } from "../ports/file-system.js";

const fs = new NodeFileSystemAdapter();
const dirs: string[] = [];

async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "agadm-"));
  dirs.push(d);
  return d;
}

function md(fields: Record<string, string>, body: string): string {
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join("\n")}\n---\n${body}`;
}

async function seed(root: string, file: string, content: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, file), content, "utf-8");
}

/**
 * Creates a REAL linked-worktree fixture mirroring actual git metadata:
 *   main/.git/worktrees/<name>/         (gitdir)
 *   main/.git/worktrees/<name>/commondir  — "../../\n"
 *   main/.git/worktrees/<name>/gitdir     — "<wt>/.git\n" (PLAIN path backlink)
 *   wt/.git                               — "gitdir: <gitdir>\n"
 * `opts.gitdirStyle` lets tests vary the gitdir line (absolute/relative),
 * `opts.mutate` allows corrupting metadata after creation.
 */
async function makeWorktree(
  parent: string,
  name = "wt",
  opts: {
    relativeGitdir?: boolean;
    mutate?: (fixture: { main: string; wt: string; gitdir: string }) => Promise<void>;
  } = {},
): Promise<{ main: string; wt: string; gitdir: string }> {
  const main = join(parent, "main");
  const wt = join(parent, name);
  const gitdir = join(main, ".git", "worktrees", name);
  await mkdir(join(main, ".git"), { recursive: true });
  await mkdir(gitdir, { recursive: true });
  await mkdir(wt, { recursive: true });
  const gitdirLine = opts.relativeGitdir
    ? relative(wt, gitdir)
    : gitdir;
  await writeFile(join(wt, ".git"), `gitdir: ${gitdirLine}\n`, "utf-8");
  await writeFile(join(gitdir, "commondir"), "../../\n", "utf-8");
  await writeFile(join(gitdir, "gitdir"), `${join(wt, ".git")}\n`, "utf-8");
  if (opts.mutate) {
    await opts.mutate({ main, wt, gitdir });
  }
  return { main, wt, gitdir };
}

afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

/**
 * A FileSystemPort delegating to a real Node adapter, instrumented to (a) record
 * which read method the scan used, (b) optionally DROP `readFileNoFollow` to
 * model a port that cannot read safely, and (c) optionally LIE that a given path
 * is a regular file at `lstat` time (modelling a TOCTOU swap where the checked
 * file becomes a symlink before the read). Lets the tests prove the scan reads
 * with O_NOFOLLOW and fails closed when it is unavailable.
 */
function spyPort(opts: { noFollow?: boolean; lstatAsRegular?: string }): {
  port: FileSystemPort;
  followed: string[];
  noFollowed: string[];
} {
  const base = new NodeFileSystemAdapter();
  const followed: string[] = [];
  const noFollowed: string[] = [];
  const port: FileSystemPort = {
    readFile: (path) => {
      followed.push(path);
      return base.readFile(path);
    },
    writeFile: (path, content, o) => base.writeFile(path, content, o),
    stat: (path) => base.stat(path),
    exists: (path) => base.exists(path),
    mkdir: (path) => base.mkdir(path),
    readdir: (path) => base.readdir(path),
    lstat: async (path): Promise<FileStat> => {
      if (opts.lstatAsRegular !== undefined && path === opts.lstatAsRegular) {
        return { size: 0, mtimeMs: 0, isFile: true, isDirectory: false, isSymbolicLink: false };
      }
      return base.lstat(path);
    },
    realpath: (path) => base.realpath(path),
    rm: (path) => base.rm(path),
    ...(opts.noFollow
      ? {}
      : {
          readFileNoFollow: (path: string) => {
            noFollowed.push(path);
            return base.readFileNoFollow(path);
          },
        }),
  };
  return { port, followed, noFollowed };
}

describe("buildAgentProfileRoots", () => {
  it("orders project > user > plugin and drops the user root when ws===home", () => {
    const full = buildAgentProfileRoots("/ws", "/home", [{ dir: "/plug/agents", source: "plugin:p" }]);
    expect(full).toEqual([
      { dir: "/ws/.anycode/agents", source: "project" },
      { dir: "/home/.anycode/agents", source: "user" },
      { dir: "/plug/agents", source: "plugin:p" },
    ]);
    expect(buildAgentProfileRoots("/same", "/same", [])).toEqual([
      { dir: "/same/.anycode/agents", source: "project" },
    ]);
  });
});

describe("ownAgentRoots", () => {
  it("returns the two writable roots, collapsing when ws===home", () => {
    expect(ownAgentRoots("/ws", "/home")).toEqual(["/ws/.anycode/agents", "/home/.anycode/agents"]);
    expect(ownAgentRoots("/same", "/same")).toEqual(["/same/.anycode/agents"]);
  });
});

describe("scanAgentProfilesAdmin", () => {
  it("lists valid profiles with metadata and reports problems for broken ones", async () => {
    const ws = await tmp();
    const home = await tmp();
    const wsRoot = join(ws, ".anycode/agents");
    await seed(wsRoot, "reviewer.md", md({ name: "reviewer", description: "Reviews code", tools: "Read, Grep" }, "body text"));
    await seed(wsRoot, "broken.md", "no frontmatter");

    const result = await scanAgentProfilesAdmin(fs, { workspace: ws, home });
    const rows = Object.fromEntries(result.rows.map((r) => [r.name, r]));
    expect(rows.reviewer).toMatchObject({
      name: "reviewer",
      description: "Reviews code",
      tools: ["Read", "Grep"],
      toolsExplicit: true,
      source: "project",
      sourceKind: "project",
      path: join(wsRoot, "reviewer.md"),
    });
    expect(rows.reviewer!.bodyBytes).toBe(Buffer.byteLength("body text"));
    expect(rows.broken).toBeUndefined();
    expect(result.problems.some((p) => p.includes("Invalid agent profile"))).toBe(true);
  });

  it("carries frontmatter engine onto the row and names a bad engine in problems", async () => {
    const ws = await tmp();
    const home = await tmp();
    const wsRoot = join(ws, ".anycode/agents");
    await seed(
      wsRoot,
      "scout.md",
      md({ name: "scout", description: "Runs on Codex", engine: "codex" }, "body"),
    );
    await seed(
      wsRoot,
      "bogus.md",
      md({ name: "bogus", description: "Asks for an engine that does not exist", engine: "gemini" }, "body"),
    );

    const result = await scanAgentProfilesAdmin(fs, { workspace: ws, home });
    const rows = Object.fromEntries(result.rows.map((r) => [r.name, r]));
    expect(rows.scout?.engine).toBe("codex");
    // A rejected profile is never listed AND never silent: the strip must name it.
    expect(rows.bogus).toBeUndefined();
    expect(result.problems.some((p) => p.includes('engine "gemini"'))).toBe(true);
  });

  it("refuses a profile combining engine: with explicit tools: (TASK.97 R4) — never listed, problem names both", async () => {
    const ws = await tmp();
    const home = await tmp();
    const wsRoot = join(ws, ".anycode/agents");
    await seed(
      wsRoot,
      "conflict.md",
      md({ name: "conflict", description: "d", engine: "claude", tools: "Read, Grep" }, "body"),
    );

    const result = await scanAgentProfilesAdmin(fs, { workspace: ws, home });
    expect(result.rows.find((r) => r.name === "conflict")).toBeUndefined();
    expect(
      result.problems.some(
        (p) => p.includes('"tools" cannot be combined with "engine: claude"') && p.includes("remove one of the two"),
      ),
    ).toBe(true);
  });

  it("keeps an engine row when tools: is entirely absent", async () => {
    const ws = await tmp();
    const home = await tmp();
    const wsRoot = join(ws, ".anycode/agents");
    await seed(wsRoot, "bare-engine.md", md({ name: "bare-engine", description: "d", engine: "codex" }, "body"));

    const result = await scanAgentProfilesAdmin(fs, { workspace: ws, home });
    const row = result.rows.find((r) => r.name === "bare-engine");
    expect(row?.engine).toBe("codex");
    expect(row?.toolsExplicit).toBe(false);
  });

  it("dedupes a name across roots (project wins) and tags user rows", async () => {
    const ws = await tmp();
    const home = await tmp();
    await seed(join(ws, ".anycode/agents"), "dup.md", md({ name: "dup", description: "project" }, "P"));
    await seed(join(home, ".anycode/agents"), "dup.md", md({ name: "dup", description: "user" }, "U"));
    await seed(join(home, ".anycode/agents"), "useronly.md", md({ name: "useronly", description: "u" }, "b"));

    const result = await scanAgentProfilesAdmin(fs, { workspace: ws, home });
    const rows = Object.fromEntries(result.rows.map((r) => [r.name, r]));
    expect(rows.dup!.description).toBe("project");
    expect(rows.dup!.sourceKind).toBe("project");
    expect(rows.useronly!.sourceKind).toBe("user");
    expect(result.rows.filter((r) => r.name === "dup")).toHaveLength(1);
  });

  it("refuses a symlinked profile file — never surfaces out-of-catalog content (#2)", async () => {
    const ws = await tmp();
    const outside = await tmp();
    const secret = join(outside, "secret.md");
    await writeFile(secret, md({ name: "leaked", description: "SECRET DATA" }, "secret body"), "utf-8");
    const wsRoot = join(ws, ".anycode/agents");
    await mkdir(wsRoot, { recursive: true });
    // evil.md -> outside/secret.md: following it would leak the target's metadata.
    await symlink(secret, join(wsRoot, "evil.md"));

    const result = await scanAgentProfilesAdmin(fs, { workspace: ws, home: ws });
    expect(result.rows.find((r) => r.name === "leaked")).toBeUndefined();
    expect(result.problems.some((p) => p.includes("symbolic link"))).toBe(true);
  });

  it("skips a symlinked catalog ROOT escaping the own area — external .md never listed (#1)", async () => {
    const ws = await tmp();
    const outside = await tmp();
    // A real agents dir OUTSIDE the catalog holding a valid profile.
    await seed(outside, "leaked.md", md({ name: "leaked", description: "SECRET DATA" }, "secret body"));
    // <ws>/.anycode/agents is itself a SYMLINK to that outside dir.
    await mkdir(join(ws, ".anycode"), { recursive: true });
    await symlink(outside, join(ws, ".anycode/agents"));

    const result = await scanAgentProfilesAdmin(fs, { workspace: ws, home: ws });
    // Following the symlinked root would enumerate + list the outside tree's .md.
    expect(result.rows.find((r) => r.name === "leaked")).toBeUndefined();
    expect(result.rows).toHaveLength(0);
    expect(result.problems.some((p) => p.includes("escaping the catalog"))).toBe(true);
  });

  it("reads with O_NOFOLLOW — a scan→read symlink swap cannot expose the target (#2)", async () => {
    const ws = await tmp();
    const outside = await tmp();
    // The swap target: a secret markdown reachable only by dereferencing the link.
    await writeFile(join(outside, "secret.md"), md({ name: "leaked", description: "SECRET DATA" }, "s"), "utf-8");
    const wsRoot = join(ws, ".anycode/agents");
    await mkdir(wsRoot, { recursive: true });
    // On disk probe.md is a symlink; the port LIES at lstat that it is a regular
    // file (post-lstat swap), forcing the scan onto the read path.
    const probe = join(wsRoot, "probe.md");
    await symlink(join(outside, "secret.md"), probe);

    const { port, followed, noFollowed } = spyPort({ lstatAsRegular: probe });
    const result = await scanAgentProfilesAdmin(port, { workspace: ws, home: ws });

    // O_NOFOLLOW read was used, a link-following readFile was NOT, and the swapped
    // symlink target never surfaced as a row.
    expect(noFollowed).toContain(probe);
    expect(followed).not.toContain(probe);
    expect(result.rows.find((r) => r.name === "leaked")).toBeUndefined();
    expect(result.problems.some((p) => p.includes("Could not read agent profile"))).toBe(true);
  });

  it("fails closed when the port lacks readFileNoFollow — file skipped, never link-followed (#2)", async () => {
    const ws = await tmp();
    const wsRoot = join(ws, ".anycode/agents");
    await seed(wsRoot, "plain.md", md({ name: "plain", description: "a plain profile" }, "b"));
    const plain = join(wsRoot, "plain.md");

    const { port, followed } = spyPort({ noFollow: true });
    const result = await scanAgentProfilesAdmin(port, { workspace: ws, home: ws });

    // No safe reader ⇒ the file is skipped (fail-closed), NOT read via a
    // link-following readFile fallback.
    expect(result.rows.find((r) => r.name === "plain")).toBeUndefined();
    expect(followed).not.toContain(plain);
    expect(result.problems.some((p) => p.includes("Could not read agent profile"))).toBe(true);
  });
});

describe("resolveWorktreeMainRootSync", () => {
  it("resolves the main root from a linked worktree (absolute gitdir)", async () => {
    const parent = await tmp();
    const { main, wt } = await makeWorktree(parent);
    expect(resolveWorktreeMainRootSync(wt)).toBe(realpathSync(main));
    // Ordinary main checkout (a .git DIRECTORY) yields undefined.
    expect(resolveWorktreeMainRootSync(main)).toBeUndefined();
  });

  it("resolves with a relative gitdir line too", async () => {
    const parent = await tmp();
    const { main, wt } = await makeWorktree(parent, "wt", { relativeGitdir: true });
    expect(resolveWorktreeMainRootSync(wt)).toBe(realpathSync(main));
  });

  it("tolerates macOS system aliases (tmpdir realpath) in every comparison", async () => {
    const parent = await tmp();
    const { main, wt } = await makeWorktree(parent);
    // workspace passed under a different-but-equal alias still canonicalizes.
    const alias = await realpathSync(parent);
    expect(resolveWorktreeMainRootSync(join(alias, "wt"))).toBe(join(alias, "main"));
  });

  it("returns undefined for missing .git, garbage/multiline .git, plain checkouts", async () => {
    const parent = await tmp();
    // missing .git
    const empty = join(parent, "empty");
    await mkdir(empty, { recursive: true });
    expect(resolveWorktreeMainRootSync(empty)).toBeUndefined();
    // garbage .git
    const garbage = join(parent, "garbage");
    await mkdir(garbage, { recursive: true });
    await writeFile(join(garbage, ".git"), "not a gitdir file\nsecond line\n", "utf-8");
    expect(resolveWorktreeMainRootSync(garbage)).toBeUndefined();
    // multiline gitdir: line
    await writeFile(join(garbage, ".git"), "gitdir: /a\ngitdir: /b\n", "utf-8");
    expect(resolveWorktreeMainRootSync(garbage)).toBeUndefined();
    // plain checkout: .git is a directory
    const plain = join(parent, "plain");
    await mkdir(join(plain, ".git"), { recursive: true });
    expect(resolveWorktreeMainRootSync(plain)).toBeUndefined();
  });

  it("returns undefined on missing/malformed commondir or backlink", async () => {
    const parent = await tmp();
    // missing commondir
    const { wt: wtNoCommon } = await makeWorktree(parent, "nocommon", {
      mutate: async ({ gitdir }) => {
        await rm(join(gitdir, "commondir"));
      },
    });
    expect(resolveWorktreeMainRootSync(wtNoCommon)).toBeUndefined();
    // malformed commondir (multiline)
    const { wt: wtBadCommon } = await makeWorktree(parent, "badcommon", {
      mutate: async ({ gitdir }) => {
        await writeFile(join(gitdir, "commondir"), "../../\nextra\n", "utf-8");
      },
    });
    expect(resolveWorktreeMainRootSync(wtBadCommon)).toBeUndefined();
    // missing backlink
    const { wt: wtNoBack } = await makeWorktree(parent, "noback", {
      mutate: async ({ gitdir }) => {
        await rm(join(gitdir, "gitdir"));
      },
    });
    expect(resolveWorktreeMainRootSync(wtNoBack)).toBeUndefined();
    // malformed backlink
    const { wt: wtBadBack } = await makeWorktree(parent, "badback", {
      mutate: async ({ gitdir }) => {
        await writeFile(join(gitdir, "gitdir"), "line1\nline2\n", "utf-8");
      },
    });
    expect(resolveWorktreeMainRootSync(wtBadBack)).toBeUndefined();
  });

  it("returns undefined when the backlink points at a different checkout", async () => {
    const parent = await tmp();
    const other = join(parent, "other");
    await mkdir(other, { recursive: true });
    const { wt } = await makeWorktree(parent, "wt", {
      mutate: async ({ gitdir }) => {
        await writeFile(join(gitdir, "gitdir"), `${join(other, ".git")}\n`, "utf-8");
      },
    });
    expect(resolveWorktreeMainRootSync(wt)).toBeUndefined();
  });

  it("returns undefined for a foreign commondir (not .git, noncanonical worktree dir)", async () => {
    const parent = await tmp();
    // commondir basename is not ".git"
    const { wt: wtForeign } = await makeWorktree(parent, "foreign", {
      mutate: async ({ gitdir }) => {
        const foreign = join(parent, "foreign-common");
        await mkdir(foreign, { recursive: true });
        await writeFile(join(gitdir, "commondir"), `${foreign}\n`, "utf-8");
      },
    });
    expect(resolveWorktreeMainRootSync(wtForeign)).toBeUndefined();
    // gitdir not a direct child of common/worktrees (noncanonical)
    const { wt: wtNoncanonical } = await makeWorktree(parent, "noncanon", {
      mutate: async ({ gitdir, wt }) => {
        const nested = join(gitdir, "nested");
        await mkdir(nested, { recursive: true });
        await writeFile(join(nested, "commondir"), "../../../\n", "utf-8");
        await writeFile(join(nested, "gitdir"), `${join(wt, ".git")}\n`, "utf-8");
        await writeFile(join(wt, ".git"), `gitdir: ${nested}\n`, "utf-8");
      },
    });
    expect(resolveWorktreeMainRootSync(wtNoncanonical)).toBeUndefined();
  });

  it("rejects a symlinked .anycode parent or agents dir escaping main", async () => {
    // Two INDEPENDENT fixtures: the p1 mutation (parent .anycode symlink) must
    // not leak into the p2 case, so each rejection is isolated.
    const outside = await tmp();
    // main/.anycode -> outside
    const parent1 = await tmp();
    const { wt: wtParentLink } = await makeWorktree(parent1, "wt", {
      mutate: async ({ main }) => {
        await symlink(outside, join(main, ".anycode"));
      },
    });
    expect(resolveWorktreeMainRootSync(wtParentLink)).toBeUndefined();
    // main/.anycode real, agents -> outside
    const parent2 = await tmp();
    const { wt: wtAgentsLink } = await makeWorktree(parent2, "wt", {
      mutate: async ({ main }) => {
        await mkdir(join(main, ".anycode"), { recursive: true });
        await symlink(outside, join(main, ".anycode", "agents"));
      },
    });
    expect(resolveWorktreeMainRootSync(wtAgentsLink)).toBeUndefined();
  });
});

describe("buildAgentProfileRoots with linked worktree inheritance", () => {
  it("orders worktree project > main project > user > plugin with project labels", async () => {
    const parent = await tmp();
    const { main, wt } = await makeWorktree(parent);
    const roots = buildAgentProfileRoots(wt, "/home", [{ dir: "/plug/agents", source: "plugin:p" }]);
    expect(roots).toEqual([
      { dir: join(wt, ".anycode/agents"), source: "project" },
      { dir: join(realpathSync(main), ".anycode/agents"), source: "project" },
      { dir: "/home/.anycode/agents", source: "user" },
      { dir: "/plug/agents", source: "plugin:p" },
    ]);
    // Non-worktree / malformed workspaces keep the current behavior.
    const plain = await tmp();
    expect(buildAgentProfileRoots(plain, "/home", [])).toEqual([
      { dir: join(plain, ".anycode/agents"), source: "project" },
      { dir: "/home/.anycode/agents", source: "user" },
    ]);
  });
});

describe("scanAgentProfilesAdmin with linked worktree inheritance", () => {
  it("shows a main-only reviewer as project", async () => {
    const parent = await tmp();
    const home = await tmp();
    const { main, wt } = await makeWorktree(parent);
    await seed(join(main, ".anycode/agents"), "reviewer.md", md({ name: "reviewer", description: "from main" }, "b"));
    const result = await scanAgentProfilesAdmin(fs, { workspace: wt, home });
    const row = result.rows.find((r) => r.name === "reviewer");
    expect(row).toMatchObject({ source: "project", sourceKind: "project" });
    expect(row!.path).toBe(join(realpathSync(main), ".anycode/agents", "reviewer.md"));
  });

  it("worktree duplicate wins over the main duplicate", async () => {
    const parent = await tmp();
    const home = await tmp();
    const { main, wt } = await makeWorktree(parent);
    await seed(join(main, ".anycode/agents"), "dup.md", md({ name: "dup", description: "main" }, "M"));
    await seed(join(wt, ".anycode/agents"), "dup.md", md({ name: "dup", description: "worktree" }, "W"));
    const result = await scanAgentProfilesAdmin(fs, { workspace: wt, home });
    const dups = result.rows.filter((r) => r.name === "dup");
    expect(dups).toHaveLength(1);
    expect(dups[0]!.description).toBe("worktree");
    expect(dups[0]!.path).toBe(join(wt, ".anycode/agents", "dup.md"));
  });

  it("main nonconflicting profiles stay visible alongside a local agents dir", async () => {
    const parent = await tmp();
    const home = await tmp();
    const { main, wt } = await makeWorktree(parent);
    await seed(join(main, ".anycode/agents"), "mainonly.md", md({ name: "mainonly", description: "main" }, "M"));
    await seed(join(wt, ".anycode/agents"), "local.md", md({ name: "local", description: "local" }, "L"));
    const result = await scanAgentProfilesAdmin(fs, { workspace: wt, home });
    const names = result.rows.map((r) => r.name).sort();
    expect(names).toEqual(["local", "mainonly"]);
  });

  it("malformed worktree metadata silently keeps the current roots (no scan problem)", async () => {
    const parent = await tmp();
    const home = await tmp();
    const garbage = join(parent, "garbage");
    await mkdir(garbage, { recursive: true });
    await writeFile(join(garbage, ".git"), "nonsense\n", "utf-8");
    await seed(join(garbage, ".anycode/agents"), "local.md", md({ name: "local", description: "d" }, "b"));
    const result = await scanAgentProfilesAdmin(fs, { workspace: garbage, home });
    expect(result.rows.map((r) => r.name)).toEqual(["local"]);
    // Silent: no NEW problems beyond what an ordinary workspace would produce
    // (here: none at all — the rejected resolver fallback adds no errors).
    expect(result.problems).toEqual([]);
  });
});

describe("discoverAgentProfiles via the shared builder (worktree inheritance)", () => {
  it("main-only profile visible; local duplicate wins with exactly one entry", async () => {
    const parent = await tmp();
    const home = await tmp();
    const { main, wt } = await makeWorktree(parent);
    await seed(join(main, ".anycode/agents"), "mainonly.md", md({ name: "mainonly", description: "main" }, "M"));
    const roots = buildAgentProfileRoots(wt, home, []);
    // main-only profile visible
    const r1 = await discoverAgentProfiles(fs, roots);
    expect(r1.profiles.map((p) => p.name)).toContain("mainonly");
    // local duplicate wins, exactly one entry
    await seed(join(wt, ".anycode/agents"), "mainonly.md", md({ name: "mainonly", description: "worktree" }, "W"));
    const r2 = await discoverAgentProfiles(fs, roots);
    const dup = r2.profiles.filter((p) => p.name === "mainonly");
    expect(dup).toHaveLength(1);
    // The WINNING entry is the WORKTREE's — by description and systemPrompt
    // body (PersonaDefinition carries both).
    expect(dup[0]!.description).toBe("worktree");
    expect((dup[0] as unknown as { systemPrompt?: string }).systemPrompt).toBe("W");
  });
});

describe("worktree paths containing spaces (TASK.214 fix 1)", () => {
  it("resolver accepts git metadata lines with internal spaces", async () => {
    const parent = await tmp();
    const spaced = join(parent, "my repo dir");
    await mkdir(spaced, { recursive: true });
    const { main, wt } = await makeWorktree(spaced);
    expect(resolveWorktreeMainRootSync(wt)).toBe(realpathSync(main));
    // relative gitdir line also contains spaces
    const spaced2 = join(parent, "another spaced repo");
    await mkdir(spaced2, { recursive: true });
    const { main: main2, wt: wt2 } = await makeWorktree(spaced2, "wt two", { relativeGitdir: true });
    expect(resolveWorktreeMainRootSync(wt2)).toBe(realpathSync(main2));
  });

  it("buildAgentProfileRoots and admin scan show main profiles for a spaced worktree", async () => {
    const parent = await tmp();
    const spaced = join(parent, "my repo dir");
    await mkdir(spaced, { recursive: true });
    const { main, wt } = await makeWorktree(spaced);
    const home = await tmp();
    const roots = buildAgentProfileRoots(wt, home, []);
    expect(roots[1]).toEqual({ dir: join(realpathSync(main), ".anycode/agents"), source: "project" });
    await seed(join(main, ".anycode/agents"), "reviewer.md", md({ name: "reviewer", description: "from main" }, "b"));
    const result = await scanAgentProfilesAdmin(fs, { workspace: wt, home });
    expect(result.rows.find((r) => r.name === "reviewer")).toMatchObject({ sourceKind: "project" });
  });

  it("runtime discovery via the shared builder sees the spaced main profile", async () => {
    const parent = await tmp();
    const spaced = join(parent, "my repo dir");
    await mkdir(spaced, { recursive: true });
    const { main, wt } = await makeWorktree(spaced);
    const home = await tmp();
    await seed(join(main, ".anycode/agents"), "spacy.md", md({ name: "spacy", description: "from main" }, "M"));
    const discovered = await discoverAgentProfiles(fs, buildAgentProfileRoots(wt, home, []));
    expect(discovered.profiles.map((p) => p.name)).toContain("spacy");
  });
});

describe("main === home keeps the project tier (TASK.214 fix 2)", () => {
  it("yields main profiles as project, deduping the later user root", async () => {
    const parent = await tmp();
    const { main, wt } = await makeWorktree(parent);
    const roots = buildAgentProfileRoots(wt, main, []);
    expect(roots).toEqual([
      { dir: join(wt, ".anycode/agents"), source: "project" },
      { dir: join(realpathSync(main), ".anycode/agents"), source: "project" },
    ]);
    // No downgraded "user" duplicate of the same directory.
    expect(roots.filter((r) => r.source === "user")).toHaveLength(0);
  });

  it("admin scan labels main profiles as project when main === home", async () => {
    const parent = await tmp();
    const { main, wt } = await makeWorktree(parent);
    await seed(join(main, ".anycode/agents"), "reviewer.md", md({ name: "reviewer", description: "from main" }, "b"));
    const result = await scanAgentProfilesAdmin(fs, { workspace: wt, home: main });
    expect(result.rows.find((r) => r.name === "reviewer")).toMatchObject({
      source: "project",
      sourceKind: "project",
    });
  });

  it("ordinary workspace === home behavior is preserved (single project root)", async () => {
    const same = await tmp();
    expect(buildAgentProfileRoots(same, same, [])).toEqual([
      { dir: join(same, ".anycode/agents"), source: "project" },
    ]);
  });
});
