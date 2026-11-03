import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ChildSplitPane } from "./ChildSplitPane.js";

it("shows the failure reason in the single child panel and roster", () => {
  const card = { agentType: "codex", description: "review", model: null, engine: null, turns: 0, toolCalls: 0, lastTool: null, activity: [], activityDropped: 0, final: { status: "error" as const, durationMs: 1, failureReason: "host failed to initialize: timeout" } };
  const row = { spawnToolCallId: "spawn", card, badge: "error" as const };
  const render = (rows: typeof row[]) => renderToStaticMarkup(createElement(ChildSplitPane, { rows, expandedId: "spawn", onExpandRow() {}, onExitSplit() {}, onClose() {}, children: null }));
  expect(render([row])).toContain("Error: host failed to initialize: timeout");
  expect(render([row, { ...row, spawnToolCallId: "other" }])).toContain("Error: host failed to initialize: timeout");
});
