/**
 * SessionEngine behaviour for the native Claude session (cut §1.4 DoD), driven
 * by REAL W0 fixture frames through the narrow `ClaudeTransport` seam — the seam
 * exists precisely so a lifecycle test needs no child process.
 *
 * The load-bearing assertion in this file is the CONTEXT METER one. Codex's
 * C-bug-1 was a plausible-looking host-side context meter summed out of the
 * turn's own usage fields; it was wrong, and it looked right. Claude's meter is
 * pulled from `get_context_usage` AFTER the terminal `result` instead, and the
 * test below is built so that a regression back to a `result.usage` sum FAILS:
 * the fixture's usage numbers and the transport's `get_context_usage` answer are
 * deliberately disjoint, so the two sources can never be confused for one
 * another by a passing test.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@anycode/core";
import {
  CLAUDE_ENGINE_CAPABILITIES,
  CLAUDE_PRESET_IDS,
  ClaudeEngine,
  type ClaudeEngineTimeouts,
  type ClaudeTransport,
} from "./claude-engine.js";
import { ClaudeModelCatalog } from "./models.js";
import { findClaudePreset } from "./presets.js";
import type { ClaudeStreamMessage } from "./protocol.js";

const FIXTURES_DIR = fileURLToPath(new URL("./contract/fixtures/", import.meta.url));

/**
 * The CLI->host STREAM frames of an envelope fixture, in order. `dir:"out"` is
 * the CLI's stdout; control_request/control_response envelopes are excluded
 * because they belong to the control router, never to the turn stream.
 */
function streamFrames(file: string): ClaudeStreamMessage[] {
  return readFileSync(join(FIXTURES_DIR, file), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { dir?: string; raw?: unknown })
    .filter((entry) => entry.dir === "out")
    .map((entry) => entry.raw as { type?: string })
    .filter((raw) => raw.type !== "control_request" && raw.type !== "control_response")
    .map((raw) => raw as ClaudeStreamMessage);
}

/** The live `initialize` models[] catalog, read out of the fixture that captured it. */
function liveCatalog(): ClaudeModelCatalog {
  const line = readFileSync(join(FIXTURES_DIR, "w0-16-setmodel.jsonl"), "utf8")
    .split("\n")
    .filter((raw) => raw.trim() !== "")
    .map((raw) => JSON.parse(raw) as { raw?: { type?: string; response?: { response?: { models?: unknown } } } })
    .find((entry) => Array.isArray(entry.raw?.response?.response?.models));
  const models = line?.raw?.response?.response?.models;
  expect(Array.isArray(models)).toBe(true);
  return ClaudeModelCatalog.fromInitialize(models);
}

interface ControlCall {
  subtype: string;
  request?: Record<string, unknown>;
}

interface FakeTransportOptions {
  /** Frames delivered on the notification stream, in order. */
  frames?: ClaudeStreamMessage[];
  /** The `get_context_usage` answer, or a thrower to exercise the fail-soft path. */
  contextUsage?: Record<string, unknown> | (() => never);
  /** Control subtypes that must be REFUSED, mapping to the refusal message. */
  refuse?: Record<string, string>;
  /**
   * TASK.157: a per-call provider of `get_context_usage` readings. Each call
   * receives the call index (0-based) and returns a reading, a promise of one,
   * or throws. Takes precedence over `contextUsage` when present. Use
   * `deferredUsage()` to gate individual calls.
   */
  contextUsageSequence?: (call: number) => Record<string, unknown> | Promise<Record<string, unknown>>;
}

/**
 * A `ClaudeTransport` that records every control call and replays a fixed frame
 * list. Frames are pushed only once a turn starts consuming, mirroring the real
 * client's single long-lived notification queue.
 */
class FakeTransport implements ClaudeTransport {
  readonly controls: ControlCall[] = [];
  readonly order: string[] = [];
  contextUsageCalls = 0;
  /** TASK.157: concurrent in-flight `get_context_usage` requests right now. */
  activeContextUsage = 0;
  /** TASK.157: high-water mark of concurrent context requests. */
  maxConcurrentContextUsage = 0;
  interrupts = 0;
  closed = 0;
  readonly sent: (string | unknown[])[] = [];
  /** Frames pushed after a `sendUserMessage`, so a turn always sees them in order. */
  private pending: ClaudeStreamMessage[];
  private waiters: ((result: IteratorResult<ClaudeStreamMessage>) => void)[] = [];
  private buffer: ClaudeStreamMessage[] = [];
  private done = false;

  constructor(private readonly options: FakeTransportOptions = {}) {
    this.pending = [...(options.frames ?? [])];
  }

  async initialize(): Promise<{ commands: unknown[]; models: unknown[]; account: { tokenSource?: string; subscriptionType?: string } }> {
    return { commands: [], models: [], account: { tokenSource: "oauth" } };
  }

  async controlRequest<T>(subtype: string, request?: Record<string, unknown>): Promise<T> {
    this.controls.push({ subtype, ...(request === undefined ? {} : { request }) });
    this.order.push(`control:${subtype}`);
    const refusal = this.options.refuse?.[subtype];
    if (refusal !== undefined) throw new Error(refusal);
    return {} as T;
  }

  async getContextUsage(): Promise<Record<string, unknown>> {
    this.contextUsageCalls += 1;
    this.order.push("get_context_usage");
    const sequence = this.options.contextUsageSequence;
    if (sequence !== undefined) {
      this.activeContextUsage += 1;
      this.maxConcurrentContextUsage = Math.max(this.maxConcurrentContextUsage, this.activeContextUsage);
      try {
        return await sequence(this.contextUsageCalls - 1);
      } finally {
        this.activeContextUsage -= 1;
      }
    }
    const usage = this.options.contextUsage;
    if (typeof usage === "function") {
      usage();
      throw new Error("contextUsage thrower returned");
    }
    return usage ?? {};
  }

  async interrupt(): Promise<{ stillQueued: string[] }> {
    this.interrupts += 1;
    this.order.push("interrupt");
    return { stillQueued: [] };
  }

  sendUserMessage(content: string | unknown[]): void {
    this.sent.push(content);
    this.order.push("sendUserMessage");
    const frames = this.pending;
    this.pending = [];
    for (const frame of frames) this.push(frame);
  }

  notifications(): AsyncIterable<ClaudeStreamMessage> {
    const self = this;
    return {
      [Symbol.asyncIterator](): AsyncIterator<ClaudeStreamMessage> {
        return {
          next(): Promise<IteratorResult<ClaudeStreamMessage>> {
            const value = self.buffer.shift();
            if (value !== undefined) return Promise.resolve({ value, done: false });
            if (self.done) return Promise.resolve({ value: undefined, done: true });
            return new Promise((resolve) => self.waiters.push(resolve));
          },
        };
      },
    };
  }

  async close(): Promise<void> {
    this.closed += 1;
    this.order.push("close");
    this.done = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  /** TASK.189: frames delivered on the NEXT sendUserMessage (a later turn's stream). */
  enqueue(frame: ClaudeStreamMessage): void {
    this.pending.push(frame);
  }

  /** Delivers one frame to the turn (or buffers it until the turn asks). */
  push(frame: ClaudeStreamMessage): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter({ value: frame, done: false });
      return;
    }
    this.buffer.push(frame);
  }
}

/**
 * Builds an engine with a real settings object. `ClaudeEngineSettings` is not
 * exported, but it is structurally satisfiable — the catalog and preset lookup
 * both are exported — so no production change is needed to test the settings
 * paths.
 */
function engineWith(
  transport: ClaudeTransport,
  overrides: { model?: string; presetId?: string; catalog?: ClaudeModelCatalog; timeouts?: Partial<ClaudeEngineTimeouts> } = {},
): ClaudeEngine {
  const catalog = overrides.catalog ?? liveCatalog();
  return new ClaudeEngine(transport, "session-ref-1", undefined, {
    catalog,
    model: overrides.model ?? "default",
    preset: findClaudePreset(overrides.presetId ?? "ask")!,
    effortsByModel: new Map(),
    notices: [],
  }, overrides.timeouts);
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function types(events: readonly AgentEvent[]): string[] {
  return events.map((event) => event.type);
}

/** TASK.157: a manually-gated `get_context_usage` reading. */
interface DeferredUsage {
  readonly promise: Promise<Record<string, unknown>>;
  resolve(reading: Record<string, unknown>): void;
  reject(error: unknown): void;
}

function deferredUsage(): DeferredUsage {
  let resolve!: (reading: Record<string, unknown>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Record<string, unknown>>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve: (r) => resolve(r), reject: (e) => reject(e) };
}

/** A minimal assistant frame that produces translated events without a terminal result. */
function assistantFrame(id: string): ClaudeStreamMessage {
  return {
    type: "assistant",
    message: { id, model: "model-x", content: [{ type: "text", text: `chunk ${id}` }] },
  } as unknown as ClaudeStreamMessage;
}

function userToolResultFrame(id: string): ClaudeStreamMessage {
  return {
    type: "user",
    uuid: id,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
  } as unknown as ClaudeStreamMessage;
}

function resultFrame157(reason: "completed" | "aborted_streaming" = "completed"): ClaudeStreamMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 1,
    duration_ms: 1,
    duration_api_ms: 1,
    total_cost_usd: 0,
    terminal_reason: reason,
  } as unknown as ClaudeStreamMessage;
}

