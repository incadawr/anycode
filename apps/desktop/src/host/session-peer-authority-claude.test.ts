/**
 * Claude reconciles its native permission preset at system/init without any
 * settings event, so the Session must republish peer authority from that
 * reconciliation (both directions), and a resumed preset counts as closed
 * until the init has confirmed it. Real Claude engine, settings seam and Session.
 */

import { afterEach, describe, expect, it } from "vitest";
import { ClaudeEngine } from "./engines/claude/claude-engine.js";
import { ClaudeModelCatalog } from "./engines/claude/models.js";
import { findClaudePreset } from "./engines/claude/presets.js";
import { ClaudeSettingsSeam } from "./engines/claude/settings-seam.js";
import { createHarness } from "./test-harness.js";

type Wire = "plan" | "default" | "acceptEdits";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length > 0) await cleanups.pop()!(); });

function claudeParts(initial: string, resumed: boolean) {
  const transport = {
    notifications: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }) }),
    close: async () => {},
  } as never;
  const engine = new ClaudeEngine(transport, "native-ref", undefined, {
    catalog: ClaudeModelCatalog.fromInitialize([{ value: "m", resolvedModel: "m", displayName: "M" }]),
    model: "m", preset: findClaudePreset(initial)!, effortsByModel: new Map(), notices: [],
  });
  // The connect step marks a resumed session's preset provisional.
  engine.presetProvisional = resumed;
  const seam = new ClaudeSettingsSeam(engine);
  const init = (permissionMode: Wire) =>
    (engine as unknown as { onSystemInit(init: unknown): void }).onSystemInit({ session_id: "native-ref", model: "m", permissionMode, tools: [], mcp_servers: [] });
  return { engine, seam, init };
}

function claudeRoot(initial: string, resumed: boolean) {
  const { engine, seam, init } = claudeParts(initial, resumed);
  const h = createHarness({ steps: [], engine, engineSettings: seam });
  cleanups.push(async () => { h.close(); await engine.dispose("session-close"); });
  const seen: string[] = [];
  const orchestrate: boolean[] = [];
  h.session.observePermissionMode(mode => seen.push(mode), enabled => orchestrate.push(enabled));
  return { h, engine, seam, seen, orchestrate, init };
}

describe("Claude native init republishes peer authority", () => {
  it("narrows main to plan when a persisted Ask resumes and the CLI reports plan", async () => {
    const c = claudeRoot("ask", true);
    expect(c.seen).toEqual(["plan"]); // provisional resume preset is closed until init
    c.init("plan");
    expect(c.seam.snapshot().activePresetId).toBe("read-only");
    expect(c.seen.at(-1)).toBe("plan");
    expect(c.h.session.peerAuthorityClosed()).toBe(false);
  });

  it("opens main to build when a provisional Read-only resume is established as Ask by init", async () => {
    const c = claudeRoot("read-only", true);
    expect(c.seen).toEqual(["plan"]);
    c.init("default");
    expect(c.seam.snapshot().activePresetId).toBe("ask");
    expect(c.seen.at(-1)).toBe("build");
  });

  it("keeps a resumed Ask closed until init, then publishes build when the CLI confirms it", async () => {
    const c = claudeRoot("ask", true);
    expect(c.seen).toEqual(["plan"]);
    expect(c.h.session.peerAuthorityClosed()).toBe(true);
    c.init("default");
    expect(c.seen).toEqual(["plan", "build"]);
    expect(c.orchestrate.at(-1)).toBe(false);
    c.init("default"); // repeated init with no change publishes nothing more
    expect(c.seen).toEqual(["plan", "build"]);
  });

  it("publishes a mid-session CLI preset drift on a fresh (verified) session too", async () => {
    const c = claudeRoot("ask", false);
    expect(c.seen).toEqual(["build"]);
    c.init("plan");
    expect(c.seen).toEqual(["build", "plan"]);
  });
});

describe("Claude native init after an engine switch", () => {
  it("republishes from a switched Claude runtime's init", async () => {
    const claude = claudeParts("ask", true);
    cleanups.push(async () => { await claude.engine.dispose("session-close"); });
    const h = createHarness({ steps: [],
      switchEngineFactory: async () => ({ engine: claude.engine as never, engineSettings: claude.seam }) });
    cleanups.push(async () => { h.close(); });
    const seen: string[] = [];
    h.session.observePermissionMode(mode => seen.push(mode), () => {});
    h.send({ type: "ui_ready" });
    await h.waitUntil(() => h.received.some(m => m.type === "host_ready"));
    h.send({ type: "engine_switch_request", requestId: "to-claude", engine: "claude", model: "m" });
    await h.waitUntil(() => h.received.some(m => m.type === "engine_switched"));
    expect(seen.at(-1)).toBe("plan"); // resumed preset still provisional
    claude.init("default");
    expect(seen.at(-1)).toBe("build");
    claude.init("plan");
    expect(seen.at(-1)).toBe("plan");
  });
});

/**
 * A reopened session whose saved orchestration was recovered to a verified OFF
 * posture: the engine itself quarantines on a later init that drifts from the
 * recovered base. That quarantine never passes through the Session's
 * orchestration controller, so the seam must carry it.
 */
