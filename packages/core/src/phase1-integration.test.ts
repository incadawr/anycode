/**
 * Phase 1 end-to-end integration (design §2.10): the reworked AgentLoop wired to
 * REAL wave-1 components — ConversationHistory + ContextManager (compaction),
 * runToolBatches (parallel read-only batches), the dispatcher, InMemoryHookRunner
 * (UserPromptSubmit/Stop), ModePermissionEngine — driven by a scripted ModelPort
 * over a real temp directory. Proves the integration invariants the loop owns:
 *   - parallel batch (Read+Grep+Glob): events flow, history in proposal order;
 *   - cancel mid-batch: every call gets an outcome and unansweredToolCallIds() is
 *     [] on the exit path (regression for the latent MVP defect R3);
 *   - forced compaction mid-session: the next step sees summary + verbatim tail,
 *     tool_call/tool_result pairs intact;
 *   - invalid tool-call: an invalid_input outcome plus input:{} in history;
 *   - resume: a loop seeded from prior history continues and persists via a sink;
 *   - UserPromptSubmit context lands inside the written user message.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import {
  AgentLoop,
  AllowAllPermissionBroker,
  ConversationHistory,
  InMemoryHookRunner,
  InMemoryTodoStore,
  ModePermissionEngine,
  NodeExecutionAdapter,
  NodeFileSystemAdapter,
  NodeHttpAdapter,
  createDefaultToolRegistry,
} from "./index.js";
import type { AgentEvent, ModelStreamEvent, TokenUsage } from "./types/index.js";
import type { ChatMessage, HistoryItem } from "./types/index.js";
import type {
  AnyToolDefinition,
  ToolContext,
  ToolMetadata,
  ToolResult,
} from "./types/index.js";
import type { HistorySink } from "./context/history.js";
import type { ModelPort, ModelRequest } from "./ports/index.js";

// ---------------------------------------------------------------------------
// Scripted model port. One scripted step per streamText call whose request
// carries tools; a compaction call (tools: []) instead replays a fixed summary
// so ContextManager.runCompaction can be exercised deterministically.

class ScriptedModelPort implements ModelPort {
  private call = 0;
  readonly requests: ModelRequest[] = [];

  constructor(
    private readonly scripts: ModelStreamEvent[][],
    private readonly compactionSummary?: string,
  ) {}

  async *streamText(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    // Compaction uses tools: []; every real model step carries the tool set.
    if (this.compactionSummary !== undefined && request.tools.length === 0) {
      yield { type: "start" };
      yield { type: "text_delta", id: "s", text: this.compactionSummary };
      yield { type: "finish", finishReason: "stop", usage: {} };
      return;
    }
    const script = this.scripts[this.call] ?? [
      { type: "finish", finishReason: "stop", usage: {} },
    ];
    this.call += 1;
    for (const event of script) {
      if (request.abortSignal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      yield event;
    }
  }
}

function toolCall(id: string, name: string, input: unknown): ModelStreamEvent {
  return { type: "tool_call", toolCall: { id, name, input } };
}

function toolStep(...calls: ModelStreamEvent[]): ModelStreamEvent[] {
  return [{ type: "start" }, ...calls, { type: "finish", finishReason: "tool_calls", usage: {} }];
}

function textStep(text: string, usage: TokenUsage = {}): ModelStreamEvent[] {
  return [
    { type: "start" },
    { type: "text_delta", id: "t1", text },
    { type: "finish", finishReason: "stop", usage },
  ];
}

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function ports() {
  return {
    fs: new NodeFileSystemAdapter(),
    exec: new NodeExecutionAdapter(),
    http: new NodeHttpAdapter(),
    todos: new InMemoryTodoStore(),
  };
}

function item(message: ChatMessage): HistoryItem {
  return { id: globalThis.crypto.randomUUID(), createdAt: Date.now(), message };
}

/** Recording sink so resume tests can observe write-behind persistence calls. */
class RecordingSink implements HistorySink {
  readonly appended: HistoryItem[][] = [];
  readonly replaced: HistoryItem[][] = [];
  append(items: readonly HistoryItem[]): void {
    this.appended.push([...items]);
  }
  replaceAll(items: readonly HistoryItem[]): void {
    this.replaced.push([...items]);
  }
  async flush(): Promise<void> {}
}

