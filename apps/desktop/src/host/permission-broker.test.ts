/**
 * IpcPermissionBroker fail-closed matrix (design §4), unit-tested in isolation:
 * allow / deny / timeout->deny / disconnect->deny / turn-cancel->deny /
 * unknown requestId ignored / double response (first wins). The timeout case
 * uses vitest fake timers so the 120s deadline is exercised deterministically.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { writeTool } from "@anycode/core";
import type { PermissionRequest } from "@anycode/core";
import type { HostToUiMessage } from "../shared/protocol.js";
import {
  IpcPermissionBroker,
  PERMISSION_ASK_TIMEOUT_MS,
  PLAN_APPROVAL_ASK_TIMEOUT_MS,
  resolveAskTimeoutMs,
  toWireToolMeta,
} from "./permission-broker.js";

function makeBroker(timeoutMs?: number): {
  broker: IpcPermissionBroker;
  emitted: HostToUiMessage[];
} {
  const emitted: HostToUiMessage[] = [];
  const broker = new IpcPermissionBroker((message) => emitted.push(message), timeoutMs);
  return { broker, emitted };
}

const request: PermissionRequest = {
  toolName: "Write",
  input: { file_path: "/workspace/a.txt", content: "hi" },
  metadata: writeTool.metadata,
  mode: "build",
};

function requestId(emitted: HostToUiMessage[]): string {
  const found = emitted.find((m) => m.type === "permission_request");
  if (!found || found.type !== "permission_request") {
    throw new Error("no permission_request emitted");
  }
  return found.requestId;
}

function settled(emitted: HostToUiMessage[]): Extract<HostToUiMessage, { type: "permission_settled" }>[] {
  return emitted.filter(
    (m): m is Extract<HostToUiMessage, { type: "permission_settled" }> =>
      m.type === "permission_settled",
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("IpcPermissionBroker matrix", () => {
  it("emits permission_request with the UI-safe metadata subset", () => {
    const { broker, emitted } = makeBroker();
    void broker.requestPermission(request);

    const req = emitted.find((m) => m.type === "permission_request");
    expect(req).toBeDefined();
    if (req?.type === "permission_request") {
      expect(req.toolName).toBe("Write");
      expect(req.input).toEqual(request.input);
      expect(req.mode).toBe("build");
      expect(req.metadata).toEqual(toWireToolMeta(writeTool.metadata));
    }
    broker.denyAll("cleanup", "shutdown");
  });

  it("allow: resolves to allow and settles origin=ui", async () => {
    const { broker, emitted } = makeBroker();
    const decision = broker.requestPermission(request);
    broker.handleResponse(requestId(emitted), "allow");

    await expect(decision).resolves.toEqual({ behavior: "allow" });
    expect(settled(emitted)).toEqual([
      expect.objectContaining({ behavior: "allow", origin: "ui" }),
    ]);
  });

  it("allow carries updatedInput through to the dispatcher", async () => {
    const { broker, emitted } = makeBroker();
    const decision = broker.requestPermission(request);
    broker.handleResponse(requestId(emitted), "allow", { file_path: "/workspace/b.txt", content: "x" });

    await expect(decision).resolves.toEqual({
      behavior: "allow",
      updatedInput: { file_path: "/workspace/b.txt", content: "x" },
    });
  });

  it("deny: resolves to deny and settles origin=ui", async () => {
    const { broker, emitted } = makeBroker();
    const decision = broker.requestPermission(request);
    broker.handleResponse(requestId(emitted), "deny");

    await expect(decision).resolves.toMatchObject({ behavior: "deny" });
    expect(settled(emitted)).toEqual([
      expect.objectContaining({ behavior: "deny", origin: "ui" }),
    ]);
  });

  it("timeout: resolves to deny and settles origin=timeout", async () => {
    vi.useFakeTimers();
    const { broker, emitted } = makeBroker(120_000);
    const decision = broker.requestPermission(request);

    await vi.advanceTimersByTimeAsync(120_000);

    await expect(decision).resolves.toMatchObject({ behavior: "deny" });
    expect(settled(emitted)).toEqual([
      expect.objectContaining({ behavior: "deny", origin: "timeout" }),
    ]);
  });

  it("disconnect: denyAll resolves deny and settles origin=disconnect", async () => {
    const { broker, emitted } = makeBroker();
    const decision = broker.requestPermission(request);
    broker.denyAll("ui disconnected", "disconnect");

    await expect(decision).resolves.toMatchObject({ behavior: "deny", reason: "ui disconnected" });
    expect(settled(emitted)).toEqual([
      expect.objectContaining({ behavior: "deny", origin: "disconnect" }),
    ]);
  });

  it("turn cancel: denyAll resolves deny and settles origin=turn_cancelled", async () => {
    const { broker, emitted } = makeBroker();
    const decision = broker.requestPermission(request);
    broker.denyAll("turn cancelled", "turn_cancelled");

    await expect(decision).resolves.toMatchObject({ behavior: "deny", reason: "turn cancelled" });
    expect(settled(emitted)).toEqual([
      expect.objectContaining({ behavior: "deny", origin: "turn_cancelled" }),
    ]);
  });

  it("unknown requestId is ignored; the real response still wins", async () => {
    const { broker, emitted } = makeBroker();
    const decision = broker.requestPermission(request);

    broker.handleResponse("not-a-real-id", "allow");
    expect(settled(emitted)).toHaveLength(0);
    expect(broker.pendingCount).toBe(1);

    broker.handleResponse(requestId(emitted), "deny");
    await expect(decision).resolves.toMatchObject({ behavior: "deny" });
    expect(settled(emitted)).toHaveLength(1);
    expect(broker.pendingCount).toBe(0);
  });

  it("double response: the first answer wins, the second is ignored", async () => {
    const { broker, emitted } = makeBroker();
    const decision = broker.requestPermission(request);
    const id = requestId(emitted);

    broker.handleResponse(id, "allow");
    broker.handleResponse(id, "deny");

    await expect(decision).resolves.toEqual({ behavior: "allow" });
    expect(settled(emitted)).toEqual([
      expect.objectContaining({ behavior: "allow", origin: "ui" }),
    ]);
  });
});

describe("IpcPermissionBroker FIFO presentation queue (design §2.12, R7)", () => {
  function requestsOf(emitted: HostToUiMessage[]): Extract<HostToUiMessage, { type: "permission_request" }>[] {
    return emitted.filter(
      (m): m is Extract<HostToUiMessage, { type: "permission_request" }> => m.type === "permission_request",
    );
  }

  it("a second concurrent ask is not sent to the UI until the first settles, then is presented in arrival order", async () => {
    const { broker, emitted } = makeBroker();

    const first = broker.requestPermission({ ...request, toolName: "First" });
    const second = broker.requestPermission({ ...request, toolName: "Second" });

    // Only the first request has been presented; the second is parked (both are "pending").
    expect(requestsOf(emitted)).toHaveLength(1);
    expect(requestsOf(emitted)[0]?.toolName).toBe("First");
    expect(broker.pendingCount).toBe(2);

    broker.handleResponse(requestId(emitted), "allow");
    await expect(first).resolves.toEqual({ behavior: "allow" });

    // Settling the first frees the slot: the second is now presented.
    expect(requestsOf(emitted)).toHaveLength(2);
    expect(requestsOf(emitted)[1]?.toolName).toBe("Second");

    const secondId = requestsOf(emitted)[1]!.requestId;
    broker.handleResponse(secondId, "deny");
    await expect(second).resolves.toMatchObject({ behavior: "deny" });
  });

  it("a third ask queued behind two others is presented only after both prior asks settle", async () => {
    const { broker, emitted } = makeBroker();

    const first = broker.requestPermission({ ...request, toolName: "First" });
    const second = broker.requestPermission({ ...request, toolName: "Second" });
    const third = broker.requestPermission({ ...request, toolName: "Third" });

    expect(requestsOf(emitted).map((r) => r.toolName)).toEqual(["First"]);

    broker.handleResponse(requestsOf(emitted)[0]!.requestId, "deny");
    await expect(first).resolves.toMatchObject({ behavior: "deny" });
    expect(requestsOf(emitted).map((r) => r.toolName)).toEqual(["First", "Second"]);

    broker.handleResponse(requestsOf(emitted)[1]!.requestId, "deny");
    await expect(second).resolves.toMatchObject({ behavior: "deny" });
    expect(requestsOf(emitted).map((r) => r.toolName)).toEqual(["First", "Second", "Third"]);

    broker.handleResponse(requestsOf(emitted)[2]!.requestId, "deny");
    await expect(third).resolves.toMatchObject({ behavior: "deny" });
  });

  it("denyAll drains both the queue and the shown request, without ever presenting the queued ones", async () => {
    const { broker, emitted } = makeBroker();

    const first = broker.requestPermission({ ...request, toolName: "First" });
    const second = broker.requestPermission({ ...request, toolName: "Second" });
    const third = broker.requestPermission({ ...request, toolName: "Third" });

    expect(broker.pendingCount).toBe(3);
    expect(requestsOf(emitted)).toHaveLength(1);

    broker.denyAll("shutting down", "shutdown");

    await expect(first).resolves.toMatchObject({ behavior: "deny" });
    await expect(second).resolves.toMatchObject({ behavior: "deny" });
    await expect(third).resolves.toMatchObject({ behavior: "deny" });

    // The queued asks (Second, Third) were denied WITHOUT ever being presented.
    expect(requestsOf(emitted)).toHaveLength(1);
    expect(settled(emitted)).toHaveLength(3);
    expect(settled(emitted).every((s) => s.origin === "shutdown" && s.behavior === "deny")).toBe(true);
    expect(broker.pendingCount).toBe(0);
  });

  it("denyAll on an empty broker (no pending asks) is a safe no-op", () => {
    const { broker, emitted } = makeBroker();
    expect(() => broker.denyAll("noop", "disconnect")).not.toThrow();
    expect(emitted).toHaveLength(0);
    expect(broker.pendingCount).toBe(0);
  });

  it("the 120s timeout is armed when the request is actually sent to the UI, not when it is queued", async () => {
    vi.useFakeTimers();
    const { broker, emitted } = makeBroker(120_000);

    const first = broker.requestPermission({ ...request, toolName: "First" });
    const second = broker.requestPermission({ ...request, toolName: "Second" });

    // 100s pass while "Second" is still queued (never shown) — it must NOT time out yet,
    // because its own 120s clock has not started (it only starts once presented).
    await vi.advanceTimersByTimeAsync(100_000);
    expect(settled(emitted)).toHaveLength(0);

    // "First" (shown at t=0) times out at 120s while "Second" is still waiting in the queue.
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(first).resolves.toMatchObject({ behavior: "deny" });
    expect(settled(emitted)).toEqual([expect.objectContaining({ behavior: "deny", origin: "timeout" })]);

    // Settling "First" presents "Second" now, at t=120_000 — its own 120s clock starts here.
    expect(requestsOf(emitted).map((r) => r.toolName)).toEqual(["First", "Second"]);

    // 119s after being shown: still not timed out.
    await vi.advanceTimersByTimeAsync(119_000);
    expect(settled(emitted)).toHaveLength(1);

    // 1s later (120s after being shown): now it times out too.
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(second).resolves.toMatchObject({ behavior: "deny" });
    expect(settled(emitted)).toEqual([
      expect.objectContaining({ behavior: "deny", origin: "timeout" }),
      expect.objectContaining({ behavior: "deny", origin: "timeout" }),
    ]);
  });
});

describe("IpcPermissionBroker.pendingToolName (slice 2.2.3, design §5)", () => {
  it("returns the toolName of a still-pending ask (shown or queued)", () => {
    const { broker, emitted } = makeBroker();
    void broker.requestPermission({ ...request, toolName: "Bash" });
    void broker.requestPermission({ ...request, toolName: "Second" });

    const shownId = requestId(emitted);
    expect(broker.pendingToolName(shownId)).toBe("Bash");
    // the second ask is queued (not yet presented) but still resolvable by id.
    expect(broker.pendingCount).toBe(2);

    broker.denyAll("cleanup", "shutdown");
  });

  it("returns undefined for an unknown requestId", () => {
    const { broker } = makeBroker();
    expect(broker.pendingToolName("not-a-real-id")).toBeUndefined();
  });

  it("returns undefined once the ask has settled (handleResponse removes it)", () => {
    const { broker, emitted } = makeBroker();
    void broker.requestPermission(request);
    const id = requestId(emitted);

    broker.handleResponse(id, "allow");

    expect(broker.pendingToolName(id)).toBeUndefined();
  });
});

/**
 * TASK.27: an ExitPlanMode ask is a human reading a whole implementation plan,
 * not a one-glance "allow this command?" — the generic 120 s deadline would
 * fail-closed-deny a plan the user is still reading, and the model would be
 * told the plan was rejected. The plan ask therefore gets its own, longer
 * deadline; it is a floor, never a shortening, so it can only ever be safer
 * than the generic one.
 */
