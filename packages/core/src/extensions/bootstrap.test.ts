/**
 * discoverExtensions (design slice-3.3-cut.md §3.7, test matrix §5.2 item 9):
 * fail-soft subsystem isolation (a thrown plugin/skills/profiles discovery
 * leaves the other two contributing normally + records a problem), the
 * plugins-first internal order (plugin skillRoots/agentRoots feed the two
 * later discovery passes), root assembly (project > user precedence,
 * workspace===home single-load dedupe), claimedMcpNames threading (explicit
 * config always wins a plugin-server name collision), and the zero-cost empty
 * world.
 *
 * The three subsystem entry points (discoverPlugins/discoverSkills/
 * discoverAgentProfiles) are still task-3.3.2/3.3.3/3.3.4 STUBS at the time
 * this lane (3.3.5) is written and land concurrently — a stub ignores its `fs`
 * argument and always returns an empty, non-throwing result, so a "failing fs"
 * double alone cannot exercise the aggregator's fail-soft wrapping. Instead
 * these tests use `vi.doMock` (import-time module override, NOT hoisted) to
 * make one subsystem's entry point itself throw or return fixed fake data,
 * proving the AGGREGATOR's own contract — never-throw wrapping, ordering,
 * root construction, claimed-set forwarding, verbatim pass-through of
 * problems/profiles/pluginMcpServerSpecs — without depending on which lane's
 * real body has landed. Content that the OTHER lanes own (the exact prompt
 * text `buildSkillsPromptSection` produces for non-empty metas, `SkillPort
 * .load()`'s body) is deliberately NOT asserted here; only the frozen ""

 * aggregator's own load-bearing regression guarantee.
 *
 * The fifth subsystem — AGENTS.md memory (slice 3.6, design slice-3.6-cut.md
 * §2.5, task 3.6.4) — is implemented DIRECTLY in bootstrap.ts (no separate
 * discovery module, unlike the four above), so its tests near the bottom of
 * this file exercise the REAL discoverMemory logic end-to-end over the
 * hermetic in-memory `makeFs` FileSystemPort below, rather than vi.doMock-ing
 * a submodule.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileSystemPort } from "../ports/file-system.js";
import type { McpServerSpec } from "../ports/mcp.js";
import type { WorkflowDefinition } from "../ports/workflow.js";
import type { PersonaDefinition } from "../subagents/personas.js";
import { MEMORY_FILE_MAX_BYTES } from "../types/config.js";

const PLUGINS_PATH = "../plugins/discovery.js";
const SKILLS_PATH = "../skills/discovery.js";
const PROFILES_PATH = "../subagents/profiles.js";
const PROFILES_PROMPT_SECTION_PATH = "../subagents/profiles-prompt-section.js";
const WORKFLOW_DISCOVERY_PATH = "../workflow/discovery.js";
const WORKFLOW_PROMPT_SECTION_PATH = "../workflow/prompt-section.js";

function makeFs(files: Record<string, string> = {}): FileSystemPort {
  return {
    readFile: async (path) => {
      const content = files[path];
      if (content === undefined) {
        throw new Error(`ENOENT: ${path}`);
      }
      return content;
    },
    writeFile: async () => {},
    stat: async () => ({ size: 0, mtimeMs: 0, isFile: true, isDirectory: false }),
    exists: async (path) => path in files,
    mkdir: async () => {},
    readdir: async () => [],
  };
}

/** Fresh import of the module under test, honoring any vi.doMock calls made so far this test. */
async function importBootstrap(): Promise<typeof import("./bootstrap.js")> {
  return import("./bootstrap.js");
}

