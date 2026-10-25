/**
 * discoverExtensions — Taskana 4732 S1-A workflow-contribution tests (design
 * §8): plugin workflow roots land BETWEEN user and bundled (a plugin preset
 * shadows the bundled deep-research; project/user shadow the plugin), the
 * passthrough options (pluginStatePath/appVersion/reserved/consent) reach
 * discoverPlugins, and a no-plugin boot stays byte-invariant (empty result
 * arrays + zero problems — additive-optional contract).
 *
 * Real (unmocked) discoverPlugins over the hermetic in-memory port, so the
 * plugin→workflow wiring is exercised end-to-end.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileSystemPort } from "../ports/file-system.js";

const WORKFLOW_DISCOVERY_PATH = "../workflow/discovery.js";

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
const USER_PLUGINS = "/home/u/.anycode/plugins";
const STATE_PATH = `${USER_PLUGINS}/state.json`;

const WORKFLOW_JSON = {
  name: "deep-research",
  description: "plugin-provided deep research preset",
  steps: [{ id: "plan", agentType: "general-purpose", promptTemplate: "Plan: ${input}" }],
};

function pluginFixture(): FakeFsSpec {
  const storeRoot = `${USER_PLUGINS}/.store/essentials/1.0.0`;
  return {
    dirs: {
      [USER_PLUGINS]: [".store"],
      [`${storeRoot}/workflows`]: ["deep-research.json"],
    },
    files: {
      [STATE_PATH]: JSON.stringify({
        version: 1,
        plugins: {
          essentials: {
            source: { kind: "official" },
            trust: "official",
            active: "1.0.0",
            enabled: true,
            pinned: false,
            capabilities: [],
          },
        },
        removedDefaults: [],
        disabled: [],
      }),
      [`${storeRoot}/.anycode-plugin/plugin.json`]: JSON.stringify({
        manifestVersion: 1,
        name: "essentials",
        version: "1.0.0",
        skills: [],
        agents: [],
        workflows: ["workflows"],
      }),
      [`${storeRoot}/workflows/deep-research.json`]: JSON.stringify(WORKFLOW_JSON),
    },
  };
}

afterEach(() => {
  vi.doUnmock(WORKFLOW_DISCOVERY_PATH);
  vi.resetModules();
});

describe("discoverExtensions — plugin workflow roots (Taskana 4732 S1-A)", () => {
  it("plugin roots land BETWEEN user and bundled; a plugin preset shadows the bundled one", async () => {
    let capturedRoots: unknown;
    vi.doMock(WORKFLOW_DISCOVERY_PATH, () => ({
      discoverWorkflows: vi.fn(async (_fs: unknown, roots: unknown) => {
        capturedRoots = roots;
        return { workflows: [], problems: [] };
      }),
    }));
    const { discoverExtensions, BUNDLED_WORKFLOWS_DIR } = await import("../extensions/bootstrap.js");
    await discoverExtensions(makeFs(pluginFixture()), {
      workspace: WORKSPACE,
      home: HOME,
      pluginStatePath: STATE_PATH,
    });

    expect(capturedRoots).toEqual([
      { dir: `${WORKSPACE}/.anycode/workflows`, source: "project" },
      { dir: `${HOME}/.anycode/workflows`, source: "user" },
      { dir: `${USER_PLUGINS}/.store/essentials/1.0.0/workflows`, source: "plugin:essentials" },
      { dir: BUNDLED_WORKFLOWS_DIR, source: "bundled" },
    ]);
  });

  it("end-to-end: the plugin's workflow definition is discovered with source plugin:<name>", async () => {
    const { discoverExtensions } = await import("../extensions/bootstrap.js");
    const bootstrap = await discoverExtensions(makeFs(pluginFixture()), {
      workspace: WORKSPACE,
      home: HOME,
      pluginStatePath: STATE_PATH,
    });
    expect(bootstrap.problems).toEqual([]);
    const workflow = bootstrap.workflows.find((w) => w.name === "deep-research");
    expect(workflow).toBeDefined();
    expect(workflow!.source).toBe("plugin:essentials");
    // The prompt section advertises it too (fourth subsystem wiring intact).
    expect(bootstrap.workflowsPromptSection).toContain("deep-research");
  });

  it("a project workflow with the same name shadows the plugin's (claimed-set precedence)", async () => {
    const spec = pluginFixture();
    spec.files![`${WORKSPACE}/.anycode/workflows/deep-research.json`] = JSON.stringify({
      ...WORKFLOW_JSON,
      description: "project override",
    });
    spec.dirs![`${WORKSPACE}/.anycode/workflows`] = ["deep-research.json"];
    const { discoverExtensions } = await import("../extensions/bootstrap.js");
    const bootstrap = await discoverExtensions(makeFs(spec), {
      workspace: WORKSPACE,
      home: HOME,
      pluginStatePath: STATE_PATH,
    });
    const workflow = bootstrap.workflows.find((w) => w.name === "deep-research");
    expect(workflow!.source).toBe("project");
    expect(workflow!.description).toBe("project override");
  });

  it("no-plugin boot stays byte-invariant: no workflow roots, empty arrays, zero problems", async () => {
    let capturedRoots: unknown;
    vi.doMock(WORKFLOW_DISCOVERY_PATH, () => ({
      discoverWorkflows: vi.fn(async (_fs: unknown, roots: unknown) => {
        capturedRoots = roots;
        return { workflows: [], problems: [] };
      }),
    }));
    const { discoverExtensions, BUNDLED_WORKFLOWS_DIR } = await import("../extensions/bootstrap.js");
    const bootstrap = await discoverExtensions(makeFs({}), {
      workspace: WORKSPACE,
      home: HOME,
    });
    expect(capturedRoots).toEqual([
      { dir: `${WORKSPACE}/.anycode/workflows`, source: "project" },
      { dir: `${HOME}/.anycode/workflows`, source: "user" },
      { dir: BUNDLED_WORKFLOWS_DIR, source: "bundled" },
    ]);
    expect(bootstrap.problems).toEqual([]);
    expect(bootstrap.workflows).toEqual([]);
    expect(bootstrap.pluginMcpServerSpecs).toEqual([]);
    expect(bootstrap.skillsPromptSection).toBe("");
    expect(bootstrap.profilesPromptSection).toBe("");
    expect(bootstrap.workflowsPromptSection).toBe("");
    expect(bootstrap.memorySection).toBe("");
  });

  it("passthrough options reach discoverPlugins (state path, app version, consent)", async () => {
    const PLUGINS_PATH = "../plugins/discovery.js";
    let capturedOptions: unknown;
    vi.doMock(PLUGINS_PATH, () => ({
      discoverPlugins: vi.fn(async (_fs: unknown, opts: unknown) => {
        capturedOptions = opts;
        return { skillRoots: [], agentRoots: [], workflowRoots: [], mcpServerSpecs: [], problems: [] };
      }),
    }));
    try {
      const { discoverExtensions } = await import("../extensions/bootstrap.js");
      await discoverExtensions(makeFs({}), {
        workspace: WORKSPACE,
        home: HOME,
        pluginStatePath: STATE_PATH,
        appVersion: "0.1.7",
        reservedSkillNames: new Set(["anycode-setup"]),
        reservedAgentNames: new Set(["general-purpose"]),
        mcpConsent: [],
      });
      expect(capturedOptions).toMatchObject({
        workspace: WORKSPACE,
        home: HOME,
        pluginStatePath: STATE_PATH,
        appVersion: "0.1.7",
      });
      expect((capturedOptions as { reservedSkillNames: Set<string> }).reservedSkillNames.has("anycode-setup")).toBe(true);
      expect((capturedOptions as { mcpConsent: unknown[] }).mcpConsent).toEqual([]);
    } finally {
      vi.doUnmock(PLUGINS_PATH);
    }
  });
});