// ── TASK.189: CLI self-started (foreign) turn fixtures ──────────────────────

function foreignAssistantFrame(id: string, text: string): ClaudeStreamMessage {
  return {
    type: "assistant",
    message: { id, model: "foreign-model", content: [{ type: "text", text }] },
  } as unknown as ClaudeStreamMessage;
}

function foreignToolUseFrame(id: string, name: string): ClaudeStreamMessage {
  return {
    type: "assistant",
    message: { id, model: "foreign-model", content: [{ type: "tool_use", id: `toolu_${id}`, name, input: {} }] },
  } as unknown as ClaudeStreamMessage;
}

function foreignResultFrame(
  result: string,
  options: { cost?: number; usage?: Record<string, unknown>; terminalReason?: string } = {},
): ClaudeStreamMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result,
    num_turns: 1,
    duration_ms: 1,
    duration_api_ms: 1,
    total_cost_usd: options.cost ?? 0,
    ...(options.usage !== undefined ? { usage: options.usage } : {}),
    ...(options.terminalReason !== undefined ? { terminal_reason: options.terminalReason } : {}),
  } as unknown as ClaudeStreamMessage;
}

function ownerFrames(label: string, usage?: Record<string, unknown>): ClaudeStreamMessage[] {
  return [
    foreignAssistantFrame(`m-owner-${label}`, `OWNER OUTPUT ${label}`),
    foreignResultFrame(`owner result ${label}`, { usage }),
  ];
}

describe("ClaudeEngine.runTurn — projection of a real W0 turn", () => {
  it("carries the writeprobe turn through to turn_end/loop_end, emitting BOTH tool_call and tool_execution_start (W17)", async () => {
    const transport = new FakeTransport({
      frames: streamFrames("w0-02-control-writeprobe.jsonl"),
      contextUsage: { totalTokens: 33_000, maxTokens: 200_000 },
    });
    const events = await collect(engineWith(transport).runTurn("write a file", { signal: new AbortController().signal }));

    expect(events[0]).toEqual({ type: "turn_start", turn: 1 });

    // W17: store.ts CREATES the tool card on `tool_call` and only PATCHES it on
    // `tool_execution_start`. Emitting the patch alone is a silent no-op — a
    // card that never renders — so both forms are asserted, paired by id.
    const toolCall = events.find((event) => event.type === "tool_call");
    const executionStart = events.find((event) => event.type === "tool_execution_start");
    expect(toolCall).toBeDefined();
    expect(executionStart).toBeDefined();
    expect((executionStart as { toolCallId: string }).toolCallId).toBe(
      (toolCall as { toolCall: { id: string } }).toolCall.id,
    );
    expect((toolCall as { toolCall: { name: string } }).toolCall.name).toBe(
      (executionStart as { toolName: string }).toolName,
    );

    // The tool's own result, correlated back to the same call.
    const toolResult = events.find((event) => event.type === "tool_result");
    expect(toolResult).toBeDefined();
    expect((toolResult as { outcome: { toolCallId: string } }).outcome.toolCallId).toBe(
      (toolCall as { toolCall: { id: string } }).toolCall.id,
    );

    // Assistant prose reached the transcript.
    expect(types(events)).toContain("text_delta");

    const turnEnd = events.find((event) => event.type === "turn_end");
    const loopEnd = events.find((event) => event.type === "loop_end");
    expect(turnEnd).toEqual({ type: "turn_end", turn: 1, finishReason: "stop" });
    expect(loopEnd).toEqual({ type: "loop_end", reason: "completed", turns: 1 });
  });

  it("never renders the CLI's replayed user echo as a transcript message", async () => {
    // The fixture's own `user{isReplay:true}` frame is our input coming back;
    // painting it would double every message the user sends.
    const transport = new FakeTransport({
      frames: streamFrames("w0-02-control-writeprobe.jsonl"),
      contextUsage: { totalTokens: 1, maxTokens: 2 },
    });
    const events = await collect(engineWith(transport).runTurn("write a file", { signal: new AbortController().signal }));
    // The only tool_result present is the genuine one (asserted above); no
    // event carries the echoed user text as assistant/user prose.
    const texts = events.filter((event) => event.type === "text_delta").map((event) => (event as { text: string }).text);
    expect(texts.join("")).not.toContain("write a file");
  });

  /**
   * R-W0-9 (the "live image delivery is impossible" finding) was DISPROVEN on
   * 2026-07-25 against CLI 2.1.220: the model describes an attached image. The
   * finding was never about the CLI — `runTurn` sent `input` as a bare string,
   * so no image block ever rode the frame in the first place.
   *
   * The assertion is deliberately ON THE PAYLOAD, not on the capability flag: a
   * flag says what the engine claims, only the sent frame says what the model
   * can actually receive.
   */
  it("carries image attachments as content blocks in the sent user frame (R-W0-9 disproven)", async () => {
    expect(CLAUDE_ENGINE_CAPABILITIES.supportsImages).toBe(true);
    const transport = new FakeTransport({ frames: streamFrames("w0-02-control-writeprobe.jsonl") });
    await collect(
      engineWith(transport).runTurn("look", {
        signal: new AbortController().signal,
        attachments: [{ mediaType: "image/png", data: "AA==" }],
      }),
    );
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } },
      { type: "text", text: "look" },
    ]);
  });

  it("keeps sending a bare string when a turn carries no attachments (byte-shape lock)", async () => {
    const transport = new FakeTransport({ frames: streamFrames("w0-02-control-writeprobe.jsonl") });
    await collect(engineWith(transport).runTurn("look", { signal: new AbortController().signal }));
    expect(transport.sent).toEqual(["look"]);
  });
});

describe("ClaudeEngine — TASK.226 срез S4: takePresentation reaches the turn's translator", () => {
  it("a tool_result for the bridge's own tool_use id carries the stamped presentation snapshot", async () => {
    const snapshot = { subagent: "opaque" } as never;
    const transport = new FakeTransport({
      frames: [
        {
          type: "assistant",
          message: { id: "m-bridge", model: "x", content: [{ type: "tool_use", id: "toolu_bridge", name: "mcp__anycode__agent", input: {} }] },
        } as unknown as ClaudeStreamMessage,
        {
          type: "user",
          uuid: "u-bridge",
          message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_bridge", content: "done" }] },
        } as unknown as ClaudeStreamMessage,
        { type: "result", subtype: "success", terminal_reason: "completed" } as unknown as ClaudeStreamMessage,
      ],
      contextUsage: { totalTokens: 1, maxTokens: 2 },
    });
    const engine = new ClaudeEngine(
      transport,
      "session-ref-1",
      undefined,
      { catalog: liveCatalog(), model: "default", preset: findClaudePreset("ask")!, effortsByModel: new Map(), notices: [] },
      undefined,
      (id) => (id === "toolu_bridge" ? snapshot : undefined),
    );
    const events = await collect(engine.runTurn("delegate", { signal: new AbortController().signal }));
    const toolResult = events.find((event) => event.type === "tool_result") as Extract<AgentEvent, { type: "tool_result" }>;
    expect(toolResult.outcome.result?.presentation).toBe(snapshot);
  });

  it("a turn with no takePresentation callback at all leaves result.presentation absent (byte-identical to pre-srez)", async () => {
    const transport = new FakeTransport({
      frames: [
        {
          type: "assistant",
          message: { id: "m-bridge", model: "x", content: [{ type: "tool_use", id: "toolu_bridge", name: "mcp__anycode__agent", input: {} }] },
        } as unknown as ClaudeStreamMessage,
        {
          type: "user",
          uuid: "u-bridge",
          message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_bridge", content: "done" }] },
        } as unknown as ClaudeStreamMessage,
        { type: "result", subtype: "success", terminal_reason: "completed" } as unknown as ClaudeStreamMessage,
      ],
      contextUsage: { totalTokens: 1, maxTokens: 2 },
    });
    const events = await collect(engineWith(transport).runTurn("delegate", { signal: new AbortController().signal }));
    const toolResult = events.find((event) => event.type === "tool_result") as Extract<AgentEvent, { type: "tool_result" }>;
    expect(toolResult.outcome.result?.presentation).toBeUndefined();
  });
});

