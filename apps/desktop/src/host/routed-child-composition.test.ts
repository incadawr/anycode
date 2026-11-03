import { describe, expect, it, vi } from "vitest";
import type { SessionSubagentRequest } from "@anycode/core";
import type { ChildSessionPort } from "./child-session-port.js";
import { createRoutedChildComposition } from "./routed-child-composition.js";
import { RoleHealthCache } from "./role-route.js";

describe("routed child snapshots", () => {
  it("uses the route selected before dispatch even if settings change", async () => {
    const run = vi.fn().mockResolvedValue({ status: "completed", turns: 0, background: { reason: "requested" } });
    const resolve = vi.fn(() => ({ entries: [{ model: "changed" }], skipped: [] }));
    const composition = createRoutedChildComposition({ health: new RoleHealthCache(), describeError: String, resolve,
      prepare: (req) => req, record: () => {}, report: () => {}, deliver: () => {} });
    const port = { run } as unknown as ChildSessionPort;
    composition.attach(port);
    const req: SessionSubagentRequest = { agentType: "executor", description: "task", prompt: "work", spawnToolCallId: "first", model: "first", routeStamped: true, detach: true };
    composition.snapshot(req, { entries: [{ model: "first" }, { model: "fallback" }], skipped: [] });
    await port.run(req, {});
    expect(resolve).not.toHaveBeenCalled();
    composition.onTerminal({ status: "error", finalText: "rate limited (HTTP 429)", turns: 1, toolCalls: 0, durationMs: 1, truncated: false, childSessionId: "child", parentSessionId: "parent", spawnToolCallId: "first" }, req);
    expect(run.mock.calls[1]?.[0]).toMatchObject({ model: "fallback", detach: true });
  });
});
