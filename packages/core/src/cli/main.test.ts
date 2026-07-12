/**

 * parser coverage for /allow, plus a full runCli() drive with a fake
 * ModelPort + in-memory streams proving /compact and unknown slash lines
 * never reach the model while a normal line still does.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { release, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  KNOWN_SLASH_COMMANDS,
  parseAllowCommand,
  renderEvent,
  renderMcpStatusTable,
  renderSkillsTable,
  renderWorkflowsTable,
  runCli,
} from "./main.js";
import { NodeFileSystemAdapter } from "../adapters/node/index.js";
import { SqlitePersistenceAdapter } from "../adapters/node/sqlite-persistence.js";
import { deriveSessionTitle, sanitizeTitleSource } from "../context/session-title.js";
import type { ExtensionsBootstrap } from "../extensions/bootstrap.js";
import { McpManager } from "../mcp/index.js";
import type { ModelPort, ModelRequest } from "../ports/index.js";
import type { McpServerStatus, McpTransportFactory, McpWireTransport } from "../ports/mcp.js";
import type { SkillMeta } from "../ports/skills.js";
import type { WorkflowDefinition, WorkflowMeta } from "../ports/workflow.js";
import { buildSystemPrompt, type SystemPromptEnv } from "../prompts/identity.js";
import type { PersonaDefinition } from "../subagents/personas.js";
import { backgroundCapableBashTool, bashKillTool, bashOutputTool, createDefaultToolRegistry } from "../tools/index.js";
import { exitPlanModeTool } from "../tools/exit-plan-mode.js";
import type { AgentEvent, ModelStreamEvent } from "../types/events.js";
import type { ImageAttachment } from "../types/images.js";

describe("parseAllowCommand", () => {
  it("treats empty/whitespace-only text as a listing request", () => {
    expect(parseAllowCommand("")).toEqual({ kind: "list" });
    expect(parseAllowCommand("   ")).toEqual({ kind: "list" });
  });

  it("parses a bare tool name into a pattern-less rule", () => {
    expect(parseAllowCommand("Bash")).toEqual({ kind: "add", rule: { toolName: "Bash" } });
  });

  it("parses a tool name + unquoted multi-word pattern (rest of the line)", () => {
    expect(parseAllowCommand("Bash git *")).toEqual({
      kind: "add",
      rule: { toolName: "Bash", pattern: "git *" },
    });
  });

  it("strips matching double or single quotes around the pattern", () => {
    expect(parseAllowCommand('Bash "git *"')).toEqual({
      kind: "add",
      rule: { toolName: "Bash", pattern: "git *" },
    });
    expect(parseAllowCommand("WebFetch 'https://example.com/**'")).toEqual({
      kind: "add",
      rule: { toolName: "WebFetch", pattern: "https://example.com/**" },
    });
  });

  it("is invalid when the tool name is itself a quoted-empty string", () => {
    expect(parseAllowCommand('""')).toEqual({ kind: "invalid" });
  });
});

/** Records call count; every call finishes immediately with no tool calls. */
class CountingModelPort implements ModelPort {
  calls = 0;

  streamText(_request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.calls += 1;
    return (async function* () {
      yield { type: "finish", finishReason: "stop", usage: {} } as ModelStreamEvent;
    })();
  }
}

/** Like CountingModelPort, but also records every request's `system` field (systemPrompt). */
class RecordingModelPort implements ModelPort {
  requests: ModelRequest[] = [];

  streamText(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    return (async function* () {
      yield { type: "finish", finishReason: "stop", usage: {} } as ModelStreamEvent;
    })();
  }
}

/** Replays one fixed event script per call index, falling back to an immediate stop. */
class SequencedModelPort implements ModelPort {
  private call = 0;
  constructor(private readonly scripts: ModelStreamEvent[][]) {}

  streamText(_request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const events = this.scripts[this.call] ?? [
      { type: "finish", finishReason: "stop", usage: {} } as ModelStreamEvent,
    ];
    this.call += 1;
    return (async function* () {
      for (const event of events) {
        yield event;
      }
    })();
  }
}

function collectOutput(output: PassThrough): () => string {
  let text = "";
  output.on("data", (chunk: Buffer) => {
    text += chunk.toString("utf8");
  });
  return () => text;
}

const literalEnvSettingsDirs: string[] = [];

/**
 * Fresh throwaway `settings.json` path for a runCli() call whose `env` is a
 * `:memory:`-DB literal (no dbPath/tmpdir of its own to piggyback on) so it
 * never falls through to `defaultSettingsFilePath()` and reads/writes the
 * owner's real `~/.anycode/settings.json` (design slice-P7.5-cut.md, test
 * isolation fix — mirrors the `/allow`-test settingsFilePath idiom above and
 * makeTitleTestEnv's dbPath-sibling idiom below).
 */
function isolatedSettingsPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "anycode-cli-literal-env-settings-"));
  literalEnvSettingsDirs.push(dir);
  return join(dir, "settings.json");
}

