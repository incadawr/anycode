/**
 * Fail-closed shape-validator tests for the child-session protocol (TASK.102
 * CUT-S2 §2.3/§4.1: "мусор/лишние ключи/не-строки/отсутствующие поля —
 * отвергаются"). Every parser must accept a well-formed message and reject
 * garbage, wrong-typed fields, missing required fields, and objects carrying
 * extra unknown keys — always returning `null`, never throwing.
 */

import { PERMISSION_MODES } from "@anycode/core";
import { describe, expect, it } from "vitest";
import {
  CHILD_AGENT_TYPE_MAX_CHARS,
  CHILD_DESCRIPTION_MAX_CHARS,
  CHILD_FINAL_TEXT_MAX_CHARS,
  CHILD_ID_MAX_CHARS,
  CHILD_MODEL_MAX_CHARS,
  CHILD_PROGRESS_TYPE,
  CHILD_PROMPT_MAX_CHARS,
  CHILD_PROVIDER_MAX_CHARS,
  CHILD_READY_TYPE,
  CHILD_RUN_CANCEL_TYPE,
  CHILD_RUN_EVENT_TYPE,
  CHILD_RUNS_GLOBAL_MAX,
  CHILD_RUNS_PER_PARENT_MAX,
  CHILD_SPAWN_REQUEST_TYPE,
  CHILD_START_DEADLINE_MS,
  CHILD_START_TYPE,
  CHILD_STEER_QUEUE_MAX,
  CHILD_SUMMARY_MAX_CHARS,
  CHILD_TERMINAL_TYPE,
  CHILD_TOOL_NAME_MAX_CHARS,
  isValidChildId,
  parseChildProgress,
  parseChildReady,
  parseChildRunCancel,
  parseChildRunEvent,
  parseChildSpawnRequest,
  parseChildStart,
  parseChildTerminal,
  PERMISSION_MODE_VALUES,
} from "./child-sessions.js";

// A representative garbage set, exercised against every parser.
const GARBAGE_INPUTS: unknown[] = [
  null,
  undefined,
  42,
  "not an object",
  [],
  {},
  { type: "anycode:something-else" },
];