describe("ClaudeEngine — the context meter is get_context_usage, never a result.usage sum (codex C-bug-1)", () => {
  /**
   * The discriminator. The fixture's terminal `result` carries its OWN usage
   * numbers; the transport answers `get_context_usage` with deliberately
   * DISJOINT ones. A meter that regressed to summing the result frame would
   * report the fixture's numbers and fail here — and, critically, `maxTokens`
   * (the budget) is not on the result frame at ALL, so a summing implementation
   * has nothing to report as a budget in the first place.
   */
  it("reports get_context_usage's totalTokens/maxTokens, with source \"provider\"", async () => {
    const frames = streamFrames("w0-02-control-writeprobe.jsonl");
    const result = frames.find((frame) => frame.type === "result") as unknown as Record<string, unknown>;
    expect(result).toBeDefined();
    // Prove the two sources really are distinguishable in this test.
    const resultUsage = result.usage as Record<string, number> | undefined;
    const resultUsageSum = Object.values(resultUsage ?? {}).reduce(
      (total, value) => total + (typeof value === "number" ? value : 0),
      0,
    );
    expect(resultUsageSum).not.toBe(33_333);
    expect(result).not.toHaveProperty("maxTokens");

    const transport = new FakeTransport({ frames, contextUsage: { totalTokens: 33_333, maxTokens: 200_000 } });
    const events = await collect(engineWith(transport).runTurn("hi", { signal: new AbortController().signal }));

    // TASK.157: the fixture carries user (tool-result) frames, so a mid-turn
    // refresh fires too — the FINAL reading is the LAST context_usage.
    const usage = events.filter((event) => event.type === "context_usage").at(-1);
    expect(usage).toEqual({ type: "context_usage", estimatedTokens: 33_333, budgetTokens: 200_000, source: "provider" });
    expect(transport.contextUsageCalls).toBe(2);
  });

  it("pulls the meter AFTER the terminal result, and yields it after loop_end", async () => {
    const transport = new FakeTransport({
      frames: streamFrames("w0-02-control-writeprobe.jsonl"),
      contextUsage: { totalTokens: 10, maxTokens: 100 },
    });
    const events = await collect(engineWith(transport).runTurn("hi", { signal: new AbortController().signal }));
    const order = types(events);
    // TASK.157: the FINAL reading is the LAST context_usage, strictly after
    // loop_end; mid-turn refreshes only ever precede it.
    expect(order.lastIndexOf("context_usage")).toBeGreaterThan(order.lastIndexOf("loop_end"));
    // Ordering on the wire, not just in the event list: the fixture's
    // user/tool-result boundary triggers one mid-turn refresh inside the hot
    // path, then the terminal $0 read lands after sendUserMessage, still
    // exactly once post-terminal.
    expect(transport.order.filter((step) => step === "get_context_usage" || step === "sendUserMessage")).toEqual([
      "sendUserMessage",
      "get_context_usage",
      "get_context_usage",
    ]);
  });

  it("an unreadable or failing get_context_usage leaves the meter silent — it never fails the turn", async () => {
    for (const contextUsage of [
      { totalTokens: 5 } as Record<string, unknown>, // maxTokens absent -> no honest budget
      { totalTokens: 5, maxTokens: 0 } as Record<string, unknown>, // a zero window is not a window
      (): never => {
        throw new Error("control request failed");
      },
    ]) {
      const transport = new FakeTransport({ frames: streamFrames("w0-02-control-writeprobe.jsonl"), contextUsage });
      const events = await collect(engineWith(transport).runTurn("hi", { signal: new AbortController().signal }));
      expect(types(events)).not.toContain("context_usage");
      expect(events.find((event) => event.type === "loop_end")).toEqual({ type: "loop_end", reason: "completed", turns: 1 });
    }
  });
});

describe("ClaudeEngine — permission posture (mode / set_permission_mode)", () => {
  it("mode() is display-only and never consults core's permission engine", () => {
    expect(engineWith(new FakeTransport()).mode()).toBe("build");
    expect(CLAUDE_ENGINE_CAPABILITIES.supportsCorePermissions).toBe(false);
  });

  it("selectPreset sends the preset's WIRE mode via set_permission_mode and advances the active preset", async () => {
    const transport = new FakeTransport();
    const engine = engineWith(transport);
    expect(engine.activePresetId).toBe("ask");

    await expect(engine.selectPreset("read-only")).resolves.toEqual({ ok: true, presetId: "read-only" });
    // The WIRE value, not the preset id and not the CLI flag word.
    expect(transport.controls).toEqual([{ subtype: "set_permission_mode", request: { mode: "plan" } }]);
    expect(engine.activePresetId).toBe("read-only");
    expect(engine.snapshot().activePresetId).toBe("read-only");
  });

  it("every exposed preset maps to a mode the wire accepts, and only the three frozen ids exist", async () => {
    expect([...CLAUDE_PRESET_IDS]).toEqual(["read-only", "ask", "workspace"]);
    const transport = new FakeTransport();
    const engine = engineWith(transport);
    for (const id of CLAUDE_PRESET_IDS) await engine.selectPreset(id);
    expect(transport.controls.map((call) => call.request?.mode)).toEqual(["plan", "default", "acceptEdits"]);
  });

  it("an unknown preset is refused WITHOUT touching the wire, and the posture is unchanged", async () => {
    const transport = new FakeTransport();
    const engine = engineWith(transport);
    const rejected = await engine.selectPreset("bypassPermissions");
    expect(rejected.ok).toBe(false);
    expect(transport.controls).toEqual([]);
    expect(engine.activePresetId).toBe("ask");
  });

  it("a CLI-refused set_permission_mode leaves the previous posture in place", async () => {
    const transport = new FakeTransport({ refuse: { set_permission_mode: "mode rejected" } });
    const engine = engineWith(transport);
    const rejected = await engine.selectPreset("workspace");
    expect(rejected).toEqual({ ok: false, reason: "mode rejected" });
    expect(engine.activePresetId).toBe("ask");
  });
});

describe("ClaudeEngine.selectModel — validate host-side, THEN set_model", () => {
  it("refuses an id the live catalog does not contain, without sending anything", async () => {
    const transport = new FakeTransport();
    const engine = engineWith(transport);
    const rejected = await engine.selectModel("gpt-5.6-terra");
    expect(rejected.ok).toBe(false);
    // The whole reason models.ts exists: an unverifiable id never reaches the
    // wire, where it would be accepted at spawn and fail the turn late.
    expect(transport.controls).toEqual([]);
    expect(engine.snapshot().model).toBe("default");
  });

  it("sends set_model for a catalog member and advances the local record only after the ack", async () => {
    const transport = new FakeTransport();
    const engine = engineWith(transport);
    await expect(engine.selectModel("sonnet")).resolves.toEqual({ ok: true, model: "sonnet" });
    expect(transport.controls).toEqual([{ subtype: "set_model", request: { model: "sonnet" } }]);
    expect(engine.snapshot().model).toBe("sonnet");
  });

  it("a refused set_model is a clean no-op — the prior model survives (w0-16 live behaviour)", async () => {
    const transport = new FakeTransport({ refuse: { set_model: "model rejected" } });
    const engine = engineWith(transport);
    const rejected = await engine.selectModel("sonnet");
    expect(rejected).toEqual({ ok: false, reason: "model rejected" });
    expect(engine.snapshot().model).toBe("default");
  });

  it("an unreadable catalog refuses every switch rather than guessing (fail-closed)", async () => {
    const transport = new FakeTransport();
    const engine = engineWith(transport, { catalog: ClaudeModelCatalog.fromInitialize(undefined) });
    const rejected = await engine.selectModel("sonnet");
    expect(rejected.ok).toBe(false);
    expect(transport.controls).toEqual([]);
  });

  it("the read-back is compared through the catalog's resolvedModel, never by string equality with the sent id", async () => {
    // The trap: `claude-fable-5[1m]` is SENT, `claude-fable-5` is REPORTED.
    // Asserting the reported id equals the requested one fires a spurious
    // mismatch on every switch to a `[1m]` variant.
    const catalog = liveCatalog();
    const transport = new FakeTransport({
      frames: streamFrames("w0-02-control-writeprobe.jsonl"),
      contextUsage: { totalTokens: 10, maxTokens: 100, model: "claude-fable-5" },
    });
    const engine = engineWith(transport, { catalog });
    await expect(engine.selectModel("claude-fable-5[1m]")).resolves.toEqual({ ok: true, model: "claude-fable-5[1m]" });
    await collect(engine.runTurn("hi", { signal: new AbortController().signal }));

    const reported = engine.resolvedModel();
    expect(reported).toBe("claude-fable-5");
    expect(reported).not.toBe("claude-fable-5[1m]"); // the naive comparison this guards against
    expect(catalog.readBackMatches("claude-fable-5[1m]", reported!)).toBe(true);
  });

  it("selectEffort is gated on the model's own supportedEffortLevels", async () => {
    const transport = new FakeTransport();
    const engine = engineWith(transport, { model: "haiku" }); // haiku carries no effort levels live
    const rejected = await engine.selectEffort("high");
    expect(rejected.ok).toBe(false);
    expect(transport.controls).toEqual([]);

    const opus = engineWith(transport, { model: "opus[1m]" });
    await expect(opus.selectEffort("high")).resolves.toEqual({ ok: true, effort: "high" });
    expect(transport.controls).toEqual([{ subtype: "apply_flag_settings", request: { effortLevel: "high" } }]);
    expect(opus.snapshot().effort).toBe("high");
  });

  it("re-resolves the effort for the switched-to model and restores the remembered value when switching back (TASK.60 shape)", async () => {
    const transport = new FakeTransport();
    const engine = engineWith(transport, { model: "opus[1m]" });
    await expect(engine.selectEffort("high")).resolves.toEqual({ ok: true, effort: "high" });

    // sonnet has no remembered effort yet, so the switch clears the local
    // record rather than carrying opus's "high" over onto an unrelated model.
    await expect(engine.selectModel("sonnet")).resolves.toEqual({ ok: true, model: "sonnet" });
    expect(engine.snapshot().effort).toBeUndefined();

    await expect(engine.selectModel("opus[1m]")).resolves.toEqual({ ok: true, model: "opus[1m]" });
    expect(engine.snapshot().effort).toBe("high");
    // Restoring re-asserts it live too, not just in the local record.
    expect(transport.controls.at(-1)).toEqual({ subtype: "apply_flag_settings", request: { effortLevel: "high" } });
  });
});

