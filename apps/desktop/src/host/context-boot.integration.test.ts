import { EventEmitter } from "node:events";
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
