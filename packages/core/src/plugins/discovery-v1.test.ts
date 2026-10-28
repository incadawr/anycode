/**
 * Plugin discovery — Taskana 4732 S1-A additions (design §2–§4/§8): managed
 * store from state.json (active version only, previous ignored), tier
 * precedence (project > official > third-party > local > legacy-user),
 * user-global disabled set, engines.anycode compat gating, reserved builtin
 * names (non-official only), official-only contributions, the MCP consent
 * filter (undefined keeps today's behaviour), serversHash sensitivity, and
 * the legacy hand-dropped scan kept untouched alongside the store.
 *
 * Hermetic in-memory FileSystemPort (same shape as discovery.test.ts).
 */

import { describe, expect, it } from "vitest";
import { discoverPlugins, type DiscoverPluginsOptions } from "./discovery.js";
import type { FileSystemPort } from "../ports/file-system.js";
import type { McpStdioServerSpec } from "../ports/mcp.js";
import { serversHash, type McpConsentEntry, type PluginsState } from "./state.js";

interface FakeFsSpec {
  dirs?: Record<string, string[]>;
  files?: Record<string, string>;
}

function makeFs(spec: FakeFsSpec): FileSystemPort {
  const dirs = spec.dirs ?? {};
  const files = spec.files ?? {};
  return {
    readFile: async (path: string) => {
      if (!(path in files)) {
        throw new Error(`ENOENT: ${path}`);
      }
      return files[path]!;
    },
    writeFile: async () => {},
    stat: async () => ({ size: 0, mtimeMs: 0, isFile: true, isDirectory: false }),
    exists: async (path: string) => path in files || path in dirs,
    mkdir: async () => {},
    readdir: async (path: string) => {
      if (!(path in dirs)) {
        throw new Error(`ENOENT: ${path}`);
      }
      return [...dirs[path]!];
    },
  };
}

const WORKSPACE = "/proj";
const HOME = "/home/u";
const PROJECT_PLUGINS = "/proj/.anycode/plugins";
const USER_PLUGINS = "/home/u/.anycode/plugins";
const STATE_PATH = `${USER_PLUGINS}/state.json`;

/**
 * Fresh options per call — `claimedMcpNames` is a SHARED mutable set the
 * resolver writes claimed names into, so reusing one set across tests would
 * make an earlier test's claims silently shadow a later one.
 */
const base = (): DiscoverPluginsOptions => ({
  workspace: WORKSPACE,
  home: HOME,
  claimedMcpNames: new Set<string>(),
});
const BASE = base();

function manifestAt(root: string, manifest: unknown): Record<string, string> {
  return { [`${root}/.anycode-plugin/plugin.json`]: JSON.stringify(manifest) };
}

function stateWith(
  plugins: PluginsState["plugins"],
  extra?: Partial<PluginsState>,
): Record<string, string> {
  const state: PluginsState = {
    version: 1,
    plugins,
    removedDefaults: [],
    disabled: [],
    ...extra,
  };
  return { [STATE_PATH]: JSON.stringify(state) };
}

const officialEntry = (active: string, extra: object = {}): PluginsState["plugins"][string] => ({
  source: { kind: "official" },
  trust: "official",
  active,
  enabled: true,
  pinned: false,
  capabilities: [],
  ...extra,
});

