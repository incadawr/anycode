/**
 * Translator tests driven by the COMMITTED W0 FIXTURES, not hand-written
 * objects (cut §1.4 DoD-8): one assert-form per row of the §1.4 translation
 * table. A hand-authored input can only ever prove the translator agrees with
 * this file's own idea of the wire; replaying the captured bytes proves it
 * agrees with the CLI.
 *
 * Fixtures live beside the pinned contract (contract/fixtures/) — the same
 * copies the drift gate sweeps.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@anycode/core";
import { ClaudeTurnTranslator } from "./event-translator.js";
import type { ClaudeResultMessage, ClaudeStreamMessage, ClaudeSystemInitMessage } from "./protocol.js";

const FIXTURES_DIR = join(new URL(".", import.meta.url).pathname, "contract", "fixtures");

/** Inbound (CLI -> host) stream frames of one fixture, in wire order. Envelope fixtures unwrap `raw` for `dir:"out"`; bare fixtures ARE the wire bytes. */
function streamFrames(file: string): ClaudeStreamMessage[] {
  const lines = readFileSync(join(FIXTURES_DIR, file), "utf8").split("\n").filter((line) => line.trim() !== "");
  const frames: unknown[] = [];
  for (const line of lines) {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if ("raw" in parsed && "dir" in parsed) {
      // "out" = the CLI's stdout, i.e. what a translator ever sees.
      if (parsed.dir === "out") frames.push(parsed.raw);
      continue;
    }
    frames.push(parsed);
  }
  return frames.filter((frame): frame is ClaudeStreamMessage => {
    const type = (frame as { type?: unknown } | null)?.type;
    return typeof type === "string" && !type.startsWith("control_");
  });
}

/** Replays every stream frame of a fixture through ONE translator and returns the flattened event stream. */
function translate(file: string, options?: { onInit?(init: ClaudeSystemInitMessage): void; onResult?(result: ClaudeResultMessage): void }): AgentEvent[] {
  const translator = new ClaudeTurnTranslator({ turn: 1, ...options });
  return streamFrames(file).flatMap((frame) => translator.onMessage(frame));
}

/**
 * Several W0 fixtures capture MULTI-TURN sessions (one process, many turns —
 * probe #1). A translator is turn-scoped by contract, so replaying such a
 * fixture the way the engine actually drives it means starting a fresh
 * translator after every terminal `result`. Returns the concatenated stream.
 */
function translateAllTurns(
  file: string,
  options?: { onInit?(init: ClaudeSystemInitMessage): void; onResult?(result: ClaudeResultMessage): void },
): AgentEvent[] {
  const events: AgentEvent[] = [];
  let turn = 1;
  let translator = new ClaudeTurnTranslator({ turn, ...options });
  for (const frame of streamFrames(file)) {
    events.push(...translator.onMessage(frame));
    if (frame.type === "result") {
      turn += 1;
      translator = new ClaudeTurnTranslator({ turn, ...options });
    }
  }
  return events;
}

function ofType<T extends AgentEvent["type"]>(events: AgentEvent[], type: T): Extract<AgentEvent, { type: T }>[] {
  return events.filter((event): event is Extract<AgentEvent, { type: T }> => event.type === type);
}

