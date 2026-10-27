import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  AgentLoop, AiSdkModelPort, InMemoryHookRunner, InMemoryTodoStore,
  ModePermissionEngine, NodeHttpAdapter, RuleAwarePermissionEngine,
  SessionPermissionRules, SwitchableModelPort, createDefaultToolRegistry,
  resolveEffortLevels, resolveReasoningEffort,
  type AgentLoopConfig,
} from "@anycode/core";
import { findCatalogEntry } from "@anycode/core/catalog";
import type { HostToUiMessage } from "../shared/protocol.js";
import { CoreEngine } from "./engines/core-engine.js";
import { IpcPermissionBroker } from "./permission-broker.js";
import { createHarness, MemFs } from "./test-harness.js";

type Msg<T extends HostToUiMessage["type"]> = Extract<HostToUiMessage, { type: T }>;
const ready = (m: HostToUiMessage): m is Msg<"host_ready"> => m.type === "host_ready";
const changed = (m: HostToUiMessage): m is Msg<"model_changed"> => m.type === "model_changed";

describe("session default effort through the Responses request", () => {
  it.each([
    ["gpt-6.1-sol", "medium", false],
    ["gpt-6.1-terra", "medium", false],
    ["gpt-6-astra", "off", true],
  ] as const)("uses %s's documented default or sends no effort when unavailable", async (initial, displayed, unknown) => {
    const bodies: Record<string, unknown>[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end([
          { type: "response.created", response: { id: "resp_1", created_at: 1_700_000_000, model: "gpt-6.1-terra" } },
          { type: "response.completed", response: { usage: { input_tokens: 5, input_tokens_details: { cached_tokens: 0 }, output_tokens: 2, output_tokens_details: { reasoning_tokens: 0 } } } },
        ].map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    const port = (model: string) => new AiSdkModelPort({ transport: "openai-responses", baseUrl, apiKey: "test-key", model, providerName: "OpenAI", retry: { maxRetries: 0, stallTimeoutMs: 0 } });
    const switchable = new SwitchableModelPort(port(initial));
    const entry = findCatalogEntry("openai")!;
    const bootEffort = resolveReasoningEffort(initial, entry, undefined);
    const config: AgentLoopConfig = {
      modelPort: switchable, registry: createDefaultToolRegistry(), hooks: new InMemoryHookRunner(),
      permissionEngine: new RuleAwarePermissionEngine(new ModePermissionEngine(), new SessionPermissionRules()),
      permissionBroker: new IpcPermissionBroker(() => {}), mode: "build", cwd: "/workspace",
      ports: { fs: new MemFs(), exec: {} as AgentLoopConfig["ports"]["exec"], http: new NodeHttpAdapter(), todos: new InMemoryTodoStore() },
      reasoningEffort: bootEffort,
    };
    const engine = new CoreEngine({ loop: new AgentLoop(config), config, switchModelImpl: (id, selected) => {
      switchable.setPort(port(id));
      config.reasoningEffort = resolveReasoningEffort(id, entry, selected);
      return { model: id, reasoningEffort: config.reasoningEffort ?? "off", availableEffortLevels: resolveEffortLevels(id, entry) };
    } });
    const h = createHarness({ steps: [], engine, reasoningSupported: true, availableEffortLevels: resolveEffortLevels(initial, entry), selectedEffort: bootEffort });
    try {
      h.send({ type: "ui_ready" });
      const hello = await h.waitFor(ready);
      expect(hello.reasoningEffort).toBe(displayed);
      expect(hello.availableEffortLevels === undefined).toBe(unknown);
      h.send({ type: "user_message", requestId: "boot", text: "hello" });
      await h.waitUntil(() => h.received.some((m) => m.type === "agent_event" && m.event.type === "loop_end"));
      expect(bodies[0]?.model).toBe(initial);
      if (unknown) expect(bodies[0]?.reasoning).toBeUndefined();
      else expect(bodies[0]?.reasoning).toMatchObject({ effort: "medium" });
      h.send({ type: "set_model", model: "gpt-6.1-terra" });
      const switched = await h.waitFor(changed);
      expect(switched.reasoningEffort).toBe(unknown ? "off" : "medium");
      h.send({ type: "user_message", requestId: "next", text: "hello again" });
      await h.waitUntil(() => bodies.length > 1);
      expect(bodies[1]?.model).toBe("gpt-6.1-terra");
      if (unknown) expect(bodies[1]?.reasoning).toMatchObject({ effort: "none" });
      else expect(bodies[1]?.reasoning).toMatchObject({ effort: "medium" });
    } finally {
      h.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