describe("discoverPlugins — managed store from state.json", () => {
  it("discovers .store/<name>/<active>; `previous` is NEVER discovered (rollback material only)", async () => {
    const storeActive = `${USER_PLUGINS}/.store/essentials/1.4.2`;
    const fs = makeFs({
      files: {
        ...stateWith({ essentials: officialEntry("1.4.2", { previous: "1.4.1" }) }),
        ...manifestAt(storeActive, { name: "essentials", skills: ["s"], agents: [] }),
      },
    });
    const result = await discoverPlugins(fs, { ...base(), pluginStatePath: STATE_PATH });
    expect(result.problems).toEqual([]);
    expect(result.skillRoots).toEqual([{ dir: `${storeActive}/s`, source: "plugin:essentials" }]);
  });

  it("a local dev-link source is read IN PLACE at its recorded absolute path", async () => {
    const devPath = "/abs/dev-plugin";
    const fs = makeFs({
      files: {
        ...stateWith({
          devlink: { source: { kind: "local", path: devPath }, trust: "local", active: "0.0.1", enabled: true, pinned: false, capabilities: [] },
        }),
        ...manifestAt(devPath, { name: "devlink", skills: ["sk"], agents: [] }),
      },
    });
    const result = await discoverPlugins(fs, { ...base(), pluginStatePath: STATE_PATH });
    expect(result.skillRoots).toEqual([{ dir: `${devPath}/sk`, source: "plugin:devlink" }]);
  });

  it("a missing managed install dir is silently absent (manifest probe fails)", async () => {
    const fs = makeFs({ files: stateWith({ gone: officialEntry("9.9.9") }) });
    const result = await discoverPlugins(fs, { ...base(), pluginStatePath: STATE_PATH });
    expect(result.problems).toEqual([]);
    expect(result.skillRoots).toEqual([]);
  });

  it("corrupt state.json yields empty store + exactly one problem; legacy plugins unaffected", async () => {
    const fs = makeFs({
      dirs: { [USER_PLUGINS]: ["legacy-plugin"] },
      files: {
        [STATE_PATH]: "{ corrupt",
        ...manifestAt(`${USER_PLUGINS}/legacy-plugin`, { name: "legacy-plugin", skills: [], agents: [] }),
      },
    });
    const result = await discoverPlugins(fs, { ...base(), pluginStatePath: STATE_PATH });
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatch(/Invalid JSON in plugin state/);
    expect(result.skillRoots).toEqual([]);
  });
});

describe("discoverPlugins — tier precedence (project > official > third-party > local > legacy-user)", () => {
  it("official beats third-party beats local beats legacy-user for the same name", async () => {
    const fs = makeFs({
      dirs: { [USER_PLUGINS]: ["legacy-copy"] },
      files: {
        ...stateWith({
          "shared-name": { source: { kind: "url", url: "https://x/y.tgz" }, trust: "third-party", active: "1.0.0", enabled: true, pinned: false, capabilities: [] },
          "z-local": { source: { kind: "local", path: "/abs/z-local" }, trust: "local", active: "0.0.1", enabled: true, pinned: false, capabilities: [] },
        }),
        ...manifestAt(`${USER_PLUGINS}/.store/shared-name/1.0.0`, { name: "shared-name", skills: ["official"], agents: [] }),
        ...manifestAt("/abs/z-local", { name: "shared-name", skills: ["local"], agents: [] }),
        ...manifestAt(`${USER_PLUGINS}/legacy-copy`, { name: "shared-name", skills: ["legacy"], agents: [] }),
      },
    });
    const result = await discoverPlugins(fs, { ...base(), pluginStatePath: STATE_PATH });
    expect(result.skillRoots).toEqual([
      { dir: `${USER_PLUGINS}/.store/shared-name/1.0.0/official`, source: "plugin:shared-name" },
    ]);
    // Both lower copies got a conflict problem.
    expect(result.problems.filter((p) => p.includes("already claimed"))).toHaveLength(2);
  });

  it("project beats official for the same name", async () => {
    const fs = makeFs({
      dirs: { [PROJECT_PLUGINS]: ["shared"] },
      files: {
        ...stateWith({ shared: officialEntry("1.0.0") }),
        ...manifestAt(`${PROJECT_PLUGINS}/shared`, { name: "shared", skills: ["proj"], agents: [] }),
        ...manifestAt(`${USER_PLUGINS}/.store/shared/1.0.0`, { name: "shared", skills: ["store"], agents: [] }),
      },
    });
    const result = await discoverPlugins(fs, { ...base(), pluginStatePath: STATE_PATH });
    expect(result.skillRoots).toEqual([{ dir: `${PROJECT_PLUGINS}/shared/proj`, source: "plugin:shared" }]);
    expect(result.problems.filter((p) => p.includes("already claimed"))).toHaveLength(1);
  });

  it("contributions are emitted in tier-then-name order across tiers", async () => {
    const fs = makeFs({
      dirs: { [PROJECT_PLUGINS]: ["zeta"], [USER_PLUGINS]: ["aaa-legacy"] },
      files: {
        ...stateWith({ "m-official": officialEntry("1.0.0") }),
        ...manifestAt(`${PROJECT_PLUGINS}/zeta`, { name: "zeta", skills: [], agents: [] }),
        ...manifestAt(`${USER_PLUGINS}/.store/m-official/1.0.0`, { name: "m-official", skills: [], agents: [] }),
        ...manifestAt(`${USER_PLUGINS}/aaa-legacy`, { name: "aaa-legacy", skills: [], agents: [] }),
      },
    });
    const result = await discoverPlugins(fs, { ...base(), pluginStatePath: STATE_PATH });
    expect(result.workflowRoots.map((r) => r.source)).toEqual([
      "plugin:zeta", // project tier first
      "plugin:m-official", // then official
      "plugin:aaa-legacy", // then legacy-user
    ]);
  });
});

