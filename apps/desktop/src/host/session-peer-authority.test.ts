/**
 * Native peer authority: a Claude or Codex root publishes the mapped Core
 * posture of its permission preset (never its display-only mode) over the same
 * observer pipe Core uses, and republishes on every preset transition.
 */

import { describe, expect, it } from "vitest";
import type { PermissionMode } from "@anycode/core";
import type { EngineId } from "./engines/session-engine.js";
import type { EngineSettingsSeam, SessionOptions } from "./session.js";
import { createHarness } from "./test-harness.js";

type Snapshot = { model: string; activePresetId: string };

/** Minimal two-phase settings seam: `selectPreset` records a pending choice, `apply`/`reject` settle it. */
function fakeSeam(initial: string) {
  let applied: Snapshot = { model: "m", activePresetId: initial };
  let pending: Snapshot | null = null;
  const appliedListeners = new Set<(snapshot: Snapshot) => void>();
  const rejectedListeners = new Set<(reason: string) => void>();
  const seam = {
    models: () => [], presets: () => [],
    snapshot: () => applied,
    pendingSnapshot: () => pending,
    selectModel: () => ({ ok: false as const, reason: "unused" }),
    selectPreset: (id: string) => { pending = { ...applied, activePresetId: id }; return { ok: true as const, ...pending }; },
    onSettingsApplied: (listener: (snapshot: Snapshot) => void) => { appliedListeners.add(listener); return () => appliedListeners.delete(listener); },
    onSettingsRejected: (listener: (reason: string) => void) => { rejectedListeners.add(listener); return () => rejectedListeners.delete(listener); },
  } as unknown as EngineSettingsSeam;
  return {
    seam,
    apply() { applied = pending ?? applied; pending = null; for (const listener of appliedListeners) listener(applied); },
    reject() { pending = null; for (const listener of rejectedListeners) listener("refused"); },
  };
}

function nativeEngine(id: EngineId): SessionOptions["engine"] {
  return { id, mode: () => "build", capabilities: {}, reasoningEffort: () => undefined, historyItems: () => [], dispose: async () => {} } as unknown as SessionOptions["engine"];
}

function observe(h: ReturnType<typeof createHarness>) {
  const modes: Array<[PermissionMode, EngineId]> = [];
  const orchestrate: Array<[boolean, EngineId]> = [];
  h.session.observePermissionMode((mode, engine) => modes.push([mode, engine]), (enabled, engine) => orchestrate.push([enabled, engine]));
  return { modes, orchestrate, last: () => modes.at(-1) };
}

describe("Session — native peer authority", () => {
  it("maps Claude presets to the Core posture on attach and after each applied change", async () => {
    const fake = fakeSeam("read-only");
    const h = createHarness({ steps: [], engine: nativeEngine("claude"), engineSettings: fake.seam });
    try {
      const seen = observe(h);
      expect(seen.modes).toEqual([["plan", "claude"]]);
      expect(seen.orchestrate).toEqual([[false, "claude"]]);
      h.send({ type: "set_engine_preset", presetId: "ask" });
      await h.waitUntil(() => seen.modes.length === 2);
      expect(seen.last()).toEqual(["plan", "claude"]); // pending widening does not count yet
      fake.apply();
      expect(seen.last()).toEqual(["build", "claude"]);
      h.send({ type: "set_engine_preset", presetId: "workspace" });
      await h.waitUntil(() => seen.modes.length > 3);
      fake.apply();
      expect(seen.last()).toEqual(["build", "claude"]);
      expect(seen.modes.every(([mode]) => mode !== "yolo")).toBe(true);
    } finally { h.close(); }
  });

  it("holds a pending Codex widening back until it is applied and reverts a rejected one", async () => {
    const fake = fakeSeam("ask");
    const h = createHarness({ steps: [], engine: nativeEngine("codex"), engineSettings: fake.seam });
    try {
      const seen = observe(h);
      expect(seen.last()).toEqual(["build", "codex"]);
      h.send({ type: "set_engine_preset", presetId: "full-access" });
      await h.waitUntil(() => seen.modes.length === 2);
      expect(seen.last()).toEqual(["build", "codex"]);
      fake.apply();
      expect(seen.last()).toEqual(["yolo", "codex"]);
      h.send({ type: "set_engine_preset", presetId: "read-only" });
      await h.waitUntil(() => seen.last()?.[0] === "plan"); // a pending narrowing counts at once
      fake.reject();
      expect(seen.last()).toEqual(["yolo", "codex"]); // reverted snapshot republished
    } finally { h.close(); }
  });

  it("does not forward a native display mode and republishes the session flag, not the emitted one", () => {
    const fake = fakeSeam("ask");
    const h = createHarness({ steps: [], engine: nativeEngine("codex"), engineSettings: fake.seam });
    try {
      const seen = observe(h);
      h.outbound.emit({ type: "mode_changed", mode: "yolo" });
      expect(seen.modes).toEqual([["build", "codex"]]);
      h.outbound.emit({ type: "orchestrate_changed", enabled: true });
      expect(seen.orchestrate).toEqual([[false, "codex"], [false, "codex"]]);
    } finally { h.close(); }
  });

  it("fails closed without a settings seam and while the posture is quarantined", () => {
    const bare = createHarness({ steps: [], engine: nativeEngine("claude") });
    const fake = fakeSeam("full-access");
    const quarantined = createHarness({ steps: [], engine: nativeEngine("codex"), engineSettings: fake.seam });
    try {
      expect(observe(bare).modes).toEqual([["plan", "claude"]]);
      (quarantined.session as unknown as { orchestrate: boolean; orchestrationPosture: string }).orchestrate = true;
      const seen = observe(quarantined);
      expect(seen.last()).toEqual(["yolo", "codex"]);
      expect(seen.orchestrate).toEqual([[true, "codex"]]);
      (quarantined.session as unknown as { orchestrationPosture: string }).orchestrationPosture = "quarantined";
      quarantined.outbound.emit({ type: "orchestrate_changed", enabled: true });
      expect(seen.last()).toEqual(["plan", "codex"]);
      expect(seen.orchestrate.at(-1)).toEqual([false, "codex"]);
    } finally { bare.close(); quarantined.close(); }
  });

  it("keeps forwarding Core mode and orchestrate reports tagged core", async () => {
    const h = createHarness({ steps: [], mode: "plan" });
    try {
      const seen = observe(h);
      h.send({ type: "set_mode", mode: "build" });
      await h.waitUntil(() => seen.modes.length === 2);
      expect(seen.modes).toEqual([["plan", "core"], ["build", "core"]]);
    } finally { h.close(); }
  });
});

describe("Session — native peer authority across an engine switch", () => {
  it("republishes with the target engine id and its mapped preset", async () => {
    const core = nativeEngine("core");
    const fake = fakeSeam("full-access");
    const h = createHarness({ steps: [], engine: core,
      switchEngineFactory: async () => ({ engine: nativeEngine("codex"), engineSettings: fake.seam }) });
    try {
      h.send({ type: "ui_ready" });
      await h.waitUntil(() => h.received.some(m => m.type === "host_ready"));
      const seen = observe(h);
      expect(seen.last()).toEqual(["build", "core"]);
      h.send({ type: "engine_switch_request", requestId: "to-codex", engine: "codex", model: "test-model" });
      await h.waitUntil(() => h.received.some(m => m.type === "engine_switched"));
      expect(seen.last()).toEqual(["yolo", "codex"]);
      expect(seen.orchestrate.at(-1)).toEqual([false, "codex"]);
    } finally { h.close(); }
  });
});
