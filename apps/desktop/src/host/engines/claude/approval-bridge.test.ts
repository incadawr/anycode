/**
 * Approval-bridge tests, byte-anchored to the live exchange captured in
 * `w0-02-control-writeprobe.jsonl` (cut §1.4 DoD, hazard (в)): the allow
 * payload this bridge produces must equal, field for field, the one the real
 * CLI accepted — an allow that quietly drops `updatedInput`/`toolUseID`
 * degrades silently rather than failing loudly.
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NodeFileSystemAdapter, SessionPermissionRules, resolveWorkspaceWriteFacts } from "@anycode/core";
import type { PermissionDecision, PermissionRequest } from "@anycode/core";
import type { HostToUiMessage } from "../../../shared/protocol.js";
import { IpcPermissionBroker } from "../../permission-broker.js";
import type { ControlRequestResponder, InboundControlRequest } from "./claude-client.js";
import { ClaudeApprovalBridge, allowResponse, decodeCanUseTool, denyResponse } from "./approval-bridge.js";
import type { ClaudeMcpBridge } from "./mcp-bridge.js";

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

describe("ClaudeApprovalBridge — TASK.226 S3: AnyCode's own MCP door", () => {
  it("can_use_tool for mcp__anycode__* is auto-allowed, never asks the broker, and never engages the pending latch", async () => {
    const { broker, requests } = brokerStub({ behavior: "allow" });
    const bridge = new ClaudeApprovalBridge({ broker, activePresetId: () => "ask", bridge: {} as ClaudeMcpBridge });
    const { responder, success, error } = responderSpy();

    await bridge.handle(inbound({ tool_name: "mcp__anycode__agent", tool_use_id: "toolu_mcp1", input: { agent_type: "probe" } }), responder);

    expect(error).not.toHaveBeenCalled();
    // Byte-identical to the allow shape any other tool gets (`allowResponse`) —
    // this is not a bespoke payload, just an unconditional grant of it.
    expect(success.mock.calls[0]![0]).toEqual({ behavior: "allow", updatedInput: { agent_type: "probe" }, toolUseID: "toolu_mcp1" });
    // The human-facing broker is never consulted for AnyCode's own door
    // (plan §2.6): the child session behind it has its own broker.
    expect(requests).toEqual([]);
  });

  it("a parked human-facing approval does not block a concurrent mcp__anycode__* request, and vice versa (probes.md P1 order)", async () => {
    let settle: (decision: PermissionDecision) => void = () => {};
    const parked = new Promise<PermissionDecision>((resolve) => {
      settle = resolve;
    });
    const broker = {
      requestPermission: () => parked,
      denyAll: vi.fn(),
    } as unknown as IpcPermissionBroker;
    const bridge = new ClaudeApprovalBridge({ broker, activePresetId: () => "ask", bridge: {} as ClaudeMcpBridge });

    const human = responderSpy();
    const humanHandled = bridge.handle(inbound({ tool_name: "Bash", tool_use_id: "t-human", input: {} }), human.responder);

    // The mcp door's own approval is served WHILE the human one is still parked.
    const mcp = responderSpy();
    await bridge.handle(inbound({ tool_name: "mcp__anycode__agent", tool_use_id: "t-mcp", input: {} }), mcp.responder);
    expect(mcp.success).toHaveBeenCalledTimes(1);
    expect(mcp.error).not.toHaveBeenCalled();

    settle({ behavior: "allow" });
    await humanHandled;
    expect(human.success).toHaveBeenCalledTimes(1);
  });

  it("a same-name tool without the owned bridge still asks the broker", async () => {
    const { broker, requests } = brokerStub({ behavior: "allow" });
    const bridge = new ClaudeApprovalBridge({ broker, activePresetId: () => "ask" });
    await bridge.handle(inbound({ tool_name: "mcp__anycode__agent", tool_use_id: "foreign", input: {} }), responderSpy().responder);
    expect(requests).toHaveLength(1);
  });

  it("an unregistered tool under the prefix still asks the broker", async () => {
    const { broker, requests } = brokerStub({ behavior: "allow" });
    const bridge = new ClaudeApprovalBridge({ broker, activePresetId: () => "ask", bridge: {} as ClaudeMcpBridge });
    await bridge.handle(inbound({ tool_name: "mcp__anycode__other", tool_use_id: "foreign", input: {} }), responderSpy().responder);
    expect(requests).toHaveLength(1);
  });

  it("mcp_message is routed to an attached bridge instead of the fail-closed default", async () => {
    const { broker } = brokerStub({ behavior: "allow" });
    const handleControlRequest = vi.fn(async (_request: InboundControlRequest, responder: ControlRequestResponder) => {
      responder.success({ mcp_response: { jsonrpc: "2.0", id: 1, result: { tools: [] } } });
    });
    const fakeBridge = { handleControlRequest } as unknown as ClaudeMcpBridge;
    const bridge = new ClaudeApprovalBridge({ broker, activePresetId: () => "ask", bridge: fakeBridge });
    const { responder, success, error } = responderSpy();
    const request = inbound({ server_name: "anycode", message: { method: "tools/list", jsonrpc: "2.0", id: 1 } }, "mcp_message");

    await bridge.handle(request, responder);

    expect(handleControlRequest).toHaveBeenCalledTimes(1);
    expect(handleControlRequest.mock.calls[0]![0]).toBe(request);
    expect(success).toHaveBeenCalledWith({ mcp_response: { jsonrpc: "2.0", id: 1, result: { tools: [] } } });
    expect(error).not.toHaveBeenCalled();
  });

  it("mcp_message with NO bridge attached still fails closed, exactly like hook_callback (regression: the door is opt-in)", async () => {
    const { broker } = brokerStub({ behavior: "allow" });
    const bridge = new ClaudeApprovalBridge({ broker, activePresetId: () => "ask" });
    const { responder, success, error } = responderSpy();

    await bridge.handle(inbound({ server_name: "anycode", message: {} }, "mcp_message"), responder);

    expect(error).toHaveBeenCalledTimes(1);
    expect(success).not.toHaveBeenCalled();
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
    // toPermissionRequest is async (Taskana 4294 fact minting), so the ask
    // parks after a microtask boundary — flush a couple of them.
    await Promise.resolve();
    await Promise.resolve();
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
    await Promise.resolve();
    await Promise.resolve();
    cancel.abort();
    await firstHandled;

    // A second, unrelated approval on the same live session.
    const second = responderSpy();
    const secondHandled = bridge.handle(inbound(request), second.responder);
    // toPermissionRequest is async (Taskana 4294 fact minting does real fs
    // I/O) — the W0 probe fixture writes to /tmp, which resolves, so a short
    // settle wait suffices before the ask count is asserted.
    await new Promise((resolve) => setTimeout(resolve, 25));
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

/**
 * Taskana 4294 (cross-review F1) — the claude-engine half. `supportsCorePermissions`
 * is false for the claude boot, so the ONLY gates between a persisted always-allow
 * rule (TASK.144 global-settings seeding) and the CLI's Write/Edit are (a) the
 * approval bridge minting workspace facts and (b) IpcPermissionBroker's
 * confinement check. The 4294 incident, replayed on this engine: a child session
 * rooted at a `.anycode/worktrees/<x>` worktree asks to Write an absolute path
 * in the MAIN checkout; a once-remembered blanket `{toolName:"Write"}` rule must
 * NOT answer it — the ask must reach a human (here: the broker stub).
 *
 * Facts are minted over the REAL filesystem (realpath/lstat semantics — the
 * same resolver the dispatcher uses), so these tests build real tmp dirs.
 */
