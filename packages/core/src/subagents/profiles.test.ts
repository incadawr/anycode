/**
 * Agent-profile discovery tests (Phase 3 slice 3.3.3, design §3.5 + §5.2 item 7).
 * Pure parsing/validation/mapping/caps over an in-memory FileSystemPort fake
 * (no tmpdir, no I/O): name fallback + regex, required description, tools
 * as-is-vs-baseline, the explicit-Agent problem, built-in-name collision,
 * precedence dedupe, body→systemPrompt cap, MAX_AGENT_PROFILES cap and fail-soft
 * behavior. The ∩-drop / lock re-proofs on a live child are in runner.test.ts.
 */

import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { discoverAgentProfiles, type AgentProfileRoot } from "./profiles.js";
import { PERSONAS } from "./personas.js";
import { AGENT_PROFILE_PROMPT_MAX_BYTES, MAX_AGENT_PROFILES } from "../types/config.js";
import type { FileStat, FileSystemPort } from "../ports/file-system.js";

// ---------------------------------------------------------------------------
// In-memory FileSystemPort fake. A spec maps a directory path to its entries;
// each entry is either file CONTENT (string) or the "dir" marker (a
// subdirectory). Only readdir/stat/exists/readFile are used by discovery.

type DirSpec = Record<string, string | "dir">;
type FsSpec = Record<string, DirSpec>;

class FakeFs implements FileSystemPort {
  private readonly files = new Map<string, string>();
  private readonly dirEntries = new Map<string, string[]>();
  private readonly dirPaths = new Set<string>();

  constructor(
    spec: FsSpec,
    private readonly opts: { readdirThrows?: readonly string[] } = {},
  ) {
    for (const [dir, entries] of Object.entries(spec)) {
      this.dirPaths.add(dir);
      this.dirEntries.set(dir, Object.keys(entries));
      for (const [name, value] of Object.entries(entries)) {
        const full = join(dir, name);
        if (value === "dir") {
          this.dirPaths.add(full);
        } else {
          this.files.set(full, value);
        }
      }
    }
  }

  async readFile(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) {
      throw new Error(`ENOENT: ${path}`);
    }
    return content;
  }

  async writeFile(): Promise<void> {
    throw new Error("FakeFs.writeFile is not implemented");
  }

  async stat(path: string): Promise<FileStat> {
    const isFile = this.files.has(path);
    const isDirectory = this.dirPaths.has(path);
    if (!isFile && !isDirectory) {
      throw new Error(`ENOENT: ${path}`);
    }
    return {
      size: isFile ? Buffer.byteLength(this.files.get(path)!) : 0,
      mtimeMs: 0,
      isFile,
      isDirectory,
    };
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.dirPaths.has(path);
  }

  async mkdir(): Promise<void> {
    throw new Error("FakeFs.mkdir is not implemented");
  }

  async readdir(path: string): Promise<string[]> {
    if (this.opts.readdirThrows?.includes(path)) {
      throw new Error(`EACCES: ${path}`);
    }
    const entries = this.dirEntries.get(path);
    if (!entries) {
      throw new Error(`ENOTDIR: ${path}`);
    }
    return [...entries];
  }
}

/** Builds a profile file (frontmatter + body). */
function md(fields: Record<string, string>, body = ""): string {
  const lines = Object.entries(fields).map(([key, value]) => `${key}: ${value}`);
  return `---\n${lines.join("\n")}\n---\n${body}`;
}

const WS = "/ws/.anycode/agents";
const HOME = "/home/.anycode/agents";
const ROOTS: AgentProfileRoot[] = [
  { dir: WS, source: "project" },
  { dir: HOME, source: "user" },
];

// ---------------------------------------------------------------------------

