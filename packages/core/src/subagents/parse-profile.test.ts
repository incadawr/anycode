/**
 * parseAgentProfileMd unit tests + discovery byte-invariance regression (P7.21
 * W1). The pure per-file parser is the shared oracle for discovery and the admin
 * validator/preview; the regression pins that factoring it out left
 * discoverAgentProfiles' profiles[]/problems[] byte-identical.
 */

import { describe, expect, it } from "vitest";
import { join } from "node:path";

import {
  parseAgentProfileMd,
  discoverAgentProfiles,
  type AgentProfileRoot,
} from "./profiles.js";
import { PERSONAS } from "./personas.js";
import { AGENT_PROFILE_PROMPT_MAX_BYTES } from "../types/config.js";
import type { FileStat, FileSystemPort } from "../ports/file-system.js";

function md(fields: Record<string, string>, body: string): string {
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join("\n")}\n---\n${body}`;
}

describe("parseAgentProfileMd", () => {
  it("parses a full profile and reports no problems", () => {
    const res = parseAgentProfileMd(md({ name: "reviewer", description: "Code reviewer" }, "Review."), "file");
    expect("ok" in res).toBe(true);
    if (!("ok" in res)) return;
    expect(res.ok).toMatchObject({
      name: "reviewer",
      description: "Code reviewer",
      toolsExplicit: false,
      body: "Review.",
      problems: [],
    });
    expect(res.ok.tools).toEqual([...PERSONAS["general-purpose"].tools]);
  });

  it("falls back to the filename when frontmatter omits name", () => {
    const res = parseAgentProfileMd(md({ description: "d" }, "b"), "helper");
    expect("ok" in res && res.ok.name).toBe("helper");
  });

  it("keeps an explicit tools list as-is and flags a spawn tool (non-fatal)", () => {
    const res = parseAgentProfileMd(md({ name: "r", description: "d", tools: "Read, Agent, Workflow" }, "b"), "f");
    expect("ok" in res).toBe(true);
    if (!("ok" in res)) return;
    expect(res.ok.toolsExplicit).toBe(true);
    expect(res.ok.tools).toEqual(["Read", "Agent", "Workflow"]);
    expect(res.ok.problems).toEqual([
      "requests Agent — ignored (non-recursion lock)",
      "requests Workflow — ignored (non-recursion lock)",
    ]);
  });

  it("returns a frontmatter error for a non-conforming file", () => {
    const res = parseAgentProfileMd("no frontmatter", "f");
    expect(res).toEqual({ error: { kind: "frontmatter", detail: expect.any(String) } });
  });

  it("returns a bad_name error carrying the resolved name", () => {
    const res = parseAgentProfileMd(md({ name: "bad name", description: "d" }, "b"), "f");
    expect(res).toEqual({ error: { kind: "bad_name", name: "bad name" } });
  });

  it("returns a reserved_name error for a built-in persona name", () => {
    const res = parseAgentProfileMd(md({ name: "general-purpose", description: "d" }, "b"), "f");
    expect(res).toEqual({ error: { kind: "reserved_name", name: "general-purpose" } });
  });

  it("returns a missing_description error (with name) when description is absent", () => {
    const res = parseAgentProfileMd(md({ name: "r" }, "b"), "f");
    expect(res).toEqual({ error: { kind: "missing_description", name: "r" } });
  });

  it("caps an oversize body and placeholders an empty one", () => {
    const big = "x".repeat(AGENT_PROFILE_PROMPT_MAX_BYTES + 100);
    const capped = parseAgentProfileMd(md({ name: "r", description: "d" }, big), "f");
    expect("ok" in capped && Buffer.byteLength(capped.ok.body)).toBe(AGENT_PROFILE_PROMPT_MAX_BYTES);
    const empty = parseAgentProfileMd(md({ name: "bare", description: "d" }, "   "), "f");
    expect("ok" in empty && empty.ok.body).toBe('[agent profile "bare" — empty body]');
  });
});

// ---------------------------------------------------------------------------
// Discovery byte-invariance: a crafted multi-file fixture whose profiles[] and
// problems[] must stay byte-stable after the parseAgentProfileMd extraction.

type Entry = string | "dir";
class FakeFs implements FileSystemPort {
  private files = new Map<string, string>();
  private dirs = new Set<string>();
  constructor(spec: Record<string, Record<string, Entry>>) {
    for (const [dir, entries] of Object.entries(spec)) {
      this.dirs.add(dir);
      for (const [n, v] of Object.entries(entries)) {
        const full = join(dir, n);
        if (v === "dir") this.dirs.add(full);
        else this.files.set(full, v);
      }
    }
  }
  async readFile(p: string): Promise<string> {
    const c = this.files.get(p);
    if (c === undefined) throw new Error(`ENOENT ${p}`);
    return c;
  }
  async writeFile(): Promise<void> {
    throw new Error("nope");
  }
  async stat(p: string): Promise<FileStat> {
    const isFile = this.files.has(p);
    const isDirectory = this.dirs.has(p);
    if (!isFile && !isDirectory) throw new Error(`ENOENT ${p}`);
    return { size: 0, mtimeMs: 0, isFile, isDirectory };
  }
  async exists(p: string): Promise<boolean> {
    return this.files.has(p) || this.dirs.has(p);
  }
  async mkdir(): Promise<void> {}
  async readdir(p: string): Promise<string[]> {
    const prefix = `${p}/`;
    const names = new Set<string>();
    for (const key of [...this.files.keys(), ...this.dirs]) {
      if (key.startsWith(prefix)) {
        names.add(key.slice(prefix.length).split("/")[0]!);
      }
    }
    return [...names];
  }
}

const WS = "/ws/.anycode/agents";
const HOME = "/home/.anycode/agents";
const ROOTS: AgentProfileRoot[] = [
  { dir: WS, source: "project" },
  { dir: HOME, source: "user" },
];

describe("discoverAgentProfiles byte-invariance (post-extraction regression)", () => {
  it("yields the exact profiles[] and problems[] for a mixed fixture", async () => {
    const fs = new FakeFs({
      [WS]: {
        "reviewer.md": md({ name: "reviewer", description: "project reviewer" }, "PROJECT BODY"),
        "spawner.md": md({ name: "spawner", description: "d", tools: "Read, Agent" }, "b"),
        "noname.md": md({ description: "no name here" }, "b"),
        "bad.md": md({ name: "bad name", description: "d" }, "b"),
        "reserved.md": md({ name: "explore", description: "d" }, "b"),
        "broken.md": "no frontmatter",
      },
      [HOME]: {
        "reviewer.md": md({ name: "reviewer", description: "user reviewer" }, "USER BODY"),
        "useronly.md": md({ name: "useronly", description: "u" }, "b"),
      },
    });

    const first = await discoverAgentProfiles(fs, ROOTS);
    const second = await discoverAgentProfiles(fs, ROOTS);
    // Deterministic.
    expect(second).toEqual(first);

    expect(first.profiles).toEqual([
      { name: "noname", description: "no name here", tools: [...PERSONAS["general-purpose"].tools], systemPrompt: "b" },
      { name: "reviewer", description: "project reviewer", tools: [...PERSONAS["general-purpose"].tools], systemPrompt: "PROJECT BODY" },
      { name: "spawner", description: "d", tools: ["Read", "Agent"], systemPrompt: "b" },
      { name: "useronly", description: "u", tools: [...PERSONAS["general-purpose"].tools], systemPrompt: "b" },
    ]);

    expect(first.problems).toEqual([
      `Agent profile ${join(WS, "bad.md")}: name "bad name" must match ${/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.source} — ignored`,
      `Invalid agent profile ${join(WS, "broken.md")}: missing opening '---' frontmatter fence`,
      `Agent profile ${join(WS, "reserved.md")}: name "explore" is reserved by a built-in persona — ignored`,
      `Agent profile ${join(WS, "spawner.md")}: requests Agent — ignored (non-recursion lock)`,
    ]);
  });
});
