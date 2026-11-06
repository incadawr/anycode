import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { cloneDefaults } from "../settings/schema.js";
import { loadSettings, saveSettings, withSettingsFileLock } from "../settings/files.js";
import { recordReasoningReplayRejection } from "./reasoning-replay.js";

let dir: string;
let settingsPath: string;
const event = { type: "reasoning_replay_rejected", reason: "provider-rejected", baseUrl: "https://fixture.invalid", model: "a" };
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "replay-"));
  settingsPath = join(dir, "settings.json");
  const settings = cloneDefaults();
  settings.provider.connections = [
    { id: "one", providerId: "custom", model: "a", models: ["a", "b"], baseUrl: event.baseUrl, modelOverrides: { a: { contextWindowTokens: 8192 }, b: { preserveReasoning: true } } },
    { id: "two", providerId: "custom", model: "a", baseUrl: event.baseUrl },
  ];
  await saveSettings(settingsPath, settings);
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
const read = async () => (await loadSettings(settingsPath)).settings;
it("records only the pinned model slot and restores from disk", async () => {
  expect(await recordReasoningReplayRejection({ settingsPath }, "one", event)).toBe(true);
  const connections = (await read()).provider.connections;
  expect(connections[0]?.modelOverrides).toEqual({ a: { contextWindowTokens: 8192, reasoningReplayRejection: { reason: event.reason, baseUrl: event.baseUrl } }, b: { preserveReasoning: true } });
  expect(connections[1]?.modelOverrides).toBeUndefined();
});
it.each([null, {}, { ...event, reason: "other" }, { ...event, baseUrl: "bad" }, { ...event, model: "unknown" }, { ...event, baseUrl: "https://old.invalid" }, { ...event, connectionId: "two" }, { ...event, settingsPath: "/ignored" }, { ...event, patch: {} }])("ignores malformed or stale reports %j", async raw => {
  expect(await recordReasoningReplayRejection({ settingsPath }, "one", raw)).toBe(false);
  expect((await read()).provider.connections[0]?.modelOverrides?.a?.reasoningReplayRejection).toBeUndefined();
});
it("ignores a removed connection", async () => {
  expect(await recordReasoningReplayRejection({ settingsPath }, "missing", event)).toBe(false);
});
it.each([true, false])("rechecks explicit %s after waiting for the settings lock", async preserveReasoning => {
  let pending!: Promise<boolean>;
  await withSettingsFileLock(settingsPath, async () => {
    pending = recordReasoningReplayRejection({ settingsPath }, "one", event);
    const settings = await read();
    settings.provider.connections[0]!.modelOverrides!.a!.preserveReasoning = preserveReasoning;
    await saveSettings(settingsPath, settings);
  });
  expect(await pending).toBe(false);
  expect((await read()).provider.connections[0]?.modelOverrides?.a?.preserveReasoning).toBe(preserveReasoning);
});

it("checks the edited endpoint after waiting on the lock", async () => {
  let pending!: Promise<boolean>;
  await withSettingsFileLock(settingsPath, async () => {
    pending = recordReasoningReplayRejection({ settingsPath }, "one", event);
    const settings = await read();
    settings.provider.connections[0]!.baseUrl = "https://changed.invalid";
    await saveSettings(settingsPath, settings);
  });
  expect(await pending).toBe(false);
});
it("resolves an automatic route rather than trusting the observed endpoint", async () => {
  const { resolveOpenCodeGoEndpointPolicy } = await import("@anycode/core/opencode-go");
  const settings = await read();
  settings.provider.connections[0] = { id: "one", providerId: "opencode", model: "kimi-k3" };
  await saveSettings(settingsPath, settings);
  const route = resolveOpenCodeGoEndpointPolicy("opencode", "kimi-k3");
  if (route.kind !== "route") throw new Error("missing fixture route");
  expect(await recordReasoningReplayRejection({ settingsPath }, "one", { ...event, model: "kimi-k3", baseUrl: route.route.baseUrl })).toBe(true);
  expect(await recordReasoningReplayRejection({ settingsPath }, "one", { ...event, model: "kimi-k3" })).toBe(false);
});
