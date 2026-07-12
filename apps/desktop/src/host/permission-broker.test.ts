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
import { IpcPermissionBroker, toWireToolMeta } from "./permission-broker.js";

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