describe("ClaudeApprovalBridge — Taskana 4294 workspace facts on write tools", () => {
  let root: string;
  let mainCheckout: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "claude-4294-"));
    mainCheckout = mkdtempSync(join(tmpdir(), "main-checkout-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(mainCheckout, { recursive: true, force: true });
  });

  function recordingBroker(): { broker: IpcPermissionBroker; asked: PermissionRequest[] } {
    const asked: PermissionRequest[] = [];
    const broker = {
      requestPermission: (request: PermissionRequest) => {
        asked.push(request);
        return Promise.resolve({ behavior: "deny" as const, reason: "no" });
      },
      denyAll: vi.fn(),
    } as unknown as IpcPermissionBroker;
    return { broker, asked };
  }

  it("a Write can_use_tool carries dispatcher-equivalent workspace facts (root = session cwd, resolved target)", async () => {
    const { broker, asked } = recordingBroker();
    const bridge = new ClaudeApprovalBridge({ broker, activePresetId: () => "ask", workspace: root });
    const { responder } = responderSpy();

    await bridge.handle(
      inbound({ tool_name: "Write", tool_use_id: "toolu_w", input: { file_path: join(root, "src", "a.ts"), content: "x" } }),
      responder,
    );

    expect(asked).toHaveLength(1);
    expect(asked[0]?.toolName).toBe("Write");
    // The bridge delegates to the SAME resolver the dispatcher uses, with
    // root = the wired workspace and the approval's file_path verbatim.
    expect(asked[0]?.workspace).toEqual(
      await resolveWorkspaceWriteFacts(new NodeFileSystemAdapter(), root, join(root, "src", "a.ts")),
    );
  });

  it("an Edit can_use_tool carries workspace facts too; non-write tools (Read) never do", async () => {
    const { broker, asked } = recordingBroker();
    const bridge = new ClaudeApprovalBridge({ broker, activePresetId: () => "ask", workspace: root });

    await bridge.handle(inbound({ tool_name: "Edit", tool_use_id: "toolu_e", input: { file_path: join(root, "b.ts") } }), responderSpy().responder);
    await bridge.handle(inbound({ tool_name: "Read", tool_use_id: "toolu_r", input: { file_path: join(root, "b.ts") } }), responderSpy().responder);

    expect(asked).toHaveLength(2);
    expect(asked[0]?.toolName).toBe("Edit");
    expect(asked[0]?.workspace).toEqual(
      await resolveWorkspaceWriteFacts(new NodeFileSystemAdapter(), root, join(root, "b.ts")),
    );
    expect(asked[1]?.toolName).toBe("Read");
    expect(asked[1]?.workspace).toBeUndefined();
  });

  it("no workspace seam wired (legacy construction) => NO facts => the broker's own confinement gate applies (fail-closed)", async () => {
    const { broker, asked } = recordingBroker();
    const bridge = new ClaudeApprovalBridge({ broker, activePresetId: () => "ask" });

    await bridge.handle(inbound({ tool_name: "Write", tool_use_id: "toolu_w", input: { file_path: join(root, "a.ts"), content: "x" } }), responderSpy().responder);

    expect(asked).toHaveLength(1);
    // No seam => the bridge cannot prove anything => no facts => a rule can
    // never vouch (isProvablyInsideWorkspace(undefined) === false).
    expect(asked[0]?.workspace).toBeUndefined();
  });

  it("relative / ..-bearing / non-string file_path write inputs mint NO facts (unprovable, fail-closed)", async () => {
    const { broker, asked } = recordingBroker();
    const bridge = new ClaudeApprovalBridge({ broker, activePresetId: () => "ask", workspace: root });

    await bridge.handle(inbound({ tool_name: "Write", tool_use_id: "t1", input: { file_path: "src/a.ts", content: "x" } }), responderSpy().responder);
    await bridge.handle(inbound({ tool_name: "Write", tool_use_id: "t2", input: { file_path: `${root}/../escape.ts`, content: "x" } }), responderSpy().responder);
    await bridge.handle(inbound({ tool_name: "Write", tool_use_id: "t3", input: { content: "no path at all" } }), responderSpy().responder);
    await bridge.handle(inbound({ tool_name: "Write", tool_use_id: "t4", input: { file_path: 123 } }), responderSpy().responder);

    expect(asked.map((r) => r.workspace)).toEqual([undefined, undefined, undefined, undefined]);
  });

  it("F1 end-to-end: a seeded blanket Write rule does NOT silent-allow an out-of-workspace Write — the ask reaches the broker", async () => {
    // The store the engine boots seed from settings.json (TASK.144).
    const rules = new SessionPermissionRules();
    rules.add({ toolName: "Write" });
    const emitted: HostToUiMessage[] = [];
    const broker = new IpcPermissionBroker((message) => emitted.push(message), undefined, rules);
    // A child worktree session: workspace root under <repo>/.anycode/worktrees/x,
    // the write targets a file in the MAIN checkout.
    const repo = mkdtempSync(join(tmpdir(), "repo-4294-"));
    try {
      const worktree = join(repo, ".anycode", "worktrees", "x");
      mkdirSync(worktree, { recursive: true });
      writeFileSync(join(repo, "victim.ts"), "orig", "utf-8");
      const bridge = new ClaudeApprovalBridge({ broker, activePresetId: () => "ask", workspace: worktree });

      const outcome = responderSpy();
      const handled = bridge.handle(
        inbound({ tool_name: "Write", tool_use_id: "toolu_pwn", input: { file_path: join(repo, "victim.ts"), content: "PWN" } }),
        outcome.responder,
      );
      // The fact minting does REAL fs I/O (realpath/lstat); settle it with a
      // short real-time wait for the permission_request to surface.
      const ask = await vi.waitFor(
        () => {
          const found = emitted.find((m) => m.type === "permission_request");
          if (!found) throw new Error("permission_request not emitted yet");
          return found;
        },
        { timeout: 2_000, interval: 10 },
      );
      expect(ask).toBeDefined();
      // ...and the human (test) denies it.
      if (ask.type === "permission_request") {
        broker.handleResponse(ask.requestId, "deny");
      }
      await handled;
      // The CLI's answer is a deny control_response (never a transport error).
      expect(outcome.error).not.toHaveBeenCalled();
      expect(outcome.success).toHaveBeenCalledTimes(1);
      expect((outcome.success.mock.calls[0]?.[0] as { behavior: string }).behavior).toBe("deny");
      // And the main checkout is untouched.
      expect(readFileSync(join(repo, "victim.ts"), "utf-8")).toBe("orig");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("F1 end-to-end, inside: the same blanket rule stays silent-allow for a proven-inside write", async () => {
    const rules = new SessionPermissionRules();
    rules.add({ toolName: "Write" });
    const emitted: HostToUiMessage[] = [];
    const broker = new IpcPermissionBroker((message) => emitted.push(message), undefined, rules);
    const bridge = new ClaudeApprovalBridge({ broker, activePresetId: () => "ask", workspace: root });
    const { responder, success } = responderSpy();

    const handled = bridge.handle(
      inbound({ tool_name: "Write", tool_use_id: "toolu_ok", input: { file_path: join(root, "inside.ts"), content: "OK" } }),
      responder,
    );
    await handled;

    // Silent-allow: the rule answered, nothing reached the UI, and the CLI
    // got its allow control_response.
    expect(emitted).toEqual([]);
    expect(success).toHaveBeenCalledTimes(1);
    expect((success.mock.calls[0]?.[0] as { behavior: string }).behavior).toBe("allow");
  });
});

/**
 * Taskana 4294 (cross-review F2): the persistence path. A human approves (with
 * "Always allow") a child's one deliberate out-of-workspace write after the
 * modal — Session.maybeRemember persists `{toolName:"Write"}` into the store
 * the engine boots seed from GLOBAL settings.json. This must not arm a
 * silent-allow for any LATER out-of-workspace write in ANY engine session:
 * the remembered rule is honoured only with proof, exactly like a seeded one.
 */
describe("ClaudeApprovalBridge — Taskana 4294 F2: a remembered rule does not unconfine later asks", () => {
  it("remember-armed store (post-modal allow) still refuses the next out-of-workspace Write; approves an inside one", async () => {
    // The store Session.maybeRemember appended to mid-session (the same
    // instance an engine boot hands its broker).
    const rules = new SessionPermissionRules();
    const emitted: HostToUiMessage[] = [];
    const broker = new IpcPermissionBroker((message) => emitted.push(message), undefined, rules);
    const repo = mkdtempSync(join(tmpdir(), "repo-f2-"));
    try {
      const worktree = join(repo, ".anycode", "worktrees", "x");
      mkdirSync(worktree, { recursive: true });
      writeFileSync(join(repo, "main.ts"), "orig", "utf-8");
      const bridge = new ClaudeApprovalBridge({ broker, activePresetId: () => "ask", workspace: worktree });

      // 1. The first out-of-workspace ask: the confinement escalates it to a
      //    human, who allows WITH remember (Session.maybeRemember then adds
      //    the bare rule to this very store).
      const first = responderSpy();
      const firstHandled = bridge.handle(
        inbound({ tool_name: "Write", tool_use_id: "toolu_1", input: { file_path: join(repo, "main.ts"), content: "EDIT" } }),
        first.responder,
      );
      const firstAsk = await vi.waitFor(
        () => {
          const found = emitted.find((m) => m.type === "permission_request");
          if (!found) throw new Error("first ask not presented");
          return found;
        },
        { timeout: 2_000, interval: 10 },
      );
      if (firstAsk.type === "permission_request") {
        broker.handleResponse(firstAsk.requestId, "allow");
      }
      await firstHandled;
      // The store now holds the remembered bare rule.
      rules.add({ toolName: "Write" });
      expect(rules.list()).toEqual([{ toolName: "Write" }]);

      // 2. The NEXT identical out-of-workspace Write: the remembered rule
      //    must NOT silent-allow it — the ask is presented again.
      const second = responderSpy();
      const secondHandled = bridge.handle(
        inbound({ tool_name: "Write", tool_use_id: "toolu_2", input: { file_path: join(repo, "main.ts"), content: "EDIT2" } }),
        second.responder,
      );
      const secondAsk = await vi.waitFor(
        () => {
          const found = emitted.filter((m) => m.type === "permission_request").at(-1);
          if (!found || (found as { requestId: string }).requestId === (firstAsk as { requestId: string }).requestId) {
            throw new Error("second ask not presented");
          }
          return found;
        },
        { timeout: 2_000, interval: 10 },
      );
      if (secondAsk.type === "permission_request") {
        broker.handleResponse(secondAsk.requestId, "deny");
      }
      await secondHandled;
      expect((second.success.mock.calls[0]?.[0] as { behavior: string }).behavior).toBe("deny");

      // 3. An INSIDE-workspace write on the same remembered rule: silent-allow.
      const third = responderSpy();
      const thirdHandled = bridge.handle(
        inbound({ tool_name: "Write", tool_use_id: "toolu_3", input: { file_path: join(worktree, "ok.ts"), content: "OK" } }),
        third.responder,
      );
      await thirdHandled;
      expect((third.success.mock.calls[0]?.[0] as { behavior: string }).behavior).toBe("allow");
      const presented = emitted.filter((m) => m.type === "permission_request");
      expect(presented).toHaveLength(2); // first + second only
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