describe("parseChildSpawnRequest", () => {
  const valid = {
    type: CHILD_SPAWN_REQUEST_TYPE,
    requestId: "req-1",
    spawnToolCallId: "call-1",
    agentType: "general-purpose",
    description: "build the thing",
    prompt: "please build the thing",
    permissionMode: "build",
  };

  it("accepts a well-formed minimal request", () => {
    expect(parseChildSpawnRequest(valid)).toEqual(valid);
  });

  it("accepts optional provider and model when present", () => {
    const withOptional = { ...valid, provider: "anthropic-1", model: "claude-x" };
    expect(parseChildSpawnRequest(withOptional)).toEqual(withOptional);
  });

  // TASK.102 CUT-S4 §3.1: `engine` is absent = core (byte-compatible with
  // every S2 producer); present = the child boots that engine instead of an
  // in-process core loop.
  describe("engine (CUT-S4 §3.1)", () => {
    it("accepts absent engine (core, byte-compatible with S2)", () => {
      expect(parseChildSpawnRequest(valid)).toEqual(valid);
    });

    it.each(["claude", "codex"] as const)("accepts a well-formed %s engine", (engine) => {
      const withEngine = { ...valid, engine };
      expect(parseChildSpawnRequest(withEngine)).toEqual(withEngine);
    });

    it("rejects an engine value outside the dictionary (fail-closed drop)", () => {
      expect(parseChildSpawnRequest({ ...valid, engine: "gpt" })).toBeNull();
    });

    it("rejects a non-string engine", () => {
      expect(parseChildSpawnRequest({ ...valid, engine: 1 })).toBeNull();
    });

    it("rejects the core-equivalent literal 'core' — absence, not a literal, spells core", () => {
      expect(parseChildSpawnRequest({ ...valid, engine: "core" })).toBeNull();
    });
  });

  it.each(GARBAGE_INPUTS)("rejects garbage input %#", (garbage) => {
    expect(parseChildSpawnRequest(garbage)).toBeNull();
  });

  it("rejects an object with an extra unknown key", () => {
    expect(parseChildSpawnRequest({ ...valid, extra: "surprise" })).toBeNull();
  });

  it("rejects a non-string requestId", () => {
    expect(parseChildSpawnRequest({ ...valid, requestId: 123 })).toBeNull();
  });

  it("rejects a non-string prompt", () => {
    expect(parseChildSpawnRequest({ ...valid, prompt: { nested: true } })).toBeNull();
  });

  it("rejects a missing required field", () => {
    const { prompt: _prompt, ...withoutPrompt } = valid;
    expect(parseChildSpawnRequest(withoutPrompt)).toBeNull();
  });

  it("rejects an invalid permissionMode enum value", () => {
    expect(parseChildSpawnRequest({ ...valid, permissionMode: "sudo" })).toBeNull();
  });

  it("rejects an empty-string identifier", () => {
    expect(parseChildSpawnRequest({ ...valid, requestId: "" })).toBeNull();
  });

  it("rejects a non-string optional provider", () => {
    expect(parseChildSpawnRequest({ ...valid, provider: 7 })).toBeNull();
  });

  // Review finding 1 (TASK.102 S2a review): a provider mints `part.
  // toolCallId` verbatim on OpenAI-compatible connects (stream-translator.ts)
  // and this validator was the only gate before `spawnToolCallId` becomes a
  // literal argv value in host/boot.ts's `--child-spawn-call <id>`
  // (parseHostArgs reads `argv[i+1]` positionally, TASK.102 CUT-S2 §2.6.2).
  // A model-chosen id of `"--child-mode"` previously passed `isNonEmptyString`
  // unchanged and would have desynchronized the whole arg list.
  describe("id-shaped field hardening (review finding 1)", () => {
    it("rejects a spawnToolCallId starting with a dash — the exact desync scenario the review traced through boot.ts's argv parser", () => {
      expect(parseChildSpawnRequest({ ...valid, spawnToolCallId: "--child-mode" })).toBeNull();
    });

    it("rejects a requestId starting with a dash", () => {
      expect(parseChildSpawnRequest({ ...valid, requestId: "-oops" })).toBeNull();
    });

    it("rejects an id field containing a space", () => {
      expect(parseChildSpawnRequest({ ...valid, spawnToolCallId: "call 1" })).toBeNull();
    });

    it("rejects an id field containing a control character", () => {
      expect(parseChildSpawnRequest({ ...valid, requestId: "req-1" })).toBeNull();
    });

    it("rejects a requestId one over CHILD_ID_MAX_CHARS", () => {
      expect(parseChildSpawnRequest({ ...valid, requestId: "a".repeat(CHILD_ID_MAX_CHARS + 1) })).toBeNull();
    });

    it("accepts a requestId at exactly CHILD_ID_MAX_CHARS", () => {
      const atCap = "a".repeat(CHILD_ID_MAX_CHARS);
      expect(parseChildSpawnRequest({ ...valid, requestId: atCap })).toEqual({ ...valid, requestId: atCap });
    });

    it("rejects a megabyte-scale requestId (the reachability scenario verified in code by the review: a 5MB requestId/prompt previously passed)", () => {
      expect(parseChildSpawnRequest({ ...valid, requestId: "x".repeat(5 * 1024 * 1024) })).toBeNull();
    });
  });

  describe("free-text field caps (review finding 1)", () => {
    it("rejects an agentType one over CHILD_AGENT_TYPE_MAX_CHARS", () => {
      expect(parseChildSpawnRequest({ ...valid, agentType: "a".repeat(CHILD_AGENT_TYPE_MAX_CHARS + 1) })).toBeNull();
    });

    it("accepts an agentType at exactly CHILD_AGENT_TYPE_MAX_CHARS", () => {
      const atCap = "a".repeat(CHILD_AGENT_TYPE_MAX_CHARS);
      expect(parseChildSpawnRequest({ ...valid, agentType: atCap })).toEqual({ ...valid, agentType: atCap });
    });

    it("rejects a description one over CHILD_DESCRIPTION_MAX_CHARS", () => {
      expect(parseChildSpawnRequest({ ...valid, description: "a".repeat(CHILD_DESCRIPTION_MAX_CHARS + 1) })).toBeNull();
    });

    it("accepts a description at exactly CHILD_DESCRIPTION_MAX_CHARS", () => {
      const atCap = "a".repeat(CHILD_DESCRIPTION_MAX_CHARS);
      expect(parseChildSpawnRequest({ ...valid, description: atCap })).toEqual({ ...valid, description: atCap });
    });

    it("rejects a prompt one over CHILD_PROMPT_MAX_CHARS", () => {
      expect(parseChildSpawnRequest({ ...valid, prompt: "a".repeat(CHILD_PROMPT_MAX_CHARS + 1) })).toBeNull();
    });

    it("accepts a prompt at exactly CHILD_PROMPT_MAX_CHARS", () => {
      const atCap = "a".repeat(CHILD_PROMPT_MAX_CHARS);
      expect(parseChildSpawnRequest({ ...valid, prompt: atCap })).toEqual({ ...valid, prompt: atCap });
    });

    it("rejects an optional model one over CHILD_MODEL_MAX_CHARS", () => {
      expect(parseChildSpawnRequest({ ...valid, model: "a".repeat(CHILD_MODEL_MAX_CHARS + 1) })).toBeNull();
    });

    it("rejects an optional provider one over CHILD_PROVIDER_MAX_CHARS", () => {
      expect(parseChildSpawnRequest({ ...valid, provider: "a".repeat(CHILD_PROVIDER_MAX_CHARS + 1) })).toBeNull();
    });
  });
});

