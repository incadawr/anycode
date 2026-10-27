/**
 * Fail-closed shape-validator tests for the child-session protocol (TASK.102
 * CUT-S2 §2.3/§4.1: "мусор/лишние ключи/не-строки/отсутствующие поля —
 * отвергаются"). Every parser must accept a well-formed message and reject
 * garbage, wrong-typed fields, missing required fields, and objects carrying
 * extra unknown keys — always returning `null`, never throwing.
 */

import { PERMISSION_MODES } from "@anycode/core";
import type { CeilingRefusalReason } from "@anycode/core";
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
  CHILD_RUN_SEND_TYPE,
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
  parseChildRunSend,
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

  // GitHub #17 slice B: the detach flag rides the wire so main
  // can refuse an over-cap detached request immediately instead of parking it.
  it("round-trips detach true and false, and keeps legacy absent absent", () => {
    const detached = { ...valid, detach: true };
    expect(parseChildSpawnRequest(detached)).toEqual(detached);
    const joined = { ...valid, detach: false };
    expect(parseChildSpawnRequest(joined)).toEqual(joined);
    const parsed = parseChildSpawnRequest(valid);
    expect(parsed).toEqual(valid);
    expect(parsed !== null && "detach" in parsed).toBe(false);
  });

  it("fails closed on a non-boolean detach", () => {
    for (const detach of ["true", 1, 0, null, {}]) {
      expect(parseChildSpawnRequest({ ...valid, detach })).toBeNull();
    }
  });

  it("accepts a well-formed resumeChildSessionId and drops a malformed one", () => {
    const withResume = { ...valid, resumeChildSessionId: "child-1" };
    expect(parseChildSpawnRequest(withResume)).toEqual(withResume);
    expect(parseChildSpawnRequest({ ...valid, resumeChildSessionId: "" })).toBeNull();
    expect(parseChildSpawnRequest({ ...valid, resumeChildSessionId: 1 })).toBeNull();
    expect(parseChildSpawnRequest({ ...valid, resumeChildSessionId: "bad\u0000id" })).toBeNull();
  });

  it("accepts a known effort tier and drops the message for any other (TASK.127)", () => {
    const withEffort = { ...valid, effort: "low" };
    expect(parseChildSpawnRequest(withEffort)).toEqual(withEffort);
    expect(parseChildSpawnRequest({ ...valid, effort: 3 })).toBeNull();
    expect(parseChildSpawnRequest({ ...valid, effort: "turbo" })).toBeNull();
  });

  it("accepts xhigh (engine children carry it verbatim) and round-trips it", () => {
    const withXhigh = { ...valid, engine: "claude" as const, effort: "xhigh" };
    const parsed = parseChildSpawnRequest(withXhigh);
    expect(parsed).toEqual(withXhigh);
    expect(parsed?.effort).toBe("xhigh");
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

  // S4 blocker (found independently by two reviewers): `model` is a
  // model-authored field that reaches the child host's argv unsanitized
  // (main/tabs.ts pushes `["--engine-model", value]`) and `host/boot.ts`'s
  // `parseHostArgs` has no `--engine-model` branch, so a value starting with
  // `-` gets re-read as a FLAG by the next iteration. `model:"--session=x"`
  // rewrites another session's transcript; `model:"--child-parent"` strips
  // the pedigree stamp, making the child visible in the session list. Fixed
  // by requiring `model` to be id-shaped (same rule as spawnToolCallId/
  // requestId above), never flag-shaped.
  describe("model id-shape hardening (S4 blocker)", () => {
    it.each(["--session=x", "--child-parent", "--resume=x", "-x"])(
      "rejects a flag-shaped model: %s",
      (model) => {
        expect(parseChildSpawnRequest({ ...valid, model })).toBeNull();
      },
    );

    it.each(["claude-sonnet-4-5", "us.anthropic.claude-3"])("accepts a legitimate model: %s", (model) => {
      expect(parseChildSpawnRequest({ ...valid, model })).toEqual({ ...valid, model });
    });
  });

  // Taskana 4269: `connectionId` is the exact id a profile's `connection:`
  // frontmatter selects. Wire shape mirrors `provider`; the two are mutually
  // exclusive (two ways to name the same connection).
  describe("connectionId routing (Taskana 4269)", () => {
    it("accepts an optional connectionId and round-trips it", () => {
      const withConnection = { ...valid, connectionId: "conn-glm" };
      expect(parseChildSpawnRequest(withConnection)).toEqual(withConnection);
    });

    it("rejects a non-string optional connectionId", () => {
      expect(parseChildSpawnRequest({ ...valid, connectionId: 42 })).toBeNull();
    });

    it("rejects an empty-string connectionId (isNonEmptyCappedString policy — distinct from a blank frontmatter value)", () => {
      expect(parseChildSpawnRequest({ ...valid, connectionId: "" })).toBeNull();
    });

    it("rejects a provider+connectionId pair (mutually exclusive)", () => {
      expect(parseChildSpawnRequest({ ...valid, provider: "z-ai", connectionId: "conn-glm" })).toBeNull();
    });

    it("accepts exactly CHILD_PROVIDER_MAX_CHARS and refuses one over", () => {
      const atCap = "a".repeat(CHILD_PROVIDER_MAX_CHARS);
      expect(parseChildSpawnRequest({ ...valid, connectionId: atCap })).toEqual({ ...valid, connectionId: atCap });
      expect(parseChildSpawnRequest({ ...valid, connectionId: "a".repeat(CHILD_PROVIDER_MAX_CHARS + 1) })).toBeNull();
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

describe("parseChildRunSend (Taskana 4153)", () => {
  const valid = { type: CHILD_RUN_SEND_TYPE, requestId: "req-1", childSessionId: "sess-1", text: "here are the other reviewers' edits" };

  it("accepts a well-formed send", () => {
    expect(parseChildRunSend(valid)).toEqual(valid);
  });

  it("rejects a wrong type", () => {
    expect(parseChildRunSend({ ...valid, type: CHILD_RUN_CANCEL_TYPE })).toBeNull();
  });

  it.each(GARBAGE_INPUTS)("rejects garbage input %#", (garbage) => {
    expect(parseChildRunSend(garbage)).toBeNull();
  });

  it("rejects a missing key (no text)", () => {
    expect(parseChildRunSend({ type: CHILD_RUN_SEND_TYPE, requestId: "req-1", childSessionId: "sess-1" })).toBeNull();
  });

  it("rejects a missing key (no childSessionId)", () => {
    expect(parseChildRunSend({ type: CHILD_RUN_SEND_TYPE, requestId: "req-1", text: "hello" })).toBeNull();
  });

  it("rejects an extra unknown key", () => {
    expect(parseChildRunSend({ ...valid, prompt: "shadow field" })).toBeNull();
  });

  it("rejects a malformed childSessionId shape (dash-leading, whitespace, oversized, non-string)", () => {
    expect(parseChildRunSend({ ...valid, childSessionId: "-sess-1" })).toBeNull();
    expect(parseChildRunSend({ ...valid, childSessionId: "sess 1" })).toBeNull();
    expect(parseChildRunSend({ ...valid, childSessionId: "a".repeat(CHILD_ID_MAX_CHARS + 1) })).toBeNull();
    expect(parseChildRunSend({ ...valid, childSessionId: 42 })).toBeNull();
  });

  it("rejects an empty text", () => {
    expect(parseChildRunSend({ ...valid, text: "" })).toBeNull();
  });

  it("rejects a text one over CHILD_PROMPT_MAX_CHARS", () => {
    expect(parseChildRunSend({ ...valid, text: "a".repeat(CHILD_PROMPT_MAX_CHARS + 1) })).toBeNull();
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

  it("accepts a sent event (Taskana 4153 ack, additive union member)", () => {
    const msg = { type: CHILD_RUN_EVENT_TYPE, requestId: "req-1", kind: "sent" };
    expect(parseChildRunEvent(msg)).toEqual(msg);
  });

  it("rejects a sent event carrying an extra key", () => {
    const msg = { type: CHILD_RUN_EVENT_TYPE, requestId: "req-1", kind: "sent", childSessionId: "sess-1" };
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

    it("round-trips finalTurnFinishReason \"length\" through terminal events and ChildTerminal; absent => no key; \"stop\" => null", () => {
      // ChildRunEvent terminal variant:
      const withLength = { ...validTerminal, finalTurnFinishReason: "length" as const };
      const parsedEvent = parseChildRunEvent(withLength);
      expect(parsedEvent).toEqual(withLength);
      const parsedAbsent = parseChildRunEvent(validTerminal);
      expect(parsedAbsent && "finalTurnFinishReason" in parsedAbsent).toBe(false);
      expect(parseChildRunEvent({ ...validTerminal, finalTurnFinishReason: "stop" })).toBeNull();

      // ChildTerminal (child host -> main):
      const terminalValid = {
        type: CHILD_TERMINAL_TYPE,
        status: "completed" as const,
        finalText: "the result",
        truncated: false,
        turns: 4,
        toolCalls: 10,
        durationMs: 5000,
      };
      const withLengthTerminal = { ...terminalValid, finalTurnFinishReason: "length" as const };
      expect(parseChildTerminal(withLengthTerminal)).toEqual(withLengthTerminal);
      const parsedTerminalAbsent = parseChildTerminal(terminalValid);
      expect(parsedTerminalAbsent && "finalTurnFinishReason" in parsedTerminalAbsent).toBe(false);
      expect(parseChildTerminal({ ...terminalValid, finalTurnFinishReason: "stop" })).toBeNull();
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

  it("round-trips declaredDoneAtCeiling:true on ChildTerminal and ChildRunEvent terminal; rejects non-true values; absent stays absent (TASK 4149)", () => {
    const withFlag = { ...valid, status: "max_turns" as const, declaredDoneAtCeiling: true };
    expect(parseChildTerminal(withFlag)).toEqual(withFlag);
    expect(parseChildTerminal({ ...withFlag, declaredDoneAtCeiling: false })).toBeNull();
    expect(parseChildTerminal({ ...withFlag, declaredDoneAtCeiling: "yes" })).toBeNull();
    expect("declaredDoneAtCeiling" in (parseChildTerminal(valid) ?? {})).toBe(false);
    const event = {
      type: CHILD_RUN_EVENT_TYPE,
      requestId: "req-1",
      kind: "terminal" as const,
      status: "max_turns" as const,
      finalText: "done",
      truncated: false,
      turns: 3,
      toolCalls: 9,
      durationMs: 1200,
      childSessionId: "sess-1",
      declaredDoneAtCeiling: true as const,
    };
    expect(parseChildRunEvent(event)).toEqual(event);
    expect(parseChildRunEvent({ ...event, declaredDoneAtCeiling: false })).toBeNull();
    const { declaredDoneAtCeiling: _omit, ...plain } = event;
    expect("declaredDoneAtCeiling" in (parseChildRunEvent(plain) ?? {})).toBe(false);
  });

  it("round-trips a ceiling summary on ChildTerminal and ChildRunEvent terminal; rejects malformed ones (TASK.240/4055)", () => {
    const ceiling = { rounds: 2, grantedTurns: 6, lastRefusal: "stalled" as const };
    const withCeiling = { ...valid, status: "max_turns" as const, ceiling };
    expect(parseChildTerminal(withCeiling)).toEqual(withCeiling);
    expect(parseChildTerminal({ ...withCeiling, ceiling: { rounds: 1, grantedTurns: 2 } })).toEqual({
      ...withCeiling,
      ceiling: { rounds: 1, grantedTurns: 2 },
    });
    expect(parseChildTerminal({ ...withCeiling, ceiling: { ...ceiling, lastRefusal: "bogus" } })).toBeNull();
    expect(parseChildTerminal({ ...withCeiling, ceiling: { ...ceiling, remaining: ["a"] } })).toBeNull();
    expect(parseChildTerminal({ ...withCeiling, ceiling: { rounds: -1, grantedTurns: 0 } })).toBeNull();
    expect("ceiling" in (parseChildTerminal(valid) ?? {})).toBe(false);
    const event = {
      type: CHILD_RUN_EVENT_TYPE,
      requestId: "req-1",
      kind: "terminal" as const,
      status: "max_turns" as const,
      finalText: "done",
      truncated: false,
      turns: 3,
      toolCalls: 9,
      durationMs: 1200,
      childSessionId: "sess-1",
      ceiling,
    };
    expect(parseChildRunEvent(event)).toEqual(event);
    expect(parseChildRunEvent({ ...event, ceiling: "x" })).toBeNull();
  });

  // TASK.219: additive model/responseModel on terminal payloads — legacy
  // payloads without them parse unchanged (keys stay absent); invalid types,
  // empty strings, and over-cap values are rejected with the same
  // nonempty-capped model validator (CHILD_MODEL_MAX_CHARS).
  it("round-trips model+responseModel on ChildTerminal and ChildRunEvent terminal; absent keys stay absent (TASK.219)", () => {
    const withModels = { ...valid, model: "booted-model", responseModel: "glm-5.3" };
    expect(parseChildTerminal(withModels)).toEqual(withModels);
    const parsed = parseChildTerminal(valid);
    expect(parsed && "model" in parsed).toBe(false);
    expect(parsed && "responseModel" in parsed).toBe(false);

    const event = {
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
      model: "booted-model",
      responseModel: "glm-5.3",
    };
    expect(parseChildRunEvent(event)).toEqual(event);
    const { model: _m, responseModel: _rm, ...legacy } = event;
    const parsedEvent = parseChildRunEvent(legacy);
    expect(parsedEvent && parsedEvent.kind === "terminal" && "model" in parsedEvent).toBe(false);
    expect(parsedEvent && parsedEvent.kind === "terminal" && "responseModel" in parsedEvent).toBe(false);
  });

  it("rejects invalid model/responseModel values on both parsers (type, empty, over-cap) (TASK.219)", () => {
    expect(parseChildTerminal({ ...valid, model: 42 })).toBeNull();
    expect(parseChildTerminal({ ...valid, model: "" })).toBeNull();
    expect(parseChildTerminal({ ...valid, model: "a".repeat(CHILD_MODEL_MAX_CHARS + 1) })).toBeNull();
    expect(parseChildTerminal({ ...valid, responseModel: [] })).toBeNull();
    expect(parseChildTerminal({ ...valid, responseModel: "a".repeat(CHILD_MODEL_MAX_CHARS + 1) })).toBeNull();

    const baseEvent = {
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
    expect(parseChildRunEvent({ ...baseEvent, model: 42 })).toBeNull();
    expect(parseChildRunEvent({ ...baseEvent, model: "" })).toBeNull();
    expect(parseChildRunEvent({ ...baseEvent, responseModel: "a".repeat(CHILD_MODEL_MAX_CHARS + 1) })).toBeNull();
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

  it("strips unknown additive keys instead of rejecting, returning only known fields (TASK 4239)", () => {
    expect(parseChildTerminal({ ...valid, futureAdditive: { nested: true } })).toEqual(valid);
    expect(parseChildTerminal({ ...valid, childSessionId: "sess-1" })).toEqual(valid);
  });

  it("still fails closed on a malformed known field even when additive keys are present (TASK 4239)", () => {
    expect(parseChildTerminal({ ...valid, turns: "many" })).toBeNull();
    expect(parseChildTerminal({ ...valid, futureAdditive: 1, status: "done" })).toBeNull();
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

// Taskana 4055 cross-review F3: the desktop wire mirror of core's
// CeilingRefusalReason is a hand-copied whitelist. A value added to core and
// missed here would make every terminal carrying it fail closed to null (the
// child's report is discarded). The exhaustive Record below fails to COMPILE
// when core's union grows, and the runtime case proves each core value parses.
const CORE_CEILING_REFUSAL_REASONS: Record<CeilingRefusalReason, true> = {
  ladder_disabled: true,
  rounds_exhausted: true,
  no_successful_tool_calls: true,
  grant_budget_exhausted: true,
  window_collapsed: true,
  unreadable_verdict: true,
  verdict_rejected: true,
  stalled: true,
};

describe("ChildCeilingRefusalReason parity with core's CeilingRefusalReason (Taskana 4055 F3)", () => {
  it.each(Object.keys(CORE_CEILING_REFUSAL_REASONS) as CeilingRefusalReason[])("parses core reason %s on a terminal", (reason) => {
    const terminal = {
      type: CHILD_TERMINAL_TYPE,
      status: "max_turns" as const,
      finalText: "report",
      truncated: false,
      turns: 2,
      toolCalls: 3,
      durationMs: 10,
      ceiling: { rounds: 1, grantedTurns: 1, lastRefusal: reason },
    };
    expect(parseChildTerminal(terminal)).toEqual(terminal);
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

// TASK.180: maxTurns — the creating spawn's turn budget. Absent stays valid;
// a defined value must be a safe integer within 1..CHILD_MAX_TURNS_CEILING.
describe("parseChildSpawnRequest — maxTurns (TASK.180)", () => {
  const valid = {
    type: CHILD_SPAWN_REQUEST_TYPE,
    requestId: "req-mt",
    spawnToolCallId: "call-mt",
    agentType: "general-purpose",
    description: "build the thing",
    prompt: "please build the thing",
    permissionMode: "build",
  };

  it("a payload without maxTurns still parses unchanged (pre-TASK.180 shape)", () => {
    expect(parseChildSpawnRequest(valid)).toEqual(valid);
  });

  it("1 and 200 (the ceiling) are valid and returned verbatim", () => {
    expect(parseChildSpawnRequest({ ...valid, maxTurns: 1 })).toEqual({ ...valid, maxTurns: 1 });
    expect(parseChildSpawnRequest({ ...valid, maxTurns: 200 })).toEqual({ ...valid, maxTurns: 200 });
  });

  it("rejects 0, negatives, fractions, strings, NaN, Infinity, unsafe and over-ceiling numbers", () => {
    expect(parseChildSpawnRequest({ ...valid, maxTurns: 0 })).toBeNull();
    expect(parseChildSpawnRequest({ ...valid, maxTurns: -5 })).toBeNull();
    expect(parseChildSpawnRequest({ ...valid, maxTurns: 2.5 })).toBeNull();
    expect(parseChildSpawnRequest({ ...valid, maxTurns: "8" })).toBeNull();
    expect(parseChildSpawnRequest({ ...valid, maxTurns: NaN })).toBeNull();
    expect(parseChildSpawnRequest({ ...valid, maxTurns: Infinity })).toBeNull();
    expect(parseChildSpawnRequest({ ...valid, maxTurns: 2 ** 53 })).toBeNull();
    expect(parseChildSpawnRequest({ ...valid, maxTurns: 201 })).toBeNull();
  });

  it("the parser returns the budget for a mid-range value", () => {
    expect(parseChildSpawnRequest({ ...valid, maxTurns: 42 })).toMatchObject({ maxTurns: 42 });
  });
});

// Taskana 4820 review F1: the accepted event's additive optional maxTurns —
// the child host's EFFECTIVE turn cap, carried so the parent-side budget
// latch can warn against the cap the child will actually stop at.
describe("parseChildRunEvent — accepted maxTurns (Taskana 4820 F1)", () => {
  const base = {
    type: CHILD_RUN_EVENT_TYPE,
    requestId: "req-acc",
    kind: "accepted" as const,
    childSessionId: "sess-acc",
    childTabId: "tab-acc",
    model: "model-x",
  };

  it("accepts an accepted event carrying a positive integer maxTurns, returned verbatim", () => {
    expect(parseChildRunEvent({ ...base, maxTurns: 40 })).toEqual({ ...base, maxTurns: 40 });
  });

  it("accepts the pre-F1 shape (no maxTurns) unchanged — legacy payloads keep parsing", () => {
    expect(parseChildRunEvent(base)).toEqual(base);
  });

  it("accepted effective maxTurns may exceed the profile ceiling (GitHub #17 slice A)", () => {
    // The accepted event's maxTurns is the child's EFFECTIVE session cap
    // (settings.tools.maxTurns / ANYCODE_MAX_TURNS), not a requested profile
    // budget — so 201/300/MAX_SAFE_INTEGER parse, while non-safe/fractional/
    // non-positive values still fail closed.
    expect(parseChildRunEvent({ ...base, maxTurns: 201 })).toEqual({ ...base, maxTurns: 201 });
    expect(parseChildRunEvent({ ...base, maxTurns: 300 })).toEqual({ ...base, maxTurns: 300 });
    expect(parseChildRunEvent({ ...base, maxTurns: Number.MAX_SAFE_INTEGER })).toEqual({
      ...base,
      maxTurns: Number.MAX_SAFE_INTEGER,
    });
    expect(parseChildRunEvent({ ...base, maxTurns: 0 })).toBeNull();
    expect(parseChildRunEvent({ ...base, maxTurns: -3 })).toBeNull();
    expect(parseChildRunEvent({ ...base, maxTurns: 2.5 })).toBeNull();
    expect(parseChildRunEvent({ ...base, maxTurns: "40" })).toBeNull();
    expect(parseChildRunEvent({ ...base, maxTurns: NaN })).toBeNull();
    expect(parseChildRunEvent({ ...base, maxTurns: Infinity })).toBeNull();
    expect(parseChildRunEvent({ ...base, maxTurns: 2 ** 53 })).toBeNull();
  });
});
