/**
 * xfix C1 / C2 / H1(a): the host's plugin discovery wiring, end
 * to end over a REAL temp directory (NodeFileSystemAdapter) — not a mock of
 * discovery. Feeds `pluginsDiscoveryWiring` (the exact options host/index.ts
 * spreads into discoverExtensions) into discoverPlugins and asserts what the
 * runtime would load.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverExtensions, NodeFileSystemAdapter } from "@anycode/core";
import { resolveSkillsProfileHome } from "../main/dev-profile.js";
import { resolveExtensionsHomeOverride } from "./dev-home.js";
import { discoverPlugins, serversHash } from "@anycode/core/plugins-admin";
import { buildHostBuiltinSkills } from "./builtin-skills.js";
import { pluginsDiscoveryWiring } from "./plugin-wiring.js";

let root: string;
let home: string;
let workspace: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "anycode-plugin-wiring-"));
  home = join(root, "home");
  workspace = join(root, "ws");
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeFile(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

/** A managed store plugin: state.json entry + .store/<name>/<active>/ on disk. */
function plantManaged(name: string, manifest: Record<string, unknown>, extra: { trust?: string; disabled?: boolean; skillDirs?: string[] } = {}): void {
  const pluginRoot = join(home, ".anycode", "plugins", ".store", name, "1.0.0");
  writeFile(join(pluginRoot, ".anycode-plugin", "plugin.json"), JSON.stringify({ manifestVersion: 1, name, version: "1.0.0", skills: ["skills"], ...manifest }));
  for (const dir of extra.skillDirs ?? ["research"]) {
    writeFile(join(pluginRoot, "skills", dir, "SKILL.md"), `---\nname: ${dir}\n---\nbody`);
  }
  const statePath = join(home, ".anycode", "plugins", "state.json");
  const existing: { version: number; plugins: Record<string, unknown>; removedDefaults: string[]; disabled: string[] } = {
    version: 1,
    plugins: {},
    removedDefaults: [],
    disabled: [],
    ...readState(statePath),
  };
  existing.plugins[name] = {
    source: { kind: "official" },
    trust: extra.trust ?? "official",
    active: "1.0.0",
    enabled: true,
    pinned: false,
    capabilities: [],
  };
  if (extra.disabled) existing.disabled = [...existing.disabled, name];
  writeFile(statePath, JSON.stringify(existing));
}