describe("parseChildRunCancel", () => {
  const valid = { type: CHILD_RUN_CANCEL_TYPE, requestId: "req-1" };

  it("accepts a well-formed cancel", () => {
    expect(parseChildRunCancel(valid)).toEqual(valid);
  });

  it.each(GARBAGE_INPUTS)("rejects garbage input %#", (garbage) => {
    expect(parseChildRunCancel(garbage)).toBeNull();
  });

  it("rejects an extra unknown key", () => {
    expect(parseChildRunCancel({ ...valid, reason: "why not" })).toBeNull();
  });

  it("rejects a non-string requestId", () => {
    expect(parseChildRunCancel({ type: CHILD_RUN_CANCEL_TYPE, requestId: null })).toBeNull();
  });

  it("rejects a requestId starting with a dash (review finding 1)", () => {
    expect(parseChildRunCancel({ type: CHILD_RUN_CANCEL_TYPE, requestId: "-oops" })).toBeNull();
  });

  it("rejects a requestId one over CHILD_ID_MAX_CHARS", () => {
    expect(parseChildRunCancel({ type: CHILD_RUN_CANCEL_TYPE, requestId: "a".repeat(CHILD_ID_MAX_CHARS + 1) })).toBeNull();
  });
});

describe("parseChildRunEvent", () => {
  it("accepts an accepted event", () => {
    const msg = {
      type: CHILD_RUN_EVENT_TYPE,
      requestId: "req-1",
      kind: "accepted",
      childSessionId: "sess-1",
      childTabId: "tab-1",
      model: "claude-x",
    };
    expect(parseChildRunEvent(msg)).toEqual(msg);
  });

  it("rejects any kind with a requestId starting with a dash (review finding 1)", () => {
    const msg = { type: CHILD_RUN_EVENT_TYPE, requestId: "-oops", kind: "attention", waiting: true };
    expect(parseChildRunEvent(msg)).toBeNull();
  });

  it("rejects an accepted event whose childSessionId/childTabId are dash-leading or oversized", () => {
    const base = {
      type: CHILD_RUN_EVENT_TYPE,
      requestId: "req-1",
      kind: "accepted" as const,
      childSessionId: "sess-1",
      childTabId: "tab-1",
      model: "claude-x",
    };
    expect(parseChildRunEvent({ ...base, childSessionId: "-sess-1" })).toBeNull();
    expect(parseChildRunEvent({ ...base, childTabId: "a".repeat(CHILD_ID_MAX_CHARS + 1) })).toBeNull();
  });

  it("rejects an accepted event's model one over CHILD_MODEL_MAX_CHARS", () => {
    const msg = {
      type: CHILD_RUN_EVENT_TYPE,
      requestId: "req-1",
      kind: "accepted",
      childSessionId: "sess-1",
      childTabId: "tab-1",
      model: "a".repeat(CHILD_MODEL_MAX_CHARS + 1),
    };
    expect(parseChildRunEvent(msg)).toBeNull();
  });

  it("accepts a rejected event with a known reason", () => {
    const msg = {
      type: CHILD_RUN_EVENT_TYPE,
      requestId: "req-1",
      kind: "rejected",
      reason: "limit_parent",
      message: "too many children",
    };
    expect(parseChildRunEvent(msg)).toEqual(msg);
  });

  it("rejects a rejected event with an unknown reason", () => {
    const msg = {
      type: CHILD_RUN_EVENT_TYPE,
      requestId: "req-1",
      kind: "rejected",
      reason: "because_i_said_so",
      message: "nope",
    };
    expect(parseChildRunEvent(msg)).toBeNull();
  });

  it("accepts a progress event without the optional lastTool", () => {
    const msg = { type: CHILD_RUN_EVENT_TYPE, requestId: "req-1", kind: "progress", turns: 2, toolCalls: 5 };
    expect(parseChildRunEvent(msg)).toEqual(msg);
  });

  it("accepts a progress event with lastTool", () => {
    const msg = {
      type: CHILD_RUN_EVENT_TYPE,
      requestId: "req-1",
      kind: "progress",
      turns: 2,
      toolCalls: 5,
      lastTool: "Bash",
    };
    expect(parseChildRunEvent(msg)).toEqual(msg);
  });

  it("rejects a progress event with a negative counter", () => {
    const msg = { type: CHILD_RUN_EVENT_TYPE, requestId: "req-1", kind: "progress", turns: -1, toolCalls: 5 };
    expect(parseChildRunEvent(msg)).toBeNull();
  });

  it("rejects a progress event with a non-integer counter", () => {
    const msg = { type: CHILD_RUN_EVENT_TYPE, requestId: "req-1", kind: "progress", turns: 1.5, toolCalls: 5 };
    expect(parseChildRunEvent(msg)).toBeNull();
  });

  it("rejects a progress event's lastTool one over CHILD_TOOL_NAME_MAX_CHARS", () => {
    const msg = {
      type: CHILD_RUN_EVENT_TYPE,
      requestId: "req-1",
      kind: "progress",
      turns: 2,
      toolCalls: 5,
      lastTool: "a".repeat(CHILD_TOOL_NAME_MAX_CHARS + 1),
    };
    expect(parseChildRunEvent(msg)).toBeNull();
  });

  it("accepts an activity event", () => {
    const msg = {
      type: CHILD_RUN_EVENT_TYPE,
      requestId: "req-1",
      kind: "activity",
      toolName: "Bash",
      summary: "ran a command",
    };
    expect(parseChildRunEvent(msg)).toEqual(msg);
  });

  it("rejects an activity event with a non-string summary", () => {
    const msg = { type: CHILD_RUN_EVENT_TYPE, requestId: "req-1", kind: "activity", toolName: "Bash", summary: 5 };
    expect(parseChildRunEvent(msg)).toBeNull();
  });

  it("rejects an activity event's toolName/summary one over their caps", () => {
    const base = { type: CHILD_RUN_EVENT_TYPE, requestId: "req-1", kind: "activity" as const, toolName: "Bash", summary: "ok" };
    expect(parseChildRunEvent({ ...base, toolName: "a".repeat(CHILD_TOOL_NAME_MAX_CHARS + 1) })).toBeNull();
    expect(parseChildRunEvent({ ...base, summary: "a".repeat(CHILD_SUMMARY_MAX_CHARS + 1) })).toBeNull();
  });

  it("accepts an attention event", () => {
    const msg = { type: CHILD_RUN_EVENT_TYPE, requestId: "req-1", kind: "attention", waiting: true };
    expect(parseChildRunEvent(msg)).toEqual(msg);
  });

  it("rejects an attention event with a non-boolean waiting", () => {
    const msg = { type: CHILD_RUN_EVENT_TYPE, requestId: "req-1", kind: "attention", waiting: "true" };
    expect(parseChildRunEvent(msg)).toBeNull();
  });

  it("accepts a terminal event", () => {
    const msg = {
      type: CHILD_RUN_EVENT_TYPE,
      requestId: "req-1",
      kind: "terminal",
      status: "completed",
      finalText: "done",
      truncated: false,
      turns: 3,
      toolCalls: 9,
      durationMs: 1200,
      childSessionId: "sess-1",
    };
    expect(parseChildRunEvent(msg)).toEqual(msg);
  });

  it("accepts a terminal event with an empty finalText", () => {
    const msg = {
      type: CHILD_RUN_EVENT_TYPE,
      requestId: "req-1",
      kind: "terminal",
      status: "cancelled",
      finalText: "",
      truncated: false,
      turns: 0,
      toolCalls: 0,
      durationMs: 5,
      childSessionId: "sess-1",
    };
    expect(parseChildRunEvent(msg)).toEqual(msg);
  });

  it("rejects a terminal event with an invalid status", () => {
    const msg = {
      type: CHILD_RUN_EVENT_TYPE,
      requestId: "req-1",
      kind: "terminal",
      status: "finished",
      finalText: "done",
      truncated: false,
      turns: 3,
      toolCalls: 9,
      durationMs: 1200,
      childSessionId: "sess-1",
    };
    expect(parseChildRunEvent(msg)).toBeNull();
  });

  it("rejects a terminal event missing childSessionId", () => {
    const msg = {
      type: CHILD_RUN_EVENT_TYPE,
      requestId: "req-1",
      kind: "terminal",
      status: "completed",
      finalText: "done",
      truncated: false,
      turns: 3,
      toolCalls: 9,
      durationMs: 1200,
    };
    expect(parseChildRunEvent(msg)).toBeNull();
  });

  it("rejects a terminal event's finalText one over CHILD_FINAL_TEXT_MAX_CHARS (review finding 1: finalText was uncapped in this parser — only the child-host producer capped it)", () => {
    const msg = {
      type: CHILD_RUN_EVENT_TYPE,
      requestId: "req-1",
      kind: "terminal",
      status: "completed",
      finalText: "a".repeat(CHILD_FINAL_TEXT_MAX_CHARS + 1),
      truncated: false,
      turns: 3,
      toolCalls: 9,
      durationMs: 1200,
      childSessionId: "sess-1",
    };
    expect(parseChildRunEvent(msg)).toBeNull();
  });

  it("accepts a terminal event's finalText at exactly CHILD_FINAL_TEXT_MAX_CHARS", () => {
    const finalText = "a".repeat(CHILD_FINAL_TEXT_MAX_CHARS);
    const msg = {
      type: CHILD_RUN_EVENT_TYPE,
      requestId: "req-1",
      kind: "terminal",
      status: "completed",
      finalText,
      truncated: false,
      turns: 3,
      toolCalls: 9,
      durationMs: 1200,
      childSessionId: "sess-1",
    };
    expect(parseChildRunEvent(msg)).toEqual(msg);
  });

  it("rejects a terminal event's childSessionId starting with a dash", () => {
    const msg = {
      type: CHILD_RUN_EVENT_TYPE,
      requestId: "req-1",
      kind: "terminal",
      status: "completed",
      finalText: "done",
      truncated: false,
      turns: 3,
      toolCalls: 9,
      durationMs: 1200,
      childSessionId: "-sess-1",
    };
    expect(parseChildRunEvent(msg)).toBeNull();
  });

  // TASK.102 CUT-S2 §10.7 п.4: additive amendment to this otherwise-frozen
  // terminal variant — `activitySuppressed` mirrors `ChildTerminal`'s own
  // field through to the parent-host wire.
  describe("terminal event activitySuppressed (CUT-S2 §10.7 п.4, additive)", () => {
    const validTerminal = {
      type: CHILD_RUN_EVENT_TYPE,
      requestId: "req-1",
      kind: "terminal" as const,
      status: "completed" as const,
      finalText: "done",
      truncated: false,
      turns: 3,
      toolCalls: 9,
      durationMs: 1200,
      childSessionId: "sess-1",
    };

    it("parses and carries a valid activitySuppressed", () => {
      const msg = { ...validTerminal, activitySuppressed: 3 };
      expect(parseChildRunEvent(msg)).toEqual(msg);
    });

    it("is valid, with no activitySuppressed key on the parsed result, when the field is absent", () => {
      const parsed = parseChildRunEvent(validTerminal);
      expect(parsed).toEqual(validTerminal);
      expect(parsed && "activitySuppressed" in parsed).toBe(false);
    });

    it("rejects a negative activitySuppressed", () => {
      expect(parseChildRunEvent({ ...validTerminal, activitySuppressed: -1 })).toBeNull();
    });

    it("rejects a fractional activitySuppressed", () => {
      expect(parseChildRunEvent({ ...validTerminal, activitySuppressed: 1.5 })).toBeNull();
    });

    it("rejects a non-number activitySuppressed", () => {
      expect(parseChildRunEvent({ ...validTerminal, activitySuppressed: "3" })).toBeNull();
    });
  });

  it("rejects an unknown kind", () => {
    expect(parseChildRunEvent({ type: CHILD_RUN_EVENT_TYPE, requestId: "req-1", kind: "mystery" })).toBeNull();
  });

  it("rejects an accepted event carrying an extra unknown key", () => {
    const msg = {
      type: CHILD_RUN_EVENT_TYPE,
      requestId: "req-1",
      kind: "accepted",
      childSessionId: "sess-1",
      childTabId: "tab-1",
      model: "claude-x",
      unexpected: true,
    };
    expect(parseChildRunEvent(msg)).toBeNull();
  });

  it.each(GARBAGE_INPUTS)("rejects garbage input %#", (garbage) => {
    expect(parseChildRunEvent(garbage)).toBeNull();
  });
});

