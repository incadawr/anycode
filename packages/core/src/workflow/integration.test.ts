/**

 * §10 DoD). Every per-lane test already proves ONE path in isolation:
 * workflow/engine.test.ts drives a real createSubagentRunner directly against
 * the engine, and extensions/bootstrap.ts's discoverExtensions is proven by
 * extensions/integration.test.ts (slice 3.3.6). This file is the ONLY test
 * that wires discovery -> withSubagents -> withWorkflows -> a real AgentLoop
 * session -> the Workflow tool -> the engine -> real subagent children, in
 * that order, mirroring cli/main.ts's wiring verbatim (design §6):
 *   discoverExtensions() -> new AgentLoop(withWorkflows(withSubagents({...,
 *     systemPrompt: buildSystemPrompt() + ext.skillsPromptSection +
 *     ext.workflowsPromptSection }, { profiles: ext.profiles }), ext.workflows)).
 *
 * Hermetic: a tmpdir workspace holds a real `.anycode/workflows/*.json`
 * definition (the on-disk convention workflow/discovery.ts scans); a
 * ScriptedModelPort (no live model, no network) drives one parent turn that
 * calls the Workflow tool, whose three real child AgentLoops (general-purpose,
 * a built-in persona — no md-profile needed for this lane) are each driven by
 * the SAME scripted port, routed by system prompt + prompt content. The orphan
 * proof re-uses engine.test.ts's discipline: aborting the run mid-flight through
 * the composed path must leave the step child's real Bash process ACTUALLY dead.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverExtensions } from "../extensions/bootstrap.js";
import { NodeFileSystemAdapter } from "../adapters/node/node-file-system.js";
import { NodeExecutionAdapter } from "../adapters/node/node-execution.js";
import { createDefaultToolRegistry } from "../tools/registry.js";
import { InMemoryTodoStore } from "../tools/todo-store.js";
import { InMemoryHookRunner } from "../dispatch/hook-runner.js";
import { ModePermissionEngine, DenyPermissionBroker } from "../permissions/index.js";
import { AgentLoop, type AgentLoopConfig } from "../loop/agent-loop.js";
import { withSubagents } from "../subagents/runner.js";
import { getPersona } from "../subagents/personas.js";
import { buildSystemPrompt } from "../prompts/identity.js";
import { withWorkflows } from "./engine.js";
import type { AgentEvent, ModelStreamEvent } from "../types/events.js";
import type { ModelPort, ModelRequest } from "../ports/model.js";
import type { CorePorts, ExecutionPort, FileSystemPort, HttpPort } from "../ports/index.js";
import type { WorkflowOutput } from "../tools/schemas.js";

// ---------------------------------------------------------------------------
// Local helpers (mirror workflow/engine.test.ts's / extensions/integration.test.ts's
// per-file ScriptedModelPort pattern; each test file owns its own copy).

type ModelScript = (req: ModelRequest) => ModelStreamEvent[];

class ScriptedModelPort implements ModelPort {
  readonly requests: ModelRequest[] = [];
  constructor(private readonly script: ModelScript) {}

  streamText(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
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

function lastUserText(req: ModelRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i -= 1) {
    const message = req.messages[i];
    if (message && message.role === "user") return message.content;
  }
  return "";
}

function makePorts(overrides: Partial<CorePorts> = {}): CorePorts {
  return {
    fs: {} as FileSystemPort,
    exec: {} as ExecutionPort,
    http: {} as HttpPort,
    todos: new InMemoryTodoStore(),
    ...overrides,
  };
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await stat(path);
      return;
    } catch {
      // not yet
    }
    if (Date.now() > deadline) {
      throw new Error(`file ${path} did not appear within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The built-in general-purpose persona's placeholder system prompt — a child
 * step's request embeds this inside the harness prelude (buildChildConfig ->
 * buildSubagentSystemPrompt, slice 3.6), distinct from the parent's
 * identity+workflows prompt, so a substring match routes parent vs. child. */
const GENERAL_PURPOSE_SYSTEM_PROMPT = getPersona("general-purpose").systemPrompt;

// ===========================================================================

