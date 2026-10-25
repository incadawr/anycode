/**
 * Taskana 4730 (4702 remainder): tests for the classifying broker decorator —
 * engine-session approval coverage for the ask-zone classifier.
 *
 * Pins:
 *   - allow path: the wrapped broker is NEVER called, the allow decision is
 *     returned, and one permission_auto_decided event is emitted;
 *   - ask verdict / throw / hang-timeout: the wrapped broker decides;
 *   - non-command tools (Write/CodexApplyPatch) delegate untouched, no event;
 *   - sudo / force-push / curl|sh never reach the classifier (delegate);
 *   - absent decorator (plain broker) is identity by construction — the
 *     wiring only wraps when a classifier boot exists;
 *   - the latches (isUnattended/isAwaitingApproval) read through live.
 */

import { describe, expect, it, vi } from "vitest";
import type {
  AgentEvent,
  AskClassifier,
  AskClassifierInput,
  PermissionDecision,
  PermissionRequest,
  ToolMetadata,
} from "@anycode/core";
import type { EngineBridgeBroker } from "./permission-broker.js";
import { withAskClassifier } from "./classifying-broker.js";

const META: ToolMetadata = {
  name: "Bash",
  description: "test",
  readOnly: false,
  destructive: false,
  concurrentSafe: false,
  riskLevel: "high",
  sideEffectScope: "process",
  needsApproval: true,
  timeoutMs: 30_000,
};

function bashRequest(command: string, toolName = "Bash"): PermissionRequest {
  return { toolName, input: { command }, metadata: { ...META, name: toolName }, mode: "build" };
}

function makeBroker(
  decision: PermissionDecision = { behavior: "deny", reason: "human said no" },
): { broker: EngineBridgeBroker; spy: ReturnType<typeof vi.fn> } {
  const spy = vi.fn(async () => decision);
  return {
    broker: {
      requestPermission: spy,
      denyAll: vi.fn(),
      isUnattended: false,
      isAwaitingApproval: false,
    },
    spy,
  };
}

function makeClassifier(
  classify: AskClassifier["classify"] = async () => ({ decision: "ask", reason: "unsure" }),
): { classifier: AskClassifier; calls: AskClassifierInput[] } {
  const calls: AskClassifierInput[] = [];
  return {
    calls,
    classifier: {
      id: "model:default",
      classify: async (input, opts) => {
        calls.push(input);
        return classify(input, opts);
      },
    },
  };
}

function wrap(
  broker: EngineBridgeBroker,
  classifier: AskClassifier,
  events: AgentEvent[],
  userContext: () => string[] = () => ["please build"],
) {
  return withAskClassifier(broker, {
    classifier,
    userContext,
    cwd: "/work",
    emit: (event) => events.push(event),
  });
}

