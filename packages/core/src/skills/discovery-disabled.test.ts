/**
 * discoverSkills disabled-filter (P7.20 W1): the optional {disabled} set drops
 * names at CLAIM time (before the MAX_SKILLS cap, so disabling frees a slot),
 * and an absent/empty set leaves discovery byte-identical to the pre-slice
 * behavior (boot byte-invariance).
 */

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverSkills, type SkillRoot } from "./discovery.js";
import { buildSkillsPromptSection } from "./prompt-section.js";
import { NodeFileSystemAdapter } from "../adapters/node/node-file-system.js";
import { MAX_SKILLS } from "../types/config.js";

const fs = new NodeFileSystemAdapter();
const dirs: string[] = [];

async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "skdisc-"));
  dirs.push(d);
  return d;
}

async function seedSkill(root: string, name: string, description = `${name} desc`): Promise<void> {
  await mkdir(join(root, name), { recursive: true });
  await writeFile(
    join(root, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\nbody of ${name}\n`,
    "utf-8",
  );
}

afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

describe("discoverSkills disabled filter", () => {
  it("byte-invariance: undefined vs empty disabled set yields identical metas + promptSection", async () => {
    const root = await tmp();
    await seedSkill(root, "alpha");
    await seedSkill(root, "beta");
    const roots: SkillRoot[] = [{ dir: root, source: "user" }];

    const base = await discoverSkills(fs, roots);
    const withEmpty = await discoverSkills(fs, roots, { disabled: new Set() });

    expect(withEmpty.metas).toEqual(base.metas);
    expect(withEmpty.problems).toEqual(base.problems);
    expect(buildSkillsPromptSection(withEmpty.metas)).toBe(buildSkillsPromptSection(base.metas));
    expect(base.metas.map((m) => m.name)).toEqual(["alpha", "beta"]);
  });

  it("drops disabled names from the result", async () => {
    const root = await tmp();
    await seedSkill(root, "alpha");
    await seedSkill(root, "beta");
    const result = await discoverSkills(fs, [{ dir: root, source: "user" }], {
      disabled: new Set(["alpha"]),
    });
    expect(result.metas.map((m) => m.name)).toEqual(["beta"]);
  });

  it("disabling a claimed name frees a MAX_SKILLS cap slot for a lower one", async () => {
    const root = await tmp();
    // Names s000..s064 => MAX_SKILLS + 1 skills; sorted claim order keeps the
    // first MAX_SKILLS and drops the last (s064) when nothing is disabled.
    const total = MAX_SKILLS + 1;
    for (let i = 0; i < total; i++) {
      await seedSkill(root, `s${String(i).padStart(3, "0")}`);
    }
    const roots: SkillRoot[] = [{ dir: root, source: "user" }];

    const undisabled = await discoverSkills(fs, roots);
    const names = new Set(undisabled.metas.map((m) => m.name));
    expect(undisabled.metas).toHaveLength(MAX_SKILLS);
    expect(names.has("s064")).toBe(false); // dropped by the cap

    // Disable a kept name -> the previously-dropped s064 now fits under the cap.
    const withDisabled = await discoverSkills(fs, roots, { disabled: new Set(["s000"]) });
    const names2 = new Set(withDisabled.metas.map((m) => m.name));
    expect(withDisabled.metas).toHaveLength(MAX_SKILLS);
    expect(names2.has("s000")).toBe(false);
    expect(names2.has("s064")).toBe(true);
  });
});