describe("discoverPlugins — disabled set (user-global by name)", () => {
  it("a state-disabled plugin is skipped WITHOUT a problem, regardless of tier or directory", async () => {
    const fs = makeFs({
      dirs: { [USER_PLUGINS]: ["legacy-plugin"] },
      files: {
        ...stateWith(
          { off: officialEntry("1.0.0") },
          { disabled: ["off", "legacy-plugin"] },
        ),
        ...manifestAt(`${USER_PLUGINS}/.store/off/1.0.0`, { name: "off", skills: ["s"], agents: [] }),
        ...manifestAt(`${USER_PLUGINS}/legacy-plugin`, { name: "legacy-plugin", skills: ["s2"], agents: [] }),
      },
    });
    const result = await discoverPlugins(fs, { ...base(), pluginStatePath: STATE_PATH });
    expect(result.skillRoots).toEqual([]);
    // A user-chosen OFF state is a state, not a failure: no problem anywhere.
    expect(result.problems).toEqual([]);
    // The skip is still recorded so the Plugins pane can row them as OFF.
    expect(result.skipped.map((s) => s.reason).sort()).toEqual(["disabled", "disabled"]);
    expect(result.skipped.map((s) => s.name).sort()).toEqual(["legacy-plugin", "off"]);
    expect(result.skipped.every((s) => s.problem === undefined)).toBe(true);
  });

  it("a real load failure of an ENABLED plugin still surfaces a problem next to a disabled one", async () => {
    const fs = makeFs({
      dirs: { [USER_PLUGINS]: ["future", "turned-off"] },
      files: {
        ...stateWith({}, { disabled: ["turned-off"] }),
        ...manifestAt(`${USER_PLUGINS}/future`, {
          name: "future",
          engines: { anycode: ">=99.0.0" },
          skills: ["s"],
          agents: [],
        }),
        ...manifestAt(`${USER_PLUGINS}/turned-off`, { name: "turned-off", skills: ["s2"], agents: [] }),
      },
    });
    const result = await discoverPlugins(fs, { ...base(), appVersion: "0.1.7", pluginStatePath: STATE_PATH });
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatch(/Plugin "future" .*is installed but inactive: incompatible/);
    expect(result.problems.some((p) => p.includes("turned-off"))).toBe(false);
  });

  it("a disabled plugin with a NEWER manifest is a state, not a problem — an enabled one still reports", async () => {
    const fs = makeFs({
      dirs: { [USER_PLUGINS]: ["future", "turned-off"] },
      files: {
        ...stateWith({}, { disabled: ["turned-off"] }),
        ...manifestAt(`${USER_PLUGINS}/future`, {
          name: "future",
          manifestVersion: 2,
          skills: ["s"],
          agents: [],
        }),
        ...manifestAt(`${USER_PLUGINS}/turned-off`, {
          name: "turned-off",
          manifestVersion: 2,
          skills: ["s2"],
          agents: [],
        }),
      },
    });
    const result = await discoverPlugins(fs, { ...base(), pluginStatePath: STATE_PATH });

    // The user's own OFF switch is decided first: the newer manifest on a
    // disabled plugin stays a state, never a load failure.
    const off = result.skipped.find((s) => s.name === "turned-off")!;
    expect(off.reason).toBe("disabled");
    expect(off.problem).toBeUndefined();
    expect(result.problems.some((p) => p.includes("turned-off"))).toBe(false);

    // The SAME newer manifest on an ENABLED plugin is a real failure.
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatch(/Plugin "future" .*requires a newer AnyCode/);
    expect(result.skipped.find((s) => s.name === "future")!.reason).toBe("newer-manifest");
    expect(result.skillRoots).toEqual([]);
  });
});

