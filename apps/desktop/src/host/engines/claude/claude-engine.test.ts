/**
 * SessionEngine behaviour for the native Claude session (cut §1.4 DoD), driven
 * by historical and synthetic W0 fixture frames through the narrow `ClaudeTransport` seam — the seam
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

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { SqlitePersistenceAdapter, bashTool } from "@anycode/core";
import { ClaudeShadowTranscriptEngine } from "./shadow-transcript.js";
import type { AgentEvent, ToolResultPresentation } from "@anycode/core";
import { claudeUsageRecord } from "../../claude-usage.js";
import { bindClaudeUsage } from "../../native-usage.js";
import { createHarness } from "../../test-harness.js";
import { createDesktopStore } from "../../../renderer/src/store.js";
import { saveRecovery, loadRecovery } from "../../../renderer/src/orchestration-recovery-storage.js";
import { RuntimeSessionHistory } from "../../runtime-session-history.js";
import { summarizeProviderUsage } from "../../session.js";
import {
  CLAUDE_ENGINE_CAPABILITIES,
  CLAUDE_PRESET_IDS,
  ClaudeEngine,
  type ClaudeEngineTimeouts,
  type ClaudeInitMcpServerStatus,
  type ClaudeTransport,
} from "./claude-engine.js";
import { ClaudeModelCatalog } from "./models.js";
import { findClaudePreset } from "./presets.js";
import { ClaudeClientError } from "./claude-client.js";
import { CLAUDE_INIT_HANDSHAKE_TIMEOUT_MS, CLAUDE_TEARDOWN_TOTAL_BUDGET_MS } from "../../../shared/claude-timeouts.js";
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

/** The synthetic `initialize` models[] catalog from the control-frame fixture. */
function fixtureCatalog(): ClaudeModelCatalog {
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
   * a per-call provider of `get_context_usage` readings. Each call
   * receives the call index (0-based) and returns a reading, a promise of one,
   * or throws. Takes precedence over `contextUsage` when present. Use
   * `deferredUsage()` to gate individual calls.
   */
  contextUsageSequence?: (call: number) => Record<string, unknown> | Promise<Record<string, unknown>>;
  /**
   * the error the parked notifications reader is rejected with when
   * `releaseStreamReject()` is called. Models a transport death mid-turn whose
   * rejection text is hostile — arbitrary text or a `ClaudeClientError` wrapping
   * provider text — exercising `engineDeathSafe`'s redaction from the real path.
   */
  rejectStreamOnce?: Error;
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
  /** concurrent in-flight `get_context_usage` requests right now. */
  activeContextUsage = 0;
  /** high-water mark of concurrent context requests. */
  maxConcurrentContextUsage = 0;
  interrupts = 0;
  closed = 0;
  readonly sent: (string | unknown[])[] = [];
  /** Frames pushed after a `sendUserMessage`, so a turn always sees them in order. */
  private pending: ClaudeStreamMessage[];
  private waiters: { resolve(result: IteratorResult<ClaudeStreamMessage>): void; reject(error: unknown): void }[] = [];
  private buffer: ClaudeStreamMessage[] = [];
  private done = false;
  /** the one-shot rejection to hand the parked reader (undefined once spent). */
  private streamReject: Error | undefined;
  /** a rejection armed before any reader parked, delivered on the next next(). */
  private armedStreamReject: Error | undefined;

  constructor(private readonly options: FakeTransportOptions = {}) {
    this.pending = [...(options.frames ?? [])];
    this.streamReject = options.rejectStreamOnce;
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
            if (self.armedStreamReject !== undefined) {
              const error = self.armedStreamReject;
              self.armedStreamReject = undefined;
              return Promise.reject(error);
            }
            const value = self.buffer.shift();
            if (value !== undefined) return Promise.resolve({ value, done: false });
            if (self.done) return Promise.resolve({ value: undefined, done: true });
            return new Promise((resolve, reject) => self.waiters.push({ resolve, reject }));
          },
        };
      },
    };
  }

  async close(): Promise<void> {
    this.closed += 1;
    this.order.push("close");
    this.done = true;
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ value: undefined, done: true });
  }

  /** frames delivered on the NEXT sendUserMessage (a later turn's stream). */
  enqueue(frame: ClaudeStreamMessage): void {
    this.pending.push(frame);
  }

  /** Delivers one frame to the turn (or buffers it until the turn asks). */
  push(frame: ClaudeStreamMessage): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve({ value: frame, done: false });
      return;
    }
    this.buffer.push(frame);
  }

  /**
   * reject the parked notifications reader with `rejectStreamOnce`.
   * A reader is normally parked while the engine awaits a frame; if none is
   * parked yet the rejection is armed for the next `next()` so the death lands
   * on the CURRENT turn deterministically, never on a later call's timing.
   */
  releaseStreamReject(): void {
    const error = this.streamReject;
    if (error === undefined) throw new Error("releaseStreamReject() called without rejectStreamOnce");
    this.streamReject = undefined;
    const waiter = this.waiters.shift();
    if (waiter !== undefined) waiter.reject(error);
    else this.armedStreamReject = error;
  }

  /**
   * gate the NEXT frames — the listed frames are withheld from
   * the stream until `release()` is called, mirroring a quiet stretch of a
   * live turn (a bridge call the CLI is waiting on, no frames flowing).
   * Delivered through the normal `push` path, so waiter/buffer plumbing is
   * the production one. Only meaningful before the frames' turn starts.
   */
  holdBack(frames: ClaudeStreamMessage[]): { release: () => void } {
    this.pending = this.pending.filter((frame) => !frames.includes(frame));
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        for (const frame of frames) this.push(frame);
      },
    };
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
  overrides: { model?: string; presetId?: string; catalog?: ClaudeModelCatalog; timeouts?: Partial<ClaudeEngineTimeouts>; slashPassthrough?: boolean; restricted?: () => boolean;
    /** Transports a resume (transport replacement) hands out, in order. */
    next?: ClaudeTransport[] } = {},
): ClaudeEngine {
  const catalog = overrides.catalog ?? fixtureCatalog();
  const next = overrides.next;
  const factory = next === undefined ? undefined : async () => {
    const client = next.shift();
    if (!client) throw new Error("no replacement transport left");
    return { client, approvals: undefined as never, close: () => client.close() };
  };
  return new ClaudeEngine(transport, "session-ref-1", undefined, {
    catalog,
    model: overrides.model ?? "default",
    preset: findClaudePreset(overrides.presetId ?? "ask")!,
    effortsByModel: new Map(),
    notices: [],
    slashPassthrough: overrides.slashPassthrough ?? true,
  }, overrides.timeouts, undefined, undefined, false, factory, undefined, overrides.restricted);
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function types(events: readonly AgentEvent[]): string[] {
  return events.map((event) => event.type);
}

/** a manually-gated `get_context_usage` reading. */
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

// ── CLI self-started (foreign) turn fixtures ──────────────────────

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

describe("Claude autonomous background turn through Session", () => {
  it.each(["local_bash", "local_agent", "unknown"])("folds a %s notification into an active autonomous turn", async (kind) => {
    const start = (id: string, type: string) => ({ type: "system", subtype: "task_started", task_id: id, run_id: `run-${id}`, tool_use_id: `tool-${id}`, task_type: type, is_backgrounded: true }) as unknown as ClaudeStreamMessage;
    const notify = (id: string) => ({ type: "system", subtype: "task_notification", task_id: id, run_id: `run-${id}`, tool_use_id: `tool-${id}`, status: "completed", summary: `report ${id}` }) as unknown as ClaudeStreamMessage;
    const init = { type: "system", subtype: "init", model: "default", permissionMode: "default", cwd: "/work", tools: [], mcp_servers: [], slash_commands: [], skills: [], capabilities: [] } as unknown as ClaudeStreamMessage;
    const transport = new FakeTransport({ frames: [start("a", "local_bash"), ...(kind === "unknown" ? [] : [start("b", kind)]), ...ownerFrames("initial")] });
    const engine = engineWith(transport); const native: Promise<AgentEvent[]>[] = []; const detached: AgentEvent[] = [];
    engine.onNativeTurn = turn => native.push(collect(turn));
    engine.onDetachedEvent = event => detached.push(event);
    try {
      await collect(engine.runTurn("launch", { signal: new AbortController().signal }));
      for (const frame of [notify("a"), init, foreignAssistantFrame("native", "FINAL ANSWER"), notify("b"), { ...foreignResultFrame("done"), origin: { kind: "task-notification", producer: "session-task", runId: "run-a" } }]) transport.push(frame as ClaudeStreamMessage);
      await vi.waitFor(() => expect(native).toHaveLength(1));
      const events = await native[0]!;
      expect(JSON.stringify(events)).toContain("FINAL ANSWER");
      expect(events.filter(event => event.type === "error")).toHaveLength(0);
      expect(events).toContainEqual(expect.objectContaining({ type: "loop_end", reason: "completed" }));
      if (kind === "local_agent") expect(detached.filter(event => event.type === "subagent_end" && event.toolCallId === "tool-b")).toHaveLength(1);
      if (kind === "local_bash") expect(detached.filter(event => event.type === "claude_background_task" && event.taskId === "b" && event.status === "completed")).toHaveLength(1);
      for (const frame of [init, foreignAssistantFrame("foreign", "UNRELATED"), foreignResultFrame("foreign")]) transport.push(frame);
      await vi.waitFor(() => expect((engine as unknown as { foreignTurn: unknown }).foreignTurn).toBeNull());
      expect(native).toHaveLength(1);
    } finally { await engine.dispose("session-close"); }
  });

  it("delivers a successful autonomous result without origin while logging its uncertain attribution", async () => {
    const start = { type: "system", subtype: "task_started", task_id: "a", tool_use_id: "tool-a", task_type: "local_bash" } as unknown as ClaudeStreamMessage;
    const transport = new FakeTransport({ frames: [start, ...ownerFrames("initial")] });
    const engine = engineWith(transport); const native: Promise<AgentEvent[]>[] = [];
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    engine.onNativeTurn = turn => native.push(collect(turn));
    try {
      await collect(engine.runTurn("launch", { signal: new AbortController().signal }));
      for (const frame of [{ type: "system", subtype: "task_notification", task_id: "a", tool_use_id: "tool-a", status: "completed" }, { type: "system", subtype: "init", model: "default", permissionMode: "default", cwd: "/work", tools: [], mcp_servers: [], slash_commands: [], skills: [], capabilities: [] }, foreignAssistantFrame("native", "ANSWER"), foreignResultFrame("done")]) transport.push(frame as ClaudeStreamMessage);
      await vi.waitFor(() => expect(native).toHaveLength(1));
      const events = await native[0]!;
      expect(JSON.stringify(events)).toContain("ANSWER");
      expect(events).toContainEqual(expect.objectContaining({ type: "loop_end", reason: "completed" }));
      expect(log).toHaveBeenCalledWith("[claude] autonomous turn result did not identify a task notification");
    } finally { log.mockRestore(); await engine.dispose("session-close"); }
  });
  it("preserves a second notification encountered while releasing buffered owner frames", async () => {
    const task = (id: string) => ({ type: "system", subtype: "task_started", task_id: id, tool_use_id: `tool-${id}`, task_type: "local_bash" }) as unknown as ClaudeStreamMessage;
    const notify = (id: string) => ({ type: "system", subtype: "task_notification", task_id: id, tool_use_id: `tool-${id}`, status: "completed" }) as unknown as ClaudeStreamMessage;
    const init = { type: "system", subtype: "init", model: "default", permissionMode: "default", cwd: "/work", tools: [], mcp_servers: [], slash_commands: [], skills: [], capabilities: [] } as unknown as ClaudeStreamMessage;
    const transport = new FakeTransport({ frames: [task("a"), ...ownerFrames("initial")] });
    const engine = engineWith(transport); const native: Promise<AgentEvent[]>[] = [];
    engine.onNativeTurn = turn => native.push(collect(turn));
    try {
      await collect(engine.runTurn("launch", { signal: new AbortController().signal }));
      for (const frame of [notify("a"), { type: "user", isReplay: true, message: { role: "user", content: "next" } }, init, task("b"), notify("b"), ...ownerFrames("next")]) transport.enqueue(frame as ClaudeStreamMessage);
      const owner = await collect(engine.runTurn("next", { signal: new AbortController().signal }));
      expect(owner).toContainEqual(expect.objectContaining({ type: "claude_background_task", taskId: "b", status: "completed" }));
      for (const id of ["a", "b"]) for (const frame of [init, foreignAssistantFrame(id, `NATIVE ${id}`), { ...foreignResultFrame(id), origin: { kind: "task-notification", producer: "session-task", runId: id } }]) transport.push(frame as ClaudeStreamMessage);
      await vi.waitFor(() => expect(native).toHaveLength(2));
      expect(JSON.stringify(await native[0]!)).toContain("NATIVE a");
      expect(JSON.stringify(await native[1]!)).toContain("NATIVE b");
    } finally { await engine.dispose("session-close"); }
  });

  it("marks running background tasks unknown on EOF and restores that status on reconnect", async () => {
    const task = { type: "system", subtype: "task_started", task_id: "bg-eof", tool_use_id: "bash", task_type: "local_bash" } as unknown as ClaudeStreamMessage;
    const transport = new FakeTransport({ frames: [task, ...ownerFrames("initial")] });
    const raw = engineWith(transport);
    const shadow = new ClaudeShadowTranscriptEngine(raw, { record: () => {}, list: async () => [] }, "session-ref-1", []);
    const h = createHarness({ steps: [], engine: shadow });
    raw.onDetachedEvent = event => h.session.emitDetachedSubagentEvent(event);
    try {
      h.send({ type: "ui_ready" }); await h.waitFor(m => m.type === "host_ready");
      h.send({ type: "user_message", requestId: "initial", text: "launch" });
      await h.waitUntil(() => h.received.some(m => m.type === "agent_event" && m.event.type === "loop_end"));
      await transport.close();
      await h.waitUntil(() => h.received.some(m => m.type === "agent_event" && m.event.type === "claude_background_task" && m.event.taskId === "bg-eof" && m.event.status === "unknown"));
      const before = h.received.length;
      h.send({ type: "ui_ready" }); await h.waitUntil(() => h.received.slice(before).some(m => m.type === "agent_event" && m.event.type === "claude_background_task" && m.event.taskId === "bg-eof" && m.event.status === "unknown"));
      await h.flush();
      const store = createDesktopStore();
      for (const message of h.received.slice(before)) store.getState().applyHostMessage(message);
      expect(store.getState().claudeBackgroundTasks).toMatchObject([{ taskId: "bg-eof", status: "unknown", summary: "Claude connection ended; task status is unknown." }]);
    } finally { await h.session.shutdown(); h.close(); }
  });
  it.each(["unknown-task", "no-listener", "cancelled"])("does not refresh quota for an unaccepted native turn: %s", async (scenario) => {
    const task = { type: "system", subtype: "task_started", task_id: "bg", tool_use_id: "bash", task_type: "local_bash" } as unknown as ClaudeStreamMessage;
    const transport = new FakeTransport({ frames: [task, ...ownerFrames("initial")], contextUsage: { totalTokens: 1, maxTokens: 2 } });
    const original = transport.controlRequest.bind(transport);
    let calls = 0;
    vi.spyOn(transport, "controlRequest").mockImplementation(async (subtype, request) => {
      if (subtype !== "get_usage") return original(subtype, request);
      calls++;
      return { rate_limits: { limits: [{ kind: "session", percent: 10 }] } } as never;
    });
    const engine = engineWith(transport); const detached: AgentEvent[] = [];
    engine.onDetachedEvent = event => detached.push(event);
    if (scenario !== "no-listener") engine.onNativeTurn = turn => {
      if (scenario === "cancelled") turn.cancel();
      void collect(turn);
    };
    try {
      await collect(engine.runTurn("launch", { signal: new AbortController().signal }));
      await vi.waitFor(() => expect(detached.some(event => event.type === "engine_quota")).toBe(true));
      transport.push({ type: "system", subtype: "task_notification", task_id: scenario === "unknown-task" ? "other" : "bg", tool_use_id: scenario === "unknown-task" ? "other" : "bash", status: "completed" } as unknown as ClaudeStreamMessage);
      transport.push({ type: "system", subtype: "init", model: "default", permissionMode: "default", cwd: "/work", tools: [], mcp_servers: [], slash_commands: [], skills: [], capabilities: [] } as unknown as ClaudeStreamMessage);
      transport.push(foreignAssistantFrame("candidate", "candidate"));
      const state = engine as unknown as { foreignTurn: unknown };
      await vi.waitFor(() => expect(state.foreignTurn).not.toBeNull());
      transport.push({ ...foreignResultFrame("done"), origin: { kind: scenario === "wrong-origin" ? "other" : "task-notification", producer: "session-task", runId: "run" } } as ClaudeStreamMessage);
      await vi.waitFor(() => expect(state.foreignTurn).toBeNull());
      await new Promise(resolve => setTimeout(resolve, 25));
      expect(calls).toBe(1);
      expect(detached.filter(event => event.type === "engine_quota")).toHaveLength(1);
    } finally { await engine.dispose("session-close"); }
  });
  it("refreshes quota after an accepted idle native turn through Session and renderer", async () => {
    const task = { type: "system", subtype: "task_started", task_id: "bg-quota", tool_use_id: "bash-quota", task_type: "local_bash" } as unknown as ClaudeStreamMessage;
    const transport = new FakeTransport({ frames: [task, ...ownerFrames("initial")], contextUsage: { totalTokens: 1, maxTokens: 2 } });
    const original = transport.controlRequest.bind(transport);
    let calls = 0;
    vi.spyOn(transport, "controlRequest").mockImplementation(async (subtype, request) => {
      if (subtype !== "get_usage") return original(subtype, request);
      calls++;
      return { rate_limits: { limits: [{ kind: "session", percent: calls === 1 ? 10 : 31, is_active: true }, { kind: "weekly_all", percent: calls === 1 ? 20 : 62 }] } } as never;
    });
    const raw = engineWith(transport);
    const shadow = new ClaudeShadowTranscriptEngine(raw, { record: () => {}, list: async () => [] }, "session-ref-1", []);
    const h = createHarness({ steps: [], engine: shadow });
    raw.onNativeTurn = turn => h.session.acceptClaudeNativeTurn(shadow, turn);
    raw.onDetachedEvent = event => h.session.emitDetachedSubagentEvent(event);
    try {
      h.send({ type: "ui_ready" }); await h.waitFor(m => m.type === "host_ready");
      h.send({ type: "user_message", requestId: "initial", text: "launch" });
      await h.waitUntil(() => h.received.some(m => m.type === "agent_event" && m.event.type === "engine_quota" && m.event.quota.primary?.usedPercent === 10));
      for (const frame of [
        { type: "system", subtype: "task_notification", task_id: "bg-quota", tool_use_id: "bash-quota", status: "completed" },
        { type: "system", subtype: "init", model: "default", permissionMode: "default", cwd: "/work", tools: [], mcp_servers: [], slash_commands: [], skills: [], capabilities: [] },
        foreignAssistantFrame("native-quota", "native done"),
        { ...foreignResultFrame("done"), origin: { kind: "task-notification", producer: "session-task", runId: "run" } },
      ]) transport.push(frame as ClaudeStreamMessage);
      await h.waitUntil(() => h.received.some(m => m.type === "agent_event" && m.event.type === "engine_quota" && m.event.quota.primary?.usedPercent === 31));
      expect(calls).toBe(2);
      const store = createDesktopStore();
      for (const message of h.received) store.getState().applyHostMessage(message);
      expect(store.getState().quota).toMatchObject({ primary: { usedPercent: 31 }, secondary: { usedPercent: 62 } });
    } finally { await h.session.shutdown(); h.close(); }
  }, 10_000);
  it("shows two ordinary answers live after an orphaned notification without persisting the preview", async () => {
    const task = { type: "system", subtype: "task_started", task_id: "bg", tool_use_id: "bash", task_type: "local_bash" } as unknown as ClaudeStreamMessage;
    const init = { type: "system", subtype: "init", model: "default", permissionMode: "default", cwd: "/work", tools: [], mcp_servers: [], slash_commands: [], skills: [], capabilities: [] } as unknown as ClaudeStreamMessage;
    const transport = new FakeTransport({ frames: [task, ...ownerFrames("initial")], contextUsage: { totalTokens: 1, maxTokens: 2 } });
    const raw = engineWith(transport);
    const rows: Parameters<ConstructorParameters<typeof ClaudeShadowTranscriptEngine>[1]["record"]>[1][number][] = [];
    const shadow = new ClaudeShadowTranscriptEngine(raw, { record: (_ref, items) => { rows.push(...items); }, list: async () => rows }, "session-ref-1", []);
    const h = createHarness({ steps: [], engine: shadow });
    raw.onNativeTurn = turn => h.session.acceptClaudeNativeTurn(shadow, turn);
    raw.onDetachedEvent = event => h.session.emitDetachedSubagentEvent(event);
    const completedTurns = () => new Set(h.received.flatMap(m => m.type === "agent_event" && m.event.type === "loop_end" ? [m.turnId] : [])).size;
    try {
      h.send({ type: "ui_ready" }); await h.waitFor(m => m.type === "host_ready");
      h.send({ type: "user_message", requestId: "initial", text: "launch" });
      await h.waitUntil(() => completedTurns() === 1);
      transport.push({ type: "system", subtype: "task_notification", task_id: "bg", tool_use_id: "bash", status: "completed" } as unknown as ClaudeStreamMessage);
      await h.waitUntil(() => h.received.some(m => m.type === "agent_event" && m.event.type === "claude_background_task" && m.event.status === "completed"));
      for (const [index, label] of ["first", "second"].entries()) {
        h.send({ type: "user_message", requestId: label, text: label });
        await h.waitUntil(() => transport.sent.length === index + 2);
        for (const frame of [
          { type: "user", isReplay: true, message: { role: "user", content: label } }, init,
          { type: "stream_event", event: { type: "message_start", message: { id: label } } },
          { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text" } } },
          { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `LIVE ${label}` } } },
        ]) transport.push(frame as ClaudeStreamMessage);
        await h.waitUntil(() => h.received.some(m => m.type === "agent_event" && m.event.type === "claude_turn_preview" && m.event.preview?.text === `LIVE ${label}`));
        transport.push(foreignAssistantFrame(label, `LIVE ${label}`));
        transport.push(foreignToolUseFrame(label, "Bash"));
        await h.waitUntil(() => h.received.some(m => m.type === "agent_event" && m.event.type === "claude_turn_preview" && m.event.preview?.text === `LIVE ${label}` && m.event.preview.tools.some(t => t.name === "Bash" && t.status === "requested")));
        if (index === 0) {
          const before = h.received.length;
          h.send({ type: "ui_ready" });
          await h.waitUntil(() => h.received.slice(before).some(m => m.type === "agent_event" && m.event.type === "claude_turn_preview" && m.event.preview?.text === "LIVE first"));
          await h.flush();
          const reconnected = createDesktopStore();
          for (const message of h.received.slice(before)) reconnected.getState().applyHostMessage(message);
          expect(reconnected.getState().claudeTurnPreview).toMatchObject({ text: "LIVE first", tools: [{ name: "Bash", status: "requested" }] });
          expect(JSON.stringify(reconnected.getState().transcript)).not.toContain("LIVE first");
        }
        expect(JSON.stringify(rows)).not.toContain(`LIVE ${label}`);
        expect(completedTurns()).toBe(index + 1);
        transport.push(foreignResultFrame(label));
        await h.waitUntil(() => completedTurns() === index + 2);
        await vi.waitFor(() => expect(JSON.stringify(rows)).toContain(`LIVE ${label}`));
        expect(JSON.stringify(rows).split(`LIVE ${label}`).length - 1).toBe(1);
        const sentEvents = h.received.filter(m => m.type === "agent_event" && m.event.type === "claude_turn_preview");
        expect(sentEvents.at(-1)).toMatchObject({ event: { preview: null } });
      }
      const journal = (h.session as unknown as { presentationJournal: { snapshot(): unknown } }).presentationJournal;
      expect(JSON.stringify(journal.snapshot())).not.toContain("claude_turn_preview");
      expect(transport.sent).toEqual(["launch", "first", "second"]);
    } finally { await h.session.shutdown(); h.close(); }
  }, 10_000);

  it("clears a provisional answer immediately on cancellation", async () => {
    const start = { type: "system", subtype: "task_started", task_id: "bg", tool_use_id: "bash", task_type: "local_bash" } as unknown as ClaudeStreamMessage;
    const transport = new FakeTransport({ frames: [start, ...ownerFrames("initial")], contextUsage: { totalTokens: 1, maxTokens: 2 } });
    const engine = engineWith(transport); const controller = new AbortController(); const events: AgentEvent[] = [];
    try {
      await collect(engine.runTurn("launch", { signal: new AbortController().signal }));
      const pending = (async () => { for await (const event of engine.runTurn("next", { signal: controller.signal })) events.push(event); })();
      await vi.waitFor(() => expect(transport.sent).toHaveLength(2));
      for (const frame of [
        { type: "user", isReplay: true, message: { role: "user", content: "next" } },
        { type: "system", subtype: "task_notification", task_id: "bg", tool_use_id: "bash", status: "completed" },
        { type: "system", subtype: "init", model: "default", permissionMode: "default", cwd: "/work", tools: [], mcp_servers: [], slash_commands: [], skills: [], capabilities: [] },
        foreignAssistantFrame("candidate", "LIVE BEFORE STOP"),
      ]) transport.push(frame as ClaudeStreamMessage);
      await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: "claude_turn_preview", preview: expect.objectContaining({ text: "LIVE BEFORE STOP" }) })));
      controller.abort();
      await vi.waitFor(() => expect(events).toContainEqual({ type: "claude_turn_preview", preview: null }));
      transport.push({ ...foreignResultFrame("stopped"), terminal_reason: "aborted_streaming" } as ClaudeStreamMessage);
      await pending;
    } finally { await engine.dispose("session-close"); }
  });
  it("retains a notification when the owner runs before the autonomous turn", async () => {
    const start = { type: "system", subtype: "task_started", task_id: "bg", tool_use_id: "bash", task_type: "local_bash" } as unknown as ClaudeStreamMessage;
    const init = { type: "system", subtype: "init", model: "default", permissionMode: "default", cwd: "/work", tools: [], mcp_servers: [], slash_commands: [], skills: [], capabilities: [] } as unknown as ClaudeStreamMessage;
    const transport = new FakeTransport({ frames: [start, ...ownerFrames("initial")], contextUsage: { totalTokens: 1, maxTokens: 2 } });
    const engine = engineWith(transport); const streams: Promise<AgentEvent[]>[] = [];
    engine.onNativeTurn = turn => streams.push(collect(turn));
    try {
      await collect(engine.runTurn("launch", { signal: new AbortController().signal }));
      for (const frame of [
        { type: "system", subtype: "task_notification", task_id: "bg", tool_use_id: "bash", status: "completed" },
        { type: "user", isReplay: true, message: { role: "user", content: "next" } }, init, ...ownerFrames("next"),
      ]) transport.enqueue(frame as ClaudeStreamMessage);
      const owner = await collect(engine.runTurn("next", { signal: new AbortController().signal }));
      expect(JSON.stringify(owner)).toContain("OWNER OUTPUT next");
      for (const frame of [init, foreignAssistantFrame("native", "LATER NATIVE"), { ...foreignResultFrame("native"), origin: { kind: "task-notification", producer: "session-task", runId: "run" } }]) transport.push(frame as ClaudeStreamMessage);
      await vi.waitFor(() => expect(streams).toHaveLength(1));
      expect(JSON.stringify(await streams[0]!)).toContain("LATER NATIVE");
    } finally { await engine.dispose("session-close"); }
  });

  it("does not attribute an unknown notified turn to an active owner", async () => {
    const transport = new FakeTransport({ frames: ownerFrames("initial"), contextUsage: { totalTokens: 1, maxTokens: 2 } });
    const engine = engineWith(transport); const adopted = vi.fn(); engine.onNativeTurn = adopted;
    try {
      await collect(engine.runTurn("launch", { signal: new AbortController().signal }));
      for (const frame of [
        { type: "user", isReplay: true, message: { role: "user", content: "next" } },
        { type: "system", subtype: "task_notification", task_id: "unknown", tool_use_id: "other", status: "completed" },
        { type: "system", subtype: "init", model: "default", permissionMode: "default", cwd: "/work", tools: [], mcp_servers: [], slash_commands: [], skills: [], capabilities: [] },
        foreignAssistantFrame("foreign", "FOREIGN PRIVATE"),
        { ...foreignResultFrame("foreign"), origin: { kind: "task-notification", producer: "session-task", runId: "other" } },
        ...ownerFrames("next"),
      ]) transport.enqueue(frame as ClaudeStreamMessage);
      const owner = await collect(engine.runTurn("next", { signal: new AbortController().signal }));
      expect(JSON.stringify(owner)).toContain("OWNER OUTPUT next");
      expect(JSON.stringify(owner.filter(event => event.type !== "claude_turn_preview"))).not.toContain("FOREIGN PRIVATE");
      expect(owner).toContainEqual({ type: "claude_turn_preview", preview: null });
      expect(adopted).not.toHaveBeenCalled();
      expect(owner).toContainEqual(expect.objectContaining({ type: "loop_end", reason: "completed" }));
    } finally { await engine.dispose("session-close"); }
  });

  it("recognises a normalized attachment replay while a notification is pending", async () => {
    const start = { type: "system", subtype: "task_started", task_id: "bg", tool_use_id: "bash", task_type: "local_bash" } as unknown as ClaudeStreamMessage;
    const transport = new FakeTransport({ frames: [start, ...ownerFrames("initial")], contextUsage: { totalTokens: 1, maxTokens: 2 } });
    const engine = engineWith(transport);
    try {
      await collect(engine.runTurn("launch", { signal: new AbortController().signal }));
      for (const frame of [
        { type: "system", subtype: "task_notification", task_id: "bg", tool_use_id: "bash", status: "completed" },
        { type: "user", isReplay: true, message: { role: "user", content: [{ type: "text", text: "inspect" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "NORMALIZED" }, extra: true }] } },
        { type: "system", subtype: "init", model: "default", permissionMode: "default", cwd: "/work", tools: [], mcp_servers: [], slash_commands: [], skills: [], capabilities: [] },
        ...ownerFrames("attachment"),
      ]) transport.enqueue(frame as ClaudeStreamMessage);
      const owner = await collect(engine.runTurn("inspect", { signal: new AbortController().signal, attachments: [{ mediaType: "image/png", data: "AA==" }] }));
      expect(JSON.stringify(owner)).toContain("OWNER OUTPUT attachment");
      expect(owner).toContainEqual(expect.objectContaining({ type: "loop_end", reason: "completed" }));
    } finally { await engine.dispose("session-close"); }
  });
  it.each(["b", "a"])("settles two notifications (second task %s) and a concurrent owner turn independently", async (secondTask) => {
    const task = (id: string) => ({ type: "system", subtype: "task_started", task_id: id, tool_use_id: `tool-${id}`, task_type: "local_bash" }) as unknown as ClaudeStreamMessage;
    const notify = (id: string) => ({ type: "system", subtype: "task_notification", task_id: id, tool_use_id: `tool-${id}`, status: "completed" }) as unknown as ClaudeStreamMessage;
    const init = { type: "system", subtype: "init", model: "default", permissionMode: "default", cwd: "/work", tools: [], mcp_servers: [], slash_commands: [], skills: [], capabilities: [] } as unknown as ClaudeStreamMessage;
    const transport = new FakeTransport({ frames: [task("a"), task("b"), ...ownerFrames("initial")], contextUsage: { totalTokens: 1, maxTokens: 2 } });
    const raw = engineWith(transport);
    const rows: Parameters<ConstructorParameters<typeof ClaudeShadowTranscriptEngine>[1]["record"]>[1][number][] = [];
    const shadow = new ClaudeShadowTranscriptEngine(raw, { record: (_ref, items) => { rows.push(...items); }, list: async () => rows }, "session-ref-1", []);
    const h = createHarness({ steps: [], engine: shadow });
    raw.onNativeTurn = turn => h.session.acceptClaudeNativeTurn(shadow, turn);
    try {
      h.send({ type: "ui_ready" }); await h.waitFor(m => m.type === "host_ready");
      h.send({ type: "user_message", requestId: "initial", text: "launch" });
      await h.waitUntil(() => h.received.filter(m => m.type === "agent_event" && m.event.type === "loop_end").length === 1);
      h.send({ type: "user_message", requestId: "next", text: "next question" });
      await h.waitUntil(() => transport.sent.length === 2);
      for (const frame of [
        { type: "user", isReplay: true, message: { role: "user", content: "next question" } },
        notify("a"), notify(secondTask), init,
        foreignAssistantFrame("native-a", "NATIVE A"),
        { ...foreignResultFrame("a"), origin: { kind: "task-notification", producer: "session-task", runId: "a" } },
        init, foreignAssistantFrame("native-b", "NATIVE B"),
        { ...foreignResultFrame("b"), origin: { kind: "task-notification", producer: "session-task", runId: "b" } },
        ...ownerFrames("next"),
      ]) transport.push(frame as ClaudeStreamMessage);
      await h.waitUntil(() => h.received.filter(m => m.type === "agent_event" && m.event.type === "loop_end").length === 4);
      const ends = h.received.filter(m => m.type === "agent_event" && m.event.type === "loop_end");
      expect(ends.every(m => m.type === "agent_event" && m.event.type === "loop_end" && m.event.reason === "completed")).toBe(true);
      expect(h.received.filter(m => m.type === "turn_started")).toHaveLength(4);
      const messages = rows.map(row => (row.data as { message: { role: string; content: unknown } }).message);
      expect(messages.filter(message => message.role === "user").map(message => message.content)).toEqual(["launch", "next question"]);
      expect(JSON.stringify(rows)).toContain("NATIVE A");
      expect(JSON.stringify(rows)).toContain("NATIVE B");
      expect(JSON.stringify(rows)).toContain("OWNER OUTPUT next");
      const ownerRow = rows.find(row => (row.data as { message: { role: string; content: unknown } }).message.role === "user" && (row.data as { message: { content: unknown } }).message.content === "next question");
      const ownerTurnId = (ownerRow?.data as { turnId?: string } | undefined)?.turnId;
      expect(ownerTurnId).toBeTruthy();
      const ownerHistory = rows.filter(row => (row.data as { turnId?: string }).turnId === ownerTurnId);
      expect(JSON.stringify(ownerHistory)).toContain("OWNER OUTPUT next");
      expect(JSON.stringify(ownerHistory)).not.toContain("NATIVE A");
      expect(JSON.stringify(ownerHistory)).not.toContain("NATIVE B");
      expect(transport.sent).toEqual(["launch", "next question"]);
    } finally { await h.session.shutdown(); h.close(); }
  }, 10_000);

  it("ends an owner turn safely on a result with an unsolicited origin", async () => {
    const transport = new FakeTransport({ frames: [{ ...foreignResultFrame("foreign"), origin: { kind: "task-notification", producer: "session-task", runId: "foreign" } } as ClaudeStreamMessage], contextUsage: { totalTokens: 1, maxTokens: 2 } });
    const engine = engineWith(transport);
    try {
      const events = await collect(engine.runTurn("owner", { signal: new AbortController().signal }));
      // Not an engine failure: the turn ends unconfirmed with a warning.
      expect(events.some(event => event.type === "error")).toBe(false);
      expect(events).toContainEqual(expect.objectContaining({ type: "loop_end", reason: "cancelled" }));
      expect(events).not.toContainEqual(expect.objectContaining({ type: "loop_end", reason: "completed" }));
      expect(JSON.stringify(events)).not.toContain("foreign");
    } finally { await engine.dispose("session-close"); }
  });
  it("does not attribute an ambiguous result to an owner without its replayed input", async () => {
    const start = { type: "system", subtype: "task_started", task_id: "bg", tool_use_id: "bash", task_type: "local_bash" } as unknown as ClaudeStreamMessage;
    const transport = new FakeTransport({ frames: [start, ...ownerFrames("initial")], contextUsage: { totalTokens: 1, maxTokens: 2 } });
    const after = new FakeTransport({ frames: ownerFrames("after"), contextUsage: { totalTokens: 1, maxTokens: 2 } });
    const engine = engineWith(transport, { next: [after] });
    try {
      await collect(engine.runTurn("launch", { signal: new AbortController().signal }));
      for (const frame of [
        { type: "system", subtype: "task_notification", task_id: "bg", tool_use_id: "bash", status: "completed" },
        { type: "system", subtype: "init", model: "default", permissionMode: "default", cwd: "/work", tools: [], mcp_servers: [], slash_commands: [], skills: [], capabilities: [] },
        foreignAssistantFrame("other", "FOREIGN OUTPUT"), foreignResultFrame("other"),
      ]) transport.enqueue(frame as ClaudeStreamMessage);
      const events = await collect(engine.runTurn("owner", { signal: new AbortController().signal }));
      expect(JSON.stringify(events.filter(event => event.type !== "claude_turn_preview"))).not.toContain("FOREIGN OUTPUT");
      expect(events).toContainEqual({ type: "claude_turn_preview", preview: null });
      // Unattributable, but not an engine failure: the output stays out and the engine lives on.
      expect(events).toContainEqual(expect.objectContaining({ type: "engine_notice", level: "warning" }));
      expect(events).toContainEqual(expect.objectContaining({ type: "loop_end", reason: "cancelled" }));
      expect(events.some(event => event.type === "error")).toBe(false);
      // The process that may still answer is retired; the next input goes to a resumed one.
      const next = await collect(engine.runTurn("after", { signal: new AbortController().signal }));
      expect(transport.closed).toBeGreaterThan(0);
      expect(transport.sent).toHaveLength(2);
      expect(after.sent).toEqual(["after"]);
      expect(JSON.stringify(next)).toContain("OWNER OUTPUT after");
      expect(next).toContainEqual(expect.objectContaining({ type: "loop_end", reason: "completed" }));
    } finally { await engine.dispose("session-close"); }
  });
  it.each(["idle", "owner turn"])("keeps the next owner turn when a %s notification starts no native turn", async (when) => {
    const start = { type: "system", subtype: "task_started", task_id: "bg", tool_use_id: "bash", task_type: "local_bash" } as unknown as ClaudeStreamMessage;
    const notification = { type: "system", subtype: "task_notification", task_id: "bg", tool_use_id: "bash", status: "completed" } as unknown as ClaudeStreamMessage;
    const transport = new FakeTransport({ frames: when === "idle" ? [start, ...ownerFrames("initial")] : [start, foreignAssistantFrame("first", "initial")], contextUsage: { totalTokens: 1, maxTokens: 2 } });
    const engine = engineWith(transport); const native: Promise<AgentEvent[]>[] = [];
    engine.onNativeTurn = turn => native.push(collect(turn));
    const detached: AgentEvent[] = []; engine.onDetachedEvent = event => detached.push(event);
    try {
      const first = collect(engine.runTurn("launch", { signal: new AbortController().signal }));
      if (when === "owner turn") {
        await vi.waitFor(() => expect(transport.sent).toHaveLength(1));
        transport.push(notification); transport.push(foreignResultFrame("initial"));
      }
      await first;
      if (when === "idle") {
        transport.push(notification);
        await vi.waitFor(() => expect(detached).toContainEqual(expect.objectContaining({ type: "claude_background_task", status: "completed" })));
      }
      transport.enqueue({ type: "user", isReplay: true, message: { role: "user", content: "next" } } as unknown as ClaudeStreamMessage);
      transport.enqueue({ type: "system", subtype: "init", model: "default", permissionMode: "default", cwd: "/work", tools: [], mcp_servers: [], slash_commands: [], skills: [], capabilities: [] } as unknown as ClaudeStreamMessage);
      for (const frame of ownerFrames("next")) transport.enqueue(frame);
      const owner = await collect(engine.runTurn("next", { signal: new AbortController().signal }));
      expect(JSON.stringify(owner)).toContain("OWNER OUTPUT next");
      expect(owner).toContainEqual(expect.objectContaining({ type: "loop_end", reason: "completed" }));
      expect(native).toHaveLength(0);
    } finally { await engine.dispose("session-close"); }
  });
  it("does not close a dispatched user turn on a task-notification result", async () => {
    const task = { type: "system", subtype: "task_started", task_id: "bg", tool_use_id: "bash", task_type: "local_bash" } as unknown as ClaudeStreamMessage;
    const transport = new FakeTransport({ frames: [task, ...ownerFrames("initial")], contextUsage: { totalTokens: 1, maxTokens: 2 } });
    const engine = engineWith(transport);
    const native: Promise<AgentEvent[]>[] = [];
    engine.onNativeTurn = stream => native.push(collect(stream));
    try {
      await collect(engine.runTurn("launch", { signal: new AbortController().signal }));
      for (const frame of [
        { type: "user", isReplay: true, message: { role: "user", content: "next" } },
        { type: "system", subtype: "task_notification", task_id: "bg", tool_use_id: "bash", status: "completed" },
        { type: "system", subtype: "init", model: "default", permissionMode: "default", cwd: "/work", tools: [], mcp_servers: [], slash_commands: [], skills: [], capabilities: [] },
        foreignAssistantFrame("native", "NATIVE RESULT"),
        { ...foreignResultFrame("native"), origin: { kind: "task-notification", producer: "session-task", runId: "run" } },
        ...ownerFrames("next"),
      ]) transport.enqueue(frame as ClaudeStreamMessage);
      const owner = await collect(engine.runTurn("next", { signal: new AbortController().signal }));
      expect(JSON.stringify(owner)).toContain("OWNER OUTPUT next");
      expect(JSON.stringify(owner.filter(event => event.type !== "claude_turn_preview"))).not.toContain("NATIVE RESULT");
      expect(JSON.stringify(await native[0]!)).toContain("NATIVE RESULT");
      expect(transport.sent).toEqual(["launch", "next"]);
    } finally { await engine.dispose("session-close"); }
  });
  it("preserves a successful admitted turn even when its result has no origin", async () => {
    const task = (id: string) => ({ type: "system", subtype: "task_started", task_id: id, tool_use_id: `tool-${id}`, task_type: "local_bash" }) as unknown as ClaudeStreamMessage;
    const notify = (id: string) => ({ type: "system", subtype: "task_notification", task_id: id, tool_use_id: `tool-${id}`, status: "completed" }) as unknown as ClaudeStreamMessage;
    const transport = new FakeTransport({ frames: [task("a"), task("b"), ...ownerFrames("initial")], contextUsage: { totalTokens: 1, maxTokens: 2 } });
    const engine = engineWith(transport);
    const streams: Promise<AgentEvent[]>[] = [];
    engine.onNativeTurn = stream => streams.push(collect(stream));
    try {
      await collect(engine.runTurn("launch", { signal: new AbortController().signal }));
      transport.push(notify("a")); transport.push(notify("b"));
      transport.push({ type: "system", subtype: "init", model: "default", permissionMode: "default", cwd: "/work", tools: [], mcp_servers: [], slash_commands: [], skills: [], capabilities: [] } as unknown as ClaudeStreamMessage);
      transport.push(foreignAssistantFrame("ambiguous", "FOREIGN SECRET"));
      await vi.waitFor(() => expect(streams).toHaveLength(1));
      transport.push(foreignResultFrame("unknown origin"));
      const events = await streams[0]!;
      expect(JSON.stringify(events)).toContain("FOREIGN SECRET");
      expect(events).toContainEqual(expect.objectContaining({ type: "loop_end", reason: "completed" }));
      expect(transport.sent).toEqual(["launch"]);
    } finally { await engine.dispose("session-close"); }
  });

  it("does not adopt an unsolicited foreign turn after an unknown notification", async () => {
    const transport = new FakeTransport({ frames: ownerFrames("initial"), contextUsage: { totalTokens: 1, maxTokens: 2 } });
    const engine = engineWith(transport);
    const adopted = vi.fn(); engine.onNativeTurn = adopted;
    try {
      await collect(engine.runTurn("launch", { signal: new AbortController().signal }));
      transport.push({ type: "system", subtype: "task_notification", task_id: "unknown", tool_use_id: "other", status: "completed" } as unknown as ClaudeStreamMessage);
      transport.push({ type: "system", subtype: "init", model: "default", permissionMode: "default", cwd: "/work", tools: [], mcp_servers: [], slash_commands: [], skills: [], capabilities: [] } as unknown as ClaudeStreamMessage);
      transport.push(foreignAssistantFrame("other", "foreign"));
      transport.push(foreignResultFrame("foreign"));
      for (const frame of ownerFrames("after")) transport.enqueue(frame);
      const owner = await collect(engine.runTurn("after", { signal: new AbortController().signal }));
      expect(JSON.stringify(owner)).toContain("OWNER OUTPUT after");
      expect(adopted).not.toHaveBeenCalled();
    } finally { await engine.dispose("session-close"); }
  });

  it("does not adopt a turn when a known and an unknown notification are mixed", async () => {
    const task = { type: "system", subtype: "task_started", task_id: "known", tool_use_id: "own", task_type: "local_bash" } as unknown as ClaudeStreamMessage;
    const transport = new FakeTransport({ frames: [task, ...ownerFrames("initial")], contextUsage: { totalTokens: 1, maxTokens: 2 } });
    const engine = engineWith(transport); const adopted = vi.fn(); engine.onNativeTurn = adopted;
    try {
      await collect(engine.runTurn("launch", { signal: new AbortController().signal }));
      for (const frame of [
        { type: "system", subtype: "task_notification", task_id: "known", tool_use_id: "own", status: "completed" },
        { type: "system", subtype: "task_notification", task_id: "unknown", tool_use_id: "other", status: "completed" },
        { type: "system", subtype: "init", model: "default", permissionMode: "default", cwd: "/work", tools: [], mcp_servers: [], slash_commands: [], skills: [], capabilities: [] },
        foreignAssistantFrame("other", "foreign"),
        { ...foreignResultFrame("foreign"), origin: { kind: "task-notification", producer: "session-task", runId: "unknown" } },
      ]) transport.push(frame as ClaudeStreamMessage);
      for (const frame of ownerFrames("after")) transport.enqueue(frame);
      await collect(engine.runTurn("after", { signal: new AbortController().signal }));
      expect(adopted).not.toHaveBeenCalled();
    } finally { await engine.dispose("session-close"); }
  });

  it("admits a correlated turn, keeps permissions live, persists its answer, and queues the next user input", async () => {
    const start = { type: "system", subtype: "task_started", task_id: "bg1", tool_use_id: "bash1", task_type: "local_bash", description: "sleep" } as unknown as ClaudeStreamMessage;
    const transport = new FakeTransport({ frames: [start, ...ownerFrames("initial")], contextUsage: { totalTokens: 1, maxTokens: 2 } });
    const raw = engineWith(transport);
    const rows: Parameters<ConstructorParameters<typeof ClaudeShadowTranscriptEngine>[1]["record"]>[1][number][] = [];
    const shadow = new ClaudeShadowTranscriptEngine(raw, { record: (_ref, items) => { rows.push(...items); }, list: async () => rows }, "session-ref-1", []);
    vi.spyOn(shadow, "capabilities", "get").mockReturnValue({ ...shadow.capabilities, supportsInteractiveApprovals: true });
    const h = createHarness({ steps: [], engine: shadow });
    raw.onNativeTurn = turn => h.session.acceptClaudeNativeTurn(shadow, turn);
    try {
      h.send({ type: "ui_ready" }); await h.waitFor(m => m.type === "host_ready");
      h.send({ type: "user_message", requestId: "initial", text: "launch" });
      await h.waitUntil(() => h.received.some(m => m.type === "agent_event" && m.event.type === "loop_end"));
      transport.push({ type: "system", subtype: "task_notification", task_id: "bg1", tool_use_id: "bash1", status: "completed" } as unknown as ClaudeStreamMessage);
      transport.push({ type: "system", subtype: "init", model: "default", permissionMode: "default", cwd: "/work", tools: [], mcp_servers: [], slash_commands: [], skills: [], capabilities: ["interrupt_receipt_v1"] } as unknown as ClaudeStreamMessage);
      transport.push(foreignAssistantFrame("native", "NATIVE ANSWER"));
      await h.waitUntil(() => h.received.filter(m => m.type === "turn_started").length === 2);
      const approval = h.broker.requestPermission({ toolName: "Bash", input: { command: "printf ok" }, metadata: bashTool.metadata, mode: "build" });
      const req = await h.waitFor((m): m is Extract<typeof m, { type: "permission_request" }> => m.type === "permission_request");
      h.send({ type: "permission_response", requestId: req.requestId, behavior: "allow" });
      await expect(approval).resolves.toMatchObject({ behavior: "allow" });
      for (const frame of ownerFrames("next")) transport.enqueue(frame);
      h.send({ type: "user_message", requestId: "next", text: "next question" });
      transport.push({ ...foreignResultFrame("native"), origin: { kind: "task-notification", producer: "session-task", runId: "run" } } as ClaudeStreamMessage);
      await h.waitUntil(() => h.received.filter(m => m.type === "agent_event" && m.event.type === "loop_end").length === 3);
      expect(transport.sent).toEqual(["launch", "next question"]);
      expect(JSON.stringify(h.received)).toContain("NATIVE ANSWER");
      const messages = rows.map(row => (row.data as { message: { role: string; content: unknown } }).message);
      expect(messages.filter(message => message.role === "user").map(message => message.content)).toEqual(["launch", "next question"]);
      expect(JSON.stringify(rows)).toContain("NATIVE ANSWER");
    } finally { await h.session.shutdown(); h.close(); }
  }, 10_000);
});

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
    expect(loopEnd).toEqual({ type: "loop_end", reason: "completed", turns: 2 });
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