describe("parseChildReady", () => {
  it("accepts the bare ready message", () => {
    expect(parseChildReady({ type: CHILD_READY_TYPE })).toEqual({ type: CHILD_READY_TYPE });
  });

  it("rejects an extra unknown key", () => {
    expect(parseChildReady({ type: CHILD_READY_TYPE, extra: 1 })).toBeNull();
  });

  it.each(GARBAGE_INPUTS)("rejects garbage input %#", (garbage) => {
    expect(parseChildReady(garbage)).toBeNull();
  });
});

describe("parseChildStart", () => {
  it("accepts a well-formed start", () => {
    const msg = { type: CHILD_START_TYPE, prompt: "go" };
    expect(parseChildStart(msg)).toEqual(msg);
  });

  it("accepts an empty prompt (well-formed but empty is still a string)", () => {
    const msg = { type: CHILD_START_TYPE, prompt: "" };
    expect(parseChildStart(msg)).toEqual(msg);
  });

  it("rejects a non-string prompt", () => {
    expect(parseChildStart({ type: CHILD_START_TYPE, prompt: 5 })).toBeNull();
  });

  it("rejects a missing prompt", () => {
    expect(parseChildStart({ type: CHILD_START_TYPE })).toBeNull();
  });

  it("rejects a prompt one over CHILD_PROMPT_MAX_CHARS (review finding 1)", () => {
    expect(parseChildStart({ type: CHILD_START_TYPE, prompt: "a".repeat(CHILD_PROMPT_MAX_CHARS + 1) })).toBeNull();
  });

  it.each(GARBAGE_INPUTS)("rejects garbage input %#", (garbage) => {
    expect(parseChildStart(garbage)).toBeNull();
  });
});

