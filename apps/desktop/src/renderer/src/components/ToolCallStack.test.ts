/**
 * TASK.31 — SSR component tests for `ToolCallStack`. Same jsdom-free discipline
 * as `ToolCallCard.test.ts`: `react-dom/server`'s `renderToStaticMarkup` walks
 * the React tree to an HTML string without touching any DOM API, so it works
 * under this package's plain "node" vitest environment. The component defaults
 * to collapsed, so these asserts pin the collapsed-state DOM contract (the
 * regression-sensitive surface: header label, anchors, badge class, button
 * contract). The expanded body renders plain `ToolCallCard` instances, whose
 * own DOM contract is already pinned by `ToolCallCard.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { stackBlockIdLayout, ToolCallStack } from "./ToolCallStack.js";
import type { ToolCallBlock } from "../store.js";

function mkToolCall(overrides: Partial<ToolCallBlock> = {}): ToolCallBlock {
  return {
    kind: "tool_call",
    id: "tc-1",
    toolCallId: "tc-1",
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

function renderStack(blocks: ToolCallBlock[]): string {
  return renderToStaticMarkup(createElement(ToolCallStack, { blocks }));
}

describe("ToolCallStack (SSR component render, collapsed default)", () => {
  it("renders a toggle button with aria-expanded=false and the header label + count", () => {
    const blocks = [mkToolCall({ id: "a", toolName: "Bash" }), mkToolCall({ id: "b", toolName: "Bash" })];
    const html = renderStack(blocks);
    expect(html).toContain("tool-call-stack-toggle");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("tool-call-stack-name");
    expect(html).toContain(">Bash<");
    expect(html).toContain("2 calls");
  });

  it("shows the compact type rundown for a mixed-type stack (never masquerades as one tool name)", () => {
    const html = renderStack([
      mkToolCall({ id: "a", toolName: "Bash" }),
      mkToolCall({ id: "b", toolName: "Read" }),
    ]);
    expect(html).toContain("tool-call-stack-name");
    expect(html).toContain(">Bash, Read<");
  });

  it("falls back to the neutral 'Tool calls' label for a 4+-type run", () => {
    const html = renderStack([
      mkToolCall({ id: "a", toolName: "Bash" }),
      mkToolCall({ id: "b", toolName: "Read" }),
      mkToolCall({ id: "c", toolName: "Grep" }),
      mkToolCall({ id: "d", toolName: "Glob" }),
    ]);
    expect(html).toContain(">Tool calls<");
  });

  it("does NOT render the inner tool-call-card body while collapsed", () => {
    const blocks = [mkToolCall({ id: "a" }), mkToolCall({ id: "b" })];
    const html = renderStack(blocks);
    expect(html).not.toContain("tool-call-stack-body");
    expect(html).not.toContain('class="tool-call-card');
  });

  it("carries one data-block-id anchor per non-head member (automation count stays honest)", () => {
    const blocks = [mkToolCall({ id: "a" }), mkToolCall({ id: "b" }), mkToolCall({ id: "c" })];
    const html = renderStack(blocks);
    // Head lives on the root; the other two are anchor spans.
    expect(html).toContain('data-block-id="a"');
    expect(html).toContain('data-block-id="b"');
    expect(html).toContain('data-block-id="c"');
    expect(html).toContain("tool-call-stack-anchor");
  });

  it("keeps exactly one data-block-id per original card after expansion", () => {
    const blocks = [mkToolCall({ id: "a" }), mkToolCall({ id: "b" }), mkToolCall({ id: "c" })];
    const collapsed = stackBlockIdLayout(blocks, false);
    const expanded = stackBlockIdLayout(blocks, true);
    expect([collapsed.rootId, ...collapsed.anchorIds].filter(Boolean)).toEqual(["a", "b", "c"]);
    expect([expanded.rootId, ...expanded.bodyIds].filter(Boolean)).toEqual(["a", "b", "c"]);
  });

  it("tags the root with the head block's data-block-id", () => {
    const html = renderStack([mkToolCall({ id: "head" }), mkToolCall({ id: "tail" })]);
    expect(html).toContain('data-block-id="head"');
  });

  it("maps an all-success stack to the success badge tint", () => {
    const html = renderStack([mkToolCall({ id: "a", status: "success" }), mkToolCall({ id: "b", status: "success" })]);
    expect(html).toContain("tool-call-status-success");
    expect(html).toContain(">Success<");
  });

  it("maps a mixed stack to the error badge tint with the failed count", () => {
    const html = renderStack([mkToolCall({ id: "a", status: "success" }), mkToolCall({ id: "b", status: "error" })]);
    expect(html).toContain("tool-call-status-error");
    expect(html).toContain(">1 failed<");
  });

  it("the toggle is a real button with aria-controls pointing at the body id", () => {
    const html = renderStack([mkToolCall({ id: "a" }), mkToolCall({ id: "b" })]);
    expect(html).toMatch(/<button[^>]*type="button"/);
    // aria-controls is present (the body mounts only when expanded, but the
    // id reference is wired on the toggle regardless).
    expect(html).toMatch(/aria-controls="[^"]+"/);
  });

  it("does not nest interactive buttons inside the toggle", () => {
    const html = renderStack([mkToolCall({ id: "a" }), mkToolCall({ id: "b" })]);
    // Exactly one <button> opens the toggle; no nested buttons follow before it closes.
    const toggleOpen = html.indexOf("<button");
    const toggleClose = html.indexOf("</button>");
    expect(toggleOpen).toBeGreaterThanOrEqual(0);
    expect(toggleClose).toBeGreaterThan(toggleOpen);
    const toggleSlice = html.slice(toggleOpen, toggleClose);
    expect(toggleSlice.match(/<button/g)).toHaveLength(1);
  });
});
