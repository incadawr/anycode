import { describe, expect, it } from "vitest";
import type { WireBackgroundChild } from "../../shared/protocol.js";
import type { ClaudeBackgroundTask } from "./claude-background-tasks.js";
import { backgroundBashStarts, deckRowsFrom, tasksForEngine, visibleDeckRows, type AnchorState, type CoreDeckTask, type DeckRow } from "./running-deck.js";

const task = (extra: Partial<ClaudeBackgroundTask> = {}): ClaudeBackgroundTask => ({ type: "claude_background_task", taskId: "t", toolCallId: "call", kind: "bash", description: "npm test", startedAt: 10, status: "running", ...extra });
const child = (extra: Partial<WireBackgroundChild> = {}): WireBackgroundChild => ({ childSessionId: "c", spawnToolCallId: "spawn", agentType: "general-purpose", description: "Explore repo", startedAt: 20, ...extra });
const coreTask = (extra: Partial<CoreDeckTask> = {}): CoreDeckTask => ({ taskId: "k", command: "npm run dev", status: "running", startedAt: 30, ...extra });
const row = (extra: Partial<DeckRow> = {}): DeckRow => ({ key: "task:t", kind: "task", toolCallId: "call", title: "x", typeLabel: "Bash", startedAt: 0, waiting: false, detail: undefined, ...extra });
const anchor = (extra: Partial<AnchorState> = {}): AnchorState => ({ hasCard: true, live: true, above: false, distance: 0, ...extra });

describe("deckRowsFrom", () => {
  it("drops foreground and finished tasks and failed children", () => {
    const rows = deckRowsFrom(
      [task({ taskId: "a" }), task({ taskId: "fg", foreground: true }), task({ taskId: "done", status: "completed" }), task({ taskId: "bad", status: "failed" })],
      [child({ childSessionId: "ok" }), child({ childSessionId: "ended", endedAt: 5 }), child({ childSessionId: "failed", failureReason: "boom" })],
    );
    expect(rows.map(r => r.key)).toEqual(["task:a", "child:ok"]);
  });

  it("anchors rows on toolCallId / spawnToolCallId", () => {
    const rows = deckRowsFrom([task({ toolCallId: "tc" })], [child({ spawnToolCallId: "sp" }), child({ childSessionId: "c2", spawnToolCallId: undefined })]);
    expect(rows.map(r => [r.key, r.toolCallId])).toEqual([["task:t", "tc"], ["child:c", "sp"], ["child:c2", undefined]]);
  });

  it("fills kind, type label, start time and waiting", () => {
    const [t, c] = deckRowsFrom([task({ kind: "monitor" })], [child()]);
    expect(t).toMatchObject({ kind: "task", typeLabel: "Monitor", startedAt: 10, waiting: false });
    expect(c).toMatchObject({ kind: "child", typeLabel: "general-purpose", startedAt: 20, waiting: false });
  });

  it("title falls back from descriptionFor to description to a constant, including empty descriptions", () => {
    const fallback = (t: ClaudeBackgroundTask) => (t.taskId === "x" ? "from input" : undefined);
    const rows = deckRowsFrom(
      [task({ taskId: "x", description: "" }), task({ taskId: "y", description: "own" }), task({ taskId: "z", description: "" })],
      [],
      fallback,
    );
    expect(rows.map(r => r.title)).toEqual(["from input", "own", "Background task"]);
    expect(deckRowsFrom([task({ description: "" })], [])[0]?.title).toBe("Background task");
  });

  it("detail is the task summary or the child's turn and tool counts", () => {
    const rows = deckRowsFrom(
      [task({ taskId: "s", summary: "building" }), task({ taskId: "n" })],
      [child({ childSessionId: "p", turns: 3, toolCalls: 12 }), child({ childSessionId: "q" })],
    );
    expect(rows.map(r => r.detail)).toEqual(["building", undefined, "turn 3 · 12 tools", undefined]);
  });

  it("does not mutate its inputs", () => {
    const tasks = Object.freeze([Object.freeze(task())]);
    const children = Object.freeze([Object.freeze(child())]);
    expect(() => deckRowsFrom(tasks, children)).not.toThrow();
  });
});

