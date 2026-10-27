/**
 * TASK.48 / Taskana 4086 + 4742 — tests for the transcript tick rail (the
 * evolved TranscriptMinimap). Same jsdom-free discipline as
 * ToolCallStack.test.ts: pure-logic units for the projection
 * (`selectUserTurns`/`summarizeTurn`/`excerpt`, the memoized
 * `createUserTurnsSelector`, the roving-index handler, the 4742 popover
 * open-state reducer and tick-length/aria helpers) plus
 * `renderToStaticMarkup` (react-dom/server) renders that pin the
 * component's DOM contract (tick buttons, active class, popover plain-text
 * query, rewind gating) without touching any DOM API — works under this
 * package's plain "node" vitest environment.
 *
 * 4086 follow-up coverage: incremental memoization (a streaming update to
 * the last turn must not recompute earlier turns — counted), excerpt caps.
 * 4742 coverage: threshold 2, question budget 240, short aria labels, and
 * the hover/focus/close-delay popover state machine. The stateFUL wiring
 * (hover -> popover -> rewind confirm -> onRewind) lives in
 * TranscriptMinimap.harness.test.ts, the SettingsScreen.test.ts-style
 * slot-backed-hooks harness — a separate file because its vi.mock("react")
 * must be module-level, which would break this file's real-hook SSR renders.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ARIA_LABEL_MAX,
  POPOVER_CLOSE_DELAY_MS,
  PREVIEW_QUESTION_MAX,
  TranscriptMinimap,
  activeMarkIndex,
  createUserTurnsSelector,
  excerpt,
  markDescribedBy,
  nextOpenState,
  popoverCounterText,
  rovingIndexFromKey,
  rewindUserTurnTexts,
  countUserTurns,
  selectUserTurns,
  shouldShowMinimap,
  summarizeTurn,
  tickLengthFor,
  type PopoverState,
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

describe("selectUserTurns", () => {
  it("returns [] for an empty transcript", () => {
    expect(selectUserTurns([])).toEqual([]);
  });

  it("splits turns at eligible user blocks; the mark carries id/index/question only (4742 dropped the answer/files/tool preview)", () => {
    const blocks: TranscriptBlock[] = [
      mkUser("u1", "first question"),
      mkAssistant("a1", "first answer"),
      mkTool({ id: "t1", toolCallId: "t1", toolName: "Read", input: { file_path: "src/a.ts" } }),
      mkUser("u2", "second question"),
      mkAssistant("a2", "second answer"),
    ];
    const marks = selectUserTurns(blocks);
    expect(marks).toHaveLength(2);
    expect(marks[0]).toEqual({ id: "u1", index: 0, questionExcerpt: "first question" });
    expect(marks[1]).toEqual({ id: "u2", index: 3, questionExcerpt: "second question" });
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
    expect(marks.map((m) => m.id)).toEqual(["u1", "u2"]);
  });

  it("counts authenticated agent deliveries as labeled turns while excluding reports", () => {
    const blocks: TranscriptBlock[] = [
      mkUser("agent-message:1", "envelope metadata\nfirst agent message\nDelivery: queued", { origin: "system", agentMessage: true, agentMessagePayload: "first agent message" }),
      mkUser("report", "child report", { origin: "system" }),
      mkUser("agent-message:2", "second agent message", { origin: "system", agentMessage: true }),
      mkUser("human", "human question"),
    ];
    const marks = selectUserTurns(blocks);
    expect(marks.map((mark) => mark.id)).toEqual(["agent-message:1", "agent-message:2", "human"]);
    expect(marks[0]?.agentMessage).toBe(true);
    expect(countUserTurns(blocks)).toBe(3);
    expect(shouldShowMinimap(marks.length)).toBe(true);
    expect(createUserTurnsSelector()(blocks)).toEqual(marks);
    expect(rewindUserTurnTexts(blocks)).toEqual(["", "", "human question"]);
    const html = renderToStaticMarkup(createElement(TranscriptMinimap, { marks, activeIndex: 0, onJump: () => {} }));
    expect(html).toContain("Turn 1 · Agent: first agent message");
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

  it("question excerpts are capped at PREVIEW_QUESTION_MAX (240) even for a huge prompt", () => {
    const huge = "word ".repeat(100); // 500 chars
    const mark = selectUserTurns([mkUser("u1", huge)])[0]!;
    expect(mark.questionExcerpt.length).toBeLessThanOrEqual(PREVIEW_QUESTION_MAX);
    expect(mark.questionExcerpt.endsWith("…")).toBe(true);
  });

  it("summarizeTurn folds ONLY the question (no answer scan — 4742 popover is query-only)", () => {
    const mark = summarizeTurn([mkUser("u1", "q"), mkAssistant("a1", "answer body"), mkTool({})], 0, 3);
    expect(mark).toEqual({ id: "u1", index: 0, questionExcerpt: "q" });
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
    // The earlier turns are reused verbatim.
    expect(marks[0]!.questionExcerpt).toBe("first question");
    expect(marks[1]!.questionExcerpt).toBe("second question");

    // Another delta to the same tail: still only the streamed turn.
    const streamed2 = streamed.map((block) =>
      block.kind === "assistant_text" && block.id === "a3" ? { ...block, text: `${block.text} tail` } : block,
    );
    selector(streamed2);
    expect(selector.recomputed).toEqual([2]);
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
    expect(marks[0]!.questionExcerpt).toBe("first question");
  });

  it("never serves a stale preview: question edits, rewinds", () => {
    const selector = createUserTurnsSelector();
    const blocks: TranscriptBlock[] = [
      mkUser("u1", "first question"),
      mkAssistant("a1", "first answer"),
      mkUser("u2", "second question"),
      mkUser("u3", "third question"),
    ];
    selector(blocks);
    // The open tail turn's QUESTION is edited in place (the turn has no answer, so the
    // user block itself closes the range).
    const questionEdited = blocks.map((b) => (b.id === "u3" ? { ...b, text: "edited third" } : b)) as TranscriptBlock[];
    expect(selector(questionEdited)[2]!.questionExcerpt).toBe("edited third");
    // Rewind to before turn 2 and ask again: the dropped turn's summary is gone.
    const rewound = [...questionEdited.slice(0, 2), mkUser("u2b", "second, rephrased")];
    const marks = selector(rewound);
    expect(marks.map((m) => m.id)).toEqual(["u1", "u2b"]);
    expect(marks[1]!.questionExcerpt).toBe("second, rephrased");
    expect(selector(rewound)).toEqual(selectUserTurns(rewound));
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

describe("shouldShowMinimap (4742: threshold lowered 3 -> 2)", () => {
  it("hides below 2 turns", () => {
    expect(shouldShowMinimap(0)).toBe(false);
    expect(shouldShowMinimap(1)).toBe(false);
  });

  it("shows from 2 turns up", () => {
    expect(shouldShowMinimap(2)).toBe(true);
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

describe("tickLengthFor (4742: the active tick renders longer)", () => {
  it("the active index gets 'active', everything else 'normal'", () => {
    expect(tickLengthFor(1, 1)).toBe("active");
    expect(tickLengthFor(0, 1)).toBe("normal");
    expect(tickLengthFor(2, null)).toBe("normal");
  });
});

describe("nextOpenState (4742 popover open-state machine)", () => {
  const closed: PopoverState = { openIndex: null, closing: false };

  it("hovering a tick opens its popover and cancels any pending close", () => {
    const pending: PopoverState = { openIndex: 0, closing: true };
    expect(nextOpenState(pending, { kind: "enterTick", index: 2 }, 3)).toEqual({ openIndex: 2, closing: false });
    expect(nextOpenState(closed, { kind: "enterTick", index: 0 }, 3)).toEqual({ openIndex: 0, closing: false });
  });

  it("focusing a tick opens its popover (keyboard parity with hover)", () => {
    expect(nextOpenState(closed, { kind: "focusTick", index: 1 }, 3)).toEqual({ openIndex: 1, closing: false });
  });

  it("leaving the tick arms the close delay but keeps the popover open (pointer may be headed for it)", () => {
    expect(nextOpenState({ openIndex: 1, closing: false }, { kind: "leaveTick" }, 3)).toEqual({ openIndex: 1, closing: true });
  });

  it("entering the popover cancels the pending close (Rewind button is clickable)", () => {
    expect(nextOpenState({ openIndex: 1, closing: true }, { kind: "enterPopover" }, 3)).toEqual({ openIndex: 1, closing: false });
  });

  it("leaving the popover re-arms the close delay", () => {
    expect(nextOpenState({ openIndex: 1, closing: false }, { kind: "leavePopover" }, 3)).toEqual({ openIndex: 1, closing: true });
  });

  it("blurring a tick arms the delay (focus may be moving into the popover's buttons)", () => {
    expect(nextOpenState({ openIndex: 1, closing: false }, { kind: "blurTick" }, 3)).toEqual({ openIndex: 1, closing: true });
  });

  it("closeNow (Esc) closes immediately with no delay", () => {
    expect(nextOpenState({ openIndex: 1, closing: true }, { kind: "closeNow" }, 3)).toEqual({ openIndex: null, closing: false });
  });

  it("an out-of-range tick index cannot open a popover", () => {
    expect(nextOpenState(closed, { kind: "enterTick", index: 5 }, 3)).toEqual({ openIndex: null, closing: false });
    expect(nextOpenState(closed, { kind: "enterTick", index: -1 }, 3)).toEqual({ openIndex: null, closing: false });
  });

  it("POPOVER_CLOSE_DELAY_MS is the ~120ms brief value", () => {
    expect(POPOVER_CLOSE_DELAY_MS).toBe(120);
  });
});

describe("rovingIndexFromKey (roving-tabindex key handler)", () => {
  it("ArrowDown moves down one, clamped at the last tick", () => {
    expect(rovingIndexFromKey("ArrowDown", 0, 5)).toBe(1);
    expect(rovingIndexFromKey("ArrowDown", 4, 5)).toBe(4);
  });

  it("ArrowUp moves up one, clamped at the first tick", () => {
    expect(rovingIndexFromKey("ArrowUp", 3, 5)).toBe(2);
    expect(rovingIndexFromKey("ArrowUp", 0, 5)).toBe(0);
  });

  it("Home/End jump to the first/last tick", () => {
    expect(rovingIndexFromKey("Home", 3, 5)).toBe(0);
    expect(rovingIndexFromKey("End", 0, 5)).toBe(4);
  });

  it("every other key is a no-op (Tab stays the browser's)", () => {
    expect(rovingIndexFromKey("Tab", 2, 5)).toBe(2);
    expect(rovingIndexFromKey("Enter", 2, 5)).toBe(2);
    expect(rovingIndexFromKey("ArrowLeft", 2, 5)).toBe(2);
    expect(rovingIndexFromKey("a", 2, 5)).toBe(2);
  });

  it("a single-tick rail pins the roving index at 0", () => {
    expect(rovingIndexFromKey("ArrowDown", 0, 1)).toBe(0);
    expect(rovingIndexFromKey("End", 0, 1)).toBe(0);
  });
});

describe("markDescribedBy (aria-describedby link)", () => {
  it("the open tick references the popover text; every other tick gets undefined", () => {
    expect(markDescribedBy(1, 1, "minimap-preview-r1")).toBe("minimap-preview-r1");
    expect(markDescribedBy(1, 0, "minimap-preview-r1")).toBeUndefined();
    expect(markDescribedBy(null, 0, "minimap-preview-r1")).toBeUndefined();
  });
});

describe("popoverCounterText (4742 'Message N of M' label)", () => {
  it("is 1-based and names the total", () => {
    expect(popoverCounterText(0, 3)).toBe("Message 1 of 3");
    expect(popoverCounterText(2, 3)).toBe("Message 3 of 3");
  });
});

describe("TranscriptMinimap (SSR component render)", () => {
  function renderMinimap(props: {
    marks: UserTurnMark[];
    activeIndex?: number | null;
    rewind?: { checkpointIds: (string | null)[]; onRewind: (checkpointId: string) => void };
  }): string {
    return renderToStaticMarkup(
      createElement(TranscriptMinimap, {
        marks: props.marks,
        activeIndex: props.activeIndex ?? null,
        onJump: () => {},
        ...(props.rewind !== undefined ? { rewind: props.rewind } : {}),
      }),
    );
  }

  const marks: UserTurnMark[] = [
    { id: "u1", index: 0, questionExcerpt: "first question" },
    { id: "u2", index: 3, questionExcerpt: "second question" },
  ];

  it("renders one .minimap-mark per mark with data-mark-index, data-mark-block-id and a Turn aria-label", () => {
    const html = renderMinimap({ marks });
    expect((html.match(/class="minimap-mark(?:\s[^\"]*)?"/g) ?? []).length).toBe(2);
    expect(html).toContain('data-mark-index="0"');
    expect(html).toContain('data-mark-index="1"');
    expect(html).toContain('data-mark-block-id="u1"');
    expect(html).toContain('data-mark-block-id="u2"');
    // A rail button must never carry `data-block-id`: jumpToBlock and the
    // automation block-count probe query that attribute across .message-list.
    expect(html).not.toMatch(/\sdata-block-id=/);
    expect(html).toContain('aria-label="Turn 1: first question"');
    expect(html).toContain('aria-label="Turn 2: second question"');
    expect(html).toContain('role="navigation"');
  });

  it("the aria label stays short (first ~80 chars) even for a 240-char question", () => {
    const long = "w".repeat(300);
    const html = renderMinimap({ marks: [{ id: "u1", index: 0, questionExcerpt: long }] });
    const label = /aria-label="Turn 1: ([^"]*)"/.exec(html)![1]!;
    expect(label.length).toBeLessThanOrEqual(ARIA_LABEL_MAX + "Turn 1: ".length + 1);
    expect(label.length).toBeLessThanOrEqual(96);
  });

  it("roving tabindex: exactly ONE tick carries tabIndex=0, the rest -1", () => {
    const html = renderMinimap({ marks });
    expect((html.match(/tabindex="0"/g) ?? []).length).toBe(1);
    expect((html.match(/tabindex="-1"/g) ?? []).length).toBe(1);
    // The first tick holds the stop initially.
    expect(html).toContain('tabindex="0"');
  });

  it("the active mark carries minimap-mark-active (the longer/brighter tick)", () => {
    const html = renderMinimap({ marks, activeIndex: 1 });
    expect(html).toContain('class="minimap-mark minimap-mark-active" data-mark-index="1"');
    expect(html).not.toContain('minimap-mark-active" data-mark-index="0"');
  });

  it("marks: [] renders an empty container string (no minimap-mark nodes)", () => {
    const html = renderMinimap({ marks: [] });
    expect(html.includes("minimap-mark")).toBe(false);
  });

  it("no hover in static markup: no popover, no aria-describedby, no rewind button", () => {
    const html = renderMinimap({ marks });
    expect(html).not.toContain("minimap-preview");
    expect(html).not.toContain("aria-describedby");
    expect(html).not.toContain("Rewind");
  });

  it("dots live in a .minimap-marks scroll list inside the non-clipping .minimap shell", () => {
    const html = renderMinimap({ marks });
    const open = html.indexOf('<div class="minimap-marks">');
    expect(open).toBeGreaterThan(-1);
    // Every dot sits INSIDE the scroll list, none in the outer shell.
    const close = html.indexOf("</div>", open);
    const inner = html.slice(open, close);
    expect((inner.match(/class="minimap-mark(?:\s[^"]*)?"/g) ?? []).length).toBe(2);
  });
});

describe("minimap.css clipping contract (hover preview must not be clipped)", () => {
  const css = readFileSync(new URL("../minimap.css", import.meta.url), "utf8");
  function ruleBody(selector: string): string {
    const start = css.indexOf(`${selector} {`);
    expect(start).toBeGreaterThan(-1);
    // Strip comments first: the rule's prose may mention "overflow" itself.
    return css.slice(start, css.indexOf("}", start)).replace(/\/\*[\s\S]*?\*\//g, "");
  }

  it("the outer .minimap shell declares no overflow (its absolutely-positioned preview would be clipped)", () => {
    expect(ruleBody(".minimap")).not.toMatch(/overflow/);
  });

  it("the scrolling moved onto .minimap-marks, which is the only overflow box", () => {
    expect(ruleBody(".minimap-marks")).toMatch(/overflow-y:\s*auto/);
  });
});
