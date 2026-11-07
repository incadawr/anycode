import { afterAll, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
vi.mock("../shared/engine-skills.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../shared/engine-skills.js")>();
  return { ...actual, ENGINE_BUILTIN_SKILLS: [{ ...actual.ENGINE_BUILTIN_SKILLS[0], id: "synthetic-builtin" }] };
});
import { handleSkillsSetEnabled, NodeSkillsFs } from "./skills-ipc.js";
const roots: string[] = [];
afterAll(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); });
it("derives the IPC allowlist from the catalog, including additions and removals", async () => {
  const home = await mkdtemp(join(tmpdir(), "catalog-allowlist-")); roots.push(home);
  const deps = { home: () => home, workspaceForTab: () => undefined, fs: new NodeSkillsFs(), reveal() {} };
  expect((await handleSkillsSetEnabled(deps, { builtinId: "synthetic-builtin", scope: "user", enabled: false })).ok).toBe(true);
  expect(JSON.parse(await readFile(join(home, ".anycode/config.json"), "utf8")).skills.disabled).toEqual(["synthetic-builtin"]);
  expect((await handleSkillsSetEnabled(deps, { builtinId: "anycode-setup", scope: "user", enabled: false })).ok).toBe(false);
});
