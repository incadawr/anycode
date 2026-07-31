/**
 * TASK.27 — end-to-end proof over the real wire that the desktop GUI can leave
 * plan mode the way the CLI already can.
 *
 * These run the REAL core graph (AgentLoop + dispatcher + ModePermissionEngine +
 * IpcPermissionBroker + Session) against a scripted model, so every link the
 * task listed as missing is exercised for real: the tool is registered, the
 * broker escalates its `needsApproval` ask onto the `permission_request` wire,
 * a UI allow lets the handler flip the mode through `ctx.planMode`, and the
 * loop's `onModeChange` reaches the UI as `mode_changed` plus a persistence
 * touch. Nothing here asserts on source text — host/index.ts's own wiring is
 * guarded instead by plan-exit.ts being the single atomic call site
 * (plan-exit.test.ts).
 */
import { describe, expect, it, vi } from "vitest";
import type { AgentEvent, ModelStreamEvent } from "@anycode/core";
import type { HostToUiMessage } from "../shared/protocol.js";
import type { SessionEngine } from "./engines/session-engine.js";
import { ScriptedModelPort, createHarness, textStep, toolStep } from "./test-harness.js";
import type { Harness } from "./test-harness.js";

type Of<T extends HostToUiMessage["type"]> = Extract<HostToUiMessage, { type: T }>;

const isHostReady = (m: HostToUiMessage): m is Of<"host_ready"> => m.type === "host_ready";
const isPermissionRequest = (m: HostToUiMessage): m is Of<"permission_request"> =>
  m.type === "permission_request";
const isModeChanged = (m: HostToUiMessage): m is Of<"mode_changed"> => m.type === "mode_changed";
const isLoopEnd = (m: HostToUiMessage): m is Of<"agent_event"> =>
  m.type === "agent_event" && m.event.type === "loop_end";
const toolResultOf =
  (id: string) =>
  (m: HostToUiMessage): m is Of<"agent_event"> =>
    m.type === "agent_event" && m.event.type === "tool_result" && m.event.outcome.toolCallId === id;

const loopEndCount = (h: Harness): number =>
  h.received.filter((m) => m.type === "agent_event" && m.event.type === "loop_end").length;

/** Every user-role message the scripted model actually received, in order. */
const userMessagesSeen = (h: Harness): string[] =>
  (h.config.modelPort as ScriptedModelPort).requests.flatMap((request) =>
    request.messages.filter((message) => message.role === "user").map((message) => String(message.content)),
  );

const PLAN = "## Plan\n\n1. Move the reminder into prompts/\n2. Wire the tool\n";

/** Two-step script: the model asks to exit plan mode, then speaks. */
const exitPlanScript = (): ModelStreamEvent[][] => [
  toolStep("p1", "ExitPlanMode", { plan: PLAN }),
  textStep("starting the implementation"),
];

describe("desktop plan exit — approve", () => {
  it("escalates ExitPlanMode onto the permission wire with the plan text intact", async () => {
    const h = createHarness({ steps: exitPlanScript(), mode: "plan", planExit: true });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);
      h.send({ type: "user_message", requestId: "r1", text: "figure out how to do X" });

      const request = await h.waitFor(isPermissionRequest);

      expect(request.toolName).toBe("ExitPlanMode");
      expect(request.mode).toBe("plan");
      expect((request.input as { plan?: string }).plan).toBe(PLAN);
    } finally {
      h.close();
    }
  });

  it("switches the session to build and tells BOTH the UI and persistence", async () => {
    const h = createHarness({ steps: exitPlanScript(), mode: "plan", planExit: true });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);
      h.send({ type: "user_message", requestId: "r1", text: "figure out how to do X" });
      const request = await h.waitFor(isPermissionRequest);

      h.send({ type: "permission_response", requestId: request.requestId, behavior: "allow" });

      const changed = await h.waitFor(isModeChanged);
      expect(changed.mode).toBe("build");
      await h.waitFor(isLoopEnd, 5_000);
      expect(h.touches).toContainEqual({ mode: "build" });
      // The loop's own source of truth advanced too — the next turn is a build turn.
      expect(h.engine.mode()).toBe("build");
    } finally {
      h.close();
    }
  });

  it("tells the model the plan was approved (not the fail-closed 'control unavailable')", async () => {
    const h = createHarness({ steps: exitPlanScript(), mode: "plan", planExit: true });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);
      h.send({ type: "user_message", requestId: "r1", text: "figure out how to do X" });
      const request = await h.waitFor(isPermissionRequest);
      h.send({ type: "permission_response", requestId: request.requestId, behavior: "allow" });

      const result = await h.waitFor(toolResultOf("p1"), 5_000);
      const { outcome } = result.event as Extract<AgentEvent, { type: "tool_result" }>;

      expect(outcome.status).toBe("success");
      expect(outcome.modelText).toContain("Plan approved");
      expect(outcome.modelText).not.toContain("unavailable");
    } finally {
      h.close();
    }
  });

  it("drops the plan-mode reminder from the NEXT turn once the mode advanced", async () => {
    const h = createHarness({
      steps: [...exitPlanScript(), textStep("done")],
      mode: "plan",
      planExit: true,
    });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);
      h.send({ type: "user_message", requestId: "r1", text: "figure out how to do X" });
      const request = await h.waitFor(isPermissionRequest);
      h.send({ type: "permission_response", requestId: request.requestId, behavior: "allow" });
      await h.waitFor(isLoopEnd, 5_000);

      h.send({ type: "user_message", requestId: "r2", text: "now implement it" });
      await h.waitUntil(() => loopEndCount(h) >= 2, 5_000);

      const users = userMessagesSeen(h);
      const planTurn = users.find((content) => content.startsWith("figure out how to do X"));
      const buildTurn = users.find((content) => content.startsWith("now implement it"));
      expect(planTurn).toContain("<plan-mode-reminder>");
      expect(buildTurn).toBeDefined();
      expect(buildTurn).not.toContain("<plan-mode-reminder>");
    } finally {
      h.close();
    }
  });
});