const toolResults = (events: AgentEvent[]) =>
  events.filter((e): e is Extract<AgentEvent, { type: "tool_result" }> => e.type === "tool_result");

describe("phase 1 integration", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "anycode-p1-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("runs a parallel Read+Grep+Glob batch: events flow, history stays in proposal order", async () => {
    const fileA = join(dir, "a.txt");
    const fileB = join(dir, "b.txt");
    await writeFile(fileA, "hello alpha\n", "utf8");
    await writeFile(fileB, "hello beta\n", "utf8");

    const model = new ScriptedModelPort([
      toolStep(
        toolCall("c1", "Read", { file_path: fileA }),
        toolCall("c2", "Grep", { pattern: "hello", path: dir }),
        toolCall("c3", "Glob", { pattern: "*.txt", path: dir }),
      ),
      textStep("done"),
    ]);

    const loop = new AgentLoop({
      modelPort: model,
      registry: createDefaultToolRegistry(),
      hooks: new InMemoryHookRunner(),
      permissionEngine: new ModePermissionEngine(),
      permissionBroker: new AllowAllPermissionBroker(),
      mode: "yolo",
      ports: ports(),
      cwd: dir,
      systemPrompt: "test",
    });

    const events = await collect(loop.runTurn("investigate"));

    // Three tool_execution_start + three tool_result events (one per call).
    expect(events.filter((e) => e.type === "tool_execution_start")).toHaveLength(3);
    const results = toolResults(events);
    expect(results).toHaveLength(3);
    expect(results.every((e) => e.outcome.status === "success")).toBe(true);

    // History carries the tool results in PROPOSAL order regardless of completion.
    const messages = loop.history.toMessages();
    const toolMsgs = messages.filter(
      (m): m is Extract<ChatMessage, { role: "tool" }> => m.role === "tool",
    );
    expect(toolMsgs.map((m) => m.content[0]!.toolName)).toEqual(["Read", "Grep", "Glob"]);

    // The assistant message proposed all three calls; every one is answered.
    expect(loop.history.unansweredToolCallIds()).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: "loop_end", reason: "completed" });
  });

  it("cancels mid-batch: every call gets an outcome, no dangling tool_call (R3)", async () => {
    const controller = new AbortController();

    // A read-only, concurrent-safe tool that aborts the turn the moment it runs,
    // then blocks until its (linked) signal fires — forcing a mid-batch cancel.
    const blockMeta: ToolMetadata = {
      name: "Block",
      description: "test blocker",
      readOnly: true,
      destructive: false,
      concurrentSafe: true,
      riskLevel: "low",
      sideEffectScope: "none",
      needsApproval: false,
      timeoutMs: 5_000,
    };
    const blockTool: AnyToolDefinition = {
      metadata: blockMeta,
      // Accept any object input.
      inputSchema: z.object({}).passthrough(),
      handler: (_input: unknown, ctx: ToolContext) =>
        new Promise<ToolResult>((_, reject) => {
          controller.abort("user-cancel");
          if (ctx.abortSignal.aborted) {
            reject(new Error("aborted"));
            return;
          }
          ctx.abortSignal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    };

    const fileA = join(dir, "a.txt");
    await writeFile(fileA, "hello\n", "utf8");

    const registry = createDefaultToolRegistry();
    registry.register(blockTool, { silentDuplicateWarning: true });

    const model = new ScriptedModelPort([
      // Read + Block + Read: all concurrent-safe -> a single parallel batch.
      toolStep(
        toolCall("c1", "Read", { file_path: fileA }),
        toolCall("c2", "Block", {}),
        toolCall("c3", "Read", { file_path: fileA }),
      ),
      textStep("unreached"),
    ]);

    const loop = new AgentLoop({
      modelPort: model,
      registry,
      hooks: new InMemoryHookRunner(),
      permissionEngine: new ModePermissionEngine(),
      permissionBroker: new AllowAllPermissionBroker(),
      mode: "yolo",
      ports: ports(),
      cwd: dir,
      systemPrompt: "test",
    });

    const events = await collect(loop.runTurn("go", { signal: controller.signal }));

    // Every proposed call produced exactly one outcome (real or cancelled).
    const answered = new Set(toolResults(events).map((e) => e.outcome.toolCallId));
    expect(answered).toEqual(new Set(["c1", "c2", "c3"]));

    // THE invariant on the exit path: no assistant tool_call is left unanswered.
    expect(loop.history.unansweredToolCallIds()).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: "loop_end", reason: "cancelled" });
    // The blocker itself was cancelled, not run to a result.
    const block = toolResults(events).find((e) => e.outcome.toolName === "Block");
    expect(block?.outcome.status).toBe("cancelled");
  });

  it("forces compaction mid-session: next step sees summary + verbatim tail, pairs intact", async () => {
    const long = (label: string) => `${label}: ${"context ".repeat(30)}`;

    // Seeded prior history (resume shape). The tool_call/tool_result pair (i1/i2)
    // lives in the prefix that compaction will summarize away.
    const seeded = new ConversationHistory({
      initial: [
        item({ role: "user", content: long("u0 investigate the parser bug") }),
        item({
          role: "assistant",
          content: [{ type: "tool_call", toolCallId: "old1", toolName: "Grep", input: { pattern: "x" } }],
        }),
        item({
          role: "tool",
          content: [
            { type: "tool_result", toolCallId: "old1", toolName: "Grep", text: long("match"), status: "success" },
          ],
        }),
        item({ role: "assistant", content: [{ type: "text", text: long("a3 found the cause") }] }),
        item({ role: "user", content: long("u1 now fix it") }),
        item({ role: "assistant", content: [{ type: "text", text: long("a5 on it") }] }),
      ],
    });

    const summaryText = "Earlier: user asked to fix a parser bug; cause found; proceeding.";
    const model = new ScriptedModelPort([textStep("compaction done")], summaryText);

    const loop = new AgentLoop({
      modelPort: model,
      registry: createDefaultToolRegistry(),
      hooks: new InMemoryHookRunner(),
      permissionEngine: new ModePermissionEngine(),
      permissionBroker: new AllowAllPermissionBroker(),
      mode: "yolo",
      ports: ports(),
      cwd: dir,
      systemPrompt: "test",
      history: seeded,
      // Tiny window so token pressure trips compaction on the first iteration.
      context: {
        contextWindowTokens: 200,
        outputReserveTokens: 100,
        compactThresholdPercent: 100,
        compactBufferTokens: 0,
        keepRecentMessages: 2,
      },
    });

    const events = await collect(loop.runTurn("continue"));

    // Compaction ran and succeeded.
    const start = events.find((e) => e.type === "compaction_start");
    const end = events.find(
      (e): e is Extract<AgentEvent, { type: "compaction_end" }> => e.type === "compaction_end",
    );
    expect(start).toBeTruthy();
    expect(end?.ok).toBe(true);

    // History was rewritten to [summary, ...verbatim tail].
    const items = loop.history.items;
    expect(items[0]!.kind).toBe("compact_summary");
    const summaryMsg = items[0]!.message;
    expect(summaryMsg.role).toBe("user");
    expect(summaryMsg.role === "user" && summaryMsg.content).toContain(summaryText);

    // The pre-compaction tool pair (old1) was summarized away; nothing dangles.
    expect(loop.history.unansweredToolCallIds()).toEqual([]);

    // The real model step (tools present) saw the summary as its first message.
    const realRequest = model.requests.find((r) => r.tools.length > 0);
    expect(realRequest).toBeTruthy();
    const first = realRequest!.messages[0]!;
    expect(first.role).toBe("user");
    expect(first.role === "user" && first.content).toContain(summaryText);

    expect(events.at(-1)).toMatchObject({ type: "loop_end", reason: "completed" });
  });

  it("synthesizes an invalid_input outcome and stores input:{} for an invalid tool-call", async () => {
    const model = new ScriptedModelPort([
      [
        { type: "start" },
        {
          type: "tool_call",
          toolCall: {
            id: "bad1",
            name: "Read",
            input: '{"file_path": ',
            invalid: { reason: "unterminated JSON" },
          },
        },
        { type: "finish", finishReason: "tool_calls", usage: {} },
      ],
      textStep("recovered"),
    ]);

    const loop = new AgentLoop({
      modelPort: model,
      registry: createDefaultToolRegistry(),
      hooks: new InMemoryHookRunner(),
      permissionEngine: new ModePermissionEngine(),
      permissionBroker: new AllowAllPermissionBroker(),
      mode: "yolo",
      ports: ports(),
      cwd: dir,
      systemPrompt: "test",
    });

    const events = await collect(loop.runTurn("read something"));

    const result = toolResults(events).find((e) => e.outcome.toolCallId === "bad1");
    expect(result?.outcome.status).toBe("invalid_input");
    expect(result?.outcome.modelText).toMatch(/malformed JSON/i);

    // The assistant tool_call was written with input sanitized to {} (valid JSON).
    const messages = loop.history.toMessages();
    const assistant = messages.find(
      (m): m is Extract<ChatMessage, { role: "assistant" }> => m.role === "assistant",
    );
    const callPart = assistant!.content.find(
      (p): p is Extract<typeof p, { type: "tool_call" }> => p.type === "tool_call",
    );
    expect(callPart!.input).toEqual({});

    // Paired and answered; the model got a second step to recover.
    expect(loop.history.unansweredToolCallIds()).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: "loop_end", reason: "completed" });
  });

  it("resumes from seeded history and continues, persisting new items to the sink", async () => {
    const sink = new RecordingSink();
    const resumed = new ConversationHistory({
      initial: [
        item({ role: "user", content: "earlier request" }),
        item({ role: "assistant", content: [{ type: "text", text: "earlier reply" }] }),
      ],
      sink,
    });

    const model = new ScriptedModelPort([textStep("continued")]);

    const loop = new AgentLoop({
      modelPort: model,
      registry: createDefaultToolRegistry(),
      hooks: new InMemoryHookRunner(),
      permissionEngine: new ModePermissionEngine(),
      permissionBroker: new AllowAllPermissionBroker(),
      mode: "yolo",
      ports: ports(),
      cwd: dir,
      systemPrompt: "test",
      history: resumed,
    });

    await collect(loop.runTurn("follow-up"));

    // The model's first request carried the resumed history ahead of the new turn.
    const firstRequest = model.requests.find((r) => r.tools.length > 0)!;
    expect(firstRequest.messages[0]).toEqual({ role: "user", content: "earlier request" });
    expect(firstRequest.messages.some((m) => m.role === "user" && m.content === "follow-up")).toBe(
      true,
    );

    // New items (user follow-up + assistant reply) were queued to the sink.
    const appendedMessages = sink.appended.flat().map((i) => i.message);
    expect(appendedMessages).toContainEqual({ role: "user", content: "follow-up" });
    expect(loop.history.unansweredToolCallIds()).toEqual([]);
  });

  it("appends UserPromptSubmit additionalContext inside the written user message", async () => {
    const hooks = new InMemoryHookRunner();
    hooks.register({
      event: "UserPromptSubmit",
      hook: async () => ({ additionalContext: "INJECTED-CONTEXT" }),
    });

    const model = new ScriptedModelPort([textStep("ok")]);

    const loop = new AgentLoop({
      modelPort: model,
      registry: createDefaultToolRegistry(),
      hooks,
      permissionEngine: new ModePermissionEngine(),
      permissionBroker: new AllowAllPermissionBroker(),
      mode: "yolo",
      ports: ports(),
      cwd: dir,
      systemPrompt: "test",
    });

    await collect(loop.runTurn("do the thing"));

    const messages = loop.history.toMessages();
    const user = messages.find(
      (m): m is Extract<ChatMessage, { role: "user" }> => m.role === "user",
    );
    expect(user!.content).toContain("do the thing");
    expect(user!.content).toContain("<hook-context>");
    expect(user!.content).toContain("INJECTED-CONTEXT");
    expect(user!.content).toContain("</hook-context>");
  });
});