describe("parseChildProgress", () => {
  it("accepts a progress-kind message", () => {
    const msg = { type: CHILD_PROGRESS_TYPE, kind: "progress", turns: 1, toolCalls: 2 };
    expect(parseChildProgress(msg)).toEqual(msg);
  });

  it("accepts an activity-kind message", () => {
    const msg = { type: CHILD_PROGRESS_TYPE, kind: "activity", toolName: "Read", summary: "read a file" };
    expect(parseChildProgress(msg)).toEqual(msg);
  });

  it("accepts an attention-kind message", () => {
    const msg = { type: CHILD_PROGRESS_TYPE, kind: "attention", waiting: false };
    expect(parseChildProgress(msg)).toEqual(msg);
  });

  it("rejects an unknown kind", () => {
    expect(parseChildProgress({ type: CHILD_PROGRESS_TYPE, kind: "mystery" })).toBeNull();
  });

  it("rejects a progress message with extra unknown keys", () => {
    const msg = { type: CHILD_PROGRESS_TYPE, kind: "progress", turns: 1, toolCalls: 2, bogus: true };
    expect(parseChildProgress(msg)).toBeNull();
  });

  it("rejects a progress message's lastTool one over CHILD_TOOL_NAME_MAX_CHARS (review finding 1)", () => {
    const msg = { type: CHILD_PROGRESS_TYPE, kind: "progress", turns: 1, toolCalls: 2, lastTool: "a".repeat(CHILD_TOOL_NAME_MAX_CHARS + 1) };
    expect(parseChildProgress(msg)).toBeNull();
  });

  it("rejects an activity message's toolName/summary one over their caps", () => {
    const base = { type: CHILD_PROGRESS_TYPE, kind: "activity" as const, toolName: "Read", summary: "read a file" };
    expect(parseChildProgress({ ...base, toolName: "a".repeat(CHILD_TOOL_NAME_MAX_CHARS + 1) })).toBeNull();
    expect(parseChildProgress({ ...base, summary: "a".repeat(CHILD_SUMMARY_MAX_CHARS + 1) })).toBeNull();
  });

  it.each(GARBAGE_INPUTS)("rejects garbage input %#", (garbage) => {
    expect(parseChildProgress(garbage)).toBeNull();
  });
});