describe("plan-approval ask deadline (TASK.27)", () => {
  const planRequest: PermissionRequest = {
    toolName: "ExitPlanMode",
    input: { plan: "## Plan\n\n1. do the thing" },
    metadata: { ...writeTool.metadata, name: "ExitPlanMode", needsApproval: true },
    mode: "plan",
  };

  it("resolves a longer deadline for ExitPlanMode than for any other tool", () => {
    expect(resolveAskTimeoutMs("ExitPlanMode", PERMISSION_ASK_TIMEOUT_MS)).toBe(PLAN_APPROVAL_ASK_TIMEOUT_MS);
    expect(PLAN_APPROVAL_ASK_TIMEOUT_MS).toBeGreaterThan(PERMISSION_ASK_TIMEOUT_MS);
    expect(resolveAskTimeoutMs("Write", PERMISSION_ASK_TIMEOUT_MS)).toBe(PERMISSION_ASK_TIMEOUT_MS);
    expect(resolveAskTimeoutMs("Bash", 5_000)).toBe(5_000);
  });

  it("is a floor, never a shortening — a host configured with an even longer deadline keeps it", () => {
    const longer = PLAN_APPROVAL_ASK_TIMEOUT_MS * 2;
    expect(resolveAskTimeoutMs("ExitPlanMode", longer)).toBe(longer);
  });

  it("does not deny a pending plan while the generic deadline elapses", async () => {
    vi.useFakeTimers();
    const { broker, emitted } = makeBroker(120_000);
    const decision = broker.requestPermission(planRequest);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(settled(emitted)).toEqual([]);
    expect(broker.pendingCount).toBe(1);

    // Still fail-closed, just later: its own deadline eventually denies it.
    await vi.advanceTimersByTimeAsync(PLAN_APPROVAL_ASK_TIMEOUT_MS);
    await expect(decision).resolves.toMatchObject({ behavior: "deny" });
    expect(settled(emitted)).toEqual([
      expect.objectContaining({ behavior: "deny", origin: "timeout" }),
    ]);
  });
});

