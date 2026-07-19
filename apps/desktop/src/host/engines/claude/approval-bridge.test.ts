/**
 * Approval-bridge tests, byte-anchored to the live exchange captured in
 * `w0-02-control-writeprobe.jsonl` (cut §1.4 DoD, hazard (в)): the allow
 * payload this bridge produces must equal, field for field, the one the real
 * CLI accepted — an allow that quietly drops `updatedInput`/`toolUseID`
 * degrades silently rather than failing loudly.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PermissionDecision, PermissionRequest } from "@anycode/core";
import type { IpcPermissionBroker } from "../../permission-broker.js";
import type { ControlRequestResponder, InboundControlRequest } from "./claude-client.js";
import { ClaudeApprovalBridge, allowResponse, decodeCanUseTool, denyResponse } from "./approval-bridge.js";

const FIXTURES_DIR = join(new URL(".", import.meta.url).pathname, "contract", "fixtures");

/** The captured `can_use_tool` request and the answer the live CLI accepted. */
function liveWriteProbeExchange(): { request: Record<string, unknown>; acceptedResponse: Record<string, unknown> } {
  const lines = readFileSync(join(FIXTURES_DIR, "w0-02-control-writeprobe.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { dir: string; raw: Record<string, unknown> });
  const request = lines.find(
    (line) => line.raw.type === "control_request" && (line.raw.request as { subtype?: string } | undefined)?.subtype === "can_use_tool",
  );
  // dir "in" = what the W0 harness WROTE to the CLI's stdin and the CLI accepted.
  const answer = lines.find(
    (line) =>
      line.dir === "in" &&
      line.raw.type === "control_response" &&
      ((line.raw.response as { response?: { behavior?: string } }).response?.behavior) !== undefined,
  );
  if (request === undefined || answer === undefined) throw new Error("w0-02 fixture is missing the can_use_tool exchange");
  return {
    request: request.raw.request as Record<string, unknown>,
    acceptedResponse: (answer.raw.response as { response: Record<string, unknown> }).response,
  };
}

function brokerStub(decision: PermissionDecision | Promise<PermissionDecision>): {
  broker: IpcPermissionBroker;
  requests: PermissionRequest[];
} {
  const requests: PermissionRequest[] = [];
  const broker = {
    requestPermission: (request: PermissionRequest) => {
      requests.push(request);
      return Promise.resolve(decision);
    },
    denyAll: vi.fn(),
  } as unknown as IpcPermissionBroker;
  return { broker, requests };
}

function responderSpy(): { responder: ControlRequestResponder; success: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } {
  const success = vi.fn();
  const error = vi.fn();
  return { responder: { success, error }, success, error };
}

function inbound(
  request: Record<string, unknown>,
  subtype = "can_use_tool",
  signal: AbortSignal = new AbortController().signal,
): InboundControlRequest {
  return { requestId: "req-1", subtype, request, signal };
}

describe("ClaudeApprovalBridge — allow payload is byte-identical to the live accepted answer", () => {
  it("an allow reproduces the exact {behavior, updatedInput, toolUseID} the CLI accepted (hazard (в))", async () => {
    const { request, acceptedResponse } = liveWriteProbeExchange();
    const { broker } = brokerStub({ behavior: "allow" });
    const bridge = new ClaudeApprovalBridge({ broker, activePresetId: () => "ask" });
    const { responder, success, error } = responderSpy();

    await bridge.handle(inbound(request), responder);

    expect(error).not.toHaveBeenCalled();
    expect(success).toHaveBeenCalledTimes(1);
    // Field-for-field equality with the real bytes — not merely "has a behavior".
    expect(success.mock.calls[0]![0]).toEqual(acceptedResponse);
    expect(acceptedResponse).toMatchObject({
      behavior: "allow",
      updatedInput: { file_path: "/tmp/w0-cc-writeprobe.txt", content: "OK" },
      toolUseID: "toolu_0146u56HDRZG2Nd3qz7tv67b",
    });
  });

  it("an allow that omits updatedInput/toolUseID would NOT match the live bytes (the assert can go red)", () => {
    const { acceptedResponse } = liveWriteProbeExchange();
    expect({ behavior: "allow" }).not.toEqual(acceptedResponse);
  });

  it("a broker decision that rewrote the input echoes the REWRITTEN value, not the original", async () => {
    const { request } = liveWriteProbeExchange();
    const { broker } = brokerStub({ behavior: "allow", updatedInput: { file_path: "/tmp/edited.txt", content: "EDITED" } });
    const bridge = new ClaudeApprovalBridge({ broker, activePresetId: () => "ask" });
    const { responder, success } = responderSpy();

    await bridge.handle(inbound(request), responder);

    expect(success.mock.calls[0]![0]).toMatchObject({
      behavior: "allow",
      updatedInput: { file_path: "/tmp/edited.txt", content: "EDITED" },
      toolUseID: "toolu_0146u56HDRZG2Nd3qz7tv67b",
    });
  });
});

describe("ClaudeApprovalBridge — a denial is a normal answer, never a transport error (hazard (б))", () => {
  it("deny answers with a SUCCESS envelope carrying {behavior:\"deny\", message, toolUseID}", async () => {
    const { request } = liveWriteProbeExchange();
    const { broker } = brokerStub({ behavior: "deny", reason: "use ls instead" });
    const bridge = new ClaudeApprovalBridge({ broker, activePresetId: () => "ask" });
    const { responder, success, error } = responderSpy();

    await bridge.handle(inbound(request), responder);

    // The scoped-error channel is what would kill the turn — it must stay unused.
    expect(error).not.toHaveBeenCalled();
    expect(success.mock.calls[0]![0]).toEqual({
      behavior: "deny",
      message: "use ls instead",
      toolUseID: "toolu_0146u56HDRZG2Nd3qz7tv67b",
    });
  });

  it("a broker that rejects still denies — no grant is ever invented", async () => {
    const { request } = liveWriteProbeExchange();
    const broker = {
      requestPermission: () => Promise.reject(new Error("broker exploded")),
      denyAll: vi.fn(),
    } as unknown as IpcPermissionBroker;
    const bridge = new ClaudeApprovalBridge({ broker, activePresetId: () => "ask" });
    const { responder, success } = responderSpy();

    await bridge.handle(inbound(request), responder);

    expect(success.mock.calls[0]![0]).toMatchObject({ behavior: "deny" });
  });
});

describe("ClaudeApprovalBridge — posture and scope rules", () => {
  it("ExitPlanMode in the read-only preset is DENIED with an instruction, never auto-allowed (hazard (е))", async () => {
    const { broker, requests } = brokerStub({ behavior: "allow" });
    const bridge = new ClaudeApprovalBridge({ broker, activePresetId: () => "read-only" });
    const { responder, success } = responderSpy();

    await bridge.handle(
      inbound({ tool_name: "ExitPlanMode", tool_use_id: "toolu_plan", input: { plan: "do things" } }),
      responder,
    );

    const answer = success.mock.calls[0]![0] as { behavior: string; message: string };
    expect(answer.behavior).toBe("deny");
    expect(answer.message).toContain("Read-only");
    // The user is never even prompted: escalating out of read-only is not theirs
    // to approve mid-turn — they switch the preset instead.
    expect(requests).toEqual([]);
  });

  it("ExitPlanMode outside read-only goes to the broker like any other tool", async () => {
    const { broker, requests } = brokerStub({ behavior: "allow" });
    const bridge = new ClaudeApprovalBridge({ broker, activePresetId: () => "ask" });
    const { responder, success } = responderSpy();

    await bridge.handle(inbound({ tool_name: "ExitPlanMode", tool_use_id: "toolu_plan", input: {} }), responder);

    expect(requests).toHaveLength(1);
    expect(success.mock.calls[0]![0]).toMatchObject({ behavior: "allow", toolUseID: "toolu_plan" });
  });

  it("AskUserQuestion is denied with an explanation (no interactive-question surface in the MVP)", async () => {
    const { broker, requests } = brokerStub({ behavior: "allow" });
    const bridge = new ClaudeApprovalBridge({ broker, activePresetId: () => "ask" });
    const { responder, success } = responderSpy();

    await bridge.handle(inbound({ tool_name: "AskUserQuestion", tool_use_id: "toolu_ask", input: {} }), responder);

    const answer = success.mock.calls[0]![0] as { behavior: string; message: string };
    expect(answer.behavior).toBe("deny");
    expect(answer.message).toContain("Ask the user directly");
    expect(requests).toEqual([]);
  });

  it("a second parallel can_use_tool is refused with a SCOPED error while the first is parked (serialization)", async () => {
    let settle: (decision: PermissionDecision) => void = () => {};
    const parked = new Promise<PermissionDecision>((resolve) => {
      settle = resolve;
    });
    const broker = {
      requestPermission: () => parked,
      denyAll: vi.fn(),
    } as unknown as IpcPermissionBroker;
    const bridge = new ClaudeApprovalBridge({ broker, activePresetId: () => "ask" });

    const first = responderSpy();
    const firstDone = bridge.handle(inbound({ tool_name: "Bash", tool_use_id: "t-1", input: {} }), first.responder);

    const second = responderSpy();
    await bridge.handle(inbound({ tool_name: "Write", tool_use_id: "t-2", input: {} }), second.responder);
    expect(second.error).toHaveBeenCalledTimes(1);
    expect(second.success).not.toHaveBeenCalled();

    settle({ behavior: "allow" });
    await firstDone;
    expect(first.success).toHaveBeenCalledTimes(1);

    // The latch releases: a later request is served normally.
    const third = responderSpy();
    await bridge.handle(inbound({ tool_name: "Bash", tool_use_id: "t-3", input: {} }), third.responder);
    expect(third.success).toHaveBeenCalledTimes(1);
  });

  it("hook_callback / mcp_message / unknown subtypes are fail-closed scoped errors, never silence", async () => {
    const { broker } = brokerStub({ behavior: "allow" });
    const bridge = new ClaudeApprovalBridge({ broker, activePresetId: () => "ask" });

    for (const subtype of ["hook_callback", "mcp_message", "some_future_subtype"]) {
      const { responder, success, error } = responderSpy();
      await bridge.handle(inbound({}, subtype), responder);
      // Silence would block the CLI's turn forever (contract §2.2).
      expect(error, subtype).toHaveBeenCalledTimes(1);
      expect(success, subtype).not.toHaveBeenCalled();
    }
  });

  it("a malformed can_use_tool (no tool_use_id) is a scoped error, not a crash", async () => {
    const { broker } = brokerStub({ behavior: "allow" });
    const bridge = new ClaudeApprovalBridge({ broker, activePresetId: () => "ask" });
    const { responder, error } = responderSpy();

    await bridge.handle(inbound({ tool_name: "Bash" }), responder);

    expect(error).toHaveBeenCalledTimes(1);
  });
});

describe("decodeCanUseTool — tolerant of the live request's unprojected fields", () => {
  it("decodes the live request and ignores permission_suggestions/decision_reason without rejecting it", () => {
    const { request } = liveWriteProbeExchange();
    // The live request really does carry these (they are not hypothetical).
    expect(request).toHaveProperty("permission_suggestions");
    expect(request).toHaveProperty("decision_reason_type");

    const decoded = decodeCanUseTool(request);
    expect(decoded).toMatchObject({
      toolName: "Write",
      toolUseId: "toolu_0146u56HDRZG2Nd3qz7tv67b",
      input: { file_path: "/tmp/w0-cc-writeprobe.txt", content: "OK" },
    });
  });

  it("returns null only when the correlation identity is missing", () => {
    expect(decodeCanUseTool({ tool_name: "Bash" })).toBeNull();
    expect(decodeCanUseTool({ tool_use_id: "t-1" })).toBeNull();
    expect(decodeCanUseTool({ tool_name: "Bash", tool_use_id: "t-1" })).toMatchObject({ input: {} });
  });

  it("allowResponse/denyResponse always carry toolUseID", () => {
    const approval = { toolName: "Bash", toolUseId: "t-9", input: { command: "ls" } };
    expect(allowResponse(approval)).toEqual({ behavior: "allow", updatedInput: { command: "ls" }, toolUseID: "t-9" });
    expect(denyResponse(approval, "no")).toEqual({ behavior: "deny", message: "no", toolUseID: "t-9" });
  });
});

/**
 * Contract §2.2 pairing rule, the half that is NOT about writes.
 *
 * The CLI withdraws its own `can_use_tool` via `control_cancel_request` — on
 * its OWN initiative (an interrupt it decided on, a tool it abandoned), with no
 * `denyAll()` from AnyCode to unblock anything. Suppressing our late answer is
 * necessary but not sufficient: the handler is parked on
 * `broker.requestPermission`, which nothing else will settle. It holds the
 * approval modal open and keeps the bridge's serialization latch shut, so every
 * later approval in the session is refused with "another approval is already
 * pending" — a session that silently stops being able to ask.
 *
 * These assert the handler is SETTLED, which is what the withdrawal has to
 * achieve, rather than merely that no late write occurred.
 */
describe("ClaudeApprovalBridge — a CLI-side cancellation settles the handler, not just the write", () => {
  /** A broker whose ask parks until `denyAll` settles it — the real one's behaviour. */
  function parkingBroker(): { broker: IpcPermissionBroker; denyAllCalls: string[]; asks: number } {
    const parked: ((decision: PermissionDecision) => void)[] = [];
    const state = {
      denyAllCalls: [] as string[],
      asks: 0,
    };
    const broker = {
      requestPermission: (_request: PermissionRequest) => {
        state.asks += 1;
        return new Promise<PermissionDecision>((resolve) => parked.push(resolve));
      },
      denyAll: (reason: string) => {
        state.denyAllCalls.push(reason);
        for (const resolve of parked.splice(0)) resolve({ behavior: "deny", reason });
      },
    } as unknown as IpcPermissionBroker;
    return { broker, get denyAllCalls() { return state.denyAllCalls; }, get asks() { return state.asks; } };
  }

  it("releases the parked broker ask when the CLI withdraws the request", async () => {
    const { request } = liveWriteProbeExchange();
    const parking = parkingBroker();
    const bridge = new ClaudeApprovalBridge({ broker: parking.broker, activePresetId: () => "ask" });
    const { responder } = responderSpy();
    const cancel = new AbortController();

    const handled = bridge.handle(inbound(request, "can_use_tool", cancel.signal), responder);
    await Promise.resolve();
    // Parked, exactly as a real modal awaiting the user.
    expect(parking.asks).toBe(1);

    cancel.abort();
    // The discriminator: this await HANGS FOREVER on an implementation that
    // only drops router bookkeeping.
    await handled;
    expect(parking.denyAllCalls).toEqual(["Claude withdrew this permission request"]);
  });

  it("frees the serialization latch, so the NEXT approval is asked rather than refused", async () => {
    const { request } = liveWriteProbeExchange();
    const parking = parkingBroker();
    const bridge = new ClaudeApprovalBridge({ broker: parking.broker, activePresetId: () => "ask" });
    const cancel = new AbortController();

    const first = responderSpy();
    const firstHandled = bridge.handle(inbound(request, "can_use_tool", cancel.signal), first.responder);
    await Promise.resolve();
    cancel.abort();
    await firstHandled;

    // A second, unrelated approval on the same live session.
    const second = responderSpy();
    const secondHandled = bridge.handle(inbound(request), second.responder);
    await Promise.resolve();
    expect(parking.asks).toBe(2);
    // NOT the "another approval is already pending" refusal a leaked latch produces.
    expect(second.error).not.toHaveBeenCalled();

    parking.broker.denyAll("done", "turn_cancelled");
    await secondHandled;
    expect(second.success).toHaveBeenCalledTimes(1);
  });

  it("an ALREADY-cancelled request never parks the broker and is never answered", async () => {
    const { request } = liveWriteProbeExchange();
    const parking = parkingBroker();
    const bridge = new ClaudeApprovalBridge({ broker: parking.broker, activePresetId: () => "ask" });
    const { responder, success, error } = responderSpy();
    const cancel = new AbortController();
    cancel.abort();

    // Resolves rather than hanging, and puts no modal in front of the user for
    // a tool the CLI has already abandoned.
    await bridge.handle(inbound(request, "can_use_tool", cancel.signal), responder);
    expect(parking.asks).toBe(0);
    // Pairing rule: a withdrawn request is never answered.
    expect(success).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});
