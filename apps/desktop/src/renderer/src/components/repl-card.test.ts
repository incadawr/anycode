import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { ReplCallSnapshot, ReplSnapshot } from "@anycode/core";
import type { WireAgentEvent, WireHistoryItem } from "../../../shared/protocol.js";
import { createDesktopStore, type ToolCallBlock } from "../store.js";
import { ToolCallCard } from "./ToolCallCard.js";

it("replayHydratesSameDiff", () => {
  const store = createDesktopStore({ schedule: (fn) => fn() });
  const event = (value: WireAgentEvent) => store.getState().applyHostMessage({ type: "agent_event", turnId: "turn", event: value });
  const blocks = () => store.getState().transcript.filter((block): block is ToolCallBlock => block.kind === "tool_call");
  const script = 'await call("Edit", {});';
  const input = { code: script, description: "Update fixture" };
  const edit: ReplCallSnapshot = {
    callId: "parent.1", toolName: "Edit", status: "success", durationMs: 12,
    input: { fields: { file_path: "fixture.js", old_string: "const oldValue = 1;\n", new_string: "const newValue = 2;\n" }, truncated: true },
  };
  const { callId, toolName, input: preview } = edit;
  const start = { type: "repl_call_start", toolCallId: "parent", callId, toolName, input: preview } as const;
  const end = { type: "repl_call_end", toolCallId: "parent", callId, outcome: edit } as const;
  const second = { ...end, toolCallId: "second", callId: "second.1", outcome: { ...edit, callId: "second.1" } };
  const render = (block: ToolCallBlock) => renderToStaticMarkup(createElement(ToolCallCard, { block }));
  const diff = (html: string) => html.match(/<div class="diff-line diff-line-(?:add|del)".*?<\/div>/g);

  store.getState().applyHostMessage({ type: "turn_started", turnId: "turn", requestId: "request" });
  for (const id of ["parent", "second"]) event({ type: "tool_call", toolCall: { id, name: "REPL", input } });
  event(start);
  event(start);
  expect(blocks()[0]?.repl?.calls).toHaveLength(1);
  event(end);
  event(end);
  event(start);
  event(second);
  expect(blocks().map((block) => block.repl?.calls)).toEqual([[edit], [second.outcome]]);
  const live = render(blocks()[0]!);
  expect(live).toContain("Update fixture");
  expect(live).toContain("1 call");
  expect(live).toContain("Input preview truncated");
  expect(live).toContain("12 ms");
  expect(live).toContain('<details><summary class="tool-call-input">Script source');
  expect(live.match(/data-tool-call-id="parent\.1"/g)).toHaveLength(1);
  expect(diff(live)).toHaveLength(2);
  expect(diff(live)?.join("")).toContain("newValue");

  const authoritative: ReplSnapshot = { code: script, calls: [edit] };
  event({ ...end, callId: "parent.2", outcome: { ...edit, callId: "parent.2" } });
  event({ type: "tool_result", outcome: {
    toolCallId: "parent", toolName: "REPL", status: "success", modelText: "done", durationMs: 25,
    result: { ok: true, presentation: { repl: authoritative } },
  } });
  event({ ...start, callId: "parent.3" });
  expect(blocks()[0]?.repl).toEqual(authoritative);

  const restored = createDesktopStore({ schedule: (fn) => fn() });
  const items: WireHistoryItem[] = [
    { id: "assistant", createdAt: 1, turnId: "turn", step: 1, message: { role: "assistant", content: [
      { type: "tool_call", toolCallId: "parent", toolName: "REPL", input },
    ] } },
    { id: "tool", createdAt: 2, turnId: "turn", step: 1, message: { role: "tool", content: [
      { type: "tool_result", toolCallId: "parent", toolName: "REPL", status: "success", text: "done", presentation: { repl: authoritative } },
    ] } },
  ];
  restored.getState().applyHostMessage({ type: "session_history", sessionId: "session", items, truncated: false });
  const [hydrated] = restored.getState().transcript;
  expect(hydrated).toMatchObject({ kind: "tool_call", status: "success", repl: authoritative });
  expect(diff(render(hydrated as ToolCallBlock))).toEqual(diff(live));

  restored.getState().applyHostMessage({
    type: "presentation_snapshot", coveredTurnIds: ["turn"], items, truncated: false, historyTracksTurns: true,
    turns: [{ turnId: "turn", requestId: "request", startedAt: 1, events: [
      { event: { type: "tool_call", toolCall: { id: "parent", name: "REPL", input } }, step: 1 },
      { event: { ...start, callId: "parent.3" }, step: 1 },
    ] }],
  });
  const reconnected = restored.getState().transcript.find((block) => block.kind === "tool_call");
  expect(reconnected).toMatchObject({ kind: "tool_call", status: "success", repl: authoritative });
  expect(diff(render(reconnected as ToolCallBlock))).toEqual(diff(live));
});
