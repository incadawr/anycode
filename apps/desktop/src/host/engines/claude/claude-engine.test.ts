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
import { CLAUDE_ENGINE_CAPABILITIES, CLAUDE_PRESET_IDS, ClaudeEngine, type ClaudeTransport } from "./claude-engine.js";
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
  overrides: { model?: string; presetId?: string; catalog?: ClaudeModelCatalog } = {},
): ClaudeEngine {
  const catalog = overrides.catalog ?? liveCatalog();
  return new ClaudeEngine(transport, "session-ref-1", undefined, {
    catalog,
    model: overrides.model ?? "default",
    preset: findClaudePreset(overrides.presetId ?? "ask")!,
    notices: [],
  });
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function types(events: readonly AgentEvent[]): string[] {
  return events.map((event) => event.type);
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

  it("refuses image attachments at the wire boundary, not only at the Composer gate (R-W0-9)", async () => {
    expect(CLAUDE_ENGINE_CAPABILITIES.supportsImages).toBe(false);
    const transport = new FakeTransport();
    const events = await collect(
      engineWith(transport).runTurn("look", {
        signal: new AbortController().signal,
        attachments: [{ mediaType: "image/png", data: "AA==" } as never],
      }),
    );
    expect(types(events)).toEqual(["error", "turn_end", "loop_end"]);
    // Nothing was sent: the refusal precedes the transport entirely.
    expect(transport.sent).toEqual([]);
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

    const usage = events.find((event) => event.type === "context_usage");
    expect(usage).toEqual({ type: "context_usage", estimatedTokens: 33_333, budgetTokens: 200_000, source: "provider" });
    expect(transport.contextUsageCalls).toBe(1);
  });

  it("pulls the meter AFTER the terminal result, and yields it after loop_end", async () => {
    const transport = new FakeTransport({
      frames: streamFrames("w0-02-control-writeprobe.jsonl"),
      contextUsage: { totalTokens: 10, maxTokens: 100 },
    });
    const events = await collect(engineWith(transport).runTurn("hi", { signal: new AbortController().signal }));
    const order = types(events);
    expect(order.indexOf("context_usage")).toBeGreaterThan(order.indexOf("loop_end"));
    // Ordering on the wire, not just in the event list: the $0 read happens
    // once the turn is already terminal, never inside the hot path.
    expect(transport.order.filter((step) => step === "get_context_usage" || step === "sendUserMessage")).toEqual([
      "sendUserMessage",
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
    transport.push(initFrame("model-x", "plan"));
    transport.push(RESULT);
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
