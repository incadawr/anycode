import { EventEmitter } from "node:events";
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { SqlitePersistenceAdapter } from "@anycode/core";
import { describe, expect, it, vi } from "vitest";
import { createDesktopStore } from "../renderer/src/store.js";
import { bootHostInTempProfile } from "./boot-test-env.js";

class Port extends EventEmitter {
  messages: any[] = [];
  postMessage(message: unknown) { this.messages.push(message); }
  start() {}
  send(message: unknown) { this.emit("message", { data: message }); }
}

const fixture = resolve("apps/desktop/scripts/compact-fixtures/claude.mjs");

describe("native context boot", () => {
  it("queries a legacy session and persists a new reading across a real host restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "context-boot-"));
    const saved = join(dir, "saved.sqlite");
    const binary = join(dir, "claude.mjs");
    const source = readFileSync(fixture, "utf8")
      .replace("const rl = createInterface", "let compacted = false;\nconst rl = createInterface")
      .replace('models: [{ value: "default", resolvedModel: "default", displayName: "Default" }]', 'models: [{ value: "default", resolvedModel: "default", displayName: "Default" }, { value: "other", resolvedModel: "other", displayName: "Other" }]')
      .replace("{ totalTokens: 1000, maxTokens: 200000 }", "compacted ? {} : { totalTokens: 1000, maxTokens: 200000 }")
      .replace('if (text === "/compact") { result(); return; }', 'if (text === "/compact") { compacted = true; result(); return; }');
    writeFileSync(binary, source);
    chmodSync(binary, 0o755);
    const argv = process.argv;
    try {
      for (const restart of [false, true]) {
        if (restart) writeFileSync(binary, source.replace("totalTokens: 1000, maxTokens: 200000", "totalTokens: 5000, maxTokens: 200000"));
        vi.resetModules();
        const result = await bootHostInTempProfile(async ({ parent, profile, requestShutdown, waitForStopped }) => {
          const port = new Port();
          parent.emit("message", { ports: [port], data: {} });
          await vi.waitFor(() => expect(port.listenerCount("message")).toBeGreaterThan(0), { timeout: 15000 });
          port.send({ type: "ui_ready" });
          await vi.waitFor(() => expect(port.messages.some(m => m.type === "host_ready")).toBe(true), { timeout: 15000 });
          expect(port.messages.find(m => m.type === "host_ready").contextUsage).toEqual({ estimatedTokens: 1000, budgetTokens: 200000, source: "provider" });
          if (!restart) {
            port.send({ type: "user_message", requestId: "turn", text: "hello" });
            await vi.waitFor(() => expect(port.messages.some(m => m.type === "agent_event" && m.event.type === "context_usage")).toBe(true), { timeout: 15000 });
          }
          if (restart) {
            const store = createDesktopStore();
            for (const m of port.messages) store.getState().applyHostMessage(m);
            port.send({ type: "set_model", model: "other" });
            await vi.waitFor(() => expect(port.messages.some(m => m.type === "engine_settings_changed" && m.clearContextUsage)).toBe(true));
            for (const m of port.messages) store.getState().applyHostMessage(m);
            expect(store.getState().contextUsage).toBeNull();
            let start = port.messages.length;
            port.send({ type: "ui_ready" });
            await vi.waitFor(() => expect(port.messages.slice(start).some(m => m.type === "context_usage_checkpoint" && m.contextUsage === null)).toBe(true));
            const reconnected = createDesktopStore();
            for (const m of port.messages.slice(start)) reconnected.getState().applyHostMessage(m);
            expect(reconnected.getState().contextUsage).toBeNull();
            port.send({ type: "user_message", requestId: "another", text: "hello" });
            await vi.waitFor(() => expect(port.messages.slice(start).some(m => m.type === "agent_event" && m.event.type === "context_usage")).toBe(true));
            port.send({ type: "compact_request" });
            await vi.waitFor(() => expect(port.messages.some(m => m.type === "agent_event" && m.event.type === "compaction_end" && m.event.ok)).toBe(true));
            for (const m of port.messages.slice(start)) reconnected.getState().applyHostMessage(m);
            expect(reconnected.getState().contextUsage).toBeNull();
            start = port.messages.length;
            port.send({ type: "ui_ready" });
            await vi.waitFor(() => expect(port.messages.slice(start).some(m => m.type === "context_usage_checkpoint" && m.contextUsage === null)).toBe(true));
            const afterCompact = createDesktopStore();
            for (const m of port.messages.slice(start)) afterCompact.getState().applyHostMessage(m);
            expect(afterCompact.getState().contextUsage).toBeNull();
          }
          requestShutdown();
          expect(await waitForStopped(15000)).toBe(true);
          const db = new SqlitePersistenceAdapter(profile.dbPath);
          const snapshot = await db.loadContextUsage("legacy");
          if (restart) expect(snapshot).toBeNull();
          else expect(JSON.parse(snapshot!)).toMatchObject({ engine: "claude", estimatedTokens: 1000 });
          await db.close();
          copyFileSync(profile.dbPath, saved);
        }, {
          extraEnv: { ANYCODE_ENGINE: "claude", ANYCODE_CLAUDE_BIN: binary },
          boot: async () => {
            process.argv = [argv[0]!, argv[1]!, "--resume", "legacy"];
            const path = process.env.ANYCODE_DB_PATH!;
            if (restart) copyFileSync(saved, path);
            else {
              const db = new SqlitePersistenceAdapter(path);
              await db.createSession({ id: "legacy", workspace: process.cwd(), model: "default", mode: "build", engineId: "claude", externalSessionRef: "native-ref" });
              await db.close();
            }
            await import("./index.js");
          },
        });
        if (result.error) throw result.error;
        expect(result.stopped).toBe(true);
      }
    } finally { process.argv = argv; rmSync(dir, { recursive: true, force: true }); }
  }, 60000);
});


