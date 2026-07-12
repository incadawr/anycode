/**

 *
 *  - Session over the worker_threads harness: on ui_ready the strict emission
 *    order is host_ready{sessionId} -> session_history (mapping / 500-cap /
 *    truncated) -> Outbound.replay(); no session_history for a fresh session;
 *    title derived from the first user message exactly once; mode persisted on a
 *    between-turns set_mode.
 *  - boot helpers over a real in-memory SqlitePersistenceAdapter: argv parsing;
 *    `--session <id>` creates with that id; `--resume <id>` of an absent session
 *    creates with the same id + signals resumedMissing; a seeded dangling
 *    tool_call is repaired to unanswered==0 with a synthesized cancelled
 *    tool_result persisted to the DB.
 */

import { describe, expect, it } from "vitest";
import {
  ConversationHistory,
  SqlitePersistenceAdapter,
  WriteBehindHistorySink,
} from "@anycode/core";
import type { HistoryItem } from "@anycode/core";
import type { HostToUiMessage } from "../shared/protocol.js";
import { parseHostArgs, repairDanglingToolCalls, resolveBootSession } from "./boot.js";
import { deriveSessionTitle } from "./session.js";
import { createHarness, textStep } from "./test-harness.js";

type Of<T extends HostToUiMessage["type"]> = Extract<HostToUiMessage, { type: T }>;

const isHostReady = (m: HostToUiMessage): m is Of<"host_ready"> => m.type === "host_ready";
const isSessionHistory = (m: HostToUiMessage): m is Of<"session_history"> =>
  m.type === "session_history";
const isTitleChanged = (m: HostToUiMessage): m is Of<"title_changed"> => m.type === "title_changed";
const agentEventOf =
  (innerType: string) =>
  (m: HostToUiMessage): m is Of<"agent_event"> =>
    m.type === "agent_event" && m.event.type === innerType;

// ── history fixtures ────────────────────────────────────────────────────────

function userItem(id: string, content: string, createdAt = 1): HistoryItem {
  return { id, createdAt, message: { role: "user", content }, tokenEstimate: 3, kind: "normal" };
}

function assistantTextItem(id: string, text: string, createdAt = 2): HistoryItem {
  return {
    id,
    createdAt,
    message: { role: "assistant", content: [{ type: "text", text }] },
    tokenEstimate: 5,
    kind: "normal",
  };
}

function assistantToolCallItem(
  id: string,
  toolCallId: string,
  toolName: string,
  createdAt = 3,
): HistoryItem {
  return {
    id,
    createdAt,
    message: {
      role: "assistant",
      content: [{ type: "tool_call", toolCallId, toolName, input: {} }],
    },
    tokenEstimate: 5,
    kind: "normal",
  };
}

