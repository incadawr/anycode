import { mkdtemp, readFile, rm, stat, symlink, mkdir, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentProjectsStore } from "./communication-agent-projects.js";

let dir: string;
let file: string;
let project: string;
let link: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "anycode-agent-projects-"));
  file = join(dir, "communication-agent-projects.json");
  project = join(dir, "project");
  link = join(dir, "link");
  await mkdir(project);
  await symlink(project, link);
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
const store = () => createAgentProjectsStore({ file, realpathSync });

describe("per-project agent-open switch (Taskana 4768)", () => {
  it("is off everywhere by default", () => {
    const s = store();
    expect(s.isAllowed(project)).toBe(false);
    expect(s.allowedKeys()).toEqual([]);
  });

  it("canonicalises a symlink to its realpath key and persists 0600", async () => {
    const s = store();
    expect(s.setAllowed(link, true)).toBe(true);
    expect(s.isAllowed(project)).toBe(true);
    expect(s.isAllowed(link)).toBe(true);
    expect(s.allowedKeys()).toEqual([realpathSync(project)]);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(Object.keys(JSON.parse(await readFile(file, "utf8")))).toEqual([realpathSync(project)]);
    expect(store().isAllowed(project)).toBe(true);
    expect(s.setAllowed(project, false)).toBe(true);
    expect(s.isAllowed(link)).toBe(false);
  });

  it("a corrupt file reads as empty (fail closed)", async () => {
    await writeFile(file, "{not json");
    expect(store().isAllowed(project)).toBe(false);
    await writeFile(file, JSON.stringify({ [realpathSync(project)]: "yes" }));
    expect(store().isAllowed(project)).toBe(false);
  });

  it("exact-key forget refuses unknown keys and removes known ones", () => {
    const s = store();
    s.setAllowed(project, true);
    expect(s.hasExactKey(link)).toBe(false);
    expect(s.forgetExactKey(link)).toBe(false);
    expect(s.forgetExactKey(realpathSync(project))).toBe(true);
    expect(s.isAllowed(project)).toBe(false);
  });
});
