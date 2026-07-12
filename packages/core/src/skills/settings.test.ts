/**
 * skills/settings (P7.20 W1): loadDisabledSkills union/fail-soft +
 * setSkillEnabled/removeDisabledEntry patch ONLY skills.disabled and preserve
 * every sibling config key byte-semantically. Real node fs in a tmpdir.
 */

import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  anycodeConfigPath,
  loadDisabledSkills,
  removeDisabledEntry,
  setSkillEnabled,
} from "./settings.js";
import { NodeFileSystemAdapter } from "../adapters/node/node-file-system.js";

const fs = new NodeFileSystemAdapter();
const dirs: string[] = [];

async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "skset-"));
  dirs.push(d);
  return d;
}

async function seedConfig(base: string, config: unknown): Promise<string> {
  const path = anycodeConfigPath(base);
  await mkdir(join(base, ".anycode"), { recursive: true });
  await writeFile(path, JSON.stringify(config, null, 2), "utf-8");
  return path;
}

afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

describe("loadDisabledSkills", () => {
  it("unions project + user disabled lists, fail-soft on missing", async () => {
    const ws = await tmp();
    const home = await tmp();
    await seedConfig(ws, { skills: { disabled: ["a", "b"] } });
    await seedConfig(home, { skills: { disabled: ["b", "c"] } });
    const set = await loadDisabledSkills(fs, { workspace: ws, home });
    expect([...set].sort()).toEqual(["a", "b", "c"]);
  });

  it("returns empty set when nothing is disabled / files absent", async () => {
    const ws = await tmp();
    const home = await tmp();
    const set = await loadDisabledSkills(fs, { workspace: ws, home });
    expect(set.size).toBe(0);
  });

  it("is fail-soft on malformed JSON and non-array disabled", async () => {
    const ws = await tmp();
    const home = await tmp();
    await mkdir(join(ws, ".anycode"), { recursive: true });
    await writeFile(anycodeConfigPath(ws), "{ not json", "utf-8");
    await seedConfig(home, { skills: { disabled: "nope" } });
    const set = await loadDisabledSkills(fs, { workspace: ws, home });
    expect(set.size).toBe(0);
  });

  it("reads a shared workspace===home config once", async () => {
    const base = await tmp();
    await seedConfig(base, { skills: { disabled: ["x"] } });
    const set = await loadDisabledSkills(fs, { workspace: base, home: base });
    expect([...set]).toEqual(["x"]);
  });
});

describe("setSkillEnabled / removeDisabledEntry", () => {
  it("disabling adds the name and preserves sibling mcpServers + hooks keys", async () => {
    const base = await tmp();
    const path = await seedConfig(base, {
      mcpServers: { srv: { command: "x", enabled: true } },
      hooks: { PreToolUse: [{ matcher: "*" }] },
      telemetry: { enabled: false },
    });
    await setSkillEnabled(fs, path, "alpha", false);
    const cfg = JSON.parse(await readFile(path, "utf-8"));
    expect(cfg.skills.disabled).toEqual(["alpha"]);
    expect(cfg.mcpServers).toEqual({ srv: { command: "x", enabled: true } });
    expect(cfg.hooks).toEqual({ PreToolUse: [{ matcher: "*" }] });
    expect(cfg.telemetry).toEqual({ enabled: false });
  });

  it("enabling removes the name; disabling is idempotent", async () => {
    const base = await tmp();
    const path = await seedConfig(base, { skills: { disabled: ["alpha", "beta"] } });
    await setSkillEnabled(fs, path, "alpha", true);
    expect(JSON.parse(await readFile(path, "utf-8")).skills.disabled).toEqual(["beta"]);
    await setSkillEnabled(fs, path, "beta", false);
    expect(JSON.parse(await readFile(path, "utf-8")).skills.disabled).toEqual(["beta"]);
  });

  it("removeDisabledEntry drops a name without creating the key when absent", async () => {
    const base = await tmp();
    const path = await seedConfig(base, { mcpServers: {} });
    await removeDisabledEntry(fs, path, "ghost");
    const cfg = JSON.parse(await readFile(path, "utf-8"));
    expect(cfg.skills).toBeUndefined();
    expect(cfg.mcpServers).toEqual({});
  });

  it("creates config from scratch when absent", async () => {
    const base = await tmp();
    const path = anycodeConfigPath(base);
    await setSkillEnabled(fs, path, "solo", false);
    expect(JSON.parse(await readFile(path, "utf-8")).skills.disabled).toEqual(["solo"]);
  });
});
