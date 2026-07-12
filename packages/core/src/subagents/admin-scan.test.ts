/**
 * subagents/admin-scan (P7.21 W1): buildAgentProfileRoots recipe, ownAgentRoots,
 * and scanAgentProfilesAdmin (rows with source/path/bodyBytes + fail-soft
 * problems, dedupe/cap mirroring discovery). Real node fs over tmpdirs.
 */

import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildAgentProfileRoots, ownAgentRoots, scanAgentProfilesAdmin } from "./admin-scan.js";
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