describe("ClaudeEngine — slice S4: takePresentation reaches the turn's translator", () => {
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
      { catalog: fixtureCatalog(), model: "default", preset: findClaudePreset("ask")!, effortsByModel: new Map(), notices: [] },
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

// ── live bridge subagent_* events surface inside the turn ────

/**
 * The bridge frames of a delegating owner turn: an assistant tool_use for the
 * MCP agent tool, then the (deferred) tool_result, then the terminal result.
 * The tool_result is the frame the turn WAITS on while the bridged child
 * runs — the quiet stretch the bridge-event race must fill.
 */
function bridgeToolUseFrame(): ClaudeStreamMessage {
  return {
    type: "assistant",
    message: { id: "m-bridge", model: "x", content: [{ type: "tool_use", id: "toolu_bridge", name: "mcp__anycode__agent", input: {} }] },
  } as unknown as ClaudeStreamMessage;
}

describe("ClaudeEngine — bridge events surface mid-turn", () => {
  it("a bridge event pushed while the turn is parked on a quiet stream is yielded between stream events", async () => {
    const toolResult = userToolResultFrame("toolu_bridge");
    const result = resultFrame157("completed");
    const transport = new FakeTransport({
      frames: [bridgeToolUseFrame(), toolResult, result],
      contextUsage: { totalTokens: 1, maxTokens: 2 },
    });
    const gate = transport.holdBack([toolResult, result]);
    const engine = engineWith(transport);

    const events: AgentEvent[] = [];
    const turn = (async () => {
      for await (const event of engine.runTurn("delegate", { signal: new AbortController().signal })) events.push(event);
    })();
    // Let the turn start, pass the send barrier, consume the tool_use frame
    // and park on the quiet stream (the engine's cached read is unresolved).
    await new Promise((resolve) => setImmediate(resolve));

    engine.pushBridgeEvent({ type: "subagent_start", toolCallId: "toolu_bridge", agentType: "glm-lead", description: "d" });
    // Give the parked race's bridge arm a tick to resolve BEFORE the frames
    // arrive — the event must already be yielded (or winning its race) when
    // the tool_result lands, never deferred behind it.
    await new Promise((resolve) => setImmediate(resolve));

    gate.release();
    await turn;

    const startAt = events.findIndex((event) => event.type === "subagent_start");
    const resultAt = events.findIndex((event) => event.type === "tool_result");
    expect(startAt).toBeGreaterThanOrEqual(0);
    expect(resultAt).toBeGreaterThan(startAt);
    expect(events.filter((event) => event.type === "subagent_start")).toHaveLength(1);
    expect(events.filter((event) => event.type === "loop_end")).toEqual([{ type: "loop_end", reason: "completed", turns: 1 }]);
  });

  it("bridge events queued BEFORE the turn drain in the send barrier, before the user message is sent", async () => {
    const transport = new FakeTransport({
      frames: ownerFrames("plain"),
      contextUsage: { totalTokens: 1, maxTokens: 2 },
    });
    const engine = engineWith(transport);
    engine.pushBridgeEvent({ type: "subagent_start", toolCallId: "t1", agentType: "explore", description: "first" });
    engine.pushBridgeEvent({ type: "subagent_progress", toolCallId: "t1", turns: 1, toolCalls: 1, lastTool: "Read" });

    const events = await collect(engine.runTurn("plain", { signal: new AbortController().signal }));

    // Both events yielded FIRST, order preserved — and exactly one send: the
    // barrier's `continue` re-runs before the send, so the flush cannot
    // double-send the owner input.
    expect(events[0]).toEqual({ type: "turn_start", turn: 1 });
    expect(events[1]).toMatchObject({ type: "subagent_start", toolCallId: "t1" });
    expect(events[2]).toMatchObject({ type: "subagent_progress", toolCallId: "t1" });
    expect(transport.sent).toEqual(["plain"]);
    expect(events.filter((event) => event.type === "loop_end")).toEqual([{ type: "loop_end", reason: "completed", turns: 1 }]);
  });

  it("a queued notice and queued bridge events in the same barrier pass are ALL yielded (neither batch dropped)", async () => {
    const transport = new FakeTransport({
      frames: ownerFrames("plain"),
      contextUsage: { totalTokens: 1, maxTokens: 2 },
    });
    const engine = engineWith(transport);
    engine.queueNotice({ type: "engine_notice", level: "info", message: "checkpoint" });
    engine.pushBridgeEvent({ type: "subagent_start", toolCallId: "t1", agentType: "explore", description: "first" });

    const events = await collect(engine.runTurn("plain", { signal: new AbortController().signal }));

    expect(events.filter((event) => event.type === "engine_notice")).toHaveLength(1);
    expect(events.filter((event) => event.type === "subagent_start")).toHaveLength(1);
    expect(transport.sent).toEqual(["plain"]);
  });

  it("dispose wakes parked bridge waiters without hanging the turn loop", async () => {
    const toolResult = userToolResultFrame("toolu_bridge");
    const result = resultFrame157("completed");
    const transport = new FakeTransport({
      frames: [bridgeToolUseFrame(), toolResult, result],
      contextUsage: { totalTokens: 1, maxTokens: 2 },
    });
    // The held-back frames are NEVER released: after dispose the stream is
    // dead (close() resolves the parked read done), exactly like a killed
    // CLI process delivering no further frames.
    transport.holdBack([toolResult, result]);
    const engine = engineWith(transport);

    const events: AgentEvent[] = [];
    const turn = (async () => {
      for await (const event of engine.runTurn("delegate", { signal: new AbortController().signal })) events.push(event);
    })();
    await new Promise((resolve) => setImmediate(resolve)); // parked on the quiet stream

    engine.pushBridgeEvent({ type: "subagent_start", toolCallId: "toolu_bridge", agentType: "glm-lead", description: "d" });
    await new Promise((resolve) => setImmediate(resolve)); // the bridge arm delivers the event
    await engine.dispose("host-shutdown");
    await turn; // resolves — no parked-promise hang, no unhandled rejection

    // The delivered event survived; the turn terminalized exactly once over
    // the dead stream (engine-death error terminal — no Stop was requested).
    expect(events.filter((event) => event.type === "subagent_start")).toHaveLength(1);
    const loopEnds = events.filter((event) => event.type === "loop_end");
    expect(loopEnds).toHaveLength(1);
    expect(["error", "cancelled"]).toContain(loopEnds[0]!.reason);
  });

  it("a spurious wake (event already consumed) yields nothing extra and the turn continues", async () => {
    const transport = new FakeTransport({
      frames: [bridgeToolUseFrame(), userToolResultFrame("toolu_bridge"), resultFrame157("completed")],
      contextUsage: { totalTokens: 1, maxTokens: 2 },
    });
    const engine = engineWith(transport);

    // ONE event; the race arms `nextBridgeEvent()` every iteration and a
    // losing arm's resolved promise is re-armed by the next iteration (the
    // cached-slot discipline) — the event must be yielded EXACTLY once no
    // matter how the frame/bridge arms interleave.
    engine.pushBridgeEvent({ type: "subagent_start", toolCallId: "toolu_bridge", agentType: "glm-lead", description: "d" });
    const events = await collect(engine.runTurn("delegate", { signal: new AbortController().signal }));

    expect(events.filter((event) => event.type === "subagent_start")).toHaveLength(1);
    expect(events.filter((event) => event.type === "loop_end")).toEqual([{ type: "loop_end", reason: "completed", turns: 1 }]);
  });

  /**
   * cross-review P1: `takePresentation` is consumed exactly once
   * by the PAIRED top-level tool_result — but a turn that terminalizes
   * WITHOUT that frame (a dying transport, or a Stop whose interrupt lands
   * between the MCP response and the `user` tool_result frame) must not
   * leave its stamped snapshot behind for the process's lifetime. The engine
   * owns the turn boundary, so the sweep is turn-scoped: when a turn ends
   * with unconsumed snapshots, they are dropped (a LATER turn's tool_use can
   * never legitimately target them — MCP tool_use ids are per-call).
   */
  it("a turn that dies mid-tool-call DROPS the bridge's unconsumed presentation snapshot (no cross-turn leak)", async () => {
    // tool_use announced, then the held-back tool_result/result NEVER arrive —
    // the turn parks on the quiet stream exactly like a real delegation whose
    // child settled just as the transport died (the engine-death path).
    const toolResult = userToolResultFrame("toolu_bridge");
    const result = resultFrame157("completed");
    const transport = new FakeTransport({
      frames: [bridgeToolUseFrame(), toolResult, result],
      contextUsage: { totalTokens: 1, maxTokens: 2 },
    });
    transport.holdBack([toolResult, result]);

    const presentations = new Map<string, ToolResultPresentation>();
    const dropped: string[][] = [];
    const engine = new ClaudeEngine(
      transport,
      "session-ref-1",
      undefined,
      { catalog: fixtureCatalog(), model: "default", preset: findClaudePreset("ask")!, effortsByModel: new Map(), notices: [] },
      undefined,
      (id) => presentations.get(id),
      (ids) => dropped.push([...ids]),
    );

    const events: AgentEvent[] = [];
    let stamped = false;
    const turn = (async () => {
      for await (const event of engine.runTurn("delegate", { signal: new AbortController().signal })) {
        events.push(event);
        if (event.type === "tool_call" && !stamped) {
          // The bridge's callTool handler stamped its snapshot for this
          // tool_use id the moment the child settled — BEFORE the paired
          // tool_result frame arrived. Then the CLI dies.
          stamped = true;
          presentations.set("toolu_bridge", { subagent: "opaque" } as never);
          void engine.dispose("host-shutdown");
        }
      }
    })();
    await turn;

    // The turn terminalized WITHOUT the tool_result frame (engine death).
    const loopEnds = events.filter((event) => event.type === "loop_end");
    expect(loopEnds).toHaveLength(1);
    expect(["error", "cancelled"]).toContain(loopEnds[0]!.reason);
    expect(stamped).toBe(true);
    // The turn-scoped sweep fired exactly once, naming the dead call's
    // tool_use id — the host's map entry cannot outlive the turn.
    expect(dropped).toEqual([["toolu_bridge"]]);
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

    // the fixture carries user (tool-result) frames, so a mid-turn
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
    // the FINAL reading is the LAST context_usage, strictly after
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
      expect(events.find((event) => event.type === "loop_end")).toEqual({ type: "loop_end", reason: "completed", turns: 2 });
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

  it("a refused set_model is a clean no-op — the prior model survives (synthetic w0-16 behaviour)", async () => {
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
    // The trap: `fable` is SENT, `claude-fable-5-1` is REPORTED.
    // Asserting the reported id equals the requested one fires a spurious
    // mismatch on every switch using an alias.
    const catalog = fixtureCatalog();
    const transport = new FakeTransport({
      frames: streamFrames("w0-02-control-writeprobe.jsonl"),
      contextUsage: { totalTokens: 10, maxTokens: 100, model: "claude-fable-5-1" },
    });
    const engine = engineWith(transport, { catalog });
    await expect(engine.selectModel("fable")).resolves.toEqual({ ok: true, model: "fable" });
    await collect(engine.runTurn("hi", { signal: new AbortController().signal }));

    const reported = engine.resolvedModel();
    expect(reported).toBe("claude-fable-5-1");
    expect(reported).not.toBe("fable"); // the naive comparison this guards against
    expect(catalog.readBackMatches("fable", reported!)).toBe(true);
  });

  it("selectEffort is gated on the model's own supportedEffortLevels", async () => {
    const transport = new FakeTransport();
    const engine = engineWith(transport, { model: "haiku" }); // haiku carries no effort levels live
    const rejected = await engine.selectEffort("high");
    expect(rejected.ok).toBe(false);
    expect(transport.controls).toEqual([]);

    const opus = engineWith(transport, { model: "opus" });
    await expect(opus.selectEffort("high")).resolves.toEqual({ ok: true, effort: "high" });
    expect(transport.controls).toEqual([{ subtype: "apply_flag_settings", request: { settings: { effortLevel: "high" } } }]);
    expect(opus.snapshot().effort).toBe("high");
  });

  it("applies xhigh to an Opus session using the CLI settings envelope", async () => {
    const transport = new FakeTransport();
    const catalog = ClaudeModelCatalog.fromInitialize([{ value: "opus", displayName: "Opus", supportsEffort: true, supportedEffortLevels: ["high", "xhigh"] }]);
    const engine = engineWith(transport, { model: "opus", catalog });
    await expect(engine.selectEffort("xhigh")).resolves.toEqual({ ok: true, effort: "xhigh" });
    expect(transport.controls).toEqual([{ subtype: "apply_flag_settings", request: { settings: { effortLevel: "xhigh" } } }]);
    expect(engine.snapshot().effort).toBe("xhigh");
  });

  it("does not publish an effort whose restore ACK failed, and retains the choice for retry", async () => {
    const refuse: Record<string,string> = {};
    const transport = new FakeTransport({refuse});
    const engine = engineWith(transport,{model:"opus"});
    await engine.selectEffort("high"); await engine.selectModel("sonnet");
    refuse.apply_flag_settings = "fixture refusal";
    expect(await engine.selectModel("opus")).toMatchObject({ok:true});
    expect(engine.snapshot().effort).toBeUndefined();
    delete refuse.apply_flag_settings;
    await engine.selectModel("sonnet"); await engine.selectModel("opus");
    expect(engine.snapshot().effort).toBe("high");
  });

  it("re-resolves the effort for the switched-to model and restores the remembered value when switching back (shape)", async () => {
    const transport = new FakeTransport();
    const engine = engineWith(transport, { model: "opus" });
    await expect(engine.selectEffort("high")).resolves.toEqual({ ok: true, effort: "high" });

    // sonnet has no remembered effort yet, so the switch clears the local
    // record rather than carrying opus's "high" over onto an unrelated model.
    await expect(engine.selectModel("sonnet")).resolves.toEqual({ ok: true, model: "sonnet" });
    expect(engine.snapshot().effort).toBeUndefined();

    await expect(engine.selectModel("opus")).resolves.toEqual({ ok: true, model: "opus" });
    expect(engine.snapshot().effort).toBe("high");
    // Restoring re-asserts it live too, not just in the local record.
    expect(transport.controls.at(-1)).toEqual({ subtype: "apply_flag_settings", request: { settings: { effortLevel: "high" } } });
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
      }
    })();
    while (transport.sent.length === 0) await new Promise(resolve => setTimeout(resolve, 0));
    controller.abort();
    transport.push({ ...(terminal as object), terminal_reason: "aborted_streaming" } as never);
    await turn;

    expect(transport.interrupts).toBe(1);
    // healthy-cancellation control: a cancel that SETTLES is not a
    // death — no transport close, no engine_dead signal, semantics unchanged.
    expect(transport.closed).toBe(0);
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.find((event) => event.type === "loop_end")).toEqual({ type: "loop_end", reason: "cancelled", turns: 2 });
  });

  it("a Stop that cannot settle in time closes the session and terminalizes as cancelled with a restart-required posture", async () => {
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
    // the intentional-cancel settle timeout ALSO closes the engine and
    // signals engine death — additively, WITHOUT turning the cancelled terminal
    // into an error terminal (the loop status below is still "cancelled").
    const errorEvent = events.find((event) => event.type === "error") as
      | { type: "error"; error: Error; safe?: { code: string; message: string } }
      | undefined;
    expect(errorEvent).toBeDefined();
    expect(errorEvent!.safe?.code).toBe("engine_dead");
    expect(errorEvent!.safe?.message).toContain("did not settle the interrupted turn");
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
    const nextError = next[0] as { type: "error"; error: Error; safe?: { code: string; message: string } };
    expect(nextError.error.message).toContain("session was closed");
    expect(nextError.error.message).toContain("Start a new session");
    expect(nextError.safe?.code).toBe("engine_dead");
    expect(nextError.safe?.message).toContain("did not settle the interrupted turn");
    expect(transport.sent).toEqual(["long job"]);
  });

  it("a transport that dies without an abort is still an error turn", async () => {
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

  it("resumes after idle death and delivers the next input exactly once", async () => {
    const dead = new FakeTransport();
    const resumed = new FakeTransport({ frames: ownerFrames("resumed") });
    const factory = vi.fn(async (_spawn: unknown) => ({ client: resumed, approvals: undefined!, close: () => resumed.close() }));
    const engine = new ClaudeEngine(dead, "session-ref-1", undefined, undefined, undefined, undefined, undefined, false, factory);
    engine.nativeMaterialized = true;
    await dead.close();
    await new Promise(resolve => setTimeout(resolve, 0));
    const events = await collect(engine.runTurn("keep this message", { signal: new AbortController().signal }));
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory.mock.calls[0]?.[0]).toMatchObject({ resume: "session-ref-1" });
    expect(dead.sent).toEqual([]);
    expect(resumed.sent).toEqual(["keep this message"]);
    expect(events.some(event => event.type === "error")).toBe(false);
    await engine.dispose("session-close");
  });

  it("reports idle exit details once if resume fails and preserves unsent input", async () => {
    const dead = new FakeTransport({ rejectStreamOnce: new ClaudeClientError("claude exited unexpectedly (code=1, signal=SIGTERM)") });
    const factory = vi.fn(async () => { throw new Error("network private spawn details"); });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const engine = new ClaudeEngine(dead, "session-ref-1", undefined, undefined, undefined, undefined, undefined, false, factory);
    engine.nativeMaterialized = true;
    dead.releaseStreamReject();
    await new Promise(resolve => setTimeout(resolve, 0));
    const notSent = vi.fn();
    const first = await collect(engine.runTurn("recover me", { signal: new AbortController().signal, onInputNotSent: notSent }));
    expect(factory).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("[claude] automatic resume failed: network");
    log.mockRestore();
    expect(notSent).toHaveBeenCalledOnce();
    const error = first.find(event => event.type === "error");
    expect(error).toMatchObject({ safe: { code: "engine_dead", message: expect.stringContaining("while idle") } });
    if (error?.type === "error") {
      expect(error.safe?.message).toContain("code=1, signal=SIGTERM");
      expect(error.safe?.message).toContain("Close and reopen");
      expect(error.safe?.message).not.toContain("private spawn details");
    }
    const next = await collect(engine.runTurn("still recoverable", { signal: new AbortController().signal, onInputNotSent: notSent }));
    expect(next.some(event => event.type === "error")).toBe(false);
    expect(notSent).toHaveBeenCalledTimes(2);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(dead.sent).toEqual([]);
    await engine.dispose("session-close");
  });

  it("does not resume or resend a prompt after a mid-turn death even with a factory", async () => {
    const dead = new FakeTransport({ rejectStreamOnce: new ClaudeClientError("claude exited unexpectedly (code=1, signal=null)") });
    const factory = vi.fn(async () => { throw new Error("must not respawn"); });
    const engine = new ClaudeEngine(dead, "session-ref-1", undefined, undefined, undefined, undefined, undefined, false, factory);
    const events: AgentEvent[] = [];
    for await (const event of engine.runTurn("side effects", { signal: new AbortController().signal })) {
      events.push(event);
      if (event.type === "turn_start") setTimeout(() => dead.releaseStreamReject(), 0);
    }
    await collect(engine.runTurn("new input", { signal: new AbortController().signal }));
    expect(factory).not.toHaveBeenCalled();
    expect(dead.sent).toEqual(["side effects"]);
    expect(events.some(event => event.type === "error")).toBe(true);
    await engine.dispose("session-close");
  });

  it("classifies a rejected read while waiting for a foreign turn as restartable", async () => {
    const transport = new FakeTransport({ rejectStreamOnce: new Error("read failed") });
    const engine = engineWith(transport);
    transport.push(foreignAssistantFrame("foreign", "background"));
    await new Promise(resolve => setTimeout(resolve, 0));
    const events: AgentEvent[] = [];
    for await (const event of engine.runTurn("unsent", { signal: new AbortController().signal })) {
      events.push(event);
      if (event.type === "turn_start") setTimeout(() => transport.releaseStreamReject(), 0);
    }
    expect(transport.sent).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({ type: "error", safe: expect.objectContaining({ message: expect.stringContaining("while idle") }) }));
    await engine.dispose("session-close");
  });

  it("can explicitly restart after a foreign turn loses its transport without replaying input", async () => {
    const dead = new FakeTransport();
    const resumed = new FakeTransport();
    const factory = vi.fn(async () => ({ client: resumed, approvals: undefined!, close: () => resumed.close() }));
    const engine = new ClaudeEngine(dead, "session-ref-1", undefined, undefined, undefined, undefined, undefined, false, factory);
    dead.push(foreignAssistantFrame("foreign", "background"));
    await new Promise(resolve => setTimeout(resolve, 0));
    await dead.close();
    await new Promise(resolve => setTimeout(resolve, 0));
    const events = await collect(engine.runTurn("unsent", { signal: new AbortController().signal }));
    expect(events).toContainEqual(expect.objectContaining({ type: "error", safe: expect.objectContaining({ message: expect.stringContaining("while idle") }) }));
    expect(factory).not.toHaveBeenCalled();
    expect(await engine.restartStopped()).toBe(true);
    expect(resumed.sent).toEqual([]);
    await engine.dispose("session-close");
  });

  it("allows an explicit restart after failed idle recovery without resending input", async () => {
    const dead = new FakeTransport();
    const resumed = new FakeTransport({ frames: ownerFrames("explicit") });
    const factory = vi.fn(async (_spawn: unknown) => ({ client: resumed, approvals: undefined!, close: () => resumed.close() }))
      .mockRejectedValueOnce(new Error("resume failed"));
    const engine = new ClaudeEngine(dead, "session-ref-1", undefined, undefined, undefined, undefined, undefined, false, factory);
    engine.nativeMaterialized = true;
    await dead.close();
    await new Promise(resolve => setTimeout(resolve, 0));
    await collect(engine.runTurn("unsent", { signal: new AbortController().signal }));
    expect(await engine.restartStopped()).toBe(true);
    expect(resumed.sent).toEqual([]);
    await collect(engine.runTurn("restored", { signal: new AbortController().signal }));
    expect(resumed.sent).toEqual(["restored"]);
    expect(factory).toHaveBeenCalledTimes(2);
    await engine.dispose("session-close");
  });

  it("absorbs background-task output between turns without restarting or misattributing it", async () => {
    const transport = new FakeTransport({ frames: ownerFrames("next") });
    const engine = engineWith(transport);
    transport.push(foreignAssistantFrame("background", "BACKGROUND TASK OUTPUT"));
    transport.push(foreignResultFrame("background done"));
    await new Promise(resolve => setTimeout(resolve, 0));
    const events = await collect(engine.runTurn("next", { signal: new AbortController().signal }));
    expect(transport.sent).toEqual(["next"]);
    expect(events.some(event => event.type === "text_delta" && event.text.includes("BACKGROUND"))).toBe(false);
    expect(events.some(event => event.type === "error")).toBe(false);
    await engine.dispose("session-close");
  });

  // ── trusted engine-death descriptor (safe.code "engine_dead") ─────

  it("a mid-turn transport death carries safe.code engine_dead and the fixed reason, and the latch survives into the next turn", async () => {
    const transport = new FakeTransport({ contextUsage: { totalTokens: 1, maxTokens: 2 } });
    const engine = engineWith(transport);
    const events: AgentEvent[] = [];
    for await (const event of engine.runTurn("hi", { signal: new AbortController().signal })) {
      events.push(event);
      if (event.type === "turn_start") queueMicrotask(() => transport.close());
    }
    const error = events.find((event) => event.type === "error") as
      | { type: "error"; error: Error; safe?: { code: string; message: string } }
      | undefined;
    expect(error).toBeDefined();
    expect(error!.safe).toEqual({ code: "engine_dead", message: "Claude exited during a turn" });
    expect(events.filter((event) => event.type === "loop_end")).toEqual([{ type: "loop_end", reason: "error", turns: 1 }]);

    // The latched death: the NEXT turn's error also carries the descriptor.
    const next = await collect(engine.runTurn("again", { signal: new AbortController().signal }));
    expect(types(next)).toEqual(["error", "turn_end", "loop_end"]);
    const nextError = next[0] as { type: "error"; error: Error; safe?: { code: string; message: string } };
    expect(nextError.safe?.code).toBe("engine_dead");
    expect(nextError.safe?.message).toContain("Claude exited during a turn");
    expect(next.filter((event) => event.type === "loop_end")).toEqual([{ type: "loop_end", reason: "error", turns: 2 }]);
  });

  it("hostile engine text never reaches safe.message — only a trusted descriptor does", async () => {
    // Drive one turn whose parked reader rejects with `error` (the real death path).
    const rejectedTurn = async (error: Error): Promise<AgentEvent[]> => {
      const transport = new FakeTransport({ contextUsage: { totalTokens: 1, maxTokens: 2 }, rejectStreamOnce: error });
      const events: AgentEvent[] = [];
      for await (const event of engineWith(transport).runTurn("hi", { signal: new AbortController().signal })) {
        events.push(event);
        if (event.type === "turn_start") queueMicrotask(() => transport.releaseStreamReject());
      }
      return events;
    };
    const safeOf = (events: AgentEvent[]) =>
      (events.find((event) => event.type === "error") as { safe?: { code: string; message: string } } | undefined)?.safe;
    const rawOf = (events: AgentEvent[]) =>
      (events.find((event) => event.type === "error") as { error?: Error } | undefined)?.error;

    // (a) Plain rejection text — only the classified constant is disclosed.
    const poison = await rejectedTurn(new Error("Bearer secret-poison"));
    expect(poison.filter((event) => event.type === "error")).toHaveLength(1);
    expect(poison.filter((event) => event.type === "loop_end")).toEqual([{ type: "loop_end", reason: "error", turns: 1 }]);
    expect(safeOf(poison)?.code).toBe("engine_dead");
    expect(safeOf(poison)?.message).toBe("The agent request failed. Retry or recheck the selected connection in Settings.");
    expect(safeOf(poison)?.message).not.toContain("secret-poison");
    expect(rawOf(poison)?.message).toBe("Bearer secret-poison"); // raw stays private, carried as `error`

    // (b) A ClaudeClientError is NOT a trust boundary — provider text is redacted.
    const wrapped = await rejectedTurn(new ClaudeClientError("claude control request failed: Bearer secret-poison"));
    expect(safeOf(wrapped)?.code).toBe("engine_dead");
    expect(safeOf(wrapped)?.message).not.toContain("secret-poison");

    // (c) Unknown frame text.
    const unknownFrame = await rejectedTurn(new ClaudeClientError('unknown frame type "Bearer secret-poison"'));
    expect(safeOf(unknownFrame)?.code).toBe("engine_dead");
    expect(safeOf(unknownFrame)?.message).not.toContain("secret-poison");

    // (d) Spawn-error text.
    const spawn = await rejectedTurn(new Error("spawn claude EACCES"));
    expect(safeOf(spawn)?.code).toBe("engine_dead");
    expect(safeOf(spawn)?.message).not.toContain("EACCES");

    // (e) The ONE trusted ClaudeClientError exit report reconstructs exactly, for
    //     both numeric and null code/signal.
    const exitNumeric = await rejectedTurn(new ClaudeClientError("claude exited unexpectedly (code=1, signal=SIGTERM)"));
    expect(safeOf(exitNumeric)).toEqual({ code: "engine_dead", message: "claude exited unexpectedly (code=1, signal=SIGTERM)" });
    const exitNull = await rejectedTurn(new ClaudeClientError("claude exited unexpectedly (code=null, signal=null)"));
    expect(safeOf(exitNull)).toEqual({ code: "engine_dead", message: "claude exited unexpectedly (code=null, signal=null)" });

    // (f) A suffix / malformed format is NOT trusted; nor is the same text on a
    //     plain Error — the class is the trust gate, not the string shape.
    const suffixed = await rejectedTurn(new ClaudeClientError("claude exited unexpectedly (code=1, signal=SIGTERM) trailing"));
    expect(safeOf(suffixed)?.code).toBe("engine_dead");
    expect(safeOf(suffixed)?.message).not.toContain("SIGTERM");
    const malformed = await rejectedTurn(new ClaudeClientError("claude exited unexpectedly (code=abc, signal=sigterm)"));
    expect(safeOf(malformed)?.message).not.toContain("sigterm");
    const plainExit = await rejectedTurn(new Error("claude exited unexpectedly (code=1, signal=SIGTERM)"));
    expect(safeOf(plainExit)?.message).not.toContain("SIGTERM");
  });

  it("a Stop that cannot settle a FOREIGN turn in time closes the session, signals engine death, and stays cancelled", async () => {
    const t1 = streamFrames("w0-02-control-writeprobe.jsonl");
    const transport = new FakeTransport({ frames: t1, contextUsage: { totalTokens: 1, maxTokens: 2 } });
    const engine = engineWith(transport, { timeouts: { postInterruptSettleMs: 30 } });
    await collect(engine.runTurn("first prompt", { signal: new AbortController().signal }));

    transport.push(foreignAssistantFrame("m-fd", "FOREIGN DYING"));
    const controller = new AbortController();
    const events: AgentEvent[] = [];
    const turn2 = (async () => {
      for await (const event of engine.runTurn("stop me", { signal: controller.signal })) {
        events.push(event);
        if (event.type === "engine_notice" && String((event as { message?: string }).message).includes("finishing a turn")) {
          // Stop the foreign wait and NEVER settle it: the settle deadline fires.
          controller.abort();
        }
      }
    })();
    await turn2;

    expect(transport.interrupts).toBe(1);
    expect(transport.closed).toBe(1);
    expect(transport.sent).toEqual(["first prompt"]); // the owner input was NEVER sent
    const errorEvent = events.find((event) => event.type === "error") as
      | { type: "error"; error: Error; safe?: { code: string; message: string } }
      | undefined;
    expect(errorEvent).toBeDefined();
    expect(errorEvent!.safe?.code).toBe("engine_dead");
    expect(errorEvent!.safe?.message).toContain("did not settle the interrupted turn");
    expect(events.filter((event) => event.type === "loop_end")).toEqual([{ type: "loop_end", reason: "cancelled", turns: 2 }]);
    const notice = events.find(
      (event) => event.type === "engine_notice" && String((event as { message?: string }).message).includes("running command"),
    );
    expect(notice).toBeDefined();
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

describe("Claude session — messages racing the final context read", () => {
  it("refreshes restart availability after successful restart and reconnect", async () => {
    const dead = new FakeTransport();
    const resumed = new FakeTransport();
    const engine = new ClaudeEngine(dead, "session-ref-1", undefined, undefined, undefined, undefined, undefined, false,
      vi.fn(async () => ({ client: resumed, approvals: undefined!, close: () => resumed.close() })).mockRejectedValueOnce(new Error("resume failed")));
    engine.nativeMaterialized = true;
    const h = createHarness({ steps: [], engine });
    try {
      h.send({ type: "ui_ready" }); await h.waitFor(m => m.type === "host_ready");
      await dead.close(); await new Promise(resolve => setTimeout(resolve, 0));
      h.send({ type: "user_message", requestId: "unsent", text: "draft" });
      await h.waitUntil(() => h.received.some(m => m.type === "agent_event" && m.event.type === "loop_end"));
      await h.flush();
      expect(h.received.filter(m => m.type === "claude_restart_state").at(-1)).toMatchObject({ available: true });
      h.send({ type: "claude_restart_request" });
      await h.waitUntil(() => h.received.some(m => m.type === "agent_event" && m.turnId === "claude-restart"));
      h.send({ type: "ui_ready" }); await h.flush();
      const renderer = createDesktopStore({ schedule: fn => fn() });
      for (const m of h.received) renderer.getState().applyHostMessage(m);
      expect(h.received.filter(m => m.type === "claude_restart_state").at(-1)).toMatchObject({ available: false });
      expect(renderer.getState().claudeRestartAvailable).toBe(false);
    } finally { await h.session.shutdown(); h.close(); }
  });

  it("restores an explicitly unsent input once, including after renderer reload and database reopen", async () => {
    const engine = engineWith(new FakeTransport());
    vi.spyOn(engine, "runTurn").mockImplementation(async function* (_input, options) {
      options.onInputNotSent?.();
      yield { type: "loop_end", reason: "cancelled", turns: 1 };
    });
    const root = mkdtempSync(join(tmpdir(), "unsent-recovery-"));
    const path = join(root, "history.sqlite");
    let db = new SqlitePersistenceAdapter(path);
    await db.createSession({ id: "test-session", workspace: "/workspace", model: "scripted-model", mode: "build" });
    const history = new RuntimeSessionHistory(db, "test-session");
    const h = createHarness({ steps: [], engine, runtimeHistory: history });
    const renderer = createDesktopStore({ schedule: fn => fn() });
    const saved = new Map<string, string>();
    vi.stubGlobal("sessionStorage", { setItem: (k: string, v: string) => saved.set(k, v), getItem: (k: string) => saved.get(k) ?? null });
    try {
      h.send({ type: "ui_ready" }); await h.waitFor(m => m.type === "host_ready"); await h.flush();
      for (const m of h.received) renderer.getState().applyHostMessage(m);
      renderer.getState().recordSentMessage("draft", [], "request");
      renderer.getState().appendUserText("request", "draft");
      const offset = h.received.length;
      h.send({ type: "user_message", requestId: "request", text: "draft" });
      await h.waitUntil(() => h.received.some(m => m.type === "agent_event" && m.event.type === "loop_end"));
      await h.flush();
      for (const m of h.received.slice(offset)) renderer.getState().applyHostMessage(m);
      expect(renderer.getState().promptQueue).toMatchObject([{ id: "request", text: "draft", requiresRestore: true }]);
      const [pending] = history.recoveries();
      expect(history.recoveries()).toHaveLength(1);
      expect(pending).toMatchObject({ text: "draft", state: "pending" });
      expect(renderer.getState().promptQueue[0]?.runtimeRecoveryTurnId).toBe(pending!.turnId);
      expect(h.received.filter(m => m.type === "runtime_input_recovery")).toHaveLength(1);
      expect(saveRecovery("tab", renderer.getState())).toBe(true);
      const reloaded = createDesktopStore();
      reloaded.setState(loadRecovery("tab")!);
      expect(reloaded.getState().promptQueue).toEqual(renderer.getState().promptQueue);
      await h.session.shutdown(); h.close();
      // A fresh app has no renderer storage or pending request map.
      saved.clear();
      await db.close();
      db = new SqlitePersistenceAdapter(path);
      const reopened = createHarness({ steps: [], runtimeHistory: new RuntimeSessionHistory(db, "test-session") });
      try {
        reopened.send({ type: "ui_ready" });
        await reopened.waitFor(m => m.type === "host_ready"); await reopened.flush();
        const fresh = createDesktopStore({ schedule: fn => fn() });
        for (const m of reopened.received) fresh.getState().applyHostMessage(m);
        expect(reopened.received.filter(m => m.type === "runtime_input_recovery")).toHaveLength(1);
        expect(fresh.getState().promptQueue).toMatchObject([{ text: "draft", requiresRestore: true, runtimeRecoveryTurnId: pending!.turnId }]);
        // Reconnection can reannounce the durable row without duplicating it.
        reopened.send({ type: "ui_ready" }); await reopened.flush();
        for (const m of reopened.received) fresh.getState().applyHostMessage(m);
        expect(fresh.getState().promptQueue).toHaveLength(1);
      } finally { await reopened.session.shutdown(); reopened.close(); }
    } finally { vi.unstubAllGlobals(); await h.session.shutdown(); h.close(); await db.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it.each(["transport death", "cancel after write", "cancel before write", "input not sent"].flatMap(mode => [[mode, false], [mode, true]] as const))("resolves pending echo on %s with runtime history %s", async (mode, runtime) => {
    const transport = new FakeTransport({ rejectStreamOnce: new Error("transport gone") });
    const engine = engineWith(transport, { timeouts: { postInterruptSettleMs: 30 } });
    if (mode === "cancel before write") {
      const runTurn = engine.runTurn.bind(engine);
      vi.spyOn(engine, "runTurn").mockImplementation((input, options) => {
        const controller = new AbortController();
        controller.abort();
        return runTurn(input, { ...options, signal: controller.signal });
      });
    }
    const db = new SqlitePersistenceAdapter(":memory:");
    await db.createSession({ id: "test-session", workspace: "/workspace", model: "scripted-model", mode: "build" });
    const history = runtime ? new RuntimeSessionHistory(db, "test-session") : undefined;
    const resetInput = vi.spyOn(db, "resetRuntimeInput");
    const h = createHarness({ steps: [], engine, runtimeHistory: history });
    const store = createDesktopStore({ schedule: fn => fn() });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(m => m.type === "host_ready");
      for (const message of h.received) store.getState().applyHostMessage(message);
      store.getState().recordSentMessage("hello", [], "pending");
      store.getState().appendUserText("pending", "hello");
      const offset = h.received.length;
      if (mode === "input not sent") await engine.dispose("session-close");
      h.send({ type: "user_message", requestId: "pending", text: "hello" });
      if (mode !== "input not sent" && mode !== "cancel before write") {
        await h.waitUntil(() => transport.sent.length === 1);
        if (mode === "cancel after write") h.send({ type: "cancel_turn" });
        transport.releaseStreamReject();
      }
      await h.waitUntil(() => h.received.some(m => m.type === "agent_event" && m.event.type === "loop_end"));
      await h.flush();
      for (const message of h.received.slice(offset)) store.getState().applyHostMessage(message);
      if (mode === "cancel before write") {
        expect(h.received).toContainEqual(expect.objectContaining({ type: "agent_event", event: { type: "loop_end", reason: "cancelled", turns: 1 } }));
        expect(h.received.some(m => m.type === "agent_event" && m.event.type === "error")).toBe(false);
        expect(transport.interrupts).toBe(0);
      }
      expect(store.getState().pendingSteers).toEqual([]);
      expect(store.getState().orchestrationDeliveries).toEqual([]);
      if (mode === "input not sent" || mode === "cancel before write") {
        expect(transport.sent).toEqual([]);
        expect(store.getState().promptQueue).toMatchObject([{ id: "pending", text: "hello" }]);
        expect(store.getState().queuePaused).toBe(true);
        expect(store.getState().transcript.some(block => block.id === "pending")).toBe(false);
      } else {
        expect(transport.sent).toEqual(["hello"]);
        expect(store.getState().transcript.filter(block => block.id === "pending")).toHaveLength(1);
        expect(store.getState().promptQueue).toEqual([]);
        expect(history?.recoveries().some(input => input.state === "pending")).not.toBe(true);
        expect(resetInput.mock.calls.some(call => call[3] === true)).toBe(false);
      }
    } finally { h.close(); await engine.dispose("session-close"); await db.close(); }
  });

  it("forwards the native acceptance id to runtime history", async () => {
    const engine = engineWith(new FakeTransport());
    const db = new SqlitePersistenceAdapter(":memory:");
    await db.createSession({ id: "test-session", workspace: "/workspace", model: "scripted-model", mode: "build" });
    const history = new RuntimeSessionHistory(db, "test-session");
    const accepted = vi.fn();
    vi.spyOn(history, "prepare").mockReturnValue({ text: "draft", hooks: { onInputAccepted: accepted } });
    vi.spyOn(engine, "runTurn").mockImplementation(async function* (_input, options) {
      options.onInputAccepted?.("native-accepted");
      yield { type: "loop_end", reason: "cancelled", turns: 0 };
    });
    const h = createHarness({ steps: [], engine, runtimeHistory: history });
    try {
      h.send({ type: "ui_ready" }); await h.waitFor(m => m.type === "host_ready");
      h.send({ type: "user_message", requestId: "accepted", text: "draft" });
      await h.waitUntil(() => accepted.mock.calls.length > 0);
      expect(accepted).toHaveBeenCalledWith("native-accepted");
    } finally { h.close(); await engine.dispose("session-close"); await db.close(); }
  });

  it.each([false, true])("cancels before the engine call with runtime history %s", async runtime => {
    const engine = engineWith(new FakeTransport());
    const db = new SqlitePersistenceAdapter(":memory:");
    await db.createSession({ id: "test-session", workspace: "/workspace", model: "scripted-model", mode: "build" });
    const history = runtime ? new RuntimeSessionHistory(db, "test-session") : undefined;
    const h = createHarness({ steps: [], engine, runtimeHistory: history });
    const store = createDesktopStore({ schedule: fn => fn() });
    try {
      h.send({ type: "ui_ready" }); await h.waitFor(m => m.type === "host_ready");
      for (const message of h.received) store.getState().applyHostMessage(message);
      Object.assign(h.session, { settingsBarrierActive: true, settingsBarrier: new Promise<void>(() => {}) });
      store.getState().recordSentMessage("draft", [], "cancelled");
      store.getState().appendUserText("cancelled", "draft");
      const offset = h.received.length;
      h.send({ type: "user_message", requestId: "cancelled", text: "draft" });
      h.send({ type: "cancel_turn" });
      await h.waitUntil(() => h.received.some(m => m.type === "agent_event" && m.event.type === "loop_end"));
      await h.flush();
      for (const message of h.received.slice(offset)) store.getState().applyHostMessage(message);
      expect(store.getState().transcript.some(block => block.id === "cancelled")).toBe(false);
      expect(store.getState().promptQueue).toMatchObject([{ text: "draft", requiresRestore: true }]);
      expect(h.received).toContainEqual({ type: "turn_rejected", requestId: "cancelled", reason: "input_not_sent" });
    } finally { h.close(); await engine.dispose("session-close"); await db.close(); }
  });

  it("keeps a late prompt pending and delivers it once after the previous turn settles", async () => {
    const usage = deferredUsage();
    const transport = new FakeTransport({
      frames: streamFrames("w0-02-control-writeprobe.jsonl").map(frame => ({ ...frame, session_id: "session-ref-1" })),
      contextUsageSequence: () => usage.promise,
    });
    const engine = engineWith(transport);
    const h = createHarness({ steps: [], engine });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(m => m.type === "host_ready");
      h.send({ type: "user_message", requestId: "first", text: "first prompt" });
      await h.waitUntil(() => h.received.some(m => m.type === "agent_event" && m.event.type === "loop_end"));
      expect(transport.sent).toEqual(["first prompt"]);
      const store = createDesktopStore({ schedule: fn => fn() });
      for (const message of h.received) store.getState().applyHostMessage(message);
      store.getState().recordSentMessage("follow up", [], "late");
      store.getState().appendUserText("late", "follow up");
      expect(store.getState().pendingSteers.map(entry => entry.requestId)).toEqual(["late"]);
      expect(store.getState().transcript.filter(block => block.id === "late")).toEqual([]);
      h.send({ type: "user_message", requestId: "late", text: "follow up" });
      h.send({ type: "user_message", requestId: "late", text: "follow up" });
      // A subsequent inbound frame is a deterministic barrier for admission.
      h.send({ type: "ui_ready" });
      await h.waitUntil(() => h.received.filter(m => m.type === "host_ready").length === 2);
      expect(h.received.filter(m => m.type === "turn_rejected" && m.requestId === "late")).toEqual([]);
      expect(h.received.filter(m => m.type === "turn_started" && m.requestId === "late")).toEqual([]);
      expect(transport.sent).toEqual(["first prompt"]);
      const offset = h.received.length;
      usage.resolve({ totalTokens: 1, maxTokens: 2 });
      await h.waitUntil(() => h.received.some(m => m.type === "turn_started" && m.requestId === "late"));
      await h.waitUntil(() => transport.sent.length === 2);
      await h.flush();
      for (const message of h.received.slice(offset)) store.getState().applyHostMessage(message);
      expect(store.getState().pendingSteers.map(entry => entry.requestId)).toEqual(["late"]);
      expect(store.getState().transcript.filter(block => block.id === "late")).toEqual([]);
      const acceptedOffset = h.received.length;
      const endedBefore = h.received.filter(m => m.type === "agent_event" && m.event.type === "loop_end").length;
      // Replay only the final text response: ordinary subsequent turns have
      // neither init nor an earlier full assistant tool-call frame.
      const replay = streamFrames("w0-02-control-writeprobe.jsonl");
      const textStart = replay.map(frame => frame.type === "stream_event" && frame.event.type === "message_start").lastIndexOf(true);
      for (const frame of replay.slice(textStart)) transport.push({ ...frame, session_id: "session-ref-1" });
      await h.waitUntil(() => h.received.filter(m => m.type === "agent_event" && m.event.type === "loop_end").length > endedBefore);
      expect(h.received.filter(m => m.type === "user_message_accepted" && m.requestId === "late")).toHaveLength(1);
      const replies = h.received.slice(acceptedOffset);
      const acceptance = replies.findIndex(message => message.type === "user_message_accepted");
      const firstDelta = replies.findIndex(message => message.type === "agent_event" && message.event.type === "text_delta");
      expect(firstDelta).toBeGreaterThan(acceptance);
      for (const message of replies) store.getState().applyHostMessage(message);
      expect(store.getState().pendingSteers).toEqual([]);
      expect(store.getState().transcript.filter(block => block.id === "late")).toHaveLength(1);
      const transcript = store.getState().transcript;
      const echoIndex = transcript.findIndex(block => block.id === "late");
      expect(transcript.slice(echoIndex + 1).some(block => block.kind === "assistant_text")).toBe(true);
      expect(store.getState().orchestrationDeliveries).toEqual([]);
      expect(transport.sent).toEqual(["first prompt", "follow up"]);
      expect(h.received.filter(m => m.type === "turn_started" && m.requestId === "late")).toHaveLength(1);
    } finally {
      usage.resolve({});
      h.close();
      await engine.dispose("session-close");
    }
  });
});

describe("ClaudeEngine — presentation surface", () => {
  it("projects the synthetic catalog and the frozen preset table, and reports cost without ever logging it", async () => {
    const transport = new FakeTransport({
      frames: streamFrames("w0-02-control-writeprobe.jsonl"),
      contextUsage: { totalTokens: 1, maxTokens: 2 },
    });
    const engine = engineWith(transport);
    expect(engine.models().map((choice) => choice.id)).toEqual(["default", "opus", "fable", "sonnet", "haiku"]);
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

  it("reports each native result to the durable cost observer", async () => {
    const transport = new FakeTransport({
      frames: streamFrames("w0-02-control-writeprobe.jsonl"),
      contextUsage: { totalTokens: 1, maxTokens: 2 },
    });
    const engine = engineWith(transport);
    const observed = vi.fn();
    engine.onCostResult(observed);
    await collect(engine.runTurn("hi", { signal: new AbortController().signal }));
    expect(observed).toHaveBeenCalledTimes(1);
    expect(observed.mock.calls[0]![0].total_cost_usd).toBeGreaterThan(0);
  });

  it("records captured native usage under the host turn identity", async () => {
    const db = new SqlitePersistenceAdapter(":memory:");
    await db.createSession({ id: "native", workspace: "/work", model: "m", mode: "build" });
    const engine = engineWith(new FakeTransport({ frames: streamFrames("w0-02-control-writeprobe.jsonl"), contextUsage: { totalTokens: 1, maxTokens: 2 } }));
    const pending: Promise<void>[] = [];
    const audit = { sink: { record: (row: Omit<Parameters<SqlitePersistenceAdapter["recordProviderUsage"]>[0], "sessionId" | "createdAt">) => { pending.push(db.recordProviderUsage({ ...row, sessionId: "native", createdAt: Date.now() })); } }, summary: { summary: async () => { await Promise.all(pending); return summarizeProviderUsage(await db.listProviderUsage("native")); } } };
    const h = createHarness({ steps: [], engine, usageAudit: audit });
    bindClaudeUsage(engine, audit.sink, () => h.session, "m");
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor((m) => m.type === "host_ready");
      h.send({ type: "user_message", requestId: "r", text: "hi" });
      await h.waitUntil(() => h.received.some((m) => m.type === "agent_event" && m.event.type === "loop_end"));
      await Promise.all(pending);
      const started = h.received.find((m) => m.type === "turn_started");
      expect(started?.type).toBe("turn_started");
      const rows = await db.listProviderUsage("native");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ turnId: started!.turnId, step: 1, costUsd: expect.any(Number) });
    } finally { h.close(); await db.close(); }
  });

  it("records a captured native result as a durable cost snapshot", async () => {
    const db = new SqlitePersistenceAdapter(":memory:");
    await db.createSession({ id: "claude", workspace: "/work", model: "m", mode: "build" });
    const transport = new FakeTransport({ frames: streamFrames("w0-02-control-writeprobe.jsonl"), contextUsage: { totalTokens: 1, maxTokens: 2 } });
    const engine = engineWith(transport);
    const pending: Promise<void>[] = [];
    engine.onCostResult((result) => pending.push(db.recordProviderUsage({ ...claudeUsageRecord(result, "turn-1", "m"), sessionId: "claude", createdAt: 1 })));
    await collect(engine.runTurn("hi", { signal: new AbortController().signal }));
    await Promise.all(pending);
    const records = await db.listProviderUsage("claude");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ priceBasisId: "claude-cli-reported", costUsd: expect.any(Number), inputTokens: expect.any(Number), cachedInputTokens: expect.any(Number), outputTokens: expect.any(Number) });
    expect(records[0]!.costUsd).toBeGreaterThan(0);
    await db.close();
  });

  it("CC-C has no resume source, so history is empty by construction", () => {
    expect(engineWith(new FakeTransport()).historyItems()).toEqual([]);
  });
});

/**
 * a CLI turn started by ITSELF (injected cross-session notice)
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
describe("ClaudeEngine — CLI self-started turns", () => {
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
    expect(loopEnds[0]).toEqual({ type: "loop_end", reason: "completed", turns: 1 });
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
    expect(loopEnds[0]).toEqual({ type: "loop_end", reason: "completed", turns: 1 });
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
    expect(loopEnds[0]).toEqual({ type: "loop_end", reason: "completed", turns: 1 });
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
    expect(third.filter((event) => event.type === "loop_end")).toEqual([{ type: "loop_end", reason: "completed", turns: 1 }]);
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
    expect(events.filter((event) => event.type === "loop_end")).toEqual([{ type: "loop_end", reason: "completed", turns: 1 }]);
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
    expect(third.filter((event) => event.type === "loop_end")).toEqual([{ type: "loop_end", reason: "completed", turns: 1 }]);
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
    expect(events.filter((event) => event.type === "loop_end")).toEqual([{ type: "loop_end", reason: "completed", turns: 1 }]);
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
    expect(events.filter((event) => event.type === "loop_end")).toEqual([{ type: "loop_end", reason: "completed", turns: 1 }]);
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
 * hazard (b) — the resumed session's FIRST `system/init` is the truth
 * about model and permission mode, not the row we resumed from. These pin what
 * the engine does with that init: it adopts the native posture into its own
 * settings, translating the CLI's RESOLVED model id back into the catalog
 * `value` the rest of AnyCode selects by, and it announces the init exactly
 * once so the host can materialize/patch the session row at that moment.
 */
describe("ClaudeEngine — reconciliation from the first system/init (hazard (b))", () => {
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
    const catalog = fixtureCatalog();
    const opus = catalog.get("opus")!;
    expect(opus.resolvedModel).not.toBe(opus.value); // the split this test exists for
    const transport = new FakeTransport({ frames: [initFrame(opus.resolvedModel, "acceptEdits"), RESULT] });
    const engine = engineWith(transport, { model: "haiku", presetId: "ask", catalog });

    await collect(engine.runTurn("hi", { signal: new AbortController().signal }));

    // The SELECTABLE id, never the resolved one: persisting `claude-opus-5-5`
    // would fail `catalog.has()` on the next resume and silently fall back to
    // the default model.
    expect(engine.snapshot().model).toBe("opus");
    expect(catalog.has(engine.snapshot().model)).toBe(true);
    expect(engine.snapshot().activePresetId).toBe("workspace");
  });

  it("keeps an alias selection that ALREADY resolves to the reported id (no spurious flip between aliases)", async () => {
    const catalog = fixtureCatalog();
    const opus = catalog.get("opus")!;
    const transport = new FakeTransport({ frames: [initFrame(opus.resolvedModel, "default"), RESULT] });
    const engine = engineWith(transport, { model: "opus", presetId: "ask", catalog });

    await collect(engine.runTurn("hi", { signal: new AbortController().signal }));

    // A naive `findByResolved` adoption would replace the user's `opus`
    // with whichever catalog entry shares that resolved id and is listed first.
    expect(engine.snapshot().model).toBe("opus");
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
    expect(seen).toEqual([{ sessionId: "native-session-1", model: "model-x", permissionMode: "plan", mcpServerNames: [], mcpServerStatuses: [] }]);

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
    expect(seen).toEqual([{ sessionId: "native-session-1", model: "model-x", permissionMode: "plan", mcpServerNames: [], mcpServerStatuses: [] }]);
  });
});

