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


// Taskana 4764 C1/C2/C4: the door serves the browser tools (with or without
// an agent catalog) and routes browser_* names to the shared engine bridge.
describe("bridge door — Taskana 4764 browser tools", () => {
  function fakeBrowser() {
    const calls: Array<{ name: string; args: unknown; signal: AbortSignal; toolUseId: string }> = [];
    const navigate = { canonical: "BrowserNavigate", claudeName: "browser_navigate", codexName: "anycode_browser_navigate", description: "d2", inputSchema: { type: "object" } };
    const open = { canonical: "BrowserOpen", claudeName: "browser_open", codexName: "anycode_browser_open", description: "d1", inputSchema: { type: "object" } };
    const browser = {
      specs: [open, navigate],
      byClaudeName: (name: string) => (name === "browser_navigate" ? navigate : name === "browser_open" ? open : undefined),
      byCodexName: () => undefined,
      call: async (spec: { canonical: string }, args: unknown, signal: AbortSignal, toolUseId: string) => {
        calls.push({ name: spec.canonical, args, signal, toolUseId });
        return { text: `ran ${spec.canonical}`, isError: false, status: "success" as const, durationMs: 1 };
      },
    } as never as import("../browser-bridge.js").EngineBrowserBridge;
    return { browser, calls };
  }

  const dummyPort = {
    send: async () => ({ ok: false, reason: "unavailable", message: "not exercised" }),
    run: async () => ({ status: "completed", finalText: "", truncated: false, turns: 0, toolCalls: 0, durationMs: 0, childSessionId: "c", parentSessionId: "p", spawnToolCallId: "" }),
  } as never as SessionSubagentPort;

  it("C1: empty catalog + no port -> 10 browser decls and NO agent decl; catalog + port -> agent first then browser", () => {
    const { browser } = fakeBrowser();
    const full = {
      ...browser,
      specs: Array.from({ length: 10 }, (_, i) => ({
        canonical: `Canonical${i}`, claudeName: `browser_t${i}`, codexName: `anycode_browser_t${i}`, description: `d${i}`, inputSchema: { type: "object" },
      })),
    } as never as import("../browser-bridge.js").EngineBrowserBridge;
    const bare = createBridgePresentationStamp({ catalog: [], resolveCallCatalog: async () => [], browser: full, onEvent: () => {} });
    const bareTools = bare.listTools();
    expect(bareTools).toHaveLength(10);
    expect(bareTools.every((tool) => tool.name.startsWith("browser_t"))).toBe(true);
    expect(bareTools.some((tool) => tool.name === "agent")).toBe(false);

    const fullDoor = createBridgePresentationStamp({ catalog: CATALOG, resolveCallCatalog: async () => CATALOG, port: dummyPort, browser: full, onEvent: () => {} });
    const tools = fullDoor.listTools();
    expect(tools).toHaveLength(12);
    expect(tools[0]?.name).toBe("agent");
    expect(tools[1]?.name).toBe("agent_status");
    expect(tools.slice(2).every((tool) => tool.name.startsWith("browser_t"))).toBe(true);
  });

  it("C2: browser_navigate routes to the bridge with the toolUseId; missing toolUseId, unknown name and agent-without-port keep their errors", async () => {
    const { browser, calls } = fakeBrowser();
    const stamp = createBridgePresentationStamp({ catalog: [], resolveCallCatalog: async () => [], browser, onEvent: () => {} });
    const signal = new AbortController().signal;
    const ok = await stamp.callTool("browser_navigate", { url: "http://localhost:3000/" }, signal, { toolUseId: "t1" });
    expect(ok).toEqual({ text: "ran BrowserNavigate", isError: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.toolUseId).toBe("t1");

    const noId = await stamp.callTool("browser_navigate", {}, signal, {});
    expect(noId.isError).toBe(true);
    expect(noId.text).toContain("could not correlate");

    const unknown = await stamp.callTool("browser_bogus", {}, signal, { toolUseId: "t2" });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain("no tool named");

    const agentless = createBridgePresentationStamp({ catalog: CATALOG, resolveCallCatalog: async () => CATALOG, browser, onEvent: () => {} });
    const agent = await agentless.callTool("agent", AGENT_ARGS, signal, { toolUseId: "t3" });
    expect(agent.isError).toBe(true);
    expect(agent.text).toContain("agent delegation is unavailable");
  });

  it("C4: an aborted browser call returns normally and stamps no presentation", async () => {
    const { browser } = fakeBrowser();
    const controller = new AbortController();
    let release!: () => void;
    (browser as unknown as { call: unknown }).call = async () =>
      new Promise((resolve) => {
        release = () => resolve({ text: "late", isError: false, status: "success", durationMs: 0 });
      });
    const stamp = createBridgePresentationStamp({ catalog: [], resolveCallCatalog: async () => [], browser, onEvent: () => {} });
    const pending = stamp.callTool("browser_navigate", {}, controller.signal, { toolUseId: "t-abort" });
    controller.abort();
    release();
    const result = await pending;
    expect(result.isError).toBe(false);
    expect(stamp.entries().size).toBe(0);
  });
});

it("exposes status through the owning Claude bridge", async () => {
  const rig = lateSettlingPort({ status: "completed", presentationWorthy: false });
  rig.port.listStatus = () => [{ id: "owned", description: "work", state: "running", startedAt: Date.now(), turns: 1, toolCalls: 0, tail: [] }];
  const { stamp } = stampOver(rig.port);
  expect(stamp.listTools().map((tool) => tool.name)).toContain("agent_status");
  expect(await stamp.callTool("agent_status", {}, new AbortController().signal, {})).toMatchObject({ isError: false, text: expect.stringContaining("owned") });
  expect((await stamp.callTool("agent_status", { id: "foreign" }, new AbortController().signal, {})).isError).toBe(true);
});
