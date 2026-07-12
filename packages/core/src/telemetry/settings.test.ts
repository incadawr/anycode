/**
 * settings.test.ts (slice P7.22/F19 W1): setUserTelemetryEnabled — 1:1 mirror
 * of skills/settings.test.ts's setSkillEnabled coverage. Patches ONLY
 * `telemetry.enabled`, preserving every sibling top-level key AND sibling
 * `telemetry.*` keys (e.g. `dir`) byte-semantically; creates the section/file
 * when absent. Real node fs in a tmpdir.
 */

import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setUserTelemetryEnabled, userTelemetryConfigPath } from "./settings.js";
import { NodeFileSystemAdapter } from "../adapters/node/node-file-system.js";

const fs = new NodeFileSystemAdapter();
const dirs: string[] = [];

async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "telset-"));
  dirs.push(d);
  return d;
}

async function seedConfig(home: string, config: unknown): Promise<string> {
  const path = userTelemetryConfigPath(home);
  await mkdir(join(home, ".anycode"), { recursive: true });
  await writeFile(path, JSON.stringify(config, null, 2), "utf-8");
  return path;
}

afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

describe("setUserTelemetryEnabled", () => {
  it("flips telemetry.enabled while preserving mcpServers + skills + telemetry.dir siblings", async () => {
    const home = await tmp();
    const path = await seedConfig(home, {
      mcpServers: { srv: { command: "x", enabled: true } },
      skills: { disabled: ["alpha"] },
      telemetry: { enabled: false, dir: "/custom/telemetry/dir" },
    });
    await setUserTelemetryEnabled(fs, home, true);
    const cfg = JSON.parse(await readFile(path, "utf-8"));
    expect(cfg.telemetry).toEqual({ enabled: true, dir: "/custom/telemetry/dir" });
    expect(cfg.mcpServers).toEqual({ srv: { command: "x", enabled: true } });
    expect(cfg.skills).toEqual({ disabled: ["alpha"] });
  });

  it("flips true -> false and back, idempotent on repeat", async () => {
    const home = await tmp();
    const path = await seedConfig(home, { telemetry: { enabled: true } });
    await setUserTelemetryEnabled(fs, home, false);
    expect(JSON.parse(await readFile(path, "utf-8")).telemetry.enabled).toBe(false);
    await setUserTelemetryEnabled(fs, home, false);
    expect(JSON.parse(await readFile(path, "utf-8")).telemetry.enabled).toBe(false);
    await setUserTelemetryEnabled(fs, home, true);
    expect(JSON.parse(await readFile(path, "utf-8")).telemetry.enabled).toBe(true);
  });

  it("creates the telemetry section when absent, preserving other top-level keys", async () => {
    const home = await tmp();
    const path = await seedConfig(home, { hooks: { PreToolUse: [{ matcher: "*" }] } });
    await setUserTelemetryEnabled(fs, home, true);
    const cfg = JSON.parse(await readFile(path, "utf-8"));
    expect(cfg.telemetry).toEqual({ enabled: true });
    expect(cfg.hooks).toEqual({ PreToolUse: [{ matcher: "*" }] });
  });

  it("creates the config file from scratch when absent", async () => {
    const home = await tmp();
    const path = userTelemetryConfigPath(home);
    await setUserTelemetryEnabled(fs, home, true);
    expect(JSON.parse(await readFile(path, "utf-8")).telemetry).toEqual({ enabled: true });
  });

  it("serializes concurrent patches to the same file without a lost update", async () => {
    const home = await tmp();
    await seedConfig(home, { mcpServers: { a: {} } });
    await Promise.all([
      setUserTelemetryEnabled(fs, home, true),
      setUserTelemetryEnabled(fs, home, false),
      setUserTelemetryEnabled(fs, home, true),
    ]);
    const cfg = JSON.parse(await readFile(userTelemetryConfigPath(home), "utf-8"));
    expect(typeof cfg.telemetry.enabled).toBe("boolean");
    expect(cfg.mcpServers).toEqual({ a: {} });
  });
});