/**
 * TASK.138: an unanswered ask means nobody is at the screen, and every later ask
 * in that session is denied outright instead of burning its own full deadline.
 * The live failure this prevents: four serial asks × 120 s of dead wall clock,
 * plus a subagent losing its entire time budget to asks no one could answer.
 */
describe("unattended latch (TASK.138)", () => {
  it("denies later asks immediately, without presenting them, once one expired", async () => {
    vi.useFakeTimers();
    const { broker, emitted } = makeBroker(120_000);
    const first = broker.requestPermission(request);
    await vi.advanceTimersByTimeAsync(120_000);
    await expect(first).resolves.toMatchObject({ behavior: "deny" });
    expect(broker.isUnattended).toBe(true);

    const presentedBefore = emitted.filter((m) => m.type === "permission_request").length;
    // No timer advanced between here and the assertions: the wall clock spent by
    // these five asks is zero, so total wait stays bounded by ONE deadline
    // regardless of how many tools the model tries.
    const later = await Promise.all([
      broker.requestPermission(request),
      broker.requestPermission(request),
      broker.requestPermission(request),
      broker.requestPermission(request),
      broker.requestPermission(request),
    ]);

    expect(later.every((d) => d.behavior === "deny")).toBe(true);
    expect(emitted.filter((m) => m.type === "permission_request").length).toBe(presentedBefore);
    expect(broker.pendingCount).toBe(0);
  });

  it("tells the model the refusal is not on the merits and that retrying will not help", async () => {
    vi.useFakeTimers();
    const { broker } = makeBroker(120_000);
    const first = broker.requestPermission(request);
    await vi.advanceTimersByTimeAsync(120_000);

    const expired = await first;
    expect(expired.behavior).toBe("deny");
    const expiredReason = expired.behavior === "deny" ? expired.reason : "";
    expect(expiredReason).toContain("no one answered");
    expect(expiredReason).toContain("NOT a refusal on the merits");
    expect(expiredReason).toContain("rephrased equivalent");

    const latched = await broker.requestPermission(request);
    expect(latched.behavior).toBe("deny");
    const latchedReason = latched.behavior === "deny" ? latched.reason : "";
    expect(latchedReason).toContain("unattended");
    expect(latchedReason).toContain("NOT a refusal on the merits");
  });

  it("a permission answer disarms the latch — asking resumes", async () => {
    vi.useFakeTimers();
    const { broker, emitted } = makeBroker(120_000);
    const first = broker.requestPermission(request);
    await vi.advanceTimersByTimeAsync(120_000);
    await first;
    expect(broker.isUnattended).toBe(true);

    // The click lands on an ask that already expired: unknown requestId, ignored
    // as a decision — but it is still proof that a human came back.
    broker.handleResponse(requestId(emitted), "allow");
    expect(broker.isUnattended).toBe(false);

    const presentedBefore = emitted.filter((m) => m.type === "permission_request").length;
    void broker.requestPermission(request);
    expect(emitted.filter((m) => m.type === "permission_request").length).toBe(presentedBefore + 1);
  });

  it("noteHumanPresent disarms the latch and is idempotent when it was never armed", async () => {
    vi.useFakeTimers();
    const { broker } = makeBroker(120_000);
    broker.noteHumanPresent();
    expect(broker.isUnattended).toBe(false);

    const first = broker.requestPermission(request);
    await vi.advanceTimersByTimeAsync(120_000);
    await first;
    expect(broker.isUnattended).toBe(true);

    broker.noteHumanPresent();
    broker.noteHumanPresent();
    expect(broker.isUnattended).toBe(false);
  });

  it("the latch never turns an ask into an allow", async () => {
    vi.useFakeTimers();
    const { broker } = makeBroker(120_000);
    const first = broker.requestPermission(request);
    await vi.advanceTimersByTimeAsync(120_000);
    await first;

    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const decision = await broker.requestPermission(request);
      expect(decision.behavior).toBe("deny");
    }
  });
});

