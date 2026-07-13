import { describe, expect, it, vi } from "vitest";
import type { HostToUiMessage } from "../../../shared/protocol.js";
import { IpcPermissionBroker } from "../../permission-broker.js";
import { CODEX_APPROVAL_ERROR_CODE, CodexApprovalBridge } from "./approval-bridge.js";
import type { JsonRpcServerRequest } from "./protocol.js";

const ACTIVE = { threadId: "thread-1", turnId: "turn-1" };

function request(method: string, params: Record<string, unknown>): JsonRpcServerRequest {
  return { id: "rpc-1", method, params };
}

function command(params: Partial<Record<string, unknown>> = {}): JsonRpcServerRequest {
  return request("item/commandExecution/requestApproval", {
    ...ACTIVE,
    itemId: "item-command",
    command: "git status",
    cwd: "/workspace",
    ...params,
  });
}

function file(params: Partial<Record<string, unknown>> = {}): JsonRpcServerRequest {
  return request("item/fileChange/requestApproval", {
    ...ACTIVE,
    itemId: "item-file",
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
}

function rig(timeoutMs?: number) {
  const emitted: HostToUiMessage[] = [];
  const broker = new IpcPermissionBroker((message) => emitted.push(message), timeoutMs);
  const bridge = new CodexApprovalBridge({ broker, activeTurn: () => ACTIVE });
  return { bridge, broker, emitted };
}

describe("CodexApprovalBridge", () => {
  it("maps the two observed request shapes to high-risk, build-mode UI asks and answers only accept", async () => {
    const { bridge, broker, emitted } = rig();
    const exec = responder();
    bridge.handle(command(), exec);
    await flush();
    const ask = emitted.find((message) => message.type === "permission_request");
    expect(ask).toMatchObject({
      toolName: "CodexExec",
      input: { command: "git status", cwd: "/workspace" },
      mode: "build",
      metadata: { riskLevel: "high", sideEffectScope: "process" },
    });
    if (!ask || ask.type !== "permission_request") throw new Error("missing permission request");
    broker.handleResponse(ask.requestId, "allow");
    await flush();
    expect(exec.result).toHaveBeenCalledWith({ decision: "accept" });
    expect(exec.error).not.toHaveBeenCalled();

    const patch = responder();
    bridge.handle(file(), patch);
    await flush();
    const patchAsk = emitted.filter((message) => message.type === "permission_request").at(-1);
    expect(patchAsk).toMatchObject({
      toolName: "CodexApplyPatch",
      input: { reason: null, grantRoot: null },
      metadata: { riskLevel: "high", sideEffectScope: "filesystem" },
    });
  });

  it("rejects unknown, malformed, and stale requests without presenting UI", async () => {
    const { bridge, emitted } = rig();
    const invalid = responder();
    bridge.handle(request("permissions/requestApproval", { ...ACTIVE }), invalid);
    const malformed = responder();
    bridge.handle(command({ cwd: 17 }), malformed);
    const stale = responder();
    bridge.handle(command({ turnId: "old-turn" }), stale);
    await flush();
    for (const response of [invalid, malformed, stale]) {
      expect(response.result).not.toHaveBeenCalled();
      expect(response.error).toHaveBeenCalledTimes(1);
      expect(response.error).toHaveBeenCalledWith(expect.objectContaining({ code: CODEX_APPROVAL_ERROR_CODE }));
    }
    expect(emitted).toEqual([]);
  });

  it("rejects overload immediately and denies every non-allow settlement exactly once", async () => {
    const { bridge, broker, emitted } = rig();
    const first = responder();
    const second = responder();
    bridge.handle(command(), first);
    await flush();
    bridge.handle(file(), second);
    await flush();
    expect(second.error).toHaveBeenCalledWith(expect.objectContaining({ code: CODEX_APPROVAL_ERROR_CODE }));
    const ask = emitted.find((message) => message.type === "permission_request");
    if (!ask || ask.type !== "permission_request") throw new Error("missing permission request");
    broker.handleResponse(ask.requestId, "deny");
    broker.handleResponse(ask.requestId, "allow");
    await flush();
    expect(first.result).not.toHaveBeenCalled();
    expect(first.error).toHaveBeenCalledTimes(1);
    expect(first.error).toHaveBeenCalledWith(expect.objectContaining({ code: CODEX_APPROVAL_ERROR_CODE }));
  });

  it("turn cancellation, disconnect, and shutdown settle the sole request as a JSON-RPC denial", async () => {
    for (const origin of ["turn_cancelled", "disconnect", "shutdown"] as const) {
      const { bridge } = rig();
      const response = responder();
      bridge.handle(command(), response);
      await flush();
      bridge.denyAll("forced close", origin);
      await flush();
      expect(response.result).not.toHaveBeenCalled();
      expect(response.error).toHaveBeenCalledTimes(1);
      expect(response.error).toHaveBeenCalledWith(expect.objectContaining({ code: CODEX_APPROVAL_ERROR_CODE }));
    }
  });

  it("converts a broker deadline into the same no-grant JSON-RPC error", async () => {
    const { bridge } = rig(1);
    const response = responder();
    bridge.handle(command(), response);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(response.result).not.toHaveBeenCalled();
    expect(response.error).toHaveBeenCalledTimes(1);
    expect(response.error).toHaveBeenCalledWith(expect.objectContaining({ code: CODEX_APPROVAL_ERROR_CODE }));
  });
});