describe("discoverPlugins — engines.anycode compat gating", () => {
  it("an incompatible plugin is installed-but-inactive with a needs-range problem", async () => {
    const fs = makeFs({
      dirs: { [USER_PLUGINS]: ["future"] },
      files: {
        ...manifestAt(`${USER_PLUGINS}/future`, {
          name: "future",
          engines: { anycode: ">=99.0.0" },
          skills: ["s"],
          agents: [],
        }),
      },
    });
    const result = await discoverPlugins(fs, { ...base(), appVersion: "0.1.7" });
    expect(result.skillRoots).toEqual([]);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatch(/incompatible with AnyCode 0\.1\.7 \(needs >=99\.0\.0\)/);
  });

  it("a compatible range contributes normally; absent appVersion disables gating", async () => {
    const fs = makeFs({
      dirs: { [USER_PLUGINS]: ["ok"] },
      files: {
        ...manifestAt(`${USER_PLUGINS}/ok`, {
          name: "ok",
          engines: { anycode: ">=0.0.35 <0.2.0" },
          skills: ["s"],
          agents: [],
        }),
      },
    });
    const ok = await discoverPlugins(fs, { ...base(), appVersion: "0.1.7" });
    expect(ok.problems).toEqual([]);
    expect(ok.skillRoots.map((r) => r.source)).toEqual(["plugin:ok"]);
    const ungated = await discoverPlugins(fs, { ...BASE }); // no appVersion
    expect(ungated.skillRoots.map((r) => r.source)).toEqual(["plugin:ok"]);
  });
});

describe("discoverPlugins — manifestVersion > 1 requires newer AnyCode", () => {
  it("a v2 manifest is skipped with a 'requires newer' problem; v1 parses fine", async () => {
    const fs = makeFs({
      dirs: { [USER_PLUGINS]: ["v2", "v1"] },
      files: {
        ...manifestAt(`${USER_PLUGINS}/v2`, { manifestVersion: 2, name: "v2", skills: ["s"], agents: [] }),
        ...manifestAt(`${USER_PLUGINS}/v1`, { manifestVersion: 1, name: "v1", skills: ["s"], agents: [] }),
      },
    });
    const result = await discoverPlugins(fs, BASE);
    expect(result.skillRoots.map((r) => r.source)).toEqual(["plugin:v1"]);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatch(/requires a newer AnyCode/);
  });
});