/**
 * TASK.144: the always-allow seam the two ENGINE boots pass and the core boot
 * deliberately does not (see PermissionRuleMatcher's header). These assert both
 * halves: a matching rule is answered without ever reaching the UI, and a
 * broker constructed without the seam is byte-identical to every pre-TASK.144
 * one — which is what makes the core path's hook-can-still-ask invariant safe.
 */
describe("IpcPermissionBroker always-allow rules (TASK.144)", () => {
  function makeRuledBroker(matches: (toolName: string, input: unknown) => boolean): {
    broker: IpcPermissionBroker;
    emitted: HostToUiMessage[];
    seen: { toolName: string; input: unknown }[];
  } {
    const emitted: HostToUiMessage[] = [];
    const seen: { toolName: string; input: unknown }[] = [];
    const broker = new IpcPermissionBroker((message) => emitted.push(message), undefined, {
      matches(toolName, input) {
        seen.push({ toolName, input });
        return matches(toolName, input);
      },
    });
    return { broker, emitted, seen };
  }

  it("answers a matching ask with allow, without a permission_request and without parking it", async () => {
    const { broker, emitted, seen } = makeRuledBroker(() => true);

    await expect(broker.requestPermission(request)).resolves.toEqual({ behavior: "allow" });
    // Nothing reached the UI at all — neither the ask nor a settle it would
    // have to reconcile against an ask it never saw.
    expect(emitted).toEqual([]);
    expect(broker.pendingCount).toBe(0);
    // The store is consulted with the ask's own toolName and raw input, never a
    // translated one: a stored `Bash` rule must not vouch for `CodexExec`.
    expect(seen).toEqual([{ toolName: "Write", input: request.input }]);
  });

  it("arms no deadline for a rule-allowed ask", async () => {
    vi.useFakeTimers();
    const { broker, emitted } = makeRuledBroker(() => true);

    await expect(broker.requestPermission(request)).resolves.toEqual({ behavior: "allow" });
    await vi.advanceTimersByTimeAsync(PERMISSION_ASK_TIMEOUT_MS * 2);
    expect(settled(emitted)).toEqual([]);
  });

  it("presents a non-matching ask exactly as before", async () => {
    const { broker, emitted } = makeRuledBroker(() => false);
    const decision = broker.requestPermission(request);

    expect(broker.pendingCount).toBe(1);
    broker.handleResponse(requestId(emitted), "deny");
    await expect(decision).resolves.toMatchObject({ behavior: "deny" });
  });

  it("does not queue behind a shown ask: a rule-allowed call resolves while another is in front of the UI", async () => {
    const { broker, emitted } = makeRuledBroker((toolName) => toolName === "Read");
    const shown = broker.requestPermission(request);
    expect(emitted.filter((m) => m.type === "permission_request")).toHaveLength(1);

    // The FIFO queue exists because the renderer has one modal slot. A rule
    // match never needs that slot, so it must not inherit the queue's latency —
    // otherwise an always-allowed read would still wait out the human.
    const readRequest: PermissionRequest = { ...request, toolName: "Read", input: { file_path: "/workspace/a.txt" } };
    await expect(broker.requestPermission(readRequest)).resolves.toEqual({ behavior: "allow" });
    expect(emitted.filter((m) => m.type === "permission_request")).toHaveLength(1);
    expect(broker.pendingCount).toBe(1);

    broker.handleResponse(requestId(emitted), "allow");
    await expect(shown).resolves.toMatchObject({ behavior: "allow" });
  });

  it("without the seam (the core boot's broker) every ask is still parked and presented", async () => {
    const { broker, emitted } = makeBroker();
    const decision = broker.requestPermission(request);

    expect(broker.pendingCount).toBe(1);
    expect(emitted.filter((m) => m.type === "permission_request")).toHaveLength(1);
    broker.handleResponse(requestId(emitted), "allow");
    await expect(decision).resolves.toMatchObject({ behavior: "allow" });
  });
});