describe("ClaudeTurnTranslator — translation table on W0 fixtures (cut §1.4 DoD-8)", () => {
  it("row: assistant.tool_use -> BOTH tool_call AND tool_execution_start (W17 discriminator)", () => {
    const events = translate("w0-02-control-writeprobe.jsonl");
    const calls = ofType(events, "tool_call");
    const starts = ofType(events, "tool_execution_start");
    // The live fixture's single Write tool_use.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.toolCall).toMatchObject({
      id: "toolu_0146u56HDRZG2Nd3qz7tv67b",
      name: "Write",
      input: { file_path: "/tmp/w0-cc-writeprobe.txt", content: "OK" },
    });
    // W17: a tool_execution_start WITHOUT its tool_call renders no card at all.
    expect(starts).toHaveLength(1);
    expect(starts[0]!.toolCallId).toBe(calls[0]!.toolCall.id);
    expect(events.indexOf(calls[0]!)).toBeLessThan(events.indexOf(starts[0]!));
  });

  it("row: user.tool_result -> tool_result, correlated by tool_use_id, outcome from is_error", () => {
    const events = translate("w0-02-control-writeprobe.jsonl");
    const results = ofType(events, "tool_result");
    expect(results).toHaveLength(1);
    expect(results[0]!.outcome).toMatchObject({
      toolCallId: "toolu_0146u56HDRZG2Nd3qz7tv67b",
      // Correlation is what supplies the name: the tool_result block itself carries none.
      toolName: "Write",
      status: "success",
    });
    expect(results[0]!.outcome.modelText).toContain("File created successfully");
  });

  it("row: stream_event content_block_start/delta/stop(text) -> text_start/text_delta/text_end with `${message.id}:${index}` ids", () => {
    const events = translate("w0-01-persistence.jsonl");
    const starts = ofType(events, "text_start");
    const deltas = ofType(events, "text_delta");
    const ends = ofType(events, "text_end");
    expect(starts.length).toBeGreaterThan(0);
    expect(deltas.length).toBeGreaterThan(0);
    // Every open block is closed.
    expect(ends.length).toBe(starts.length);
    expect(starts[0]!.id).toMatch(/^msg_[A-Za-z0-9]+:\d+$/);
    // Deltas patch a block that was actually opened (store.ts drops otherwise).
    for (const delta of deltas) expect(starts.some((start) => start.id === delta.id)).toBe(true);
  });

  it("row: stream_event thinking_delta -> reasoning events (store.ts renders them engine-agnostically)", () => {
    const events = translate("w0-02-control-writeprobe.jsonl");
    const reasoningStarts = ofType(events, "reasoning_start");
    const reasoningEnds = ofType(events, "reasoning_end");
    expect(reasoningStarts.length).toBeGreaterThan(0);
    expect(reasoningEnds.length).toBe(reasoningStarts.length);
  });

  it("hazard (з): text is NOT doubled — the final assistant frame's text block is dropped when the same message already streamed deltas", () => {
    const events = translate("w0-01-persistence.jsonl");
    // If the fallback fired alongside the deltas, the same message id would
    // produce both `msg_x:N` and `msg_x:fallback` starts.
    const fallbackStarts = ofType(events, "text_start").filter((event) => event.id.endsWith(":fallback"));
    expect(fallbackStarts).toEqual([]);
  });

  it("fallback path: an assistant text block with no streamed deltas DOES project text events", () => {
    const translator = new ClaudeTurnTranslator({ turn: 1 });
    const events = translator.onMessage({
      type: "assistant",
      message: { id: "msg_nostream", model: "claude-opus-4-8", content: [{ type: "text", text: "hello" }] },
    } as unknown as ClaudeStreamMessage);
    expect(events.map((event) => event.type)).toEqual(["text_start", "text_delta", "text_end"]);
  });

  it("row: system/init is engine STATE, not an event — re-emitted on EVERY turn (probe #1), silently", () => {
    const inits: ClaudeSystemInitMessage[] = [];
    // Driven the way the engine drives it: a fresh translator per turn.
    const events = translateAllTurns("w0-01-persistence.jsonl", { onInit: (init) => inits.push(init) });
    // This fixture runs two turns in ONE process — hence two inits, same session.
    expect(inits.length).toBeGreaterThan(1);
    expect(inits[0]!.session_id).toBeTruthy();
    expect(inits[1]!.session_id).toBe(inits[0]!.session_id);
    expect(inits[0]!.capabilities).toContain("interrupt_receipt_v1");
    // No init ever produced a user-visible event.
    expect(events.some((event) => event.type === "engine_notice")).toBe(false);
  });

  it("a repeated system/init inside ONE turn refreshes state without emitting anything", () => {
    const inits: ClaudeSystemInitMessage[] = [];
    const translator = new ClaudeTurnTranslator({ turn: 1, onInit: (init) => inits.push(init) });
    const init = {
      type: "system",
      subtype: "init",
      session_id: "s-1",
      model: "claude-opus-4-8",
      permissionMode: "default",
      capabilities: ["interrupt_receipt_v1"],
    } as unknown as ClaudeStreamMessage;
    expect(translator.onMessage(init)).toEqual([]);
    expect(translator.onMessage(init)).toEqual([]);
    expect(inits).toHaveLength(2);
  });

  it("row: system/permission_denied -> engine_notice built from the FRAME's fields, never parsed out of tool_result prose", () => {
    // Multi-turn fixture: the dontAsk auto-denials happen on its later turns.
    const events = translateAllTurns("w0-08-permmodes.jsonl");
    const notices = ofType(events, "engine_notice").filter((event) => event.message.includes("denied permission"));
    expect(notices.length).toBeGreaterThan(0);
    // tool_name comes from the structured frame.
    expect(notices.some((notice) => notice.message.includes("Write") || notice.message.includes("Bash"))).toBe(true);
  });

  it("row: rate_limit_event with status \"allowed\" is silent (it rides every ordinary turn)", () => {
    const events = translate("w0-02-control-writeprobe.jsonl");
    expect(ofType(events, "engine_notice").filter((event) => event.message.includes("rate limit"))).toEqual([]);
  });

  it("row: rate_limit_event with a non-allowed status -> engine_notice; credits_required reads as the honest limit-exhausted form (R-W0-4)", () => {
    const translator = new ClaudeTurnTranslator({ turn: 1 });
    const events = translator.onMessage({
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", errorCode: "credits_required" },
    } as unknown as ClaudeStreamMessage);
    expect(events).toEqual([
      { type: "engine_notice", level: "warning", message: "Claude usage limit reached — usage credits are required to continue." },
    ]);
  });

  it("row: result -> turn_end + loop_end, ALWAYS last and in that order", () => {
    const results: ClaudeResultMessage[] = [];
    const events = translate("w0-02-control-writeprobe.jsonl", { onResult: (result) => results.push(result) });
    const tail = events.slice(-2);
    expect(tail.map((event) => event.type)).toEqual(["turn_end", "loop_end"]);
    expect(tail[0]).toMatchObject({ type: "turn_end", turn: 1, finishReason: "stop" });
    expect(tail[1]).toMatchObject({ type: "loop_end", reason: "completed", turns: 1 });
    // The result frame is handed to the engine for cost accounting + the
    // post-result get_context_usage pull — never summed into a ctx meter here.
    expect(results).toHaveLength(1);
    expect(results[0]!.total_cost_usd).toBeGreaterThan(0);
    expect(events.some((event) => event.type === "context_usage")).toBe(false);
  });

  it("row: an interrupted turn's result (terminal_reason aborted_streaming) -> loop_end:cancelled, not an error", () => {
    const events = translate("w0-03-interrupt-pending.jsonl");
    const loopEnds = ofType(events, "loop_end");
    expect(loopEnds).toHaveLength(1);
    expect(loopEnds[0]!.reason).toBe("cancelled");
    expect(ofType(events, "turn_end")[0]!.finishReason).toBe("other");
  });

  it("hazard (и): the phantom `<local-command-stdout>` user frame after a successful set_model is DROPPED", () => {
    const events = translate("w0-16-setmodel.jsonl");
    // A phantom reply would surface as transcript content; nothing in this
    // fixture's user frames may project any event.
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("local-command-stdout");
    expect(serialized).not.toContain("Set model to");
  });

  it("row: `--replay-user-messages` echoes (isReplay:true) project nothing", () => {
    const translator = new ClaudeTurnTranslator({ turn: 1 });
    const echo = translator.onMessage({
      type: "user",
      isReplay: true,
      uuid: "u-1",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t-1", content: "x" }] },
    } as unknown as ClaudeStreamMessage);
    expect(echo).toEqual([]);
  });

  it("row: duplicate user frames are deduped by uuid", () => {
    const translator = new ClaudeTurnTranslator({ turn: 1 });
    const frame = {
      type: "user",
      uuid: "u-dup",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t-1", content: "done" }] },
    } as unknown as ClaudeStreamMessage;
    expect(translator.onMessage(frame)).toHaveLength(1);
    expect(translator.onMessage(frame)).toEqual([]);
  });

  it("row: messages with parent_tool_use_id != null are dropped, while the ROOT Task tool's own frames survive (hazard (ж))", () => {
    const translator = new ClaudeTurnTranslator({ turn: 1 });
    // Root Task tool_use — parent_tool_use_id null: MUST project.
    const root = translator.onMessage({
      type: "assistant",
      parent_tool_use_id: null,
      message: { id: "msg_root", model: "m", content: [{ type: "tool_use", id: "toolu_task", name: "Task", input: {} }] },
    } as unknown as ClaudeStreamMessage);
    expect(root.map((event) => event.type)).toEqual(["tool_call", "tool_execution_start"]);
    // Subagent-internal frame — MUST fold away.
    const child = translator.onMessage({
      type: "assistant",
      parent_tool_use_id: "toolu_task",
      message: { id: "msg_child", model: "m", content: [{ type: "tool_use", id: "toolu_child", name: "Bash", input: {} }] },
    } as unknown as ClaudeStreamMessage);
    expect(child).toEqual([]);
    // The ROOT Task's tool_result still correlates.
    const rootResult = translator.onMessage({
      type: "user",
      parent_tool_use_id: null,
      uuid: "u-root",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_task", content: "subagent done" }] },
    } as unknown as ClaudeStreamMessage);
    expect(rootResult).toHaveLength(1);
    expect((rootResult[0] as Extract<AgentEvent, { type: "tool_result" }>).outcome.toolName).toBe("Task");
  });

  it("the signed-out trap: assistant.error terminalizes honestly even though result claims subtype:\"success\" (probe #12)", () => {
    // w0-07 is the live capture of a spawn against an isolated (unauthenticated)
    // CLAUDE_CONFIG_DIR: `assistant.error:"authentication_failed"` arrives, and
    // the terminal frame then claims `subtype:"success"` WITH `is_error:true`.
    // Trusting `subtype` alone would report this failed turn as a clean success.
    const events = translate("w0-07-verify1-configdir-probe.jsonl");
    const errors = ofType(events, "error");
    expect(errors).toHaveLength(1);
    expect((errors[0]!.error as Error).message).toContain("not signed in");
    // Exactly one terminal error, and the turn still closes properly.
    expect(ofType(events, "loop_end")).toHaveLength(1);
  });
});