/**
 * a `system/init` reporting an MCP server as `failed` must be
 * visible in the turn's own event stream — before this fix the status was
 * dropped by name-only parsing, so a failed "anycode" counted as healthy and
 * the model was the only one to notice ("anycode failed to connect").
 */
describe("ClaudeEngine — a failed MCP server is visible in the turn", () => {
  const RESULT: ClaudeStreamMessage = {
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 1,
    duration_ms: 1,
    duration_api_ms: 1,
    total_cost_usd: 0,
  } as unknown as ClaudeStreamMessage;

  function initWithServers(mcpServers: unknown[]): ClaudeStreamMessage {
    return {
      type: "system",
      subtype: "init",
      session_id: "native-session-1",
      model: "model-x",
      permissionMode: "plan",
      cwd: "/work",
      tools: [],
      mcp_servers: mcpServers,
      slash_commands: [],
      skills: [],
      capabilities: ["interrupt_receipt_v1"],
      claude_code_version: "2.1.288",
    } as unknown as ClaudeStreamMessage;
  }

  const FAILED_INIT = initWithServers([
    { name: "anycode", status: "failed" },
    { name: "alpha", status: "connected" },
  ]);

  it("yields exactly one engine_notice warning naming anycode and mcp__anycode__*, before turn_end", async () => {
    const transport = new FakeTransport({ frames: [FAILED_INIT, RESULT] });
    const engine = engineWith(transport);

    const events = await collect(engine.runTurn("hi", { signal: new AbortController().signal }));

    const mcpNotices = events.filter((event) => event.type === "engine_notice" && String((event as { message?: string }).message).includes("anycode"));
    expect(mcpNotices).toHaveLength(1);
    const notice = mcpNotices[0] as { level: string; message: string };
    expect(notice.level).toBe("warning");
    expect(notice.message).toContain("mcp__anycode__*");
    // Before turn_end — the warning belongs to the turn that observed it.
    expect(events.findIndex((event) => event.type === "engine_notice" && event === mcpNotices[0])).toBeLessThan(
      events.findIndex((event) => event.type === "turn_end"),
    );
    // The connected server produces no notice of its own.
    expect(events.filter((event) => event.type === "engine_notice" && String((event as { message?: string }).message).includes("\"alpha\""))).toHaveLength(0);
  });

  it("a second turn with the same failed init yields NO new notice (dedupe across turns)", async () => {
    const transport = new FakeTransport({ frames: [FAILED_INIT, RESULT] });
    const engine = engineWith(transport);

    await collect(engine.runTurn("one", { signal: new AbortController().signal }));
    transport.enqueue(FAILED_INIT);
    transport.enqueue(RESULT);
    const second = await collect(engine.runTurn("two", { signal: new AbortController().signal }));

    expect(second.filter((event) => event.type === "engine_notice")).toHaveLength(0);
  });

  it("an init with only connected servers yields no MCP notice", async () => {
    const transport = new FakeTransport({
      frames: [initWithServers([{ name: "alpha", status: "connected" }, { name: "beta", status: "pending" }]), RESULT],
    });
    const engine = engineWith(transport);

    const events = await collect(engine.runTurn("hi", { signal: new AbortController().signal }));
    expect(events.filter((event) => event.type === "engine_notice")).toHaveLength(0);
  });
});