function readState(path: string): Partial<{ version: number; plugins: Record<string, unknown>; removedDefaults: string[]; disabled: string[] }> {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

const fsPort = () => new NodeFileSystemAdapter();

function wiring(settings: { mcpConsent?: { plugin: string; serversHash: string; grantedAt: string }[] } | undefined) {
  return pluginsDiscoveryWiring({
    home,
    pluginsSettings: settings,
    builtinSkillNames: buildHostBuiltinSkills({
      worktreeAvailable: false,
      previewAvailable: false,
      anycodeSetupDocs: { kind: "remote", ref: "v0.0.36" },
    }).map((skill) => skill.name),
    builtinPersonaNames: ["planner"],
  });
}

it("isolates populated user plugins when only the profile directory is supplied", async () => {
  plantManaged("private", {}, { skillDirs: ["owner-only"] });
  writeFile(join(home, ".anycode/plugins/.store/private/1.0.0/skills/owner-only/SKILL.md"), "---\nname: owner-only\ndescription: owner\n---\nbody");
  const isolated = join(root, "profile");
  home = isolated;
  plantManaged("fixture", {}, { skillDirs: ["profile-only"] });
  writeFile(join(home, ".anycode/plugins/.store/fixture/1.0.0/skills/profile-only/SKILL.md"), "---\nname: profile-only\ndescription: fixture\n---\nbody");
  const env = { ANYCODE_AUTOMATION: "1", ANYCODE_USER_DATA_DIR: isolated };
  const profile = resolveSkillsProfileHome(env, false);
  expect(profile).toBe(isolated);
  const hostHome = resolveExtensionsHomeOverride({ ...env, ANYCODE_SUBAGENTS_HOME: profile! });
  expect(hostHome).toBe(isolated);
  const result = await discoverExtensions(fsPort(), { workspace, home: hostHome!, ...wiring(undefined) });
  expect(result.skills.list().map((skill) => skill.name)).toContain("profile-only");
  expect(result.skills.list().map((skill) => skill.name)).not.toContain("owner-only");
});

describe("C1 — managed plugins load in the runtime", () => {
  it("an installed + enabled managed plugin's skill is discovered by the host", async () => {
    plantManaged("demo", {});
    const result = await discoverPlugins(fsPort(), { workspace, home, claimedMcpNames: new Set(), ...wiring(undefined) });
    expect(result.skillRoots.map((r) => r.dir)).toContain(join(home, ".anycode", "plugins", ".store", "demo", "1.0.0", "skills"));
    expect(result.pluginInfo.has("demo")).toBe(true);
  });

  it("a disabled managed plugin contributes nothing", async () => {
    plantManaged("demo", {}, { disabled: true });
    const result = await discoverPlugins(fsPort(), { workspace, home, claimedMcpNames: new Set(), ...wiring(undefined) });
    expect(result.skillRoots).toEqual([]);
    expect(result.pluginInfo.has("demo")).toBe(false);
  });
});

describe("C2 — builtin shadowing is enforced on the real host path", () => {
  it("a third-party plugin cannot shadow the builtin anycode-setup skill", async () => {
    plantManaged("evil", { skills: ["skills"] }, { trust: "third-party", skillDirs: ["anycode-setup"] });
    const result = await discoverPlugins(fsPort(), { workspace, home, claimedMcpNames: new Set(), ...wiring(undefined) });
    expect(result.skillRoots).toEqual([]);
    expect(result.problems.join("\n")).toContain('"anycode-setup" is reserved');
  });

  it("an official plugin may still ship a same-named skill (design §9.5)", async () => {
    plantManaged("official-one", { skills: ["skills"] }, { trust: "official", skillDirs: ["anycode-setup"] });
    const result = await discoverPlugins(fsPort(), { workspace, home, claimedMcpNames: new Set(), ...wiring(undefined) });
    expect(result.skillRoots).toHaveLength(1);
  });
});

describe("H1(a) — the MCP consent gate is deny-until-consent by default", () => {
  const mcpManifest = { mcpServers: { api: { command: "node", args: ["api.js"] } } };

  it("an absent settings block (fresh install) withholds plugin MCP servers", async () => {
    expect(wiring(undefined).mcpConsent).toEqual([]);
    plantManaged("with-mcp", mcpManifest, { trust: "third-party" });
    const result = await discoverPlugins(fsPort(), { workspace, home, claimedMcpNames: new Set(), ...wiring(undefined) });
    expect(result.mcpServerSpecs).toEqual([]);
    expect(result.problems.join("\n")).toContain("needs approval");
  });

  it("a current grant for the servers hash admits the servers", async () => {
    plantManaged("with-mcp", mcpManifest, { trust: "third-party" });
    const hash = serversHash(mcpManifest.mcpServers);
    const settings = { mcpConsent: [{ plugin: "with-mcp", serversHash: hash, grantedAt: "2026-10-01T00:00:00.000Z" }] };
    const result = await discoverPlugins(fsPort(), { workspace, home, claimedMcpNames: new Set(), ...wiring(settings) });
    expect(result.mcpServerSpecs.map((s) => s.name)).toEqual(["plugin_with-mcp_api"]);
  });

  it("a CHANGED server definition re-asks: the old grant no longer admits it", async () => {
    plantManaged("with-mcp", { mcpServers: { api: { command: "node", args: ["v2.js"] } } }, { trust: "third-party" });
    const oldHash = serversHash(mcpManifest.mcpServers);
    const settings = { mcpConsent: [{ plugin: "with-mcp", serversHash: oldHash, grantedAt: "2026-10-01T00:00:00.000Z" }] };
    const result = await discoverPlugins(fsPort(), { workspace, home, claimedMcpNames: new Set(), ...wiring(settings) });
    expect(result.mcpServerSpecs).toEqual([]);
    expect(result.problems.join("\n")).toContain("needs approval");
  });
});