describe("parseChildTerminal", () => {
  const valid = {
    type: CHILD_TERMINAL_TYPE,
    status: "completed" as const,
    finalText: "the result",
    truncated: false,
    turns: 4,
    toolCalls: 10,
    durationMs: 5000,
  };

  it("accepts a well-formed terminal without activitySuppressed", () => {
    expect(parseChildTerminal(valid)).toEqual(valid);
  });

  it("accepts activitySuppressed when present", () => {
    const withSuppressed = { ...valid, activitySuppressed: 3 };
    expect(parseChildTerminal(withSuppressed)).toEqual(withSuppressed);
  });

  it("rejects a negative activitySuppressed", () => {
    expect(parseChildTerminal({ ...valid, activitySuppressed: -1 })).toBeNull();
  });

  it("rejects an invalid status enum value", () => {
    expect(parseChildTerminal({ ...valid, status: "done" })).toBeNull();
  });

  it("rejects a non-boolean truncated", () => {
    expect(parseChildTerminal({ ...valid, truncated: "false" })).toBeNull();
  });

  it("rejects a missing required field", () => {
    const { durationMs: _durationMs, ...withoutDuration } = valid;
    expect(parseChildTerminal(withoutDuration)).toBeNull();
  });

  it("rejects an object with an extra unknown key", () => {
    expect(parseChildTerminal({ ...valid, childSessionId: "sess-1" })).toBeNull();
  });

  it("rejects a finalText one over CHILD_FINAL_TEXT_MAX_CHARS (review finding 1: this parser had no cap at all before)", () => {
    expect(parseChildTerminal({ ...valid, finalText: "a".repeat(CHILD_FINAL_TEXT_MAX_CHARS + 1) })).toBeNull();
  });

  it("accepts a finalText at exactly CHILD_FINAL_TEXT_MAX_CHARS", () => {
    const finalText = "a".repeat(CHILD_FINAL_TEXT_MAX_CHARS);
    expect(parseChildTerminal({ ...valid, finalText })).toEqual({ ...valid, finalText });
  });

  it.each(GARBAGE_INPUTS)("rejects garbage input %#", (garbage) => {
    expect(parseChildTerminal(garbage)).toBeNull();
  });
});