/**
 * GitHub #3: the CLI re-emits `system/init` on every turn, and that report is
 * per-turn news. A live view (the host's MCP pane) that latched the FIRST init
 * kept showing a server as connected after a later init reported it failed.
 */
describe("ClaudeEngine — the MCP report follows EVERY system/init (GitHub #3)", () => {
  const RESULT: ClaudeStreamMessage = {
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 1,
    duration_ms: 1,
    duration_api_ms: 1,
    total_cost_usd: 0,
  } as unknown as ClaudeStreamMessage;

  function initWithServers(mcpServers: unknown[]): ClaudeStreamMessage {
    return {
      type: "system",
      subtype: "init",
      session_id: "native-session-1",
      model: "model-x",
      permissionMode: "plan",
      cwd: "/work",
      tools: [],
      mcp_servers: mcpServers,
      slash_commands: [],
      skills: [],
      capabilities: ["interrupt_receipt_v1"],
      claude_code_version: "2.1.288",
    } as unknown as ClaudeStreamMessage;
  }

  it("announces a connected → failed transition across two inits", async () => {
    const transport = new FakeTransport({
      frames: [initWithServers([{ name: "docs", status: "connected" }]), RESULT],
    });
    const engine = engineWith(transport);
    const seen: ClaudeInitMcpServerStatus[][] = [];
    engine.onEverySystemInit((init) => seen.push(init.mcpServerStatuses));

    await collect(engine.runTurn("one", { signal: new AbortController().signal }));
    expect(seen).toEqual([[{ name: "docs", status: "connected" }]]);

    // The SAME server dies on the next turn and only says so in that init.
    transport.enqueue(initWithServers([{ name: "docs", status: "failed" }]));
    transport.enqueue(RESULT);
    await collect(engine.runTurn("two", { signal: new AbortController().signal }));

    expect(seen).toEqual([
      [{ name: "docs", status: "connected" }],
      [{ name: "docs", status: "failed" }],
    ]);
  });

  it("does not replay a previous init to a listener registered mid-session (next init only)", async () => {
    const transport = new FakeTransport({
      frames: [initWithServers([{ name: "docs", status: "connected" }]), RESULT],
    });
    const engine = engineWith(transport);
    await collect(engine.runTurn("one", { signal: new AbortController().signal }));

    const seen: ClaudeInitMcpServerStatus[][] = [];
    engine.onEverySystemInit((init) => seen.push(init.mcpServerStatuses));
    expect(seen).toEqual([]);

    transport.enqueue(initWithServers([{ name: "docs", status: "failed" }]));
    transport.enqueue(RESULT);
    await collect(engine.runTurn("two", { signal: new AbortController().signal }));
    expect(seen).toEqual([[{ name: "docs", status: "failed" }]]);
  });
});

