/**
 * Taskana 4707 review: the host's builtin-skill composition, and the wiring
 * that keeps host/index.ts calling it. Removing either fails a test here.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildHostBuiltinSkills } from "./builtin-skills.js";

const DOCS = { kind: "remote" as const, ref: "v0.0.35" };
const names = (list: readonly { name: string }[]): string[] => list.map((skill) => skill.name);

describe("buildHostBuiltinSkills", () => {
  it("always registers the unconditional skills (subagent authoring and anycode-setup)", () => {
    const list = buildHostBuiltinSkills({ worktreeAvailable: false, previewAvailable: false, anycodeSetupDocs: DOCS });
    expect(names(list)).toEqual(["creating-subagents", "anycode-setup"]);
  });

  it("adds the worktree and preview skills only when their capability is available", () => {
    const list = buildHostBuiltinSkills({ worktreeAvailable: true, previewAvailable: true, anycodeSetupDocs: DOCS });
    expect(names(list)).toEqual([
      "using-git-worktrees",
      "using-browser-preview",
      "creating-subagents",
      "anycode-setup",
    ]);
  });

  it("gives the anycode-setup skill the docs location it was handed", () => {
    const list = buildHostBuiltinSkills({
      worktreeAvailable: false,
      previewAvailable: false,
      anycodeSetupDocs: { kind: "local", dir: "/Applications/AnyCode.app/Contents/Resources/docs/user" },
    });
    const setup = list.find((skill) => skill.name === "anycode-setup");
    expect(setup?.body).toContain("/Applications/AnyCode.app/Contents/Resources/docs/user/<topic>.md");
  });

  it("is called from host/index.ts boot (the wiring cannot silently drop the setup skill)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const indexSource = readFileSync(resolve(here, "index.ts"), "utf8");
    expect(indexSource).toContain("buildHostBuiltinSkills({");
    expect(indexSource).toContain("anycodeSetupDocs: anycodeSetupDocsForHost(),");
  });
});
