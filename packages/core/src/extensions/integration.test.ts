/**
 * Slice 3.3.6 — combined composition e2e (design slice-3.3-cut.md §3.7 "one
 * discoverExtensions for CLI and host", §5.2 item 9/10, §10 DoD). Every
 * per-lane test (skills/discovery.test.ts, tools/skill.test.ts,
 * subagents/profiles tests in runner.test.ts, plugins/discovery.test.ts,
 * extensions/bootstrap.test.ts) already proves ONE subsystem in isolation.
 * This file is the ONLY test that wires all three through the REAL
 * bootstrap -> AgentLoop path in a single session, mirroring cli/main.ts's
 * wiring order verbatim:
 *   discoverExtensions() -> manager.start([...specs, ...ext.pluginMcpServerSpecs])
 *   -> new AgentLoop(withSubagents({ ..., skills: ext.skills, systemPrompt:
 *      buildSystemPrompt() + ext.skillsPromptSection }, { profiles: ext.profiles })).
 *
 * Hermetic: a tmpdir workspace holds a real SKILL.md, a real *.md agent
 * profile, and a real plugin manifest declaring the existing
 * mcp/fixtures/fixture-server.mjs as a stdio server; a ScriptedModelPort (no
 * live model, no network) drives one Skill call, one Agent(profile) call and
 * one plugin-bridged MCP tool call in sequence. The orphan proof re-uses the
 * discipline of plugins/discovery.test.ts's real-integration suite: dispose()
 * must leave the fixture child's pid ACTUALLY dead.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { discoverExtensions } from "./bootstrap.js";
import { NodeFileSystemAdapter } from "../adapters/node/node-file-system.js";
import { NodeMcpTransportFactory, NodeStdioMcpTransport } from "../adapters/node/node-mcp-transport.js";
import { McpManager } from "../mcp/manager.js";
import { createDefaultToolRegistry } from "../tools/registry.js";
import { InMemoryTodoStore } from "../tools/todo-store.js";
import { InMemoryHookRunner } from "../dispatch/hook-runner.js";
import { ModePermissionEngine } from "../permissions/engine.js";
import { AgentLoop, type AgentLoopConfig } from "../loop/agent-loop.js";
import { buildChildConfig, withSubagents } from "../subagents/runner.js";
import { buildSystemPrompt } from "../prompts/identity.js";
import type { AgentEvent, ModelStreamEvent } from "../types/events.js";
import type { ModelPort, ModelRequest } from "../ports/model.js";
import type { CorePorts, ExecutionPort, FileSystemPort, HttpPort } from "../ports/index.js";
import type {
  McpServerSpec,
  McpStdioServerSpec,
  McpTransportFactory,
  McpWireTransport,
} from "../ports/mcp.js";
import type { PermissionBroker, PermissionDecision, PermissionRequest } from "../types/permissions.js";

const FIXTURE = fileURLToPath(new URL("../mcp/fixtures/fixture-server.mjs", import.meta.url));

// ---------------------------------------------------------------------------
// Local helpers (mirror subagents/runner.test.ts / tools/skill.test.ts's
// per-file ScriptedModelPort pattern; each test file owns its own copy).

type ModelScript = (req: ModelRequest) => ModelStreamEvent[];

class ScriptedModelPort implements ModelPort {
  constructor(private readonly script: ModelScript) {}

  streamText(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const events = this.script(request);
    const signal = request.abortSignal;
    return (async function* () {
      for (const event of events) {
        if (signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        yield event;
      }
    })();
  }
}

function textStep(text: string): ModelStreamEvent[] {
  return [
    { type: "start" },
    { type: "text_delta", id: "t", text },
    { type: "finish", finishReason: "stop", usage: {} },
  ];
}

function toolStep(id: string, name: string, input: unknown): ModelStreamEvent[] {
  return [
    { type: "start" },
    { type: "tool_call", toolCall: { id, name, input } },
    { type: "finish", finishReason: "tool_calls", usage: {} },
  ];
}

function makePorts(): CorePorts {
  return {
    fs: {} as FileSystemPort,
    exec: {} as ExecutionPort,
    http: {} as HttpPort,
    todos: new InMemoryTodoStore(),
  };
}

/** Captures the concrete NodeStdioMcpTransport the real factory creates, purely to read its .pid test hook (mirrors plugins/discovery.test.ts). */
class CapturingRealFactory implements McpTransportFactory {
  private readonly real = new NodeMcpTransportFactory();
  transport: NodeStdioMcpTransport | undefined;
  create(spec: McpServerSpec): McpWireTransport {
    const transport = this.real.create(spec);
    this.transport = transport as NodeStdioMcpTransport;
    return transport;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForDead(pid: number, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isPidAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function asStdio(spec: McpServerSpec): McpStdioServerSpec {
  return spec as McpStdioServerSpec;
}

// ---------------------------------------------------------------------------

describe("extensions integration — skills + agent profiles + plugins compose through the real bootstrap -> AgentLoop wiring (§3.3.6)", () => {
  let tmpWorkspace: string | undefined;
  let tmpHome: string | undefined;
  let manager: McpManager | undefined;

  afterEach(async () => {
    // try/finally-equivalent cleanup: runs even when an assertion above threw,
    // so the fixture child is never left orphaned by a failing test.
    if (manager) {
      await manager.dispose();
      manager = undefined;
    }
    if (tmpWorkspace) {
      await rm(tmpWorkspace, { recursive: true, force: true });
      tmpWorkspace = undefined;
    }
    if (tmpHome) {
      await rm(tmpHome, { recursive: true, force: true });
      tmpHome = undefined;
    }
  });

  it(
    "one session: Skill body lands in history, Agent(profile) runs re-proving both non-recursion locks, " +
      "the plugin-bridged MCP tool asks -> allows -> returns, and dispose leaves the plugin child pid dead",
    async () => {
      // --- Fixture tree: a skill, an agent profile, and a plugin declaring the
      // real fixture MCP server, exactly the three local-config forms §3.7 discovers. ---
      tmpWorkspace = await mkdtemp(join(tmpdir(), "anycode-ext-integration-ws-"));
      tmpHome = await mkdtemp(join(tmpdir(), "anycode-ext-integration-home-"));

      const skillDir = join(tmpWorkspace, ".anycode", "skills", "demo-skill");
      await mkdir(skillDir, { recursive: true });
      const skillPath = join(skillDir, "SKILL.md");
      await writeFile(
        skillPath,
        [
          "---",
          "name: demo-skill",
          "description: A demo skill proving the composed skill-load path.",
          "---",
          "SKILL BODY MARKER: follow these distinctive review instructions precisely.",
          "",
        ].join("\n"),
      );

      const agentsDir = join(tmpWorkspace, ".anycode", "agents");
      await mkdir(agentsDir, { recursive: true });
      await writeFile(
        join(agentsDir, "reviewer.md"),
        [
          "---",
          "name: reviewer",
          "description: A restricted-tool review profile.",
          "tools: Read, Grep",
          "---",
          "REVIEWER PROFILE SYSTEM PROMPT — conduct a careful, narrow review.",
          "",
        ].join("\n"),
      );

      const pluginRoot = join(tmpWorkspace, ".anycode", "plugins", "greeter");
      await mkdir(join(pluginRoot, ".anycode-plugin"), { recursive: true });
      await writeFile(
        join(pluginRoot, ".anycode-plugin", "plugin.json"),
        JSON.stringify({
          name: "greeter",
          mcpServers: {
            echoer: { command: process.execPath, args: [FIXTURE] },
          },
        }),
      );

      // --- discoverExtensions: the ONE aggregator both CLI and host wire (§3.7) ---
      const ext = await discoverExtensions(new NodeFileSystemAdapter(), {
        workspace: tmpWorkspace,
        home: tmpHome,
        claimedMcpNames: new Set(),
      });

      expect(ext.problems).toEqual([]);
      expect(ext.skills.list()).toEqual([
        {
          name: "demo-skill",
          description: "A demo skill proving the composed skill-load path.",
          source: "project",
          path: skillPath,
        },
      ]);
      expect(ext.profiles).toEqual([
        {
          name: "reviewer",
          description: "A restricted-tool review profile.",
          tools: ["Read", "Grep"],
          // The trailing newline from the written file's body survives capUtf8Bytes
          // (only an all-whitespace body is replaced with a placeholder, §3.5).
          systemPrompt: "REVIEWER PROFILE SYSTEM PROMPT — conduct a careful, narrow review.\n",
        },
      ]);
      const reviewerPersona = ext.profiles[0]!;
      expect(ext.pluginMcpServerSpecs).toHaveLength(1);
      const pluginSpec = asStdio(ext.pluginMcpServerSpecs[0]!);
      expect(pluginSpec.name).toBe("plugin_greeter_echoer");
      expect(pluginSpec.cwd).toBe(pluginRoot);

      // --- Start the MCP manager with ONLY the plugin-declared server (mirrors
      // the real wiring's single manager.start([...explicitSpecs, ...ext.pluginMcpServerSpecs])). ---
      const registry = createDefaultToolRegistry();
      const factory = new CapturingRealFactory();
      manager = new McpManager({ registry, transports: factory });
      await manager.start([...ext.pluginMcpServerSpecs]);

      const pid = factory.transport?.pid;
      expect(pid).toBeTruthy();
      expect(isPidAlive(pid!)).toBe(true);
      const echoToolName = "mcp__plugin_greeter_echoer__echo";
      expect(registry.has(echoToolName)).toBe(true);

      // --- Real AgentLoop wiring (mirrors cli/main.ts's withSubagents + skills + systemPrompt block) ---
      const brokerCalls: PermissionRequest[] = [];
      const broker: PermissionBroker = {
        requestPermission: async (request): Promise<PermissionDecision> => {
          brokerCalls.push(request);
          return { behavior: "allow" };
        },
      };

      const ECHO_MESSAGE = "hello-from-composed-integration";
      let parentStep = 0;
      const model = new ScriptedModelPort((req) => {
        // The child's request embeds the profile's systemPrompt inside the harness
        // prelude (buildChildConfig -> buildSubagentSystemPrompt, slice 3.6) —
        // distinct from the parent's identity+skills prompt, so a substring match
        // routes parent vs. child steps deterministically.
        if (req.system?.includes(reviewerPersona.systemPrompt) ?? false) {
          return textStep("reviewer child report");
        }
        parentStep += 1;
        switch (parentStep) {
          case 1:
            return toolStep("call-skill", "Skill", { name: "demo-skill" });
          case 2:
            return toolStep("call-agent", "Agent", {
              description: "review the change",
              prompt: "please review",
              agent_type: "reviewer",
            });
          case 3:
            return toolStep("call-echo", echoToolName, { message: ECHO_MESSAGE });
          default:
            return textStep("composed session done");
        }
      });

      const parentConfig: AgentLoopConfig = {
        modelPort: model,
        registry,
        hooks: new InMemoryHookRunner(),
        permissionEngine: new ModePermissionEngine(),
        permissionBroker: broker,
        mode: "auto", // riskLevel:"high" -> "ask" (design §2.8/permissions/engine.ts); readOnly tools -> allow
        ports: makePorts(),
        cwd: tmpWorkspace,
        systemPrompt: buildSystemPrompt() + ext.skillsPromptSection,
        skills: ext.skills,
      };
      const loop = new AgentLoop(withSubagents(parentConfig, { profiles: ext.profiles }));

      const events: AgentEvent[] = [];
      for await (const event of loop.runTurn(
        "drive the skill, the profile agent, and the plugin mcp tool",
      )) {
        events.push(event);
      }

      // --- (a) Skill: the body lands in the model-visible history ---
      const skillResult = events.find((e) => e.type === "tool_result" && e.outcome.toolName === "Skill");
      expect(skillResult?.type === "tool_result" && skillResult.outcome.status).toBe("success");
      expect(skillResult?.type === "tool_result" && skillResult.outcome.modelText).toContain(
        "SKILL BODY MARKER",
      );
      const toolMessageParts = loop.history
        .toMessages()
        .filter((m) => m.role === "tool")
        .flatMap((m) => (m.role === "tool" ? m.content : []));
      const skillHistoryPart = toolMessageParts.find((p) => p.toolName === "Skill");
      expect(skillHistoryPart?.text).toContain("SKILL BODY MARKER");
      expect(skillHistoryPart?.status).toBe("success");

      // --- (b) Agent(profile): the child ran and reported back; both
      // non-recursion locks re-proved directly on the SAME parent config/persona
      // (mirrors subagents/runner.test.ts's "buildChildConfig on a profile
      // re-proves BOTH non-recursion locks"). ---
      const agentResult = events.find((e) => e.type === "tool_result" && e.outcome.toolName === "Agent");
      expect(agentResult?.type === "tool_result" && agentResult.outcome.status).toBe("success");
      expect(agentResult?.type === "tool_result" && agentResult.outcome.modelText).toBe(
        "reviewer child report",
      );
      const subagentStart = events.find((e) => e.type === "subagent_start");
      expect(subagentStart?.type === "subagent_start" && subagentStart.agentType).toBe("reviewer");
      const subagentEnd = events.find((e) => e.type === "subagent_end");
      expect(subagentEnd?.type === "subagent_end" && subagentEnd.status).toBe("completed");

      const childConfig = buildChildConfig(parentConfig, reviewerPersona, {
        agentType: "reviewer",
        description: "lock re-proof",
        prompt: "n/a",
      });
      expect(childConfig.registry.has("Agent")).toBe(false); // lock #1 (structural, Agent never registered)
      expect(childConfig.registry.has("Skill")).toBe(false); // ∩ with the profile's Read/Grep-only allowlist
      expect(childConfig.subagents).toBeUndefined(); // lock #2 (defense in depth)

      // --- (c) Plugin-bridged MCP tool: a real "ask" reaches the broker mock,
      // then the real fixture child answers through the full dispatch pipeline. ---
      const echoResult = events.find((e) => e.type === "tool_result" && e.outcome.toolName === echoToolName);
      expect(echoResult?.type === "tool_result" && echoResult.outcome.status).toBe("success");
      expect(echoResult?.type === "tool_result" && echoResult.outcome.modelText).toContain(ECHO_MESSAGE);
      // Skill/Agent are readOnly + needsApproval:false -> never reach the broker;
      // only the fail-closed high-risk mcp tool does (byte-identical to §4.3's table).
      expect(brokerCalls).toHaveLength(1);
      expect(brokerCalls[0]?.toolName).toBe(echoToolName);

      // --- Loop invariant re-proved on the composed session (§2.10 THE INVARIANT) ---
      const loopEnd = events.at(-1);
      expect(loopEnd?.type === "loop_end" && loopEnd.reason).toBe("completed");
      expect(loop.history.unansweredToolCallIds()).toEqual([]);

      // --- Orphan proof: dispose() leaves the plugin child ACTUALLY dead, on the
      // composed session (re-proves the 3.2 kill-discipline through the plugin path). ---
      await manager.dispose();
      manager = undefined;
      await waitForDead(pid!);
      expect(isPidAlive(pid!)).toBe(false);
    },
    20_000,
  );
});