function toolResultItem(
  id: string,
  toolCallId: string,
  toolName: string,
  createdAt = 4,
): HistoryItem {
  return {
    id,
    createdAt,
    message: {
      role: "tool",
      content: [{ type: "tool_result", toolCallId, toolName, text: "ok", status: "success" }],
    },
    tokenEstimate: 2,
    kind: "normal",
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Session — session_history emission order + mapping (design §3.3)
// ═════════════════════════════════════════════════════════════════════════════

describe("Session — session_history hydration", () => {
  it("emits host_ready{sessionId} then session_history then replay, in that order", async () => {
    const bootHistory = [userItem("u1", "hello there"), assistantTextItem("a1", "hi")];
    const h = createHarness({ steps: [textStep("again")], bootHistory, hasTitle: true });
    try {
      h.send({ type: "ui_ready" });
      const history = await h.waitFor(isSessionHistory);

      // First ui_ready: only host_ready + session_history (replay buffer empty).
      expect(h.received.map((m) => m.type)).toEqual(["host_ready", "session_history"]);
      const ready = h.received.find(isHostReady);
      expect(ready?.sessionId).toBe("test-session");
      expect(history.sessionId).toBe("test-session");
      expect(history.truncated).toBe(false);

      // Run a turn so the replay buffer is non-empty, then re-handshake.
      h.send({ type: "user_message", requestId: "r1", text: "go" });
      await h.waitFor(agentEventOf("loop_end"));
      await h.flush();

      const before = h.received.length;
      h.send({ type: "ui_ready" });
      await h.waitUntil(() => h.received.filter(isSessionHistory).length >= 2);
      await h.flush();

      const tail = h.received.slice(before);
      expect(tail[0]?.type).toBe("host_ready");
      expect(tail[1]?.type).toBe("session_history");
      // Everything after is the replayed buffer (turn_started first).
      expect(tail[2]?.type).toBe("turn_started");
      expect(tail.some(agentEventOf("loop_end"))).toBe(true);
    } finally {
      h.close();
    }
  });

  it("maps HistoryItem -> WireHistoryItem (id/createdAt/kind/message, drops tokenEstimate)", async () => {
    const bootHistory: HistoryItem[] = [
      userItem("u1", "first", 100),
      { ...assistantTextItem("a1", "summary", 200), kind: "compact_summary" },
      assistantToolCallItem("a2", "call-1", "Write", 300),
      toolResultItem("t1", "call-1", "Write", 400),
    ];
    const h = createHarness({ steps: [], bootHistory });
    try {
      h.send({ type: "ui_ready" });
      const history = await h.waitFor(isSessionHistory);

      expect(history.items).toHaveLength(4);
      expect(history.items[0]).toEqual({
        id: "u1",
        createdAt: 100,
        kind: "normal",
        message: { role: "user", content: "first" },
      });
      // tokenEstimate must not leak onto the wire item.
      expect(history.items[0]).not.toHaveProperty("tokenEstimate");
      expect(history.items[1]?.kind).toBe("compact_summary");
      expect(history.items[2]?.message).toEqual({
        role: "assistant",
        content: [{ type: "tool_call", toolCallId: "call-1", toolName: "Write", input: {} }],
      });
      expect(history.items[3]?.message).toEqual({
        role: "tool",
        content: [{ type: "tool_result", toolCallId: "call-1", toolName: "Write", text: "ok", status: "success" }],
      });
    } finally {
      h.close();
    }
  });

  it("caps to the last 500 items with truncated:true", async () => {
    const bootHistory: HistoryItem[] = [];
    for (let i = 0; i < 600; i++) {
      bootHistory.push(userItem(`u${i}`, `msg ${i}`, i));
    }
    const h = createHarness({ steps: [], bootHistory });
    try {
      h.send({ type: "ui_ready" });
      const history = await h.waitFor(isSessionHistory);

      expect(history.truncated).toBe(true);
      expect(history.items).toHaveLength(500);
      // The kept window is the LAST 500 (u100..u599).
      expect(history.items[0]?.id).toBe("u100");
      expect(history.items.at(-1)?.id).toBe("u599");
    } finally {
      h.close();
    }
  });

  it("emits NO session_history for a fresh session (empty boot history)", async () => {
    const h = createHarness({ steps: [] });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);
      await h.flush();
      expect(h.received.some(isSessionHistory)).toBe(false);
      expect(h.received[0]?.type).toBe("host_ready");
    } finally {
      h.close();
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Session — title derivation (design §4.2)
// ═════════════════════════════════════════════════════════════════════════════

describe("Session — title derivation", () => {
  it("derives the title from the first user message exactly once (idempotent across turns)", async () => {
    const h = createHarness({ steps: [textStep("a"), textStep("b")] });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      h.send({ type: "user_message", requestId: "r1", text: "First line here\nsecond line" });
      await h.waitFor(agentEventOf("loop_end"));

      expect(h.touches).toEqual([{ title: "First line here" }]);

      // A second turn must NOT re-derive the title.
      h.send({ type: "user_message", requestId: "r2", text: "a wholly different prompt" });
      await h.waitFor(
        (m): m is Of<"turn_started"> => m.type === "turn_started" && m.requestId === "r2",
      );
      await h.flush();
      expect(h.touches).toEqual([{ title: "First line here" }]);
    } finally {
      h.close();
    }
  });

  it("emits title_changed when the heuristic derives a title (Phase 4 slice 4.4-T, design §4)", async () => {
    const h = createHarness({ steps: [textStep("a")] });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);
      h.send({ type: "user_message", requestId: "r1", text: "First line here\nsecond line" });
      const titleChanged = await h.waitFor(isTitleChanged);
      expect(titleChanged.title).toBe("First line here");
      await h.waitFor(agentEventOf("loop_end"));
      // Exactly one title_changed from the heuristic — no refineTitle injected.
      expect(h.received.filter(isTitleChanged)).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it("runs the tier-2 refinement after the first turn's teardown exactly once (amendment A1)", async () => {
    let calls = 0;
    const refineTitle = async (text: string): Promise<string | null> => {
      calls += 1;
      return `Refined: ${text.slice(0, 10)}`;
    };
    const h = createHarness({ steps: [textStep("a"), textStep("b")], refineTitle });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      h.send({ type: "user_message", requestId: "r1", text: "first message" });
      await h.waitFor(agentEventOf("loop_end"));
      // The refinement fires from the SAME turn's teardown (fire-and-forget),
      // so wait for the second title_changed (heuristic, then refinement)
      // rather than a fixed number of macrotask flushes.
      await h.waitUntil(() => h.received.filter(isTitleChanged).length >= 2);

      expect(h.touches).toEqual([
        { title: "first message" },
        { title: "Refined: first mess" },
      ]);
      const titleChangedEvents = h.received.filter(isTitleChanged);
      expect(titleChangedEvents.map((m) => m.title)).toEqual([
        "first message",
        "Refined: first mess",
      ]);
      expect(calls).toBe(1);

      // A second turn must NOT re-trigger the refinement.
      h.send({ type: "user_message", requestId: "r2", text: "a wholly different prompt" });
      await h.waitFor(
        (m): m is Of<"turn_started"> => m.type === "turn_started" && m.requestId === "r2",
      );
      await h.flush();
      expect(calls).toBe(1);
      expect(h.touches).toHaveLength(2);
    } finally {
      h.close();
    }
  });

  it("keeps the heuristic title when refineTitle resolves to null", async () => {
    const refineTitle = async (): Promise<string | null> => null;
    const h = createHarness({ steps: [textStep("a")], refineTitle });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);
      h.send({ type: "user_message", requestId: "r1", text: "first message" });
      await h.waitFor(agentEventOf("loop_end"));
      await h.flush();

      // Only the heuristic's touch/title_changed — a null refinement never
      // writes a second one.
      expect(h.touches).toEqual([{ title: "first message" }]);
      expect(h.received.filter(isTitleChanged)).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it("skips title derivation AND refinement when the boot session already has a title", async () => {
    let calls = 0;
    const refineTitle = async (): Promise<string | null> => {
      calls += 1;
      return "should never run";
    };
    const h = createHarness({ steps: [textStep("a")], hasTitle: true, refineTitle });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);
      h.send({ type: "user_message", requestId: "r1", text: "should not become the title" });
      await h.waitFor(agentEventOf("loop_end"));
      await h.flush();
      expect(h.touches).toEqual([]);
      expect(h.received.filter(isTitleChanged)).toHaveLength(0);
      expect(calls).toBe(0);
    } finally {
      h.close();
    }
  });

  it("caps the derived title at 80 characters (first line only)", () => {
    expect(deriveSessionTitle("short")).toBe("short");
    expect(deriveSessionTitle("  padded  \nrest")).toBe("padded");
    const long = "x".repeat(120);
    expect(deriveSessionTitle(long)).toHaveLength(80);
    expect(deriveSessionTitle("")).toBe("");
    expect(deriveSessionTitle("   \n   ")).toBe("");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Session — mode persistence (design §4.2)
// ═════════════════════════════════════════════════════════════════════════════

describe("Session — mode persistence", () => {
  it("persists the mode via touch on a between-turns set_mode", async () => {
    const h = createHarness({ steps: [textStep("x")] });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);
      h.send({ type: "set_mode", mode: "plan" });
      await h.waitFor((m): m is Of<"mode_changed"> => m.type === "mode_changed");
      await h.flush();
      expect(h.touches).toEqual([{ mode: "plan" }]);
    } finally {
      h.close();
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// boot helpers — argv parsing (design §3.5)
// ═════════════════════════════════════════════════════════════════════════════

describe("parseHostArgs", () => {
  it("parses --session <id> and --session=<id> (create, resume=false)", () => {
    expect(parseHostArgs(["--session", "abc"])).toEqual({ sessionId: "abc", resume: false });
    expect(parseHostArgs(["--session=def"])).toEqual({ sessionId: "def", resume: false });
  });

  it("parses --resume <id> and --resume=<id> (load, resume=true)", () => {
    expect(parseHostArgs(["--resume", "abc"])).toEqual({ sessionId: "abc", resume: true });
    expect(parseHostArgs(["--resume=def"])).toEqual({ sessionId: "def", resume: true });
  });

  it("defaults to no id / resume:false when no session flag is present", () => {
    expect(parseHostArgs([])).toEqual({ sessionId: undefined, resume: false });
    expect(parseHostArgs(["--other", "x"])).toEqual({ sessionId: undefined, resume: false });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// boot helpers — resolveBootSession over real persistence (design §3.5)
// ═════════════════════════════════════════════════════════════════════════════

describe("resolveBootSession", () => {
  it("--session <id> creates a new session with exactly that id", async () => {
    const persistence = new SqlitePersistenceAdapter(":memory:");
    try {
      const result = await resolveBootSession(persistence, {
        args: { sessionId: "given-id", resume: false },
        workspace: "/ws",
        model: "m1",
      });
      expect(result.sessionMeta.id).toBe("given-id");
      expect(result.sessionMeta.mode).toBe("build");
      expect(result.initialHistory).toEqual([]);
      expect(result.resumedMissing).toBe(false);
      expect((await persistence.getSession("given-id"))?.id).toBe("given-id");
    } finally {
      await persistence.close();
    }
  });

  it("no session flag creates a fresh random session", async () => {
    const persistence = new SqlitePersistenceAdapter(":memory:");
    try {
      const result = await resolveBootSession(persistence, {
        args: { resume: false },
        workspace: "/ws",
        model: "m1",
      });
      expect(result.sessionMeta.id).toBeTruthy();
      expect(result.resumedMissing).toBe(false);
      expect((await persistence.getSession(result.sessionMeta.id))?.workspace).toBe("/ws");
    } finally {
      await persistence.close();
    }
  });

  it("--resume of an absent id creates a session with that same id and flags resumedMissing", async () => {
    const persistence = new SqlitePersistenceAdapter(":memory:");
    try {
      const result = await resolveBootSession(persistence, {
        args: { sessionId: "ghost", resume: true },
        workspace: "/ws",
        model: "m1",
      });
      expect(result.sessionMeta.id).toBe("ghost");
      expect(result.resumedMissing).toBe(true);
      expect(result.initialHistory).toEqual([]);
      // Persisted with that same id so a subsequent write-behind flush lands.
      expect((await persistence.getSession("ghost"))?.id).toBe("ghost");
    } finally {
      await persistence.close();
    }
  });

  it("--resume of an existing session loads its meta + history (resumedMissing:false)", async () => {
    const persistence = new SqlitePersistenceAdapter(":memory:");
    try {
      await persistence.createSession({ id: "s1", workspace: "/ws", model: "m1", mode: "plan" });
      await persistence.appendHistory("s1", [userItem("u1", "prior")]);

      const result = await resolveBootSession(persistence, {
        args: { sessionId: "s1", resume: true },
        workspace: "/ws",
        model: "m1",
      });
      expect(result.sessionMeta.id).toBe("s1");
      expect(result.sessionMeta.mode).toBe("plan"); // persisted mode restored
      expect(result.resumedMissing).toBe(false);
      expect(result.initialHistory).toHaveLength(1);
      expect(result.initialHistory[0]?.id).toBe("u1");
    } finally {
      await persistence.close();
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════

// ═════════════════════════════════════════════════════════════════════════════

describe("repairDanglingToolCalls", () => {
  it("closes a dangling tool_call and persists a synthesized cancelled result", async () => {
    const persistence = new SqlitePersistenceAdapter(":memory:");
    try {
      await persistence.createSession({ id: "s1", workspace: "/ws", model: "m1", mode: "build" });
      // Crash mid-turn: assistant tool_call persisted, no matching tool_result.
      await persistence.appendHistory("s1", [
        userItem("u1", "write it"),
        assistantToolCallItem("a1", "call-1", "Write"),
      ]);

      const initialHistory = await persistence.loadHistory("s1");
      const sink = new WriteBehindHistorySink(persistence, "s1");
      const history = new ConversationHistory({ initial: initialHistory, sink });
      expect(history.unansweredToolCallIds()).toEqual(["call-1"]);

      const repaired = await repairDanglingToolCalls(history, sink);
      expect(repaired).toBe(1);
      expect(history.unansweredToolCallIds()).toEqual([]);

      // The synthesized cancelled result reached the DB before any turn.
      const persisted = await persistence.loadHistory("s1");
      expect(persisted).toHaveLength(3);
      const toolItem = persisted[2];
      expect(toolItem?.message.role).toBe("tool");
      if (toolItem?.message.role === "tool") {
        expect(toolItem.message.content).toHaveLength(1);
        expect(toolItem.message.content[0]).toMatchObject({
          type: "tool_result",
          toolCallId: "call-1",
          toolName: "Write",
          status: "cancelled",
        });
      }
    } finally {
      await persistence.close();
    }
  });

  it("is a no-op on a balanced history", async () => {
    const persistence = new SqlitePersistenceAdapter(":memory:");
    try {
      await persistence.createSession({ id: "s1", workspace: "/ws", model: "m1", mode: "build" });
      await persistence.appendHistory("s1", [
        userItem("u1", "write it"),
        assistantToolCallItem("a1", "call-1", "Write"),
        toolResultItem("t1", "call-1", "Write"),
      ]);
      const initialHistory = await persistence.loadHistory("s1");
      const sink = new WriteBehindHistorySink(persistence, "s1");
      const history = new ConversationHistory({ initial: initialHistory, sink });

      const repaired = await repairDanglingToolCalls(history, sink);
      expect(repaired).toBe(0);
      expect(await persistence.loadHistory("s1")).toHaveLength(3);
    } finally {
      await persistence.close();
    }
  });

  it("repairs multiple dangling tool_calls in one assistant message", async () => {
    const persistence = new SqlitePersistenceAdapter(":memory:");
    try {
      await persistence.createSession({ id: "s1", workspace: "/ws", model: "m1", mode: "build" });
      const twoCalls: HistoryItem = {
        id: "a1",
        createdAt: 2,
        message: {
          role: "assistant",
          content: [
            { type: "tool_call", toolCallId: "call-1", toolName: "Read", input: {} },
            { type: "tool_call", toolCallId: "call-2", toolName: "Write", input: {} },
          ],
        },
        kind: "normal",
      };
      await persistence.appendHistory("s1", [userItem("u1", "do both"), twoCalls]);

      const initialHistory = await persistence.loadHistory("s1");
      const sink = new WriteBehindHistorySink(persistence, "s1");
      const history = new ConversationHistory({ initial: initialHistory, sink });

      const repaired = await repairDanglingToolCalls(history, sink);
      expect(repaired).toBe(2);
      expect(history.unansweredToolCallIds()).toEqual([]);
      expect(await persistence.loadHistory("s1")).toHaveLength(4);
    } finally {
      await persistence.close();
    }
  });
});
