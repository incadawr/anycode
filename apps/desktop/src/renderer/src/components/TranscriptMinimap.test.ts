/**
 * TASK.48 / Taskana 4086 — tests for the transcript minimap. Same jsdom-free
 * discipline as ToolCallStack.test.ts: pure-logic units for the projection
 * (`selectUserTurns`/`summarizeTurn`/`excerpt`/`basenameOf`/
 * `shouldShowMinimap`/`activeMarkIndex`, the memoized
 * `createUserTurnsSelector`, the roving-index handler) plus
 * `renderToStaticMarkup` (react-dom/server) renders that pin the component's
 * DOM contract (mark buttons, active class, preview rows,
 * aria-describedby/roving-tabindex wiring) without touching any DOM API —
 * works under this package's plain "node" vitest environment.
 *
 * 4086 follow-up coverage (brief §4): incremental memoization (a streaming
 * update to the last turn must not recompute earlier turns — counted),
 * excerpt caps during the walk, and the roving-index key handler.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ANSWER_SCAN_CHARS,
  PREVIEW_ANSWER_MAX,
  PREVIEW_FILES_MAX,
  TranscriptMinimap,
  activeMarkIndex,
  basenameOf,
  createUserTurnsSelector,
  excerpt,
  markDescribedBy,
  rovingIndexFromKey,
  selectUserTurns,
  shouldShowMinimap,
  summarizeTurn,
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
    expect(marks[0]!.answerExcerpt).toBe("first answer");
    expect(marks[0]!.toolCallCount).toBe(1);
    expect(marks[1]!.id).toBe("u2");
    expect(marks[1]!.answerExcerpt).toBe("second answer");
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
    // (answerExcerpt is the whitespace-collapsed excerpt, so the "\n" join
    // renders as a single space.)
    expect(marks[0]!.answerExcerpt).toBe("part one part two");
    expect(marks[1]!.answerExcerpt).toBe("");
  });

  it("a turn with no answer yet has answerExcerpt === ''", () => {
    const marks = selectUserTurns([mkUser("u1", "q"), mkUser("u2", "q2"), mkAssistant("a", "late")]);
    expect(marks[0]!.answerExcerpt).toBe("");
    expect(marks[1]!.answerExcerpt).toBe("late");
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

  it("answer excerpts are capped at PREVIEW_ANSWER_MAX even for a huge answer", () => {
    const paragraph = "word ".repeat(50); // 250 chars
    const blocks: TranscriptBlock[] = [
      mkUser("u1", "q"),
      ...Array.from({ length: 40 }, (_, i) => mkAssistant(`a${i}`, paragraph)), // 10k chars
    ];
    const mark = selectUserTurns(blocks)[0]!;
    expect(mark.answerExcerpt.length).toBeLessThanOrEqual(PREVIEW_ANSWER_MAX);
    expect(mark.answerExcerpt.endsWith("…")).toBe(true);
  });

  it("tool metadata past the answer-text cap is still tracked (the cap bounds the string, not the turn)", () => {
    const big = "x".repeat(ANSWER_SCAN_CHARS); // exhausts the scan budget in one block
    const blocks: TranscriptBlock[] = [
      mkUser("u1", "q"),
      mkAssistant("a1", big),
      mkTool({ id: "t1", toolCallId: "t1", toolName: "Read", input: { file_path: "src/late.ts" } }),
      mkAssistant("a2", "never scanned"),
    ];
    const mark = selectUserTurns(blocks)[0]!;
    expect(mark.toolCallCount).toBe(1);
    expect(mark.files).toEqual(["late.ts"]);
    expect(mark.answerExcerpt.length).toBeLessThanOrEqual(PREVIEW_ANSWER_MAX);
  });
});

describe("summarizeTurn (excerpt caps during the walk)", () => {
  it("stops scanning assistant text after ANSWER_SCAN_CHARS raw chars but keeps counting tool calls", () => {
    // 100 blocks x 10 chars = 1000 raw chars > ANSWER_SCAN_CHARS (800): the
    // walk stops scanning after the budget, but the collapsed remainder is
    // still far past the excerpt cap, so the final excerpt is identical to
    // an uncapped walk's.
    const ten = "0123456789";
    const scannedAll = summarizeTurn(
      [mkUser("u1", "q"), ...Array.from({ length: 100 }, (_, i) => mkAssistant(`a${i}`, ten))],
      0,
      101,
    );
    // The accumulator holds 1000 raw chars; the final excerpt is the capped,
    // ellipsis-terminated prefix: 18 whole "0123456789" groups + "…" (the
    // word-boundary cut trims the partial 19th group to the last full word).
    expect(scannedAll.answerExcerpt.length).toBeLessThanOrEqual(PREVIEW_ANSWER_MAX);
    expect(scannedAll.answerExcerpt.endsWith("…")).toBe(true);
    expect(scannedAll.answerExcerpt.startsWith("0123456789")).toBe(true);
    expect(scannedAll.answerExcerpt).toBe(`${Array.from({ length: 18 }, () => "0123456789").join(" ")}…`);

    // Now ONE block larger than the budget: the walk must take at most
    // ANSWER_SCAN_CHARS from it (slice, never the whole body).
    const huge = "y".repeat(ANSWER_SCAN_CHARS * 3);
    const capped = summarizeTurn([mkUser("u1", "q"), mkAssistant("a1", huge)], 0, 2);
    expect(capped.answerExcerpt).toBe("y".repeat(PREVIEW_ANSWER_MAX - 1) + "…");
  });

  it("a single huge hydrated block is sliced to the budget, not copied whole", () => {
    const huge = "z".repeat(50_000);
    const mark = summarizeTurn([mkUser("u1", "q"), mkAssistant("a1", huge)], 0, 2);
    expect(mark.answerExcerpt.length).toBe(PREVIEW_ANSWER_MAX);
  });
});

describe("createUserTurnsSelector (incremental memoization)", () => {
  function threeTurnBlocks(): TranscriptBlock[] {
    return [
      mkUser("u1", "first question"),
      mkAssistant("a1", "first answer"),
      mkUser("u2", "second question"),
      mkAssistant("a2", "second answer"),
      mkUser("u3", "third question"),
      mkAssistant("a3", "third answer"),
    ];
  }

  it("first call computes every turn; an identical second call recomputes none", () => {
    const selector = createUserTurnsSelector();
    const blocks = threeTurnBlocks();
    selector(blocks);
    expect(selector.recomputed).toEqual([0, 1, 2]);
    selector(blocks);
    expect(selector.recomputed).toEqual([]);
  });

  it("a streaming update to the LAST turn does not recompute the earlier turns (counted)", () => {
    const selector = createUserTurnsSelector();
    const blocks = threeTurnBlocks();
    selector(blocks);
    expect(selector.recomputed).toEqual([0, 1, 2]);

    // rAF-flushed text_delta: same ids, a3's text grew — only turn 3 reprojects.
    const streamed = blocks.map((block) =>
      block.kind === "assistant_text" && block.id === "a3" ? { ...block, text: `${block.text} more streamed text` } : block,
    );
    const marks = selector(streamed);
    expect(selector.recomputed).toEqual([2]);
    // The reprojection is visible in the output, the earlier turns are reused verbatim.
    expect(marks[2]!.answerExcerpt).toContain("more streamed text");
    expect(marks[0]!.answerExcerpt).toBe("first answer");
    expect(marks[1]!.answerExcerpt).toBe("second answer");

    // Another delta to the same tail: still only the streamed turn.
    const streamed2 = streamed.map((block) =>
      block.kind === "assistant_text" && block.id === "a3" ? { ...block, text: `${block.text} tail` } : block,
    );
    selector(streamed2);
    expect(selector.recomputed).toEqual([2]);
  });

  it("a newly appended block to the open turn invalidates only that turn", () => {
    const selector = createUserTurnsSelector();
    const blocks = threeTurnBlocks();
    selector(blocks);
    const appended = [...blocks, mkTool({ id: "t9", toolCallId: "t9", toolName: "Read", input: { file_path: "x.ts" } })];
    const marks = selector(appended);
    expect(selector.recomputed).toEqual([2]);
    expect(marks[2]!.toolCallCount).toBe(1);
    expect(marks[2]!.files).toEqual(["x.ts"]);
  });

  it("a NEW user turn reuses every earlier turn's summary", () => {
    const selector = createUserTurnsSelector();
    const blocks = threeTurnBlocks();
    selector(blocks);
    const withNewTurn = [...blocks, mkUser("u4", "fourth question"), mkAssistant("a4", "fourth answer")];
    const marks = selector(withNewTurn);
    expect(selector.recomputed).toEqual([3]);
    expect(marks).toHaveLength(4);
    expect(marks[3]!.id).toBe("u4");
  });

  it("an earlier turn's content change invalidates only that turn (its closing block changed; suffixes' didn't)", () => {
    const selector = createUserTurnsSelector();
    const blocks = threeTurnBlocks();
    selector(blocks);
    // Not a streaming shape (the store never patches non-tail text), but the
    // selector must stay CORRECT: turn 0's closing block changed -> turn 0
    // recomputes; turns 1/2 keep identical ranges (same start index, same
    // closing block), so their cached summaries remain valid.
    const edited = blocks.map((block) =>
      block.kind === "assistant_text" && block.id === "a1" ? { ...block, text: "edited first answer" } : block,
    );
    const marks = selector(edited);
    expect(selector.recomputed).toEqual([0]);
    expect(marks[0]!.answerExcerpt).toBe("edited first answer");
  });

  it("an identical-repeat input reuses marks without recomputing anything", () => {
    const selector = createUserTurnsSelector();
    const blocks = threeTurnBlocks();
    const first = selector(blocks);
    const second = selector(blocks);
    expect(selector.recomputed).toEqual([]);
    expect(second).toEqual(first);
  });

  it("independent selectors do not share a memo (two tabs)", () => {
    const a = createUserTurnsSelector();
    const b = createUserTurnsSelector();
    const blocks = threeTurnBlocks();
    a(blocks);
    // b has its own cache: full compute on its first call.
    b(blocks);
    expect(b.recomputed).toEqual([0, 1, 2]);
    // a's cache is untouched by b's call — its last run recomputed nothing.
    a(blocks);
    expect(a.recomputed).toEqual([]);
  });

  it("agrees with selectUserTurns on a mixed transcript (memoization is unobservable)", () => {
    const selector = createUserTurnsSelector();
    const blocks: TranscriptBlock[] = [
      mkAssistant("pre", "orphan leading text"),
      mkUser("u1", "first"),
      mkUser("s1", "system report", { origin: "system" }),
      mkAssistant("a1", "answer one"),
      mkTool({ id: "t1", toolCallId: "t1", toolName: "Edit", input: { file_path: "a/b.ts" } }),
      mkUser("u2", "second"),
      mkAssistant("a2", "answer two"),
      mkUser("u3", "third"),
    ];
    const direct = selectUserTurns(blocks);
    const memoized = selector(blocks);
    expect(memoized).toEqual(direct);
    // And again after a tail stream into the (open, toolless) third turn.
    const streamed = [...blocks, mkAssistant("a3", "answer three")];
    expect(selector(streamed)).toEqual(selectUserTurns(streamed));
    expect(selector.recomputed).toEqual([2]);
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

describe("rovingIndexFromKey (roving-tabindex key handler)", () => {
  it("ArrowDown moves down one, clamped at the last dot", () => {
    expect(rovingIndexFromKey("ArrowDown", 0, 5)).toBe(1);
    expect(rovingIndexFromKey("ArrowDown", 4, 5)).toBe(4);
  });

  it("ArrowUp moves up one, clamped at the first dot", () => {
    expect(rovingIndexFromKey("ArrowUp", 3, 5)).toBe(2);
    expect(rovingIndexFromKey("ArrowUp", 0, 5)).toBe(0);
  });

  it("Home/End jump to the first/last dot", () => {
    expect(rovingIndexFromKey("Home", 3, 5)).toBe(0);
    expect(rovingIndexFromKey("End", 0, 5)).toBe(4);
  });

  it("every other key is a no-op (Tab stays the browser's)", () => {
    expect(rovingIndexFromKey("Tab", 2, 5)).toBe(2);
    expect(rovingIndexFromKey("Enter", 2, 5)).toBe(2);
    expect(rovingIndexFromKey("ArrowLeft", 2, 5)).toBe(2);
    expect(rovingIndexFromKey("a", 2, 5)).toBe(2);
  });

  it("a single-dot minimap pins the roving index at 0", () => {
    expect(rovingIndexFromKey("ArrowDown", 0, 1)).toBe(0);
    expect(rovingIndexFromKey("End", 0, 1)).toBe(0);
  });
});

describe("markDescribedBy (aria-describedby link)", () => {
  it("the hovered/focused dot references the preview; every other dot gets undefined", () => {
    expect(markDescribedBy(1, 1, "minimap-preview-r1")).toBe("minimap-preview-r1");
    expect(markDescribedBy(1, 0, "minimap-preview-r1")).toBeUndefined();
    expect(markDescribedBy(null, 0, "minimap-preview-r1")).toBeUndefined();
  });
});

describe("TranscriptMinimap (SSR component render)", () => {
  function renderMinimap(props: { marks: UserTurnMark[]; activeIndex?: number | null }): string {
    return renderToStaticMarkup(
      createElement(TranscriptMinimap, { marks: props.marks, activeIndex: props.activeIndex ?? null, onJump: () => {} }),
    );
  }

  const marks: UserTurnMark[] = [
    { id: "u1", index: 0, questionExcerpt: "first question", answerExcerpt: "first answer", files: ["a.ts"], toolCallCount: 1 },
    { id: "u2", index: 3, questionExcerpt: "second question", answerExcerpt: "", files: [], toolCallCount: 0 },
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

  it("roving tabindex: exactly ONE dot carries tabIndex=0, the rest -1", () => {
    const html = renderMinimap({ marks });
    expect((html.match(/tabindex="0"/g) ?? []).length).toBe(1);
    expect((html.match(/tabindex="-1"/g) ?? []).length).toBe(1);
    // The first dot holds the stop initially.
    expect(html).toContain('tabindex="0"');
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

  it("no hover in static markup: no preview card, no aria-describedby", () => {
    const html = renderMinimap({ marks });
    expect(html).not.toContain("minimap-preview");
    expect(html).not.toContain("aria-describedby");
  });
});