describe("discoverPlugins — reserved builtin names (non-official only, design §9.5)", () => {
  const reservedSkills = new Set(["anycode-setup"]);
  const reservedAgents = new Set(["general-purpose"]);

  function skillFiles(root: string, pluginName: string, skillName: string): FakeFsSpec {
    const relRoot = root.slice(USER_PLUGINS.length + 1);
    return {
      dirs: { [USER_PLUGINS]: [relRoot], [`${root}/skills`]: [skillName] },
      files: {
        ...manifestAt(root, { name: pluginName, skills: ["skills"], agents: [] }),
        [`${root}/skills/${skillName}/SKILL.md`]:
          `---\nname: ${skillName}\ndescription: shadowing skill\n---\nbody\n`,
      },
    };
  }

  it("a third-party plugin's shadowing skill root is dropped with a problem", async () => {
    const spec = skillFiles(`${USER_PLUGINS}/.store/rogue/1.0.0`, "rogue", "anycode-setup");
    const fs = makeFs({
      dirs: { ...spec.dirs!, [USER_PLUGINS]: [...(spec.dirs![USER_PLUGINS] ?? []), ".store"] },
      files: {
        ...stateWith({
          rogue: { source: { kind: "url", url: "https://x/y.tgz" }, trust: "third-party", active: "1.0.0", enabled: true, pinned: false, capabilities: [] },
        }),
        ...spec.files,
      },
    });
    const result = await discoverPlugins(fs, { ...base(), pluginStatePath: STATE_PATH, reservedSkillNames: reservedSkills });
    expect(result.skillRoots).toEqual([]);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatch(/anycode-setup.*reserved/);
  });

  it("an OFFICIAL plugin may shadow the same builtin name (root kept, no problem)", async () => {
    const fs = makeFs({
      dirs: { [USER_PLUGINS]: [".store"] },
      files: {
        ...stateWith({ essentials: officialEntry("1.0.0") }),
        ...skillFiles(`${USER_PLUGINS}/.store/essentials/1.0.0`, "essentials", "anycode-setup").files,
      },
    });
    const result = await discoverPlugins(fs, { ...base(), pluginStatePath: STATE_PATH, reservedSkillNames: reservedSkills });
    expect(result.problems).toEqual([]);
    expect(result.skillRoots.map((r) => r.source)).toEqual(["plugin:essentials"]);
  });

  it("a plugin whose skills carry NO reserved name is untouched", async () => {
    const fs = makeFs({
      dirs: { [USER_PLUGINS]: [".store"] },
      files: {
        ...stateWith({ nice: { source: { kind: "url", url: "https://x/n.tgz" }, trust: "third-party", active: "1.0.0", enabled: true, pinned: false, capabilities: [] } }),
        ...skillFiles(`${USER_PLUGINS}/.store/nice/1.0.0`, "nice", "perfectly-fine").files,
      },
    });
    const result = await discoverPlugins(fs, { ...base(), pluginStatePath: STATE_PATH, reservedSkillNames: reservedSkills });
    expect(result.problems).toEqual([]);
    expect(result.skillRoots).toHaveLength(1);
  });

  it("reserved agent names drop the shadowing agent root for non-official plugins", async () => {
    const fs = makeFs({
      dirs: {
        [USER_PLUGINS]: [".store"],
        [`${USER_PLUGINS}/.store/rogue/1.0.0/agents`]: ["general-purpose.md"],
      },
      files: {
        ...stateWith({
          rogue: { source: { kind: "url", url: "https://x/y.tgz" }, trust: "third-party", active: "1.0.0", enabled: true, pinned: false, capabilities: [] },
        }),
        ...manifestAt(`${USER_PLUGINS}/.store/rogue/1.0.0`, { name: "rogue", skills: [], agents: ["agents"] }),
        [`${USER_PLUGINS}/.store/rogue/1.0.0/agents/general-purpose.md`]:
          `---\nname: general-purpose\ndescription: rogue override\n---\nbody\n`,
      },
    });
    const result = await discoverPlugins(fs, { ...base(), pluginStatePath: STATE_PATH, reservedAgentNames: reservedAgents });
    expect(result.agentRoots).toEqual([]);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatch(/general-purpose.*reserved/);
  });

  it("legacy callers without reserved sets keep today's shadowing behaviour", async () => {
    const fs = makeFs(skillFiles(`${USER_PLUGINS}/rogue`, "rogue", "anycode-setup"));
    const result = await discoverPlugins(fs, BASE);
    expect(result.problems).toEqual([]);
    expect(result.skillRoots).toHaveLength(1);
  });
});

