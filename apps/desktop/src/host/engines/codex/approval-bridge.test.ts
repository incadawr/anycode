import { describe, expect, it, vi } from "vitest";
import type { HostToUiMessage } from "../../../shared/protocol.js";
import { IpcPermissionBroker } from "../../permission-broker.js";
import { CODEX_APPROVAL_ERROR_CODE, CodexApprovalBridge, type ActiveCodexTurn } from "./approval-bridge.js";
import type { JsonRpcServerRequest } from "./protocol.js";
import { TurnItemIndex } from "./turn-item-index.js";

const ACTIVE = { threadId: "thread-1", turnId: "turn-1" };

function request(method: string, params: unknown): JsonRpcServerRequest {
  return { id: "rpc-1", method, params };
}

/** Exact live command-approval params (w1-p1): no `reason` field exists at all. */
function command(params: Record<string, unknown> = {}): JsonRpcServerRequest {
  return request("item/commandExecution/requestApproval", {
    ...ACTIVE,
    itemId: "item-command",
    startedAtMs: 1_783_965_236_075,
    environmentId: "local",
    command: "git status",
    cwd: "/workspace",
    commandActions: [{ type: "unknown", command: "git status" }],
    proposedExecpolicyAmendment: null,
    availableDecisions: ["accept", "acceptWithExecpolicyAmendment", "cancel"],
    ...params,
  });
}

/** Exact live file-change approval params (w1-p3): no diff, no path, nullable fields. */
function file(params: Record<string, unknown> = {}): JsonRpcServerRequest {
  return request("item/fileChange/requestApproval", {
    ...ACTIVE,
    itemId: "item-file",
    startedAtMs: 1_783_965_343_890,
    reason: null,
    grantRoot: null,
    ...params,
  });
}