describe("ClaudeEngine — cancellation and disposal", () => {
  it("a Stop mid-turn interrupts exactly once and terminalizes as cancelled", async () => {
    const frames = streamFrames("w0-02-control-writeprobe.jsonl");
    const terminal = frames.find((frame) => frame.type === "result")!;
    const transport = new FakeTransport({ contextUsage: { totalTokens: 1, maxTokens: 2 } });
    const engine = engineWith(transport);
    const controller = new AbortController();

    const events: AgentEvent[] = [];
    const turn = (async () => {
      for await (const event of engine.runTurn("long job", { signal: controller.signal })) {
        events.push(event);
        // Stop as soon as the turn is genuinely under way.
        if (event.type === "turn_start") {
          controller.abort();
          // The CLI answers an interrupt by terminating the turn itself.
          queueMicrotask(() => transport.push({ ...(terminal as object), terminal_reason: "aborted_streaming" } as never));
        }
      }
    })();
    await turn;

    expect(transport.interrupts).toBe(1);
    expect(events.find((event) => event.type === "loop_end")).toEqual({ type: "loop_end", reason: "cancelled", turns: 1 });
  });

  it("TASK.156: a Stop that cannot settle in time closes the session and terminalizes as cancelled with a restart-required posture", async () => {
    const transport = new FakeTransport({
      frames: [
        {
          type: "assistant",
          message: { id: "m-bash", model: "x", content: [{ type: "tool_use", id: "toolu_sleep", name: "Bash", input: { command: "sleep 60" } }] },
        } as unknown as ClaudeStreamMessage,
      ],
      contextUsage: { totalTokens: 1, maxTokens: 2 },
    });
    const engine = engineWith(transport, { timeouts: { postInterruptSettleMs: 50 } });
    const controller = new AbortController();

    const events: AgentEvent[] = [];
    const turn = (async () => {
      for await (const event of engine.runTurn("long job", { signal: controller.signal })) {
        events.push(event);
        if (event.type === "tool_call") controller.abort();
      }
    })();
    await turn;

    expect(events.some((event) => event.type === "tool_call")).toBe(true);
    expect(transport.interrupts).toBe(1);
    expect(transport.closed).toBe(1);
    expect(events.some((event) => event.type === "error")).toBe(false);
    const notice = events.find((event) => event.type === "engine_notice") as
      | { level: string; message: string }
      | undefined;
    expect(notice).toBeDefined();
    expect(notice!.level).toBe("info");
    expect(notice!.message).toContain("running command");
    const loopEnds = events.filter((event) => event.type === "loop_end");
    expect(loopEnds).toHaveLength(1);
    expect(loopEnds[0]).toEqual({ type: "loop_end", reason: "cancelled", turns: 1 });
    expect(events[events.length - 2]).toMatchObject({ type: "turn_end" });
    expect(events[events.length - 1]).toEqual({ type: "loop_end", reason: "cancelled", turns: 1 });

    // The terminal latch: the next turn never reaches the dead transport.
    const next = await collect(engine.runTurn("again", { signal: new AbortController().signal }));
    expect(types(next)).toEqual(["error", "turn_end", "loop_end"]);
    const nextError = next[0] as { type: "error"; error: Error };
    expect(nextError.error.message).toContain("session was closed");
    expect(nextError.error.message).toContain("Start a new session");
    expect(transport.sent).toEqual(["long job"]);
  });

  it("TASK.156: a transport that dies without an abort is still an error turn", async () => {
    const transport = new FakeTransport({ contextUsage: { totalTokens: 1, maxTokens: 2 } });
    const controller = new AbortController();
    const events: AgentEvent[] = [];
    const turn = (async () => {
      for await (const event of engineWith(transport).runTurn("hi", { signal: controller.signal })) {
        events.push(event);
        if (event.type === "turn_start") queueMicrotask(() => transport.close());
      }
    })();
    await turn;
    expect(events.some((event) => event.type === "error")).toBe(true);
    expect(events.find((event) => event.type === "loop_end")).toEqual({ type: "loop_end", reason: "error", turns: 1 });
  });

  it("dispose interrupts before closing the transport", async () => {
    const transport = new FakeTransport();
    const engine = engineWith(transport);
    // An interrupt is only meaningful for a LIVE turn; with none active the
    // latch correctly skips it and disposal is a plain close.
    await engine.dispose("session-close");
    expect(transport.closed).toBe(1);

    const live = new FakeTransport({ contextUsage: { totalTokens: 1, maxTokens: 2 } });
    const liveEngine = engineWith(live);
    const controller = new AbortController();
    const iterator = liveEngine.runTurn("hi", { signal: controller.signal })[Symbol.asyncIterator]();
    await iterator.next(); // turn_start
    // Resume the generator PAST the turn_start yield so it reaches its
    // notification loop — the turn only counts as active once it is parked
    // there, and an interrupt for a turn that never started would be an
    // unanswerable request.
    const parked = iterator.next();
    await new Promise((resolve) => setImmediate(resolve));

    await liveEngine.dispose("host-shutdown");
    expect(live.interrupts).toBe(1);
    expect(live.order.indexOf("interrupt")).toBeLessThan(live.order.indexOf("close"));
    await parked.catch(() => undefined);
  });

  it("a disposed engine terminalizes any further turn instead of reaching a dead transport", async () => {
    const transport = new FakeTransport();
    const engine = engineWith(transport);
    await engine.dispose("session-close");
    const events = await collect(engine.runTurn("hi", { signal: new AbortController().signal }));
    expect(types(events)).toEqual(["error", "turn_end", "loop_end"]);
    expect(transport.sent).toEqual([]);
  });
});