describe("visibleDeckRows", () => {
  // Anchors are keyed by row key (what useDeckAnchors returns), never by toolCallId.
  it("lists rows without an anchor, without a card, or whose card is not live", () => {
    const rows = [row({ key: "a", toolCallId: undefined }), row({ key: "b", toolCallId: "call-b" }), row({ key: "c", toolCallId: "call-c" })];
    const anchors = new Map([["b", anchor({ hasCard: false })], ["c", anchor({ live: false })]]);
    expect(visibleDeckRows(rows, anchors).map(r => r.key)).toEqual(["a", "b", "c"]);
  });

  it("hides a live card that is visible and shows one that is above", () => {
    const rows = [row({ key: "vis", toolCallId: "call-vis" }), row({ key: "up", toolCallId: "call-up" })];
    const anchors = new Map([["vis", anchor({ above: false })], ["up", anchor({ above: true })]]);
    expect(visibleDeckRows(rows, anchors).map(r => r.key)).toEqual(["up"]);
  });

  it("orders card-less rows newest first (ties by key), then live-above rows nearest the viewport top first", () => {
    const rows = [
      row({ key: "far", toolCallId: "call-far", startedAt: 99 }),
      row({ key: "old", toolCallId: undefined, startedAt: 1 }),
      row({ key: "tieB", toolCallId: undefined, startedAt: 5 }),
      row({ key: "near", toolCallId: "call-near", startedAt: 0 }),
      row({ key: "tieA", toolCallId: undefined, startedAt: 5 }),
      row({ key: "new", toolCallId: undefined, startedAt: 8 }),
    ];
    const anchors = new Map([["far", anchor({ above: true, distance: -300 })], ["near", anchor({ above: true, distance: -40 })]]);
    expect(visibleDeckRows(rows, anchors).map(r => r.key)).toEqual(["new", "tieA", "tieB", "old", "near", "far"]);
  });

  it("does not mutate its inputs", () => {
    const rows = Object.freeze([row({ key: "b", toolCallId: undefined, startedAt: 1 }), row({ key: "a", toolCallId: undefined, startedAt: 2 })]);
    expect(visibleDeckRows(rows, new Map()).map(r => r.key)).toEqual(["a", "b"]);
    expect(rows.map(r => r.key)).toEqual(["b", "a"]);
  });
});

describe("core tasks (the engine DeepSeek and other providers run on)", () => {
  it("lists only running core tasks, as card-less Bash rows", () => {
    const rows = deckRowsFrom([], [], undefined, [coreTask({ taskId: "a" }), coreTask({ taskId: "done", status: "completed" }), coreTask({ taskId: "bad", status: "failed" })]);
    expect(rows).toEqual([{ key: "core:a", kind: "task", toolCallId: undefined, title: "npm run dev", typeLabel: "Bash", startedAt: 30, waiting: false, detail: undefined }]);
  });

  it("titles by description and keeps the command as the detail line", () => {
    const [r] = deckRowsFrom([], [], undefined, [coreTask({ description: "Dev server" })]);
    expect(r).toMatchObject({ title: "Dev server", detail: "npm run dev" });
    expect(deckRowsFrom([], [], undefined, [coreTask({ command: "", description: undefined })])[0]?.title).toBe("Background task");
  });

  it("orders Claude tasks, then core tasks, then children, and a core row never waits for a card", () => {
    const rows = deckRowsFrom([task({ taskId: "c" })], [child()], undefined, [coreTask()]);
    expect(rows.map(r => r.key)).toEqual(["task:c", "core:k", "child:c"]);
    expect(visibleDeckRows(rows.filter(r => r.key === "core:k"), new Map()).map(r => r.key)).toEqual(["core:k"]);
  });
});

describe("tasksForEngine", () => {
  const claude = [task()];
  const core = [coreTask()];
  it("counts only the list of the engine that is live", () => {
    expect(tasksForEngine("claude", claude, core)).toEqual({ claude, core: [] });
    expect(tasksForEngine("core", claude, core)).toEqual({ claude: [], core });
    expect(tasksForEngine("codex", claude, core)).toEqual({ claude: [], core: [] });
  });
  it("reads a missing engine as core, as a core store has no engine block", () => {
    expect(tasksForEngine(undefined, claude, core)).toEqual({ claude: [], core });
  });
  it("returns the same empty list every time, so a shallow selector stays stable", () => {
    expect(tasksForEngine("codex", claude, core).claude).toBe(tasksForEngine("codex", claude, core).claude);
  });
});

describe("backgroundBashStarts", () => {
  const bash = (id: string, input: unknown, status: string = "success", toolName = "Bash") =>
    ({ kind: "tool_call", id, toolCallId: id, toolName, input, status }) as never;
  it("lists only Bash calls that returned and asked to run in the background", () => {
    const ids = backgroundBashStarts([
      bash("a", { command: "x", run_in_background: true }),
      bash("b", { command: "x" }),
      bash("c", { command: "x", run_in_background: false }),
      bash("d", { command: "x", run_in_background: true }, "running"),
      bash("e", { command: "x", run_in_background: true }, "error"),
      bash("f", { run_in_background: true }, "success", "Read"),
      bash("g", null),
      { kind: "assistant_text", id: "h", text: "x" } as never,
    ]);
    expect(ids).toEqual(["a"]);
  });
});