describe("desktop plan exit — reject", () => {
  it("keeps the session in plan mode and emits no mode_changed", async () => {
    const h = createHarness({ steps: exitPlanScript(), mode: "plan", planExit: true });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);
      h.send({ type: "user_message", requestId: "r1", text: "figure out how to do X" });
      const request = await h.waitFor(isPermissionRequest);

      h.send({ type: "permission_response", requestId: request.requestId, behavior: "deny" });

      const result = await h.waitFor(toolResultOf("p1"), 5_000);
      const { outcome } = result.event as Extract<AgentEvent, { type: "tool_result" }>;
      expect(outcome.status).toBe("denied");
      await h.waitFor(isLoopEnd, 5_000);
      await h.flush();
      expect(h.received.some(isModeChanged)).toBe(false);
      expect(h.touches).not.toContainEqual({ mode: "build" });
      expect(h.engine.mode()).toBe("plan");
    } finally {
      h.close();
    }
  });
});

describe("desktop plan exit — fail-closed without the wiring", () => {
  it("does not even offer the tool to the model when planExit is off", () => {
    const h = createHarness({ steps: [textStep("hi")], mode: "plan" });
    try {
      expect(h.config.registry.list()).not.toContain("ExitPlanMode");
      expect(h.config.planExitMode).toBeUndefined();
    } finally {
      h.close();
    }
  });
});

describe("plan-mode reminder injection", () => {
  it("appends the reminder to a plan-mode turn's user message", async () => {
    const h = createHarness({ steps: [textStep("ok")], mode: "plan", planExit: true });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);
      h.send({ type: "user_message", requestId: "r1", text: "research the auth flow" });
      await h.waitFor(isLoopEnd, 5_000);

      const sent = userMessagesSeen(h).at(-1) ?? "";
      expect(sent).toContain("research the auth flow");
      expect(sent).toContain("<plan-mode-reminder>");
      expect(sent).toContain("ExitPlanMode");
    } finally {
      h.close();
    }
  });

  it("never appends it in build mode", async () => {
    const h = createHarness({ steps: [textStep("ok")], mode: "build", planExit: true });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);
      h.send({ type: "user_message", requestId: "r1", text: "just do it" });
      await h.waitFor(isLoopEnd, 5_000);

      expect(userMessagesSeen(h).at(-1)).toBe("just do it");
    } finally {
      h.close();
    }
  });

  it("never appends it for an engine that owns its own plan mode (Claude/Codex)", async () => {
    const seen: string[] = [];
    const engine: SessionEngine = {
      id: "claude",
      capabilities: {
        supportsCorePermissions: false,
        supportsRewind: false,
        supportsWorkflow: false,
        supportsGitMutations: false,
        supportsContextUsage: false,
        supportsContextBreakdown: false,
        supportsInteractiveApprovals: true,
        costAccounting: false,
        supportsModelSelection: false,
        supportsReasoningEffort: false,
        supportsImages: false,
        supportsTasks: false,
        supportsFileSnapshots: false,
      },
      mode: () => "plan",
      reasoningEffort: () => undefined,
      setReasoningEffort: vi.fn(),
      async *runTurn(input: string): AsyncIterable<AgentEvent> {
        seen.push(input);
        yield { type: "loop_end", reason: "completed", turns: 1 } as AgentEvent;
      },
      historyItems: () => [],
      dispose: async () => {},
    };
    const h = createHarness({ steps: [], engine, mode: "plan" });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);
      h.send({ type: "user_message", requestId: "r1", text: "look into it" });
      await h.waitUntil(() => seen.length > 0, 5_000);

      expect(seen[0]).toBe("look into it");
    } finally {
      h.close();
    }
  });
});