describe("ClaudeEngine — presentation surface", () => {
  it("projects the live catalog and the frozen preset table, and reports cost without ever logging it", async () => {
    const transport = new FakeTransport({
      frames: streamFrames("w0-02-control-writeprobe.jsonl"),
      contextUsage: { totalTokens: 1, maxTokens: 2 },
    });
    const engine = engineWith(transport);
    expect(engine.models().map((choice) => choice.id)).toEqual(["default", "opus[1m]", "claude-fable-5[1m]", "sonnet", "haiku"]);
    expect(engine.presets().map((preset) => preset.id)).toEqual(["read-only", "ask", "workspace"]);

    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await collect(engine.runTurn("hi", { signal: new AbortController().signal }));
      expect(engine.sessionCostUsd()).toBeGreaterThan(0);
      expect(logged).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  it("CC-C has no resume source, so history is empty by construction", () => {
    expect(engineWith(new FakeTransport()).historyItems()).toEqual([]);
  });
});

/**
 * TASK.189: a CLI turn started by ITSELF (injected cross-session notice)
 * between owner turns must be absorbed — never misattributed to the next
 * owner turn's transcript, never allowed to terminate that turn early.
 *
 * T1 is the chronology-shaped reproduction of the incident (foreign text AND
 * foreign tool activity, then a foreign result, then a genuine owner turn).
 * Observed failure on the UNMODIFIED engine (run before E1–E9):
 *   AssertionError: expected '[{"type":"turn_start","turn":2},…' to contain
 *   'OWNER OUTPUT two' — the foreign tool_use rendered into turn 2's events
 *   (tool_call/tool_execution_start/tool_result for toolu_m-f-tool, "Bash")
 *   and the foreign `result` TERMINATED turn 2 (turn_end stop + loop_end
 *   completed with no owner assistant output); engine_session_tokens carried
 *   the FOREIGN usage snapshot (input 115 = fixture + foreign 111).
 */
describe("ClaudeEngine — TASK.189: CLI self-started turns", () => {
  it("repro: an unsolicited CLI turn between owner turns is absorbed, not misattributed", async () => {
    const t1 = streamFrames("w0-02-control-writeprobe.jsonl");
    const transport = new FakeTransport({ frames: t1, contextUsage: { totalTokens: 1, maxTokens: 2 } });
    const engine = engineWith(transport);
    const turn1 = await collect(engine.runTurn("first prompt", { signal: new AbortController().signal }));

    // No awaits here: the foreign burst arrives between turns, back-to-back.
    transport.push(foreignAssistantFrame("m-f1", "FOREIGN TEXT"));
    transport.push(foreignToolUseFrame("m-f-tool", "Bash"));
    transport.push(foreignResultFrame("foreign result", { usage: { input_tokens: 111, output_tokens: 11 } }));
    // Distinct owner usage snapshot — the separator (supervisor correction 5).
    for (const f of ownerFrames("two", { input_tokens: 10, output_tokens: 5 })) transport.enqueue(f);

    const events = await collect(engine.runTurn("second", { signal: new AbortController().signal }));

    expect(events.some((event) => event.type === "error")).toBe(false);
    const loopEnds = events.filter((event) => event.type === "loop_end");
    expect(loopEnds).toHaveLength(1);
    expect(loopEnds[0]).toEqual({ type: "loop_end", reason: "completed", turns: 2 });
    expect(events.find((event) => event.type === "turn_end")).toEqual({ type: "turn_end", turn: 2, finishReason: "stop" });
    const serialized = JSON.stringify(events);
    expect(serialized).toContain("OWNER OUTPUT two");
    expect(serialized).not.toContain("FOREIGN TEXT");
    expect(serialized).not.toContain("foreign result");
    expect(serialized).not.toContain("Bash"); // the foreign tool_use never renders
    expect(transport.sent).toEqual(["first prompt", "second"]);
    // The absorbed turn owns NO meter read: the owner's tokens are exactly its
    // own usage snapshot, cumulative from turn 1's fixture usage.
    const tokens = events.find((event) => event.type === "engine_session_tokens") as
      | { input: number; output: number; total: number }
      | undefined;
    expect(tokens).toBeDefined();
    // Cumulative = turn 1's own tokens + the owner 10/5 snapshot; the foreign
    // 111/11 usage is absorbed and must NOT appear anywhere in the total.
    const turn1Tokens = turn1.find((event) => event.type === "engine_session_tokens") as
      | { input: number; output: number }
      | undefined;
    expect(tokens!.input).toBe((turn1Tokens?.input ?? 0) + 10);
    expect(tokens!.output).toBe((turn1Tokens?.output ?? 0) + 5);
    const notice = events.find(
      (event) => event.type === "engine_notice" && String((event as { message?: string }).message).includes("started a turn on its own"),
    );
    expect(notice).toBeDefined();
  });

  it("a burst of adjacent unsolicited turns is absorbed entirely", async () => {
    const t1 = streamFrames("w0-02-control-writeprobe.jsonl");
    const transport = new FakeTransport({ frames: t1, contextUsage: { totalTokens: 1, maxTokens: 2 } });
    const engine = engineWith(transport);
    await collect(engine.runTurn("first prompt", { signal: new AbortController().signal }));

    // Back-to-back with NO awaits: two whole foreign turns, then the owner's.
    transport.push(foreignAssistantFrame("m-fa", "F-A"));
    transport.push(foreignResultFrame("fa"));
    transport.push(foreignAssistantFrame("m-fb", "F-B"));
    transport.push(foreignResultFrame("fb"));
    for (const f of ownerFrames("two")) transport.enqueue(f);

    const events = await collect(engine.runTurn("second", { signal: new AbortController().signal }));

    expect(events.some((event) => event.type === "error")).toBe(false);
    const loopEnds = events.filter((event) => event.type === "loop_end");
    expect(loopEnds).toHaveLength(1);
    expect(loopEnds[0]).toEqual({ type: "loop_end", reason: "completed", turns: 2 });
    const serialized = JSON.stringify(events);
    expect(serialized).toContain("OWNER OUTPUT two");
    expect(serialized).not.toContain("F-A");
    expect(serialized).not.toContain("F-B");
    expect(transport.sent.at(-1)).toBe("second");
  });

  it("an owner prompt during a running self-started turn waits for its result — no timer, no interrupt, no close", async () => {
    const t1 = streamFrames("w0-02-control-writeprobe.jsonl");
    const transport = new FakeTransport({ frames: t1, contextUsage: { totalTokens: 1, maxTokens: 2 } });
    const engine = engineWith(transport);
    const turn1 = await collect(engine.runTurn("first prompt", { signal: new AbortController().signal }));

    // The foreign turn is RUNNING (no result yet).
    transport.push(foreignAssistantFrame("m-f1", "FOREIGN RUNNING"));
    const turn2 = collect(engine.runTurn("owner during", { signal: new AbortController().signal }));
    await new Promise((r) => setImmediate(r)); // let the engine park in the foreign wait

    // Mid-flight: nothing sent, nothing interrupted, nothing closed.
    expect(transport.sent).not.toContain("owner during");
    expect(transport.interrupts).toBe(0);
    expect(transport.closed).toBe(0);

    // Owner frames are enqueued BEFORE the foreign result is released, so the
    // flush-on-send cannot race the release.
    for (const f of ownerFrames("two", { input_tokens: 10, output_tokens: 5 })) transport.enqueue(f);
    transport.push(foreignResultFrame("foreign done", { usage: { input_tokens: 111, output_tokens: 11 } }));
    const events = await turn2;

    expect(events.some((event) => event.type === "error")).toBe(false);
    const loopEnds = events.filter((event) => event.type === "loop_end");
    expect(loopEnds).toHaveLength(1);
    expect(loopEnds[0]).toEqual({ type: "loop_end", reason: "completed", turns: 2 });
    expect(events.find((event) => event.type === "turn_end")).toEqual({ type: "turn_end", turn: 2, finishReason: "stop" });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("FOREIGN RUNNING");
    expect(serialized).toContain("OWNER OUTPUT two");
    expect(transport.interrupts).toBe(0);
    expect(transport.closed).toBe(0);
    expect(transport.sent).toEqual(["first prompt", "owner during"]);
    // The foreign 111/11 usage owns no meter read; the owner's 10/5 does.
    const tokens = events.find((event) => event.type === "engine_session_tokens") as
      | { input: number; output: number }
      | undefined;
    const turn1Tokens = turn1.find((event) => event.type === "engine_session_tokens") as
      | { input: number; output: number }
      | undefined;
    expect(tokens).toBeDefined();
    expect(tokens!.input).toBe((turn1Tokens?.input ?? 0) + 10);
    expect(tokens!.output).toBe((turn1Tokens?.output ?? 0) + 5);

    // The session survives: a third turn runs normally.
    for (const f of ownerFrames("three")) transport.enqueue(f);
    const third = await collect(engine.runTurn("third", { signal: new AbortController().signal }));
    expect(third.some((event) => event.type === "error")).toBe(false);
    expect(third.filter((event) => event.type === "loop_end")).toEqual([{ type: "loop_end", reason: "completed", turns: 3 }]);
    expect(JSON.stringify(third)).toContain("OWNER OUTPUT three");
  });

  it("a long self-started turn is not interrupted when the owner prompts — settle bound does not apply to normal foreign work", async () => {
    const t1 = streamFrames("w0-02-control-writeprobe.jsonl");
    const transport = new FakeTransport({ frames: t1, contextUsage: { totalTokens: 1, maxTokens: 2 } });
    const engine = engineWith(transport, { timeouts: { postInterruptSettleMs: 30 } });
    await collect(engine.runTurn("first prompt", { signal: new AbortController().signal }));

    transport.push(foreignAssistantFrame("m-f1", "FOREIGN LONG"));
    const events: AgentEvent[] = [];
    const turn2 = (async () => {
      for await (const event of engine.runTurn("owner waits", { signal: new AbortController().signal })) events.push(event);
    })();
    await new Promise((r) => setTimeout(r, 80)); // 80ms > 2x the 30ms settle bound

    expect(transport.interrupts).toBe(0);
    expect(transport.closed).toBe(0);
    expect(events.some((event) => event.type === "loop_end")).toBe(false); // still waiting

    for (const f of ownerFrames("two")) transport.enqueue(f);
    transport.push(foreignResultFrame("foreign done"));
    await turn2;

    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.filter((event) => event.type === "loop_end")).toEqual([{ type: "loop_end", reason: "completed", turns: 2 }]);
    expect(transport.interrupts).toBe(0);
  });

  it("an unsolicited turn before any owner turn is absorbed by the boot-time idle reader", async () => {
    const transport = new FakeTransport({ contextUsage: { totalTokens: 1, maxTokens: 2 } });
    const engine = engineWith(transport);

    // BEFORE any runTurn — only the boot-time idle reader can see these.
    transport.push(foreignAssistantFrame("m-f0", "FOREIGN BOOT"));
    transport.push(foreignResultFrame("foreign boot"));
    for (const f of ownerFrames("one")) transport.enqueue(f);

    const events = await collect(engine.runTurn("first ever", { signal: new AbortController().signal }));

    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.filter((event) => event.type === "loop_end")).toEqual([{ type: "loop_end", reason: "completed", turns: 1 }]);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("FOREIGN BOOT");
    expect(serialized).toContain("OWNER OUTPUT one");
    const notice = events.find(
      (event) => event.type === "engine_notice" && String((event as { message?: string }).message).includes("started a turn on its own"),
    );
    expect(notice).toBeDefined();
  });

  it("a Stop while waiting for the self-started turn interrupts it and terminalizes cancelled", async () => {
    const t1 = streamFrames("w0-02-control-writeprobe.jsonl");
    const transport = new FakeTransport({ frames: t1, contextUsage: { totalTokens: 1, maxTokens: 2 } });
    const engine = engineWith(transport);
    await collect(engine.runTurn("first prompt", { signal: new AbortController().signal }));

    transport.push(foreignAssistantFrame("m-f1", "FOREIGN TEXT"));
    const controller = new AbortController();
    const events: AgentEvent[] = [];
    const turn2 = (async () => {
      for await (const event of engine.runTurn("stop me", { signal: controller.signal })) {
        events.push(event);
        if (events.some((e) => e.type === "engine_notice" && String((e as { message?: string }).message).includes("finishing a turn"))) {
          controller.abort();
          queueMicrotask(() =>
            transport.push(foreignResultFrame("foreign", { terminalReason: "aborted_streaming" })),
          );
        }
      }
    })();
    await turn2;

    expect(transport.interrupts).toBe(1);
    expect(events.filter((event) => event.type === "loop_end")).toEqual([{ type: "loop_end", reason: "cancelled", turns: 2 }]);
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(transport.sent).toEqual(["first prompt"]); // the owner input was NEVER sent
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("FOREIGN TEXT");
    expect(serialized).not.toContain('"foreign"');

    // Correction 3: no foreign-turn state left behind — a later turn does not
    // wait forever for a result already consumed.
    for (const f of ownerFrames("three")) transport.enqueue(f);
    const third = await collect(engine.runTurn("third", { signal: new AbortController().signal }));
    expect(third.some((event) => event.type === "error")).toBe(false);
    expect(third.filter((event) => event.type === "loop_end")).toEqual([{ type: "loop_end", reason: "completed", turns: 3 }]);
  });

  it("dispose while waiting for a self-started turn settles the waiting turn as cancelled", async () => {
    const t1 = streamFrames("w0-02-control-writeprobe.jsonl");
    const transport = new FakeTransport({ frames: t1, contextUsage: { totalTokens: 1, maxTokens: 2 } });
    const engine = engineWith(transport);
    await collect(engine.runTurn("first prompt", { signal: new AbortController().signal }));

    transport.push(foreignAssistantFrame("m-f1", "FOREIGN TEXT"));
    const events: AgentEvent[] = [];
    const turn2 = (async () => {
      for await (const event of engine.runTurn("waiting", { signal: new AbortController().signal })) events.push(event);
    })();
    await new Promise((r) => setImmediate(r)); // park in the foreign wait
    await engine.dispose("session-close");
    await turn2;

    expect(events.filter((event) => event.type === "loop_end")).toEqual([{ type: "loop_end", reason: "cancelled", turns: 2 }]);
    expect(transport.closed).toBe(1);
  });

  it("idle status noise between turns does not open a foreign turn or delay the next owner input", async () => {
    const t1 = streamFrames("w0-02-control-writeprobe.jsonl");
    const transport = new FakeTransport({ frames: t1, contextUsage: { totalTokens: 1, maxTokens: 2 } });
    const engine = engineWith(transport);
    await collect(engine.runTurn("first prompt", { signal: new AbortController().signal }));

    // Idle noise — no result ever follows, and none is needed.
    transport.push({ type: "system", subtype: "status", status: "compacting" } as unknown as ClaudeStreamMessage);
    for (const f of ownerFrames("two")) transport.enqueue(f);

    const events = await collect(engine.runTurn("second", { signal: new AbortController().signal }));

    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.filter((event) => event.type === "loop_end")).toEqual([{ type: "loop_end", reason: "completed", turns: 2 }]);
    expect(JSON.stringify(events)).toContain("OWNER OUTPUT two");
    const foreignNotices = events.filter(
      (event) => event.type === "engine_notice" && String((event as { message?: string }).message).includes("started a turn on its own"),
    );
    expect(foreignNotices).toHaveLength(0);
    expect(transport.sent.at(-1)).toBe("second");
  });

  it("idle replay/local-command echo does not open a foreign turn (no wait for a nonexistent result)", async () => {
    const t1 = streamFrames("w0-02-control-writeprobe.jsonl");
    const transport = new FakeTransport({ frames: t1, contextUsage: { totalTokens: 1, maxTokens: 2 } });
    const engine = engineWith(transport);
    await collect(engine.runTurn("first prompt", { signal: new AbortController().signal }));

    // Both live echo shapes from event-translator's onUser: the replay marker
    // AND the bare-string local-command stdout without it.
    transport.push({
      type: "user",
      isReplay: true,
      message: { role: "user", content: [{ type: "text", text: "first prompt" }] },
    } as unknown as ClaudeStreamMessage);
    transport.push({
      type: "user",
      message: { role: "user", content: "<local-command-stdout>model set</local-command-stdout>" },
    } as unknown as ClaudeStreamMessage);
    for (const f of ownerFrames("two")) transport.enqueue(f);

    const events = await collect(engine.runTurn("second", { signal: new AbortController().signal }));

    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.filter((event) => event.type === "loop_end")).toEqual([{ type: "loop_end", reason: "completed", turns: 2 }]);
    const foreignNotices = events.filter(
      (event) => event.type === "engine_notice" && String((event as { message?: string }).message).includes("started a turn on its own"),
    );
    expect(foreignNotices).toHaveLength(0);
    expect(JSON.stringify(events)).toContain("OWNER OUTPUT two");
    expect(transport.sent).toEqual(["first prompt", "second"]); // never waited for a nonexistent result
  });

  it("foreign frames arriving during a yielded pre-send notice stay foreign (send barrier re-runs after every yield)", async () => {
    const transport = new FakeTransport({ contextUsage: { totalTokens: 1, maxTokens: 2 } });
    const engine = engineWith(transport);
    engine.queueNotice({ type: "engine_notice", level: "info", message: "review checkpoint" });
    for (const f of ownerFrames("review")) transport.enqueue(f);

    const iterator = engine.runTurn("owner", { signal: new AbortController().signal })[Symbol.asyncIterator]();
    await iterator.next(); // turn_start
    const notice = await iterator.next();
    expect(notice.value).toMatchObject({ type: "engine_notice", message: "review checkpoint" });

    // While the generator is SUSPENDED at the notice yield, the CLI starts
    // (and finishes) a whole foreign turn. The barrier must re-run on resume:
    // classify the foreign frames, re-wait, and only then send the input —
    // which flushes the enqueued OWNER frames, never the foreign ones.
    transport.push(foreignAssistantFrame("review-foreign", "FOREIGN AT YIELD"));
    transport.push(foreignResultFrame("foreign done"));

    const events: AgentEvent[] = [];
    for (;;) {
      const step = await iterator.next();
      if (step.done) break;
      events.push(step.value);
    }
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("FOREIGN AT YIELD");
    expect(serialized).toContain("OWNER OUTPUT review");
    expect(events.filter((event) => event.type === "loop_end")).toEqual([{ type: "loop_end", reason: "completed", turns: 1 }]);
    await engine.dispose("session-close");
  });

  it("dispose during a suspended pre-send notice never sends the owner input and terminalizes cancelled", async () => {
    const transport = new FakeTransport({ contextUsage: { totalTokens: 1, maxTokens: 2 } });
    const engine = engineWith(transport);
    engine.queueNotice({ type: "engine_notice", level: "info", message: "review checkpoint" });

    const iterator = engine.runTurn("owner", { signal: new AbortController().signal })[Symbol.asyncIterator]();
    await iterator.next(); // turn_start
    await iterator.next(); // the queued notice — generator suspended at its yield

    await engine.dispose("session-close");
    const events: AgentEvent[] = [];
    for (;;) {
      const step = await iterator.next();
      if (step.done) break;
      events.push(step.value);
    }
    expect(transport.sent).toEqual([]); // the owner input was never injected
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.filter((event) => event.type === "loop_end")).toEqual([{ type: "loop_end", reason: "cancelled", turns: 1 }]);
  });

  it("dispose while suspended at the foreign-wait notice settles the waiting turn as cancelled, not error", async () => {
    const transport = new FakeTransport({ contextUsage: { totalTokens: 1, maxTokens: 2 } });
    const engine = engineWith(transport);

    // A RUNNING foreign turn (no result yet) parks the owner turn in the
    // foreign wait. Manual, SEQUENTIAL iteration: stop exactly at the
    // finishing-notice yield, dispose while the generator is SUSPENDED there,
    // then drain — a concurrent consumer would already have resumed the
    // generator into its wait race and would not exercise the suspension.
    transport.push(foreignAssistantFrame("pending", "FOREIGN"));
    const iterator = engine.runTurn("owner during", { signal: new AbortController().signal })[Symbol.asyncIterator]();
    const events: AgentEvent[] = [];
    for (;;) {
      const step = await iterator.next();
      if (step.done) throw new Error("missing finishing notice");
      events.push(step.value);
      if (step.value.type === "engine_notice" && String((step.value as { message?: string }).message).includes("finishing a turn")) break;
    }

    await engine.dispose("session-close");

    for (;;) {
      const step = await iterator.next();
      if (step.done) break;
      events.push(step.value);
    }
    expect(transport.sent).toEqual([]); // the owner input was never injected
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.filter((event) => event.type === "loop_end")).toEqual([{ type: "loop_end", reason: "cancelled", turns: 1 }]);
  });
});