describe("discoverAgentProfiles — mapping to PersonaDefinition", () => {
  it("maps a profile without a tools field to the general-purpose baseline", async () => {
    const fs = new FakeFs({
      [WS]: { "reviewer.md": md({ name: "reviewer", description: "Code reviewer" }, "Review carefully.") },
    });

    const { profiles, problems } = await discoverAgentProfiles(fs, ROOTS);

    expect(problems).toEqual([]);
    expect(profiles).toHaveLength(1);
    const profile = profiles[0]!;
    expect(profile.name).toBe("reviewer");
    expect(profile.description).toBe("Code reviewer");
    expect(profile.systemPrompt).toBe("Review carefully.");
    // tools absent => the nine non-Agent general-purpose tools.
    expect(profile.tools).toEqual([...PERSONAS["general-purpose"].tools]);
    expect(profile.tools).not.toContain("Agent");
  });

  it("keeps an explicit tools list AS-IS (∩ is applied later by the runner)", async () => {
    const fs = new FakeFs({
      [WS]: {
        "narrow.md": md({ name: "narrow", description: "d", tools: "Read, Grep, NoSuchTool" }, "body"),
      },
    });

    const { profiles, problems } = await discoverAgentProfiles(fs, ROOTS);

    expect(problems).toEqual([]);
    // Unknown tool names are kept verbatim here; buildPersonaRegistry drops them.
    expect(profiles[0]?.tools).toEqual(["Read", "Grep", "NoSuchTool"]);
  });

  it("flags an explicit Agent in the tools list but keeps it (lock #1 drops it later)", async () => {
    const fs = new FakeFs({
      [WS]: { "rec.md": md({ name: "rec", description: "d", tools: "Read, Agent" }, "body") },
    });

    const { profiles, problems } = await discoverAgentProfiles(fs, ROOTS);

    expect(profiles[0]?.tools).toContain("Agent");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("Agent");
    expect(problems[0]).toContain("non-recursion");
  });

  it("flags an explicit Workflow in the tools list but keeps it (SPAWN_TOOLS lock #1 drops it later)", async () => {
    const fs = new FakeFs({
      [WS]: { "rec.md": md({ name: "rec", description: "d", tools: "Read, Workflow" }, "body") },
    });

    const { profiles, problems } = await discoverAgentProfiles(fs, ROOTS);

    expect(profiles[0]?.tools).toContain("Workflow");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("Workflow");
    expect(problems[0]).toContain("non-recursion");
  });

  it("flags BOTH Agent and Workflow when a profile lists them together", async () => {
    const fs = new FakeFs({
      [WS]: {
        "rec.md": md({ name: "rec", description: "d", tools: "Read, Agent, Workflow" }, "body"),
      },
    });

    const { profiles, problems } = await discoverAgentProfiles(fs, ROOTS);

    expect(profiles[0]?.tools).toEqual(["Read", "Agent", "Workflow"]);
    expect(problems).toHaveLength(2);
    expect(problems.some((p) => p.includes("Agent") && p.includes("non-recursion"))).toBe(true);
    expect(problems.some((p) => p.includes("Workflow") && p.includes("non-recursion"))).toBe(true);
  });

  it("falls back to the filename (without .md) when no name field is given", async () => {
    const fs = new FakeFs({
      [WS]: { "helper.md": md({ description: "no explicit name" }, "body") },
    });

    const { profiles } = await discoverAgentProfiles(fs, ROOTS);
    expect(profiles[0]?.name).toBe("helper");
  });

  it("caps the body at AGENT_PROFILE_PROMPT_MAX_BYTES and uses it as the systemPrompt", async () => {
    const big = "x".repeat(AGENT_PROFILE_PROMPT_MAX_BYTES + 500);
    const fs = new FakeFs({
      [WS]: { "big.md": md({ name: "big", description: "d" }, big) },
    });

    const { profiles } = await discoverAgentProfiles(fs, ROOTS);
    expect(Buffer.byteLength(profiles[0]!.systemPrompt)).toBe(AGENT_PROFILE_PROMPT_MAX_BYTES);
  });

  it("gives an empty-body profile a placeholder system prompt (like built-in personas)", async () => {
    const fs = new FakeFs({
      [WS]: { "bare.md": md({ name: "bare", description: "d" }, "   \n  ") },
    });

    const { profiles } = await discoverAgentProfiles(fs, ROOTS);
    expect(profiles[0]?.systemPrompt.length).toBeGreaterThan(0);
    expect(profiles[0]?.systemPrompt).toContain("bare");
    expect(profiles[0]?.systemPrompt).toContain("empty body");
  });
});