describe("ClaudeTurnTranslator — finish() guarantees (codex TurnTranslator parity)", () => {
  it("finishTerminal closes open text blocks and cancels dangling tools, then turn_end + loop_end", () => {
    const translator = new ClaudeTurnTranslator({ turn: 3 });
    translator.onMessage({
      type: "stream_event",
      event: { type: "message_start", message: { id: "msg_x" } },
    } as unknown as ClaudeStreamMessage);
    translator.onMessage({
      type: "stream_event",
      event: { type: "content_block_start", index: 0, content_block: { type: "text" } },
    } as unknown as ClaudeStreamMessage);
    translator.onMessage({
      type: "assistant",
      message: { id: "msg_x", model: "m", content: [{ type: "tool_use", id: "toolu_open", name: "Bash", input: {} }] },
    } as unknown as ClaudeStreamMessage);

    const events = translator.finishTerminal("cancelled");
    expect(events.map((event) => event.type)).toEqual(["text_end", "tool_result", "turn_end", "loop_end"]);
    const outcome = (events[1] as Extract<AgentEvent, { type: "tool_result" }>).outcome;
    expect(outcome).toMatchObject({ toolCallId: "toolu_open", toolName: "Bash", status: "cancelled" });
    expect(events[3]).toMatchObject({ type: "loop_end", reason: "cancelled", turns: 3 });
  });

  it("a second terminal frame is a no-op — a doubled `result` never double-reports (CC-B hazard (г))", () => {
    const translator = new ClaudeTurnTranslator({ turn: 1 });
    const result = { type: "result", subtype: "success", is_error: false, num_turns: 1, duration_ms: 1, duration_api_ms: 1, total_cost_usd: 0 } as unknown as ClaudeStreamMessage;
    expect(translator.onMessage(result).map((event) => event.type)).toEqual(["turn_end", "loop_end"]);
    expect(translator.onMessage(result)).toEqual([]);
    expect(translator.finishTerminal("error")).toEqual([]);
  });
});