/**
 * Where TASK.138's latch and TASK.144's rule seam meet — a case neither branch
 * could see alone, since each shipped without the other. The rule wins: it is a
 * standing human answer given in advance, so the "nobody is at the screen"
 * premise the latch reasons from simply does not apply to it. The opposite
 * order would switch every always-allow rule off the moment the latch armed,
 * defeating exactly the unattended runs the rules exist to serve.
 */
describe("always-allow rules vs the unattended latch", () => {
  function makeLatchedRuledBroker(matches: (toolName: string) => boolean): {
    broker: IpcPermissionBroker;
    emitted: HostToUiMessage[];
  } {
    const emitted: HostToUiMessage[] = [];
    const broker = new IpcPermissionBroker((message) => emitted.push(message), 120_000, {
      matches: (toolName) => matches(toolName),
    });
    return { broker, emitted };
  }

  it("still allows a rule-matched call after the latch has armed", async () => {
    vi.useFakeTimers();
    const { broker, emitted } = makeLatchedRuledBroker((toolName) => toolName === "Read");

    // Arm the latch on a call no rule covers.
    const first = broker.requestPermission(request);
    await vi.advanceTimersByTimeAsync(120_000);
    await expect(first).resolves.toMatchObject({ behavior: "deny" });
    expect(broker.isUnattended).toBe(true);

    const readRequest: PermissionRequest = {
      ...request,
      toolName: "Read",
      input: { file_path: "/workspace/a.txt" },
    };
    await expect(broker.requestPermission(readRequest)).resolves.toEqual({ behavior: "allow" });
    expect(broker.pendingCount).toBe(0);
    // Allowed without ever going in front of a UI nobody is watching.
    expect(emitted.filter((m) => m.type === "permission_request")).toHaveLength(1);
  });

  it("keeps denying an unmatched call while the latch is armed", async () => {
    vi.useFakeTimers();
    const { broker } = makeLatchedRuledBroker((toolName) => toolName === "Read");

    const first = broker.requestPermission(request);
    await vi.advanceTimersByTimeAsync(120_000);
    await first;

    const decision = await broker.requestPermission(request);
    expect(decision.behavior).toBe("deny");
    const reason = decision.behavior === "deny" ? decision.reason : "";
    expect(reason).toContain("unattended");
  });

  it("a rule-allowed call is not proof of a human — the latch stays armed", async () => {
    vi.useFakeTimers();
    const { broker } = makeLatchedRuledBroker((toolName) => toolName === "Read");

    const first = broker.requestPermission(request);
    await vi.advanceTimersByTimeAsync(120_000);
    await first;

    await broker.requestPermission({
      ...request,
      toolName: "Read",
      input: { file_path: "/workspace/a.txt" },
    });
    expect(broker.isUnattended).toBe(true);
  });
});