describe("protocol constants", () => {
  it("freezes the documented admission/timing numbers", () => {
    expect(CHILD_RUNS_PER_PARENT_MAX).toBe(3);
    expect(CHILD_RUNS_GLOBAL_MAX).toBe(8);
    expect(CHILD_START_DEADLINE_MS).toBe(30_000);
    expect(CHILD_STEER_QUEUE_MAX).toBe(16);
  });
});

// Review finding 4: PERMISSION_MODE_VALUES is a hand-typed `readonly string[]`
// duplicate of core's PERMISSION_MODES tuple (file header: this production
// file takes zero VALUE imports of @anycode/core, so it cannot just import
// the real thing). The duplicate is untyped against the original, so nothing
// caught a drift before this test — a new PermissionMode added to core would
// make parseChildSpawnRequest silently reject every spawn request in that
// mode, and neither typecheck nor any other test would notice. A value
// import of @anycode/core is fine HERE (this is the test file, never
// bundled) even though it's forbidden in child-sessions.ts itself.
describe("PERMISSION_MODE_VALUES parity with @anycode/core's PERMISSION_MODES (review finding 4)", () => {
  it("stays byte-for-byte in sync with the real core export", () => {
    expect(PERMISSION_MODE_VALUES).toEqual(PERMISSION_MODES);
  });
});