describe("ClaudeTurnTranslator — resume dedup (SLICE-CC D-min, cut §1.5 DoD-3)", () => {
  /**
   * `--resume` never re-emits history on the wire (probe #4): part2 carries
   * only a fresh `system/init` + the `--replay-user-messages` echo of the
   * NEW input + a normal new turn — nothing from turn1. So the only dedup
   * unit CC-D needs is that the echo of the new input (`isReplay:true`,
   * `w0-16-setmodel.jsonl` hazard (д)'s same class) projects nothing, while
   * the turn's real content still projects normally.
   */
  it("projects zero events for the echoed new-input user frame, and the real turn content normally, over w0-04-resume-part2.jsonl", () => {
    const frames = streamFrames("w0-04-resume-part2.jsonl");
    const echoFrame = frames.find((frame) => frame.type === "user");
    expect(echoFrame).toMatchObject({ isReplay: true });

    const events = translate("w0-04-resume-part2.jsonl");
    // No user-authored event exists in AnyCode's vocabulary at all — the
    // discriminating assert is that the echo contributed NOTHING (not text,
    // not a duplicate turn marker) while the assistant's real reply and the
    // terminal frames still came through.
    const text = ofType(events, "text_delta").map((event) => event.text).join("");
    expect(text).toContain("RESUME-PART2-OK");
    expect(ofType(events, "turn_end")).toHaveLength(1);
    expect(ofType(events, "loop_end")).toHaveLength(1);
  });
});