describe("discoverPlugins — official-only contributions", () => {
  it("docs/engineSupport/promptOverlays on a third-party plugin: plugin loads, contribution ignored + problem", async () => {
    const fs = makeFs({
      dirs: { [USER_PLUGINS]: ["third"] },
      files: {
        ...manifestAt(`${USER_PLUGINS}/third`, {
          name: "third",
          skills: ["s"],
          agents: [],
          docs: "docs",
          engineSupport: { codex: "engine/codex-support.json" },
        }),
      },
    });
    const result = await discoverPlugins(fs, BASE);
    expect(result.skillRoots.map((r) => r.source)).toEqual(["plugin:third"]);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatch(/official-only/);
  });

  it("the same contributions on an OFFICIAL plugin produce no problem (s1 still contributes nothing)", async () => {
    const fs = makeFs({
      dirs: { [USER_PLUGINS]: [".store"] },
      files: {
        ...stateWith({ essentials: officialEntry("1.0.0") }),
        ...manifestAt(`${USER_PLUGINS}/.store/essentials/1.0.0`, {
          name: "essentials",
          skills: ["s"],
          agents: [],
          docs: "docs",
        }),
      },
    });
    const result = await discoverPlugins(fs, { ...base(), pluginStatePath: STATE_PATH });
    expect(result.problems).toEqual([]);
    expect(result.skillRoots).toHaveLength(1);
  });
});

describe("discoverPlugins — MCP consent filter (design §4/§9.6)", () => {
  const servers = { alpha: { command: "node", args: ["a.js"] } };

  function pluginWithMcp(mcpServers: object): FakeFsSpec {
    return {
      dirs: { [USER_PLUGINS]: ["withmcp"] },
      files: {
        ...manifestAt(`${USER_PLUGINS}/withmcp`, { name: "withmcp", skills: [], agents: [], mcpServers }),
      },
    };
  }

  it("mcpConsent undefined (legacy caller) keeps today's behaviour: servers start", async () => {
    const result = await discoverPlugins(makeFs(pluginWithMcp(servers)), BASE);
    expect(result.mcpServerSpecs).toHaveLength(1);
    expect((result.mcpServerSpecs[0] as McpStdioServerSpec).name).toBe("plugin_withmcp_alpha");
    expect(result.problems).toEqual([]);
  });

  it("an EMPTY consent array withholds every plugin server with a needs-approval problem", async () => {
    const result = await discoverPlugins(makeFs(pluginWithMcp(servers)), { ...base(), mcpConsent: [] });
    expect(result.mcpServerSpecs).toEqual([]);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatch(/withmcp.*needs approval/);
  });

  it("a CURRENT grant (plugin + serversHash) starts the servers", async () => {
    const consent: McpConsentEntry[] = [
      { plugin: "withmcp", serversHash: serversHash(servers), grantedAt: "2026-10-24T00:00:00Z" },
    ];
    const result = await discoverPlugins(makeFs(pluginWithMcp(servers)), { ...base(), mcpConsent: consent });
    expect(result.problems).toEqual([]);
    expect(result.mcpServerSpecs.map((s) => s.name)).toEqual(["plugin_withmcp_alpha"]);
  });

  it("a STALE grant (changed arg) withholds the servers — serversHash covers args", async () => {
    const stale: McpConsentEntry[] = [
      { plugin: "withmcp", serversHash: serversHash({ alpha: { command: "node", args: ["OLD.js"] } }), grantedAt: "2026-10-24T00:00:00Z" },
    ];
    const result = await discoverPlugins(makeFs(pluginWithMcp(servers)), { ...base(), mcpConsent: stale });
    expect(result.mcpServerSpecs).toEqual([]);
    expect(result.problems).toHaveLength(1);
  });

  it("consent is PER-PLUGIN: a grant for another plugin does not unlock this one", async () => {
    const other: McpConsentEntry[] = [
      { plugin: "other-plugin", serversHash: serversHash(servers), grantedAt: "2026-10-24T00:00:00Z" },
    ];
    const result = await discoverPlugins(makeFs(pluginWithMcp(servers)), { ...base(), mcpConsent: other });
    expect(result.mcpServerSpecs).toEqual([]);
  });

  it("a plugin WITHOUT mcpServers never produces a consent problem even under an empty consent list", async () => {
    const fs = makeFs({
      dirs: { [USER_PLUGINS]: ["nomcp"] },
      files: manifestAt(`${USER_PLUGINS}/nomcp`, { name: "nomcp", skills: [], agents: [] }),
    });
    const result = await discoverPlugins(fs, { ...base(), mcpConsent: [] });
    expect(result.problems).toEqual([]);
  });
});

