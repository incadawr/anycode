import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { bootHostInTempProfile } from "./boot-test-env.js";

class Port extends EventEmitter {
  messages: any[] = [];
  postMessage(message: unknown) { this.messages.push(message); }
  start() {}
  send(message: unknown) { this.emit("message", { data: message }); }
}

describe("host model pricing", () => {
  it("records each model's rate and exposes the sum in usage audit", async () => {
    let callAgent = false;
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const input = JSON.parse(body);
        const base = { id: "fixture", object: "chat.completion.chunk", created: 0, model: input.model };
        response.writeHead(200, { "content-type": "text/event-stream" });
        const invoke = callAgent && input.model === "a";
        if (invoke) callAgent = false;
        const delta = invoke ? { tool_calls: [{ index: 0, id: "call-agent", type: "function", function: { name: "Agent", arguments: JSON.stringify({ description: "test", prompt: "answer", agent_type: "general-purpose", model: "b" }) } }] } : { role: "assistant", content: "done" };
        response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: invoke ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1000, completion_tokens: 1000, total_tokens: 2000, prompt_tokens_details: { cached_tokens: 0 } } })}\n\n`);
        response.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("No fixture address");
    const settings = { version: 2, provider: { activeConnectionId: "conn-a", connections: [{ id: "conn-a", providerId: "custom:fixture", model: "a", modelOverrides: { a: { pricing: { input: 1, cachedInput: 0, output: 2 } }, b: { pricing: { input: 3, cachedInput: 0, output: 4 } } } }] }, tools: {}, permissions: { alwaysAllow: [] }, ui: { theme: "system" }, security: { allowWeakSecretStorage: false } };
    try {
      const result = await bootHostInTempProfile(async ({ parent, profile }) => {
        const port = new Port();
        parent.emit("message", { ports: [port], data: {} });
        await vi.waitFor(() => expect(port.listenerCount("message")).toBeGreaterThan(0), { timeout: 15000 });
        port.send({ type: "ui_ready" });
        await vi.waitFor(() => expect(port.messages.some((m) => m.type === "host_ready")).toBe(true));
        port.send({ type: "user_message", requestId: "one", text: "hi" });
        await vi.waitFor(() => expect(port.messages.some((m) => JSON.stringify(m).includes("done"))).toBe(true), { timeout: 15000 });
        await vi.waitFor(() => { port.send({ type: "usage_audit_request" }); expect(port.messages.filter((m) => m.type === "usage_audit").at(-1)?.steps?.length).toBe(1); }, { timeout: 15000 });
        port.send({ type: "set_model", model: "b" });
        await vi.waitFor(() => expect(port.messages.some((m) => m.type === "model_changed" && m.model === "b")).toBe(true));
        port.send({ type: "user_message", requestId: "two", text: "hi again" });
        await vi.waitFor(() => { port.send({ type: "usage_audit_request" }); expect(port.messages.filter((m) => m.type === "usage_audit").at(-1)?.steps?.length).toBe(2); }, { timeout: 15000 });
        const audit = port.messages.filter((m) => m.type === "usage_audit").at(-1);
        expect(audit.steps.find((s: any) => s.model === "a").costUsd).toBeCloseTo(.003);
        expect(audit.steps.find((s: any) => s.model === "b").costUsd).toBeCloseTo(.007);
        expect(audit.totals.costUsd).toBeCloseTo(.01);
        port.send({ type: "set_model", model: "a" });
        await vi.waitFor(() => expect(port.messages.some((m) => m.type === "model_changed" && m.model === "a")).toBe(true));
        callAgent = true;
        port.send({ type: "user_message", requestId: "three", text: "use an agent" });
        await vi.waitFor(() => { port.send({ type: "usage_audit_request" }); expect(port.messages.filter((m) => m.type === "usage_audit").at(-1)?.totals?.subagentCount).toBe(1); }, { timeout: 15000 });
        const childAudit = port.messages.filter((m) => m.type === "usage_audit").at(-1);
        expect(childAudit.totals.subagentCostUsd).toBeCloseTo(.007);
        port.send({ type: "set_model", model: "c" });
        await vi.waitFor(() => expect(port.messages.some((m) => m.type === "model_changed" && m.model === "c")).toBe(true));
        port.send({ type: "user_message", requestId: "four", text: "unpriced" });
        await vi.waitFor(() => { port.send({ type: "usage_audit_request" }); expect(port.messages.filter((m) => m.type === "usage_audit").at(-1)?.totals?.unpricedSteps).toBe(1); }, { timeout: 15000 });
        const unknown = port.messages.filter((m) => m.type === "usage_audit").at(-1).steps.find((row: any) => row.model === "c");
        expect(unknown.costUsd).toBeUndefined();
        expect(unknown.priceBasisId).toBeUndefined();
        const db = new DatabaseSync(profile.dbPath, { readOnly: true });
        try {
          const rows = db.prepare("SELECT model, cost_usd, price_basis_id, subagent_id FROM provider_usage").all();
          const child = rows.find((row) => row.subagent_id);
          expect(child).toMatchObject({ model: "b", cost_usd: .007 });
          expect(child?.price_basis_id).toContain('model:');
        } finally { db.close(); }
      }, { extraEnv: { ANYCODE_MODEL: "a", ANYCODE_BASE_URL: `http://127.0.0.1:${address.port}/v1`, ANYCODE_API_KEY: "test", ANYCODE_PROVIDER_TRANSPORT: "openai-chat-completions", ANYCODE_MODEL_SETTINGS_CONNECTION_ID: "conn-a", ANYCODE_CHILD_MODELS: '["a","b"]' }, boot: async () => { vi.resetModules(); writeFileSync(process.env.ANYCODE_SETTINGS_PATH!, JSON.stringify(settings)); await import("./index.js"); } });
      if (result.error !== null) throw result.error;
      expect(result.stopped).toBe(true);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  }, 60000);
});
