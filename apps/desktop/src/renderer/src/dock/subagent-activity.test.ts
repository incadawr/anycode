import { describe, expect, it } from "vitest";
import { deriveSubagentActivity } from "./subagent-activity.js";

describe("subagent dock activity", () => {
  it("tracks running, permission and unseen outcomes until focused", () => {
    const rows = [{ spawnToolCallId: "a", badge: "running" as const }, { spawnToolCallId: "b", badge: "waiting_permission" as const }];
    const running = deriveSubagentActivity(rows, false, { previous: {}, unseen: {} });
    expect(running.label).toBe("Subagents — 2 running, 1 waiting for permission");
    const failed = deriveSubagentActivity([{ ...rows[0]!, badge: "error" }, rows[1]!], false, running.memory);
    expect(failed.label).toBe("Subagents — 1 running, 1 waiting for permission, 1 failed");
    const focused = deriveSubagentActivity([{ ...rows[0]!, badge: "error" }], true, failed.memory);
    expect(focused.label).toBe("Subagents");
    expect(deriveSubagentActivity([{ ...rows[0]!, badge: "error" }], false, focused.memory).label).toBe("Subagents");
  });
});