/**
 * cut §1.5 hazard (б) — the resumed session's FIRST `system/init` is the truth
 * about model and permission mode, not the row we resumed from. These pin what
 * the engine does with that init: it adopts the native posture into its own
 * settings, translating the CLI's RESOLVED model id back into the catalog
 * `value` the rest of AnyCode selects by, and it announces the init exactly
 * once so the host can materialize/patch the session row at that moment.
 */
describe("ClaudeEngine — reconciliation from the first system/init (cut §1.5 hazard (б))", () => {
  const RESULT: ClaudeStreamMessage = {
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 1,
    duration_ms: 1,
    duration_api_ms: 1,
    total_cost_usd: 0,
  } as unknown as ClaudeStreamMessage;

  function initFrame(model: string, permissionMode: string): ClaudeStreamMessage {
    return {
      type: "system",
      subtype: "init",
      session_id: "native-session-1",
      model,
      permissionMode,
      cwd: "/work",
      tools: [],
      mcp_servers: [],
      slash_commands: [],
      skills: [],
      capabilities: ["interrupt_receipt_v1"],
      claude_code_version: "2.1.212",
    } as unknown as ClaudeStreamMessage;
  }

  it("adopts the native posture: a RESOLVED model id becomes the catalog `value`, and the wire mode becomes the preset", async () => {
    // The row said `haiku`/`ask`. The native session actually survived on
    // opus with acceptEdits — and reports opus by its RESOLVED id.
    const catalog = liveCatalog();
    const opus = catalog.get("opus[1m]")!;
    expect(opus.resolvedModel).not.toBe(opus.value); // the split this test exists for
    const transport = new FakeTransport({ frames: [initFrame(opus.resolvedModel, "acceptEdits"), RESULT] });
    const engine = engineWith(transport, { model: "haiku", presetId: "ask", catalog });

    await collect(engine.runTurn("hi", { signal: new AbortController().signal }));

    // The SELECTABLE id, never the resolved one: persisting `claude-opus-4-8`
    // would fail `catalog.has()` on the next resume and silently fall back to
    // the default model.
    expect(engine.snapshot().model).toBe("opus[1m]");
    expect(catalog.has(engine.snapshot().model)).toBe(true);
    expect(engine.snapshot().activePresetId).toBe("workspace");
  });

  it("keeps an alias selection that ALREADY resolves to the reported id (no spurious flip between aliases)", async () => {
    const catalog = liveCatalog();
    const opus = catalog.get("opus[1m]")!;
    const transport = new FakeTransport({ frames: [initFrame(opus.resolvedModel, "default"), RESULT] });
    const engine = engineWith(transport, { model: "opus[1m]", presetId: "ask", catalog });

    await collect(engine.runTurn("hi", { signal: new AbortController().signal }));

    // A naive `findByResolved` adoption would replace the user's `opus[1m]`
    // with whichever catalog entry shares that resolved id and is listed first.
    expect(engine.snapshot().model).toBe("opus[1m]");
    expect(engine.snapshot().activePresetId).toBe("ask");
  });

  it("announces the first init exactly once, and only after a turn produced one", async () => {
    const transport = new FakeTransport({ frames: [initFrame("model-x", "plan"), RESULT] });
    const engine = engineWith(transport);
    const seen: { sessionId: string; model: string; permissionMode: string }[] = [];
    engine.onFirstSystemInit((init) => seen.push(init));

    // A handshake alone emits no `system/init` at all (probe #13) — nothing yet.
    expect(seen).toEqual([]);

    await collect(engine.runTurn("hi", { signal: new AbortController().signal }));
    expect(seen).toEqual([{ sessionId: "native-session-1", model: "model-x", permissionMode: "plan" }]);

    // A second turn re-emits `system/init` (probe #1); the announcement does not repeat.
    transport.enqueue(initFrame("model-x", "plan"));
    transport.enqueue(RESULT);
    await collect(engine.runTurn("again", { signal: new AbortController().signal }));
    expect(seen).toHaveLength(1);
  });

  it("replays the latched init to a listener registered after the fact", async () => {
    const transport = new FakeTransport({ frames: [initFrame("model-x", "plan"), RESULT] });
    const engine = engineWith(transport);
    await collect(engine.runTurn("hi", { signal: new AbortController().signal }));

    const seen: { model: string }[] = [];
    engine.onFirstSystemInit((init) => seen.push(init));
    expect(seen).toEqual([{ sessionId: "native-session-1", model: "model-x", permissionMode: "plan" }]);
  });
});

