import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { bootHostInTempProfile } from "./boot-test-env.js";

class Port extends EventEmitter {
  messages: any[] = [];
  postMessage(message: unknown) { this.messages.push(message); }
  start() {}
  send(message: unknown) { this.emit("message", { data: message }); }
}

const extraEnv = { ANYCODE_PROVIDER_ID: "opencode", ANYCODE_MODEL: "gemini-4-argon", ANYCODE_API_KEY: "test", ANYCODE_AUTOMATIC_MODEL_ROUTING: "1" };

async function checkBoot(expected: string, settings?: object) {
  const result = await bootHostInTempProfile(async ({ parent }) => {
    const port = new Port();
    parent.emit("message", { ports: [port], data: {} });
    await vi.waitFor(() => expect(port.listenerCount("message")).toBeGreaterThan(0), { timeout: 15000 });
    port.send({ type: "ui_ready" });
    await vi.waitFor(() => expect(port.messages.find(m => m.type === "host_ready")?.model).toBe(expected), { timeout: 15000 });
    await vi.waitFor(() => expect(port.messages.some(m => m.type === "agent_event" && m.event?.type === "engine_notice" && m.event.level === "warning")).toBe(true));
    const notice = port.messages.find(m => m.type === "agent_event" && m.event?.type === "engine_notice" && m.event.level === "warning").event.message;
    expect(notice).toContain("gemini-4-argon");
    expect(notice).toContain(expected);
    expect(notice).not.toMatch(/\((unsupported|unknown)-model\)|invalid-route/);
  }, {
    extraEnv: { ...extraEnv, ...(settings ? { ANYCODE_MODEL_SETTINGS_CONNECTION_ID: "conn-go" } : {}) },
    boot: async () => { vi.resetModules(); if (settings) writeFileSync(process.env.ANYCODE_SETTINGS_PATH!, JSON.stringify(settings)); await import("./index.js"); },
  });
  if (result.error !== null) throw result.error;
  expect(result.stopped).toBe(true);
}

it("recovers a rejected model on boot and emits a readable notice", async () => {
  await checkBoot("minimax-m3.1-flash");
}, 60000);

it("uses a routable model from the saved connection snapshot", async () => {
  const settings = { version: 2, provider: { activeConnectionId: "conn-go", connections: [{ id: "conn-go", providerId: "opencode", model: "gemini-4-argon", modelRoutes: { version: 1, fetchedAt: "2026-11-05T00:00:00Z", models: {
    "gemini-4-argon": { kind: "refusal", reason: "unsupported-model" },
    alternate: { kind: "route", route: { transport: "openai-responses", baseUrl: "https://opencode.ai/inference/go/openai/v1", metadata: {} } },
  } } }] }, tools: {}, permissions: { alwaysAllow: [] }, ui: { theme: "system" }, security: { allowWeakSecretStorage: false } };
  await checkBoot("alternate", settings);
}, 60000);
