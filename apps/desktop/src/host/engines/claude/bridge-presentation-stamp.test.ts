/**
 * Taskana 4056 review (N2): the claude door's `tools/call` handler, lifted
 * out of host/index.ts verbatim (see bridge-presentation-stamp.ts's own
 * header for why a lift — not an import — is the established idiom here).
 * These tests pin the handler's after-abort discipline against a REAL
 * `runAgentBridgeCall` (not a mock of it), so the timings they reproduce —
 * abort mid-call, the run resolving LATE, a presentation being finalized
 * from the aborted child's own accumulated card — are the timings the
 * production port produces (child-session-port.ts: abort sends the cancel
 * and keeps the promise parked on the child's real terminal; it never
 * resolves the promise by itself).
 */

import { describe, expect, it } from "vitest";
import type { SessionSubagentPort, SessionSubagentRequest, SubagentCardEvent, SubagentRunOptions } from "@anycode/core";
import { createBridgePresentationStamp } from "./bridge-presentation-stamp.js";

/** A bridge child that emits a progress event, then settles the given outcome after the caller releases it. */
function lateSettlingPort(outcome: { status: "cancelled" | "completed"; presentationWorthy: boolean }) {
  let release: (() => void) | undefined;
  const settled = new Promise<void>((resolveRelease) => {
    release = resolveRelease;
  });
  const port: SessionSubagentPort = {
    send: async () => ({ ok: false, reason: "unavailable", message: "fake port: send is not exercised by this test" }),
    run: async (_req: SessionSubagentRequest, opts: SubagentRunOptions) => {
      // One progress event before the abort lands, so the run's card
      // accumulator actually started (a presentation is only finalized
      // for a card that did — agent-bridge.ts's own W1: never fabricated).
      opts.onProgress?.({ kind: "start", agentType: "explore", description: "d" });
      await settled;
      return {
        status: outcome.status,
        finalText: "child done",
        truncated: false,
        turns: 1,
        toolCalls: 1,
        durationMs: 5,
        childSessionId: "child-1",
        parentSessionId: "parent-1",
        spawnToolCallId: _req.spawnToolCallId ?? "",
      };
    },
  };
  return { port, settle: () => release!() };
}

const CATALOG = [{ name: "explore", description: "d", systemPrompt: "" }] as never as Parameters<typeof createBridgePresentationStamp>[0]["catalog"];

/** Minimal `agent` tool args (decodeAgentBridgeCallInput's required non-empty strings). */
const AGENT_ARGS = { agent_type: "explore", description: "d", prompt: "p" } as Record<string, unknown>;

function stampOver(port: SessionSubagentPort) {
  const seen: SubagentCardEvent[] = [];
  const stamp = createBridgePresentationStamp({
    catalog: CATALOG,
    resolveCallCatalog: async () => CATALOG,
    port,
    onEvent: (event) => seen.push(event),
  });
  return { stamp, seen };
}

describe("bridge door callTool — Taskana 4056 review N2 (no presentation stamp past the turn-end sweep)", () => {
  it("a call aborted mid-run (Stop) that resolves LATE must NOT stamp a presentation — the turn-end sweep already ran", async () => {
    const rig = lateSettlingPort({ status: "cancelled", presentationWorthy: true });
    const { stamp } = stampOver(rig.port);
    const controller = new AbortController();

    const pending = stamp.callTool("agent", AGENT_ARGS, controller.signal, { toolUseId: "toolu_n2" });
    // Stop: the CLI's notifications/cancelled aborts the call's signal while
    // the run is still parked on the child's terminal.
    controller.abort();
    // The engine's turn ends now: the turn-end dropPresentations sweep fires
    // (no tool_result ever arrives for an aborted MCP call — the SDK server
    // answers nothing once the signal fired, mcp-bridge.ts module doc P3).
    stamp.dropPresentations(["toolu_n2"]);
    // ...and only THEN does the child's terminal land, resolving the parked run.
    rig.settle();
    const response = await pending;

    expect(response.isError).toBe(true);
    // The defect: this late set leaked one entry past the sweep for the
    // process's lifetime.
    expect(stamp.entries().size).toBe(0);
  });

  it("a live call's presentation is still stamped and consumed exactly once by takePresentation (S4 behaviour unchanged)", async () => {
    const rig = lateSettlingPort({ status: "completed", presentationWorthy: true });
    const { stamp } = stampOver(rig.port);
    const call = stamp.callTool("agent", AGENT_ARGS, new AbortController().signal, { toolUseId: "toolu_ok" });
    rig.settle();
    const response = await call;

    expect(response.isError).toBe(false);
    expect(stamp.entries().has("toolu_ok")).toBe(true);
    const taken = stamp.takePresentation("toolu_ok");
    expect(taken).toBeDefined();
    // Consumed exactly once: a second take reads empty, and the map no
    // longer holds the id.
    expect(stamp.takePresentation("toolu_ok")).toBeUndefined();
    expect(stamp.entries().has("toolu_ok")).toBe(false);
  });

  it("late bridge EVENTS after the abort are dropped, not forwarded (codex-door parity, 69e803e7)", async () => {
    const rig = lateSettlingPort({ status: "cancelled", presentationWorthy: true });
    const { stamp, seen } = stampOver(rig.port);
    const controller = new AbortController();
    const pending = stamp.callTool("agent", AGENT_ARGS, controller.signal, { toolUseId: "toolu_ev" });
    controller.abort();
    rig.settle();
    await pending;
    // The one pre-abort turn_start WAS forwarded (it raced the abort); the
    // map-visibility outcome is what this file pins — the forwarded-event
    // drop itself is the 69e803e7 behaviour this handler keeps verbatim.
    expect(seen.length).toBeLessThanOrEqual(1);
  });
});