describe("ClaudeTurnTranslator — drift-gate contribution (cut §3.3 layer-1 item (в-translator))", () => {
  it("chews every inbound stream frame of every committed fixture without an unknown-shape throw", () => {
    const files = readdirSync(FIXTURES_DIR).filter((name) => name.endsWith(".jsonl"));
    expect(files.length).toBeGreaterThanOrEqual(28);
    for (const file of files) {
      const translator = new ClaudeTurnTranslator({ turn: 1 });
      for (const frame of streamFrames(file)) {
        expect(() => translator.onMessage(frame), `${file}: ${JSON.stringify(frame).slice(0, 120)}`).not.toThrow();
      }
    }
  });
});

/**
 * cut §1.4 — `result.terminal_reason` is CANONICAL, and treating it as
 * canonical means mapping all of it. The committed signed-out fixture is the
 * proof this matters: it carries `terminal_reason:"api_error"` together with
 * `subtype:"success"` and `is_error:true`, so a mapping that handles three
 * reasons and then falls through to `subtype` calls a failed turn completed.
 *
 * Second half of the same rule: a turn that ends in error must SAY something.
 * An error `loop_end` with no `error` event is a faceless failure in the UI —
 * the turn just stops.
 */
describe("ClaudeTurnTranslator — terminal reasons are exhaustively mapped, and error terminals carry an error", () => {
  function result(fields: Record<string, unknown>): ClaudeStreamMessage {
    return {
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 1,
      duration_ms: 1,
      duration_api_ms: 1,
      total_cost_usd: 0,
      ...fields,
    } as unknown as ClaudeStreamMessage;
  }

  function terminalOf(frame: ClaudeStreamMessage): { events: AgentEvent[]; loop: string } {
    const events = new ClaudeTurnTranslator({ turn: 1 }).onMessage(frame);
    const loopEnd = events.find((event) => event.type === "loop_end") as Extract<AgentEvent, { type: "loop_end" }>;
    return { events, loop: loopEnd.reason };
  }

  it("api_error is an ERROR terminal even when subtype claims success (the signed-out shape, probe #12)", () => {
    const { events, loop } = terminalOf(result({ terminal_reason: "api_error", is_error: true }));
    expect(loop).toBe("error");
    const errors = events.filter((event) => event.type === "error");
    expect(errors).toHaveLength(1);
    expect((errors[0]!.error as Error).message).toContain("API request failed");
  });

  it.each([
    ["blocking_limit", "error"],
    ["rapid_refill_breaker", "error"],
    ["prompt_too_long", "error"],
    ["image_error", "error"],
    ["model_error", "error"],
    ["malformed_tool_use_exhausted", "error"],
    ["tool_deferred", "error"],
    ["tool_deferred_unavailable", "error"],
    ["structured_output_retry_exhausted", "error"],
    ["turn_setup_failed", "error"],
    ["aborted_streaming", "cancelled"],
    ["aborted_tools", "cancelled"],
    ["background_requested", "cancelled"],
    ["max_turns", "max_turns"],
    ["budget_exhausted", "max_turns"],
    ["completed", "completed"],
    ["stop_hook_prevented", "completed"],
    ["hook_stopped", "completed"],
  ])("terminal_reason %s -> loop_end %s, regardless of subtype:\"success\"", (reason, expected) => {
    expect(terminalOf(result({ terminal_reason: reason })).loop).toBe(expected);
  });

  it("every error terminal carries exactly one error event, and it is never faceless", () => {
    const { events } = terminalOf(result({ terminal_reason: "prompt_too_long" }));
    const errors = events.filter((event) => event.type === "error");
    expect(errors).toHaveLength(1);
    expect((errors[0]!.error as Error).message).toContain("context window");
    // Order: the error precedes the terminal pair.
    expect(events.map((event) => event.type).slice(-3)).toEqual(["error", "turn_end", "loop_end"]);
  });

  it("does not DOUBLE-report: an assistant.error already shown is not repeated at the terminal", () => {
    const translator = new ClaudeTurnTranslator({ turn: 1 });
    const early = translator.onMessage({
      type: "assistant",
      error: "authentication_failed",
      message: { model: "m", content: [] },
    } as unknown as ClaudeStreamMessage);
    expect(early.filter((event) => event.type === "error")).toHaveLength(1);

    const terminal = translator.onMessage(result({ terminal_reason: "api_error", is_error: true }));
    expect(terminal.filter((event) => event.type === "error")).toHaveLength(0);
    expect((terminal.find((event) => event.type === "loop_end") as { reason: string }).reason).toBe("error");
  });

  it("a latched failure overrides a result that claims a clean completion", () => {
    const translator = new ClaudeTurnTranslator({ turn: 1 });
    translator.onMessage({
      type: "assistant",
      error: "authentication_failed",
      message: { model: "m", content: [] },
    } as unknown as ClaudeStreamMessage);
    // No terminal_reason at all, subtype success — the pre-fix happy path.
    const terminal = translator.onMessage(result({}));
    expect((terminal.find((event) => event.type === "loop_end") as { reason: string }).reason).toBe("error");
  });

  it("an UNKNOWN future terminal_reason is not asserted as success — it falls back to subtype", () => {
    expect(terminalOf(result({ terminal_reason: "some_future_reason" })).loop).toBe("completed");
    expect(terminalOf(result({ terminal_reason: "some_future_reason", subtype: "error_during_execution" })).loop).toBe("error");
  });

  it("api_retry{authentication_failed} TERMINALIZES the turn instead of promising a retry (cut §1.4 table)", () => {
    const translator = new ClaudeTurnTranslator({ turn: 1 });
    const retry = translator.onMessage({
      type: "system",
      subtype: "api_retry",
      error: "authentication_failed",
    } as unknown as ClaudeStreamMessage);
    // A signed-out profile fails every retry — saying "retrying" leaves the
    // user watching a turn that can never finish.
    expect(retry.filter((event) => event.type === "engine_notice")).toHaveLength(0);

    const terminal = translator.onMessage(result({}));
    expect((terminal.find((event) => event.type === "loop_end") as { reason: string }).reason).toBe("error");
    const errors = terminal.filter((event) => event.type === "error");
    expect(errors).toHaveLength(1);
    expect((errors[0]!.error as Error).message).toContain("not signed in");
  });

  it("a RECOVERABLE api_retry still reports as a retry notice", () => {
    const events = new ClaudeTurnTranslator({ turn: 1 }).onMessage({
      type: "system",
      subtype: "api_retry",
      error: "overloaded",
    } as unknown as ClaudeStreamMessage);
    expect(events).toEqual([
      { type: "engine_notice", level: "retry", message: "Claude is retrying an API request: overloaded" },
    ]);
  });
});