/**
 * TASK.159: claude emits NO token event through the core `finish`->`usage`
 * path (the context meter is deliberately `get_context_usage`, never a
 * `result.usage` sum — the describe block above). This is the OTHER half:
 * `result.usage` DOES feed a session-cumulative `engine_session_tokens`
 * event, which host/index.ts's telemetry tap (records.ts's
 * `buildEngineTelemetryTap`) converts to additive deltas. The double-count
 * pin mirrors records.test.ts's own engine-tap pin, one layer down the
 * stack: the ENGINE must hand the tap a truly cumulative session total, or
 * that shim's delta math is fed a lie from the start.
 */
describe("ClaudeEngine — session-cumulative token accounting (TASK.159)", () => {
  const INIT: ClaudeStreamMessage = {
    type: "system",
    subtype: "init",
    session_id: "native-session-1",
    model: "model-x",
    permissionMode: "plan",
    cwd: "/work",
    tools: [],
    mcp_servers: [],
    slash_commands: [],
    skills: [],
    capabilities: ["interrupt_receipt_v1"],
    claude_code_version: "2.1.212",
  } as unknown as ClaudeStreamMessage;

  function resultFrame(usage?: Record<string, unknown>): ClaudeStreamMessage {
    return {
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 1,
      duration_ms: 1,
      duration_api_ms: 1,
      total_cost_usd: 0,
      ...(usage !== undefined ? { usage } : {}),
    } as unknown as ClaudeStreamMessage;
  }

  it("two turns with usage 10/5 each -> engine_session_tokens is CUMULATIVE (15, then 30), never per-turn (double-count pin)", async () => {
    const transport = new FakeTransport({ frames: [INIT, resultFrame({ input_tokens: 10, output_tokens: 5 })] });
    const engine = engineWith(transport);

    const first = await collect(engine.runTurn("one", { signal: new AbortController().signal }));
    expect(first.find((event) => event.type === "engine_session_tokens")).toEqual({
      type: "engine_session_tokens",
      input: 10,
      output: 5,
      total: 15,
    });
    // Yielded after the turn's own loop_end (same ordering discipline as the
    // context-meter read it sits beside in runTurn).
    expect(types(first).indexOf("engine_session_tokens")).toBeGreaterThan(types(first).indexOf("loop_end"));

    transport.enqueue(INIT);
    transport.enqueue(resultFrame({ input_tokens: 10, output_tokens: 5 }));
    const second = await collect(engine.runTurn("two", { signal: new AbortController().signal }));
    expect(second.find((event) => event.type === "engine_session_tokens")).toEqual({
      type: "engine_session_tokens",
      input: 20,
      output: 10,
      total: 30,
    });
  });

  it("a turn whose result carries no usage emits no engine_session_tokens event (fail-soft, never invents a number)", async () => {
    const transport = new FakeTransport({ frames: [INIT, resultFrame()] });
    const engine = engineWith(transport);
    const events = await collect(engine.runTurn("hi", { signal: new AbortController().signal }));
    expect(events.find((event) => event.type === "engine_session_tokens")).toBeUndefined();

    // The skipped turn must leave the SAME engine's cumulative accumulator
    // untouched: the next turn's real usage starts from 0, not from a phantom
    // partial sum the skip could have left behind.
    transport.enqueue(INIT);
    transport.enqueue(resultFrame({ input_tokens: 3, output_tokens: 1 }));
    const next = await collect(engine.runTurn("hi again", { signal: new AbortController().signal }));
    expect(next.find((event) => event.type === "engine_session_tokens")).toEqual({
      type: "engine_session_tokens",
      input: 3,
      output: 1,
      total: 4,
    });
  });

  it("non-numeric usage fields are treated as absent, never coerced into a garbage total", async () => {
    const transport = new FakeTransport({
      frames: [INIT, resultFrame({ input_tokens: "ten", output_tokens: 5 })],
    });
    const events = await collect(engineWith(transport).runTurn("hi", { signal: new AbortController().signal }));
    expect(events.find((event) => event.type === "engine_session_tokens")).toBeUndefined();
  });
});

/**
 * TASK.157: mid-turn provider context refreshes. Claude must refresh the
 * meter at user/tool-result and assistant boundaries during a RUNNING turn,
 * at most once per 30s (first refresh immediately eligible), never
 * overlapping, with completions surfacing during quiet periods without
 * another frame. Mid-turn failures/malformed readings are fully silent. The
 * unconditional post-loop_end final read is preserved.
 */
