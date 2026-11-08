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