afterEach(() => {
  while (literalEnvSettingsDirs.length > 0) {
    const dir = literalEnvSettingsDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("CLI slash dispatcher (design slice-2.3-cut.md, tail 3) — fake ModelPort", () => {
  it("/compact and an unknown slash never reach the model; /allow parses/lists correctly", async () => {
    const modelPort = new CountingModelPort();
    const input = new PassThrough();
    const output = new PassThrough();
    const getText = collectOutput(output);
    // /allow add drives PersistingSessionPermissionRules, which fire-and-forget
    // persists to settingsFilePath — an isolated tmp path so this test never
    // touches the owner's real ~/.anycode/settings.json (design slice-P7.5-cut.md).
    const settingsDir = mkdtempSync(join(tmpdir(), "anycode-allow-test-"));
    const settingsFilePath = join(settingsDir, "settings.json");

    const runPromise = runCli({
      argv: [],
      env: {
        ANYCODE_API_KEY: "test-key",
        ANYCODE_MODEL: "test-model",
        ANYCODE_DB_PATH: ":memory:",
      ANYCODE_SETTINGS_PATH: isolatedSettingsPath(),
      } as NodeJS.ProcessEnv,
      input,
      output,
      modelPort,
      cwd: process.cwd(),
      settingsFilePath,
    });

    input.write("/compact\n");
    input.write("/nonsense\n");
    input.write("/allow\n");
    input.write('/allow Bash "git *"\n');
    input.write("/allow\n");
    input.end();

    const exitCode = await runPromise;
    expect(exitCode).toBe(0);

    const text = getText();
    expect(text).toContain("[unknown command: /nonsense]");
    expect(text).toContain("[allow] no rules for this session");
    expect(text).toContain("[allow] added rule: Bash git *");
    expect(text).toContain("[allow] Bash git *");
    // Empty history => empty compaction prefix (structural no-op) — the model
    // must never be called by /compact here, proving it never runs a turn.
    expect(modelPort.calls).toBe(0);

    rmSync(settingsDir, { recursive: true, force: true });
  });

  it("a normal (non-slash) line still drives a real turn through the model", async () => {
    const modelPort = new CountingModelPort();
    const input = new PassThrough();
    const output = new PassThrough();

    const runPromise = runCli({
      argv: [],
      env: {
        ANYCODE_API_KEY: "test-key",
        ANYCODE_MODEL: "test-model",
        ANYCODE_DB_PATH: ":memory:",
      ANYCODE_SETTINGS_PATH: isolatedSettingsPath(),
      } as NodeJS.ProcessEnv,
      input,
      output,
      modelPort,
      cwd: process.cwd(),
    });

    input.write("hello there\n");
    input.end();

    await runPromise;
    expect(modelPort.calls).toBe(1);
  });
});

describe("KNOWN_SLASH_COMMANDS (slice 4.1 §2.4, extended slice 4.2 §2.6, slice 4.3 §2.6, slice 4.4 §2.3, slice 4.6 §2.3, slice 4.7 §2.8, slice 5.4 §2.5, slice 5.6 wave C, slice 5.5 wave C, slice 6.1 wave D, slice 6.2 wave D, slice 6.4 wave C, slice 6.6 wave C)", () => {
  it("is the frozen 23-command set, now including /repo-map", () => {
    expect(KNOWN_SLASH_COMMANDS).toEqual([
      "/compact",
      "/allow",
      "/mcp",
      "/skills",
      "/workflows",
      "/sessions",
      "/rewind",
      "/reasoning",
      "/mode",
      "/model",
      "/status",
      "/diff",
      "/commit",
      "/hooks",
      "/tasks",
      "/lsp",
      "/image",
      "/context",
      "/telemetry",
      "/repo-map",
      "/help",
      "/quit",
      "/exit",
    ]);
  });

  it("/help lists commands and /quit exits the REPL through the normal path (no input.end)", async () => {
    const modelPort = new CountingModelPort();
    const input = new PassThrough();
    const output = new PassThrough();
    const getText = collectOutput(output);

    const runPromise = runCli({
      argv: [],
      env: {
        ANYCODE_API_KEY: "test-key",
        ANYCODE_MODEL: "test-model",
        ANYCODE_DB_PATH: ":memory:",
      ANYCODE_SETTINGS_PATH: isolatedSettingsPath(),
      } as NodeJS.ProcessEnv,
      input,
      output,
      modelPort,
      cwd: process.cwd(),
    });

    input.write("/help\n");
    // /quit must terminate the REPL on its own — the run resolves WITHOUT input.end().
    input.write("/quit\n");

    const exitCode = await runPromise;
    expect(exitCode).toBe(0);

    const text = getText();
    expect(text).toContain("/help");
    // Neither slash command ever reaches the model.
    expect(modelPort.calls).toBe(0);
  });
});

describe("CLI env-hardening (slice 2.5 §4.4, residual R3.5)", () => {
  it("scrubs ANYCODE_API_KEY from the live env after the model port is built", async () => {
    const modelPort = new CountingModelPort();
    const input = new PassThrough();
    const output = new PassThrough();

    // A mutable env object standing in for the CLI's process.env. After runCli
    // has constructed the model port (which captured the key by value), the key
    // must be gone so a Bash child spawned by a turn cannot inherit it.
    const env = {
      ANYCODE_API_KEY: "test-key",
      ANYCODE_MODEL: "test-model",
      ANYCODE_DB_PATH: ":memory:",
      ANYCODE_SETTINGS_PATH: isolatedSettingsPath(),
    } as NodeJS.ProcessEnv;

    const runPromise = runCli({ argv: [], env, input, output, modelPort, cwd: process.cwd() });

    input.write("hello there\n");
    input.end();
    await runPromise;

    // Non-secret ANYCODE_* survive; only the secret key is scrubbed.
    expect(env.ANYCODE_API_KEY).toBeUndefined();
    expect(env.ANYCODE_MODEL).toBe("test-model");
    // The turn still ran — the port kept the key by value before the scrub.
    expect(modelPort.calls).toBe(1);
  });
});

describe("CLI render of subagent coarse-progress events (task 3.1.3, design §3.3/§4.2)", () => {
  it("renders subagent_start -> subagent_progress x2 -> subagent_end as prefixed status lines, in order", () => {
    const events: AgentEvent[] = [
      { type: "subagent_start", toolCallId: "call-1", agentType: "explore", description: "map the auth module" },
      { type: "subagent_progress", toolCallId: "call-1", turns: 1, toolCalls: 2, lastTool: "Read" },
      { type: "subagent_progress", toolCallId: "call-1", turns: 2, toolCalls: 3 },
      { type: "subagent_end", toolCallId: "call-1", status: "completed", turns: 2, durationMs: 1234 },
    ];

    let text = "";
    const write = (chunk: string): void => {
      text += chunk;
    };
    for (const event of events) {
      renderEvent(event, write);
    }

    expect(text).toBe(
      "\n[subagent call-1] start: explore — map the auth module\n" +
        "[subagent call-1] progress: turns=1 toolCalls=2 lastTool=Read\n" +
        "[subagent call-1] progress: turns=2 toolCalls=3\n" +
        "[subagent call-1] end (completed): turns=2 durationMs=1234\n",
    );
  });

  it("disambiguates two interleaved subagents by toolCallId", () => {
    const events: AgentEvent[] = [
      { type: "subagent_start", toolCallId: "call-a", agentType: "general-purpose", description: "fix flaky test" },
      { type: "subagent_start", toolCallId: "call-b", agentType: "explore", description: "survey the CLI" },
      { type: "subagent_progress", toolCallId: "call-b", turns: 1, toolCalls: 1, lastTool: "Grep" },
      { type: "subagent_end", toolCallId: "call-b", status: "completed", turns: 1, durationMs: 42 },
      { type: "subagent_end", toolCallId: "call-a", status: "max_turns", turns: 8, durationMs: 9999 },
    ];

    let text = "";
    const write = (chunk: string): void => {
      text += chunk;
    };
    for (const event of events) {
      renderEvent(event, write);
    }

    expect(text).toBe(
      "\n[subagent call-a] start: general-purpose — fix flaky test\n" +
        "\n[subagent call-b] start: explore — survey the CLI\n" +
        "[subagent call-b] progress: turns=1 toolCalls=1 lastTool=Grep\n" +
        "[subagent call-b] end (completed): turns=1 durationMs=42\n" +
        "[subagent call-a] end (max_turns): turns=8 durationMs=9999\n",
    );
  });
});

describe("CLI render of workflow coarse-progress events (design slice-3.4-cut.md §2.3/§3.4)", () => {
  it("renders workflow_start -> step_start/progress/end x2 -> workflow_end as prefixed status lines, in order", () => {
    const events: AgentEvent[] = [
      { type: "workflow_start", toolCallId: "call-1", workflow: "release-notes", totalSteps: 2 },
      { type: "workflow_step_start", toolCallId: "call-1", stepId: "gather", agentType: "explore" },
      { type: "workflow_step_progress", toolCallId: "call-1", stepId: "gather", turns: 1, toolCalls: 2, lastTool: "Read" },
      { type: "workflow_step_end", toolCallId: "call-1", stepId: "gather", status: "completed", turns: 1, durationMs: 111 },
      { type: "workflow_step_start", toolCallId: "call-1", stepId: "write", agentType: "general-purpose" },
      { type: "workflow_step_progress", toolCallId: "call-1", stepId: "write", turns: 2, toolCalls: 1 },
      { type: "workflow_step_end", toolCallId: "call-1", stepId: "write", status: "completed", turns: 2, durationMs: 222 },
      { type: "workflow_end", toolCallId: "call-1", status: "completed", completedSteps: 2, totalSteps: 2, durationMs: 333 },
    ];

    let text = "";
    const write = (chunk: string): void => {
      text += chunk;
    };
    for (const event of events) {
      renderEvent(event, write);
    }

    expect(text).toBe(
      "\n[workflow call-1] start: release-notes (2 step(s))\n" +
        "[workflow call-1] step gather start: explore\n" +
        "[workflow call-1] step gather progress: turns=1 toolCalls=2 lastTool=Read\n" +
        "[workflow call-1] step gather end (completed): turns=1 durationMs=111\n" +
        "[workflow call-1] step write start: general-purpose\n" +
        "[workflow call-1] step write progress: turns=2 toolCalls=1\n" +
        "[workflow call-1] step write end (completed): turns=2 durationMs=222\n" +
        "[workflow call-1] end (completed): completedSteps=2/2 durationMs=333\n",
    );
  });

  it("renders a fail-fast run: a failed step, a skipped step, and a failed workflow_end", () => {
    const events: AgentEvent[] = [
      { type: "workflow_start", toolCallId: "call-2", workflow: "risky", totalSteps: 2 },
      { type: "workflow_step_start", toolCallId: "call-2", stepId: "a", agentType: "general-purpose" },
      { type: "workflow_step_end", toolCallId: "call-2", stepId: "a", status: "error", turns: 3, durationMs: 50 },
      { type: "workflow_step_end", toolCallId: "call-2", stepId: "b", status: "skipped", turns: 0, durationMs: 0 },
      { type: "workflow_end", toolCallId: "call-2", status: "failed", completedSteps: 0, totalSteps: 2, durationMs: 60 },
    ];

    let text = "";
    const write = (chunk: string): void => {
      text += chunk;
    };
    for (const event of events) {
      renderEvent(event, write);
    }

    expect(text).toBe(
      "\n[workflow call-2] start: risky (2 step(s))\n" +
        "[workflow call-2] step a start: general-purpose\n" +
        "[workflow call-2] step a end (error): turns=3 durationMs=50\n" +
        "[workflow call-2] step b end (skipped): turns=0 durationMs=0\n" +
        "[workflow call-2] end (failed): completedSteps=0/2 durationMs=60\n",
    );
  });
});

describe("renderMcpStatusTable (design slice-3.2-cut.md §6, task 3.2.3)", () => {
  it("prints a placeholder line when no servers are configured", () => {
    expect(renderMcpStatusTable([])).toBe("[mcp] no servers configured\n");
  });

  it("renders a column-aligned table (name, transport, state, tools, error) — snapshot", () => {
    const statuses: McpServerStatus[] = [
      { name: "fixture", transport: "stdio", state: "connected", toolCount: 3, toolsTruncated: false },
      {
        name: "remote-search",
        transport: "http",
        state: "failed",
        toolCount: 0,
        toolsTruncated: false,
        error: "connect timed out",
      },
    ];
    expect(renderMcpStatusTable(statuses)).toBe(
      "name           transport  state      tools  error\n" +
        "fixture        stdio      connected  3\n" +
        "remote-search  http       failed     0      connect timed out\n",
    );
  });
});

describe("CLI MCP wiring (design slice-3.2-cut.md §6, task 3.2.3) — fake ModelPort", () => {
  it("with an empty/absent MCP config: prints no MCP banner, /mcp reports no servers, shutdown is clean", async () => {
    const modelPort = new CountingModelPort();
    const input = new PassThrough();
    const output = new PassThrough();
    const getText = collectOutput(output);

    const runPromise = runCli({
      argv: [],
      env: {
        ANYCODE_API_KEY: "test-key",
        ANYCODE_MODEL: "test-model",
        ANYCODE_DB_PATH: ":memory:",
      ANYCODE_SETTINGS_PATH: isolatedSettingsPath(),
      } as NodeJS.ProcessEnv,
      input,
      output,
      modelPort,
      // The repo root carries no .anycode/config.json or .mcp.json (like the
      // other runCli() tests above), so loadMcpServerSpecs resolves to zero
      // specs — zero children spawned.
      cwd: process.cwd(),
    });

    input.write("/mcp\n");
    input.end();

    const exitCode = await runPromise;
    expect(exitCode).toBe(0);

    const text = getText();
    expect(text).not.toContain("MCP:");
    expect(text).toContain("[mcp] no servers configured");
  });
});

describe("renderSkillsTable (design slice-3.3-cut.md §6)", () => {
  it("prints a placeholder line when no skills are discovered", () => {
    expect(renderSkillsTable([])).toBe("[skills] no skills discovered\n");
  });

  it("renders a column-aligned table (name, source, description) — snapshot", () => {
    const metas: SkillMeta[] = [
      {
        name: "demo-skill",
        description: "demos things",
        source: "project",
        path: "/proj/.anycode/skills/demo-skill/SKILL.md",
      },
      {
        name: "writer",
        description: "writes docs",
        source: "plugin:acme",
        path: "/proj/.anycode/plugins/acme/skills/writer/SKILL.md",
      },
    ];
    expect(renderSkillsTable(metas)).toBe(
      "name        source       description\n" +
        "demo-skill  project      demos things\n" +
        "writer      plugin:acme  writes docs\n",
    );
  });
});

describe("renderWorkflowsTable (design slice-3.4-cut.md §6)", () => {
  it("prints a placeholder line when no workflows are discovered", () => {
    expect(renderWorkflowsTable([])).toBe("[workflows] no workflows discovered\n");
  });

  it("renders a column-aligned table (name, source, steps, description) — snapshot", () => {
    const metas: WorkflowMeta[] = [
      { name: "release-notes", description: "drafts release notes", stepCount: 2, source: "project" },
      { name: "triage", description: "triages an incoming bug report", stepCount: 4, source: "user" },
    ];
    expect(renderWorkflowsTable(metas)).toBe(
      "name           source   steps  description\n" +
        "release-notes  project  2      drafts release notes\n" +
        "triage         user     4      triages an incoming bug report\n",
    );
  });
});

// ---------------------------------------------------------------------------
// Extensions bootstrap wiring (design slice-3.3-cut.md §6, task 3.3.5). Real
// discoverExtensions runs against `.anycode/skills|agents` under the given
// workspace/home; the empty-world case below runs it for real (process.cwd()
// carries no such directories, mirroring the MCP tests above). The
// nonzero-count case mocks "../extensions/bootstrap.js" (vi.doMock, NOT
// hoisted — a fresh `import("./main.js")` after vi.resetModules() picks it
// up) rather than depending on skills/subagents-profiles discovery's real
// bodies (owned by concurrent lanes 3.3.2/3.3.3, may not have landed yet):
// this isolates the wiring block's OWN contract (banner text/threshold,
// systemPrompt concatenation, /skills command) from those subsystems' content.
describe("CLI extensions wiring (design slice-3.3-cut.md §6/slice-3.4-cut.md §6, tasks 3.3.5/3.4.4) — fake ModelPort", () => {
  afterEach(() => {
    vi.doUnmock("../extensions/bootstrap.js");
    vi.resetModules();
  });

  it("empty world: no extensions banner, systemPrompt unchanged, /skills and /workflows report nothing discovered", async () => {
    const modelPort = new CountingModelPort();
    const input = new PassThrough();
    const output = new PassThrough();
    const getText = collectOutput(output);
    const cwd = mkdtempSync(join(tmpdir(), "anycode-cli-empty-world-"));
    const home = mkdtempSync(join(tmpdir(), "anycode-cli-empty-home-"));

    try {
      const runPromise = runCli({
        argv: [],
        env: {
          ANYCODE_API_KEY: "test-key",
          ANYCODE_MODEL: "test-model",
          ANYCODE_DB_PATH: ":memory:",
        ANYCODE_SETTINGS_PATH: isolatedSettingsPath(),
        } as NodeJS.ProcessEnv,
        input,
        output,
        modelPort,
        // No .anycode/skills|agents|workflows or AGENTS.md under this temp
        // workspace => discoverExtensions and memory resolve empty.
        cwd,
        home,
      });

      input.write("/skills\n");
      input.write("/workflows\n");
      input.end();

      const exitCode = await runPromise;
      expect(exitCode).toBe(0);

      const text = getText();
      expect(text).not.toContain("Skills:");
      expect(text).not.toContain("Agent profiles:");
      expect(text).not.toContain("Workflows:");
      expect(text).toContain("[skills] no skills discovered");
      expect(text).toContain("[workflows] no workflows discovered");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("empty world: systemPrompt = buildSystemPrompt({toolNames, env}) (zero memory/skills/workflows => \"\" sections, design slice-3.6-cut.md §5-para.6 relative invariant)", async () => {
    const modelPort = new RecordingModelPort();
    const input = new PassThrough();
    const output = new PassThrough();
    const cwd = mkdtempSync(join(tmpdir(), "anycode-cli-empty-world-"));
    const home = mkdtempSync(join(tmpdir(), "anycode-cli-empty-home-"));

    try {
      const runPromise = runCli({
        argv: [],
        env: {
          ANYCODE_API_KEY: "test-key",
          ANYCODE_MODEL: "test-model",
          ANYCODE_DB_PATH: ":memory:",
        ANYCODE_SETTINGS_PATH: isolatedSettingsPath(),
        } as NodeJS.ProcessEnv,
        input,
        output,
        modelPort,
        cwd,
        home,
      });

      input.write("hello there\n");
      input.end();

      const exitCode = await runPromise;
      expect(exitCode).toBe(0);

      expect(modelPort.requests).toHaveLength(1);
      // No MCP servers/extensions configured in this empty world => toolNames is
      // the built-in registry's snapshot plus the CLI-registered ExitPlanMode

      // — the CLI wiring registers it before the toolNames snapshot, so it reaches
      // the CLI's anti-confabulation section while the desktop prompt stays without it)
      // plus the CLI-registered background-Bash surface (design slice-5.5-cut.md

      // backgroundCapableBashTool overwrites "Bash" and BashOutput/BashKill join
      // the registry before this same toolNames snapshot).
      const expectedRegistry = createDefaultToolRegistry();
      expectedRegistry.register(exitPlanModeTool);
      expectedRegistry.register(backgroundCapableBashTool, { silentDuplicateWarning: true });
      expectedRegistry.register(bashOutputTool);
      expectedRegistry.register(bashKillTool);
      const expectedToolNames = expectedRegistry.list();
      const expectedEnv: SystemPromptEnv = {
        workingDirectory: cwd,
        platform: process.platform,
        osVersion: release(),
        date: new Date().toISOString().slice(0, 10),
        modelId: "test-model",
        isGitRepo: await new NodeFileSystemAdapter().exists(`${cwd}/.git`),
      };
      // buildSystemPrompt({toolNames, env}) + "" (memory) + "" (skills) +
      // "" (workflows) === buildSystemPrompt({toolNames, env}) byte-for-byte —
      // proving the concatenation point never mutates a boot with nothing
      // discovered (prompts/system.ts's own section content is out of this lane).
      expect(modelPort.requests[0]?.system).toBe(
        buildSystemPrompt({ toolNames: expectedToolNames, env: expectedEnv }),
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("nonzero extensions: banner prints all four counts, systemPrompt carries both sections, /skills and /workflows render their tables", async () => {
    const fakeMeta: SkillMeta = {
      name: "demo-skill",
      description: "a demo skill",
      source: "project",
      path: "/proj/.anycode/skills/demo-skill/SKILL.md",
    };
    const fakeProfile: PersonaDefinition = {
      name: "reviewer",
      description: "reviews code",
      tools: ["Read"],
      systemPrompt: "review placeholder",
    };
    const fakeWorkflow: WorkflowDefinition = {
      name: "release-notes",
      description: "drafts release notes",
      steps: [{ id: "gather", agentType: "explore", promptTemplate: "gather changes" }],
      source: "project",
      path: "/proj/.anycode/workflows/release-notes.json",
    };
    const fakeBootstrap: ExtensionsBootstrap = {
      skills: { list: () => [fakeMeta], load: async () => undefined },
      skillsPromptSection: "\n[skills section placeholder]\n- demo-skill (project): a demo skill\n",
      profiles: [fakeProfile],
      profilesPromptSection: "\n[profiles section placeholder]\n- reviewer: reviews code\n",
      // Left empty deliberately: a real plugin mcp spec would make
      // mcpManager.start() attempt an actual child-process connection, which
      // this wiring-level test has no business exercising (that belongs to
      // 3.3.4's own plugin/mcp-bridge integration test).
      pluginMcpServerSpecs: [],
      workflows: [fakeWorkflow],
      workflowsPromptSection: "\n[workflows section placeholder]\n- release-notes (project, 1 steps): drafts release notes\n",
      memorySection: "\nAGENTS.md (project):\nAlways run the linter before finishing.\n",
      repoMapFiles: [{ relativePath: "src/index.ts", size: 120, mtimeMs: 10, extension: ".ts", lines: 5 }],
      problems: ["demo problem"],
    };

    vi.doMock("../extensions/bootstrap.js", () => ({
      discoverExtensions: vi.fn(async () => fakeBootstrap),
    }));
    vi.resetModules();
    const { runCli: runCliMocked } = await import("./main.js");

    const modelPort = new RecordingModelPort();
    const input = new PassThrough();
    const output = new PassThrough();
    const getText = collectOutput(output);

    const runPromise = runCliMocked({
      argv: [],
      env: {
        ANYCODE_API_KEY: "test-key",
        ANYCODE_MODEL: "test-model",
        ANYCODE_DB_PATH: ":memory:",
        ANYCODE_REPO_MAP: "1",
        ANYCODE_SETTINGS_PATH: isolatedSettingsPath(),
      } as NodeJS.ProcessEnv,
      input,
      output,
      modelPort,
      cwd: process.cwd(),
    });

    input.write("/skills\n");
    input.write("/workflows\n");
    input.write("/repo-map\n");
    input.write("hello there\n");
    input.end();

    const exitCode = await runPromise;
    expect(exitCode).toBe(0);

    const text = getText();
    expect(text).toContain("Skills: 1 · Agent profiles: 1 · Plugins: 0 · Workflows: 1");
    expect(text).toContain("[warn] extensions: demo problem");
    expect(text).toContain(renderSkillsTable([fakeMeta]));
    const expectedWorkflowMeta: WorkflowMeta = {
      name: fakeWorkflow.name,
      description: fakeWorkflow.description,
      stepCount: fakeWorkflow.steps.length,
      source: fakeWorkflow.source,
    };
    expect(text).toContain(renderWorkflowsTable([expectedWorkflowMeta]));
    expect(text).toContain("<repo-map>");
    expect(text).toContain("- src/");
    expect(text).toContain("- index.ts");

    // The real (non-slash) turn's request carries buildSystemPrompt({toolNames,
    // env}) + ext.memorySection + ext.skillsPromptSection +
    // ext.workflowsPromptSection + ext.profilesPromptSection concatenated, IN
    // THAT ORDER — proving the wiring point in runCli's AgentLoopConfig,
    // without asserting buildSystemPrompt()'s own content (prompts/system.ts
    // is out of this lane).
    expect(modelPort.requests).toHaveLength(1);
    const system = modelPort.requests[0]?.system ?? "";
    expect(system).toContain(fakeBootstrap.memorySection);
    expect(system).toContain(fakeBootstrap.skillsPromptSection);
    expect(system).toContain(fakeBootstrap.workflowsPromptSection);
    expect(system).toContain(fakeBootstrap.profilesPromptSection);
    const memoryIndex = system.indexOf(fakeBootstrap.memorySection);
    const skillsIndex = system.indexOf(fakeBootstrap.skillsPromptSection);
    const workflowsIndex = system.indexOf(fakeBootstrap.workflowsPromptSection);
    const profilesIndex = system.indexOf(fakeBootstrap.profilesPromptSection);
    const repoMapIndex = system.indexOf("<repo-map>");
    expect(memoryIndex).toBeGreaterThanOrEqual(0);
    expect(skillsIndex).toBeGreaterThan(memoryIndex);
    expect(workflowsIndex).toBeGreaterThan(skillsIndex);
    expect(profilesIndex).toBeGreaterThan(workflowsIndex);
    expect(repoMapIndex).toBeGreaterThan(profilesIndex);
  });

  it("/model re-renders the cached repo map under the new model window without rediscovery", async () => {
    const files = Array.from({ length: 500 }, (_, index) => ({
      relativePath: `src/file-${index.toString().padStart(4, "0")}.ts`,
      size: 100,
      mtimeMs: index,
      extension: ".ts",
      lines: 10,
    }));
    const discover = vi.fn(async (): Promise<ExtensionsBootstrap> => ({
      skills: { list: () => [], load: async () => undefined },
      skillsPromptSection: "",
      profiles: [],
      profilesPromptSection: "",
      pluginMcpServerSpecs: [],
      workflows: [],
      workflowsPromptSection: "",
      memorySection: "",
      repoMapFiles: files,
      problems: [],
    }));
    vi.doMock("../extensions/bootstrap.js", () => ({ discoverExtensions: discover }));
    vi.resetModules();
    const { runCli: runCliMocked } = await import("./main.js");

    const port = new RecordingModelPort();
    const input = new PassThrough();
    const output = new PassThrough();
    const runPromise = runCliMocked({
      argv: [],
      env: {
        ANYCODE_API_KEY: "test-key",
        ANYCODE_BASE_URL: "https://api.z.ai/api/anthropic",
        ANYCODE_MODEL: "glm-4.5",
        ANYCODE_DB_PATH: ":memory:",
        ANYCODE_REPO_MAP: "1",
        ANYCODE_SETTINGS_PATH: isolatedSettingsPath(),
      } as NodeJS.ProcessEnv,
      input,
      output,
      modelPort: port,
      modelPortFactory: () => port,
      cwd: process.cwd(),
    });
    input.write("first\n");
    input.write("/model glm-4.6\n");
    input.write("second\n");
    input.end();
    expect(await runPromise).toBe(0);

    expect(port.requests).toHaveLength(2);
    expect(port.requests[0]!.system).toContain("glm-4.5");
    expect(port.requests[1]!.system).toContain("glm-4.6");
    expect(port.requests[1]!.system!.length).toBeGreaterThan(port.requests[0]!.system!.length);
    expect(discover).toHaveBeenCalledOnce();
  });
});

describe("CLI systemPrompt wiring — toolNames snapshot ordering (design slice-3.6-cut.md §6/§0.2)", () => {
  it("a registry.list() snapshot taken AFTER McpManager.start() includes the freshly bridged mcp__ tool, and buildSystemPrompt renders it", async () => {
    // Mirrors mcp/manager.test.ts's in-process InMemoryTransport pattern: a
    // real (in-process) MCP server, zero children, full determinism — proving
    // the ORDER property cli/main.ts's wiring depends on (design §0.2: "the
    // snapshot handed to buildSystemPrompt must be taken after start()") without
    // needing a live child process or a CliOptions transport-injection seam.
    const server = new McpServer({ name: "fake-mcp", version: "0" });
    server.registerTool(
      "ping",
      { description: "pings back", inputSchema: {} },
      async () => ({ content: [{ type: "text", text: "pong" }] }),
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    void server.connect(serverTransport);

    const registry = createDefaultToolRegistry();
    const beforeStart = registry.list();
    expect(beforeStart).not.toContain("mcp__fake-mcp__ping");

    const factory: McpTransportFactory = {
      create: () => clientTransport as unknown as McpWireTransport,
    };
    const manager = new McpManager({ registry, transports: factory });
    try {
      await manager.start([
        { kind: "stdio", name: "fake-mcp", command: "unused", args: [], env: {} },
      ]);

      // The property under test: a snapshot taken AFTER start() carries the
      // bridged tool — exactly the point at which cli/main.ts's own `toolNames`
      // is captured (immediately after its mcpManager.start() try/catch block).
      const toolNames = registry.list();
      expect(toolNames).toContain("mcp__fake-mcp__ping");

      const prompt = buildSystemPrompt({ toolNames });
      expect(prompt).toContain("mcp__fake-mcp__ping");
    } finally {
      await manager.dispose();
    }
  });
});

describe("CLI workflow wiring order (design slice-3.4-cut.md §2.10/§6): withWorkflows AFTER withSubagents", () => {
  it("a real turn calling the Workflow tool reaches the port (not the fail-closed 'unavailable' lock), proving withSubagents ran first", async () => {
    // No .anycode/workflows under the repo root/homedir => zero workflows
    // discovered; the model still calls Workflow by name, and the handler's
    // "unknown workflow" response (as opposed to "workflows are unavailable in
    // this context") proves ctx.workflows was populated — which only happens
    // when withWorkflows sees config.subagents already set (design §2.10). If
    // the wiring order were reversed, config.subagents would be undefined when
    // withWorkflows runs and the tool would stay fail-closed unavailable.
    const modelPort = new SequencedModelPort([
      [
        { type: "start" },
        { type: "tool_call", toolCall: { id: "call-1", name: "Workflow", input: { name: "demo" } } },
        { type: "finish", finishReason: "tool_calls", usage: {} },
      ],
      [
        { type: "start" },
        { type: "text_delta", id: "t", text: "done" },
        { type: "finish", finishReason: "stop", usage: {} },
      ],
    ]);
    const input = new PassThrough();
    const output = new PassThrough();
    const getText = collectOutput(output);

    const runPromise = runCli({
      argv: [],
      env: {
        ANYCODE_API_KEY: "test-key",
        ANYCODE_MODEL: "test-model",
        ANYCODE_DB_PATH: ":memory:",
      ANYCODE_SETTINGS_PATH: isolatedSettingsPath(),
      } as NodeJS.ProcessEnv,
      input,
      output,
      modelPort,
      cwd: process.cwd(),
    });

    input.write("run the demo workflow\n");
    input.end();

    const exitCode = await runPromise;
    expect(exitCode).toBe(0);

    const text = getText();
    expect(text).not.toContain("workflows are unavailable in this context");
    expect(text).toContain('Unknown workflow "demo"');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Session titling (Phase 4 slice 4.4-T, design/feature-session-titles.md §3,
// slice-4.4-T-cut.md §5). A real (non-`:memory:`) sqlite file is required
// here — unlike every other describe block above, these tests reopen the DB
// after runCli's exit path has already flushed + closed it (mirrors
// cli/integration.test.ts's readSessionMode/setupTempDirs pattern), so
// `:memory:` (which dies with the process/instance) would not work.
// ─────────────────────────────────────────────────────────────────────────

const titleTestTempDirs: string[] = [];

/** Fresh workspace dir + fresh sqlite db path, isolated per test (mirrors integration.test.ts's setupTempDirs). */
function setupTitleTestDirs(): { workspace: string; dbPath: string } {
  const workspace = mkdtempSync(join(tmpdir(), "anycode-cli-title-ws-"));
  const dbDir = mkdtempSync(join(tmpdir(), "anycode-cli-title-db-"));
  titleTestTempDirs.push(workspace, dbDir);
  return { workspace, dbPath: join(dbDir, "anycode.sqlite") };
}

/**
 * ANYCODE_SETTINGS_PATH keeps PersistingSessionPermissionRules's boot-seed read
 * (and any fire-and-forget persist a scripted "a"/`/allow` answer triggers,
 * design slice-P7.5-cut.md §3.2) off the owner's real `~/.anycode/settings.json`
 * — sibling to dbPath's own tmpdir, so it needs no separate cleanup entry.
 */
function makeTitleTestEnv(dbPath: string): NodeJS.ProcessEnv {
  return {
    ANYCODE_API_KEY: "test-key",
    ANYCODE_MODEL: "test-model",
    ANYCODE_DB_PATH: dbPath,
    ANYCODE_SETTINGS_PATH: join(dirname(dbPath), "settings.json"),
  } as NodeJS.ProcessEnv;
}

/**
 * Reopens the session persisted at `dbPath` for `workspace` (runCli's own
 * exit path has already flushed + closed the write-behind sink and the db

 * persisted title, plus the id (so a follow-up --resume run can target it).
 */
async function readSessionTitle(
  dbPath: string,
  workspace: string,
): Promise<{ id: string; title: string | undefined }> {
  const persistence = new SqlitePersistenceAdapter(dbPath);
  try {
    const sessions = await persistence.listSessions({ workspace });
    expect(sessions.length).toBeGreaterThan(0);
    const session = sessions[0]!;
    return { id: session.id, title: session.title };
  } finally {
    await persistence.close();
  }
}

afterEach(() => {
  while (titleTestTempDirs.length > 0) {
    const dir = titleTestTempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("CLI session titling (design feature-session-titles.md §3, slice-4.4-T-cut.md §5)", () => {
  it("derives a title from the first prompt's raw first line and persists it to sqlite", async () => {
    const { workspace, dbPath } = setupTitleTestDirs();
    const modelPort = new CountingModelPort();
    const input = new PassThrough();
    const output = new PassThrough();

    const runPromise = runCli({
      argv: [],
      env: makeTitleTestEnv(dbPath),
      input,
      output,
      modelPort,
      cwd: workspace,
    });

    input.write("Fix the flaky node-execution test\n");
    input.end();

    const exitCode = await runPromise;
    expect(exitCode).toBe(0);

    const { title } = await readSessionTitle(dbPath, workspace);
    expect(title).toBe("Fix the flaky node-execution test");
    // The scripted test port never opts into refinement (sessionTitleRefinement

    // — exactly one model call, for the turn itself.
    expect(modelPort.calls).toBe(1);
  });

  it("never re-derives the title of a --resume'd session that already has one", async () => {
    const { workspace, dbPath } = setupTitleTestDirs();

    const firstRun = runCli({
      argv: [],
      env: makeTitleTestEnv(dbPath),
      input: (() => {
        const input = new PassThrough();
        input.write("Original heuristic title\n");
        input.end();
        return input;
      })(),
      output: new PassThrough(),
      modelPort: new CountingModelPort(),
      cwd: workspace,
    });
    await firstRun;

    const { id: sessionId, title: firstTitle } = await readSessionTitle(dbPath, workspace);
    expect(firstTitle).toBe("Original heuristic title");

    const input2 = new PassThrough();
    const output2 = new PassThrough();
    const resumedRun = runCli({
      argv: [],
      env: makeTitleTestEnv(dbPath),
      input: input2,
      output: output2,
      modelPort: new CountingModelPort(),
      cwd: workspace,
      resumeSessionId: sessionId,
    });
    input2.write("should NOT become the title\n");
    input2.end();
    const exitCode = await resumedRun;
    expect(exitCode).toBe(0);

    const { title } = await readSessionTitle(dbPath, workspace);
    expect(title).toBe("Original heuristic title");
  });

  it("in plan mode, the title comes from the raw trimmed line — never the <plan-mode-reminder> tag", async () => {
    const { workspace, dbPath } = setupTitleTestDirs();
    const modelPort = new CountingModelPort();
    const input = new PassThrough();
    const output = new PassThrough();

    const runPromise = runCli({
      argv: [],
      env: makeTitleTestEnv(dbPath),
      input,
      output,
      modelPort,
      cwd: workspace,
      mode: "plan",
    });

    input.write("investigate the auth bug\n");
    input.end();

    const exitCode = await runPromise;
    expect(exitCode).toBe(0);

    const { title } = await readSessionTitle(dbPath, workspace);
    expect(title).toBe("investigate the auth bug");
    expect(title).not.toContain("plan-mode-reminder");
  });

  it("sessionTitleRefinement:true runs the tier-2 one-shot, and the exit path awaits it before persistence.close()", async () => {
    const { workspace, dbPath } = setupTitleTestDirs();
    // Call 0: the turn itself (immediate finish, no tool calls).
    // Call 1: the tier-2 refinement one-shot, replying with a title.
    const modelPort = new SequencedModelPort([
      [{ type: "start" }, { type: "finish", finishReason: "stop", usage: {} }],
      [
        { type: "start" },
        { type: "text_delta", id: "t1", text: "Refined session title" },
        { type: "finish", finishReason: "stop", usage: {} },
      ],
    ]);
    const input = new PassThrough();
    const output = new PassThrough();

    const runPromise = runCli({
      argv: [],
      env: makeTitleTestEnv(dbPath),
      input,
      output,
      modelPort,
      cwd: workspace,
      sessionTitleRefinement: true,
    });

    input.write("first raw line\n");
    input.end();

    const exitCode = await runPromise;
    expect(exitCode).toBe(0);



    // already durably persisted; no polling/vi.waitFor needed.
    const { title } = await readSessionTitle(dbPath, workspace);
    expect(title).toBe("Refined session title");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Sessions/resume UX (Phase 4 slice 4.4, design slice-4.4-cut.md §7). Hermetic
// e2e through the REAL runCli + the same tmp-db harness above (a real sqlite
// file, NOT `:memory:`, so continuity survives across two runCli runs). Covers
// the eight scenarios of §7: --continue (workspace-scoped resume), the



// `-p --continue`, and the live-session /sessions table.
// ─────────────────────────────────────────────────────────────────────────

/** Reopens `dbPath` and returns every session for `workspace` (session-count/continuity assertions). */
async function listWorkspaceSessions(dbPath: string, workspace: string) {
  const persistence = new SqlitePersistenceAdapter(dbPath);
  try {
    return await persistence.listSessions({ workspace });
  } finally {
    await persistence.close();
  }
}

/** Runs one non-interactive session that writes a single line then ends, and asserts exit 0. */
async function seedSession(dbPath: string, workspace: string, firstLine: string): Promise<void> {
  const input = new PassThrough();
  input.write(`${firstLine}\n`);
  input.end();
  const exitCode = await runCli({
    argv: [],
    env: makeTitleTestEnv(dbPath),
    input,
    output: new PassThrough(),
    modelPort: new CountingModelPort(),
    cwd: workspace,
  });
  expect(exitCode).toBe(0);
}

describe("CLI sessions/resume UX (design slice-4.4-cut.md §7)", () => {
  it("scenario 1: run 2 --continue resumes run 1's session (no new row) with a Continuing notice", async () => {
    const { workspace, dbPath } = setupTitleTestDirs();
    await seedSession(dbPath, workspace, "Fix the flaky test");
    const { id: firstId } = await readSessionTitle(dbPath, workspace);

    const input = new PassThrough();
    const output = new PassThrough();
    const getText = collectOutput(output);
    const runPromise = runCli({
      argv: ["--continue"],
      env: makeTitleTestEnv(dbPath),
      input,
      output,
      modelPort: new CountingModelPort(),
      cwd: workspace,
    });
    input.write("keep going\n");
    input.end();

    expect(await runPromise).toBe(0);
    expect(getText()).toContain(`Continuing ${firstId.slice(0, 8)} — Fix the flaky test`);

    // Continuity: still exactly one session, same id — --continue never forked a new row.
    const sessions = await listWorkspaceSessions(dbPath, workspace);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.id).toBe(firstId);
  });

  it("scenario 2: --continue with no prior session for this workspace warns and starts fresh (exit 0)", async () => {
    const { workspace, dbPath } = setupTitleTestDirs();
    const input = new PassThrough();
    const output = new PassThrough();
    const getText = collectOutput(output);
    const runPromise = runCli({
      argv: ["--continue"],
      env: makeTitleTestEnv(dbPath),
      input,
      output,
      modelPort: new CountingModelPort(),
      cwd: workspace,
    });
    input.write("hello there\n");
    input.end();

    expect(await runPromise).toBe(0);
    expect(getText()).toContain("[warn] no previous session for this workspace; starting a new session");
    // A fresh session was still created and used.
    const sessions = await listWorkspaceSessions(dbPath, workspace);
    expect(sessions).toHaveLength(1);
  });

  it("scenario 3: --resume <id> together with --continue — the id wins, --continue is ignored with a warn (R1)", async () => {
    const { workspace, dbPath } = setupTitleTestDirs();
    await seedSession(dbPath, workspace, "Seed session");
    const { id } = await readSessionTitle(dbPath, workspace);

    const input = new PassThrough();
    const output = new PassThrough();
    const getText = collectOutput(output);
    const runPromise = runCli({
      argv: ["--resume", id, "--continue"],
      env: makeTitleTestEnv(dbPath),
      input,
      output,
      modelPort: new CountingModelPort(),
      cwd: workspace,
    });
    input.write("more\n");
    input.end();

    expect(await runPromise).toBe(0);
    expect(getText()).toContain("[warn] --continue ignored: --resume was given");
    // The explicit --resume <id> path stays silent on success (L1) and resumes
    // the very session it names — no new row, --continue never took over.
    const sessions = await listWorkspaceSessions(dbPath, workspace);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.id).toBe(id);
  });

  it("scenario 4: a bare --resume in a non-interactive session exits 1 WITHOUT creating the database (R4)", async () => {
    const { workspace, dbPath } = setupTitleTestDirs();
    const output = new PassThrough();
    const getText = collectOutput(output);
    const exitCode = await runCli({
      argv: ["--resume"],
      env: makeTitleTestEnv(dbPath),
      input: new PassThrough(),
      output,
      modelPort: new CountingModelPort(),
      cwd: workspace,
      // interactive defaults to false on PassThrough streams (no isTTY) — no -p needed.
    });

    expect(exitCode).toBe(1);
    expect(getText()).toContain("--resume without a session id needs an interactive terminal");
    // The early-guard returns before persistence is constructed, so the sqlite
    // file is never even opened.
    expect(existsSync(dbPath)).toBe(false);
  });

  it("scenario 5a: a bare --resume in an interactive session opens the picker; '1' resumes the listed session", async () => {
    const { workspace, dbPath } = setupTitleTestDirs();
    await seedSession(dbPath, workspace, "Picker seed session");
    const { id } = await readSessionTitle(dbPath, workspace);

    const input = new PassThrough();
    const output = new PassThrough();
    const getText = collectOutput(output);
    const runPromise = runCli({
      argv: ["--resume"],
      env: makeTitleTestEnv(dbPath),
      input,
      output,
      modelPort: new CountingModelPort(),
      cwd: workspace,
      interactive: true,
    });

    // Wait for the picker's own prompt to land before answering (never a blind write).
    await vi.waitFor(() => {
      if (!getText().includes("pick a session")) {
        throw new Error("picker prompt has not been shown yet");
      }
    });
    input.write("1\n");

    // Wait for the REPL banner — it is printed only AFTER the main readline
    // interface exists (past the picker handoff), so "/quit" below is guaranteed
    // to reach the main rl, not the already-closed picker rl.
    await vi.waitFor(() => {
      if (!getText().includes("AnyCode CLI")) {
        throw new Error("REPL banner (post-resume) has not landed yet");
      }
    });
    input.write("/quit\n");

    expect(await runPromise).toBe(0);
    expect(getText()).toContain(`Resuming ${id.slice(0, 8)} — Picker seed session`);
    // Resumed, not created — still exactly one session, same id.
    const sessions = await listWorkspaceSessions(dbPath, workspace);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.id).toBe(id);
  });

  it("scenario 5b: the picker answered 'q' aborts through the clean shutdown path (dispose → exit 130, R5)", async () => {
    const { workspace, dbPath } = setupTitleTestDirs();
    await seedSession(dbPath, workspace, "Abort seed session");

    const input = new PassThrough();
    const output = new PassThrough();
    const getText = collectOutput(output);
    const runPromise = runCli({
      argv: ["--resume"],
      env: makeTitleTestEnv(dbPath),
      input,
      output,
      modelPort: new CountingModelPort(),
      cwd: workspace,
      interactive: true,
    });

    await vi.waitFor(() => {
      if (!getText().includes("pick a session")) {
        throw new Error("picker prompt has not been shown yet");
      }
    });
    input.write("q\n");

    // The abort path runs the REAL exit sequence — await mcpManager.dispose()
    // (reaps any MCP children; none here, but the dispose call is exercised) then
    // persistence.close() — before returning 130. The REPL is never entered (no
    // banner), and the promise resolves cleanly with no orphan/hang.
    expect(await runPromise).toBe(130);
    expect(getText()).not.toContain("AnyCode CLI");
  });

  it("scenario 6: --continue of a titled session never re-derives its title (A23 mirror)", async () => {
    const { workspace, dbPath } = setupTitleTestDirs();
    await seedSession(dbPath, workspace, "Original heuristic title");
    const { id, title: firstTitle } = await readSessionTitle(dbPath, workspace);
    expect(firstTitle).toBe("Original heuristic title");

    const input = new PassThrough();
    const output = new PassThrough();
    const runPromise = runCli({
      argv: ["--continue"],
      env: makeTitleTestEnv(dbPath),
      input,
      output: output,
      modelPort: new CountingModelPort(),
      cwd: workspace,
    });
    input.write("should NOT become the title\n");
    input.end();
    expect(await runPromise).toBe(0);

    const after = await readSessionTitle(dbPath, workspace);
    expect(after.id).toBe(id);
    expect(after.title).toBe("Original heuristic title");
  });

  it("scenario 7: -p <prompt> --continue resumes the most recent session headlessly (exit 0)", async () => {
    const { workspace, dbPath } = setupTitleTestDirs();
    await seedSession(dbPath, workspace, "Headless seed session");
    const { id } = await readSessionTitle(dbPath, workspace);

    const output = new PassThrough();
    const errorOutput = new PassThrough();
    const getText = collectOutput(output);
    const getErr = collectOutput(errorOutput);
    const exitCode = await runCli({
      argv: ["-p", "continue this headlessly", "--continue"],
      env: makeTitleTestEnv(dbPath),
      input: new PassThrough(),
      output,
      errorOutput,
      modelPort: new CountingModelPort(),
      cwd: workspace,
    });

    // -p forces non-interactive, but session resolution runs BEFORE the print
    // branch (A16), so --continue still resumes — headless-continue works. The

    // in --print mode ALL boot diagnostics route to errorOutput, keeping stdout an
    // answer-only channel), so it is asserted on errorOutput, not stdout.
    expect(exitCode).toBe(0);
    expect(getErr()).toContain(`Continuing ${id.slice(0, 8)} — Headless seed session`);

    expect(getText()).not.toContain("Continuing");
    // Continuity: no new session row.
    const sessions = await listWorkspaceSessions(dbPath, workspace);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.id).toBe(id);
  });

  it("scenario 8: /sessions in a live session prints a table with the derived title and a '*' on the current session", async () => {
    const { workspace, dbPath } = setupTitleTestDirs();
    const input = new PassThrough();
    const output = new PassThrough();
    const getText = collectOutput(output);
    const runPromise = runCli({
      argv: [],
      env: makeTitleTestEnv(dbPath),
      input,
      output,
      modelPort: new CountingModelPort(),
      cwd: workspace,
    });
    // The first line derives + synchronously persists the title (sqlite is
    // DatabaseSync); the /sessions line then lists it back with the current marker.
    input.write("Investigate the auth bug\n");
    input.write("/sessions\n");
    input.end();

    expect(await runPromise).toBe(0);

    const { id } = await readSessionTitle(dbPath, workspace);
    const text = getText();
    expect(text).not.toContain("[sessions] none found");
    expect(text).toContain("Investigate the auth bug");
    // The current session's short id carries the "*" suffix.
    expect(text).toContain(`${id.slice(0, 8)}*`);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Headless-v1 (slice 4.5) e2e that assert PERSISTED state (design §7): the
// empty-prompt guard skipping DB creation (scenario 2), the json envelope's
// sessionId matching the real DB row (scenario 5), and the tier-1-only
// headless title heuristic (scenario 9). These reuse the file-DB helpers
// (setupTitleTestDirs/seedSession/readSessionTitle/listWorkspaceSessions)
// because they read the sqlite rows back after runCli resolves. The stdin-
// prompt / usage-guard / structured-format e2e that need no DB read live in
// print.test.ts.
// ─────────────────────────────────────────────────────────────────────────
describe("CLI headless-v1 persisted-state e2e (design slice-4.5-cut.md §7)", () => {
  it("scenario 2: bare -p with an empty piped prompt exits 2 and never creates the DB", async () => {
    const { workspace, dbPath } = setupTitleTestDirs();
    const input = new PassThrough();
    const errorOutput = new PassThrough();
    const getErr = collectOutput(errorOutput);

    const runPromise = runCli({
      argv: ["-p"],
      env: makeTitleTestEnv(dbPath),
      input,
      output: new PassThrough(),
      errorOutput,
      modelPort: new CountingModelPort(),
      cwd: workspace,
    });
    input.end(""); // empty stdin ⇒ empty prompt ⇒ guard exit 2

    expect(await runPromise).toBe(2);
    expect(getErr()).toContain("--print got an empty prompt");
    // The guard stands before loadEnvConfig / the SqlitePersistenceAdapter, so
    // no database file is ever opened (A14 fail-fast without wiring).
    expect(existsSync(dbPath)).toBe(false);
  });

  it("scenario 5: -p x --output-format json emits one envelope line whose sessionId matches the sole DB row", async () => {
    const { workspace, dbPath } = setupTitleTestDirs();
    const output = new PassThrough();
    const errorOutput = new PassThrough();
    const getOut = collectOutput(output);

    const exitCode = await runCli({
      argv: ["-p", "compute six times seven", "--output-format", "json"],
      env: makeTitleTestEnv(dbPath),
      input: new PassThrough(),
      output,
      errorOutput,
      modelPort: new SequencedModelPort([
        [{ type: "start" }, { type: "text_delta", id: "t", text: "42" }, { type: "finish", finishReason: "stop", usage: {} }],
      ]),
      cwd: workspace,
    });

    expect(exitCode).toBe(0);
    const lines = getOut()
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(1); // json = exactly one stdout line (the envelope)
    const envelope = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(envelope.type).toBe("result");
    expect(envelope.result).toBe("42");

    const sessions = await listWorkspaceSessions(dbPath, workspace);
    expect(sessions).toHaveLength(1);
    expect(envelope.sessionId).toBe(sessions[0]!.id);
  });

  it("scenario 9: a fresh headless run derives the tier-1 title with NO LLM refinement (R8)", async () => {
    const { workspace, dbPath } = setupTitleTestDirs();
    const prompt = "Investigate the auth bug in the login flow";
    const modelPort = new CountingModelPort();

    const exitCode = await runCli({
      argv: ["-p", prompt],
      env: makeTitleTestEnv(dbPath),
      input: new PassThrough(),
      output: new PassThrough(),
      errorOutput: new PassThrough(),
      modelPort,
      cwd: workspace,
    });

    expect(exitCode).toBe(0);
    const { title } = await readSessionTitle(dbPath, workspace);
    expect(title).toBe(deriveSessionTitle(sanitizeTitleSource(prompt)));

    // no fire-and-forget tier-2 refinement (which would push calls to 2).
    expect(modelPort.calls).toBe(1);
  });

  it("scenario 9b: -p --continue of a titled session leaves the persisted title untouched (L8)", async () => {
    const { workspace, dbPath } = setupTitleTestDirs();
    await seedSession(dbPath, workspace, "Seed heuristic title");
    const { id, title: seeded } = await readSessionTitle(dbPath, workspace);

    const exitCode = await runCli({
      argv: ["-p", "a brand new headless prompt", "--continue"],
      env: makeTitleTestEnv(dbPath),
      input: new PassThrough(),
      output: new PassThrough(),
      errorOutput: new PassThrough(),
      modelPort: new CountingModelPort(),
      cwd: workspace,
    });

    expect(exitCode).toBe(0);
    const after = await readSessionTitle(dbPath, workspace);
    expect(after.id).toBe(id);
    expect(after.title).toBe(seeded);
    const sessions = await listWorkspaceSessions(dbPath, workspace);
    expect(sessions).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// /model + multi-provider wiring (Phase 4 slice 4.6, design slice-4.6-cut.md
// §7). Hermetic e2e through the REAL runCli + the same tmp-db harness above,
// plus an injectable modelPortFactory (CliOptions test-only override): the
// --model boot flag, /model show/switch, resume mode-restore (4.4-R1), and the
// Agent-tool model override. Every scenario is scripted — no network.
// ─────────────────────────────────────────────────────────────────────────

/** Emits one fixed text delta then finishes; records call count (distinguishable per model id). */
class TextModelPort implements ModelPort {
  calls = 0;
  constructor(private readonly text: string) {}

  streamText(_request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.calls += 1;
    const { text } = this;
    return (async function* () {
      yield { type: "start" } as ModelStreamEvent;
      yield { type: "text_delta", id: "t", text } as ModelStreamEvent;
      yield { type: "finish", finishReason: "stop", usage: {} } as ModelStreamEvent;
    })();
  }
}

/** Reopens `dbPath` and returns the sole session's persisted model id (mirror of readSessionMode). */
async function readSessionModel(dbPath: string, workspace: string): Promise<string> {
  const persistence = new SqlitePersistenceAdapter(dbPath);
  try {
    const sessions = await persistence.listSessions({ workspace });
    expect(sessions.length).toBeGreaterThan(0);
    return sessions[0]!.model;
  } finally {
    await persistence.close();
  }
}

describe("CLI /model + multi-provider wiring e2e (design slice-4.6-cut.md §7)", () => {
  it("scenario 1: --model overrides ANYCODE_MODEL for the created session's persisted model", async () => {
    const { workspace, dbPath } = setupTitleTestDirs();
    const input = new PassThrough();
    const runPromise = runCli({
      argv: ["--model", "over-x"],
      env: {
        ANYCODE_API_KEY: "test-key",
        ANYCODE_MODEL: "env-y",
        ANYCODE_DB_PATH: dbPath,
      ANYCODE_SETTINGS_PATH: join(dirname(dbPath), "settings.json"),
      } as NodeJS.ProcessEnv,
      input,
      output: new PassThrough(),
      modelPort: new CountingModelPort(),
      cwd: workspace,
    });
    input.write("hi\n");
    input.end();

    expect(await runPromise).toBe(0);

    expect(await readSessionModel(dbPath, workspace)).toBe("over-x");
  });

  it("scenario 1b: --model flows into the -p --output-format json envelope's model field", async () => {
    const { workspace, dbPath } = setupTitleTestDirs();
    const output = new PassThrough();
    const getOut = collectOutput(output);

    const exitCode = await runCli({
      argv: ["-p", "compute", "--output-format", "json", "--model", "over-x"],
      env: {
        ANYCODE_API_KEY: "test-key",
        ANYCODE_MODEL: "env-y",
        ANYCODE_DB_PATH: dbPath,
      ANYCODE_SETTINGS_PATH: join(dirname(dbPath), "settings.json"),
      } as NodeJS.ProcessEnv,
      input: new PassThrough(),
      output,
      errorOutput: new PassThrough(),
      modelPort: new SequencedModelPort([
        [{ type: "start" }, { type: "text_delta", id: "t", text: "42" }, { type: "finish", finishReason: "stop", usage: {} }],
      ]),
      cwd: workspace,
    });

    expect(exitCode).toBe(0);
    const lines = getOut().split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    const envelope = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(envelope.model).toBe("over-x");
  });

  it("scenario 2: --model with NO ANYCODE_MODEL in env still boots (the flag satisfies the required-model contract A1)", async () => {
    const { workspace, dbPath } = setupTitleTestDirs();
    const input = new PassThrough();
    const runPromise = runCli({
      // Deliberately no ANYCODE_MODEL: loadEnvConfig would throw, but the

      argv: ["--model", "over-x"],
      env: {
        ANYCODE_API_KEY: "test-key",
        ANYCODE_DB_PATH: dbPath,
      ANYCODE_SETTINGS_PATH: join(dirname(dbPath), "settings.json"),
      } as NodeJS.ProcessEnv,
      input,
      output: new PassThrough(),
      modelPort: new CountingModelPort(),
      cwd: workspace,
    });
    input.write("hi\n");
    input.end();

    expect(await runPromise).toBe(0);
    expect(await readSessionModel(dbPath, workspace)).toBe("over-x");
  });

  it("scenario 3a: --model \"\" exits 2 without creating the database", async () => {
    const { workspace, dbPath } = setupTitleTestDirs();
    const errorOutput = new PassThrough();
    const getErr = collectOutput(errorOutput);
    const exitCode = await runCli({
      argv: ["--model", ""],
      env: makeTitleTestEnv(dbPath),
      input: new PassThrough(),
      output: new PassThrough(),
      errorOutput,
      modelPort: new CountingModelPort(),
      cwd: workspace,
    });

    expect(exitCode).toBe(2);
    expect(getErr()).toContain("--model needs a model id");
    // The guard stands before loadEnvConfig / the SqlitePersistenceAdapter.
    expect(existsSync(dbPath)).toBe(false);
  });

  it("scenario 3b: a trailing bare --model exits 2 without creating the database", async () => {
    const { workspace, dbPath } = setupTitleTestDirs();
    const errorOutput = new PassThrough();
    const getErr = collectOutput(errorOutput);
    const exitCode = await runCli({
      argv: ["--model"],
      env: makeTitleTestEnv(dbPath),
      input: new PassThrough(),
      output: new PassThrough(),
      errorOutput,
      modelPort: new CountingModelPort(),
      cwd: workspace,
    });

    expect(exitCode).toBe(2);
    expect(getErr()).toContain("--model needs a model id");
    expect(existsSync(dbPath)).toBe(false);
  });

  it("scenario 4: /model on a z.ai endpoint shows the current model plus the matched provider's hints", async () => {
    const modelPort = new CountingModelPort();
    const input = new PassThrough();
    const output = new PassThrough();
    const getText = collectOutput(output);

    const runPromise = runCli({
      argv: [],
      env: {
        ANYCODE_API_KEY: "test-key",
        ANYCODE_MODEL: "glm-4.6",
        ANYCODE_BASE_URL: "https://api.z.ai/api/anthropic",
        ANYCODE_DB_PATH: ":memory:",
      ANYCODE_SETTINGS_PATH: isolatedSettingsPath(),
      } as NodeJS.ProcessEnv,
      input,
      output,
      modelPort,
      cwd: process.cwd(),
    });

    input.write("/model\n");
    input.write("/quit\n");

    expect(await runPromise).toBe(0);
    const text = getText();
    expect(text).toContain("[model] glm-4.6");
    expect(text).toContain("[model] provider: Z.AI (GLM) — models: glm-5.2, glm-4.6, glm-4.5, glm-4.5-air (switch: /model <id>)");
    // /model show never reaches the model.
    expect(modelPort.calls).toBe(0);
  });

  it("scenario 5: /model glm-4.5 with a factory routes the next turn through the new port and persists session.model", async () => {
    const { workspace, dbPath } = setupTitleTestDirs();
    const input = new PassThrough();
    const output = new PassThrough();
    const getText = collectOutput(output);

    const runPromise = runCli({
      argv: [],
      env: makeTitleTestEnv(dbPath),
      input,
      output,
      // Base port never streams (we switch before the turn); the factory yields
      // ports whose text encodes the id they were built for.
      modelPort: new CountingModelPort(),
      modelPortFactory: (id: string) => new TextModelPort(`from-${id}`),
      cwd: workspace,
    });

    input.write("/model glm-4.5\n");
    input.write("hello there\n");
    input.write("/quit\n");

    expect(await runPromise).toBe(0);
    const text = getText();
    expect(text).toContain("[model] now glm-4.5");
    // The turn AFTER the switch runs through the factory-built glm-4.5 port.
    expect(text).toContain("from-glm-4.5");
    // touchSession persisted the new model (sqlite is synchronous).
    expect(await readSessionModel(dbPath, workspace)).toBe("glm-4.5");
  });

  it("scenario 6: /model glm-4.5 with an injected port but NO factory refuses; the model is unchanged", async () => {
    const { workspace, dbPath } = setupTitleTestDirs();
    const input = new PassThrough();
    const output = new PassThrough();
    const getText = collectOutput(output);

    const runPromise = runCli({
      argv: [],
      env: makeTitleTestEnv(dbPath),
      input,
      output,
      // Injected port, no factory ⇒ modelPortFactory is undefined ⇒ /model refuses.
      modelPort: new CountingModelPort(),
      cwd: workspace,
    });

    input.write("/model glm-4.5\n");
    input.write("/model\n");
    input.write("/quit\n");

    expect(await runPromise).toBe(0);
    const text = getText();
    expect(text).toContain("[model] model switching is unavailable: this session runs on an injected model port");
    // The show still reports the original (unchanged) model.
    expect(text).toContain("[model] test-model");
    // No touchSession(model) fired ⇒ the persisted model is the env default.
    expect(await readSessionModel(dbPath, workspace)).toBe("test-model");
  });

  it("scenario 7: resume restores the persisted mode; an explicit --mode on the resume wins (4.4-R1)", async () => {
    const { workspace, dbPath } = setupTitleTestDirs();

    // Run 1: create a session in plan mode, then exit.
    const input1 = new PassThrough();
    input1.write("seed line\n");
    input1.end();
    expect(
      await runCli({
        argv: ["--mode", "plan"],
        env: makeTitleTestEnv(dbPath),
        input: input1,
        output: new PassThrough(),
        modelPort: new CountingModelPort(),
        cwd: workspace,
      }),
    ).toBe(0);
    const { id } = await readSessionTitle(dbPath, workspace);

    // Run 2: --resume with no mode ⇒ the banner restores plan.
    const output2 = new PassThrough();
    const getText2 = collectOutput(output2);
    const input2 = new PassThrough();
    const run2 = runCli({
      argv: ["--resume", id],
      env: makeTitleTestEnv(dbPath),
      input: input2,
      output: output2,
      modelPort: new CountingModelPort(),
      cwd: workspace,
    });
    input2.end();
    expect(await run2).toBe(0);
    expect(getText2()).toContain("mode=plan");

    // Run 3: --resume with an explicit --mode edit ⇒ the flag wins over the restore.
    const output3 = new PassThrough();
    const getText3 = collectOutput(output3);
    const input3 = new PassThrough();
    const run3 = runCli({
      argv: ["--resume", id, "--mode", "edit"],
      env: makeTitleTestEnv(dbPath),
      input: input3,
      output: output3,
      modelPort: new CountingModelPort(),
      cwd: workspace,
    });
    input3.end();
    expect(await run3).toBe(0);
    expect(getText3()).toContain("mode=edit");
  });

  it("scenario 8: a resumed yolo session warns and starts in build (never silently re-escalates, R7)", async () => {
    const { workspace, dbPath } = setupTitleTestDirs();

    // Seed a yolo session directly through the adapter.
    const seed = new SqlitePersistenceAdapter(dbPath);
    const id = globalThis.crypto.randomUUID();
    await seed.createSession({ id, workspace, model: "test-model", mode: "yolo" });
    await seed.close();

    const output = new PassThrough();
    const getText = collectOutput(output);
    const input = new PassThrough();
    const runPromise = runCli({
      argv: ["--resume", id],
      env: makeTitleTestEnv(dbPath),
      input,
      output,
      modelPort: new CountingModelPort(),
      cwd: workspace,
    });
    input.end();

    expect(await runPromise).toBe(0);
    const text = getText();
    expect(text).toContain("[warn] resumed session was in yolo mode; starting in build (re-enable with /mode yolo)");
    expect(text).toContain("mode=build");
  });

  it("scenario 9a: Agent with a model override + a factory spawns the child on the factory port", async () => {
    const parentPort = new SequencedModelPort([
      [
        { type: "start" } as ModelStreamEvent,
        {
          type: "tool_call",
          toolCall: { id: "call-1", name: "Agent", input: { agent_type: "general-purpose", description: "delegate", prompt: "do it", model: "glm-4.5" } },
        } as ModelStreamEvent,
        { type: "finish", finishReason: "tool_calls", usage: {} } as ModelStreamEvent,
      ],
      [
        { type: "start" } as ModelStreamEvent,
        { type: "text_delta", id: "t", text: "parent-done" } as ModelStreamEvent,
        { type: "finish", finishReason: "stop", usage: {} } as ModelStreamEvent,
      ],
    ]);
    const input = new PassThrough();
    const output = new PassThrough();
    const getText = collectOutput(output);

    const runPromise = runCli({
      argv: [],
      env: {
        ANYCODE_API_KEY: "test-key",
        ANYCODE_MODEL: "test-model",
        ANYCODE_DB_PATH: ":memory:",
      ANYCODE_SETTINGS_PATH: isolatedSettingsPath(),
      } as NodeJS.ProcessEnv,
      input,
      output,
      modelPort: parentPort,
      modelPortFactory: (id: string) => new TextModelPort(`child-from-${id}`),
      cwd: process.cwd(),
    });

    input.write("delegate a task\n");
    input.write("/quit\n");

    expect(await runPromise).toBe(0);
    const text = getText();
    // The child ran (subagent events surfaced) and its final text came from the
    // factory-built glm-4.5 port (the tool result body).
    expect(text).toContain("[subagent call-1] start: general-purpose");
    expect(text).toContain("child-from-glm-4.5");
    expect(text).not.toContain("is not supported in this host");
  });

  it("scenario 9b: Agent with a model override but NO factory fails with the runner's error text (no child spawned)", async () => {
    const parentPort = new SequencedModelPort([
      [
        { type: "start" } as ModelStreamEvent,
        {
          type: "tool_call",
          toolCall: { id: "call-1", name: "Agent", input: { agent_type: "general-purpose", description: "delegate", prompt: "do it", model: "glm-4.5" } },
        } as ModelStreamEvent,
        { type: "finish", finishReason: "tool_calls", usage: {} } as ModelStreamEvent,
      ],
      [
        { type: "start" } as ModelStreamEvent,
        { type: "text_delta", id: "t", text: "parent-done" } as ModelStreamEvent,
        { type: "finish", finishReason: "stop", usage: {} } as ModelStreamEvent,
      ],
    ]);
    const input = new PassThrough();
    const output = new PassThrough();
    const getText = collectOutput(output);

    const runPromise = runCli({
      argv: [],
      env: {
        ANYCODE_API_KEY: "test-key",
        ANYCODE_MODEL: "test-model",
        ANYCODE_DB_PATH: ":memory:",
      ANYCODE_SETTINGS_PATH: isolatedSettingsPath(),
      } as NodeJS.ProcessEnv,
      input,
      output,
      // Injected port, no factory ⇒ resolveChildModelPort absent ⇒ error-outcome.
      modelPort: parentPort,
      cwd: process.cwd(),
    });

    input.write("delegate a task\n");
    input.write("/quit\n");

    expect(await runPromise).toBe(0);
    const text = getText();
    expect(text).toContain('Agent: model override "glm-4.5" is not supported in this host; retry without the model field.');
    // The error returns BEFORE the semaphore/spawn, so no subagent ever starts.
    expect(text).not.toContain("[subagent call-1] start");
  });

  it("scenario 10: /model show and switch never invoke a model call (title-lock, hazard A3)", async () => {
    const modelPort = new CountingModelPort();
    const input = new PassThrough();
    const output = new PassThrough();
    const getText = collectOutput(output);

    const runPromise = runCli({
      argv: [],
      env: {
        ANYCODE_API_KEY: "test-key",
        ANYCODE_MODEL: "test-model",
        ANYCODE_DB_PATH: ":memory:",
      ANYCODE_SETTINGS_PATH: isolatedSettingsPath(),
      } as NodeJS.ProcessEnv,
      input,
      output,
      modelPort,
      // A factory so the switch actually succeeds — and STILL streams nothing.
      modelPortFactory: (id: string) => new TextModelPort(`from-${id}`),
      cwd: process.cwd(),
    });

    input.write("/model\n");
    input.write("/model glm-4.5\n");
    input.write("/quit\n");

    expect(await runPromise).toBe(0);
    expect(getText()).toContain("[model] now glm-4.5");
    // Neither the show nor the switch runs a turn ⇒ zero base-port calls.
    expect(modelPort.calls).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Context v2 e2e (Phase 6 slice 6.4, design slice-6.4-cut.md §2-C4/§6#1-3):
// hermetic runCli proof that the context budget is model-aware end to end —
// a catalog 128k model boots with the fixed denominator (the overflow-fix
// number), a live /model switch re-budgets between turns, and an explicit
// ANYCODE_CONTEXT_WINDOW override outranks the catalog both at boot and after
// a switch. No network; every port is scripted.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Locates a turn's `context_usage` transcript line for a given denominator —
 * distinguished from `/context`'s OWN snapshot line (formatContextInfo's
 * "[context] ~N/BUDGET tokens (...% of budget...)") by the event's distinct
 * "[context: ~" (colon) prefix (renderEvent's "case context_usage"; both
 * forms otherwise share the "N/BUDGET tokens" substring).
 */
function findContextEventIndex(text: string, budgetTokens: number): number {
  return text.search(new RegExp(`\\[context: ~\\d+/${budgetTokens} tokens \\(`));
}

describe("CLI context v2 e2e (design slice-6.4-cut.md §2-C4)", () => {
  it("scenario 1: boot on a 128k catalog model (z-ai/glm-4.5) reports context_usage budgetTokens 104000 — the overflow-fix number", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const getText = collectOutput(output);

    const runPromise = runCli({
      argv: [],
      env: {
        ANYCODE_API_KEY: "test-key",
        ANYCODE_MODEL: "glm-4.5",
        ANYCODE_BASE_URL: "https://api.z.ai/api/anthropic",
        ANYCODE_DB_PATH: ":memory:",
      ANYCODE_SETTINGS_PATH: isolatedSettingsPath(),
      } as NodeJS.ProcessEnv,
      input,
      output,
      modelPort: new CountingModelPort(),
      cwd: process.cwd(),
    });

    input.write("hi\n");
    input.write("/context\n");
    input.write("/quit\n");

    expect(await runPromise).toBe(0);
    const text = getText();
    // The turn's context_usage event carries the catalog-resolved denominator.
    expect(text).toContain("/104000 tokens");
    // /context's own snapshot agrees: 128k window, 91000 auto-compact threshold
    // (161920 would be the pre-6.4 defect — see scenario 3 below for that number).
    expect(text).toContain("[context] window 128000 — output reserve 24000 — auto-compact at 91000");
    expect(text).not.toContain("auto-compact at 161920");
  });

  it("scenario 2: /model glm-4.5 on a z-ai boot re-budgets between turns — 200k (176000) becomes 128k (104000); /context shows both windows before/after", async () => {
    const { workspace, dbPath } = setupTitleTestDirs();
    const input = new PassThrough();
    const output = new PassThrough();
    const getText = collectOutput(output);

    const runPromise = runCli({
      argv: [],
      env: {
        ANYCODE_API_KEY: "test-key",
        ANYCODE_MODEL: "glm-4.6",
        ANYCODE_BASE_URL: "https://api.z.ai/api/anthropic",
        ANYCODE_DB_PATH: dbPath,
      ANYCODE_SETTINGS_PATH: join(dirname(dbPath), "settings.json"),
      } as NodeJS.ProcessEnv,
      input,
      output,
      // Base port serves the pre-switch turn; the factory yields ports whose
      // text encodes the id they were built for (mirrors scenario 5 above).
      modelPort: new CountingModelPort(),
      modelPortFactory: (id: string) => new TextModelPort(`from-${id}`),
      cwd: workspace,
    });

    input.write("/context\n");
    input.write("hi\n");
    input.write("/model glm-4.5\n");
    input.write("/context\n");
    input.write("hello again\n");
    input.write("/quit\n");

    expect(await runPromise).toBe(0);
    const text = getText();

    // /context BEFORE the switch: boot window is the 200k catalog model (glm-4.6).
    const beforeIdx = text.indexOf("[context] window 200000 — output reserve 24000 — auto-compact at 161920");
    expect(beforeIdx).toBeGreaterThanOrEqual(0);
    // The turn immediately after boot carries the SAME 200k-model denominator
    // (the context_usage EVENT line, not /context's own snapshot line above).
    const firstTurnIdx = findContextEventIndex(text, 176_000);
    expect(firstTurnIdx).toBeGreaterThan(beforeIdx);

    const switchIdx = text.indexOf("[model] now glm-4.5");
    expect(switchIdx).toBeGreaterThan(firstTurnIdx);

    // /context AFTER the switch: the 128k window, re-budgeted between turns.
    const afterIdx = text.indexOf("[context] window 128000 — output reserve 24000 — auto-compact at 91000");
    expect(afterIdx).toBeGreaterThan(switchIdx);

    // The turn after the switch ran through the factory-built glm-4.5 port AND
    // carries the new (104000) denominator — the re-budget took effect.
    const secondTurnIdx = text.indexOf("from-glm-4.5");
    expect(secondTurnIdx).toBeGreaterThan(afterIdx);
    expect(findContextEventIndex(text, 104_000)).toBeGreaterThan(afterIdx);
  });

  it("scenario 3: ANYCODE_CONTEXT_WINDOW overrides the catalog window at boot AND survives a /model switch — the denominator never moves (R7 floor math: 50000 ⇒ 26000)", async () => {
    const { workspace, dbPath } = setupTitleTestDirs();
    const input = new PassThrough();
    const output = new PassThrough();
    const getText = collectOutput(output);

    const runPromise = runCli({
      argv: [],
      env: {
        ANYCODE_API_KEY: "test-key",
        ANYCODE_MODEL: "glm-4.6",
        ANYCODE_BASE_URL: "https://api.z.ai/api/anthropic",
        ANYCODE_CONTEXT_WINDOW: "50000",
        ANYCODE_DB_PATH: dbPath,
      ANYCODE_SETTINGS_PATH: join(dirname(dbPath), "settings.json"),
      } as NodeJS.ProcessEnv,
      input,
      output,
      modelPort: new CountingModelPort(),
      modelPortFactory: (id: string) => new TextModelPort(`from-${id}`),
      cwd: workspace,
    });

    input.write("hi\n");
    input.write("/model glm-4.5\n");
    input.write("hello again\n");
    input.write("/context\n");
    input.write("/quit\n");

    expect(await runPromise).toBe(0);
    const text = getText();

    // Boot denominator: the env override (50000) wins over the catalog's

    // the pre-switch turn's context_usage EVENT (distinct from /context's own
    // snapshot line, which also happens to share the window below).
    const firstTurnIdx = findContextEventIndex(text, 26_000);
    expect(firstTurnIdx).toBeGreaterThanOrEqual(0);
    // The switch still ran through the factory-built glm-4.5 port...
    const switchTextIdx = text.indexOf("from-glm-4.5");
    expect(switchTextIdx).toBeGreaterThan(firstTurnIdx);
    // ...but the override wins again inside resolveContextWindow for the
    // post-switch turn ⇒ the SAME (26000) denominator, never the catalog's
    // 104000 for glm-4.5 — the override is immovable across the switch.
    // Exactly two context_usage EVENTS carry it (one per turn).
    const eventMatches = [...text.matchAll(/\[context: ~\d+\/26000 tokens \(/g)];
    expect(eventMatches.length).toBe(2);
    expect(eventMatches[1]!.index).toBeGreaterThan(switchTextIdx);
    // /context's own snapshot after the switch agrees: 50000/13000, never the
    // catalog's 128000/91000 for glm-4.5.
    expect(text).toContain("[context] window 50000 — output reserve 24000 — auto-compact at 13000");
    expect(text).not.toContain("[context] window 128000");
    expect(text).not.toContain("[context] window 200000");
    expect(findContextEventIndex(text, 104_000)).toBe(-1);
    expect(findContextEventIndex(text, 176_000)).toBe(-1);
  });

  it("scenario 4: default-boot byte-identity — a non-catalog model (test-model) omits loopConfig.context; /context still works off the DEFAULT window (200000/176000/161920)", async () => {
    const { workspace, dbPath } = setupTitleTestDirs();
    const input = new PassThrough();
    const output = new PassThrough();
    const getText = collectOutput(output);

    const runPromise = runCli({
      argv: [],
      env: makeTitleTestEnv(dbPath),
      input,
      output,
      modelPort: new CountingModelPort(),
      cwd: workspace,
    });

    input.write("hi\n");
    input.write("/context\n");
    input.write("/quit\n");

    expect(await runPromise).toBe(0);
    const text = getText();
    expect(text).toContain("/176000 tokens");
    expect(text).toContain("[context] window 200000 — output reserve 24000 — auto-compact at 161920");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Checkpoint / rewind e2e (Phase 4 slice 4.7, design slice-4.7-cut.md §7).
// Real runCli drives over PassThrough streams + a scripted ModelPort emitting
// tool_call events, against a tmp workspace + a tmp ANYCODE_DB_PATH (so the
// shadow GIT_DIR — rooted beside the db, OUTSIDE the workspace — is hermetic).
// Writes need an allowing broker, so these opt into `yolo: true` (AllowAll) and

// required for the mechanic, exactly as the B1 integration suite already needs.
// ─────────────────────────────────────────────────────────────────────────

/** One assistant turn that calls Write, then a follow-up model round that stops. */
function writeCall(id: string, filePath: string, content: string): ModelStreamEvent[] {
  return [
    { type: "tool_call", toolCall: { id, name: "Write", input: { file_path: filePath, content } } } as ModelStreamEvent,
    { type: "finish", finishReason: "tool_calls", usage: {} } as ModelStreamEvent,
  ];
}
const STOP_SCRIPT: ModelStreamEvent[] = [
  { type: "finish", finishReason: "stop", usage: {} } as ModelStreamEvent,
];

/** Root that main.ts derives for the shadow checkpoints from a real (non-`:memory:`) db path. */
function shadowCheckpointsRoot(dbPath: string): string {
  return join(dirname(dbPath), "checkpoints");
}
/** Exact per-workspace shadow GIT_DIR main.ts's ShadowGitCheckpoints computes (sha256(workspace)[0..16]). */
function shadowGitDir(dbPath: string, workspace: string): string {
  return join(shadowCheckpointsRoot(dbPath), createHash("sha256").update(workspace).digest("hex").slice(0, 16));
}

async function readCheckpoints(dbPath: string, sessionId: string) {
  const persistence = new SqlitePersistenceAdapter(dbPath);
  try {
    return await persistence.listCheckpoints(sessionId);
  } finally {
    await persistence.close();
  }
}
async function readHistoryJson(dbPath: string, sessionId: string): Promise<string> {
  const persistence = new SqlitePersistenceAdapter(dbPath);
  try {
    return JSON.stringify(await persistence.loadHistory(sessionId));
  } finally {
    await persistence.close();
  }
}
function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Git identity + isolation env so a setup commit never depends on the host's user config. */
function gitSetupEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t.invalid",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t.invalid",
  } as NodeJS.ProcessEnv;
}
function gitInWorkspace(workspace: string, args: string[]): string {
  return execFileSync("git", args, { cwd: workspace, env: gitSetupEnv(), encoding: "utf8" });
}
/** Makes `workspace` a real git repo with one committed file (for the L6 user-`.git` invariant). */
function initGitRepoWithCommit(workspace: string): void {
  gitInWorkspace(workspace, ["init", "--quiet"]);
  writeFileSync(join(workspace, "tracked.txt"), "original\n");
  gitInWorkspace(workspace, ["add", "-A"]);
  gitInWorkspace(workspace, ["commit", "--quiet", "-m", "initial"]);
}

describe("CLI checkpoint/rewind e2e (design slice-4.7-cut.md §7)", () => {
  it("scenario 1: a Write turn captures exactly one checkpoint; the shadow gitDir sits under the db dir, never in the workspace", async () => {
    const { workspace, dbPath } = setupTitleTestDirs();
    const f = join(workspace, "f.txt");
    const port = new SequencedModelPort([writeCall("w1", f, "v1"), STOP_SCRIPT]);
    const input = new PassThrough();
    const output = new PassThrough();
    const getText = collectOutput(output);

    const runPromise = runCli({
      argv: [],
      env: makeTitleTestEnv(dbPath),
      input,
      output,
      modelPort: port,
      cwd: workspace,
      yolo: true, // AllowAll broker so the Write executes (the checkpoint is post-permission).
      checkpoints: true,
    });
    input.write("write f as v1\n");
    input.end();

    expect(await runPromise).toBe(0);

    const text = getText();
    expect(text).toContain("[checkpoint]");
    expect(occurrences(text, "[checkpoint]")).toBe(1);
    expect(readFileSync(f, "utf8")).toBe("v1");
    // Shadow gitDir under the db dir; NOTHING in the workspace (L6).
    expect(existsSync(join(shadowGitDir(dbPath, workspace), "HEAD"))).toBe(true);
    expect(existsSync(join(workspace, ".git"))).toBe(false);
    // Exactly one persisted checkpoint row, reason "auto".
    const { id } = await readSessionTitle(dbPath, workspace);
    const checkpoints = await readCheckpoints(dbPath, id);
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]!.reason).toBe("auto");
  }, 20000);

  it("scenario 3: a read-only turn spawns no git, creates no checkpoints dir, emits no checkpoint event (L2)", async () => {
    const { workspace, dbPath } = setupTitleTestDirs();
    const port = new SequencedModelPort([
      [
        { type: "text_delta", id: "t", text: "just talking" } as ModelStreamEvent,
        { type: "finish", finishReason: "stop", usage: {} } as ModelStreamEvent,
      ],
    ]);
    const input = new PassThrough();
    const output = new PassThrough();
    const getText = collectOutput(output);

    const runPromise = runCli({
      argv: [],
      env: makeTitleTestEnv(dbPath),
      input,
      output,
      modelPort: port,
      cwd: workspace,
      yolo: true,
      checkpoints: true,
    });
    input.write("no tools, just chat\n");
    input.end();

    expect(await runPromise).toBe(0);
    expect(getText()).not.toContain("[checkpoint]");
    // Lazy init: with no write-effect tool the service never touches disk.
    expect(existsSync(shadowCheckpointsRoot(dbPath))).toBe(false);
    const { id } = await readSessionTitle(dbPath, workspace);
    expect(await readCheckpoints(dbPath, id)).toHaveLength(0);
  }, 20000);

  it("scenario 4: /rewind restores files AND the conversation to before a turn (rewind-surgery = replaceAll, R9)", async () => {
    const { workspace, dbPath } = setupTitleTestDirs();
    const f = join(workspace, "f.txt");
    const g = join(workspace, "g.txt");
    const port = new SequencedModelPort([
      writeCall("w1", f, "v1"), // turn 1 => f = v1
      STOP_SCRIPT,
      [

        { type: "tool_call", toolCall: { id: "e1", name: "Edit", input: { file_path: f, old_string: "v1", new_string: "v2" } } } as ModelStreamEvent,
        { type: "tool_call", toolCall: { id: "w2", name: "Write", input: { file_path: g, content: "gee" } } } as ModelStreamEvent,
        { type: "finish", finishReason: "tool_calls", usage: {} } as ModelStreamEvent,
      ],
      STOP_SCRIPT,
    ]);
    const input = new PassThrough();
    const output = new PassThrough();
    const getText = collectOutput(output);

    const runPromise = runCli({
      argv: [],
      env: makeTitleTestEnv(dbPath),
      input,
      output,
      modelPort: port,
      cwd: workspace,
      yolo: true,
      checkpoints: true,
    });

    // Two write turns with distinctive markers so the conversation assertion is unambiguous.
    input.write("TURN-ONE write f as v1\n");
    input.write("TURN-TWO-MARKER edit f and write g\n");
    await vi.waitFor(() => {
      if (occurrences(getText(), "[checkpoint]") < 2) {
        throw new Error("both turn checkpoints have not landed yet");
      }
    });
    await vi.waitFor(() => {
      if (!existsSync(g) || readFileSync(f, "utf8") !== "v2") {
        throw new Error("the second turn's file operations have not completed yet");
      }
    });
    // After turn 2, on disk: f=v2, g exists.
    expect(readFileSync(f, "utf8")).toBe("v2");
    expect(existsSync(g)).toBe(true);

    // /rewind 1 = newest checkpoint = the one taken BEFORE turn 2 (f=v1, no g).
    input.write("/rewind 1\n");
    await vi.waitFor(() => {
      if (!getText().includes("[rewind] restore files+conversation to checkpoint")) {
        throw new Error("rewind confirmation prompt not shown yet");
      }
    });
    input.write("y\n");
    await vi.waitFor(() => {
      if (!getText().includes("[rewind] safety checkpoint")) {
        throw new Error("restore has not completed yet");
      }
    });
    // A follow-up (read-only) turn, then close — proves the conversation truncated.
    input.write("TURN-THREE just checking\n");
    input.end();

    expect(await runPromise).toBe(0);

    // Files rewound: f back to v1, g removed.
    expect(readFileSync(f, "utf8")).toBe("v1");
    expect(existsSync(g)).toBe(false);
    const text = getText();
    expect(text).toContain("[rewind] restored files:");
    expect(text).toContain("[rewind] conversation rewound to before that turn");

    const { id } = await readSessionTitle(dbPath, workspace);
    // Conversation restored to the pre-turn-2 snapshot: turn 2 is gone, turns 1 & 3 remain.
    const historyJson = await readHistoryJson(dbPath, id);
    expect(historyJson).toContain("TURN-ONE");
    expect(historyJson).toContain("TURN-THREE");
    expect(historyJson).not.toContain("TURN-TWO-MARKER");
    // A mandatory pre-rewind safety checkpoint was persisted.
    const checkpoints = await readCheckpoints(dbPath, id);
    expect(checkpoints.some((c) => c.reason === "pre-rewind")).toBe(true);
  }, 30000);

  it("scenario 5: a second /rewind onto the pre-rewind safety redoes the undo (bidirectional, R9)", async () => {
    const { workspace, dbPath } = setupTitleTestDirs();
    const f = join(workspace, "f.txt");
    const g = join(workspace, "g.txt");
    const port = new SequencedModelPort([
      writeCall("w1", f, "v1"),
      STOP_SCRIPT,
      [
        { type: "tool_call", toolCall: { id: "e1", name: "Edit", input: { file_path: f, old_string: "v1", new_string: "v2" } } } as ModelStreamEvent,
        { type: "tool_call", toolCall: { id: "w2", name: "Write", input: { file_path: g, content: "gee" } } } as ModelStreamEvent,
        { type: "finish", finishReason: "tool_calls", usage: {} } as ModelStreamEvent,
      ],
      STOP_SCRIPT,
    ]);
    const input = new PassThrough();
    const output = new PassThrough();
    const getText = collectOutput(output);

    const runPromise = runCli({
      argv: [],
      env: makeTitleTestEnv(dbPath),
      input,
      output,
      modelPort: port,
      cwd: workspace,
      yolo: true,
      checkpoints: true,
    });

    input.write("write f as v1\n");
    input.write("edit f and write g\n");
    await vi.waitFor(() => {
      if (occurrences(getText(), "[checkpoint]") < 2) {
        throw new Error("both turn checkpoints have not landed yet");
      }
    });

    // Undo turn 2: g removed, f back to v1.
    input.write("/rewind 1\n");
    await vi.waitFor(() => {
      if (occurrences(getText(), "[rewind] restore files+conversation to checkpoint") < 1) {
        throw new Error("first confirmation not shown");
      }
    });
    input.write("y\n");
    await vi.waitFor(() => {
      if (occurrences(getText(), "[rewind] safety checkpoint") < 1) {
        throw new Error("first restore not complete");
      }
    });
    expect(readFileSync(f, "utf8")).toBe("v1");
    expect(existsSync(g)).toBe(false);

    // Redo: /rewind 1 now points at the just-taken pre-rewind safety (f=v2, g) => g returns.
    input.write("/rewind 1\n");
    await vi.waitFor(() => {
      if (occurrences(getText(), "[rewind] restore files+conversation to checkpoint") < 2) {
        throw new Error("second confirmation not shown");
      }
    });
    input.write("y\n");
    await vi.waitFor(() => {
      if (occurrences(getText(), "[rewind] safety checkpoint") < 2) {
        throw new Error("second restore not complete");
      }
    });
    input.end();

    expect(await runPromise).toBe(0);
    expect(readFileSync(f, "utf8")).toBe("v2");
    expect(existsSync(g)).toBe(true);
  }, 30000);

  it("scenario 6: /rewind <#> files rewinds only files; /rewind <#> conversation rewinds only the conversation", async () => {
    // files-only: g removed, but the conversation still carries turn 2.
    {
      const { workspace, dbPath } = setupTitleTestDirs();
      const f = join(workspace, "f.txt");
      const g = join(workspace, "g.txt");
      const port = new SequencedModelPort([
        writeCall("w1", f, "v1"),
        STOP_SCRIPT,
        writeCall("w2", g, "gee"), // turn 2: create g (TURN-TWO-MARKER prompt)
        STOP_SCRIPT,
      ]);
      const input = new PassThrough();
      const output = new PassThrough();
      const getText = collectOutput(output);
      const runPromise = runCli({
        argv: [], env: makeTitleTestEnv(dbPath), input, output,
        modelPort: port, cwd: workspace, yolo: true, checkpoints: true,
      });
      input.write("write f\n");
      input.write("TURN-TWO-MARKER write g\n");
      await vi.waitFor(() => {
        if (occurrences(getText(), "[checkpoint]") < 2) throw new Error("checkpoints not landed");
      });
      input.write("/rewind 1 files\n");
      await vi.waitFor(() => {
        if (!getText().includes("[rewind] restore files to checkpoint")) throw new Error("no files-scope prompt");
      });
      input.write("y\n");
      await vi.waitFor(() => {
        if (!getText().includes("[rewind] safety checkpoint")) throw new Error("restore not done");
      });
      input.end();
      expect(await runPromise).toBe(0);

      const text = getText();
      expect(existsSync(g)).toBe(false); // files rewound
      expect(text).toContain("[rewind] restored files:");
      expect(text).not.toContain("[rewind] conversation rewound to before that turn");
      const { id } = await readSessionTitle(dbPath, workspace);
      expect(await readHistoryJson(dbPath, id)).toContain("TURN-TWO-MARKER"); // conversation intact
    }

    // conversation-only: turn 2 gone from history, but g stays on disk.
    {
      const { workspace, dbPath } = setupTitleTestDirs();
      const f = join(workspace, "f.txt");
      const g = join(workspace, "g.txt");
      const port = new SequencedModelPort([
        writeCall("w1", f, "v1"),
        STOP_SCRIPT,
        writeCall("w2", g, "gee"),
        STOP_SCRIPT,
      ]);
      const input = new PassThrough();
      const output = new PassThrough();
      const getText = collectOutput(output);
      const runPromise = runCli({
        argv: [], env: makeTitleTestEnv(dbPath), input, output,
        modelPort: port, cwd: workspace, yolo: true, checkpoints: true,
      });
      input.write("write f\n");
      input.write("TURN-TWO-MARKER write g\n");
      await vi.waitFor(() => {
        if (occurrences(getText(), "[checkpoint]") < 2) throw new Error("checkpoints not landed");
      });
      input.write("/rewind 1 conversation\n");
      await vi.waitFor(() => {
        if (!getText().includes("[rewind] restore conversation to checkpoint")) throw new Error("no conversation-scope prompt");
      });
      input.write("y\n");
      await vi.waitFor(() => {
        if (!getText().includes("[rewind] safety checkpoint")) throw new Error("restore not done");
      });
      input.end();
      expect(await runPromise).toBe(0);

      const text = getText();
      expect(existsSync(g)).toBe(true); // files untouched
      expect(text).toContain("[rewind] conversation rewound to before that turn");
      expect(text).not.toContain("[rewind] restored files:");
      const { id } = await readSessionTitle(dbPath, workspace);
      expect(await readHistoryJson(dbPath, id)).not.toContain("TURN-TWO-MARKER"); // conversation rewound
    }
  }, 30000);

  it("scenario 7: answering the confirmation with 'n' cancels the rewind and captures no safety checkpoint", async () => {
    const { workspace, dbPath } = setupTitleTestDirs();
    const f = join(workspace, "f.txt");
    const g = join(workspace, "g.txt");
    const port = new SequencedModelPort([
      writeCall("w1", f, "v1"),
      STOP_SCRIPT,
      writeCall("w2", g, "gee"),
      STOP_SCRIPT,
    ]);
    const input = new PassThrough();
    const output = new PassThrough();
    const getText = collectOutput(output);
    const runPromise = runCli({
      argv: [], env: makeTitleTestEnv(dbPath), input, output,
      modelPort: port, cwd: workspace, yolo: true, checkpoints: true,
    });
    input.write("write f\n");
    input.write("write g\n");
    await vi.waitFor(() => {
      if (occurrences(getText(), "[checkpoint]") < 2) throw new Error("checkpoints not landed");
    });
    input.write("/rewind 1\n");
    await vi.waitFor(() => {
      if (!getText().includes("[rewind] restore files+conversation to checkpoint")) throw new Error("no prompt");
    });
    input.write("n\n");
    await vi.waitFor(() => {
      if (!getText().includes("[rewind] cancelled")) throw new Error("cancel not printed");
    });
    input.end();
    expect(await runPromise).toBe(0);

    const text = getText();
    expect(text).toContain("[rewind] cancelled");
    expect(text).not.toContain("[rewind] safety checkpoint");
    expect(text).not.toContain("[rewind] restored files:");
    // Nothing changed on disk, and no pre-rewind safety row was written.
    expect(existsSync(g)).toBe(true);
    const { id } = await readSessionTitle(dbPath, workspace);
    const checkpoints = await readCheckpoints(dbPath, id);
    expect(checkpoints).toHaveLength(2);
    expect(checkpoints.every((c) => c.reason === "auto")).toBe(true);
  }, 30000);

  it("scenario 8: disabled sessions refuse /rewind; an enabled-but-empty session reports no checkpoints / no match", async () => {
    // (a) scripted session with NO opt-in => checkpoints default OFF => refuse.
    {
      const input = new PassThrough();
      const output = new PassThrough();
      const getText = collectOutput(output);
      const runPromise = runCli({
        argv: [],
        env: {
          ANYCODE_API_KEY: "test-key",
          ANYCODE_MODEL: "test-model",
          ANYCODE_DB_PATH: ":memory:",
        ANYCODE_SETTINGS_PATH: isolatedSettingsPath(),
        } as NodeJS.ProcessEnv,
        input,
        output,
        modelPort: new CountingModelPort(),
        cwd: process.cwd(),
      });
      input.write("/rewind\n");
      input.end();
      expect(await runPromise).toBe(0);
      expect(getText()).toContain("[rewind] checkpoints are disabled for this session");
    }
    // (b) enabled but empty: bare /rewind -> notice; /rewind 99 -> no match.
    {
      const { workspace, dbPath } = setupTitleTestDirs();
      const input = new PassThrough();
      const output = new PassThrough();
      const getText = collectOutput(output);
      const runPromise = runCli({
        argv: [], env: makeTitleTestEnv(dbPath), input, output,
        modelPort: new CountingModelPort(), cwd: workspace, checkpoints: true,
      });
      input.write("/rewind\n");
      input.write("/rewind 99\n");
      input.end();
      expect(await runPromise).toBe(0);
      const text = getText();
      expect(text).toContain("[rewind] no checkpoints yet in this session");
      expect(text).toContain('[rewind] no checkpoint matches "99"');
    }
  }, 20000);

  it("scenario 9: options.checkpoints wins over the --no-checkpoints flag (R11 precedence)", async () => {
    // options.checkpoints:true beats --no-checkpoints => checkpoints ON.
    {
      const { workspace, dbPath } = setupTitleTestDirs();
      const f = join(workspace, "f.txt");
      const port = new SequencedModelPort([writeCall("w1", f, "v1"), STOP_SCRIPT]);
      const input = new PassThrough();
      const output = new PassThrough();
      const getText = collectOutput(output);
      const runPromise = runCli({
        argv: ["--no-checkpoints"],
        env: makeTitleTestEnv(dbPath),
        input,
        output,
        modelPort: port,
        cwd: workspace,
        yolo: true,
        checkpoints: true, // explicit option short-circuits the flag (`??`)
      });
      input.write("write f\n");
      input.end();
      expect(await runPromise).toBe(0);
      expect(getText()).toContain("[checkpoint]");
      const { id } = await readSessionTitle(dbPath, workspace);
      expect(await readCheckpoints(dbPath, id)).toHaveLength(1);
    }
    // options.checkpoints:false forces OFF even in an otherwise-eligible session.
    {
      const { workspace, dbPath } = setupTitleTestDirs();
      const f = join(workspace, "f.txt");
      const port = new SequencedModelPort([writeCall("w1", f, "v1"), STOP_SCRIPT]);
      const input = new PassThrough();
      const output = new PassThrough();
      const getText = collectOutput(output);
      const runPromise = runCli({
        argv: [],
        env: makeTitleTestEnv(dbPath),
        input,
        output,
        modelPort: port,
        cwd: workspace,
        yolo: true,
        checkpoints: false,
      });
      input.write("write f\n");
      input.write("/rewind\n");
      input.end();
      expect(await runPromise).toBe(0);
      const text = getText();
      expect(text).not.toContain("[checkpoint]");
      expect(text).toContain("[rewind] checkpoints are disabled for this session");
      expect(existsSync(shadowCheckpointsRoot(dbPath))).toBe(false);
      const { id } = await readSessionTitle(dbPath, workspace);
      expect(await readCheckpoints(dbPath, id)).toHaveLength(0);
    }
  }, 30000);

  it("scenario 10: -p print mode never checkpoints and never creates the checkpoints dir (A19/R11)", async () => {
    const { workspace, dbPath } = setupTitleTestDirs();
    const f = join(workspace, "f.txt");
    const port = new SequencedModelPort([writeCall("w1", f, "v1"), STOP_SCRIPT]);
    const output = new PassThrough();
    const errorOutput = new PassThrough();
    const getText = collectOutput(output);

    const exitCode = await runCli({
      argv: ["-p", "please write f"],
      env: makeTitleTestEnv(dbPath),
      input: new PassThrough(),
      output,
      errorOutput,
      modelPort: port,
      cwd: workspace,

    });

    expect(exitCode).toBe(0);
    expect(getText()).not.toContain("[checkpoint]");
    expect(existsSync(shadowCheckpointsRoot(dbPath))).toBe(false);
  }, 20000);

  it("scenario 11: a checkpoint on a git workspace leaves the user's .git byte-unchanged (L6)", async () => {
    const { workspace, dbPath } = setupTitleTestDirs();
    initGitRepoWithCommit(workspace);
    // Dirty the tracked file so the shadow snapshot captures a non-clean tree.
    writeFileSync(join(workspace, "tracked.txt"), "locally modified\n");
    const headBefore = gitInWorkspace(workspace, ["rev-parse", "HEAD"]).trim();
    const gitHeadFileBefore = readFileSync(join(workspace, ".git", "HEAD"), "utf8");

    const agentFile = join(workspace, "agent-new.txt");
    const port = new SequencedModelPort([writeCall("w1", agentFile, "created by agent"), STOP_SCRIPT]);
    const input = new PassThrough();
    const output = new PassThrough();
    const getText = collectOutput(output);

    const runPromise = runCli({
      argv: [], env: makeTitleTestEnv(dbPath), input, output,
      modelPort: port, cwd: workspace, yolo: true, checkpoints: true,
    });
    input.write("agent writes a new file\n");
    input.end();
    expect(await runPromise).toBe(0);

    // The shadow checkpoint really captured (mechanic works against a real git repo).
    expect(getText()).toContain("[checkpoint]");
    const { id } = await readSessionTitle(dbPath, workspace);
    expect(await readCheckpoints(dbPath, id)).toHaveLength(1);
    // L6: the user's .git HEAD + commit are byte-unchanged; the shadow gitDir is OUTSIDE the workspace.
    expect(gitInWorkspace(workspace, ["rev-parse", "HEAD"]).trim()).toBe(headBefore);
    expect(readFileSync(join(workspace, ".git", "HEAD"), "utf8")).toBe(gitHeadFileBefore);
    expect(shadowGitDir(dbPath, workspace).startsWith(workspace)).toBe(false);
    // The still-dirty working file was NOT reverted by the snapshot (no read-tree ran).
    expect(readFileSync(join(workspace, "tracked.txt"), "utf8")).toBe("locally modified\n");
  }, 20000);

  it("scenario 12: a checkpoint survives --resume; /rewind sees it and a new capture chains onto it", async () => {
    const { workspace, dbPath } = setupTitleTestDirs();
    const f = join(workspace, "f.txt");
    // Run 1: one write turn => checkpoint #1.
    {
      const input = new PassThrough();
      const runPromise = runCli({
        argv: [], env: makeTitleTestEnv(dbPath), input, output: new PassThrough(),
        modelPort: new SequencedModelPort([writeCall("w1", f, "v1"), STOP_SCRIPT]),
        cwd: workspace, yolo: true, checkpoints: true,
      });
      input.write("run one writes f\n");
      input.end();
      expect(await runPromise).toBe(0);
    }
    const { id } = await readSessionTitle(dbPath, workspace);
    const afterRun1 = await readCheckpoints(dbPath, id);
    expect(afterRun1).toHaveLength(1);
    const run1Short = afterRun1[0]!.id.slice(0, 8);

    // Run 2: --resume; /rewind lists the run-1 checkpoint; a new write turn chains a #2.
    const g = join(workspace, "g.txt");
    const input2 = new PassThrough();
    const output2 = new PassThrough();
    const getText2 = collectOutput(output2);
    const runPromise2 = runCli({
      argv: [], env: makeTitleTestEnv(dbPath), input: input2, output: output2,
      modelPort: new SequencedModelPort([writeCall("w2", g, "gee"), STOP_SCRIPT]),
      cwd: workspace, yolo: true, checkpoints: true, resumeSessionId: id,
    });
    input2.write("/rewind\n");
    await vi.waitFor(() => {
      if (!getText2().includes(run1Short)) throw new Error("resumed /rewind does not list the run-1 checkpoint yet");
    });
    input2.write("run two writes g\n");
    await vi.waitFor(() => {
      if (!getText2().includes("[checkpoint]")) throw new Error("run-2 checkpoint not landed yet");
    });
    input2.end();
    expect(await runPromise2).toBe(0);

    const afterRun2 = await readCheckpoints(dbPath, id);
    expect(afterRun2).toHaveLength(2);
    // Newest-first, distinct commits => the run-2 capture chained onto run-1's.
    expect(afterRun2[0]!.commitHash).not.toBe(afterRun2[1]!.commitHash);
  }, 30000);
});

// ─────────────────────────────────────────────────────────────────────────
// Phase 5 slice 5.5 (design slice-5.5-cut.md §6#4/#5/#10): background-task
// hermetic e2e, CLI wave. Wave A/B's own suites (tasks/manager.test.ts,
// tools/bash-*.test.ts) re-prove the orphan-kill/cursor/cap mechanics against
// real spawns; these tests only prove the CLI-level wiring: notices actually
// reach the next turn's user message exactly once (§6#5), a live background
// task never survives runCli()'s own exit path (§6#4), and --print never
// registers the CLI-only tools (§6#10). yolo:true is used throughout (like
// the checkpoint e2e above) so Bash actually executes instead of asking a
// broker with no attached prompter.
// ─────────────────────────────────────────────────────────────────────────

/** One assistant turn that calls Bash with run_in_background, then a follow-up model round that stops. */
function bashBackgroundCall(id: string, command: string): ModelStreamEvent[] {
  return [
    {
      type: "tool_call",
      toolCall: { id, name: "Bash", input: { command, run_in_background: true } },
    } as ModelStreamEvent,
    { type: "finish", finishReason: "tool_calls", usage: {} } as ModelStreamEvent,
  ];
}

/** Like SequencedModelPort (above), but also records every request — needed to inspect the injected user message per turn. */
class SequencedRecordingModelPort implements ModelPort {
  private call = 0;
  requests: ModelRequest[] = [];
  constructor(private readonly scripts: ModelStreamEvent[][]) {}

  streamText(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    const events = this.scripts[this.call] ?? [
      { type: "finish", finishReason: "stop", usage: {} } as ModelStreamEvent,
    ];
    this.call += 1;
    return (async function* () {
      for (const event of events) {
        yield event;
      }
    })();
  }
}

/** True unless the pid is provably gone (ESRCH) — mirrors the orphan-check idiom used by adapters/node/node-execution.test.ts. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** The last message's content, asserted to be the user's (design: turnInput is always appended as a user ChatMessage). */
function lastUserMessageText(request: ModelRequest | undefined): string {
  const last = request?.messages[request.messages.length - 1];
  expect(last?.role).toBe("user");
  return (last as { role: "user"; content: string }).content;
}

describe("CLI background tasks e2e (design slice-5.5-cut.md §6#5): notices injected exactly once", () => {
  it("a completed bg task's notice appears in the <system-reminder> block of the VERY NEXT turn, then never again", async () => {
    const { workspace, dbPath } = setupTitleTestDirs();
    const port = new SequencedRecordingModelPort([
      bashBackgroundCall("b1", "true"), // turn 1: starts a bg task that exits almost immediately
      STOP_SCRIPT, // ends turn 1
      STOP_SCRIPT, // turn 2: inspect the injected reminder
      STOP_SCRIPT, // turn 3: inspect its absence (drained)
    ]);
    const input = new PassThrough();
    const output = new PassThrough();
    const getText = collectOutput(output);

    const runPromise = runCli({
      argv: [],
      env: makeTitleTestEnv(dbPath),
      input,
      output,
      modelPort: port,
      cwd: workspace,
      yolo: true,
    });

    input.write("run the tests in the background\n");
    // Poll via the CLI's OWN /tasks introspection (a slash command — never
    // consumes a scripted model call) until the task manager reports it done;
    // this is the same real-process-completion signal §6#1-3's orphan tests
    // poll on, just observed through the CLI surface instead of a pid file.
    await vi.waitFor(
      () => {
        input.write("/tasks\n");
        // Matched against task-1's OWN /tasks table row, never the unrelated
        // "[loop_end: completed, ...]" line every normal turn already prints.
        if (!/task-1\s+(completed|failed)/.test(getText())) {
          throw new Error("background task has not finished yet");
        }
      },
      { timeout: 5000, interval: 20 },
    );

    input.write("what happened?\n");
    await vi.waitFor(() => {
      if (port.requests.length < 3) throw new Error("turn 2's model call has not landed yet");
    });
    input.write("anything else?\n");
    input.end();

    expect(await runPromise).toBe(0);

    // Turn 2 (request index 2): exactly one system-reminder block, carrying the notice.
    const turn2Text = lastUserMessageText(port.requests[2]);
    expect(turn2Text.match(/<system-reminder>/g)).toHaveLength(1);
    expect(turn2Text).toContain("Background task update:");
    expect(turn2Text).toContain("task-1");
    expect(turn2Text).toContain("completed");
    expect(turn2Text).toContain("exit 0");
    expect(turn2Text.startsWith("what happened?")).toBe(true);

    // Turn 3 (request index 3): drained — no reminder, byte-identical to a pre-5.5 turn.
    const turn3Text = lastUserMessageText(port.requests[3]);
    expect(turn3Text).toBe("anything else?");
    expect(turn3Text).not.toContain("system-reminder");
  }, 15000);

  it("a turn with no background tasks at all injects nothing — turnInput is the raw trimmed line, byte-identical to pre-5.5", async () => {
    const port = new SequencedRecordingModelPort([STOP_SCRIPT]);
    const input = new PassThrough();
    const output = new PassThrough();

    const runPromise = runCli({
      argv: [],
      env: { ANYCODE_API_KEY: "test-key", ANYCODE_MODEL: "test-model", ANYCODE_DB_PATH: ":memory:", ANYCODE_SETTINGS_PATH: isolatedSettingsPath() } as NodeJS.ProcessEnv,
      input,
      output,
      modelPort: port,
      cwd: process.cwd(),
      yolo: true,
    });

    input.write("just chatting, no tools\n");
    input.end();

    expect(await runPromise).toBe(0);
    expect(port.requests).toHaveLength(1);
    expect(lastUserMessageText(port.requests[0])).toBe("just chatting, no tools");
  });
});

describe("CLI background tasks e2e (design slice-5.5-cut.md §6#4): exit-path reap", () => {
  it("a live background task never survives runCli()'s own exit (/exit reaps it — no orphan, bounded)", async () => {
    const { workspace, dbPath } = setupTitleTestDirs();
    const pidFile = join(workspace, "bg.pid");
    const port = new SequencedRecordingModelPort([
      bashBackgroundCall("b1", `sh -c 'echo $$ > ${pidFile}; sleep 30'`),
      STOP_SCRIPT,
    ]);
    const input = new PassThrough();
    const output = new PassThrough();
    const getText = collectOutput(output);

    const runPromise = runCli({
      argv: [],
      env: makeTitleTestEnv(dbPath),
      input,
      output,
      modelPort: port,
      cwd: workspace,
      yolo: true,
    });

    input.write("start a long-running background process\n");
    await vi.waitFor(
      () => {
        if (!existsSync(pidFile)) throw new Error("bg task has not written its pid yet");
      },
      { timeout: 5000, interval: 20 },
    );
    await vi.waitFor(() => {
      if (!getText().includes("[loop_end")) throw new Error("turn 1 has not finished yet");
    });
    input.write("/exit\n");
    input.end();

    const exitCode = await runPromise;
    expect(exitCode).toBe(0);

    const pid = Number(readFileSync(pidFile, "utf8").trim());
    expect(Number.isInteger(pid) && pid > 0).toBe(true);
    // runCli() already resolved (the promise above), which per the exit-path
    // ordering (design §2/C2) means tasks.disposeAll() already awaited every
    // live task's reap BEFORE mcpManager.dispose() — so the pid must be dead
    // by now, not merely "probably dead soon".
    expect(isPidAlive(pid)).toBe(false);
  }, 15000);
});

describe("CLI background tasks e2e (design slice-5.5-cut.md §6#10): print-mode gate", () => {
  it("--print never registers BashOutput/BashKill — the toolNames snapshot sent to the model excludes them", async () => {
    const modelPort = new RecordingModelPort();
    const input = new PassThrough(); // print never reads stdin for an inline prompt
    const output = new PassThrough();
    const errorOutput = new PassThrough();

    const exitCode = await runCli({
      argv: ["--print", "hello"],
      env: { ANYCODE_API_KEY: "test-key", ANYCODE_MODEL: "test-model", ANYCODE_DB_PATH: ":memory:", ANYCODE_SETTINGS_PATH: isolatedSettingsPath() } as NodeJS.ProcessEnv,
      input,
      output,
      errorOutput,
      modelPort,
      cwd: process.cwd(),
    });

    expect(exitCode).toBe(0);
    expect(modelPort.requests).toHaveLength(1);
    const toolNames = modelPort.requests[0]!.tools.map((t) => t.name);
    expect(toolNames).not.toContain("BashOutput");
    expect(toolNames).not.toContain("BashKill");

    // the background-only surface is withheld headlessly.
    expect(toolNames).toContain("Bash");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Phase 6 slice 6.1 (design slice-6.1-cut.md §2-D4/§6#5/#6): CLI-wiring
// hermetic e2e for the diagnostics-after-edit surface, driven against the
// REAL fixture LSP server (lsp/fixtures/fake-lsp-server.cjs) through a real
// spawnPersistent child process — waves A/B/C's own suites (node-execution,
// lsp/manager.test.ts, tools/diagnostics.test.ts) already re-prove the
// spawn/kill/protocol mechanics; these tests only prove the CLI-level
// wiring: a configured server's diagnostics actually reach a turn's
// tool_result (§6#4/#8-analog at the CLI seam), a denied Edit never spawns
// anything (§6#6b), a session with no lspServers config is byte-identical to
// pre-6.1 (§6#6c/L8), and a live server never survives runCli()'s own exit
// (§6#5, mirroring the 5.5 bg-task exit-reap test immediately above).
// ─────────────────────────────────────────────────────────────────────────

const LSP_FIXTURE = fileURLToPath(new URL("../lsp/fixtures/fake-lsp-server.cjs", import.meta.url));

/** Writes `<workspace>/.anycode/config.json` with one lspServers entry driving the real fixture for `.ts` files. */
function writeLspConfig(workspace: string, serverName = "fake"): void {
  mkdirSync(join(workspace, ".anycode"), { recursive: true });
  writeFileSync(
    join(workspace, ".anycode", "config.json"),
    JSON.stringify({
      lspServers: [
        { name: serverName, command: process.execPath, args: [LSP_FIXTURE], extensions: [".ts"] },
      ],
    }),
  );
}

/** One assistant turn that calls Edit, then a follow-up model round that stops (mirror of writeCall above). */
function editCall(id: string, filePath: string, oldString: string, newString: string): ModelStreamEvent[] {
  return [
    {
      type: "tool_call",
      toolCall: { id, name: "Edit", input: { file_path: filePath, old_string: oldString, new_string: newString } },
    } as ModelStreamEvent,
    { type: "finish", finishReason: "tool_calls", usage: {} } as ModelStreamEvent,
  ];
}

/** Extracts the pid column of `serverName`'s "ready" row from a rendered /lsp table (getText() accumulation). */
function extractReadyPid(text: string, serverName: string): number {
  const match = new RegExp(`${serverName}\\s+ready\\s+(\\d+)`).exec(text);
  expect(match).not.toBeNull();
  return Number(match![1]);
}

describe("CLI language-server e2e (design slice-6.1-cut.md §2-D4/§6#4): diagnostics round-trip", () => {
  it("a Write to a matching file returns real diagnostics from the spawned fixture server", async () => {
    const { workspace, dbPath } = setupTitleTestDirs();
    writeLspConfig(workspace);
    const f = join(workspace, "f.ts");
    const port = new SequencedModelPort([
      writeCall("w1", f, "const x = 1; // DIAG: bad type\n"),
      STOP_SCRIPT,
    ]);
    const input = new PassThrough();
    const output = new PassThrough();
    const getText = collectOutput(output);

    const runPromise = runCli({
      argv: [],
      env: makeTitleTestEnv(dbPath),
      input,
      output,
      modelPort: port,
      cwd: workspace,
      yolo: true, // AllowAll broker so the Write actually executes.
    });

    input.write("write f with a diagnostic marker\n");
    input.end();

    expect(await runPromise).toBe(0);
    const text = getText();
    expect(text).toContain('"diagnostics"');
    expect(text).toContain("error: bad type");
    expect(readFileSync(f, "utf8")).toBe("const x = 1; // DIAG: bad type\n");
  }, 15000);

  it("a clean file (no DIAG: marker) reports \"none reported\" — a clean-file signal, not silence", async () => {
    const { workspace, dbPath } = setupTitleTestDirs();
    writeLspConfig(workspace);
    const f = join(workspace, "clean.ts");
    const port = new SequencedModelPort([writeCall("w1", f, "const x = 1;\n"), STOP_SCRIPT]);
    const input = new PassThrough();
    const output = new PassThrough();
    const getText = collectOutput(output);

    const runPromise = runCli({
      argv: [],
      env: makeTitleTestEnv(dbPath),
      input,
      output,
      modelPort: port,
      cwd: workspace,
      yolo: true,
    });

    input.write("write a clean file\n");
    input.end();

    expect(await runPromise).toBe(0);
    expect(getText()).toContain('"diagnostics":"none reported"');
  }, 15000);

  it("an Edit (not just Write) to a matching file also gets diagnostics — both wrapped tools work", async () => {
    const { workspace, dbPath } = setupTitleTestDirs();
    writeLspConfig(workspace);
    const f = join(workspace, "f.ts");
    writeFileSync(f, "const y = 1;\n");
    const port = new SequencedModelPort([
      editCall("e1", f, "const y = 1;", "const y = 1; // DIAG: edited-in bug"),
      STOP_SCRIPT,
    ]);
    const input = new PassThrough();
    const output = new PassThrough();
    const getText = collectOutput(output);

    const runPromise = runCli({
      argv: [],
      env: makeTitleTestEnv(dbPath),
      input,
      output,
      modelPort: port,
      cwd: workspace,
      yolo: true,
    });

    input.write("edit f to add a marker\n");
    input.end();

    expect(await runPromise).toBe(0);
    expect(getText()).toContain("error: edited-in bug");
  }, 15000);
});

describe("CLI language-server e2e (design slice-6.1-cut.md §2-D4/§6#6b): deny path never spawns", () => {
  it("a denied Edit leaves the file unchanged and spawns no server (status stays not_started)", async () => {
    const { workspace, dbPath } = setupTitleTestDirs();
    writeLspConfig(workspace);
    const f = join(workspace, "f.ts");
    writeFileSync(f, "line1\n");
    const port = new SequencedModelPort([editCall("e1", f, "line1", "line1 // DIAG: nope")]);
    const input = new PassThrough();
    const output = new PassThrough();
    const getText = collectOutput(output);

    // No yolo/interactive => createCliPermissionBroker falls back to
    // DenyPermissionBroker (non-interactive, non-yolo): every "ask" verdict
    // (Edit is "ask" in the default "build" mode) auto-denies, no prompter needed.
    const runPromise = runCli({
      argv: [],
      env: makeTitleTestEnv(dbPath),
      input,
      output,
      modelPort: port,
      cwd: workspace,
    });

    input.write("edit the file\n");
    input.write("/lsp\n");
    input.end();

    expect(await runPromise).toBe(0);
    const text = getText();
    expect(text).toContain("(denied)");
    // File untouched: the diagnostics wrapper's spawn lives strictly AFTER a
    // successful inner write, and the inner Edit never ran at all.
    expect(readFileSync(f, "utf8")).toBe("line1\n");
    // The configured server was never spawned by the denied call: /lsp still
    // shows it not_started, with no pid.
    expect(text).toMatch(/fake\s+not_started/);
    expect(text).not.toContain("ready");
    expect(text).not.toContain("initializing");
  }, 15000);
});

describe("CLI language-server e2e (design slice-6.1-cut.md §2-D4/§6#6c/L8): no lspServers config is byte-identical", () => {
  it("a session with NO .anycode/config.json#lspServers never attaches a diagnostics field to a Write result", async () => {
    const { workspace, dbPath } = setupTitleTestDirs();
    // Deliberately NOT calling writeLspConfig — this workspace carries no
    // .anycode/config.json at all (mirrors the pre-6.1 world, L8).
    const f = join(workspace, "f.ts");
    const port = new SequencedModelPort([writeCall("w1", f, "const x = 1; // DIAG: should be invisible\n"), STOP_SCRIPT]);
    const input = new PassThrough();
    const output = new PassThrough();
    const getText = collectOutput(output);

    const runPromise = runCli({
      argv: [],
      env: makeTitleTestEnv(dbPath),
      input,
      output,
      modelPort: port,
      cwd: workspace,
      yolo: true,
    });

    input.write("write f\n");
    input.write("/lsp\n");
    input.end();

    expect(await runPromise).toBe(0);
    const text = getText();
    expect(text).not.toContain("diagnostics");
    expect(text).toContain("[lsp] no language servers configured\n");
    expect(readFileSync(f, "utf8")).toBe("const x = 1; // DIAG: should be invisible\n");
  }, 15000);
});

describe("CLI language-server e2e (design slice-6.1-cut.md §2-D4/§6#5): exit-path reap", () => {
  it("a spawned fixture server never survives runCli()'s own exit (/exit reaps it — no orphan, bounded)", async () => {
    const { workspace, dbPath } = setupTitleTestDirs();
    writeLspConfig(workspace);
    const f = join(workspace, "f.ts");
    const port = new SequencedModelPort([writeCall("w1", f, "const x = 1; // DIAG: spawn me\n"), STOP_SCRIPT]);
    const input = new PassThrough();
    const output = new PassThrough();
    const getText = collectOutput(output);

    const runPromise = runCli({
      argv: [],
      env: makeTitleTestEnv(dbPath),
      input,
      output,
      modelPort: port,
      cwd: workspace,
      yolo: true,
    });

    input.write("write f with a diagnostic marker\n");
    input.write("/lsp\n");
    await vi.waitFor(
      () => {
        if (!/fake\s+ready\s+\d+/.test(getText())) {
          throw new Error("the fixture server has not reached ready yet");
        }
      },
      { timeout: 5000, interval: 20 },
    );
    const pid = extractReadyPid(getText(), "fake");
    expect(Number.isInteger(pid) && pid > 0).toBe(true);

    input.write("/exit\n");
    input.end();

    const exitCode = await runPromise;
    expect(exitCode).toBe(0);
    // runCli() already resolved, which per the exit-path ordering (design
    // §2-D1: lsp.disposeAll() strictly before mcpManager.dispose()) means the
    // server was already reaped — the pid must be dead now, mirroring the
    // 5.5 bg-task exit-reap assertion above.
    expect(isPidAlive(pid)).toBe(false);
  }, 15000);
});

// ─────────────────────────────────────────────────────────────────────────
// Phase 6 slice 6.2 (design slice-6.2-cut.md §2-D2/§6#2/#8): CLI-wiring
// hermetic e2e for the multimodal image-input surface. Wave A/B/C's own
// suites (util/images.test.ts, provider/capabilities.test.ts,
// tools/read-image.test.ts, provider/image-wire.integration.test.ts) already
// re-prove the sniff/cap/capability/wire-serialization mechanics; these
// tests only prove the CLI-level wiring: /image staging actually reaches the

// attaches to that one-shot prompt, a live /model switch is honored by the
// media closure on the very next call (D2-a), and a non-capable model
// refuses honestly with zero "images" keys ever reaching history

// ─────────────────────────────────────────────────────────────────────────

// A real, honestly-magic-byte 1x1 PNG (not a text file wearing a .png
// extension) — decoded once from a well-known minimal-PNG base64 literal, so
// sniffImageMediaType/loadImageAttachment see a genuine PNG header.
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function writeTinyPng(path: string): void {
  writeFileSync(path, Buffer.from(TINY_PNG_BASE64, "base64"));
}

/** One assistant turn that calls Read on an image path, then a follow-up model round that stops. */
function readImageCall(id: string, filePath: string): ModelStreamEvent[] {
  return [
    { type: "tool_call", toolCall: { id, name: "Read", input: { file_path: filePath } } } as ModelStreamEvent,
    { type: "finish", finishReason: "tool_calls", usage: {} } as ModelStreamEvent,
  ];
}

/** The last message's content+images, asserted to be the user's (mirrors lastUserMessageText above). */
function lastUserMessageWithImages(
  request: ModelRequest | undefined,
): { content: string; images?: ImageAttachment[] } {
  const last = request?.messages[request.messages.length - 1];
  expect(last?.role).toBe("user");
  return last as { role: "user"; content: string; images?: ImageAttachment[] };
}

describe("CLI image-input e2e (design slice-6.2-cut.md §6#8a): /image stage drains exactly once (R12)", () => {
  it("/image <png> + a prompt attaches images to that turn's user message; the SECOND turn is clean", async () => {
    const { workspace, dbPath } = setupTitleTestDirs();
    const pngPath = join(workspace, "tiny.png");
    writeTinyPng(pngPath);
    const port = new SequencedRecordingModelPort([STOP_SCRIPT, STOP_SCRIPT]);
    const input = new PassThrough();
    const output = new PassThrough();
    const getText = collectOutput(output);

    const runPromise = runCli({
      argv: [],
      env: { ...makeTitleTestEnv(dbPath), ANYCODE_IMAGE_INPUT: "on" },
      input,
      output,
      modelPort: port,
      cwd: workspace,
    });

    input.write(`/image ${pngPath}\n`);
    input.write("describe this image\n");
    input.write("what else do you see\n");
    input.end();

    expect(await runPromise).toBe(0);
    const text = getText();
    expect(text).toContain("[image] staged tiny.png (image/png,");
    expect(text).toContain("KB) — 1 staged");

    expect(port.requests).toHaveLength(2);
    const turn1 = lastUserMessageWithImages(port.requests[0]);
    expect(turn1.content.startsWith("describe this image")).toBe(true);
    expect(turn1.images).toHaveLength(1);
    expect(turn1.images![0]!.mediaType).toBe("image/png");
    expect(turn1.images![0]!.data).toBe(TINY_PNG_BASE64);
    expect(turn1.images![0]!.sourcePath).toBe(pngPath);


    const turn2 = lastUserMessageWithImages(port.requests[1]);
    expect(turn2.content).toBe("what else do you see");
    expect(turn2.images).toBeUndefined();
  }, 15000);
});

describe("CLI image-input e2e (design slice-6.2-cut.md §6#8b): print --image attaches to the one-shot prompt", () => {
  it("print --image <png> ⇒ the captured request carries images; exit code 0", async () => {
    const { workspace, dbPath } = setupTitleTestDirs();
    const pngPath = join(workspace, "tiny.png");
    writeTinyPng(pngPath);
    const port = new RecordingModelPort();
    const output = new PassThrough();
    const errorOutput = new PassThrough();
    const input = new PassThrough();

    const exitCode = await runCli({
      argv: ["--print", "describe this image", "--image", pngPath],
      env: { ANYCODE_API_KEY: "test-key", ANYCODE_MODEL: "test-model", ANYCODE_DB_PATH: ":memory:", ANYCODE_IMAGE_INPUT: "on", ANYCODE_SETTINGS_PATH: isolatedSettingsPath() } as NodeJS.ProcessEnv,
      input,
      output,
      errorOutput,
      modelPort: port,
      cwd: workspace,
    });

    expect(exitCode).toBe(0);
    expect(port.requests).toHaveLength(1);
    const turn = lastUserMessageWithImages(port.requests[0]);
    expect(turn.images).toHaveLength(1);
    expect(turn.images![0]!.mediaType).toBe("image/png");
    expect(turn.images![0]!.data).toBe(TINY_PNG_BASE64);
  });
});

describe("CLI image-input e2e (design slice-6.2-cut.md §6#8c): a live /model switch is honored on the very next call", () => {
  it("/model to an unlisted id turns off capability immediately; the next /image is refused", async () => {
    const { workspace, dbPath } = setupTitleTestDirs();
    const pngPath = join(workspace, "tiny.png");
    writeTinyPng(pngPath);
    const input = new PassThrough();
    const output = new PassThrough();
    const getText = collectOutput(output);

    const runPromise = runCli({
      argv: [],
      // No ANYCODE_IMAGE_INPUT override: capability comes straight from the
      // catalog hint. The default anthropic endpoint (no ANYCODE_BASE_URL)
      // marks claude-opus-4-20250514 image-capable (provider/catalog-data.ts).
      env: { ...makeTitleTestEnv(dbPath), ANYCODE_MODEL: "claude-opus-4-20250514" },
      input,
      output,
      modelPort: new CountingModelPort(),
      modelPortFactory: (_id: string) => new CountingModelPort(),
      cwd: workspace,
    });

    input.write(`/image ${pngPath}\n`);
    input.write("/model some-unlisted-model\n");
    input.write(`/image ${pngPath}\n`);
    input.write("/quit\n");

    expect(await runPromise).toBe(0);
    const text = getText();
    expect(text).toContain("[image] staged tiny.png");
    expect(text).toContain("[model] now some-unlisted-model");
    expect(text).toContain(
      `${pngPath} is an image, and the current model is not marked image-capable (switch /model, or set ANYCODE_IMAGE_INPUT=on to override)`,
    );
  }, 15000);
});

describe("CLI image-input e2e (design slice-6.2-cut.md §6#2): capability-off poison-proof", () => {
  it("/image refuses immediately with the explicit override hint; a normal turn continues text-only with zero images keys in history", async () => {
    const { workspace, dbPath } = setupTitleTestDirs();
    const pngPath = join(workspace, "tiny.png");
    writeTinyPng(pngPath);
    // test-model matches no catalog entry's models and no override is set,
    // so resolveImageInput is fail-closed false — the same env every other
    // suite in this file already uses by default.
    const port = new SequencedRecordingModelPort([STOP_SCRIPT]);
    const input = new PassThrough();
    const output = new PassThrough();
    const getText = collectOutput(output);

    const runPromise = runCli({
      argv: [],
      env: makeTitleTestEnv(dbPath),
      input,
      output,
      modelPort: port,
      cwd: workspace,
    });

    input.write(`/image ${pngPath}\n`);
    input.write("just chatting, no pictures\n");
    input.end();

    expect(await runPromise).toBe(0);
    const text = getText();
    expect(text).toContain("is an image, and the current model is not marked image-capable");
    expect(text).toContain("ANYCODE_IMAGE_INPUT=on");

    expect(port.requests).toHaveLength(1);
    expect(JSON.stringify(port.requests[0]!.messages)).not.toContain("images");
  }, 15000);
});

describe("CLI image-input e2e (design slice-6.2-cut.md §1 DoD/agent-driven): scripted Read(png) attaches via ctx.media wiring", () => {
  it("a scripted Read on a real PNG carries images on the NEXT turn's tool-result message", async () => {
    const { workspace, dbPath } = setupTitleTestDirs();
    const pngPath = join(workspace, "tiny.png");
    writeTinyPng(pngPath);
    const port = new SequencedRecordingModelPort([readImageCall("r1", pngPath), STOP_SCRIPT]);
    const input = new PassThrough();
    const output = new PassThrough();

    const runPromise = runCli({
      argv: [],
      env: { ...makeTitleTestEnv(dbPath), ANYCODE_IMAGE_INPUT: "on" },
      input,
      output,
      modelPort: port,
      cwd: workspace,
    });

    input.write("look at the screenshot\n");
    input.end();

    expect(await runPromise).toBe(0);
    expect(port.requests).toHaveLength(2);
    const toolMessage = port.requests[1]!.messages.find((m) => m.role === "tool") as
      | { role: "tool"; content: Array<{ type: string; images?: ImageAttachment[] }> }
      | undefined;
    expect(toolMessage).toBeDefined();
    const imagePart = toolMessage!.content.find((part) => part.images !== undefined);
    expect(imagePart?.images).toHaveLength(1);
    expect(imagePart?.images?.[0]?.mediaType).toBe("image/png");
    expect(imagePart?.images?.[0]?.data).toBe(TINY_PNG_BASE64);
  }, 15000);
});

// ─────────────────────────────────────────────────────────────────────────
// Phase 6 slice 6.3 (design slice-6.3-cut.md §2-C2/§6#2-4): CLI-wiring
// hermetic e2e for the WebSearch tool, driven over a REAL loopback
// `node:http` server (mirrors adapters/node/node-http.test.ts's
// listen/closeServer idiom — port 0, close in afterEach, no fixed sleeps).
// Every OTHER suite in this file configures no `webSearch` section at all,
// so their continued-green-unchanged status IS the configless byte-identity
// lock (L6) — no separate "no section" case is added here.
// ─────────────────────────────────────────────────────────────────────────

type WebSearchRequestHandler = (req: IncomingMessage, res: ServerResponse) => void;

async function listenWebSearch(handler: WebSearchRequestHandler): Promise<{ server: Server; endpoint: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, endpoint: `http://127.0.0.1:${port}` };
}

function closeWebSearchServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** Writes `<workspace>/.anycode/config.json` with one `webSearch` (brave) section pointed at the loopback endpoint. */
function writeWebSearchConfig(workspace: string, endpoint: string, apiKeyEnv = "TEST_SEARCH_KEY"): void {
  mkdirSync(join(workspace, ".anycode"), { recursive: true });
  writeFileSync(
    join(workspace, ".anycode", "config.json"),
    JSON.stringify({ webSearch: { backend: "brave", endpoint, apiKeyEnv } }),
  );
}

/** One assistant turn that calls WebSearch, then a follow-up model round that stops. */
function webSearchCall(id: string, query: string): ModelStreamEvent[] {
  return [
    { type: "tool_call", toolCall: { id, name: "WebSearch", input: { query } } } as ModelStreamEvent,
    { type: "finish", finishReason: "tool_calls", usage: {} } as ModelStreamEvent,
  ];
}

describe("CLI WebSearch e2e (design slice-6.3-cut.md §6#3): loopback happy path", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await closeWebSearchServer(server);
      server = undefined;
    }
  });

  it("a scripted WebSearch call hits the real loopback server with the key header and a percent-encoded query, and the key never leaks", async () => {
    const { workspace, dbPath } = setupTitleTestDirs();
    let requestCount = 0;
    let capturedAuthHeader: string | undefined;
    let capturedUrl: string | undefined;
    const listening = await listenWebSearch((req, res) => {
      requestCount += 1;
      capturedAuthHeader = req.headers["x-subscription-token"] as string | undefined;
      capturedUrl = req.url;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          web: {
            results: [
              { title: "Result One", url: "https://example.com/one", description: "First result snippet" },
            ],
          },
        }),
      );
    });
    server = listening.server;
    writeWebSearchConfig(workspace, listening.endpoint);

    const port = new SequencedModelPort([webSearchCall("s1", "climate change 2026"), STOP_SCRIPT]);
    const input = new PassThrough();
    const output = new PassThrough();
    const getText = collectOutput(output);

    const runPromise = runCli({
      argv: [],
      env: { ...makeTitleTestEnv(dbPath), TEST_SEARCH_KEY: "k-123" },
      input,
      output,
      modelPort: port,
      cwd: workspace,
      yolo: true, // AllowAll broker so the "ask"-escalated WebSearch call actually runs.
    });

    input.write("search the web\n");
    input.end();

    expect(await runPromise).toBe(0);
    const text = getText();
    expect(text).toContain("Result One");
    expect(text).toContain("https://example.com/one");

    // Server-side assertions (§6#3): exactly one request, key header verbatim,
    // q percent-encoded via the structural URLSearchParams path (space -> "+").
    expect(requestCount).toBe(1);
    expect(capturedAuthHeader).toBe("k-123");
    expect(capturedUrl).toContain("q=climate+change+2026");


    // model-facing transcript (tool_result/output/error text).
    expect(text).not.toContain("k-123");
  }, 15000);
});

describe("CLI WebSearch e2e (design slice-6.3-cut.md §6#4): deny path never touches the network", () => {
  it("a denied WebSearch call reaches the permission gate but the loopback server sees zero requests", async () => {
    const { workspace, dbPath } = setupTitleTestDirs();
    let requestCount = 0;
    const listening = await listenWebSearch((_req, res) => {
      requestCount += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ web: { results: [] } }));
    });
    try {
      writeWebSearchConfig(workspace, listening.endpoint);

      const port = new SequencedModelPort([webSearchCall("s1", "denied query")]);
      const input = new PassThrough();
      const output = new PassThrough();
      const getText = collectOutput(output);

      // No yolo/interactive => createCliPermissionBroker falls back to
      // DenyPermissionBroker (mirrors the LSP deny e2e above): every "ask"
      // verdict (WebSearch is "ask" via the needsApproval escalation, same
      // class as WebFetch) auto-denies, no prompter needed, and the handler —
      // which is what would issue the HTTP GET — never runs.
      const runPromise = runCli({
        argv: [],
        env: { ...makeTitleTestEnv(dbPath), TEST_SEARCH_KEY: "k-123" },
        input,
        output,
        modelPort: port,
        cwd: workspace,
      });

      input.write("search the web\n");
      input.end();

      expect(await runPromise).toBe(0);
      expect(getText()).toContain("(denied)");
      expect(requestCount).toBe(0);
    } finally {
      await closeWebSearchServer(listening.server);
    }
  }, 15000);
});

describe("CLI WebSearch e2e (design slice-6.3-cut.md §6#2): apiKeyEnv unset disables registration", () => {
  it("a webSearch section whose apiKeyEnv is absent from env warns at boot, never registers the tool, and issues zero HTTP requests", async () => {
    const { workspace, dbPath } = setupTitleTestDirs();
    let requestCount = 0;
    const listening = await listenWebSearch((_req, res) => {
      requestCount += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ web: { results: [] } }));
    });
    try {
      // Config is otherwise valid, but this run's env does NOT set
      // TEST_SEARCH_KEY (unlike the two suites above) — loadWebSearchConfig
      // resolves backend:null with an issue, so the tool is never registered.
      writeWebSearchConfig(workspace, listening.endpoint);

      const port = new SequencedRecordingModelPort([webSearchCall("s1", "should never run"), STOP_SCRIPT]);
      const input = new PassThrough();
      const output = new PassThrough();
      const getText = collectOutput(output);

      const runPromise = runCli({
        argv: [],
        env: makeTitleTestEnv(dbPath),
        input,
        output,
        modelPort: port,
        cwd: workspace,
        yolo: true,
      });

      input.write("search the web\n");
      input.end();

      expect(await runPromise).toBe(0);
      const text = getText();
      expect(text).toContain("[warn] websearch config:");
      expect(text).toContain("env var TEST_SEARCH_KEY is not set");
      // Registry-level proof of non-registration: the dispatcher's own
      // "unknown tool" outcome, not just an absent declaration.
      expect(text).toContain("Unknown tool: WebSearch");
      // Declaration-level proof: the tool never reached the model's tools list.
      expect(port.requests[0]!.tools.some((t) => t.name === "WebSearch")).toBe(false);
      expect(requestCount).toBe(0);
    } finally {
      await closeWebSearchServer(listening.server);
    }
  }, 15000);
});

// ─────────────────────────────────────────────────────────────────────────
// Phase 6 slice 6.6 (design slice-6.6-cut.md §2-C4): CLI-wiring hermetic e2e
// for the opt-in telemetry sink. The file on disk is the assertable artifact
// — these tests never inspect telemetry internals, only the JSONL it leaves
// behind (mirrors the LSP/WebSearch e2e suites above, which likewise treat
// their own machinery as already proven by Wave A/B's own unit suites).
// ─────────────────────────────────────────────────────────────────────────

/** Writes `<workspace>/.anycode/config.json` with an enabled `telemetry` section pointed at `dir`. */
function writeTelemetryConfig(workspace: string, dir: string): void {
  mkdirSync(join(workspace, ".anycode"), { recursive: true });
  writeFileSync(
    join(workspace, ".anycode", "config.json"),
    JSON.stringify({ telemetry: { enabled: true, dir } }),
  );
}

/** Reads the sole `*.jsonl` file in `dir` and parses every line as JSON. */
function readTelemetryRecords(dir: string): Array<{ t: string }> {
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  expect(files).toHaveLength(1);
  const raw = readFileSync(join(dir, files[0]!), "utf8");
  const lines = raw.split("\n").filter((line) => line.length > 0);
  return lines.map((line) => JSON.parse(line) as { t: string });
}

describe("CLI telemetry e2e (design slice-6.6-cut.md §2-C4/DoD): enabled sink writes a valid per-session JSONL", () => {
  it("session_start -> turn events -> session_end, every line valid JSON, flushed by /quit's exit path", async () => {
    const { workspace, dbPath } = setupTitleTestDirs();
    const telDir = join(workspace, "tel");
    writeTelemetryConfig(workspace, telDir);
    const f = join(workspace, "f.txt");
    const port = new SequencedModelPort([writeCall("w1", f, "hello\n"), STOP_SCRIPT]);
    const input = new PassThrough();
    const output = new PassThrough();
    const getText = collectOutput(output);

    const runPromise = runCli({
      argv: [],
      env: makeTitleTestEnv(dbPath),
      input,
      output,
      modelPort: port,
      cwd: workspace,
      yolo: true, // AllowAll broker so the Write actually executes.
    });

    input.write("write f\n");
    input.write("/quit\n");
    input.end();

    expect(await runPromise).toBe(0);
    void getText; // transcript bytes are not asserted here; only the sink file is.

    const records = readTelemetryRecords(telDir);
    expect(records.length).toBeGreaterThan(2);
    expect(records[0]!.t).toBe("session_start");
    expect(records[records.length - 1]!.t).toBe("session_end");
    const middleTypes = new Set(records.slice(1, -1).map((r) => r.t));
    expect(middleTypes.size).toBeGreaterThan(0);
    for (const t of middleTypes) {
      expect(["usage", "tool", "turn_end", "context_usage", "loop_end"]).toContain(t);
    }
  }, 15000);

  it("every record carries v:1, a ts number, and this session's id", async () => {
    const { workspace, dbPath } = setupTitleTestDirs();
    const telDir = join(workspace, "tel");
    writeTelemetryConfig(workspace, telDir);
    const modelPort = new CountingModelPort();
    const input = new PassThrough();
    const output = new PassThrough();

    const runPromise = runCli({
      argv: [],
      env: makeTitleTestEnv(dbPath),
      input,
      output,
      modelPort,
      cwd: workspace,
    });

    input.write("/quit\n");
    input.end();

    expect(await runPromise).toBe(0);
    const sessions = await listWorkspaceSessions(dbPath, workspace);
    expect(sessions).toHaveLength(1);

    const records = readTelemetryRecords(telDir) as unknown as Array<{ v: number; ts: number; session: string; t: string }>;
    expect(records).toHaveLength(2); // session_start, session_end — no turn ran
    for (const record of records) {
      expect(record.v).toBe(1);
      expect(typeof record.ts).toBe("number");
      expect(record.session).toBe(sessions[0]!.id);
    }
    expect(records[0]!.t).toBe("session_start");
    expect(records[1]!.t).toBe("session_end");
  });
});

describe("CLI telemetry e2e (design slice-6.6-cut.md §6#1): sentinel-leak probe", () => {
  it("sentinel markers in the prompt, assistant text/reasoning, tool args, and a failing tool's error text never reach the JSONL", async () => {
    const { workspace, dbPath } = setupTitleTestDirs();
    const telDir = join(workspace, "tel");
    writeTelemetryConfig(workspace, telDir);

    const LEAK_PROMPT = "LEAK_PROMPT_7f";
    const LEAK_ARG = "LEAK_ARG_7f";
    const LEAK_TEXT = "LEAK_TEXT_7f";
    const LEAK_REASON = "LEAK_REASON_7f";
    const LEAK_ERR = "LEAK_ERR_7f";

    const f = join(workspace, "leak.txt");
    const missingPath = join(workspace, `missing-${LEAK_ERR}.txt`);

    const port = new SequencedModelPort([
      [
        { type: "start" },
        { type: "text_delta", id: "t1", text: `analyzing ${LEAK_TEXT}` },
        { type: "reasoning_delta", id: "r1", text: `thinking ${LEAK_REASON}` },
        {
          type: "tool_call",
          toolCall: { id: "w1", name: "Write", input: { file_path: f, content: LEAK_ARG } },
        },
        { type: "finish", finishReason: "tool_calls", usage: {} },
      ] as ModelStreamEvent[],
      [
        {
          type: "tool_call",
          toolCall: { id: "r1c", name: "Read", input: { file_path: missingPath } },
        },
        { type: "finish", finishReason: "tool_calls", usage: {} },
      ] as ModelStreamEvent[],
      STOP_SCRIPT,
    ]);
    const input = new PassThrough();
    const output = new PassThrough();
    const getText = collectOutput(output);

    const runPromise = runCli({
      argv: [],
      env: makeTitleTestEnv(dbPath),
      input,
      output,
      modelPort: port,
      cwd: workspace,
      yolo: true, // AllowAll broker so the Write actually executes.
    });

    input.write(`handle ${LEAK_PROMPT} now\n`);
    input.write("/quit\n");
    input.end();

    expect(await runPromise).toBe(0);
    // Sanity: the scripted turn actually ran the failing Read (proves the
    // error path was exercised, not skipped) — checked against the transcript,
    // never against the telemetry file.
    expect(getText()).toContain("error");

    const files = readdirSync(telDir).filter((f2) => f2.endsWith(".jsonl"));
    expect(files).toHaveLength(1);
    const raw = readFileSync(join(telDir, files[0]!), "utf8");
    for (const marker of [LEAK_PROMPT, LEAK_ARG, LEAK_TEXT, LEAK_REASON, LEAK_ERR, workspace, f, missingPath]) {
      expect(raw).not.toContain(marker);
    }
    // The whitelist mapper still recorded the two tool outcomes (name/status/
    // duration only) — proves this is redaction, not silent event loss.
    const records = readTelemetryRecords(telDir);
    const toolRecords = records.filter((r) => r.t === "tool");
    expect(toolRecords.length).toBe(2);
  }, 15000);
});

describe("CLI telemetry e2e (design slice-6.6-cut.md §2-C1/R3/R4): env kill-switch", () => {
  it("ANYCODE_TELEMETRY=0 disables the sink even with an enabled project config", async () => {
    const { workspace, dbPath } = setupTitleTestDirs();
    const telDir = join(workspace, "tel");
    writeTelemetryConfig(workspace, telDir);
    const modelPort = new CountingModelPort();
    const input = new PassThrough();
    const output = new PassThrough();

    const runPromise = runCli({
      argv: [],
      env: { ...makeTitleTestEnv(dbPath), ANYCODE_TELEMETRY: "0" },
      input,
      output,
      modelPort,
      cwd: workspace,
    });

    input.write("/quit\n");
    input.end();

    expect(await runPromise).toBe(0);
    expect(existsSync(telDir)).toBe(false);
  });
});

describe("CLI telemetry e2e (design slice-6.6-cut.md §6#4): hostile fs — unwritable sink dir", () => {
  it("a sink dir under a read-only parent never crashes the run: exit code stays 0 and no file is written", async () => {
    const { workspace, dbPath } = setupTitleTestDirs();
    const readonlyParent = mkdtempSync(join(tmpdir(), "anycode-tel-readonly-"));
    const telDir = join(readonlyParent, "tel");
    writeTelemetryConfig(workspace, telDir);
    chmodSync(readonlyParent, 0o500); // read+execute, no write => mkdir(telDir) fails EACCES

    try {
      const modelPort = new CountingModelPort();
      const input = new PassThrough();
      const output = new PassThrough();
      const getText = collectOutput(output);

      const runPromise = runCli({
        argv: [],
        env: makeTitleTestEnv(dbPath),
        input,
        output,
        modelPort,
        cwd: workspace,
      });

      input.write("/quit\n");
      input.end();

      expect(await runPromise).toBe(0);
      expect(existsSync(telDir)).toBe(false);
      expect(getText()).not.toContain("[fatal]");
    } finally {
      chmodSync(readonlyParent, 0o700);
      rmSync(readonlyParent, { recursive: true, force: true });
    }
  }, 15000);
});

describe("CLI telemetry e2e (design slice-6.6-cut.md §2-C1/R12): print-mode session_end flush", () => {
  it("a --print run with telemetry enabled writes a file ending in session_end (the const+return reframe actually flushes)", async () => {
    const { workspace, dbPath } = setupTitleTestDirs();
    const telDir = join(workspace, "tel");
    writeTelemetryConfig(workspace, telDir);
    const port = new SequencedModelPort([STOP_SCRIPT]);

    const exitCode = await runCli({
      argv: ["-p", "compute six times seven"],
      env: makeTitleTestEnv(dbPath),
      input: new PassThrough(),
      output: new PassThrough(),
      errorOutput: new PassThrough(),
      modelPort: port,
      cwd: workspace,
    });

    expect(exitCode).toBe(0);
    const records = readTelemetryRecords(telDir);
    expect(records[0]!.t).toBe("session_start");
    expect(records[records.length - 1]!.t).toBe("session_end");
  }, 15000);
});

describe("CLI telemetry e2e (design slice-6.6-cut.md §2-C1/L4): default byte-lock", () => {
  it("a workspace with NO .anycode/config.json#telemetry never creates a sink, warns nothing, and leaves the workspace untouched", async () => {
    const { workspace, dbPath } = setupTitleTestDirs();
    // Deliberately NOT calling writeTelemetryConfig — this workspace carries no
    // .anycode/config.json at all (mirrors the pre-6.6 world, L4/L8): loadTelemetryConfig
    // resolves telemetry:null silently, so no sink is built anywhere (default dir or not).
    const modelPort = new CountingModelPort();
    const input = new PassThrough();
    const output = new PassThrough();
    const getText = collectOutput(output);

    const runPromise = runCli({
      argv: [],
      env: makeTitleTestEnv(dbPath),
      input,
      output,
      modelPort,
      cwd: workspace,
    });

    input.write("/quit\n");
    input.end();

    expect(await runPromise).toBe(0);
    expect(existsSync(join(workspace, ".anycode"))).toBe(false);
    expect(getText()).not.toContain("[warn] telemetry");
  });
});