describe("core context boot", () => {
  it("restores the persisted turn reading through the host restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "core-context-boot-"));
    const saved = join(dir, "saved.sqlite");
    const argv = process.argv;
    const server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        const base = { id: "fixture", object: "chat.completion.chunk", created: 0, model: "fixture-model" };
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12345, completion_tokens: 12, total_tokens: 12357 } })}\n\n`);
        response.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("No fixture address");
    let reading: { estimatedTokens: number; budgetTokens: number; source: string };
    try {
      for (const restart of [false, true]) {
        vi.resetModules();
        const result = await bootHostInTempProfile(async ({ parent, profile, requestShutdown, waitForStopped }) => {
          const port = new Port();
          parent.emit("message", { ports: [port], data: {} });
          await vi.waitFor(() => expect(port.listenerCount("message")).toBeGreaterThan(0), { timeout: 15000 });
          port.send({ type: "ui_ready" });
          await vi.waitFor(() => expect(port.messages.some(m => m.type === "host_ready")).toBe(true), { timeout: 15000 });
          if (restart) {
            expect(port.messages.find(m => m.type === "host_ready").contextUsage).toEqual(reading);
          } else {
            port.send({ type: "user_message", requestId: "turn", text: "hello" });
            await vi.waitFor(() => expect(port.messages.some(m => m.type === "agent_event" && m.event.type === "context_usage" && m.event.source === "provider")).toBe(true), { timeout: 15000 });
          }
          requestShutdown();
          expect(await waitForStopped(15000)).toBe(true);
          const db = new SqlitePersistenceAdapter(profile.dbPath);
          const snapshot = JSON.parse((await db.loadContextUsage("core-session"))!);
          expect(snapshot).toMatchObject({ engine: "core", model: "fixture-model", source: "provider" });
          if (!restart) {
            reading = { estimatedTokens: snapshot.estimatedTokens, budgetTokens: snapshot.budgetTokens, source: snapshot.source };
            expect(reading.estimatedTokens).toBeGreaterThan(10000);
          }
          await db.close();
          copyFileSync(profile.dbPath, saved);
        }, {
          extraEnv: { ANYCODE_MODEL: "fixture-model", ANYCODE_BASE_URL: `http://127.0.0.1:${address.port}/v1`, ANYCODE_API_KEY: "test", ANYCODE_PROVIDER_TRANSPORT: "openai-chat-completions", ANYCODE_CONTEXT_WINDOW: "200000" },
          boot: async () => {
            process.argv = [argv[0]!, argv[1]!, "--resume", "core-session"];
            process.chdir(dir);
            const path = process.env.ANYCODE_DB_PATH!;
            if (restart) copyFileSync(saved, path);
            else {
              const db = new SqlitePersistenceAdapter(path);
              await db.createSession({ id: "core-session", workspace: process.cwd(), model: "fixture-model", mode: "build", engineId: "core" });
              await db.close();
            }
            await import("./index.js");
          },
        });
        if (result.error) throw result.error;
        expect(result.stopped).toBe(true);
      }
    } finally {
      process.argv = argv;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);
});
