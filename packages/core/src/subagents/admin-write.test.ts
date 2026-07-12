/**
 * subagents/admin-write (P7.21 W1): draft validation refusals, serialize
 * round-trip, and create/save/delete with symlink-resolved containment proven by
 * EXECUTION over real node fs tmpdirs.
 */

import { mkdtemp, mkdir, writeFile, rm, stat, symlink, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  validateAgentProfileDraft,
  serializeAgentProfile,
  createAgentProfile,
  saveAgentProfile,
  deleteAgentProfile,
} from "./admin-write.js";
import { ownAgentRoots } from "./admin-scan.js";
import { parseAgentProfileMd } from "./profiles.js";
import { AGENT_PROFILE_PROMPT_MAX_BYTES } from "../types/config.js";
import { NodeFileSystemAdapter } from "../adapters/node/node-file-system.js";
import type { SubagentProfileDraft } from "./preview.js";

const fs = new NodeFileSystemAdapter();
const dirs: string[] = [];
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "agwr-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

const base: SubagentProfileDraft = { name: "summarizer", description: "Summarizes code", body: "You summarize." };

describe("validateAgentProfileDraft", () => {
  it("accepts a clean draft (no warnings)", () => {
    expect(validateAgentProfileDraft({ ...base, tools: ["Read", "Grep"] })).toEqual({ ok: true, warnings: [] });
  });
  it("refuses a reserved built-in name with the distinct reason", () => {
    const r = validateAgentProfileDraft({ ...base, name: "general-purpose" });
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ reason: "reserved_name" });
  });
  it("refuses a proto-key name", () => {
    const r = validateAgentProfileDraft({ ...base, name: "constructor" });
    expect(r).toMatchObject({ ok: false, reason: "validation_failed" });
  });
  it("refuses an over-cap body (never truncates)", () => {
    const r = validateAgentProfileDraft({ ...base, body: "x".repeat(AGENT_PROFILE_PROMPT_MAX_BYTES + 1) });
    expect(r).toMatchObject({ ok: false, reason: "validation_failed" });
  });
  it("refuses an explicit spawn tool", () => {
    const r = validateAgentProfileDraft({ ...base, tools: ["Read", "Agent"] });
    expect(r).toMatchObject({ ok: false, reason: "validation_failed" });
  });
  it("warns (does not refuse) on an unknown tool name", () => {
    const r = validateAgentProfileDraft({ ...base, tools: ["Read", "NoSuchTool"] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings.some((w) => w.includes("NoSuchTool"))).toBe(true);
  });
  it("refuses a multi-line description (frontmatter smuggling guard)", () => {
    const r = validateAgentProfileDraft({ ...base, description: "line1\ntools: Agent" });
    expect(r).toMatchObject({ ok: false, reason: "validation_failed" });
  });
  it.each([[" Agent "], ['"Agent"'], ["[Agent]"], [" Workflow "]])(
    "refuses a spawn tool that only normalizes through the parser (#3): %j",
    (tool) => {
      // The renderer sends the spawn tool as the whole `tools` list; it evades the
      // raw SPAWN_TOOLS.has check but the parser normalizes it to Agent/Workflow.
      const r = validateAgentProfileDraft({ ...base, tools: [tool] });
      expect(r).toMatchObject({ ok: false, reason: "validation_failed" });
    },
  );
  it("refuses a whitespace-only or empty body — would spawn as the placeholder (#5)", () => {
    expect(validateAgentProfileDraft({ ...base, body: "   " })).toMatchObject({ ok: false, reason: "validation_failed" });
    expect(validateAgentProfileDraft({ ...base, body: "" })).toMatchObject({ ok: false, reason: "validation_failed" });
    expect(validateAgentProfileDraft({ ...base, body: "\n\t \n" })).toMatchObject({ ok: false, reason: "validation_failed" });
  });
});

describe("serializeAgentProfile round-trip", () => {
  it("serialize -> parse reconstructs the identical draft", () => {
    const draft: SubagentProfileDraft = { name: "r", description: "d", tools: ["Read", "Grep"], body: "Body\nwith\nlines and a --- inert line" };
    const parsed = parseAgentProfileMd(serializeAgentProfile(draft), "fallback");
    expect("ok" in parsed).toBe(true);
    if (!("ok" in parsed)) return;
    const back: SubagentProfileDraft = {
      name: parsed.ok.name,
      description: parsed.ok.description,
      tools: parsed.ok.toolsExplicit ? [...parsed.ok.tools] : undefined,
      body: parsed.ok.body,
    };
    expect(back).toEqual(draft);
  });
  it("omits the tools line for an empty/absent list", () => {
    expect(serializeAgentProfile({ name: "r", description: "d", body: "b" })).not.toContain("tools:");
    expect(serializeAgentProfile({ name: "r", description: "d", tools: [], body: "b" })).not.toContain("tools:");
  });
});