afterEach(() => {
  vi.doUnmock(PLUGINS_PATH);
  vi.doUnmock(SKILLS_PATH);
  vi.doUnmock(PROFILES_PATH);
  vi.doUnmock(PROFILES_PROMPT_SECTION_PATH);
  vi.doUnmock(WORKFLOW_DISCOVERY_PATH);
  vi.doUnmock(WORKFLOW_PROMPT_SECTION_PATH);
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// Empty world (real, unmocked subsystem entry points): zero cost, byte-
// identical to today's boot.

describe("discoverExtensions — empty world", () => {
  it("an empty tree yields an empty bootstrap: empty skill list, \"\" section, no profiles/specs/workflows/problems", async () => {
    const { discoverExtensions } = await importBootstrap();
    const bootstrap = await discoverExtensions(makeFs(), {
      workspace: "/proj",
      home: "/home/u",
    });

    expect(bootstrap.skills.list()).toEqual([]);
    expect(bootstrap.skillsPromptSection).toBe("");
    expect(bootstrap.profiles).toEqual([]);
    // Sixth field (slice 3.7, design §2.4): zero profiles discovered => "" —
    // the empty-world systemPrompt byte-invariant intact.
    expect(bootstrap.profilesPromptSection).toBe("");
    expect(bootstrap.pluginMcpServerSpecs).toEqual([]);
    // Fourth subsystem (design §2.9): zero workflows discovered => zero-cost,
    // byte-invariant section (real prompt-section.ts body lands with 3.4.3,
    // but the frozen "" contract on an empty metas list already holds today).
    expect(bootstrap.workflows).toEqual([]);
    expect(bootstrap.workflowsPromptSection).toBe("");
    // Fifth subsystem (slice 3.6, design §2.5): no AGENTS.md at either root =>
    // "" — the empty-world systemPrompt byte-invariant intact.
    expect(bootstrap.memorySection).toBe("");
    expect(bootstrap.repoMapFiles).toEqual([]);
    expect(bootstrap.problems).toEqual([]);
  });

  it("walks and enriches repository files only when explicitly enabled", async () => {
    const fs = makeFs({ "/proj/src/a.ts": "one\ntwo" });
    fs.readdir = async (path) => path === "/proj" ? ["src"] : path === "/proj/src" ? ["a.ts"] : [];
    fs.stat = async (path) => ({
      size: path.endsWith("a.ts") ? 7 : 0,
      mtimeMs: 10,
      isFile: path.endsWith("a.ts"),
      isDirectory: !path.endsWith("a.ts"),
    });
    const { discoverExtensions } = await importBootstrap();
    const bootstrap = await discoverExtensions(fs, {
      workspace: "/proj",
      home: "/home/u",
      repoMapConfig: { enabled: true },
    });
    expect(bootstrap.repoMapFiles).toEqual([
      { relativePath: "src/a.ts", size: 7, mtimeMs: 10, extension: ".ts", lines: 2 },
    ]);
  });
});

// ---------------------------------------------------------------------------

// nothing + a problem; the other two are unaffected.

describe("discoverExtensions — fail-soft subsystem isolation", () => {
  it("plugin discovery throwing leaves skills + profiles contributing normally", async () => {
    const fakeSkillMetas = [
      { name: "demo-skill", description: "demo", source: "project", path: "/proj/.anycode/skills/demo/SKILL.md" },
    ];
    const fakeProfiles: PersonaDefinition[] = [
      { name: "reviewer", description: "reviews", tools: ["Read"], systemPrompt: "review" },
    ];

    vi.doMock(PLUGINS_PATH, () => ({
      discoverPlugins: vi.fn(async () => {
        throw new Error("plugin boom");
      }),
    }));
    vi.doMock(SKILLS_PATH, async (importOriginal) => {
      const actual = await importOriginal<typeof import("../skills/discovery.js")>();
      return {
        ...actual,
        discoverSkills: vi.fn(async () => ({ metas: fakeSkillMetas, problems: [] })),
      };
    });
    vi.doMock(PROFILES_PATH, () => ({
      discoverAgentProfiles: vi.fn(async () => ({ profiles: fakeProfiles, problems: [] })),
    }));

    const { discoverExtensions } = await importBootstrap();
    const bootstrap = await discoverExtensions(makeFs(), { workspace: "/proj", home: "/home/u" });

    expect(bootstrap.problems).toEqual([expect.stringContaining("plugin discovery failed")]);
    expect(bootstrap.problems[0]).toContain("plugin boom");
    expect(bootstrap.skills.list()).toEqual(fakeSkillMetas);
    expect(bootstrap.profiles).toEqual(fakeProfiles);
    expect(bootstrap.pluginMcpServerSpecs).toEqual([]);
  });

  it("skills discovery throwing leaves plugin mcp specs + profiles contributing normally", async () => {
    const fakePluginSpecs: McpServerSpec[] = [
      { kind: "stdio", name: "plugin_demo_srv", command: "node", args: [], env: {} },
    ];
    const fakeProfiles: PersonaDefinition[] = [
      { name: "reviewer", description: "reviews", tools: ["Read"], systemPrompt: "review" },
    ];

    vi.doMock(PLUGINS_PATH, () => ({
      discoverPlugins: vi.fn(async () => ({
        skillRoots: [],
        agentRoots: [],
        mcpServerSpecs: fakePluginSpecs,
        problems: [],
      })),
    }));
    vi.doMock(SKILLS_PATH, async (importOriginal) => {
      const actual = await importOriginal<typeof import("../skills/discovery.js")>();
      return {
        ...actual,
        discoverSkills: vi.fn(async () => {
          throw new Error("skills boom");
        }),
      };
    });
    vi.doMock(PROFILES_PATH, () => ({
      discoverAgentProfiles: vi.fn(async () => ({ profiles: fakeProfiles, problems: [] })),
    }));

    const { discoverExtensions } = await importBootstrap();
    const bootstrap = await discoverExtensions(makeFs(), { workspace: "/proj", home: "/home/u" });

    expect(bootstrap.problems).toEqual([expect.stringContaining("skills discovery failed")]);
    expect(bootstrap.problems[0]).toContain("skills boom");
    expect(bootstrap.pluginMcpServerSpecs).toEqual(fakePluginSpecs);
    expect(bootstrap.profiles).toEqual(fakeProfiles);
    // Skills discovery failed => zero skills, but the port must still exist (fail-closed shape).
    expect(bootstrap.skills.list()).toEqual([]);
    expect(bootstrap.skillsPromptSection).toBe("");
  });

  it("agent-profile discovery throwing leaves skills + plugin mcp specs contributing normally", async () => {
    const fakeSkillMetas = [
      { name: "demo-skill", description: "demo", source: "project", path: "/proj/.anycode/skills/demo/SKILL.md" },
    ];
    const fakePluginSpecs: McpServerSpec[] = [
      { kind: "stdio", name: "plugin_demo_srv", command: "node", args: [], env: {} },
    ];

    vi.doMock(PLUGINS_PATH, () => ({
      discoverPlugins: vi.fn(async () => ({
        skillRoots: [],
        agentRoots: [],
        mcpServerSpecs: fakePluginSpecs,
        problems: [],
      })),
    }));
    vi.doMock(SKILLS_PATH, async (importOriginal) => {
      const actual = await importOriginal<typeof import("../skills/discovery.js")>();
      return {
        ...actual,
        discoverSkills: vi.fn(async () => ({ metas: fakeSkillMetas, problems: [] })),
      };
    });
    vi.doMock(PROFILES_PATH, () => ({
      discoverAgentProfiles: vi.fn(async () => {
        throw new Error("profiles boom");
      }),
    }));

    const { discoverExtensions } = await importBootstrap();
    const bootstrap = await discoverExtensions(makeFs(), { workspace: "/proj", home: "/home/u" });

    expect(bootstrap.problems).toEqual([expect.stringContaining("agent profile discovery failed")]);
    expect(bootstrap.problems[0]).toContain("profiles boom");
    expect(bootstrap.skills.list()).toEqual(fakeSkillMetas);
    expect(bootstrap.pluginMcpServerSpecs).toEqual(fakePluginSpecs);
    expect(bootstrap.profiles).toEqual([]);
    // Sixth field (slice 3.7): zero profiles => "" — fail-soft shape symmetric
    // with skillsPromptSection/workflowsPromptSection above.
    expect(bootstrap.profilesPromptSection).toBe("");
  });

  it("never throws even when all three subsystems throw at once — an empty-contribution bootstrap with three problems", async () => {
    vi.doMock(PLUGINS_PATH, () => ({
      discoverPlugins: vi.fn(async () => {
        throw new Error("plugin boom");
      }),
    }));
    vi.doMock(SKILLS_PATH, async (importOriginal) => {
      const actual = await importOriginal<typeof import("../skills/discovery.js")>();
      return {
        ...actual,
        discoverSkills: vi.fn(async () => {
          throw new Error("skills boom");
        }),
      };
    });
    vi.doMock(PROFILES_PATH, () => ({
      discoverAgentProfiles: vi.fn(async () => {
        throw new Error("profiles boom");
      }),
    }));

    const { discoverExtensions } = await importBootstrap();
    await expect(
      discoverExtensions(makeFs(), { workspace: "/proj", home: "/home/u" }),
    ).resolves.toEqual({
      skills: expect.objectContaining({}),
      skillsPromptSection: "",
      profiles: [],
      profilesPromptSection: "",
      pluginMcpServerSpecs: [],
      workflows: [],
      workflowsPromptSection: "",
      memorySection: "",
      repoMapFiles: [],
      problems: [
        expect.stringContaining("plugin discovery failed"),
        expect.stringContaining("skills discovery failed"),
        expect.stringContaining("agent profile discovery failed"),
      ],
    });
  });
});

// ---------------------------------------------------------------------------
// Internal order + root assembly (§3.7: "plugins first, THEN skills+profiles
// discovery over [built-in roots ++ plugin roots]").

describe("discoverExtensions — plugins-first order and root assembly", () => {
  it("runs plugin discovery before skills/profiles discovery, and appends plugin roots after the built-in roots", async () => {
    const calls: string[] = [];
    const pluginSkillRoot = { dir: "/proj/.anycode/plugins/demo/skills", source: "plugin:demo" };
    const pluginAgentRoot = { dir: "/proj/.anycode/plugins/demo/agents", source: "plugin:demo" };

    let capturedSkillRoots: unknown;
    let capturedAgentRoots: unknown;

    vi.doMock(PLUGINS_PATH, () => ({
      discoverPlugins: vi.fn(async () => {
        calls.push("plugins");
        return {
          skillRoots: [pluginSkillRoot],
          agentRoots: [pluginAgentRoot],
          mcpServerSpecs: [],
          problems: [],
        };
      }),
    }));
    vi.doMock(SKILLS_PATH, async (importOriginal) => {
      const actual = await importOriginal<typeof import("../skills/discovery.js")>();
      return {
        ...actual,
        discoverSkills: vi.fn(async (_fs: unknown, roots: unknown) => {
          calls.push("skills");
          capturedSkillRoots = roots;
          return { metas: [], problems: [] };
        }),
      };
    });
    vi.doMock(PROFILES_PATH, () => ({
      discoverAgentProfiles: vi.fn(async (_fs: unknown, roots: unknown) => {
        calls.push("profiles");
        capturedAgentRoots = roots;
        return { profiles: [], problems: [] };
      }),
    }));

    const { discoverExtensions } = await importBootstrap();
    await discoverExtensions(makeFs(), { workspace: "/proj", home: "/home/u" });

    expect(calls[0]).toBe("plugins");
    expect(calls).toContain("skills");
    expect(calls).toContain("profiles");

    expect(capturedSkillRoots).toEqual([
      { dir: "/proj/.anycode/skills", source: "project" },
      { dir: "/proj/.agents/skills", source: "project" },
      { dir: "/home/u/.anycode/skills", source: "user" },
      { dir: "/home/u/.agents/skills", source: "user" },
      pluginSkillRoot,
    ]);
    expect(capturedAgentRoots).toEqual([
      { dir: "/proj/.anycode/agents", source: "project" },
      { dir: "/home/u/.anycode/agents", source: "user" },
      pluginAgentRoot,
    ]);
  });

  it("workspace === home: loads the shared pair once (no duplicate user roots)", async () => {
    let capturedSkillRoots: unknown;
    let capturedAgentRoots: unknown;

    vi.doMock(PLUGINS_PATH, () => ({
      discoverPlugins: vi.fn(async () => ({ skillRoots: [], agentRoots: [], mcpServerSpecs: [], problems: [] })),
    }));
    vi.doMock(SKILLS_PATH, async (importOriginal) => {
      const actual = await importOriginal<typeof import("../skills/discovery.js")>();
      return {
        ...actual,
        discoverSkills: vi.fn(async (_fs: unknown, roots: unknown) => {
          capturedSkillRoots = roots;
          return { metas: [], problems: [] };
        }),
      };
    });
    vi.doMock(PROFILES_PATH, () => ({
      discoverAgentProfiles: vi.fn(async (_fs: unknown, roots: unknown) => {
        capturedAgentRoots = roots;
        return { profiles: [], problems: [] };
      }),
    }));

    const { discoverExtensions } = await importBootstrap();
    await discoverExtensions(makeFs(), { workspace: "/same", home: "/same" });

    expect(capturedSkillRoots).toEqual([
      { dir: "/same/.anycode/skills", source: "project" },
      { dir: "/same/.agents/skills", source: "project" },
    ]);
    expect(capturedAgentRoots).toEqual([{ dir: "/same/.anycode/agents", source: "project" }]);
  });
});

// ---------------------------------------------------------------------------
// Agent-profiles prompt section (design slice-3.7-cut.md §2.4, task 3.7.2):
// the sixth field, filled from the SAME profiles[] the block above already
// discovered — no new discovery pass, just a prompt-section projection.

describe("discoverExtensions — agent-profiles prompt section wiring (design slice-3.7-cut.md §2.4)", () => {
  it("forwards the discovered profiles verbatim to buildProfilesPromptSection and returns its result", async () => {
    const fakeProfiles: PersonaDefinition[] = [
      { name: "librarian", description: "curates docs", tools: ["Read"], systemPrompt: "curate" },
    ];
    const sentinelSection = "\n[profiles section placeholder]\n- librarian: curates docs\n";

    vi.doMock(PROFILES_PATH, () => ({
      discoverAgentProfiles: vi.fn(async () => ({ profiles: fakeProfiles, problems: [] })),
    }));
    let capturedProfiles: unknown;
    vi.doMock(PROFILES_PROMPT_SECTION_PATH, () => ({
      buildProfilesPromptSection: vi.fn((profiles: unknown) => {
        capturedProfiles = profiles;
        return sentinelSection;
      }),
    }));

    const { discoverExtensions } = await importBootstrap();
    const bootstrap = await discoverExtensions(makeFs(), { workspace: "/proj", home: "/home/u" });

    expect(bootstrap.profiles).toEqual(fakeProfiles);
    expect(bootstrap.profilesPromptSection).toBe(sentinelSection);
    expect(capturedProfiles).toEqual(fakeProfiles);
  });

  it("real buildProfilesPromptSection: discovered profiles yield a non-\"\" section; a discovery failure yields \"\" (fail-soft symmetry)", async () => {
    const fakeProfiles: PersonaDefinition[] = [
      { name: "reviewer", description: "reviews code", tools: ["Read"], systemPrompt: "review" },
    ];
    vi.doMock(PROFILES_PATH, () => ({
      discoverAgentProfiles: vi.fn(async () => ({ profiles: fakeProfiles, problems: [] })),
    }));

    const { discoverExtensions } = await importBootstrap();
    const bootstrap = await discoverExtensions(makeFs(), { workspace: "/proj", home: "/home/u" });

    expect(bootstrap.profilesPromptSection).not.toBe("");
    expect(bootstrap.profilesPromptSection).toContain("reviewer");
  });
});

// ---------------------------------------------------------------------------
// Workflow subsystem (design §2.9, slice 3.4.4): the fourth fail-soft block.
// discoverWorkflows/buildWorkflowsPromptSection are still 3.4.3 STUBS at the
// time this lane is written (discoverWorkflows always resolves to `{
// workflows: [], problems: [] }`; buildWorkflowsPromptSection always returns
// ""), so — mirroring the plugins/skills/profiles tests above — these use
// vi.doMock to prove the AGGREGATOR's own contract (fail-soft wrapping, root
// assembly, verbatim pass-through of definitions, metas projection forwarded
// to the prompt-section builder) without depending on which lane's real body
// has landed.

describe("discoverExtensions — workflow subsystem", () => {
  it("workflow discovery throwing leaves plugins/skills/profiles contributing normally", async () => {
    const fakeSkillMetas = [
      { name: "demo-skill", description: "demo", source: "project", path: "/proj/.anycode/skills/demo/SKILL.md" },
    ];
    const fakeProfiles: PersonaDefinition[] = [
      { name: "reviewer", description: "reviews", tools: ["Read"], systemPrompt: "review" },
    ];
    const fakePluginSpecs: McpServerSpec[] = [
      { kind: "stdio", name: "plugin_demo_srv", command: "node", args: [], env: {} },
    ];

    vi.doMock(PLUGINS_PATH, () => ({
      discoverPlugins: vi.fn(async () => ({
        skillRoots: [],
        agentRoots: [],
        mcpServerSpecs: fakePluginSpecs,
        problems: [],
      })),
    }));
    vi.doMock(SKILLS_PATH, async (importOriginal) => {
      const actual = await importOriginal<typeof import("../skills/discovery.js")>();
      return {
        ...actual,
        discoverSkills: vi.fn(async () => ({ metas: fakeSkillMetas, problems: [] })),
      };
    });
    vi.doMock(PROFILES_PATH, () => ({
      discoverAgentProfiles: vi.fn(async () => ({ profiles: fakeProfiles, problems: [] })),
    }));
    vi.doMock(WORKFLOW_DISCOVERY_PATH, () => ({
      discoverWorkflows: vi.fn(async () => {
        throw new Error("workflow boom");
      }),
    }));

    const { discoverExtensions } = await importBootstrap();
    const bootstrap = await discoverExtensions(makeFs(), { workspace: "/proj", home: "/home/u" });

    expect(bootstrap.problems).toEqual([expect.stringContaining("workflow discovery failed")]);
    expect(bootstrap.problems[0]).toContain("workflow boom");
    expect(bootstrap.skills.list()).toEqual(fakeSkillMetas);
    expect(bootstrap.profiles).toEqual(fakeProfiles);
    expect(bootstrap.pluginMcpServerSpecs).toEqual(fakePluginSpecs);
    // Workflow discovery failed => zero workflows, but the "" section invariant
    // (fail-closed shape) must still hold.
    expect(bootstrap.workflows).toEqual([]);
    expect(bootstrap.workflowsPromptSection).toBe("");
  });

  it("passes discovered workflow definitions through verbatim and forwards their metas projection to buildWorkflowsPromptSection", async () => {
    const fakeWorkflows: WorkflowDefinition[] = [
      {
        name: "release-notes",
        description: "drafts release notes",
        steps: [
          { id: "gather", agentType: "explore", promptTemplate: "gather changes" },
          {
            id: "write",
            agentType: "general-purpose",
            promptTemplate: "write notes from ${steps.gather}",
            dependsOn: ["gather"],
          },
        ],
        source: "project",
        path: "/proj/.anycode/workflows/release-notes.json",
      },
    ];
    const sentinelSection = "\n[workflows section placeholder]\n- release-notes (project, 2 steps): drafts release notes\n";

    vi.doMock(WORKFLOW_DISCOVERY_PATH, () => ({
      discoverWorkflows: vi.fn(async () => ({ workflows: fakeWorkflows, problems: [] })),
    }));
    let capturedMetas: unknown;
    vi.doMock(WORKFLOW_PROMPT_SECTION_PATH, () => ({
      buildWorkflowsPromptSection: vi.fn((metas: unknown) => {
        capturedMetas = metas;
        return sentinelSection;
      }),
    }));

    const { discoverExtensions } = await importBootstrap();
    const bootstrap = await discoverExtensions(makeFs(), { workspace: "/proj", home: "/home/u" });

    expect(bootstrap.workflows).toEqual(fakeWorkflows);
    expect(bootstrap.workflowsPromptSection).toBe(sentinelSection);
    expect(capturedMetas).toEqual([
      { name: "release-notes", description: "drafts release notes", stepCount: 2, source: "project" },
    ]);
  });

  it("scans project > user workflow roots — no plugin roots (design §8-R8)", async () => {
    let capturedRoots: unknown;
    vi.doMock(WORKFLOW_DISCOVERY_PATH, () => ({
      discoverWorkflows: vi.fn(async (_fs: unknown, roots: unknown) => {
        capturedRoots = roots;
        return { workflows: [], problems: [] };
      }),
    }));

    const { discoverExtensions } = await importBootstrap();
    await discoverExtensions(makeFs(), { workspace: "/proj", home: "/home/u" });

    expect(capturedRoots).toEqual([
      { dir: "/proj/.anycode/workflows", source: "project" },
      { dir: "/home/u/.anycode/workflows", source: "user" },
    ]);
  });

  it("workspace === home: loads the workflow root once (no duplicate user root)", async () => {
    let capturedRoots: unknown;
    vi.doMock(WORKFLOW_DISCOVERY_PATH, () => ({
      discoverWorkflows: vi.fn(async (_fs: unknown, roots: unknown) => {
        capturedRoots = roots;
        return { workflows: [], problems: [] };
      }),
    }));

    const { discoverExtensions } = await importBootstrap();
    await discoverExtensions(makeFs(), { workspace: "/same", home: "/same" });

    expect(capturedRoots).toEqual([{ dir: "/same/.anycode/workflows", source: "project" }]);
  });
});

// ---------------------------------------------------------------------------
// claimedMcpNames threading (§3.7: explicit config always wins over plugins).

describe("discoverExtensions — claimedMcpNames threading", () => {
  it("passes a fresh empty Set to plugin discovery when claimedMcpNames is omitted", async () => {
    let captured: Set<string> | undefined;
    vi.doMock(PLUGINS_PATH, () => ({
      discoverPlugins: vi.fn(async (_fs: unknown, opts: { claimedMcpNames: Set<string> }) => {
        captured = opts.claimedMcpNames;
        return { skillRoots: [], agentRoots: [], mcpServerSpecs: [], problems: [] };
      }),
    }));

    const { discoverExtensions } = await importBootstrap();
    await discoverExtensions(makeFs(), { workspace: "/proj", home: "/home/u" });

    expect(captured).toBeInstanceOf(Set);
    expect(captured?.size).toBe(0);
  });

  it("forwards the caller's claimedMcpNames set through unchanged, so an explicit-config name is already claimed before plugins run", async () => {
    let captured: Set<string> | undefined;
    vi.doMock(PLUGINS_PATH, () => ({
      discoverPlugins: vi.fn(async (_fs: unknown, opts: { claimedMcpNames: Set<string> }) => {
        captured = opts.claimedMcpNames;
        return { skillRoots: [], agentRoots: [], mcpServerSpecs: [], problems: [] };
      }),
    }));

    const { discoverExtensions } = await importBootstrap();
    const claimed = new Set(["explicit-server"]);
    await discoverExtensions(makeFs(), { workspace: "/proj", home: "/home/u", claimedMcpNames: claimed });

    expect(captured).toBe(claimed);
    expect(captured?.has("explicit-server")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Aggregated problems ordering + verbatim pass-through (contribution shapes).

describe("discoverExtensions — contribution shapes", () => {
  it("aggregates problems in plugins -> skills -> profiles order and passes profiles/specs through verbatim", async () => {
    const fakeProfiles: PersonaDefinition[] = [
      { name: "reviewer", description: "reviews", tools: ["Read"], systemPrompt: "review" },
    ];
    const fakeSpecs: McpServerSpec[] = [
      { kind: "stdio", name: "plugin_demo_srv", command: "node", args: [], env: {} },
    ];

    vi.doMock(PLUGINS_PATH, () => ({
      discoverPlugins: vi.fn(async () => ({
        skillRoots: [],
        agentRoots: [],
        mcpServerSpecs: fakeSpecs,
        problems: ["plugin problem"],
      })),
    }));
    vi.doMock(SKILLS_PATH, async (importOriginal) => {
      const actual = await importOriginal<typeof import("../skills/discovery.js")>();
      return {
        ...actual,
        discoverSkills: vi.fn(async () => ({ metas: [], problems: ["skills problem"] })),
      };
    });
    vi.doMock(PROFILES_PATH, () => ({
      discoverAgentProfiles: vi.fn(async () => ({ profiles: fakeProfiles, problems: ["profiles problem"] })),
    }));

    const { discoverExtensions } = await importBootstrap();
    const bootstrap = await discoverExtensions(makeFs(), { workspace: "/proj", home: "/home/u" });

    expect(bootstrap.problems).toEqual(["plugin problem", "skills problem", "profiles problem"]);
    expect(bootstrap.profiles).toEqual(fakeProfiles);
    expect(bootstrap.pluginMcpServerSpecs).toEqual(fakeSpecs);
  });

  it("aggregates problems in plugins -> skills -> profiles -> workflows order (fourth subsystem lands last)", async () => {
    vi.doMock(PLUGINS_PATH, () => ({
      discoverPlugins: vi.fn(async () => ({
        skillRoots: [],
        agentRoots: [],
        mcpServerSpecs: [],
        problems: ["plugin problem"],
      })),
    }));
    vi.doMock(SKILLS_PATH, async (importOriginal) => {
      const actual = await importOriginal<typeof import("../skills/discovery.js")>();
      return {
        ...actual,
        discoverSkills: vi.fn(async () => ({ metas: [], problems: ["skills problem"] })),
      };
    });
    vi.doMock(PROFILES_PATH, () => ({
      discoverAgentProfiles: vi.fn(async () => ({ profiles: [], problems: ["profiles problem"] })),
    }));
    vi.doMock(WORKFLOW_DISCOVERY_PATH, () => ({
      discoverWorkflows: vi.fn(async () => ({ workflows: [], problems: ["workflow problem"] })),
    }));

    const { discoverExtensions } = await importBootstrap();
    const bootstrap = await discoverExtensions(makeFs(), { workspace: "/proj", home: "/home/u" });

    expect(bootstrap.problems).toEqual([
      "plugin problem",
      "skills problem",
      "profiles problem",
      "workflow problem",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Memory subsystem (fifth, design slice-3.6-cut.md §2.5, task 3.6.4): AGENTS.md
// discovery through FileSystemPort only — `~/.anycode/AGENTS.md` (user) then
// `<ws>/AGENTS.md` (project). Real end-to-end tests over the hermetic makeFs()
// double above (zero real disk, zero node:fs) since this subsystem's body
// lives directly in bootstrap.ts, not a separately-mockable module.

describe("discoverExtensions — memory subsystem (AGENTS.md, design slice-3.6-cut.md §2.5)", () => {
  it("zero AGENTS.md files anywhere => \"\" (systemPrompt byte-invariant, re-proved directly on this subsystem)", async () => {
    const { discoverExtensions } = await importBootstrap();
    const bootstrap = await discoverExtensions(makeFs(), { workspace: "/proj", home: "/home/u" });

    expect(bootstrap.memorySection).toBe("");
    expect(bootstrap.problems).toEqual([]);
  });

  it("only the user AGENTS.md exists: memorySection carries just that file, headed \"AGENTS.md (user)\"", async () => {
    const { discoverExtensions } = await importBootstrap();
    const bootstrap = await discoverExtensions(
      makeFs({ "/home/u/AGENTS.md": "Prefer short commit messages.\n" }),
      { workspace: "/proj", home: "/home/u" },
    );

    expect(bootstrap.memorySection).toBe("AGENTS.md (user):\nPrefer short commit messages.\n");
    expect(bootstrap.problems).toEqual([]);
  });

  it("only the project AGENTS.md exists: memorySection carries just that file, headed \"AGENTS.md (project)\"", async () => {
    const { discoverExtensions } = await importBootstrap();
    const bootstrap = await discoverExtensions(
      makeFs({ "/proj/AGENTS.md": "Run the linter before finishing.\n" }),
      { workspace: "/proj", home: "/home/u" },
    );

    expect(bootstrap.memorySection).toBe("AGENTS.md (project):\nRun the linter before finishing.\n");
    expect(bootstrap.problems).toEqual([]);
  });

  it("both files present: user THEN project (project sits closer to the tail — more specific)", async () => {
    const { discoverExtensions } = await importBootstrap();
    const bootstrap = await discoverExtensions(
      makeFs({
        "/home/u/AGENTS.md": "User-wide convention.\n",
        "/proj/AGENTS.md": "Project-specific convention.\n",
      }),
      { workspace: "/proj", home: "/home/u" },
    );

    expect(bootstrap.memorySection).toBe(
      "AGENTS.md (user):\nUser-wide convention.\n\n\nAGENTS.md (project):\nProject-specific convention.\n",
    );
    const userIndex = bootstrap.memorySection.indexOf("AGENTS.md (user)");
    const projectIndex = bootstrap.memorySection.indexOf("AGENTS.md (project)");
    expect(userIndex).toBeGreaterThanOrEqual(0);
    expect(projectIndex).toBeGreaterThan(userIndex);
    expect(bootstrap.problems).toEqual([]);
  });

  it("workspace === home: reads the shared AGENTS.md ONCE, labeled \"project\" (not duplicated as \"user\")", async () => {
    const { discoverExtensions } = await importBootstrap();
    const bootstrap = await discoverExtensions(
      makeFs({ "/same/AGENTS.md": "Shared convention.\n" }),
      { workspace: "/same", home: "/same" },
    );

    expect(bootstrap.memorySection).toBe("AGENTS.md (project):\nShared convention.\n");
    expect(bootstrap.memorySection).not.toContain("(user)");
    expect(bootstrap.problems).toEqual([]);
  });

  it("caps an oversized AGENTS.md at MEMORY_FILE_MAX_BYTES and records a truncation problem", async () => {
    const { discoverExtensions } = await importBootstrap();
    const oversized = "a".repeat(MEMORY_FILE_MAX_BYTES + 1_000);
    const bootstrap = await discoverExtensions(makeFs({ "/proj/AGENTS.md": oversized }), {
      workspace: "/proj",
      home: "/home/u",
    });

    const header = "AGENTS.md (project):\n";
    const encoder = new TextEncoder();
    expect(bootstrap.memorySection.startsWith(header)).toBe(true);
    expect(encoder.encode(bootstrap.memorySection).length).toBeLessThanOrEqual(
      MEMORY_FILE_MAX_BYTES + encoder.encode(header).length,
    );
    expect(bootstrap.problems).toEqual([expect.stringContaining("/proj/AGENTS.md exceeded")]);
    expect(bootstrap.problems[0]).toContain(`${MEMORY_FILE_MAX_BYTES} bytes`);
  });

  it("a readFile failure is fail-soft: a problem is recorded, memorySection excludes the broken file, the other file is unaffected", async () => {
    const { discoverExtensions } = await importBootstrap();
    const files: Record<string, string> = {
      "/home/u/AGENTS.md": "unreadable placeholder",
      "/proj/AGENTS.md": "Project convention survives.\n",
    };
    const fs = makeFs(files);
    const brokenFs: FileSystemPort = {
      ...fs,
      readFile: async (path) => {
        if (path === "/home/u/AGENTS.md") {
          throw new Error("EACCES: permission denied");
        }
        return fs.readFile(path);
      },
    };

    const bootstrap = await discoverExtensions(brokenFs, { workspace: "/proj", home: "/home/u" });

    expect(bootstrap.memorySection).toBe("AGENTS.md (project):\nProject convention survives.\n");
    expect(bootstrap.problems).toEqual([expect.stringContaining("could not read /home/u/AGENTS.md")]);
    expect(bootstrap.problems[0]).toContain("EACCES");
  });

  it("an fs.exists that throws is fail-soft at the aggregator level: an empty memorySection + a problem, other subsystems unaffected", async () => {
    const fakeSkillMetas = [
      { name: "demo-skill", description: "demo", source: "project", path: "/proj/.anycode/skills/demo/SKILL.md" },
    ];
    vi.doMock(SKILLS_PATH, async (importOriginal) => {
      const actual = await importOriginal<typeof import("../skills/discovery.js")>();
      return {
        ...actual,
        discoverSkills: vi.fn(async () => ({ metas: fakeSkillMetas, problems: [] })),
      };
    });

    const fs = makeFs();
    const brokenExistsFs: FileSystemPort = {
      ...fs,
      exists: async (path) => {
        if (path.endsWith("AGENTS.md")) {
          throw new Error("simulated exists() failure");
        }
        return fs.exists(path);
      },
    };

    const { discoverExtensions } = await importBootstrap();
    const bootstrap = await discoverExtensions(brokenExistsFs, { workspace: "/proj", home: "/home/u" });

    expect(bootstrap.memorySection).toBe("");
    expect(bootstrap.problems).toEqual([expect.stringContaining("memory discovery failed")]);
    expect(bootstrap.problems[0]).toContain("simulated exists() failure");
    // Skills discovery (mocked above) still contributed normally — one
    // subsystem's failure never takes the others down.
    expect(bootstrap.skills.list()).toEqual(fakeSkillMetas);
  });
});
