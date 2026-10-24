/**
 * Taskana 4068 / TASK.98 (review 23.08 narrowing): unit tests for the pure
 * engine-switch seam. No I/O, no live CLIs — these pin the EXACT strings a
 * switched-to engine receives as its first prompt, and the planning rules
 * that decide which canonical items survive into that prompt.
 */

import { describe, expect, it } from "vitest";
import type { HistoryItem } from "@anycode/core";
import { planEngineSwitchImport, renderImportPrompt, ENGINE_SWITCH_TURN_ID } from "./engine-switch.js";

function item(id: string, partial: Partial<HistoryItem> & Pick<HistoryItem, "message">): HistoryItem {
  return { id, createdAt: 0, ...partial };
}

describe("planEngineSwitchImport", () => {
  it("empty history -> empty plan, not truncated", () => {
    expect(planEngineSwitchImport([])).toEqual({ items: [], truncated: false });
  });

  it("filters compact_summary and microcompact_cleared markers (core-engine artifacts)", () => {
    const history: HistoryItem[] = [
      item("m1", { message: { role: "user", content: "old" }, kind: "compact_summary" }),
      item("m2", { message: { role: "assistant", content: [] }, kind: "microcompact_cleared" }),
      item("n1", { message: { role: "user", content: "keep me" } }),
    ];
    const plan = planEngineSwitchImport(history);
    expect(plan.items.map((i) => i.id)).toEqual(["n1"]);
    // markers dropped by FILTERING do not count as truncation
    expect(plan.truncated).toBe(false);
  });

  it("kind: normal and undefined both survive", () => {
    const history: HistoryItem[] = [
      item("a", { message: { role: "user", content: "x" }, kind: "normal" }),
      item("b", { message: { role: "user", content: "y" } }),
    ];
    expect(planEngineSwitchImport(history).items.map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("keeps the LAST maxItems and sets truncated (3 items, max 2 -> items 2-3)", () => {
    const history: HistoryItem[] = [
      item("1", { message: { role: "user", content: "one" } }),
      item("2", { message: { role: "user", content: "two" } }),
      item("3", { message: { role: "user", content: "three" } }),
    ];
    const plan = planEngineSwitchImport(history, 2);
    expect(plan.items.map((i) => i.id)).toEqual(["2", "3"]);
    expect(plan.truncated).toBe(true);
  });

  it("exactly maxItems items -> not truncated", () => {
    const history: HistoryItem[] = [
      item("1", { message: { role: "user", content: "one" } }),
      item("2", { message: { role: "user", content: "two" } }),
    ];
    const plan = planEngineSwitchImport(history, 2);
    expect(plan.items).toHaveLength(2);
    expect(plan.truncated).toBe(false);
  });
});

describe("renderImportPrompt", () => {
  const workspace = "/tmp/proj";

  it("renders a user item with the # user prefix, images skipped", () => {
    const plan = planEngineSwitchImport([
      item("u1", {
        message: { role: "user", content: "hello", images: [{ mediaType: "image/png", data: "x" } as never] },
      }),
    ]);
    const prompt = renderImportPrompt("core", "codex", plan, workspace);
    expect(prompt).toBe(
      [
        `Session continued in this codex engine (previous engine: core; workspace: ${workspace}).`,
        `Imported the full conversation (1 items).`,
        `# user hello`,
      ].join("\n"),
    );
  });

  it("renders an assistant item joining only text parts (tool_call parts skipped)", () => {
    const plan = planEngineSwitchImport([
      item("a1", {
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "first" },
            { type: "tool_call", toolCallId: "t1", toolName: "Read", input: {} },
            { type: "text", text: "second" },
          ],
        },
      }),
    ]);
    const prompt = renderImportPrompt("core", "claude", plan, workspace);
    expect(prompt).toContain(`# assistant first\nsecond`);
  });

  it("renders a tool item from the FIRST part only, capped at 500 chars; later parts skipped", () => {
    const long = "x".repeat(600);
    const plan = planEngineSwitchImport([
      item("t1", {
        message: {
          role: "tool",
          content: [
            {
              type: "tool_result",
              toolCallId: "t1",
              toolName: "Bash",
              text: long,
              status: "success" as never,
            },
            {
              type: "tool_result",
              toolCallId: "t2",
              toolName: "Read",
              text: "second-part-must-not-appear",
              status: "success" as never,
            },
          ],
        },
      }),
    ]);
    const prompt = renderImportPrompt("codex", "core", plan, workspace);
    expect(prompt).toContain(`# tool Bash ${"x".repeat(500)}`);
    expect(prompt).not.toContain("x".repeat(501));
    expect(prompt).not.toContain("second-part-must-not-appear");
  });

  it("truncated header names the kept count; full header names the conversation length", () => {
    const full = renderImportPrompt(
      "core",
      "codex",
      { items: [item("1", { message: { role: "user", content: "a" } })], truncated: false },
      workspace,
    );
    expect(full).toContain(`Imported the full conversation (1 items).`);

    const truncated = renderImportPrompt(
      "core",
      "codex",
      {
        items: [
          item("2", { message: { role: "user", content: "b" } }),
          item("3", { message: { role: "user", content: "c" } }),
        ],
        truncated: true,
      },
      workspace,
    );
    expect(truncated).toContain(`Imported the last 2 conversation items (older history was dropped).`);
    expect(truncated).not.toContain(`Imported the full conversation`);
  });

  it("identical inputs -> identical strings; full expected string for a 3-item fixture (snapshot-free determinism)", () => {
    const history: HistoryItem[] = [
      item("u", { message: { role: "user", content: "fix the bug" } }),
      item("a", {
        message: { role: "assistant", content: [{ type: "text", text: "looking" }] },
      }),
      item("t", {
        message: {
          role: "tool",
          content: [{ type: "tool_result", toolCallId: "c1", toolName: "Read", text: "file body", status: "success" as never }],
        },
      }),
    ];
    const plan = planEngineSwitchImport(history);
    const expected = [
      `Session continued in this codex engine (previous engine: core; workspace: /tmp/proj).`,
      `Imported the full conversation (3 items).`,
      `# user fix the bug`,
      `# assistant looking`,
      `# tool Read file body`,
    ].join("\n");
    expect(renderImportPrompt("core", "codex", plan, workspace)).toBe(expected);
    expect(renderImportPrompt("core", "codex", plan, workspace)).toBe(expected);
  });

  it("malformed shapes are skipped, never fatal (unknown role)", () => {
    const plan = { items: [item("x", { message: { role: "mystery" as never, content: "?" } })], truncated: false };
    const prompt = renderImportPrompt("core", "codex", plan, workspace);
    expect(prompt).not.toContain("mystery");
    expect(prompt.split("\n")).toHaveLength(2); // headers only
  });
});

describe("ENGINE_SWITCH_TURN_ID", () => {
  it("is the sentinel turn id for the switch announcement event", () => {
    expect(ENGINE_SWITCH_TURN_ID).toBe("engine-switch");
  });
});
