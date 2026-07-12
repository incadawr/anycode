/**
 * ExitPlanMode tool unit tests (Phase 4 slice 4.3, design §2.5/§3.1/§5.2 item 3).
 * Handler-level checks mirror the Agent/Skill precedent for a fail-closed-lock
 * tool: no control -> unavailable, wrong mode -> the benign no-op error naming
 * the current mode, a broker-approved exit -> the output shape and the
 * model-facing approval text. The empty-plan schema rejection is exercised
 * through the dispatch pipeline (as in the other tool suites, since zod
 * validation is a dispatcher-owned pipeline stage, not something the handler
 * itself runs); the metadata table is a frozen-contract snapshot.
 */

import { describe, expect, it } from "vitest";
import { DenyPermissionBroker, InMemoryHookRunner, ModePermissionEngine, executeToolCall } from "../index.js";
import type { CorePorts } from "../ports/index.js";
import type { PlanModeControl } from "../types/permissions.js";
import type { ToolContext } from "../types/tools.js";
import { exitPlanModeTool } from "./exit-plan-mode.js";
import { ToolRegistry } from "./registry.js";

function ports(): CorePorts {
  return {} as CorePorts; // the ExitPlanMode handler never touches ctx.ports
}

function handlerCtx(planMode?: PlanModeControl): ToolContext {
  return {
    toolCallId: "call-1",
    abortSignal: new AbortController().signal,
    cwd: "/work",
    ports: ports(),
    planMode,
  };
}

describe("ExitPlanMode tool — handler (design §3.1)", () => {
  it("no PlanModeControl -> unavailable (fail-closed lock, mirrors Agent/Skill without their own port)", async () => {
    const result = await exitPlanModeTool.handler({ plan: "do the thing" }, handlerCtx());
    expect(result.ok).toBe(false);
    expect(result.error).toContain("unavailable");
  });

  it("current mode is not plan -> a benign no-op error naming the current mode, zero mutations attempted", async () => {
    let exitCalls = 0;
    const planMode: PlanModeControl = {
      currentMode: () => "build",
      exitPlan: () => {
        exitCalls += 1;
        return null;
      },
    };
    const result = await exitPlanModeTool.handler({ plan: "do the thing" }, handlerCtx(planMode));
    expect(result.ok).toBe(false);
    expect(result.error).toBe("ExitPlanMode: not in plan mode (current mode: build).");
    expect(exitCalls).toBe(1);
  });

  it("a broker-approved exit returns the previous/target mode pair and an approval message for the model", async () => {
    const planMode: PlanModeControl = {
      currentMode: () => "plan",
      exitPlan: () => "build",
    };
    const result = await exitPlanModeTool.handler({ plan: "do the thing" }, handlerCtx(planMode));
    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ previousMode: "plan", mode: "build" });
    expect(exitPlanModeTool.formatResultForModel?.(result)).toContain("Plan approved");
  });
});

describe("ExitPlanMode tool — schema (design §2.5)", () => {
  it("an empty plan fails zod validation before the handler ever runs (dispatch-level invalid_input)", async () => {
    const registry = new ToolRegistry();
    registry.register(exitPlanModeTool);
    const outcome = await executeToolCall(
      {
        registry,
        hooks: new InMemoryHookRunner(),
        permissionEngine: new ModePermissionEngine(),
        permissionBroker: new DenyPermissionBroker(),
        mode: "plan",
        ports: ports(),
        cwd: "/work",
      },
      { id: "c1", name: "ExitPlanMode", input: { plan: "" } },
    );
    expect(outcome.status).toBe("invalid_input");
    expect(outcome.modelText).toContain("ExitPlanMode");
  });
});

describe("ExitPlanMode tool — metadata table (frozen, design §2.5)", () => {
  it("readOnly/needsApproval/concurrentSafe are exactly the plan-mode-gate combination the design freezes", () => {
    expect(exitPlanModeTool.metadata.name).toBe("ExitPlanMode");
    // readOnly + needsApproval is what lets the EXISTING permission engine
    // escalate this tool to an ask in plan mode with zero permissions/* edits.
    expect(exitPlanModeTool.metadata.readOnly).toBe(true);
    expect(exitPlanModeTool.metadata.needsApproval).toBe(true);
    // Always a solo batch: a mode flip must never race a parallel sibling call.
    expect(exitPlanModeTool.metadata.concurrentSafe).toBe(false);
    expect(exitPlanModeTool.metadata.destructive).toBe(false);
    expect(exitPlanModeTool.metadata.riskLevel).toBe("low");
    expect(exitPlanModeTool.metadata.sideEffectScope).toBe("none");
  });
});
