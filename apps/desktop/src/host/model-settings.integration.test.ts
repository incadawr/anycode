import { EventEmitter } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { bootHostInTempProfile } from "./boot-test-env.js";
import { handleCustomProviderCreate } from "../main/provider-ipc.js";
import { handleConnectionCreate } from "../main/settings-ipc.js";
import { buildHostEnv } from "../main/host-env.js";
import { loadSettings } from "../settings/files.js";

class Port extends EventEmitter {
  messages: any[] = [];
  postMessage(message: unknown) { this.messages.push(message); }
  start() {}
  send(message: unknown) { this.emit("message", { data: message }); }
}

const vault = {
  setSecret: async () => ({ ok: true as const }),
  clearSecret: async () => {},
  getSecretValue: async () => undefined,
  probeSecret: async () => ({ state: "unset" as const }),
  statuses: async () => [],
};

function respond(response: ServerResponse, model: string) {
  const base = { id: "fixture", object: "chat.completion.chunk", created: 0, model };
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }] })}\n\n`);
  response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
  response.end("data: [DONE]\n\n");
}

describe("persisted model settings through the host", () => {
  it.each(["on", "off"] as const)("creates a custom endpoint with image input %s and enforces it after reload", async (setting) => {
    const requests: any[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", chunk => { body += chunk; });
      req.on("end", () => { const input = JSON.parse(body); requests.push(input); respond(res, input.model); });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No fixture address");
    const url = `http://127.0.0.1:${address.port}/v1`;
    try {
      const result = await bootHostInTempProfile(async ({ parent }) => {
        const port = new Port();
        parent.emit("message", { ports: [port], data: {} });
        await vi.waitFor(() => expect(port.listenerCount("message")).toBeGreaterThan(0), { timeout: 15000 });
        port.send({ type: "ui_ready" });
        await vi.waitFor(() => expect(port.messages.some(m => m.type === "host_ready")).toBe(true));
        expect(port.messages.find(m => m.type === "host_ready").imageInput).toBe(setting === "on");
        port.send({ type: "user_message", requestId: "image", text: "look", images: [{ mediaType: "image/png", data: "QUJD", sourcePath: "shot.png" }] });
        if (setting === "off") {
          await vi.waitFor(() => expect(port.messages).toContainEqual(expect.objectContaining({ type: "turn_rejected", requestId: "image", reason: "unsupported_images" })));
          expect(requests).toHaveLength(0);
        } else {
          await vi.waitFor(() => expect(requests.some(r => r.messages.some((m: any) => Array.isArray(m.content) && m.content.some((part: any) => part.type === "image_url")))).toBe(true), { timeout: 15000 });
        }
      }, { boot: async () => {
        const path = process.env.ANYCODE_SETTINGS_PATH!;
        expect((await handleCustomProviderCreate({ vault, settingsPath: path, genId: () => "custom:fixture" }, { name: "Fixture", baseUrl: url, kind: "openai-compatible", authOptional: true })).ok).toBe(true);
        expect((await handleConnectionCreate({ vault, settingsPath: path, bootEnv: {}, catalogIds: ["custom:fixture"], isCustom: () => true, genConnectionId: () => "conn-fixture" }, { providerId: "custom:fixture", model: "vision", transport: "openai-chat-completions", imageInputOverride: setting })).ok).toBe(true);
        const loaded = (await loadSettings(path)).settings;
        expect(loaded.provider.connections[0]).toMatchObject({ imageInputOverride: setting, imageInputModel: "vision" });
        const env = await buildHostEnv({ bootEnv: {}, settings: loaded, getSecret: async () => undefined });
        Object.assign(process.env, env, { ANYCODE_API_KEY: "test", ANYCODE_BASE_URL: url, ANYCODE_MODEL_SETTINGS_CONNECTION_ID: "conn-fixture" });
        vi.resetModules();
        await import("./index.js");
      }});
      if (result.error !== null) throw result.error;
      expect(result.stopped).toBe(true);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  }, 45000);

  it("applies vocabulary edits only after the in-flight turn and clears them on the following turn", async () => {
    const requests: any[] = [];
    let release: (() => void) | undefined;
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", chunk => { body += chunk; });
      req.on("end", () => {
        const input = JSON.parse(body);
        const prompt = input.messages.findLast((m: any) => m.role === "user")?.content;
        if (input.tools?.length && ["first", "second", "third"].includes(prompt)) {
          requests.push(input);
          if (prompt !== "third") release = () => { if (!res.writableEnded) respond(res, input.model); };
          else respond(res, input.model);
        } else respond(res, input.model);
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No fixture address");
    const settings = { version: 2, provider: { activeConnectionId: "conn-a", connections: [{ id: "conn-a", providerId: "custom:fixture", model: "a", modelOverrides: { a: { reasoningSupported: true, reasoningEffort: "high", effortLevels: ["low", "high"] } } }] }, tools: {}, permissions: { alwaysAllow: [] }, ui: { theme: "system" }, security: { allowWeakSecretStorage: false } };
    try {
      const result = await bootHostInTempProfile(async ({ parent, profile }) => {
        const port = new Port(); parent.emit("message", { ports: [port], data: {} });
        await vi.waitFor(() => expect(port.listenerCount("message")).toBeGreaterThan(0), { timeout: 15000 });
        port.send({ type: "ui_ready" });
        await vi.waitFor(() => expect(port.messages.some(m => m.type === "host_ready")).toBe(true));
        port.send({ type: "user_message", requestId: "one", text: "first" });
        await vi.waitFor(() => expect(requests).toHaveLength(1), { timeout: 15000 });
        expect(requests[0].reasoning_effort).toBe("high");
        settings.provider.connections[0]!.modelOverrides.a = { reasoningSupported: true, reasoningEffort: "low", effortLevels: ["low"] };
        writeFileSync(profile.settingsPath, JSON.stringify(settings));
        expect(requests[0].reasoning_effort).toBe("high");
        release!();
        await vi.waitFor(() => expect(port.messages.filter(m => m.type === "agent_event" && m.event?.type === "loop_end")).toHaveLength(1), { timeout: 15000 });
        port.send({ type: "user_message", requestId: "two", text: "second" });
        await vi.waitFor(() => expect(requests).toHaveLength(2), { timeout: 15000 });
        expect(requests[1].reasoning_effort).toBe("low");
        expect(port.messages.filter(m => m.type === "model_changed").at(-1)?.availableEffortLevels).toEqual(["low"]);
        delete (settings.provider.connections[0]!.modelOverrides.a as { effortLevels?: string[] }).effortLevels;
        writeFileSync(profile.settingsPath, JSON.stringify(settings));
        release!();
        await vi.waitFor(() => expect(port.messages.filter(m => m.type === "agent_event" && m.event?.type === "loop_end")).toHaveLength(2), { timeout: 15000 });
        port.send({ type: "user_message", requestId: "three", text: "third" });
        await vi.waitFor(() => expect(requests).toHaveLength(3), { timeout: 15000 });
        expect(requests[2].reasoning_effort).toBe("low");
        expect(port.messages.filter(m => m.type === "model_changed").at(-1)?.availableEffortLevels).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
        await vi.waitFor(() => expect(port.messages.filter(m => m.type === "agent_event" && m.event?.type === "loop_end")).toHaveLength(3), { timeout: 15000 });
      }, { extraEnv: { ANYCODE_MODEL: "a", ANYCODE_BASE_URL: `http://127.0.0.1:${address.port}/v1`, ANYCODE_API_KEY: "test", ANYCODE_PROVIDER_TRANSPORT: "openai-chat-completions", ANYCODE_MODEL_SETTINGS_CONNECTION_ID: "conn-a" }, boot: async () => { vi.resetModules(); writeFileSync(process.env.ANYCODE_SETTINGS_PATH!, JSON.stringify(settings)); await import("./index.js"); } });
      if (result.error !== null) throw result.error;
      expect(result.stopped).toBe(true);
    } finally { release?.(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }, 60000);
});