// ---------------------------------------------------------------------------
// isValidChildId (TASK.102 CUT-S2 §10.5, additive export): lets the parent
// host's RPC client pre-flight validate a spawnToolCallId BEFORE putting it
// on the wire. It must accept/reject the exact same shapes
// parseChildSpawnRequest's own spawnToolCallId gate does — a disagreement
// here would either reject requests main would have accepted, or (worse) let
// through requests main's fail-closed parser silently drops, hanging the
// caller until the 600s dispatcher timeout.

describe("isValidChildId", () => {
  it("accepts a well-formed id", () => {
    expect(isValidChildId("call-1")).toBe(true);
  });

  it.each([null, undefined, 42, {}, [], true, Symbol("x")])("rejects a non-string value %#", (value) => {
    expect(isValidChildId(value)).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isValidChildId("")).toBe(false);
  });

  it("rejects a value starting with a dash", () => {
    expect(isValidChildId("-oops")).toBe(false);
  });

  it("rejects a value containing a space", () => {
    expect(isValidChildId("has space")).toBe(false);
  });

  it("rejects a value containing a control character", () => {
    expect(isValidChildId("has\x1fcontrol")).toBe(false);
  });

  it("rejects a value one over CHILD_ID_MAX_CHARS", () => {
    expect(isValidChildId("a".repeat(CHILD_ID_MAX_CHARS + 1))).toBe(false);
  });

  it("accepts a value at exactly CHILD_ID_MAX_CHARS", () => {
    expect(isValidChildId("a".repeat(CHILD_ID_MAX_CHARS))).toBe(true);
  });

  describe("parity with parseChildSpawnRequest's spawnToolCallId gate (§10.5: pre-flight and main must never disagree)", () => {
    const base = {
      type: CHILD_SPAWN_REQUEST_TYPE,
      requestId: "req-1",
      agentType: "general-purpose",
      description: "d",
      prompt: "p",
      permissionMode: "build",
    };

    const candidates: unknown[] = [
      "ok-id",
      "",
      "-dash-lead",
      "has space",
      "has\x1fcontrol",
      "a".repeat(CHILD_ID_MAX_CHARS),
      "a".repeat(CHILD_ID_MAX_CHARS + 1),
    ];

    it.each(candidates)(
      "isValidChildId(%j) agrees with whether parseChildSpawnRequest accepts the SAME value as spawnToolCallId",
      (candidate) => {
        const parsed = parseChildSpawnRequest({ ...base, spawnToolCallId: candidate });
        expect(isValidChildId(candidate)).toBe(parsed !== null);
      },
    );
  });
});