function responder() {
  return { result: vi.fn(), error: vi.fn() };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function rig(timeoutMs?: number, active: ActiveCodexTurn = ACTIVE) {
  const emitted: HostToUiMessage[] = [];
  const broker = new IpcPermissionBroker((message) => emitted.push(message), timeoutMs);
  const bridge = new CodexApprovalBridge({ broker, activeTurn: () => active });
  return { bridge, broker, emitted };
}

function ask(emitted: HostToUiMessage[]) {
  const message = emitted.filter((entry) => entry.type === "permission_request").at(-1);
  if (!message || message.type !== "permission_request") throw new Error("missing permission request");
  return message;
}

describe("CodexApprovalBridge — decisions", () => {
  it("answers allow with accept and deny with decline (both families, turn continues)", async () => {
    const { bridge, broker, emitted } = rig();

    const exec = responder();
    bridge.handle(command(), exec);
    await flush();
    expect(ask(emitted)).toMatchObject({
      toolName: "CodexExec",
      input: { command: "git status", cwd: "/workspace" },
      mode: "build",
      metadata: { riskLevel: "high", sideEffectScope: "process" },
    });
    broker.handleResponse(ask(emitted).requestId, "allow");
    await flush();
    expect(exec.result).toHaveBeenCalledWith({ decision: "accept" });
    expect(exec.error).not.toHaveBeenCalled();

    const patch = responder();
    bridge.handle(file(), patch);
    await flush();
    expect(ask(emitted)).toMatchObject({ toolName: "CodexApplyPatch", metadata: { sideEffectScope: "filesystem" } });
    broker.handleResponse(ask(emitted).requestId, "deny");
    await flush();
    // Deny is a NORMAL protocol answer: `decline` is accepted by both families
    // (L1) and never a JSON-RPC error, so the runtime survives it.
    expect(patch.result).toHaveBeenCalledWith({ decision: "decline" });
    expect(patch.error).not.toHaveBeenCalled();
  });

  it("declines (never errors) when the ask deadline expires", async () => {
    const { bridge } = rig(1);
    const response = responder();
    bridge.handle(command(), response);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(response.result).toHaveBeenCalledWith({ decision: "decline" });
    expect(response.error).not.toHaveBeenCalled();
  });

  it("answers cancel when the parked ask is settled because the turn is going away", async () => {
    for (const origin of ["turn_cancelled", "disconnect", "shutdown"] as const) {
      const { bridge } = rig();
      const response = responder();
      bridge.handle(command(), response);
      await flush();
      bridge.denyAll("stop", origin);
      await flush();
      expect(response.result).toHaveBeenCalledWith({ decision: "cancel" });
      expect(response.error).not.toHaveBeenCalled();
    }
  });

  it("never grants: an unknown, identity-less, or stale request gets one scoped JSON-RPC error", async () => {
    const { bridge, emitted } = rig();
    const unknown = responder();
    bridge.handle(request("permissions/requestApproval", { ...ACTIVE, itemId: "x" }), unknown);
    const noParams = responder();
    bridge.handle(request("item/commandExecution/requestApproval", "nonsense"), noParams);
    const noItemId = responder();
    bridge.handle(command({ itemId: undefined }), noItemId);
    const stale = responder();
    bridge.handle(command({ turnId: "old-turn" }), stale);
    await flush();

    for (const response of [unknown, noParams, noItemId, stale]) {
      expect(response.result).not.toHaveBeenCalled();
      expect(response.error).toHaveBeenCalledTimes(1);
      expect(response.error).toHaveBeenCalledWith(expect.objectContaining({ code: CODEX_APPROVAL_ERROR_CODE }));
    }
    expect(emitted).toEqual([]);
  });

  it("rejects a concurrent second approval without touching the first", async () => {
    const { bridge, broker, emitted } = rig();
    const first = responder();
    const second = responder();
    bridge.handle(command(), first);
    await flush();
    bridge.handle(file(), second);
    await flush();
    expect(second.error).toHaveBeenCalledWith(expect.objectContaining({ code: CODEX_APPROVAL_ERROR_CODE }));

    broker.handleResponse(ask(emitted).requestId, "deny");
    broker.handleResponse(ask(emitted).requestId, "allow");
    await flush();
    expect(first.result).toHaveBeenCalledTimes(1);
    expect(first.result).toHaveBeenCalledWith({ decision: "decline" });
  });
});

describe("CodexApprovalBridge — tolerant decoding (TASK.38 DoD)", () => {
  it("accepts optional/null fields and unknown extra keys without rejecting", async () => {
    const { bridge, emitted } = rig();

    // File change with reason/grantRoot entirely ABSENT plus an undeclared key.
    const patch = responder();
    bridge.handle(
      request("item/fileChange/requestApproval", { ...ACTIVE, itemId: "item-file", futureField: { nested: true } }),
      patch,
    );
    await flush();
    expect(patch.error).not.toHaveBeenCalled();
    expect(ask(emitted)).toMatchObject({ toolName: "CodexApplyPatch", input: { reason: null, grantRoot: null } });
  });

  it("presents a command approval whose optional command/cwd are missing or wrongly typed", async () => {
    const { bridge, emitted } = rig();
    const response = responder();
    bridge.handle(command({ command: undefined, cwd: 17 }), response);
    await flush();
    expect(response.error).not.toHaveBeenCalled();
    const presented = ask(emitted);
    expect(presented.toolName).toBe("CodexExec");
    expect((presented.input as Record<string, unknown>).cwd).toBeUndefined();
    // `availableDecisions` is projected for display only — it never gates the
    // decision (decline is accepted even when unlisted, L1).
    expect((presented.input as Record<string, unknown>).availableDecisions)
      .toEqual(["accept", "acceptWithExecpolicyAmendment", "cancel"]);
  });

  it("correlates a file change with its item/started details so the modal shows real paths", async () => {
    const items = new TurnItemIndex();
    items.record({
      type: "fileChange",
      id: "item-file",
      status: "inProgress",
      changes: [
        { path: "/repo/a.txt", kind: { type: "add" }, diff: "+a\n" },
        { path: "/repo/b.txt", kind: { type: "update" }, diff: "+b\n" },
      ],
    });
    const { bridge, emitted } = rig(undefined, { ...ACTIVE, items });
    const response = responder();
    bridge.handle(file(), response);
    await flush();

    expect(response.error).not.toHaveBeenCalled();
    expect(ask(emitted).input).toEqual({
      reason: null,
      grantRoot: null,
      paths: ["/repo/a.txt", "/repo/b.txt"],
      changes: [
        { path: "/repo/a.txt", kind: "add", diff: "+a\n" },
        { path: "/repo/b.txt", kind: "update", diff: "+b\n" },
      ],
    });
  });

  it("still presents an approval whose item was never indexed (degraded, not fail-closed)", async () => {
    const { bridge, emitted } = rig(undefined, { ...ACTIVE, items: new TurnItemIndex() });
    const response = responder();
    bridge.handle(file(), response);
    await flush();
    expect(response.error).not.toHaveBeenCalled();
    expect(ask(emitted).input).toEqual({ reason: null, grantRoot: null });
  });

  it("backfills a command approval that omits command/cwd from the indexed item", async () => {
    const items = new TurnItemIndex();
    items.record({ type: "commandExecution", id: "item-command", command: "rg TODO", cwd: "/repo" });
    const { bridge, emitted } = rig(undefined, { ...ACTIVE, items });
    const response = responder();
    bridge.handle(command({ command: undefined, cwd: undefined }), response);
    await flush();
    expect(ask(emitted).input).toMatchObject({ command: "rg TODO", cwd: "/repo" });
  });
});