describe("create / save / delete with containment", () => {
  it("creates a profile, refuses a duplicate, then deletes it", async () => {
    const ws = await tmp();
    const home = ws;
    const roots = ownAgentRoots(ws, home);
    const targetRoot = join(ws, ".anycode/agents");

    const created = await createAgentProfile(fs, targetRoot, base, roots);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.path).toBe(join(targetRoot, "summarizer.md"));
    // The file exists on disk and re-parses.
    const parsed = parseAgentProfileMd(await readFile(created.path, "utf-8"), "summarizer");
    expect("ok" in parsed && parsed.ok.name).toBe("summarizer");

    const dup = await createAgentProfile(fs, targetRoot, base, roots);
    expect(dup).toEqual({ ok: false, reason: "name_conflict" });

    const del = await deleteAgentProfile(fs, created.path, roots);
    expect(del).toEqual({ ok: true });
    await expect(stat(created.path)).rejects.toThrow();
  });

  it("save with a name change renames on disk (write-new + delete-old)", async () => {
    const ws = await tmp();
    const roots = ownAgentRoots(ws, ws);
    const targetRoot = join(ws, ".anycode/agents");
    const created = await createAgentProfile(fs, targetRoot, base, roots);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const renamed = await saveAgentProfile(fs, created.path, targetRoot, { ...base, name: "condenser", body: "Now condenses." }, roots);
    expect(renamed.ok).toBe(true);
    if (!renamed.ok) return;
    expect(renamed.path).toBe(join(targetRoot, "condenser.md"));
    await expect(stat(join(targetRoot, "summarizer.md"))).rejects.toThrow();
    const parsed = parseAgentProfileMd(await readFile(renamed.path, "utf-8"), "condenser");
    expect("ok" in parsed && parsed.ok.body).toBe("Now condenses.");
  });

  it("refuses delete when the profile path is outside the own roots", async () => {
    const ws = await tmp();
    const home = await tmp();
    const roots = ownAgentRoots(ws, home);
    const outside = join(home, "elsewhere.md");
    await writeFile(outside, "keep", "utf-8");
    const refused = await deleteAgentProfile(fs, outside, roots);
    expect(refused).toEqual({ ok: false, reason: "outside_own_roots" });
    await expect(stat(outside)).resolves.toBeDefined();
  });

  it("refuses create when the own-catalog root is a symlink escaping the catalog", async () => {
    const ws = await tmp();
    const home = await tmp();
    const outside = await tmp();
    await mkdir(join(ws, ".anycode"), { recursive: true });
    // .anycode/agents -> an outside directory: a symlinked own root is untrusted.
    await symlink(outside, join(ws, ".anycode/agents"));
    const roots = ownAgentRoots(ws, home);
    const targetRoot = join(ws, ".anycode/agents");
    const result = await createAgentProfile(fs, targetRoot, base, roots);
    expect(result).toEqual({ ok: false, reason: "outside_own_roots" });
    // Nothing was written into the outside tree.
    await expect(stat(join(outside, "summarizer.md"))).rejects.toThrow();
  });

  it("refuses delete of a profile file that is itself a symlink escaping the catalog", async () => {
    const ws = await tmp();
    const home = await tmp();
    const outside = await tmp();
    const victim = join(outside, "victim.md");
    await writeFile(victim, "do not delete", "utf-8");
    const targetRoot = join(ws, ".anycode/agents");
    await mkdir(targetRoot, { recursive: true });
    // A profile-file symlink pointing outside the catalog.
    await symlink(victim, join(targetRoot, "evil.md"));
    const roots = ownAgentRoots(ws, home);
    const result = await deleteAgentProfile(fs, join(targetRoot, "evil.md"), roots);
    expect(result).toEqual({ ok: false, reason: "outside_own_roots" });
    await expect(stat(victim)).resolves.toBeDefined();
  });

  it("refuses create when an INTERMEDIATE component is a symlink escaping the base (#1)", async () => {
    const ws = await tmp();
    const outside = await tmp();
    // .anycode is a symlink; agents is a REAL dir INSIDE the link target, so the
    // root's final-component lstat sees a legit dir — only base anchoring catches it.
    await mkdir(join(outside, "agents"), { recursive: true });
    await symlink(outside, join(ws, ".anycode"));
    const roots = ownAgentRoots(ws, ws);
    const targetRoot = join(ws, ".anycode/agents");
    const result = await createAgentProfile(fs, targetRoot, base, roots);
    expect(result).toEqual({ ok: false, reason: "outside_own_roots" });
    await expect(stat(join(outside, "agents", "summarizer.md"))).rejects.toThrow();
  });

  it("serializes concurrent renames of the same source — exactly one wins, no duplicate (#4)", async () => {
    const ws = await tmp();
    const roots = ownAgentRoots(ws, ws);
    const targetRoot = join(ws, ".anycode/agents");
    const created = await createAgentProfile(fs, targetRoot, base, roots);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const [r1, r2] = await Promise.all([
      saveAgentProfile(fs, created.path, targetRoot, { ...base, name: "bbb" }, roots),
      saveAgentProfile(fs, created.path, targetRoot, { ...base, name: "ccc" }, roots),
    ]);
    expect([r1.ok, r2.ok].filter(Boolean)).toHaveLength(1);
    const bExists = await stat(join(targetRoot, "bbb.md")).then(() => true, () => false);
    const cExists = await stat(join(targetRoot, "ccc.md")).then(() => true, () => false);
    // Exactly one target file exists — the source did not fan out into two profiles.
    expect(bExists).not.toBe(cExists);
    await expect(stat(join(targetRoot, "summarizer.md"))).rejects.toThrow();
  });
});