describe("discoverAgentProfiles — validation & fail-soft", () => {
  it("skips a profile whose name fails the regex (+problem)", async () => {
    const fs = new FakeFs({
      [WS]: {
        "bad.md": md({ name: "bad name", description: "d" }, "body"),
        "spacey file.md": md({ description: "d" }, "body"), // fallback name has a space
      },
    });

    const { profiles, problems } = await discoverAgentProfiles(fs, ROOTS);
    expect(profiles).toHaveLength(0);
    expect(problems).toHaveLength(2);
    expect(problems.some((p) => p.includes("bad name"))).toBe(true);
    expect(problems.some((p) => p.includes("spacey file"))).toBe(true);
  });

  it("skips a profile with no description (+problem)", async () => {
    const fs = new FakeFs({
      [WS]: { "nodesc.md": md({ name: "nodesc" }, "body") },
    });

    const { profiles, problems } = await discoverAgentProfiles(fs, ROOTS);
    expect(profiles).toHaveLength(0);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("description");
  });

  it("reserves built-in persona names (general-purpose/explore) — skip+problem", async () => {
    const fs = new FakeFs({
      [WS]: {
        "explore.md": md({ name: "explore", description: "hijack" }, "malicious body"),
        "gp.md": md({ name: "general-purpose", description: "hijack" }, "malicious body"),
      },
    });

    const { profiles, problems } = await discoverAgentProfiles(fs, ROOTS);
    expect(profiles).toHaveLength(0);
    expect(problems).toHaveLength(2);
    expect(problems.every((p) => p.includes("reserved"))).toBe(true);
  });

  it("skips a non-conforming frontmatter file fail-soft (+problem)", async () => {
    const fs = new FakeFs({
      [WS]: { "broken.md": "---\nname: broken\n" }, // no closing fence
    });

    const { profiles, problems } = await discoverAgentProfiles(fs, ROOTS);
    expect(profiles).toHaveLength(0);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("Invalid agent profile");
  });

  it("ignores non-.md files and *.md directories silently", async () => {
    const fs = new FakeFs({
      [WS]: {
        "notes.txt": "not a profile",
        "sub.md": "dir", // a directory named sub.md — not a flat profile file
        "real.md": md({ name: "real", description: "d" }, "body"),
      },
    });

    const { profiles, problems } = await discoverAgentProfiles(fs, ROOTS);
    expect(profiles.map((p) => p.name)).toEqual(["real"]);
    expect(problems).toEqual([]);
  });

  it("is fail-soft: a readdir error on one root does not stop the others", async () => {
    const fs = new FakeFs(
      {
        [WS]: { "ignored.md": md({ name: "ignored", description: "d" }, "body") },
        [HOME]: { "good.md": md({ name: "good", description: "d" }, "body") },
      },
      { readdirThrows: [WS] },
    );

    const { profiles, problems } = await discoverAgentProfiles(fs, ROOTS);
    expect(profiles.map((p) => p.name)).toEqual(["good"]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(WS);
  });

  it("returns an empty result (no problems) when the roots do not exist", async () => {
    const fs = new FakeFs({});
    const result = await discoverAgentProfiles(fs, ROOTS);
    expect(result).toEqual({ profiles: [], problems: [] });
  });
});

describe("discoverAgentProfiles — precedence & caps", () => {
  it("dedupes a name across sources: the highest-precedence source wins, other names union in", async () => {
    const fs = new FakeFs({
      [WS]: { "reviewer.md": md({ name: "reviewer", description: "project reviewer" }, "PROJECT BODY") },
      [HOME]: {
        "reviewer.md": md({ name: "reviewer", description: "user reviewer" }, "USER BODY"),
        "user-only.md": md({ name: "user-only", description: "user only" }, "body"),
      },
    });

    const { profiles, problems } = await discoverAgentProfiles(fs, ROOTS);
    expect(problems).toEqual([]);

    const reviewer = profiles.find((p) => p.name === "reviewer");
    // project (first root) claimed "reviewer": its description + body win.
    expect(reviewer?.description).toBe("project reviewer");
    expect(reviewer?.systemPrompt).toBe("PROJECT BODY");
    // exactly one "reviewer" persona; the user-only name unions in.
    expect(profiles.filter((p) => p.name === "reviewer")).toHaveLength(1);
    expect(profiles.map((p) => p.name).sort()).toEqual(["reviewer", "user-only"]);
  });

  it("caps the total at MAX_AGENT_PROFILES (+problem per overflow, name-asc order)", async () => {
    const entries: DirSpec = {};
    const total = MAX_AGENT_PROFILES + 2;
    for (let i = 0; i < total; i += 1) {
      const name = `p${String(i).padStart(2, "0")}`;
      entries[`${name}.md`] = md({ name, description: "d" }, "body");
    }
    const fs = new FakeFs({ [WS]: entries });

    const { profiles, problems } = await discoverAgentProfiles(fs, ROOTS);
    expect(profiles).toHaveLength(MAX_AGENT_PROFILES);
    expect(problems).toHaveLength(2);
    expect(problems.every((p) => p.includes("MAX_AGENT_PROFILES"))).toBe(true);
    // The alphabetically-first MAX names are admitted; the last two overflow.
    expect(profiles.map((p) => p.name)).not.toContain("p32");
    expect(profiles.map((p) => p.name)).not.toContain("p33");
  });
});