/**
 * claude emits NO token event through the core `finish`->`usage`
 * path (the context meter is deliberately `get_context_usage`, never a
 * `result.usage` sum — the describe block above). This is the OTHER half:
 * `result.usage` DOES feed a session-cumulative `engine_session_tokens`
 * event, which host/index.ts's telemetry tap (records.ts's
 * `buildEngineTelemetryTap`) converts to additive deltas. The double-count
 * pin mirrors records.test.ts's own engine-tap pin, one layer down the
 * stack: the ENGINE must hand the tap a truly cumulative session total, or
 * that shim's delta math is fed a lie from the start.
 */
describe("ClaudeEngine — session-cumulative token accounting", () => {
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

  it("includes cache reads and writes in cumulative input usage", async () => {
    const transport = new FakeTransport({ frames: [INIT, resultFrame({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 })] });
    const engine = engineWith(transport);
    const first = await collect(engine.runTurn("one", { signal: new AbortController().signal }));
    expect(first.find((event) => event.type === "engine_session_tokens")).toEqual({ type: "engine_session_tokens", input: 130, output: 5, total: 135, cachedInput: 100 });
    transport.enqueue(INIT);
    transport.enqueue(resultFrame({ input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 40, cache_creation_input_tokens: 5 }));
    const second = await collect(engine.runTurn("two", { signal: new AbortController().signal }));
    expect(second.find((event) => event.type === "engine_session_tokens")).toEqual({ type: "engine_session_tokens", input: 177, output: 8, total: 185, cachedInput: 140 });
  });

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
 * mid-turn provider context refreshes. Claude must refresh the
 * meter at user/tool-result and assistant boundaries during a RUNNING turn,
 * at most once per 30s (first refresh immediately eligible), never
 * overlapping, with completions surfacing during quiet periods without
 * another frame. Mid-turn failures/malformed readings are fully silent. The
 * unconditional post-loop_end final read is preserved.
 */
describe("ClaudeEngine — mid-turn context refreshes", () => {
  /** Continuously consumes a turn while it stays open; resolves with events when it finishes.
   *  `parked` resolves once the turn has passed its pre-send barrier
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

// ── manual compaction via the allowlisted slash passthrough ────────

describe("ClaudeEngine.compactNow — allowlisted /compact passthrough", () => {
  it("sends the allowlisted /compact frame and maps result success to compaction events", async () => {
    const transport = new FakeTransport({
      frames: [resultFrame157("completed")],
      contextUsage: { totalTokens: 1000, maxTokens: 200000 },
    });
    const engine = engineWith(transport);

    const events = await collect(engine.compactNow({ signal: new AbortController().signal }));

    // Allowlist proof: the ONLY user frame ever sent is the /compact one —
    // nothing else, no catalog command, no free-form string.
    expect(transport.sent).toEqual(["/compact"]);
    expect(types(events)[0]).toBe("compaction_start");
    const start = events[0] as { type: "compaction_start"; trigger: string };
    expect(start.trigger).toBe("manual");
    const end = events.find((event) => event.type === "compaction_end") as
      | { type: "compaction_end"; ok: boolean; preTokens: number; durationMs: number }
      | undefined;
    expect(end).toBeDefined();
    expect(end!.ok).toBe(true);
    expect(end!.preTokens).toBe(1000);
    expect(end!.durationMs).toBeGreaterThanOrEqual(0);
    // Post-swap meter refresh rides after compaction_end.
    const order = types(events);
    expect(order.lastIndexOf("context_usage")).toBeGreaterThan(order.lastIndexOf("compaction_end"));
  });

  it("compaction failure surfaces compaction_end ok:false with the result subtype", async () => {
    const transport = new FakeTransport({
      frames: [
        {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          num_turns: 1,
          duration_ms: 1,
          duration_api_ms: 1,
          total_cost_usd: 0,
        } as unknown as ClaudeStreamMessage,
      ],
      contextUsage: { totalTokens: 1000, maxTokens: 200000 },
    });
    const engine = engineWith(transport);

    const events = await collect(engine.compactNow({ signal: new AbortController().signal }));

    const end = events.find((event) => event.type === "compaction_end") as
      | { type: "compaction_end"; ok: boolean; error?: string; durationMs: number }
      | undefined;
    expect(end).toBeDefined();
    expect(end!.ok).toBe(false);
    expect(end!.error).toContain("error_during_execution");
    expect(end!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("abort interrupts: interrupt() called, settle timeout closes with ok:false", async () => {
    // No result frame ever arrives — the settle deadline must terminalize.
    const transport = new FakeTransport({
      frames: [assistantFrame("m-compact-stuck")],
      contextUsage: { totalTokens: 1000, maxTokens: 200000 },
    });
    const engine = engineWith(transport, { timeouts: { postInterruptSettleMs: 50 } });
    const controller = new AbortController();

    const events: AgentEvent[] = [];
    const run = (async () => {
      for await (const event of engine.compactNow({ signal: controller.signal })) {
        events.push(event);
        if (event.type === "compaction_start") controller.abort();
      }
    })();
    await run;

    expect(transport.interrupts).toBe(1);
    const end = events.find((event) => event.type === "compaction_end") as
      | { type: "compaction_end"; ok: boolean; error?: string }
      | undefined;
    expect(end).toBeDefined();
    expect(end!.ok).toBe(false);
    expect(end!.error).toContain("interrupt settle timeout");
    // A wedged compaction is NOT proof the session died — transport stays open.
    expect(transport.closed).toBe(0);
    expect(events.some((event) => event.type === "error")).toBe(false);
  });

  it("stream ownership is returned: an engine-level turn AFTER compactNow still sees frames", async () => {
    const transport = new FakeTransport({
      frames: [resultFrame157("completed")],
      contextUsage: { totalTokens: 1000, maxTokens: 200000 },
    });
    const engine = engineWith(transport);
    await collect(engine.compactNow({ signal: new AbortController().signal }));
    expect(transport.sent).toEqual(["/compact"]);

    // The next owner turn owns the stream again and completes normally.
    const turnTransport = transport;
    turnTransport.enqueue(foreignAssistantFrame("m-after", "post-compaction"));
    turnTransport.enqueue(resultFrame157("completed"));
    const events = await collect(engine.runTurn("hi", { signal: new AbortController().signal }));
    expect(events[0]).toEqual({ type: "turn_start", turn: 1 });
    expect(events.find((event) => event.type === "loop_end")).toEqual({ type: "loop_end", reason: "completed", turns: 1 });
    expect(transport.sent).toEqual(["/compact", "hi"]);
  });

  it("an engine spawned WITH --disable-slash-commands (child session) refuses compaction and hides the row", async () => {
    const transport = new FakeTransport({
      frames: [resultFrame157("completed")],
      contextUsage: { totalTokens: 1000, maxTokens: 200000 },
    });
    const engine = engineWith(transport, { slashPassthrough: false });

    expect(engine.capabilities.supportsManualCompact).toBe(false);
    const events = await collect(engine.compactNow({ signal: new AbortController().signal }));

    // Nothing is sent: a /compact frame to a flagged CLI would reach the model as text.
    expect(transport.sent).toEqual([]);
    expect(events).toEqual([
      { type: "compaction_end", ok: false, preTokens: 0, durationMs: 0, error: "manual compaction unavailable in this session" },
    ]);
    expect(engineWith(new FakeTransport({ frames: [] })).capabilities.supportsManualCompact).toBe(true);
  });

  it("the leak discriminator: initialize.commands/ambient slash_commands never surface", async () => {
    const transport = new FakeTransport({
      frames: [
        {
          // A system/init whose ambient catalog names an owner-side command.
          type: "system",
          subtype: "init",
          session_id: "s-1",
          model: "default",
          permissionMode: "default",
          cwd: "/tmp",
          tools: [],
          mcp_servers: [],
          slash_commands: ["deep-research", "update-config"],
          skills: ["ambient-skill"],
          capabilities: [],
          claude_code_version: "2.1.220",
        } as unknown as ClaudeStreamMessage,
        foreignAssistantFrame("m-turn", "normal turn output"),
        resultFrame157("completed"),
      ],
      contextUsage: { totalTokens: 1000, maxTokens: 200000 },
    });
    const engine = engineWith(transport);

    const events = await collect(engine.runTurn("plain turn", { signal: new AbortController().signal }));

    // The ambient catalog NEVER reaches the projected event stream...
    expect(JSON.stringify(events)).not.toContain("deep-research");
    expect(JSON.stringify(events)).not.toContain("update-config");
    // ...and the only user frame sent is the ordinary turn input (no /command
    // is ever built or forwarded by host code — the allowlist's whole point).
    expect(transport.sent).toEqual(["plain turn"]);
    expect(transport.sent.filter((frame) => typeof frame === "string" && frame.startsWith("/"))).toEqual([]);
  });

  // ── cross-review F3/F4/F5/F7: contract, barrier, and subtype tolerance ────

  it("F3: a client that throws on the /compact send surfaces compaction_end ok:false (never throws out of the generator, no stuck compacting)", async () => {
    // The client can fail (terminal latch) in the window between the engine's
    // idle checks and the send — compactNow's own contract (and
    // AgentLoop.compactNow's precedent) is "never throws". Pre-fix, the send
    // sat OUTSIDE the try, so this exact window threw out of the generator
    // after compaction_start had already been yielded, wedging the renderer's
    // `compacting` status with no compaction_end ever coming.
    const transport = new FakeTransport({
      frames: [resultFrame157("completed")],
      contextUsage: { totalTokens: 1000, maxTokens: 200000 },
    });
    const engine = engineWith(transport);
    // Simulate the client-side death racing ahead of the engine's latch: every
    // sendUserMessage from here on throws (a closed stdin / latched
    // terminalError, claude-client.ts's write guard).
    const death = new Error("claude stdin is unavailable");
    transport.sendUserMessage = () => {
      throw death;
    };

    const events = await collect(engine.compactNow({ signal: new AbortController().signal }));

    const end = events.find((event) => event.type === "compaction_end") as
      | { type: "compaction_end"; ok: boolean; error?: string }
      | undefined;
    expect(end).toBeDefined();
    expect(end!.ok).toBe(false);
    expect(end!.error).toContain("claude stdin is unavailable");
    // compaction_start was already yielded — the end MUST follow it on the
    // same stream so the renderer's compacting status is always released.
    expect(types(events)[0]).toBe("compaction_start");
    expect(types(events).lastIndexOf("compaction_end")).toBeGreaterThan(types(events).lastIndexOf("compaction_start"));
  });

  it("F4: a CLI self-started (foreign) turn finishes BEFORE the /compact frame is sent — its result is never mistaken for the compaction's verdict", async () => {
    // The exact interleave the send barrier was built for: the idle
    // reader has already classified a foreign assistant frame (foreignTurn
    // open) when the user hits Compact. Pre-fix, compactNow sent /compact
    // immediately and treated the FIRST result it saw as terminal — the
    // FOREIGN turn's. The foreign result here deliberately carries an ERROR
    // subtype while the compaction's own result is a success: pre-fix this
    // produced a wrong ok:false (and the mirrored shape — foreign success,
    // compaction error — a wrong ok:true while the /compact turn was still
    // queued).
    const foreignResult: ClaudeStreamMessage = {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      num_turns: 1,
      duration_ms: 1,
      duration_api_ms: 1,
      total_cost_usd: 0,
    };
    const compactionResult: ClaudeStreamMessage = {
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 1,
      duration_ms: 1,
      duration_api_ms: 1,
      total_cost_usd: 0,
      terminal_reason: "completed",
    };
    const transport = new FakeTransport({
      frames: [foreignAssistantFrame("m-turn1", "first owner turn"), foreignResultFrame("first result")],
      contextUsage: { totalTokens: 1000, maxTokens: 200000 },
    });
    const engine = engineWith(transport);
    // A first owner turn flushes the constructor frames and hands the stream
    // back to the idle reader (between-turns window).
    await collect(engine.runTurn("first", { signal: new AbortController().signal }));
    expect(transport.sent).toEqual(["first"]);

    // The foreign turn STARTS between turns: the idle reader classifies the
    // assistant frame and opens foreignTurn before compactNow takes over.
    transport.push(foreignAssistantFrame("m-foreign-open", "a cross-session notice is being handled"));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    // Start the compaction; while it waits the foreign turn out (parked in
    // the barrier's frame race), the foreign turn SETTLES — its result must
    // be absorbed as the foreign turn's, never read as the compaction's.
    // The compaction's own result rides the /compact send itself (enqueue).
    const collecting = collect(engine.compactNow({ signal: new AbortController().signal }));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    transport.push(foreignResult);
    transport.enqueue(compactionResult);
    const events = await collecting;

    const end = events.find((event) => event.type === "compaction_end") as
      | { type: "compaction_end"; ok: boolean; error?: string }
      | undefined;
    expect(end).toBeDefined();
    // The verdict comes from the COMPACTION's own result (success), never the
    // foreign turn's error subtype.
    expect(end!.ok).toBe(true);
    expect(transport.sent).toEqual(["first", "/compact"]);
    expect(transport.interrupts).toBe(0); // a normal foreign turn is never interrupted
    // The foreign turn's frames were absorbed (its assistant text and result
    // never reach the compaction's event stream)...
    expect(events.some((event) => event.type === "text_start")).toBe(false);
    // ...but its existence was noticed on the stream itself: the barrier
    // yields the same engine_notice runTurn's foreign-wait does.
    const notice = events.find((event) => event.type === "engine_notice") as
      | { type: "engine_notice"; message: string }
      | undefined;
    expect(notice).toBeDefined();
    expect(notice!.message).toContain("finishing a turn it started on its own");
  });

  it("F5: a success-prefixed subtype variant (unpinned success_clears) is a PASS", async () => {
    const transport = new FakeTransport({
      frames: [
        {
          type: "result",
          subtype: "success_clears",
          is_error: false,
          num_turns: 1,
          duration_ms: 1,
          duration_api_ms: 1,
          total_cost_usd: 0,
        } as unknown as ClaudeStreamMessage,
      ],
      contextUsage: { totalTokens: 1000, maxTokens: 200000 },
    });
    const engine = engineWith(transport);

    const events = await collect(engine.compactNow({ signal: new AbortController().signal }));

    const end = events.find((event) => event.type === "compaction_end") as
      | { type: "compaction_end"; ok: boolean }
      | undefined;
    expect(end).toBeDefined();
    expect(end!.ok).toBe(true);
  });

  it("F5: a result frame with NO subtype at all fails closed as \"unknown\" (the tolerant read pins its default)", async () => {
    // The pinned contract lists subtype:string as required on a result, but
    // compactNow deliberately defends against its absence — this pins the
    // fail-closed default so the drift-buffer cannot silently rot.
    const transport = new FakeTransport({
      frames: [
        {
          type: "result",
          is_error: false,
          num_turns: 1,
          duration_ms: 1,
          duration_api_ms: 1,
          total_cost_usd: 0,
        } as unknown as ClaudeStreamMessage,
      ],
      contextUsage: { totalTokens: 1000, maxTokens: 200000 },
    });
    const engine = engineWith(transport);

    const events = await collect(engine.compactNow({ signal: new AbortController().signal }));

    const end = events.find((event) => event.type === "compaction_end") as
      | { type: "compaction_end"; ok: boolean; error?: string }
      | undefined;
    expect(end).toBeDefined();
    expect(end!.ok).toBe(false);
    expect(end!.error).toBe("unknown");
  });

  it("F7: a compaction result carrying cost/usage still feeds session-cumulative accounting", async () => {
    // A manual compaction runs a REAL summarization model call — its cost is
    // session state exactly like any foreign turn's (absorbIdleFrame routes
    // foreign results through onResult). The engine_session_tokens event is
    // deliberately NOT emitted (REPLACE-semantics consumer, doc'd in
    // compactNow); the cumulative counters are still kept honest.
    const transport = new FakeTransport({
      frames: [foreignResultFrame("compacted", { cost: 0.25, usage: { input_tokens: 700, output_tokens: 300 } })],
      contextUsage: { totalTokens: 1000, maxTokens: 200000 },
    });
    const engine = engineWith(transport);

    const events = await collect(engine.compactNow({ signal: new AbortController().signal }));

    expect(events.some((event) => event.type === "engine_session_tokens")).toBe(false);
    // The post-compaction owner turn reports the CUMULATIVE counters — the
    // compaction's tokens are inside them (200 in, 100 out from the usage
    // fixture below + the compaction's 700/300), never dropped.
    transport.enqueue(foreignAssistantFrame("m-after", "after"));
    transport.enqueue(foreignResultFrame("after result", { usage: { input_tokens: 200, output_tokens: 100 } }));
    const turnEvents = await collect(engine.runTurn("hi", { signal: new AbortController().signal }));
    const tokens = turnEvents.find((event) => event.type === "engine_session_tokens") as
      | { type: "engine_session_tokens"; input: number; output: number; total: number }
      | undefined;
    expect(tokens).toBeDefined();
    expect(tokens!.input).toBe(900);
    expect(tokens!.output).toBe(400);
    expect(tokens!.total).toBe(1300);
  });

  it("F2: a system-origin turn whose model-authored text starts with '/' is neutralized — never interpreted as a slash command", async () => {
    // The injection boundary created by the spawn change: the
    // ROOT engine session interprets a leading /command in a stream-json user
    // frame (w0-17 evidence), and host paths DO convert model output into
    // user frames — a detached child's final text (child_report ->
    // enqueuePrompt -> user_message origin:"system") or an agent-to-agent
    // message (drainAgentInbox -> acceptUserMessage(..., "system")). A child
    // model that ends its report with "\n/doctor" (or /update-config, /run)
    // must not get it executed in the parent root session.
    const transport = new FakeTransport({
      frames: [foreignAssistantFrame("m-sys-1", "handled"), foreignResultFrame("sys result")],
      contextUsage: { totalTokens: 1000, maxTokens: 200000 },
    });
    const engine = engineWith(transport);

    // POSITION 0: the frame's first non-whitespace character is the slash.
    const events = await collect(
      engine.runTurn("/doctor", { signal: new AbortController().signal, origin: "system" }),
    );

    expect(events.some((event) => event.type === "loop_end")).toBe(true);
    // The wire frame is NOT a slash command: the guard rewrites position 0.
    expect(transport.sent[0]).not.toBe("/doctor");
    expect(String(transport.sent[0])).not.toMatch(/^\/doctor/);
    // And it still carries the payload verbatim after the guard line.
    expect(String(transport.sent[0])).toContain("/doctor");
    // A HUMAN turn with the same text is untouched — the user typing /doctor
    // verbatim as ordinary text stays reachable by design (claude-engine.ts's
    // own allowlist comment).
    transport.enqueue(foreignAssistantFrame("m-human", "handled"));
    transport.enqueue(foreignResultFrame("human result"));
    await collect(engine.runTurn("/doctor", { signal: new AbortController().signal }));
    expect(transport.sent[1]).toBe("/doctor");
  });

  it("F2: a system-origin turn whose leading '/' sits on a LATER line (after the notification header) is neutralized too", async () => {
    // The realistic child-report shape: host notification header first, then
    // the model-authored body. The live CLI's interpretation of a line-start
    // /cmd at position >0 was the deferred probe (review §10.2) — the host
    // guard must not bet on the answer: every line-start '/' of a
    // system-origin frame is de-fanged.
    const transport = new FakeTransport({
      frames: [foreignAssistantFrame("m-sys-2", "handled"), foreignResultFrame("sys result 2")],
      contextUsage: { totalTokens: 1000, maxTokens: 200000 },
    });
    const engine = engineWith(transport);

    const text = "[SYSTEM NOTIFICATION - NOT USER INPUT]\nchild finished\n/doctor";
    await collect(engine.runTurn(text, { signal: new AbortController().signal, origin: "system" }));

    expect(String(transport.sent[0])).not.toMatch(/\n\/doctor/);
    expect(String(transport.sent[0])).toContain("[SYSTEM NOTIFICATION - NOT USER INPUT]");
  });

  it("F2: ordinary system-origin text (no slash) and HUMAN-origin text are byte-identical to before", async () => {
    const transport = new FakeTransport({
      frames: [foreignAssistantFrame("m-plain", "handled"), foreignResultFrame("plain result")],
      contextUsage: { totalTokens: 1000, maxTokens: 200000 },
    });
    const engine = engineWith(transport);

    const sysText = "[SYSTEM NOTIFICATION - NOT USER INPUT]\nall clean here";
    await collect(engine.runTurn(sysText, { signal: new AbortController().signal, origin: "system" }));
    expect(transport.sent[0]).toBe(sysText);

    transport.enqueue(foreignAssistantFrame("m-human2", "handled"));
    transport.enqueue(foreignResultFrame("human result 2"));
    await collect(engine.runTurn("/anything /at /all", { signal: new AbortController().signal }));
    expect(transport.sent[1]).toBe("/anything /at /all");
  });
});

// ── review: compactNow through the REAL composition ───────────
// host/index.ts hands Session a ClaudeShadowTranscriptEngine wrapping a real
// ClaudeEngine; Session's compact_request rail gates on method presence. This
// pins the shipped composition (real engine, real wrapper), not a fake.
describe("ClaudeEngine under ClaudeShadowTranscriptEngine — review (F1 end-to-end)", () => {
  it("the wrapper over a real root ClaudeEngine exposes compactNow, sends the allowlisted frame, and hands the stream back", async () => {
    const { ClaudeShadowTranscriptEngine } = await import("./shadow-transcript.js");
    const transport = new FakeTransport({
      frames: [resultFrame157("completed")],
      contextUsage: { totalTokens: 1000, maxTokens: 200000 },
    });
    const engine = engineWith(transport);
    const recorded: unknown[] = [];
    const wrapped = new ClaudeShadowTranscriptEngine(engine, { record: (_ref, items) => recorded.push(...items), list: async () => [] }, "session-ref-1", []);

    expect(wrapped.capabilities.supportsManualCompact).toBe(true);
    expect(wrapped.compactNow).toBeDefined();
    const events = await collect(wrapped.compactNow!({ signal: new AbortController().signal }));
    expect(transport.sent).toEqual(["/compact"]);
    expect(events.find((event) => event.type === "compaction_end")).toMatchObject({ type: "compaction_end", ok: true });
    expect(recorded).toEqual([]);
  });
});

describe("ClaudeEngine.compactNow — review (Stop during the foreign-turn barrier)", () => {
  it("a Stop while waiting out a foreign turn never sends /compact, never interrupts the CLI's own turn, and ends ok:false cancelled", async () => {
    const transport = new FakeTransport({
      frames: [foreignAssistantFrame("m-turn1", "first owner turn"), foreignResultFrame("first result")],
      contextUsage: { totalTokens: 1000, maxTokens: 200000 },
    });
    const engine = engineWith(transport);
    await collect(engine.runTurn("first", { signal: new AbortController().signal }));
    transport.push(foreignAssistantFrame("m-foreign-open", "a cross-session notice is being handled"));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const controller = new AbortController();
    const collecting = collect(engine.compactNow({ signal: controller.signal }));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    controller.abort();
    const events = await collecting;

    expect(transport.sent).toEqual(["first"]);
    expect(transport.interrupts).toBe(0);
    expect(events.find((event) => event.type === "compaction_end")).toMatchObject({ type: "compaction_end", ok: false, error: "cancelled" });

    // The foreign turn still settles through the restarted idle reader, and a
    // later owner turn is not wedged behind it.
    transport.push(foreignResultFrame("foreign result"));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    transport.enqueue(resultFrame157("completed"));
    await collect(engine.runTurn("after", { signal: new AbortController().signal }));
    expect(transport.sent).toEqual(["first", "after"]);
  });
});


describe("orchestration preset guard", () => {
  it("refuses preset changes before touching the transport in every restricted posture", async () => {
    const transport = new FakeTransport();
    let restricted = true;
    const engine = engineWith(transport, { restricted: () => restricted });
    await expect(engine.selectPreset("workspace")).resolves.toMatchObject({ ok: false });
    expect(transport.controls).toEqual([]);
    expect(engine.activePresetId).toBe("ask");
    restricted = false;
    await expect(engine.selectPreset("workspace")).resolves.toMatchObject({ ok: true });
    await engine.dispose("session-close");
  });
});

describe("Claude command catalog admission", () => {
  it("rejects child and restricted sessions, including a posture change during a scan", async () => {
    let restricted = false;
    let release!: (rows: { name: string; scope: "project"; description: string }[]) => void;
    const pending = new Promise<{ name: string; scope: "project"; description: string }[]>(resolve => { release = resolve; });
    const engine = engineWith(new FakeTransport(), { restricted: () => restricted });
    engine.commandCatalog = { list: () => pending, invalidate: () => {} };
    const read = engine.listClaudeCommands();
    restricted = true;
    release([{ name: "test", scope: "project", description: "Test" }]);
    expect(await read).toEqual([]);
    await engine.dispose("session-close");
    const child = engineWith(new FakeTransport(), { slashPassthrough: false });
    child.commandCatalog = { list: async () => [{ name: "test", scope: "project", description: "Test" }], invalidate: () => {} };
    expect(await child.listClaudeCommands()).toEqual([]);
    await child.dispose("session-close");
  });
});

/**
 * The CLI's own background agents (w0-19, a live capture in stream-json input
 * mode — the mode the engine drives). The parent turn's `result` arrives
 * first; the agent's own frames and its task_* lifecycle arrive AFTER it,
 * while the engine is idle; then the CLI runs a turn of its own to report.
 */
describe("ClaudeEngine — the CLI's own background agents", () => {
  // A bare fixture: every line IS a stdout frame (no dir/raw envelope).
  const capture = readFileSync(join(FIXTURES_DIR, "w0-19-background-agent.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as ClaudeStreamMessage);
  const firstResult = capture.findIndex((frame) => frame.type === "result");
  const reportInit = capture.findIndex((frame, index) => index > firstResult && frame.type === "system" && (frame as { subtype?: string }).subtype === "init");
  const parentTurn = capture.slice(0, firstResult + 1);
  const idleAgentFrames = capture.slice(firstResult + 1, reportInit);
  const reportTurn = capture.slice(reportInit);
  const isForeignNotice = (event: AgentEvent): boolean =>
    event.type === "engine_notice" && String((event as { message?: string }).message).includes("started a turn on its own");

  it("the capture splits as described: parent turn, idle agent frames, the CLI's report turn", () => {
    expect(firstResult).toBeGreaterThan(0);
    expect(reportInit).toBeGreaterThan(firstResult);
    expect(idleAgentFrames.some((frame) => frame.type === "assistant")).toBe(true);
    expect(reportTurn.at(-1)?.type).toBe("result");
  });

  it("starts the agent's card inside the parent turn", async () => {
    const transport = new FakeTransport({ frames: parentTurn, contextUsage: { totalTokens: 1, maxTokens: 2 } });
    const engine = engineWith(transport);
    const events = await collect(engine.runTurn("launch it", { signal: new AbortController().signal }));
    const call = events.find((event) => event.type === "tool_call" && event.toolCall.name === "Agent") as Extract<AgentEvent, { type: "tool_call" }>;
    expect(events).toContainEqual({ type: "subagent_start", toolCallId: call.toolCall.id, agentType: "general-purpose", description: "Summarize anycode docs" });
    await engine.dispose("session-close");
  });

  it("delivers the agent's progress between turns to the detached sink, and the child's frames never open a foreign turn", async () => {
    const transport = new FakeTransport({ frames: parentTurn, contextUsage: { totalTokens: 1, maxTokens: 2 } });
    const engine = engineWith(transport);
    const detached: AgentEvent[] = [];
    engine.onDetachedEvent = (event) => detached.push(event);
    await collect(engine.runTurn("launch it", { signal: new AbortController().signal }));

    for (const frame of idleAgentFrames) transport.push(frame);
    // No result ever follows the child's frames, and none is needed: the next
    // owner turn must not wait for one.
    for (const frame of ownerFrames("two")) transport.enqueue(frame);
    const events = await collect(engine.runTurn("second", { signal: new AbortController().signal }));

    expect(events.some(isForeignNotice)).toBe(false);
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(JSON.stringify(events)).toContain("OWNER OUTPUT two");
    expect(transport.sent.at(-1)).toBe("second");
    expect(types(detached)).toEqual([
      "subagent_activity", "subagent_progress",
      "subagent_activity", "subagent_progress",
      "subagent_activity", "subagent_progress",
      "subagent_end",
    ]);
    expect(detached[0]).toEqual({ type: "subagent_activity", toolCallId: "toolu_01AJKBpVVvTVqpg8nKBashrq", toolName: "Read", summary: "/workspace/README.md" });
    expect(detached.at(-1)).toMatchObject({ toolCallId: "toolu_01AJKBpVVvTVqpg8nKBashrq", status: "completed", toolCalls: 3, durationMs: 4010 });
    await engine.dispose("session-close");
  });

  it("the CLI's own report turn after the agent finishes is still absorbed as a foreign turn", async () => {
    const transport = new FakeTransport({ frames: parentTurn, contextUsage: { totalTokens: 1, maxTokens: 2 } });
    const engine = engineWith(transport);
    engine.onDetachedEvent = () => {};
    await collect(engine.runTurn("launch it", { signal: new AbortController().signal }));

    for (const frame of [...idleAgentFrames, ...reportTurn]) transport.push(frame);
    for (const frame of ownerFrames("two")) transport.enqueue(frame);
    const events = await collect(engine.runTurn("second", { signal: new AbortController().signal }));

    expect(events.filter(isForeignNotice)).toHaveLength(1);
    expect(JSON.stringify(events)).toContain("OWNER OUTPUT two");
    await engine.dispose("session-close");
  });

  it("without a detached sink the idle agent frames are absorbed silently (no throw, no foreign turn)", async () => {
    const transport = new FakeTransport({ frames: parentTurn, contextUsage: { totalTokens: 1, maxTokens: 2 } });
    const engine = engineWith(transport);
    await collect(engine.runTurn("launch it", { signal: new AbortController().signal }));
    for (const frame of idleAgentFrames) transport.push(frame);
    for (const frame of ownerFrames("two")) transport.enqueue(frame);
    const events = await collect(engine.runTurn("second", { signal: new AbortController().signal }));
    expect(events.some(isForeignNotice)).toBe(false);
    await engine.dispose("session-close");
  });

  it("an agent that outlived its turn still reports through the detached sink when it finishes during a later owner turn", async () => {
    const transport = new FakeTransport({ frames: parentTurn, contextUsage: { totalTokens: 1, maxTokens: 2 } });
    const engine = engineWith(transport);
    const detached: AgentEvent[] = [];
    engine.onDetachedEvent = (event) => detached.push(event);
    await collect(engine.runTurn("launch it", { signal: new AbortController().signal }));

    // The agent's frames interleave with the second owner turn's own frames.
    const [ownerAssistant, ownerResult] = ownerFrames("two");
    for (const frame of [ownerAssistant!, ...idleAgentFrames, ownerResult!]) transport.enqueue(frame);
    const events = await collect(engine.runTurn("second", { signal: new AbortController().signal }));

    expect(events.filter((event) => event.type.startsWith("subagent_"))).toEqual([]);
    expect(JSON.stringify(events)).toContain("OWNER OUTPUT two");
    expect(detached.at(-1)).toMatchObject({ type: "subagent_end", toolCallId: "toolu_01AJKBpVVvTVqpg8nKBashrq", status: "completed" });
    await engine.dispose("session-close");
  });

  it("a foreground agent cut off by a Stop settles as cancelled with its turn", async () => {
    // w0-20 up to the agent's second progress: the Stop lands before its notification.
    const foreground = readFileSync(join(FIXTURES_DIR, "w0-20-foreground-agent.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as ClaudeStreamMessage);
    const transport = new FakeTransport({ frames: [...foreground.slice(0, 9), resultFrame157("aborted_streaming")], contextUsage: { totalTokens: 1, maxTokens: 2 } });
    const engine = engineWith(transport);
    const detached: AgentEvent[] = [];
    engine.onDetachedEvent = (event) => detached.push(event);
    const controller = new AbortController();
    const events: AgentEvent[] = [];
    for await (const event of engine.runTurn("run it", { signal: controller.signal })) {
      events.push(event);
      if (event.type === "subagent_progress") controller.abort();
    }
    expect(events.find((event) => event.type === "loop_end")).toMatchObject({ reason: "cancelled" });
    expect(detached).toEqual([
      expect.objectContaining({ type: "subagent_end", toolCallId: "toolu_01RDu83vHyAmThJmAAheTCUb", status: "cancelled" }),
    ]);
    await engine.dispose("session-close");
  });

  it("an agent that reports during a manual /compact still reaches the detached sink", async () => {
    const transport = new FakeTransport({ frames: parentTurn, contextUsage: { totalTokens: 1, maxTokens: 2 } });
    const engine = engineWith(transport);
    const detached: AgentEvent[] = [];
    engine.onDetachedEvent = (event) => detached.push(event);
    await collect(engine.runTurn("launch it", { signal: new AbortController().signal }));

    for (const frame of [...idleAgentFrames, resultFrame157("completed")]) transport.enqueue(frame);
    const events = await collect(engine.compactNow({ signal: new AbortController().signal }));

    expect(events.find((event) => event.type === "compaction_end")).toMatchObject({ ok: true });
    expect(events.filter((event) => event.type.startsWith("subagent_"))).toEqual([]);
    expect(types(detached)).toContain("subagent_progress");
    expect(types(detached)).toContain("subagent_activity");
    expect(detached.at(-1)).toMatchObject({ type: "subagent_end", toolCallId: "toolu_01AJKBpVVvTVqpg8nKBashrq", status: "completed" });
    await engine.dispose("session-close");
  });

  describe("a running agent's card settles as cancelled when the CLI that ran it is gone", () => {
    const cancelled = { type: "subagent_end", toolCallId: "toolu_01AJKBpVVvTVqpg8nKBashrq", status: "cancelled" };

    async function launched(
      options: { timeouts?: Partial<ClaudeEngineTimeouts>; rejectStreamOnce?: Error } = {},
    ): Promise<{ transport: FakeTransport; engine: ClaudeEngine; detached: AgentEvent[] }> {
      const transport = new FakeTransport({
        frames: parentTurn,
        contextUsage: { totalTokens: 1, maxTokens: 2 },
        ...(options.rejectStreamOnce === undefined ? {} : { rejectStreamOnce: options.rejectStreamOnce }),
      });
      const engine = engineWith(transport, options.timeouts === undefined ? {} : { timeouts: options.timeouts });
      const detached: AgentEvent[] = [];
      engine.onDetachedEvent = (event) => detached.push(event);
      await collect(engine.runTurn("launch it", { signal: new AbortController().signal }));
      return { transport, engine, detached };
    }

    it("the CLI exits while idle", async () => {
      const { transport, engine, detached } = await launched();
      await transport.close();
      await vi.waitFor(() => expect(detached).toContainEqual(expect.objectContaining(cancelled)));
      await engine.dispose("session-close");
    });

    it("the CLI exits during a later owner turn", async () => {
      const { transport, engine, detached } = await launched();
      const turn = collect(engine.runTurn("second", { signal: new AbortController().signal }));
      await vi.waitFor(() => expect(transport.sent).toHaveLength(2));
      await transport.close();
      const events = await turn;
      expect(events.some((event) => event.type === "error")).toBe(true);
      expect(detached).toContainEqual(expect.objectContaining(cancelled));
      await engine.dispose("session-close");
    });

    /** Runs an owner turn and presses Stop once `stopWhen` sees the event to stop at. */
    async function stopped(engine: ClaudeEngine, stopWhen: (event: AgentEvent) => boolean): Promise<AgentEvent[]> {
      const controller = new AbortController();
      const events: AgentEvent[] = [];
      for await (const event of engine.runTurn("stop me", { signal: controller.signal })) {
        events.push(event);
        if (stopWhen(event)) controller.abort();
      }
      return events;
    }
    const isFinishingNotice = (event: AgentEvent): boolean =>
      event.type === "engine_notice" && String((event as { message?: string }).message).includes("finishing a turn");

    it("a Stop of a later owner turn that cannot settle in time closes the CLI", async () => {
      const { transport, engine, detached } = await launched({ timeouts: { postInterruptSettleMs: 30 } });
      transport.enqueue(foreignToolUseFrame("m-sleep", "Bash"));
      const events = await stopped(engine, (event) => event.type === "tool_call");
      expect(transport.closed).toBe(1);
      expect(events.some((event) => event.type === "error")).toBe(true);
      expect(detached).toContainEqual(expect.objectContaining(cancelled));
      await engine.dispose("session-close");
    });

    it("a Stop of a foreign turn that cannot settle in time closes the CLI", async () => {
      const { transport, engine, detached } = await launched({ timeouts: { postInterruptSettleMs: 30 } });
      transport.push(foreignAssistantFrame("m-foreign", "FOREIGN"));
      await stopped(engine, isFinishingNotice);
      expect(transport.closed).toBe(1);
      expect(detached).toContainEqual(expect.objectContaining(cancelled));
      await engine.dispose("session-close");
    });

    it("the transport fails while a stopped foreign turn settles", async () => {
      const { transport, engine, detached } = await launched({ rejectStreamOnce: new Error("claude stream broke") });
      transport.push(foreignAssistantFrame("m-foreign", "FOREIGN"));
      const controller = new AbortController();
      const turn = (async () => {
        for await (const event of engine.runTurn("stop me", { signal: controller.signal })) {
          if (isFinishingNotice(event)) controller.abort();
        }
      })();
      await vi.waitFor(() => expect(transport.interrupts).toBe(1));
      transport.releaseStreamReject();
      await turn;
      expect(detached).toContainEqual(expect.objectContaining(cancelled));
      await engine.dispose("session-close");
    });

    it("the CLI exits while a stopped foreign turn settles", async () => {
      const { transport, engine, detached } = await launched();
      transport.push(foreignAssistantFrame("m-foreign", "FOREIGN"));
      const controller = new AbortController();
      const turn = (async () => {
        for await (const event of engine.runTurn("stop me", { signal: controller.signal })) {
          if (isFinishingNotice(event)) controller.abort();
        }
      })();
      await vi.waitFor(() => expect(transport.interrupts).toBe(1));
      await transport.close();
      await turn;
      expect(detached).toContainEqual(expect.objectContaining(cancelled));
      await engine.dispose("session-close");
    });

    it("the CLI exits while a stopped owner turn settles", async () => {
      const { transport, engine, detached } = await launched();
      transport.enqueue(foreignToolUseFrame("m-sleep", "Bash"));
      const controller = new AbortController();
      const turn = (async () => {
        for await (const event of engine.runTurn("stop me", { signal: controller.signal })) {
          if (event.type === "tool_call") controller.abort();
        }
      })();
      await vi.waitFor(() => expect(transport.interrupts).toBe(1));
      await transport.close();
      await turn;
      expect(detached).toContainEqual(expect.objectContaining(cancelled));
      await engine.dispose("session-close");
    });

    it("the engine is disposed", async () => {
      const { engine, detached } = await launched();
      await engine.dispose("session-close");
      expect(detached).toContainEqual(expect.objectContaining(cancelled));
    });

    it("settles each agent once, and a closing session that throws cannot break disposal", async () => {
      const { transport, engine, detached } = await launched();
      await transport.close();
      await vi.waitFor(() => expect(detached).toContainEqual(expect.objectContaining(cancelled)));
      engine.onDetachedEvent = () => { throw new Error("session closed"); };
      await expect(engine.dispose("session-close")).resolves.toBeUndefined();
      expect(detached.filter((event) => event.type === "subagent_end")).toHaveLength(1);
    });
  });
});

it("does not block a completed turn on quota and publishes only while alive", async () => {
  const transport = new FakeTransport({ frames: streamFrames("w0-02-control-writeprobe.jsonl") });
  let resolveUsage!: (value: unknown) => void;
  const usage = new Promise<unknown>((resolve) => { resolveUsage = resolve; });
  const original = transport.controlRequest.bind(transport);
  vi.spyOn(transport, "controlRequest").mockImplementation(async (subtype, request) => {
    if (subtype === "get_usage") return await usage as never;
    return original(subtype, request);
  });
  const engine = engineWith(transport);
  const detached: AgentEvent[] = [];
  engine.onDetachedEvent = (event) => detached.push(event);
  const events = await collect(engine.runTurn("hi", { signal: new AbortController().signal }));
  expect(types(events)).toContain("loop_end");
  expect(detached.filter((event) => event.type === "engine_quota")).toHaveLength(0);
  resolveUsage({ rate_limits: { limits: [{ kind: "session", percent: 25, is_active: true }, { kind: "weekly_all", percent: 60 }] } });
  await vi.waitFor(() => expect(detached).toContainEqual(expect.objectContaining({ type: "engine_quota", quota: expect.objectContaining({ primary: expect.objectContaining({ usedPercent: 25 }) }) })));
});

it("ignores a quota reply after disposal", async () => {
  const transport = new FakeTransport({ frames: streamFrames("w0-02-control-writeprobe.jsonl") });
  let resolveUsage!: (value: unknown) => void;
  const usage = new Promise<unknown>((resolve) => { resolveUsage = resolve; });
  const original = transport.controlRequest.bind(transport);
  vi.spyOn(transport, "controlRequest").mockImplementation(async (subtype, request) => subtype === "get_usage" ? await usage as never : original(subtype, request));
  const engine = engineWith(transport);
  const detached: AgentEvent[] = [];
  engine.onDetachedEvent = event => detached.push(event);
  await collect(engine.runTurn("hi", { signal: new AbortController().signal }));
  await engine.dispose("session-close");
  resolveUsage({ rate_limits: { limits: [{ kind: "session", percent: 25 }] } });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(detached.filter(event => event.type === "engine_quota")).toHaveLength(0);
});

it("coalesces overlapping quota pulls and preserves the last successful snapshot on failure", async () => {
  const frames = streamFrames("w0-02-control-writeprobe.jsonl");
  const transport = new FakeTransport({ frames });
  let resolveUsage!: (value: unknown) => void;
  const usage = new Promise<unknown>(resolve => { resolveUsage = resolve; });
  const original = transport.controlRequest.bind(transport);
  let calls = 0;
  vi.spyOn(transport, "controlRequest").mockImplementation(async (subtype, request) => {
    if (subtype !== "get_usage") return original(subtype, request);
    calls++;
    if (calls === 1) return await usage as never;
    throw new Error("unavailable");
  });
  const engine = engineWith(transport);
  const detached: AgentEvent[] = [];
  engine.onDetachedEvent = event => detached.push(event);
  await collect(engine.runTurn("first", { signal: new AbortController().signal }));
  for (const frame of frames) transport.enqueue(frame);
  await collect(engine.runTurn("second", { signal: new AbortController().signal }));
  expect(calls).toBe(1);
  resolveUsage({ rate_limits: { limits: [{ kind: "session", percent: 25 }] } });
  await vi.waitFor(() => expect(calls).toBe(2));
  expect(engine.quotaSnapshot()?.limits[0]?.percent).toBe(25);
  expect(detached.filter(event => event.type === "engine_quota")).toHaveLength(1);
});

describe("Claude notification-driven turns (5370)", () => {
  const init = { type: "system", subtype: "init", model: "default", permissionMode: "default", cwd: "/work", tools: [], mcp_servers: [], slash_commands: [], skills: [], capabilities: [] } as unknown as ClaudeStreamMessage;
  const report = "[SYSTEM NOTIFICATION - NOT USER INPUT]\n\n<task-notification>\n  <task-id>toolu_child</task-id>\n  <task-type>subagent_child</task-type>\n  <status>completed</status>\n  <summary>Mockup written.</summary>\n</task-notification>";
  // CLI 2.1.330: a foreground Bash running past a few seconds is tracked as a
  // task whose notification lands BEFORE the tool's own result.
  const foregroundBash = (id: string): ClaudeStreamMessage[] => [
    { type: "assistant", message: { id: `m-${id}`, model: "model-x", content: [{ type: "tool_use", id: `toolu_${id}`, name: "Bash", input: { command: "sleep 6" } }] } },
    { type: "system", subtype: "task_started", task_id: id, run_id: `run-${id}`, tool_use_id: `toolu_${id}`, task_type: "local_bash", is_backgrounded: false, description: "sleep" },
    { type: "system", subtype: "task_notification", task_id: id, run_id: `run-${id}`, tool_use_id: `toolu_${id}`, status: "completed", output_file: "", summary: "sleep" },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${id}`, content: "ok" }] } },
  ] as unknown as ClaudeStreamMessage[];

  it("answers a child report normally after a foreground command was tracked as a task", async () => {
    const transport = new FakeTransport({ frames: [init, ...foregroundBash("fg"), ...ownerFrames("initial")], contextUsage: { totalTokens: 1, maxTokens: 2 } });
    const engine = engineWith(transport); const adopted = vi.fn(); engine.onNativeTurn = adopted;
    try {
      await collect(engine.runTurn("launch", { signal: new AbortController().signal }));
      // The CLI does not replay a <task-notification> input and tags no origin on its result.
      for (const frame of [init, foreignAssistantFrame("report", "MOCKUP READY"), foreignResultFrame("report")]) transport.enqueue(frame);
      const accepted = vi.fn();
      const events = await collect(engine.runTurn(report, { signal: new AbortController().signal, origin: "system", onInputAccepted: accepted }));
      expect(events.filter(event => event.type === "error")).toEqual([]);
      expect(JSON.stringify(events)).toContain("MOCKUP READY");
      expect(events).toContainEqual(expect.objectContaining({ type: "loop_end", reason: "completed" }));
      expect(events.filter(event => event.type === "claude_turn_preview")).toEqual([]);
      expect(accepted).toHaveBeenCalled();
      expect(adopted).not.toHaveBeenCalled();
      // The engine stays alive for the next owner message.
      for (const frame of [init, { type: "user", isReplay: true, message: { role: "user", content: "next" } }, ...ownerFrames("next")]) transport.enqueue(frame as ClaudeStreamMessage);
      const next = await collect(engine.runTurn("next", { signal: new AbortController().signal }));
      expect(JSON.stringify(next)).toContain("OWNER OUTPUT next");
      expect(next.filter(event => event.type === "claude_turn_preview")).toEqual([]);
    } finally { await engine.dispose("session-close"); }
  });

  it("answers an unreplayed child report while a background notification is still pending", async () => {
    const start = { type: "system", subtype: "task_started", task_id: "bg", tool_use_id: "bash", task_type: "local_bash", is_backgrounded: true } as unknown as ClaudeStreamMessage;
    const transport = new FakeTransport({ frames: [start, ...ownerFrames("initial")], contextUsage: { totalTokens: 1, maxTokens: 2 } });
    const engine = engineWith(transport);
    try {
      await collect(engine.runTurn("launch", { signal: new AbortController().signal }));
      for (const frame of [{ type: "system", subtype: "task_notification", task_id: "bg", tool_use_id: "bash", status: "completed" }, init, foreignAssistantFrame("report", "MOCKUP READY"), foreignResultFrame("report")]) transport.enqueue(frame as ClaudeStreamMessage);
      const events = await collect(engine.runTurn(report, { signal: new AbortController().signal, origin: "system" }));
      expect(events.filter(event => event.type === "error")).toEqual([]);
      expect(JSON.stringify(events.filter(event => event.type !== "claude_turn_preview"))).toContain("MOCKUP READY");
      expect(events).toContainEqual(expect.objectContaining({ type: "loop_end", reason: "completed" }));
    } finally { await engine.dispose("session-close"); }
  });

  it("streams a queued owner message as soon as its echo identifies the turn", async () => {
    const start = { type: "system", subtype: "task_started", task_id: "bg", tool_use_id: "bash", task_type: "local_bash", is_backgrounded: true } as unknown as ClaudeStreamMessage;
    const transport = new FakeTransport({ frames: [start, ...ownerFrames("initial")], contextUsage: { totalTokens: 1, maxTokens: 2 } });
    const raw = engineWith(transport);
    const rows: Parameters<ConstructorParameters<typeof ClaudeShadowTranscriptEngine>[1]["record"]>[1][number][] = [];
    const shadow = new ClaudeShadowTranscriptEngine(raw, { record: (_ref, items) => { rows.push(...items); }, list: async () => rows }, "session-ref-1", []);
    const h = createHarness({ steps: [], engine: shadow });
    raw.onNativeTurn = turn => h.session.acceptClaudeNativeTurn(shadow, turn);
    raw.onDetachedEvent = event => h.session.emitDetachedSubagentEvent(event);
    try {
      h.send({ type: "ui_ready" }); await h.waitFor(m => m.type === "host_ready");
      h.send({ type: "user_message", requestId: "initial", text: "launch" });
      await h.waitUntil(() => h.received.some(m => m.type === "agent_event" && m.event.type === "loop_end"));
      // The notification arrives inside the owner's next turn, so no autonomous turn ever consumes it.
      h.send({ type: "user_message", requestId: "queued", text: "show me" });
      await h.waitUntil(() => transport.sent.length === 2);
      for (const frame of [
        { type: "system", subtype: "task_notification", task_id: "bg", tool_use_id: "bash", status: "completed" }, init,
        { type: "user", isReplay: true, message: { role: "user", content: "show me" } },
        foreignAssistantFrame("m-live", "LIVE OWNER OUTPUT"),
      ]) transport.push(frame as ClaudeStreamMessage);
      await h.waitUntil(() => h.received.some(m => m.type === "user_message_accepted" && m.requestId === "queued"));
      await h.waitUntil(() => JSON.stringify(h.received.filter(m => m.type === "agent_event" && m.event.type !== "claude_turn_preview")).includes("LIVE OWNER OUTPUT"));
      transport.push(foreignResultFrame("live"));
      await h.waitUntil(() => h.received.filter(m => m.type === "agent_event" && m.event.type === "loop_end").length === 2);
      expect(h.received.some(m => m.type === "agent_event" && m.event.type === "claude_turn_preview" && m.event.preview !== null)).toBe(false);
      expect(h.received.some(m => m.type === "agent_event" && m.event.type === "error")).toBe(false);
    } finally { await h.session.shutdown(); h.close(); }
  }, 10_000);
});

describe("Claude notification-driven turns (5370 review follow-ups)", () => {
  const init = { type: "system", subtype: "init", model: "default", permissionMode: "default", cwd: "/work", tools: [], mcp_servers: [], slash_commands: [], skills: [], capabilities: [] } as unknown as ClaudeStreamMessage;
  const report = "[SYSTEM NOTIFICATION - NOT USER INPUT]\n\n<task-notification>\n  <task-id>toolu_child</task-id>\n  <status>completed</status>\n  <summary>Mockup written.</summary>\n</task-notification>";
  const echo = (text: string, extra: Record<string, unknown> = {}) => ({ type: "user", isReplay: true, message: { role: "user", content: text }, ...extra }) as unknown as ClaudeStreamMessage;
  const backgroundBash = (id: string) => ({ type: "system", subtype: "task_started", task_id: id, run_id: `run-${id}`, tool_use_id: `toolu_${id}`, task_type: "local_bash", is_backgrounded: true }) as unknown as ClaudeStreamMessage;
  const notified = (id: string) => ({ type: "system", subtype: "task_notification", task_id: id, run_id: `run-${id}`, tool_use_id: `toolu_${id}`, status: "completed" }) as unknown as ClaudeStreamMessage;
  const tagged = (label: string, runId: string) => ({ ...foreignResultFrame(label), origin: { kind: "task-notification", producer: "session-task", runId } }) as unknown as ClaudeStreamMessage;
  const pending = (engine: ClaudeEngine) => (engine as unknown as { pendingNotifications: unknown[] }).pendingNotifications;
  /** Fails a turn that waits forever instead of hanging the suite. */
  const collectWithin = async (stream: AsyncIterable<AgentEvent>, ms = 2_000): Promise<AgentEvent[]> => {
    const events: AgentEvent[] = [];
    const done = (async () => { for await (const event of stream) events.push(event); })();
    await Promise.race([done, new Promise((_, reject) => setTimeout(() => reject(new Error(`turn did not settle: ${JSON.stringify(events.map(event => event.type))}`)), ms))]);
    return events;
  };

  it("answers a system report while a native agent's notification is still unrecognised (untagged is never autonomous)", async () => {
    const transport = new FakeTransport({ frames: ownerFrames("initial"), contextUsage: { totalTokens: 1, maxTokens: 2 } });
    const engine = engineWith(transport); const adopted = vi.fn(); engine.onNativeTurn = adopted;
    try {
      await collect(engine.runTurn("launch", { signal: new AbortController().signal }));
      for (const frame of [
        { type: "system", subtype: "task_notification", task_id: "agent", tool_use_id: "other", status: "completed" },
        init, foreignAssistantFrame("report", "REPORT ANSWER"), foreignResultFrame("report"),
      ]) transport.enqueue(frame as ClaudeStreamMessage);
      const accepted = vi.fn();
      const events = await collect(engine.runTurn(report, { signal: new AbortController().signal, origin: "system", onInputAccepted: accepted }));
      expect(JSON.stringify(events.filter(event => event.type !== "claude_turn_preview"))).toContain("REPORT ANSWER");
      expect(accepted).toHaveBeenCalled();
      expect(events.some(event => event.type === "error")).toBe(false);
      expect(events).toContainEqual(expect.objectContaining({ type: "loop_end", reason: "completed" }));
      for (const frame of [init, echo("next"), ...ownerFrames("next")]) transport.enqueue(frame);
      const next = await collect(engine.runTurn("next", { signal: new AbortController().signal }));
      expect(JSON.stringify(next)).toContain("OWNER OUTPUT next");
      expect(next).toContainEqual(expect.objectContaining({ type: "loop_end", reason: "completed" }));
    } finally { await engine.dispose("session-close"); }
  });

  it.each(["after", "before"])("streams the owner turn that follows a foreground agent (w0-20), echo %s init", async (where) => {
    const foregroundAgent = readFileSync(join(FIXTURES_DIR, "w0-20-foreground-agent.jsonl"), "utf8")
      .split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as ClaudeStreamMessage);
    const transport = new FakeTransport({ frames: foregroundAgent, contextUsage: { totalTokens: 1, maxTokens: 2 } });
    const engine = engineWith(transport); const adopted = vi.fn(); engine.onNativeTurn = adopted;
    try {
      await collect(engine.runTurn("run the agent", { signal: new AbortController().signal }));
      for (const frame of where === "after" ? [init, echo("next"), ...ownerFrames("next")] : [echo("next"), init, ...ownerFrames("next")]) transport.enqueue(frame);
      const accepted = vi.fn();
      const next = await collect(engine.runTurn("next", { signal: new AbortController().signal, onInputAccepted: accepted }));
      expect(next.filter(event => event.type === "claude_turn_preview")).toEqual([]);
      expect(JSON.stringify(next)).toContain("OWNER OUTPUT next");
      expect(next).toContainEqual(expect.objectContaining({ type: "loop_end", reason: "completed" }));
      expect(accepted).toHaveBeenCalled();
      // A child report after it is answered like any turn.
      for (const frame of [init, foreignAssistantFrame("report", "MOCKUP READY"), foreignResultFrame("report")]) transport.enqueue(frame);
      const answered = await collect(engine.runTurn(report, { signal: new AbortController().signal, origin: "system" }));
      expect(answered.filter(event => event.type === "claude_turn_preview")).toEqual([]);
      expect(answered).toContainEqual(expect.objectContaining({ type: "loop_end", reason: "completed" }));
      expect(adopted).not.toHaveBeenCalled();
    } finally { await engine.dispose("session-close"); }
  });

  it("keeps run A pending when the CLI runs run B's turn first, and adopts A's own turn later", async () => {
    const transport = new FakeTransport({ frames: [backgroundBash("a"), backgroundBash("b"), ...ownerFrames("initial")], contextUsage: { totalTokens: 1, maxTokens: 2 } });
    const engine = engineWith(transport); const native: Promise<AgentEvent[]>[] = []; engine.onNativeTurn = turn => native.push(collect(turn));
    try {
      await collect(engine.runTurn("launch", { signal: new AbortController().signal }));
      for (const frame of [notified("a"), notified("b"), init, foreignAssistantFrame("native-b", "NATIVE B"), tagged("native-b", "run-b")]) transport.push(frame);
      await vi.waitFor(() => expect(native).toHaveLength(1));
      expect(JSON.stringify(await native[0]!)).toContain("NATIVE B");
      expect(pending(engine)).toEqual([expect.objectContaining({ taskId: "a", runId: "run-a" })]);
      for (const frame of [init, foreignAssistantFrame("native-a", "NATIVE A"), tagged("native-a", "run-a")]) transport.push(frame);
      await vi.waitFor(() => expect(native).toHaveLength(2));
      expect(JSON.stringify(await native[1]!)).toContain("NATIVE A");
      expect(pending(engine)).toEqual([]);
      for (const frame of [init, ...ownerFrames("next")]) transport.enqueue(frame);
      const next = await collect(engine.runTurn("next", { signal: new AbortController().signal }));
      expect(next.some(event => event.type === "error")).toBe(false);
      expect(next).toContainEqual(expect.objectContaining({ type: "loop_end", reason: "completed" }));
    } finally { await engine.dispose("session-close"); }
  });

  it("consumes a notification the CLI replays into an owner turn", async () => {
    const transport = new FakeTransport({ frames: [backgroundBash("a"), ...ownerFrames("initial")], contextUsage: { totalTokens: 1, maxTokens: 2 } });
    const engine = engineWith(transport);
    try {
      await collect(engine.runTurn("launch", { signal: new AbortController().signal }));
      for (const frame of [init, echo("go"), assistantFrame("work"), notified("a"), echo("<task-notification>done</task-notification>", { origin: { kind: "task-notification", runId: "run-a" } }), ...ownerFrames("go")]) transport.enqueue(frame);
      const events = await collect(engine.runTurn("go", { signal: new AbortController().signal }));
      expect(events).toContainEqual(expect.objectContaining({ type: "loop_end", reason: "completed" }));
      expect(pending(engine)).toEqual([]);
    } finally { await engine.dispose("session-close"); }
  });

  it("forgets pending notifications when the transport ends while idle", async () => {
    const transport = new FakeTransport({ frames: [backgroundBash("a"), ...ownerFrames("initial")], contextUsage: { totalTokens: 1, maxTokens: 2 } });
    const engine = engineWith(transport);
    try {
      await collect(engine.runTurn("launch", { signal: new AbortController().signal }));
      transport.push(notified("a"));
      await vi.waitFor(() => expect(pending(engine)).toHaveLength(1));
      await transport.close();
      await vi.waitFor(() => expect(pending(engine)).toEqual([]));
    } finally { await engine.dispose("session-close"); }
  });

  it("answers an owner input the CLI folds into a turn it started for a notification (init, background frames, echo, tagged result)", async () => {
    const transport = new FakeTransport({ frames: [backgroundBash("a"), ...ownerFrames("initial")], contextUsage: { totalTokens: 1, maxTokens: 2 } });
    const engine = engineWith(transport); const adopted = vi.fn(); engine.onNativeTurn = adopted;
    try {
      await collect(engine.runTurn("launch", { signal: new AbortController().signal }));
      for (const frame of [notified("a"), init, foreignAssistantFrame("bg", "BACKGROUND PART"), echo("ping"), foreignAssistantFrame("owner", "PONG"), tagged("folded", "run-a")]) transport.enqueue(frame);
      const accepted = vi.fn();
      const events = await collectWithin(engine.runTurn("ping", { signal: new AbortController().signal, onInputAccepted: accepted }));
      expect(JSON.stringify(events)).toContain("PONG");
      expect(events).toContainEqual(expect.objectContaining({ type: "loop_end", reason: "completed" }));
      expect(events.some(event => event.type === "error")).toBe(false);
      expect(accepted).toHaveBeenCalled();
      expect(adopted).not.toHaveBeenCalled();
      expect(pending(engine)).toEqual([]);
    } finally { await engine.dispose("session-close"); }
  });

  it("answers an owner input folded into an autonomous turn whose init arrived before the send (live CLI 2.1.330 order)", async () => {
    const transport = new FakeTransport({ frames: [backgroundBash("a"), ...ownerFrames("initial")], contextUsage: { totalTokens: 1, maxTokens: 2 } });
    const engine = engineWith(transport); const adopted = vi.fn(); engine.onNativeTurn = adopted;
    try {
      await collect(engine.runTurn("launch", { signal: new AbortController().signal }));
      transport.push(notified("a")); transport.push(init);
      await vi.waitFor(() => expect(pending(engine)).toEqual([]));
      for (const frame of [foreignAssistantFrame("bg", "BACKGROUND PART"), userToolResultFrame("sleep"), echo("ping"), foreignAssistantFrame("owner", "PONG"), tagged("folded", "run-a")]) transport.enqueue(frame);
      const events = await collectWithin(engine.runTurn("ping", { signal: new AbortController().signal }));
      expect(JSON.stringify(events)).toContain("PONG");
      expect(events).toContainEqual(expect.objectContaining({ type: "loop_end", reason: "completed" }));
      expect(adopted).not.toHaveBeenCalled();
    } finally { await engine.dispose("session-close"); }
  });

  it("does not read a turn origin off the owner's echo", async () => {
    const transport = new FakeTransport({ frames: [backgroundBash("a"), ...ownerFrames("initial")], contextUsage: { totalTokens: 1, maxTokens: 2 } });
    const engine = engineWith(transport);
    try {
      await collect(engine.runTurn("launch", { signal: new AbortController().signal }));
      for (const frame of [notified("a"), init, echo("hi", { origin: { kind: "human" } }), ...ownerFrames("hi")]) transport.enqueue(frame);
      const events = await collect(engine.runTurn("hi", { signal: new AbortController().signal }));
      expect(events.some(event => event.type === "error")).toBe(false);
      expect(JSON.stringify(events)).toContain("OWNER OUTPUT hi");
      expect(events).toContainEqual(expect.objectContaining({ type: "loop_end", reason: "completed" }));
    } finally { await engine.dispose("session-close"); }
  });

  it("relies on autonomous results being tagged with their notification run (w0-19 evidence)", () => {
    const frames = readFileSync(join(FIXTURES_DIR, "w0-19-background-agent.jsonl"), "utf8")
      .split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as Record<string, unknown>);
    const results = frames.filter(frame => frame.type === "result");
    const notification = frames.find(frame => frame.subtype === "task_notification")!;
    // The owner turn's result is untagged; the autonomous turn's names the notification run.
    expect(results[0]!.origin).toBeUndefined();
    expect(results[1]!.origin).toEqual({ kind: "task-notification", producer: "session-task", runId: notification.run_id });
  });

  it.each(["moved by task_updated", "still foreground when its tool_result came first"])("classifies a foreground command %s", async (scenario) => {
    const moved = scenario.startsWith("moved");
    const frames = [
      { type: "assistant", message: { id: "m-fg", model: "model-x", content: [{ type: "tool_use", id: "toolu_fg", name: "Bash", input: { command: "sleep 6" } }] } },
      { type: "system", subtype: "task_started", task_id: "fg", run_id: "run-fg", tool_use_id: "toolu_fg", task_type: "local_bash", is_backgrounded: false },
      ...(moved ? [{ type: "system", subtype: "task_updated", task_id: "fg", patch: { is_backgrounded: true } }] : []),
      { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_fg", content: "ok" }] } },
      ...(moved ? [] : [{ type: "system", subtype: "task_notification", task_id: "fg", run_id: "run-fg", tool_use_id: "toolu_fg", status: "completed" }]),
      ...ownerFrames("initial"),
    ] as unknown as ClaudeStreamMessage[];
    const transport = new FakeTransport({ frames, contextUsage: { totalTokens: 1, maxTokens: 2 } });
    const engine = engineWith(transport); const native: Promise<AgentEvent[]>[] = []; engine.onNativeTurn = turn => native.push(collect(turn));
    try {
      await collect(engine.runTurn("launch", { signal: new AbortController().signal }));
      if (moved) {
        for (const frame of [{ type: "system", subtype: "task_notification", task_id: "fg", run_id: "run-fg", tool_use_id: "toolu_fg", status: "completed" }, init, foreignAssistantFrame("native", "NATIVE FG"), tagged("native", "run-fg")]) transport.push(frame as ClaudeStreamMessage);
        await vi.waitFor(() => expect(native).toHaveLength(1));
        expect(JSON.stringify(await native[0]!)).toContain("NATIVE FG");
      } else {
        expect(pending(engine)).toEqual([]);
      }
      for (const frame of [init, ...ownerFrames("next")]) transport.enqueue(frame);
      const next = await collect(engine.runTurn("next", { signal: new AbortController().signal }));
      expect(next.some(event => event.type === "error")).toBe(false);
      expect(next).toContainEqual(expect.objectContaining({ type: "loop_end", reason: "completed" }));
    } finally { await engine.dispose("session-close"); }
  });

  it("hands an oversized candidate to the idle classifier instead of failing the engine", async () => {
    const transport = new FakeTransport({ frames: [backgroundBash("a"), ...ownerFrames("initial")], contextUsage: { totalTokens: 1, maxTokens: 2 } });
    const engine = engineWith(transport);
    try {
      await collect(engine.runTurn("launch", { signal: new AbortController().signal }));
      const flood = Array.from({ length: 20_001 }, () => ({ type: "rate_limit_event" }) as unknown as ClaudeStreamMessage);
      for (const frame of [notified("a"), init, ...flood, foreignAssistantFrame("native", "NATIVE"), tagged("native", "run-a"), init, ...ownerFrames("after")]) transport.enqueue(frame);
      const events = await collectWithin(engine.runTurn("after", { signal: new AbortController().signal }), 10_000);
      expect(events.some(event => event.type === "error")).toBe(false);
      expect(JSON.stringify(events)).toContain("OWNER OUTPUT after");
      expect(JSON.stringify(events)).not.toContain("NATIVE");
      expect(events).toContainEqual(expect.objectContaining({ type: "loop_end", reason: "completed" }));
    } finally { await engine.dispose("session-close"); }
  }, 20_000);
  it.each(["silence", "rate-limit and task-status noise, then silence"])("ends a report folded into an autonomous turn once the CLI goes quiet (%s), without killing the engine", async (scenario) => {
    const transport = new FakeTransport({ frames: [backgroundBash("a"), ...ownerFrames("initial")], contextUsage: { totalTokens: 1, maxTokens: 2 } });
    const after = new FakeTransport({ frames: [init, echo("next"), ...ownerFrames("next")], contextUsage: { totalTokens: 1, maxTokens: 2 } });
    const engine = engineWith(transport, { timeouts: { unconfirmedInputQuietMs: 50 }, next: [after] }); engine.onNativeTurn = turn => { void collect(turn); };
    try {
      await collect(engine.runTurn("launch", { signal: new AbortController().signal }));
      // The CLI takes the report into the turn it runs for run a: no echo, a tagged result, then no turn of its own.
      const noise = scenario === "silence" ? [] : [
        { type: "rate_limit_event", rate_limit_info: { status: "allowed" } },
        { type: "system", subtype: "task_progress", task_id: "other", description: "still running" },
      ];
      for (const frame of [notified("a"), init, foreignAssistantFrame("folded", "FOLDED ANSWER"), tagged("folded", "run-a"), ...noise]) transport.enqueue(frame as ClaudeStreamMessage);
      const accepted = vi.fn();
      const events = await collectWithin(engine.runTurn(report, { signal: new AbortController().signal, origin: "system", onInputAccepted: accepted }));
      expect(events.some(event => event.type === "error")).toBe(false);
      expect(events).toContainEqual(expect.objectContaining({ type: "engine_notice", level: "warning" }));
      expect(events).toContainEqual(expect.objectContaining({ type: "loop_end", reason: "cancelled" }));
      expect(accepted).not.toHaveBeenCalled();
      const next = await collectWithin(engine.runTurn("next", { signal: new AbortController().signal }));
      expect(next).toContainEqual(expect.objectContaining({ type: "loop_end", reason: "completed" }));
      expect(after.sent).toEqual(["next"]);
    } finally { await engine.dispose("session-close"); }
  });

  it("retires the process after an unconfirmed report, so its late answer cannot attach to the next input", async () => {
    const transport = new FakeTransport({ frames: [backgroundBash("a"), ...ownerFrames("initial")], contextUsage: { totalTokens: 1, maxTokens: 2 } });
    const after = new FakeTransport({ contextUsage: { totalTokens: 1, maxTokens: 2 } });
    const engine = engineWith(transport, { timeouts: { unconfirmedInputQuietMs: 20 }, next: [after] }); engine.onNativeTurn = turn => { void collect(turn); };
    try {
      await collect(engine.runTurn("launch", { signal: new AbortController().signal }));
      for (const frame of [notified("a"), init, foreignAssistantFrame("odd", "ODD OUTPUT"), { ...foreignResultFrame("odd"), origin: { kind: "unknown-producer" } }]) transport.enqueue(frame as ClaudeStreamMessage);
      const first = await collectWithin(engine.runTurn(report, { signal: new AbortController().signal, origin: "system" }));
      expect(first).toContainEqual(expect.objectContaining({ type: "loop_end", reason: "cancelled" }));
      const sentBefore = transport.sent.length;
      const run = collectWithin(engine.runTurn("next", { signal: new AbortController().signal }));
      await vi.waitFor(() => expect(after.sent).toEqual(["next"]));
      // Well past any quiet window, the old process starts the report's real answer.
      await new Promise(resolve => setTimeout(resolve, 60));
      for (const frame of [init, foreignAssistantFrame("late", "LATE REPORT ANSWER"), foreignResultFrame("late")]) transport.push(frame);
      for (const frame of [init, echo("next"), ...ownerFrames("next")]) after.push(frame);
      const next = await run;
      expect(transport.closed).toBeGreaterThan(0);
      expect(transport.sent).toHaveLength(sentBefore);
      expect(JSON.stringify(next)).not.toContain("LATE REPORT ANSWER");
      expect(JSON.stringify(next)).toContain("OWNER OUTPUT next");
      expect(next).toContainEqual(expect.objectContaining({ type: "loop_end", reason: "completed" }));
    } finally { await engine.dispose("session-close"); }
  });

  it.each(["an unanswered permission prompt", "a quota read still in flight"])("retires the old process at once despite %s, discarding its later frames", async (scenario) => {
    const transport = new FakeTransport({ frames: [backgroundBash("a"), ...ownerFrames("initial")], contextUsage: { totalTokens: 1, maxTokens: 2 } });
    const after = new FakeTransport({ contextUsage: { totalTokens: 1, maxTokens: 2 } });
    const engine = engineWith(transport, { timeouts: { unconfirmedInputQuietMs: 20 }, next: [after] }); engine.onNativeTurn = turn => { void collect(turn); };
    try {
      await collect(engine.runTurn("launch", { signal: new AbortController().signal }));
      for (const frame of [notified("a"), init, foreignAssistantFrame("odd", "ODD OUTPUT"), { ...foreignResultFrame("odd"), origin: { kind: "unknown-producer" } }]) transport.enqueue(frame as ClaudeStreamMessage);
      const first = await collectWithin(engine.runTurn(report, { signal: new AbortController().signal, origin: "system" }));
      expect(first).toContainEqual(expect.objectContaining({ type: "loop_end", reason: "cancelled" }));
      // The old process holds a request open: a permission prompt nobody
      // answers stays pending forever; a quota read settles only later.
      let busy = true;
      Object.defineProperty(transport, "hasPendingRequests", { get: () => busy && transport.closed === 0 });
      if (scenario === "a quota read still in flight") setTimeout(() => { busy = false; }, 150);
      const run = collectWithin(engine.runTurn("next", { signal: new AbortController().signal }));
      // While the request is open, the old process starts another turn.
      await new Promise(resolve => setTimeout(resolve, 20));
      for (const frame of [init, foreignAssistantFrame("late", "LATE OUTPUT")]) transport.push(frame);
      await vi.waitFor(() => expect(after.sent).toEqual(["next"]), { timeout: 1000 });
      for (const frame of [init, echo("next"), ...ownerFrames("next")]) after.push(frame);
      const next = await run;
      expect(transport.closed).toBeGreaterThan(0);
      expect(JSON.stringify(next)).not.toContain("LATE OUTPUT");
      expect(JSON.stringify(next)).toContain("OWNER OUTPUT next");
      expect(next).toContainEqual(expect.objectContaining({ type: "loop_end", reason: "completed" }));
    } finally { await engine.dispose("session-close"); }
  });

  it("gives a slow-exiting old process its own teardown budget before the new handshake clock starts", async () => {
    const transport = new FakeTransport({ frames: [backgroundBash("a"), ...ownerFrames("initial")], contextUsage: { totalTokens: 1, maxTokens: 2 } });
    const after = new FakeTransport({ contextUsage: { totalTokens: 1, maxTokens: 2 } });
    const engine = engineWith(transport, { timeouts: { unconfirmedInputQuietMs: 20 }, next: [after] }); engine.onNativeTurn = turn => { void collect(turn); };
    try {
      await collect(engine.runTurn("launch", { signal: new AbortController().signal }));
      for (const frame of [notified("a"), init, foreignAssistantFrame("odd", "ODD OUTPUT"), { ...foreignResultFrame("odd"), origin: { kind: "unknown-producer" } }]) transport.enqueue(frame as ClaudeStreamMessage);
      await collectWithin(engine.runTurn(report, { signal: new AbortController().signal, origin: "system" }));
      // A busy CLI that ignores stdin EOF: the real client escalates to
      // SIGTERM only after 6s, past the 5s handshake timeout.
      const close = transport.close.bind(transport);
      transport.close = async () => { await new Promise(resolve => setTimeout(resolve, CLAUDE_INIT_HANDSHAKE_TIMEOUT_MS + 300)); await close(); };
      for (const frame of [init, echo("next"), ...ownerFrames("next")]) after.enqueue(frame);
      const next = await collectWithin(engine.runTurn("next", { signal: new AbortController().signal }), CLAUDE_INIT_HANDSHAKE_TIMEOUT_MS + 3_000);
      expect(after.sent).toEqual(["next"]);
      expect(JSON.stringify(next)).toContain("OWNER OUTPUT next");
      expect(next).toContainEqual(expect.objectContaining({ type: "loop_end", reason: "completed" }));
    } finally { await engine.dispose("session-close"); }
  }, 15_000);

  it("fails the swap without spawning when the old process never finishes its teardown", async () => {
    const transport = new FakeTransport({ contextUsage: { totalTokens: 1, maxTokens: 2 } });
    const next = [new FakeTransport()];
    const engine = engineWith(transport, { next });
    transport.close = () => new Promise<void>(() => {});
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const swap = engine.replaceTransport({ sessionId: engine.sessionRef }).then(() => null, (error: unknown) => error);
      await vi.advanceTimersByTimeAsync(CLAUDE_TEARDOWN_TOTAL_BUDGET_MS + 2_000);
      expect(await swap).toBeInstanceOf(Error);
      expect(next).toHaveLength(1);
    } finally { vi.useRealTimers(); void engine.dispose("session-close"); }
  });

  it("does not drop a pending notification when absorbing an unattributable turn", async () => {
    const transport = new FakeTransport({ frames: [backgroundBash("a"), ...ownerFrames("initial")], contextUsage: { totalTokens: 1, maxTokens: 2 } });
    const engine = engineWith(transport, { timeouts: { unconfirmedInputQuietMs: 20 } });
    try {
      await collect(engine.runTurn("launch", { signal: new AbortController().signal }));
      for (const frame of [notified("a"), init, foreignAssistantFrame("odd", "ODD"), { ...foreignResultFrame("odd"), origin: { kind: "unknown-producer" } }]) transport.enqueue(frame as ClaudeStreamMessage);
      await collectWithin(engine.runTurn(report, { signal: new AbortController().signal, origin: "system" }));
      expect(pending(engine)).toEqual([expect.objectContaining({ taskId: "a", runId: "run-a" })]);
    } finally { await engine.dispose("session-close"); }
  });

  it("counts a notification replay inside a candidate once", async () => {
    const plain = (id: string) => ({ type: "system", subtype: "task_notification", task_id: id, tool_use_id: `toolu_${id}`, status: "completed" }) as unknown as ClaudeStreamMessage;
    const bashNoRun = (id: string) => ({ type: "system", subtype: "task_started", task_id: id, tool_use_id: `toolu_${id}`, task_type: "local_bash", is_backgrounded: true }) as unknown as ClaudeStreamMessage;
    const transport = new FakeTransport({ frames: [bashNoRun("a"), backgroundBash("b"), backgroundBash("c"), ...ownerFrames("initial")], contextUsage: { totalTokens: 1, maxTokens: 2 } });
    const engine = engineWith(transport); engine.onNativeTurn = turn => { void collect(turn); };
    try {
      await collect(engine.runTurn("launch", { signal: new AbortController().signal }));
      for (const frame of [plain("a"), notified("b"), notified("c")]) transport.push(frame);
      await vi.waitFor(() => expect(pending(engine)).toHaveLength(3));
      for (const frame of [init, echo("<task-notification>a</task-notification>", { origin: { kind: "task-notification" } }), foreignAssistantFrame("native-c", "NATIVE C"), tagged("native-c", "run-c"), init, echo("go"), ...ownerFrames("go")]) transport.enqueue(frame);
      await collectWithin(engine.runTurn("go", { signal: new AbortController().signal }));
      expect(pending(engine)).toEqual([expect.objectContaining({ taskId: "b", runId: "run-b" })]);
    } finally { await engine.dispose("session-close"); }
  });
});
