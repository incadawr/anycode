import { expect, it } from "vitest";
import { parseChildTerminal } from "../shared/child-sessions.js";
import { childBootFailure } from "./child-boot-failure.js";

it("reports a startup error with the original engine message", () => {
  const reason = "host failed to initialize: Codex version preflight timed out after 15000ms";
  expect(parseChildTerminal(childBootFailure(reason))).toMatchObject({
    status: "error", turns: 0, toolCalls: 0,
    finalText: `${reason}\nThis is a startup failure; retry the task unchanged.`,
  });
});