function recoveredOffRoot() {
  const transport = {
    notifications: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }) }),
    close: async () => {},
  } as never;
  const engine = new ClaudeEngine(transport, "native-ref", undefined, {
    catalog: ClaudeModelCatalog.fromInitialize([{ value: "m", resolvedModel: "m", displayName: "M" }]),
    model: "m", preset: findClaudePreset("ask")!, effortsByModel: new Map(), notices: [],
  });
  engine.installOrchestration({ orchestrationRecovery: { nativeBase: { version: 1, engine: "claude", model: "m", preset: "ask",
    permissionMode: "default", mcpDigest: "a".repeat(64), tools: ["Read"] } } } as never, { claudeNames: [] } as never);
  // The recovery connect step sets these after checking the OFF argv and MCP digest.
  engine.offBootVerified = true;
  engine.presetProvisional = true;
  const seam = new ClaudeSettingsSeam(engine);
  const h = createHarness({ steps: [], engine, engineSettings: seam });
  cleanups.push(async () => { h.close(); await engine.dispose("session-close"); });
  const seen: string[] = [];
  const orchestrate: boolean[] = [];
  h.session.observePermissionMode(mode => seen.push(mode), enabled => orchestrate.push(enabled));
  const init = (drift: { tools?: string[]; permissionMode?: Wire; mcp?: string[] } = {}) =>
    (engine as unknown as { onSystemInit(init: unknown): void }).onSystemInit({ session_id: "native-ref", model: "m",
      permissionMode: drift.permissionMode ?? "default", tools: drift.tools ?? ["Read"],
      mcp_servers: (drift.mcp ?? []).map(name => ({ name, status: "connected" })) });
  return { h, engine, seam, seen, orchestrate, init };
}

describe("Claude engine-owned quarantine revokes peer authority", () => {
  it("a recovered OFF publishes build once, and an unchanged repeated init publishes nothing", () => {
    const c = recoveredOffRoot();
    expect(c.seen).toEqual(["plan"]);
    c.init();
    expect(c.seen).toEqual(["plan", "build"]);
    expect(c.h.session.peerAuthorityClosed()).toBe(false);
    c.init();
    expect(c.seen).toEqual(["plan", "build"]);
    expect(c.orchestrate).toEqual([false, false]);
  });

  it.each([
    ["tool inventory", { tools: ["Read", "Bash"] }],
    ["MCP inventory", { mcp: ["extra"] }],
    ["permission mode", { permissionMode: "acceptEdits" as const }],
  ])("a later %s drift publishes plan/false at once although the init throws, and nothing reopens it", (_label, drift) => {
    const c = recoveredOffRoot();
    c.init();
    expect(c.seen.at(-1)).toBe("build");
    expect(() => c.init(drift)).toThrow("recovered OFF posture drift");
    expect(c.engine.orchestrationState).toBe("quarantined");
    expect(c.h.session.peerAuthorityClosed()).toBe(true);
    expect(c.seen).toEqual(["plan", "build", "plan"]);
    expect(c.orchestrate.at(-1)).toBe(false);
    // Later settings traffic and a later clean init cannot reopen it.
    (c.seam as unknown as { notify(snapshot: unknown): void }).notify(c.engine.snapshot());
    c.h.outbound.emit({ type: "engine_settings_changed", model: "m", activePresetId: "ask", state: "applied", appliesFrom: "next_turn" });
    c.init();
    expect(c.h.session.peerAuthorityClosed()).toBe(true);
    expect(c.seen.filter(mode => mode !== "plan")).toEqual(["build"]);
    expect(c.orchestrate.every(enabled => !enabled)).toBe(true);
  });

  it("a drift on the very first init of a provisional recovered preset keeps authority closed", () => {
    const c = recoveredOffRoot();
    expect(() => c.init({ tools: [] })).toThrow("recovered OFF posture drift");
    expect(c.h.session.peerAuthorityClosed()).toBe(true);
    expect(c.seen.every(mode => mode === "plan")).toBe(true);
    c.init();
    expect(c.h.session.peerAuthorityClosed()).toBe(true);
    expect(c.seen.every(mode => mode === "plan")).toBe(true);
  });

  it("the seam reports and signals any engine quarantine assignment, once per change", () => {
    const c = claudeParts("ask", false);
    cleanups.push(async () => { await c.engine.dispose("session-close"); });
    const calls: boolean[] = [];
    const stop = c.seam.onSettingsReconciled(() => calls.push(c.seam.runtimeQuarantined()));
    expect(c.seam.runtimeQuarantined()).toBe(false);
    c.engine.orchestrationState = "transitioning";
    expect(calls).toEqual([]);
    c.engine.orchestrationState = "quarantined";
    c.engine.orchestrationState = "quarantined";
    expect(calls).toEqual([true]);
    expect(c.seam.runtimeQuarantined()).toBe(true);
    stop();
    c.engine.orchestrationState = "off";
    expect(calls).toEqual([true]);
  });
});