describe("ClaudeEngine — mid-turn context refreshes (TASK.157)", () => {
  /** Continuously consumes a turn while it stays open; resolves with events when it finishes.
   *  TASK.189: `parked` resolves once the turn has passed its pre-send barrier
   *  and actually SENT — under engine-lifetime stream ownership a frame pushed
   *  before that point is (correctly) classified as a CLI self-started turn,
   *  not this turn's mid-turn stream. */
  function consume(engine: ClaudeEngine, signal: AbortSignal): { events: AgentEvent[]; parked: Promise<void>; done: Promise<AgentEvent[]> } {
    const events: AgentEvent[] = [];
    const iterator = engine.runTurn("work", { signal })[Symbol.asyncIterator]();
    const done = (async () => {
      for (;;) {
        const step = await iterator.next();
        if (step.done) return events;
        events.push(step.value);
      }
    })();
    const parked = (async () => {
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    })();
    return { events, parked, done };
  }

  /** Waits until predicate holds over the shared events list (event observed mid-turn). */
  async function until(predicate: () => boolean, what: string): Promise<void> {
    for (let i = 0; i < 200 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    if (!predicate()) throw new Error(`timed out waiting for ${what}`);
  }

  it("1. emits a mid-turn context_usage during a quiet period, before any loop_end, then a fresh final reading", async () => {
    const transport = new FakeTransport({
      contextUsageSequence: (call) => ({ totalTokens: 100 + call, maxTokens: 200_000 }),
    });
    const engine = engineWith(transport);
    const controller = new AbortController();
    const turn = consume(engine, controller.signal);
    await turn.parked;

    transport.push(assistantFrame("a1"));
    await until(() => turn.events.some((event) => event.type === "context_usage"), "mid-turn context_usage");
    expect(turn.events.some((event) => event.type === "loop_end" || event.type === "turn_end")).toBe(false);
    expect(turn.events.find((event) => event.type === "context_usage")).toEqual({
      type: "context_usage",
      estimatedTokens: 100,
      budgetTokens: 200_000,
      source: "provider",
    });

    transport.push(resultFrame157("completed"));
    const events = await turn.done;
    const usages = events.filter((event) => event.type === "context_usage");
    expect(usages).toHaveLength(2);
    expect(usages.at(-1)).toEqual({ type: "context_usage", estimatedTokens: 101, budgetTokens: 200_000, source: "provider" });
    expect(types(events).lastIndexOf("context_usage")).toBeGreaterThan(types(events).lastIndexOf("loop_end"));
  });

  it("2. throttles to one read per 30s: an in-window boundary does not read, +30_001ms does, and the final read is never throttled", async () => {
    let now = 0;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const transport = new FakeTransport({
        contextUsageSequence: (call) => ({ totalTokens: 10 + call, maxTokens: 100 }),
      });
      const engine = engineWith(transport);
      const turn = consume(engine, new AbortController().signal);
      await turn.parked;

      transport.push(assistantFrame("a1"));
      await until(() => transport.contextUsageCalls === 1, "first mid-turn read");

      // Inside the window: no second read.
      now = 10_000;
      transport.push(assistantFrame("a2"));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(transport.contextUsageCalls).toBe(1);

      now = 30_001;
      transport.push(assistantFrame("a3"));
      await until(() => transport.contextUsageCalls === 2, "second mid-turn read after interval");
      await until(() => turn.events.filter((event) => event.type === "context_usage").length === 2, "second mid-turn event");

      // Final read fires immediately even though it lands inside the throttle window.
      now = 30_002;
      transport.push(resultFrame157("completed"));
      const events = await turn.done;
      expect(transport.contextUsageCalls).toBe(3);
      expect(types(events).lastIndexOf("context_usage")).toBeGreaterThan(types(events).lastIndexOf("loop_end"));
    } finally {
      dateNow.mockRestore();
    }
  });

  it("3. never overlaps requests: with interval 0 and an unresolved first read, further boundaries start nothing; resolving it delivers the event", async () => {
    const gates: DeferredUsage[] = [];
    const transport = new FakeTransport({
      contextUsageSequence: (call) => {
        if (call >= 2) return { totalTokens: 60, maxTokens: 100 }; // final read
        const gate = deferredUsage();
        gates.push(gate);
        return gate.promise;
      },
    });
    const engine = engineWith(transport, { timeouts: { midTurnContextUsageIntervalMs: 0 } });
    const turn = consume(engine, new AbortController().signal);
      await turn.parked;

    transport.push(assistantFrame("a1"));
    await until(() => gates.length === 1, "first gated read");
    // Several boundaries while the first read is unresolved: no overlap.
    transport.push(assistantFrame("a2"));
    transport.push(userToolResultFrame("t1"));
    transport.push(assistantFrame("a3"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(transport.contextUsageCalls).toBe(1);
    expect(transport.maxConcurrentContextUsage).toBe(1);

    // Resolve WITHOUT pushing another frame: the completion alone surfaces.
    gates[0]!.resolve({ totalTokens: 42, maxTokens: 50 });
    await until(() => turn.events.some((event) => event.type === "context_usage"), "gated mid-turn event");
    expect(turn.events.find((event) => event.type === "context_usage")).toEqual({
      type: "context_usage",
      estimatedTokens: 42,
      budgetTokens: 50,
      source: "provider",
    });

    // The slot is free again: another boundary permits another read.
    transport.push(assistantFrame("a4"));
    await until(() => gates.length === 2, "second gated read");
    gates[1]!.resolve({ totalTokens: 43, maxTokens: 50 });
    transport.push(resultFrame157("completed"));
    const events = await turn.done;
    expect(transport.maxConcurrentContextUsage).toBe(1);
    expect(types(events).lastIndexOf("context_usage")).toBeGreaterThan(types(events).lastIndexOf("loop_end"));
  });

  it("4. a result pushed while a read is unresolved waits for it: max concurrency stays one and the final read still runs, even in-window", async () => {
    const gate = deferredUsage();
    let gateUsed = false;
    const transport = new FakeTransport({
      contextUsageSequence: () => {
        if (!gateUsed) {
          gateUsed = true;
          return gate.promise;
        }
        return { totalTokens: 999, maxTokens: 1_000 };
      },
    });
    const engine = engineWith(transport);
    const turn = consume(engine, new AbortController().signal);
      await turn.parked;

    transport.push(assistantFrame("a1"));
    await until(() => transport.contextUsageCalls === 1, "gated mid-turn read started");
    transport.push(resultFrame157("completed"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(transport.contextUsageCalls).toBe(1); // final read has NOT started

    gate.resolve({ totalTokens: 5, maxTokens: 10 });
    const events = await turn.done;
    expect(transport.contextUsageCalls).toBe(2); // final read ran after the first settled
    expect(transport.maxConcurrentContextUsage).toBe(1);
    const last = events.filter((event) => event.type === "context_usage").at(-1);
    expect(last).toEqual({ type: "context_usage", estimatedTokens: 999, budgetTokens: 1_000, source: "provider" });
    expect(types(events).lastIndexOf("context_usage")).toBeGreaterThan(types(events).lastIndexOf("loop_end"));
  });

  it("5. mid-turn rejections and malformed readings are fully silent; a valid final reading still completes the turn", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const readings: (Record<string, unknown> | (() => never))[] = [
        (): never => {
          throw new Error("mid-turn request failed");
        },
        { totalTokens: 5 }, // maxTokens absent
        { totalTokens: Number.NaN, maxTokens: 10 },
        { totalTokens: 777, maxTokens: 1_000 }, // final (index 3)
      ];
      const transport = new FakeTransport({
        contextUsageSequence: (call) => {
          const reading = readings[Math.min(call, readings.length - 1)]!;
          if (typeof reading === "function") {
            reading();
            throw new Error("thrower returned");
          }
          return reading;
        },
      });
      const engine = engineWith(transport, { timeouts: { midTurnContextUsageIntervalMs: 0 } });
      const turn = consume(engine, new AbortController().signal);
      await turn.parked;

      transport.push(assistantFrame("a1"));
      await until(() => transport.contextUsageCalls >= 1, "first mid-turn read attempted");
      await new Promise((resolve) => setTimeout(resolve, 10)); // let the null completion be consumed
      transport.push(assistantFrame("a2"));
      await until(() => transport.contextUsageCalls >= 2, "failed/malformed mid-turn reads attempted");
      await new Promise((resolve) => setTimeout(resolve, 10)); // consume the null completion
      transport.push(assistantFrame("a3"));
      await until(() => transport.contextUsageCalls >= 3, "NaN mid-turn read attempted");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(turn.events.filter((event) => event.type === "context_usage")).toHaveLength(0);
      expect(turn.events.some((event) => event.type === "error")).toBe(false);

      transport.push(resultFrame157("completed"));
      const events = await turn.done;
      expect(errorSpy).not.toHaveBeenCalled(); // mid-turn path is silent; final reading is valid
      expect(events.filter((event) => event.type === "context_usage")).toEqual([
        { type: "context_usage", estimatedTokens: 777, budgetTokens: 1_000, source: "provider" },
      ]);
      expect(events.find((event) => event.type === "loop_end")).toEqual({ type: "loop_end", reason: "completed", turns: 1 });
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("6. an unresolved measurement never delays Stop; the preserved final read completes after cancellation without overlap or stale mid-turn events", async () => {
    const gate = deferredUsage();
    let gateUsed = false;
    const transport = new FakeTransport({
      contextUsageSequence: () => {
        if (!gateUsed) {
          gateUsed = true;
          return gate.promise;
        }
        return { totalTokens: 20, maxTokens: 30 };
      },
    });
    const engine = engineWith(transport);
    const controller = new AbortController();
    const turn = consume(engine, controller.signal);
    await turn.parked;

    transport.push(assistantFrame("a1"));
    await until(() => transport.contextUsageCalls === 1, "gated mid-turn read started");

    // Stop: the interrupt must be sent BEFORE the gate resolves.
    controller.abort();
    await until(() => transport.interrupts === 1, "interrupt sent while read unresolved");
    expect(gateUsed).toBe(true);

    // The mid-turn measurement resolves while the terminal result is STILL
    // WITHHELD: an observed abort must disable delivery, so no context_usage
    // may surface while the turn is still running/cancelling.
    gate.resolve({ totalTokens: 1, maxTokens: 2 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(turn.events.filter((event) => event.type === "context_usage")).toHaveLength(0);
    expect(transport.contextUsageCalls).toBe(1); // final read still withheld too

    // Only now does the CLI terminate the cancelled turn.
    transport.push(resultFrame157("aborted_streaming"));
    const events = await turn.done;
    expect(transport.contextUsageCalls).toBe(2); // preserved final measurement ran
    expect(transport.maxConcurrentContextUsage).toBe(1);
    expect(events.find((event) => event.type === "loop_end")).toEqual({ type: "loop_end", reason: "cancelled", turns: 1 });
    expect(events.some((event) => event.type === "error")).toBe(false);
    // No stale mid-turn event after the abort: the only context_usage is the final one, after loop_end.
    const order = types(events);
    expect(order.filter((type) => type === "context_usage")).toHaveLength(1);
    expect(order.lastIndexOf("context_usage")).toBeGreaterThan(order.lastIndexOf("loop_end"));
    expect(events.filter((event) => event.type === "context_usage").at(-1)).toEqual({
      type: "context_usage",
      estimatedTokens: 20,
      budgetTokens: 30,
      source: "provider",
    });
  });
});