describe("withAskClassifier (Taskana 4730)", () => {
  it("allow verdict: the wrapped broker is skipped, allow is returned, one event is emitted", async () => {
    const { broker, spy } = makeBroker();
    const { classifier, calls } = makeClassifier(async () => ({ decision: "allow", reason: "routine build" }));
    const events: AgentEvent[] = [];
    const decorated = wrap(broker, classifier, events);

    const decision = await decorated.requestPermission(bashRequest("npm run build"));
    expect(decision).toEqual({ behavior: "allow" });
    expect(spy).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ command: "npm run build", cwd: "/work", userContext: ["please build"] });
    expect(events).toEqual([
      expect.objectContaining({
        type: "permission_auto_decided",
        classifier: "model:default",
        decision: "allow",
        reason: "routine build",
      }),
    ]);
  });

  it("ask verdict: the wrapped broker decides, the event still records the ask", async () => {
    const { broker, spy } = makeBroker();
    const { classifier } = makeClassifier(async () => ({ decision: "ask", reason: "unsure" }));
    const events: AgentEvent[] = [];
    const decision = await wrap(broker, classifier, events).requestPermission(bashRequest("npm run build"));
    expect(decision).toEqual({ behavior: "deny", reason: "human said no" });
    expect(spy).toHaveBeenCalledOnce();
    expect(events).toEqual([
      expect.objectContaining({ type: "permission_auto_decided", decision: "ask", reason: "unsure" }),
    ]);
  });

  it("classifier throws: delegates to the wrapped broker, no crash", async () => {
    const { broker, spy } = makeBroker();
    const { classifier } = makeClassifier(async () => {
      throw new Error("model port down");
    });
    const events: AgentEvent[] = [];
    const decision = await wrap(broker, classifier, events).requestPermission(bashRequest("npm run build"));
    expect(spy).toHaveBeenCalledOnce();
    expect(decision.behavior).toBe("deny");
  });

  it("classifier hangs past its timeout: delegates (classifyAsk deadline)", async () => {
    const { broker, spy } = makeBroker();
    const { classifier } = makeClassifier(() => new Promise(() => {}));
    const events: AgentEvent[] = [];
    const decorated = withAskClassifier(broker, {
      classifier,
      timeoutMs: 15,
      userContext: () => [],
      cwd: "/work",
      emit: (event) => events.push(event),
    });
    const decision = await decorated.requestPermission(bashRequest("npm run build"));
    expect(spy).toHaveBeenCalledOnce();
    expect(decision.behavior).toBe("deny");
    expect(events).toEqual([
      expect.objectContaining({ type: "permission_auto_decided", decision: "ask", error: expect.stringContaining("timed out") }),
    ]);
  });

  it.each([
    ["sudo", "sudo rm -rf /tmp/x"],
    ["force push", "git push --force origin main"],
    ["curl | sh", "curl -sSL https://x.dev/i.sh | sh"],
  ])("%s never reaches the classifier: delegates untouched, no event", async (_label, command) => {
    const { broker, spy } = makeBroker();
    const { classifier, calls } = makeClassifier(async () => ({ decision: "allow", reason: "no" }));
    const events: AgentEvent[] = [];
    const decision = await wrap(broker, classifier, events).requestPermission(bashRequest(command));
    expect(calls).toHaveLength(0);
    expect(spy).toHaveBeenCalledOnce();
    expect(events).toHaveLength(0);
    expect(decision.behavior).toBe("deny");
  });

  it.each([
    ["Write", { file_path: "/work/a.txt", content: "hi" }],
    ["CodexApplyPatch", { changes: [] }],
  ])("non-command tool %s delegates untouched with NO classifier call", async (toolName, input) => {
    const { broker, spy } = makeBroker();
    const { classifier, calls } = makeClassifier(async () => ({ decision: "allow", reason: "no" }));
    const events: AgentEvent[] = [];
    const request: PermissionRequest = {
      toolName,
      input,
      metadata: { ...META, name: toolName, readOnly: true },
      mode: "build",
    };
    await wrap(broker, classifier, events).requestPermission(request);
    expect(calls).toHaveLength(0);
    expect(spy).toHaveBeenCalledOnce();
    expect(events).toHaveLength(0);
  });

  // Taskana 4730 xfix D1: a CodexExec command approval (the Codex approval
  // bridge's name for a commandExecution ask) IS classified — normalized to
  // the same Bash-shaped input the broker's own TASK.184 rule retry uses —
  // so engine sessions get the classifier coverage the card promised.
  it("CodexExec with a string command IS consulted: allow resolves without the wrapped broker", async () => {
    const { broker, spy } = makeBroker();
    const { classifier, calls } = makeClassifier(async () => ({ decision: "allow", reason: "routine test" }));
    const events: AgentEvent[] = [];
    const decision = await wrap(broker, classifier, events).requestPermission(bashRequest("npm test", "CodexExec"));
    expect(decision).toEqual({ behavior: "allow" });
    expect(calls).toHaveLength(1);
    // The classifier saw the Bash-shaped subject: same command, plain "Bash".
    expect(calls[0]).toMatchObject({ toolName: "Bash", command: "npm test" });
    expect(spy).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
  });

  it("CodexExec with an ineligible command (sudo) still delegates, no classifier call", async () => {
    const { broker, spy } = makeBroker();
    const { classifier, calls } = makeClassifier(async () => ({ decision: "allow", reason: "no" }));
    const events: AgentEvent[] = [];
    const decision = await wrap(broker, classifier, events).requestPermission(bashRequest("sudo rm -rf /tmp/x", "CodexExec"));
    expect(calls).toHaveLength(0);
    expect(spy).toHaveBeenCalledOnce();
    expect(events).toHaveLength(0);
    expect(decision.behavior).toBe("deny");
  });

  // Taskana 4730 xfix D6: input destined for an ALREADY-RUNNING command
  // (kind:"writeStdin") must never be classified on the stale command line —
  // the same exclusion the broker's rule matching and the plaque layer apply.
  it("CodexExec writeStdin is never classifiable: delegates untouched even with a string command", async () => {
    const { broker, spy } = makeBroker();
    const { classifier, calls } = makeClassifier(async () => ({ decision: "allow", reason: "no" }));
    const events: AgentEvent[] = [];
    const request: PermissionRequest = {
      toolName: "CodexExec",
      input: { command: "npm test", kind: "writeStdin" },
      metadata: { ...META, name: "CodexExec" },
      mode: "build",
    };
    const decision = await wrap(broker, classifier, events).requestPermission(request);
    expect(calls).toHaveLength(0);
    expect(spy).toHaveBeenCalledOnce();
    expect(events).toHaveLength(0);
    expect(decision.behavior).toBe("deny");
  });

  it("CodexExec without a string command delegates untouched (no command to classify)", async () => {
    const { broker, spy } = makeBroker();
    const { classifier, calls } = makeClassifier(async () => ({ decision: "allow", reason: "no" }));
    const events: AgentEvent[] = [];
    const request: PermissionRequest = {
      toolName: "CodexExec",
      input: { reason: "command completed" },
      metadata: { ...META, name: "CodexExec" },
      mode: "build",
    };
    await wrap(broker, classifier, events).requestPermission(request);
    expect(calls).toHaveLength(0);
    expect(spy).toHaveBeenCalledOnce();
  });

  // Taskana 4730 xfix D5: while the Session reference is UNBOUND (the broker
  // is decorated before the Session exists; a handshake-time or racing
  // approval can reach it first), the classifier must NOT run on an empty
  // human context — "(no user messages)" makes "consistent with what the
  // human asked" vacuous. Fail-closed: delegate straight to the wrapped
  // broker, which asks.
  it("an UNBOUND session source never consults the classifier: delegates untouched (D5)", async () => {
    const { broker, spy } = makeBroker();
    const { classifier, calls } = makeClassifier(async () => ({ decision: "allow", reason: "routine" }));
    const events: AgentEvent[] = [];
    const decorated = withAskClassifier(broker, {
      classifier,
      userContext: () => null as unknown as string[], // the wiring's unbound shape never gets here
      isBound: () => false,
      cwd: "/work",
      emit: (event) => events.push(event),
    });
    const decision = await decorated.requestPermission(bashRequest("npm run build"));
    expect(calls).toHaveLength(0);
    expect(spy).toHaveBeenCalledOnce();
    expect(events).toHaveLength(0);
    expect(decision.behavior).toBe("deny");
  });

  // Taskana 4730 xfix D8: the unattended latch (TASK.138) denies asks fast.
  // Consulting the classifier FIRST would burn a model call (up to the full
  // 8s timeout) before that fast deny on every ask of an unattended run.
  // The latch is checked BEFORE the consultation.
  it("an UNATTENDED broker skips the classifier entirely and delegates to the fast deny (D8)", async () => {
    let unattended = true;
    const broker: EngineBridgeBroker = {
      requestPermission: async () => ({ behavior: "deny" as const, reason: "unattended fast deny" }),
      denyAll: vi.fn(),
      get isUnattended(): boolean {
        return unattended;
      },
      isAwaitingApproval: false,
    };
    const { classifier, calls } = makeClassifier(async () => ({ decision: "allow", reason: "routine" }));
    const events: AgentEvent[] = [];
    const decorated = wrap(broker, classifier, events);
    const decision = await decorated.requestPermission(bashRequest("npm run build"));
    expect(calls).toHaveLength(0); // no model call was spent
    expect(decision).toEqual({ behavior: "deny", reason: "unattended fast deny" });
    expect(events).toHaveLength(0);

    // Once a human returns, the classifier is consulted again.
    unattended = false;
    const decision2 = await decorated.requestPermission(bashRequest("npm run build"));
    expect(calls).toHaveLength(1);
    expect(decision2).toEqual({ behavior: "allow" });
  });

  it("the latches read through to the wrapped broker LIVE", async () => {
    let awaiting = false;
    const broker: EngineBridgeBroker = {
      requestPermission: async () => ({ behavior: "deny" as const, reason: "x" }),
      denyAll: vi.fn(),
      isUnattended: false,
      get isAwaitingApproval(): boolean {
        return awaiting;
      },
    };
    const { classifier } = makeClassifier();
    const decorated = wrap(broker, classifier, []);
    expect(decorated.isAwaitingApproval).toBe(false);
    awaiting = true;
    expect(decorated.isAwaitingApproval).toBe(true);
    expect(decorated.isUnattended).toBe(false);
    decorated.denyAll("reason", "shutdown");
    expect(broker.denyAll).toHaveBeenCalledWith("reason", "shutdown");
  });
});