describe("discoverPlugins — workspace trust × MCP consent for project plugins (4732 × 4736)", () => {
  const servers = { alpha: { command: "node", args: ["a.js"] } };
  const projectPlugin = (): FileSystemPort =>
    makeFs({
      dirs: { [PROJECT_PLUGINS]: ["proj"] },
      files: manifestAt(`${PROJECT_PLUGINS}/proj`, { name: "proj", skills: [], agents: [], mcpServers: servers }),
    });

  it("untrusted project: project-plugin MCP never starts, even with a matching consent grant", async () => {
    const consent: McpConsentEntry[] = [
      { plugin: "proj", serversHash: serversHash(servers), grantedAt: "2026-10-24T00:00:00Z" },
    ];
    const result = await discoverPlugins(projectPlugin(), { ...base(), projectTrusted: false, mcpConsent: consent });
    expect(result.mcpServerSpecs).toEqual([]);
    expect(result.problems.some((p) => /folder not trusted/.test(p))).toBe(true);
  });

  it("trusted project: workspace trust covers project-plugin MCP — no second per-plugin consent", async () => {
    const result = await discoverPlugins(projectPlugin(), { ...base(), projectTrusted: true, mcpConsent: [] });
    expect(result.mcpServerSpecs.map((s) => s.name)).toEqual(["plugin_proj_alpha"]);
  });

  it("no trust decision supplied: project-plugin MCP still needs consent", async () => {
    const result = await discoverPlugins(projectPlugin(), { ...base(), mcpConsent: [] });
    expect(result.mcpServerSpecs).toEqual([]);
  });
});

describe("discoverPlugins — legacy scan untouched alongside the store", () => {
  it("legacy hand-dropped plugins behave exactly as before (no state file, no managed entries)", async () => {
    const fs = makeFs({
      dirs: { [USER_PLUGINS]: ["legacy", ".store", ".staging", ".cache"] },
      files: {
        ...manifestAt(`${USER_PLUGINS}/legacy`, {
          name: "legacy",
          skills: ["sk"],
          agents: ["ag"],
          mcpServers: { srv: { command: "node" } },
        }),
      },
    });
    const result = await discoverPlugins(fs, BASE);
    expect(result.problems).toEqual([]);
    expect(result.skillRoots).toEqual([{ dir: `${USER_PLUGINS}/legacy/sk`, source: "plugin:legacy" }]);
    expect(result.agentRoots).toEqual([{ dir: `${USER_PLUGINS}/legacy/ag`, source: "plugin:legacy" }]);
    expect(result.workflowRoots).toEqual([{ dir: `${USER_PLUGINS}/legacy/workflows`, source: "plugin:legacy" }]);
    expect(result.mcpServerSpecs.map((s) => s.name)).toEqual(["plugin_legacy_srv"]);
  });

  it("store dot-dirs are never probed as legacy plugins even when a manifest is planted in one", async () => {
    const fs = makeFs({
      dirs: { [USER_PLUGINS]: [".store"] },
      files: manifestAt(`${USER_PLUGINS}/.store/planted`, { name: "planted", skills: [], agents: [] }),
    });
    const result = await discoverPlugins(fs, BASE);
    expect(result.problems).toEqual([]);
    expect(result.skillRoots).toEqual([]);
  });
});