describe("workflow integration — discovery -> Workflow tool -> engine compose through a real AgentLoop session (§3.4.6)", () => {
  let tmpWorkspace: string | undefined;
  let tmpHome: string | undefined;

  afterEach(async () => {
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
    "a discovered 3-step chain runs through the real SubagentPort, threads each step's real output into the next's prompt, " +
      "emits workflow_* in order, and lands the rendered result in the parent's history",
    async () => {
      tmpWorkspace = await mkdtemp(join(tmpdir(), "anycode-workflow-integration-ws-"));
      tmpHome = await mkdtemp(join(tmpdir(), "anycode-workflow-integration-home-"));

      // --- Fixture: a real .anycode/workflows/*.json definition, the on-disk
      // convention workflow/discovery.ts scans (project root, flat *.json). ---
      const workflowsDir = join(tmpWorkspace, ".anycode", "workflows");
      await mkdir(workflowsDir, { recursive: true });
      await writeFile(
        join(workflowsDir, "demo-pipeline.json"),
        JSON.stringify({
          name: "demo-pipeline",
          description: "Gathers, summarizes, and finalizes a report across three scoped steps.",
          steps: [
            { id: "gather", agentType: "general-purpose", promptTemplate: "${input}" },
            {
              id: "summarize",
              agentType: "general-purpose",
              promptTemplate: "summarize ${steps.gather}",
              dependsOn: ["gather"],
            },
            {
              id: "finalize",
              agentType: "general-purpose",
              promptTemplate: "finalize ${steps.summarize}",
              dependsOn: ["summarize"],
            },
          ],
        }),
      );

      // --- discoverExtensions: the ONE aggregator both CLI and host wire (§0.1/§2.9) ---
      const ext = await discoverExtensions(new NodeFileSystemAdapter(), {
        workspace: tmpWorkspace,
        home: tmpHome,
        claimedMcpNames: new Set(),
      });

      expect(ext.problems).toEqual([]);
      expect(ext.workflows.map((wf) => wf.name)).toEqual(["demo-pipeline"]);
      expect(ext.workflowsPromptSection.length).toBeGreaterThan(0);
      expect(ext.workflowsPromptSection).toContain("demo-pipeline");

      // --- Real AgentLoop wiring: mirrors cli/main.ts's withWorkflows(withSubagents(...),
      // ext.workflows) order verbatim (design §6). ---
      const INPUT_TEXT = "assess the repo";

      let parentStep = 0;
      const model = new ScriptedModelPort((req) => {
        if ((req.system?.includes(GENERAL_PURPOSE_SYSTEM_PROMPT) ?? false)) {
          const text = lastUserText(req);
          if (text.startsWith("summarize ")) return textStep(`summary:${text}`);
          if (text.startsWith("finalize ")) return textStep(`final:${text}`);
          return textStep(`gathered:${text}`); // the source step sees ${input} verbatim
        }
        parentStep += 1;
        switch (parentStep) {
          case 1:
            return toolStep("call-workflow", "Workflow", { name: "demo-pipeline", input: INPUT_TEXT });
          default:
            return textStep("composed session done");
        }
      });

      const config: AgentLoopConfig = {
        modelPort: model,
        registry: createDefaultToolRegistry(),
        hooks: new InMemoryHookRunner(),
        permissionEngine: new ModePermissionEngine(),
        permissionBroker: new DenyPermissionBroker(),
        mode: "build", // Workflow is readOnly + needsApproval:false -> allowed without the broker
        ports: makePorts(),
        cwd: tmpWorkspace,
        systemPrompt: buildSystemPrompt() + ext.skillsPromptSection + ext.workflowsPromptSection,
      };
      const loop = new AgentLoop(
        withWorkflows(withSubagents(config, { profiles: ext.profiles }), ext.workflows),
      );

      const events: AgentEvent[] = [];
      for await (const event of loop.runTurn("run the demo-pipeline workflow")) {
        events.push(event);
      }

      // --- Workflow tool result: completed, DAG output threaded through all three real steps ---
      const workflowResult = events.find(
        (e) => e.type === "tool_result" && e.outcome.toolName === "Workflow",
      );
      expect(workflowResult?.type === "tool_result" && workflowResult.outcome.status).toBe("success");
      const expectedOutput = `final:finalize summary:summarize gathered:${INPUT_TEXT}`;
      expect(workflowResult?.type === "tool_result" && workflowResult.outcome.modelText).toBe(
        expectedOutput,
      );

      // --- Template-from-prior-output on the REAL composed path: the "summarize" and
      // "finalize" children's actual model requests carried their predecessor's real
      // finalText substituted in (not a fake port's canned value). ---
      const summarizeReq = model.requests.find(
        (req) => (req.system?.includes(GENERAL_PURPOSE_SYSTEM_PROMPT) ?? false) && lastUserText(req).startsWith("summarize "),
      );
      expect(summarizeReq && lastUserText(summarizeReq)).toBe(`summarize gathered:${INPUT_TEXT}`);
      const finalizeReq = model.requests.find(
        (req) => (req.system?.includes(GENERAL_PURPOSE_SYSTEM_PROMPT) ?? false) && lastUserText(req).startsWith("finalize "),
      );
      expect(finalizeReq && lastUserText(finalizeReq)).toBe(
        `finalize summary:summarize gathered:${INPUT_TEXT}`,
      );
      const childCalls = model.requests.filter((req) => (req.system?.includes(GENERAL_PURPOSE_SYSTEM_PROMPT) ?? false));
      expect(childCalls).toHaveLength(3); // exactly the workflow's three steps — no extra spawns

      // --- The five workflow_* progress kinds reached the transcript, start..end, in order ---
      const workflowEventTypes = events.map((e) => e.type).filter((type) => type.startsWith("workflow_"));
      expect(workflowEventTypes[0]).toBe("workflow_start");
      expect(workflowEventTypes.at(-1)).toBe("workflow_end");
      expect(workflowEventTypes).toContain("workflow_step_start");
      expect(workflowEventTypes).toContain("workflow_step_progress");
      expect(workflowEventTypes).toContain("workflow_step_end");

      // Step start/end fire once per step, in DAG (= definition, for a chain) order.
      const stepStarts = events.filter(
        (e): e is Extract<AgentEvent, { type: "workflow_step_start" }> => e.type === "workflow_step_start",
      );
      expect(stepStarts.map((e) => e.stepId)).toEqual(["gather", "summarize", "finalize"]);
      const stepEnds = events.filter(
        (e): e is Extract<AgentEvent, { type: "workflow_step_end" }> => e.type === "workflow_step_end",
      );
      expect(stepEnds.map((e) => e.stepId)).toEqual(["gather", "summarize", "finalize"]);
      expect(stepEnds.every((e) => e.status === "completed")).toBe(true);
      const endEvent = events.find(
        (e): e is Extract<AgentEvent, { type: "workflow_end" }> => e.type === "workflow_end",
      );
      expect(endEvent).toMatchObject({ status: "completed", completedSteps: 3, totalSteps: 3 });

      // --- The rendered result landed in the model-visible history (verbatim, not just the emitted event) ---
      const toolMessageParts = loop.history
        .toMessages()
        .filter((m) => m.role === "tool")
        .flatMap((m) => (m.role === "tool" ? m.content : []));
      const workflowHistoryPart = toolMessageParts.find((p) => p.toolName === "Workflow");
      expect(workflowHistoryPart?.text).toBe(expectedOutput);
      expect(workflowHistoryPart?.status).toBe("success");

      // --- Loop invariant re-proved on the composed workflow session (§2.10 THE INVARIANT) ---
      const loopEnd = events.at(-1);
      expect(loopEnd?.type === "loop_end" && loopEnd.reason).toBe("completed");
      expect(loop.history.unansweredToolCallIds()).toEqual([]);
    },
    20_000,
  );
});

// ===========================================================================

describe("workflow integration — orphan safety on the composed discovery -> Workflow tool -> engine path (§3.4.6)", () => {
  let tmpWorkspace: string | undefined;
  let tmpHome: string | undefined;

  afterEach(async () => {
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
    "aborting the parent turn mid-run tears down the step child's real Bash process (no orphan), through the full composed path",
    async () => {
      tmpWorkspace = await mkdtemp(join(tmpdir(), "anycode-workflow-integration-orphan-ws-"));
      tmpHome = await mkdtemp(join(tmpdir(), "anycode-workflow-integration-orphan-home-"));

      const workflowsDir = join(tmpWorkspace, ".anycode", "workflows");
      await mkdir(workflowsDir, { recursive: true });
      await writeFile(
        join(workflowsDir, "sleeper.json"),
        JSON.stringify({
          name: "sleeper-wf",
          description: "One step that sleeps so a mid-run abort can be proven orphan-free.",
          steps: [{ id: "sleep-step", agentType: "general-purpose", promptTemplate: "${input}" }],
        }),
      );

      const ext = await discoverExtensions(new NodeFileSystemAdapter(), {
        workspace: tmpWorkspace,
        home: tmpHome,
        claimedMcpNames: new Set(),
      });
      expect(ext.problems).toEqual([]);
      expect(ext.workflows.map((wf) => wf.name)).toEqual(["sleeper-wf"]);

      // The step's real child proposes Bash; the parent proposes Workflow. Routed
      // by system prompt exactly like the happy-path test above.
      const model = new ScriptedModelPort((req) =>
        (req.system?.includes(GENERAL_PURPOSE_SYSTEM_PROMPT) ?? false)
          ? toolStep("b1", "Bash", { command: `echo $$ > pid.txt && exec sleep 5` })
          : toolStep("call-workflow", "Workflow", { name: "sleeper-wf", input: "sleep" }),
      );

      const config: AgentLoopConfig = {
        modelPort: model,
        registry: createDefaultToolRegistry(),
        hooks: new InMemoryHookRunner(),
        permissionEngine: new ModePermissionEngine(),
        permissionBroker: new DenyPermissionBroker(),
        mode: "yolo", // allow the step child's Bash call without needing a broker (mirrors engine.test.ts's orphan test)
        ports: makePorts({ exec: new NodeExecutionAdapter() }),
        cwd: tmpWorkspace, // Bash cwd = ctx.cwd, inherited by the step's child (buildChildConfig)
        systemPrompt: buildSystemPrompt() + ext.workflowsPromptSection,
      };
      const loop = new AgentLoop(
        withWorkflows(withSubagents(config, { profiles: ext.profiles }), ext.workflows),
      );

      const controller = new AbortController();
      const events: AgentEvent[] = [];
      const runPromise = (async () => {
        for await (const event of loop.runTurn("run the sleeper workflow", { signal: controller.signal })) {
          events.push(event);
        }
      })();

      const pidFile = join(tmpWorkspace, "pid.txt");
      let pid = Number.NaN;
      try {
        await waitForFile(pidFile, 5_000);
        pid = Number((await readFile(pidFile, "utf-8")).trim());

        controller.abort();
        await runPromise;

        const workflowResult = events.find(
          (e) => e.type === "tool_result" && e.outcome.toolName === "Workflow",
        );
        expect(workflowResult?.type === "tool_result" && workflowResult.outcome.status).toBe("cancelled");
        const output = (workflowResult?.type === "tool_result" &&
          workflowResult.outcome.result?.output) as WorkflowOutput | undefined;
        expect(output?.status).toBe("cancelled");
        expect(output?.steps[0]?.status).toBe("cancelled");

        const loopEnd = events.at(-1);
        expect(loopEnd?.type === "loop_end" && loopEnd.reason).toBe("cancelled");
        expect(loop.history.unansweredToolCallIds()).toEqual([]);

        expect(Number.isNaN(pid)).toBe(false);
        expect(isPidAlive(pid)).toBe(false); // SIGTERM/SIGKILL cascade reached the real process
      } finally {
        // Guarantee no orphan survives even if an assertion above threw.
        await runPromise.catch(() => {});
        if (!Number.isNaN(pid) && isPidAlive(pid)) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // already gone
          }
        }
      }
    },
    20_000,
  );
});
