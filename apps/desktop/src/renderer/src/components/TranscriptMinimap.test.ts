/**
 * TASK.48 / Taskana 4086 — tests for the transcript minimap. Same jsdom-free
 * discipline as ToolCallStack.test.ts: pure-logic units for the projection
 * (`selectUserTurns`/`excerpt`/`basenameOf`/`shouldShowMinimap`/
 * `activeMarkIndex`) plus `renderToStaticMarkup` (react-dom/server) renders
 * that pin the component's DOM contract (mark buttons, active class, preview
 * rows) without touching any DOM API — works under this package's plain
 * "node" vitest environment.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  PREVIEW_FILES_MAX,
  TranscriptMinimap,
  activeMarkIndex,
  basenameOf,
  excerpt,
  selectUserTurns,
  shouldShowMinimap,
  type UserTurnMark,
} from "./TranscriptMinimap.js";
import type { ToolCallBlock, TranscriptBlock } from "../store.js";

function mkUser(id: string, text: string, extra: Partial<Extract<TranscriptBlock, { kind: "user_text" }>> = {}): TranscriptBlock {
  return { kind: "user_text", id, text, ...extra };
}

function mkAssistant(id: string, text: string): TranscriptBlock {
  return { kind: "assistant_text", id, text };
}

function mkTool(overrides: Partial<ToolCallBlock> = {}): ToolCallBlock {
  return {
    kind: "tool_call",
    id: "tc",
    toolCallId: "tc",
    toolName: "Bash",
    input: { command: "ls" },
    status: "success",
    modelText: null,
    snapshots: { before: null, after: null },
    subagent: null,
    workflow: null,
    ...overrides,
  };
}

describe("excerpt", () => {
  it("passes short text through unchanged", () => {
    expect(excerpt("hello world", 20)).toBe("hello world");
  });

  it("truncates long text to <= max chars with an ellipsis on a word boundary", () => {
    const out = excerpt("alpha beta gamma delta epsilon zeta", 20);
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out.endsWith("…")).toBe(true);
    expect(out).toBe("alpha beta gamma…");
  });

  it("collapses whitespace and newlines to single spaces", () => {
    expect(excerpt("a\n\n  b\t\tc   d", 100)).toBe("a b c d");
  });

  it("returns the empty string for empty input", () => {
    expect(excerpt("", 10)).toBe("");
  });
});

describe("basenameOf", () => {
  it("takes the last posix segment", () => {
    expect(basenameOf("a/b/c.ts")).toBe("c.ts");
  });

  it("returns a bare filename as-is", () => {
    expect(basenameOf("c.ts")).toBe("c.ts");
  });

  it("trims a trailing slash before splitting", () => {
    expect(basenameOf("a/b/")).toBe("b");
  });

  it("splits windows separators too", () => {
    expect(basenameOf("a\\b\\c.ts")).toBe("c.ts");
  });
});

describe("selectUserTurns", () => {
  it("returns [] for an empty transcript", () => {
    expect(selectUserTurns([])).toEqual([]);
  });

  it("splits turns at eligible user blocks and accrues answers/tools per turn", () => {
    const blocks: TranscriptBlock[] = [
      mkUser("u1", "first question"),
      mkAssistant("a1", "first answer"),
      mkTool({ id: "t1", toolCallId: "t1", toolName: "Read", input: { file_path: "src/a.ts" } }),
      mkUser("u2", "second question"),
      mkAssistant("a2", "second answer"),
    ];
    const marks = selectUserTurns(blocks);
    expect(marks).toHaveLength(2);
    expect(marks[0]!.id).toBe("u1");
    expect(marks[0]!.files).toEqual(["a.ts"]);
    expect(marks[0]!.answerText).toBe("first answer");
    expect(marks[0]!.toolCallCount).toBe(1);
    expect(marks[1]!.id).toBe("u2");
    expect(marks[1]!.answerText).toBe("second answer");
    expect(marks[1]!.files).toEqual([]);
  });

  it("system-origin user blocks do not open (nor close) a turn", () => {
    const blocks: TranscriptBlock[] = [
      mkUser("u1", "real question"),
      mkAssistant("a1", "part one"),
      mkUser("s1", "child report", { origin: "system" }),
      mkAssistant("a2", "part two"),
      mkUser("u2", "next question"),
    ];
    const marks = selectUserTurns(blocks);
    expect(marks).toHaveLength(2);
    // The system block's following assistant text accrues to the OPEN turn.
    expect(marks[0]!.answerText).toBe("part one\npart two");
    expect(marks[1]!.answerText).toBe("");
  });

  it("a turn with no answer yet has answerText === ''", () => {
    const marks = selectUserTurns([mkUser("u1", "q"), mkUser("u2", "q2"), mkAssistant("a", "late")]);
    expect(marks[0]!.answerText).toBe("");
    expect(marks[1]!.answerText).toBe("late");
  });

  it("files: distinct basenames, first-appearance order, capped at PREVIEW_FILES_MAX", () => {
    const paths = ["p/1.ts", "p/2.ts", "p/3.ts", "p/4.ts", "p/5.ts", "p/6.ts", "p/7.ts", "p/8.ts"];
    const blocks: TranscriptBlock[] = [
      mkUser("u1", "q"),
      ...paths.map((file_path, i) =>
        mkTool({ id: `t${i}`, toolCallId: `t${i}`, toolName: "Read", input: { file_path } }),
      ),
    ];
    const marks = selectUserTurns(blocks);
    expect(marks[0]!.files).toHaveLength(PREVIEW_FILES_MAX);
    expect(marks[0]!.files).toEqual(["1.ts", "2.ts", "3.ts", "4.ts", "5.ts", "6.ts"]);
    // toolCallCount still counts the tools the file cap stopped tracking.
    expect(marks[0]!.toolCallCount).toBe(8);
  });

  it("files: Write/Edit recognized, Grep/Bash ignored, duplicates and non-string file_path ignored", () => {
    const blocks: TranscriptBlock[] = [
      mkUser("u1", "q"),
      mkTool({ id: "w1", toolCallId: "w1", toolName: "Write", input: { file_path: "src/x.ts", content: "" } }),
      mkTool({ id: "e1", toolCallId: "e1", toolName: "Edit", input: { file_path: "src/x.ts", old_string: "a", new_string: "b" } }),
      mkTool({ id: "g1", toolCallId: "g1", toolName: "Grep", input: { pattern: "x", path: "src" } }),
      mkTool({ id: "b1", toolCallId: "b1", toolName: "Bash", input: { command: "ls" } }),
      mkTool({ id: "r1", toolCallId: "r1", toolName: "Read", input: { file_path: 42 } }),
    ];
    const marks = selectUserTurns(blocks);
    expect(marks[0]!.files).toEqual(["x.ts"]);
    expect(marks[0]!.toolCallCount).toBe(5);
  });

  it("toolCallCount counts proposed/running calls too (a live turn's tools are part of its story)", () => {
    const blocks: TranscriptBlock[] = [
      mkUser("u1", "q"),
      mkTool({ id: "p1", toolCallId: "p1", status: "proposed" }),
      mkTool({ id: "r1", toolCallId: "r1", status: "running" }),
    ];
    expect(selectUserTurns(blocks)[0]!.toolCallCount).toBe(2);
  });

  it("marks preserve source order and carry the user block's id verbatim", () => {
    const blocks: TranscriptBlock[] = [
      mkAssistant("pre", "leading assistant text with no open turn"),
      mkUser("u-z", "q"),
      mkAssistant("a", "ans"),
      mkUser("u-a", "q2"),
    ];
    const marks = selectUserTurns(blocks);
    expect(marks.map((m) => m.id)).toEqual(["u-z", "u-a"]);
    expect(marks.map((m) => m.index)).toEqual([1, 3]);
  });
});

describe("shouldShowMinimap", () => {
  it("hides below 3 turns", () => {
    expect(shouldShowMinimap(0)).toBe(false);
    expect(shouldShowMinimap(1)).toBe(false);
    expect(shouldShowMinimap(2)).toBe(false);
  });

  it("shows from 3 turns up", () => {
    expect(shouldShowMinimap(3)).toBe(true);
    expect(shouldShowMinimap(10)).toBe(true);
  });
});

describe("activeMarkIndex", () => {
  const marks = [1, 2, 3, 4, 5].map((index) => ({ index })) as unknown as UserTurnMark[];

  it("returns the index when in range", () => {
    expect(activeMarkIndex(marks, 2)).toBe(2);
  });

  it("clamps high to the last mark", () => {
    expect(activeMarkIndex(marks, 99)).toBe(4);
  });

  it("clamps low to the first mark", () => {
    expect(activeMarkIndex(marks, -1)).toBe(0);
  });

  it("null stays null", () => {
    expect(activeMarkIndex(marks, null)).toBe(null);
  });
});

describe("TranscriptMinimap (SSR component render)", () => {
  function renderMinimap(props: { marks: UserTurnMark[]; activeIndex?: number | null }): string {
    return renderToStaticMarkup(
      createElement(TranscriptMinimap, { marks: props.marks, activeIndex: props.activeIndex ?? null, onJump: () => {} }),
    );
  }

  const marks: UserTurnMark[] = [
    { id: "u1", index: 0, questionExcerpt: "first question", answerText: "first answer", files: ["a.ts"], toolCallCount: 1 },
    { id: "u2", index: 3, questionExcerpt: "second question", answerText: "", files: [], toolCallCount: 0 },
  ];

  it("renders one .minimap-mark per mark with data-mark-index, data-mark-block-id and Turn aria-label", () => {
    const html = renderMinimap({ marks });
    expect((html.match(/class="minimap-mark(?:\s[^"]*)?"/g) ?? []).length).toBe(2);
    expect(html).toContain('data-mark-index="0"');
    expect(html).toContain('data-mark-index="1"');
    expect(html).toContain('data-mark-block-id="u1"');
    expect(html).toContain('data-mark-block-id="u2"');
    // A minimap button must never carry `data-block-id`: jumpToBlock and the
    // automation block-count probe query that attribute across .message-list.
    expect(html).not.toMatch(/\sdata-block-id=/);
    expect(html).toContain('aria-label="Turn 1: first question"');
    expect(html).toContain('aria-label="Turn 2: second question"');
    expect(html).toContain('role="navigation"');
  });

  it("the active mark carries minimap-mark-active", () => {
    const html = renderMinimap({ marks, activeIndex: 1 });
    expect(html).toContain('class="minimap-mark minimap-mark-active" data-mark-index="1"');
    expect(html).not.toContain('minimap-mark-active" data-mark-index="0"');
  });

  it("marks: [] renders an empty container string (no minimap-mark nodes)", () => {
    const html = renderMinimap({ marks: [] });
    expect(html.includes("minimap-mark")).toBe(false);
  });
});
