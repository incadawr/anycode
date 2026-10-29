import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { SqlitePersistenceAdapter } from "@anycode/core";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { bootHostInTempProfile, PROXY_ENV_KEYS } from "./boot-test-env.js";

class FakePort extends EventEmitter {
  messages: any[] = [];
  postMessage(message: unknown) { this.messages.push(message); }
  start() {}
  send(message: unknown) { this.emit("message", { data: message }); }
}

describe("host boot effort selection", () => {
  it("retains a saved off selection when switching from GLM-5.2 to GLM-5.3", async () => {
    // The profile inputs the fork must NOT see, captured for the cleanup checks.
    const ambient = {
      home: process.env.HOME,
      sessionId: process.env.ANYCODE_SESSION_ID,
      sessionWorkspace: process.env.ANYCODE_SESSION_WORKSPACE,
      proxy: Object.fromEntries(PROXY_ENV_KEYS.map((key) => [key, process.env[key]])),
    };
    let stampedSessionId: string | undefined;
    const result = await bootHostInTempProfile(
      async ({ parent, profile, requestShutdown, waitForStopped }) => {
        const port = new FakePort();
        parent.emit("message", { ports: [port], data: {} });
        await vi.waitFor(() => expect(port.listenerCount("message")).toBeGreaterThan(0), { timeout: 15000 });
        port.send({ type: "ui_ready" });
        await vi.waitFor(() => expect(port.messages.some((m) => m.type === "host_ready")).toBe(true));
        expect(port.messages.find((m) => m.type === "host_ready").reasoningEffort).toBe("off");
        expect(port.messages.find((m) => m.type === "host_ready")).not.toHaveProperty("reasoningEffortDefault");
        port.send({ type: "set_model", model: "glm-5.3" });
        await vi.waitFor(() => expect(port.messages.some((m) => m.type === "model_changed")).toBe(true));
        expect(port.messages.find((m) => m.type === "model_changed").reasoningEffort).toBe("off");
        expect(port.messages.find((m) => m.type === "model_changed")).not.toHaveProperty("reasoningEffortDefault");
        // What the fork stamped into its own environment on this bare boot.
        stampedSessionId = process.env.ANYCODE_SESSION_ID;
        requestShutdown();
        expect(await waitForStopped(15000)).toBe(true);
        // Guard: the host wrote its session into the TEMP database (proves it never
        // fell back to the developer's real ~/.anycode/anycode.sqlite).
        expect(existsSync(profile.dbPath)).toBe(true);
        expect(statSync(profile.dbPath).size).toBeGreaterThan(0);
      },
      {
        tempPrefix: "anycode-effort-test-",
        extraEnv: {
          ANYCODE_MODEL: "glm-5.2",
          ANYCODE_BASE_URL: "https://api.z.ai/api/anthropic",
          ANYCODE_API_KEY: "test",
          ANYCODE_REASONING_EFFORT: "off",
        },
      },
    );

    if (result.error !== null) throw result.error;
    // The fork read the throwaway profile through the end of its teardown: the
    // scaffolding stops it before restoring anything, so a boot that outlives a
    // timed-out wait cannot be handed the developer's real environment.
    expect(result.stopped).toBe(true);
    expect(result.restored).toBe(true);
    expect(result.homeAtStop).toBe(result.profile.dir);
    // The session pair the fork created is gone again (this is the case that
    // matters: both keys are absent from the ambient environment).
    expect(stampedSessionId).toBeTruthy();
    expect(process.env.ANYCODE_SESSION_ID).toBe(ambient.sessionId);
    expect(process.env.ANYCODE_SESSION_WORKSPACE).toBe(ambient.sessionWorkspace);
    // The shell's environment is back, and nothing of the throwaway profile is left.
    expect(process.env.HOME).toBe(ambient.home);
    for (const key of PROXY_ENV_KEYS) expect(process.env[key]).toBe(ambient.proxy[key]);
    expect(existsSync(result.profile.dir)).toBe(false);
  }, 45_000);
});


it("pins an unpinned legacy host's live model settings to the connection that supplied its fork env", async () => {
  const settings = {
    version:2, provider:{activeConnectionId:"conn-source", connections:[{id:"conn-source", providerId:"z-ai", model:"glm-5.2", modelOverrides:{
      "glm-5.2":{contextWindowTokens:128000, reasoningEffort:"high"},
      "glm-5.3":{contextWindowTokens:64000, reasoningEffort:"low"},
    }}]}, tools:{}, permissions:{alwaysAllow:[]}, ui:{theme:"system"}, security:{allowWeakSecretStorage:false},
  };
  const result = await bootHostInTempProfile(async ({parent, profile}) => {
    const port = new FakePort();
    parent.emit("message", {ports:[port], data:{}});
    await vi.waitFor(() => expect(port.listenerCount("message")).toBeGreaterThan(0), {timeout:15000});
    port.send({type:"ui_ready"});
    await vi.waitFor(() => expect(port.messages.some((m) => m.type === "host_ready")).toBe(true));
    expect(port.messages.find((m) => m.type === "host_ready").modelSettingsConnectionId).toBe("conn-source");
    settings.provider.activeConnectionId = "other-connection";
    writeFileSync(profile.settingsPath, JSON.stringify(settings));
    port.send({type:"set_model", model:"glm-5.3"});
    await vi.waitFor(() => expect(port.messages.some((m) => m.type === "model_changed")).toBe(true));
    expect(port.messages.find((m) => m.type === "model_changed")).toMatchObject({reasoningEffort:"low", contextUsage:{budgetTokens:40000}});
    settings.provider.connections[0]!.modelOverrides["glm-5.2"] = {contextWindowTokens:96000, reasoningEffort:"max"};
    writeFileSync(profile.settingsPath, JSON.stringify(settings));
    port.send({type:"set_model", model:"glm-5.2"});
    await vi.waitFor(() => expect(port.messages.filter((m) => m.type === "model_changed")).toHaveLength(2));
    expect(port.messages.filter((m) => m.type === "model_changed").at(-1)).toMatchObject({reasoningEffort:"max", contextUsage:{budgetTokens:72000}});
  }, {
    extraEnv:{ANYCODE_MODEL:"glm-5.2", ANYCODE_BASE_URL:"https://api.z.ai/api/anthropic", ANYCODE_API_KEY:"test",
      ANYCODE_MODEL_SETTINGS_CONNECTION_ID:"conn-source", ANYCODE_CONTEXT_WINDOW:"128000", ANYCODE_CONTEXT_WINDOW_MODEL:"glm-5.2", ANYCODE_CONTEXT_WINDOW_FROM_SETTINGS:"1",
      ANYCODE_REASONING_EFFORT:"high", ANYCODE_REASONING_EFFORT_MODEL:"glm-5.2"},
    boot:async () => { vi.resetModules(); writeFileSync(process.env.ANYCODE_SETTINGS_PATH!, JSON.stringify(settings)); await import("./index.js"); },
  });
  if (result.error !== null) throw result.error;
  expect(result.stopped).toBe(true);
}, 45000);


for (const [resumed, initialModel] of [[false, "both"], [false, "onlyMax"], [true, "both"]] as const) {
  it(`resolves child effort across ${resumed ? "durable resume" : "fresh boot"} on ${initialModel}, switches and settings refresh`, async () => {
    const requests: any[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        const input = JSON.parse(body); requests.push(input);
        const base = { id: "fixture", object: "chat.completion.chunk", created: 0, model: input.model };
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
        res.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("No fixture address");
    const settings = { version: 2, provider: { activeConnectionId: "conn", connections: [{ id: "conn", providerId: "custom:fixture", model: "both", modelCapabilities: {
      both: { reasoning: true, effortLevels: ["xhigh", "max"] }, onlyMax: { reasoning: true, effortLevels: ["max"] },
    } }] }, tools: {}, permissions: { alwaysAllow: [] }, ui: { theme: "system" }, security: { allowWeakSecretStorage: false } };
    const oldArgv = process.argv;
    try {
      process.argv = [process.execPath, "host", ...(resumed ? ["--resume", "effort-child"] : ["--session", "effort-child", "--child-parent", "parent", "--child-spawn-call", "call", "--child-mode", "build"])];
      const result = await bootHostInTempProfile(async ({ parent, profile }) => {
        const port = new FakePort();
        parent.emit("message", { ports: [port], data: {} });
        await vi.waitFor(() => expect(port.listenerCount("message")).toBeGreaterThan(0), { timeout: 15000 });
        port.send({ type: "ui_ready" });
        await vi.waitFor(() => expect(port.messages.some((m) => m.type === "host_ready")).toBe(true));
        expect(port.messages.find((m) => m.type === "host_ready").reasoningEffort).toBe(initialModel === "both" ? "xhigh" : "max");
        if (!resumed) {
          port.send({ type: "set_model", model: "both" });
          await vi.waitFor(() => expect(port.messages.some((m) => m.type === "model_changed" && m.model === "both")).toBe(true));
          expect(port.messages.filter((m) => m.type === "model_changed").at(-1)).toMatchObject({ selectedReasoningEffort: "xhigh", reasoningEffort: "xhigh" });
          port.send({ type: "set_model", model: "onlyMax" });
          await vi.waitFor(() => expect(port.messages.some((m) => m.type === "model_changed" && m.model === "onlyMax")).toBe(true));
          expect(port.messages.filter((m) => m.type === "model_changed").at(-1)).toMatchObject({ selectedReasoningEffort: "xhigh", reasoningEffort: "max" });
          settings.provider.connections[0]!.modelCapabilities.onlyMax.effortLevels = ["xhigh", "max"];
          writeFileSync(profile.settingsPath, JSON.stringify(settings));
          port.send({ type: "user_message", requestId: "refresh", text: "hello" });
          await vi.waitFor(() => expect(requests.length).toBeGreaterThan(0), { timeout: 15000 });
          expect(requests.at(-1).reasoning_effort).toBe("xhigh");
          expect(port.messages.filter((m) => m.type === "model_changed").at(-1)).toMatchObject({ selectedReasoningEffort: "xhigh", reasoningEffort: "xhigh" });
          return;
        }
        port.send({ type: "user_message", requestId: "one", text: "hello" });
        await vi.waitFor(() => expect(requests.length).toBeGreaterThanOrEqual(1), { timeout: 15000 });
        expect(requests[0].reasoning_effort).toBe("xhigh");
        await vi.waitFor(() => expect(port.messages.some((m) => m.type === "agent_event" && m.event?.type === "loop_end")).toBe(true), { timeout: 15000 });
        port.send({ type: "set_model", model: "onlyMax" });
        await vi.waitFor(() => expect(port.messages.some((m) => m.type === "model_changed" && m.model === "onlyMax")).toBe(true));
        expect(port.messages.filter((m) => m.type === "model_changed").at(-1)).toMatchObject({ selectedReasoningEffort: "xhigh", reasoningEffort: "max" });
        const beforeSecond = requests.length;
        port.send({ type: "user_message", requestId: "two", text: "hello again" });
        await vi.waitFor(() => expect(requests.length).toBeGreaterThan(beforeSecond), { timeout: 15000 });
        expect(requests.at(-1).reasoning_effort).toBe("high"); // chat-completions transport's max encoding
        settings.provider.connections[0]!.modelCapabilities.onlyMax.effortLevels = ["xhigh", "max"];
        writeFileSync(profile.settingsPath, JSON.stringify(settings));
        await vi.waitFor(() => expect(port.messages.filter((m) => m.type === "agent_event" && m.event?.type === "loop_end").length).toBeGreaterThanOrEqual(2), { timeout: 15000 });
        const beforeThird = requests.length;
        port.send({ type: "user_message", requestId: "three", text: "refresh" });
        await vi.waitFor(() => expect(requests.length).toBeGreaterThan(beforeThird), { timeout: 15000 });
        expect(requests.at(-1).reasoning_effort).toBe("xhigh");
        expect(port.messages.filter((m) => m.type === "model_changed").at(-1)).toMatchObject({ selectedReasoningEffort: "xhigh", reasoningEffort: "xhigh" });
      }, {
        extraEnv: { ANYCODE_MODEL: initialModel, ANYCODE_BASE_URL: `http://127.0.0.1:${address.port}/v1`, ANYCODE_API_KEY: "test", ANYCODE_PROVIDER_TRANSPORT: "openai-chat-completions", ANYCODE_MODEL_SETTINGS_CONNECTION_ID: "conn", ANYCODE_REASONING_EFFORT: "xhigh" },
        boot: async () => {
          vi.resetModules();
          writeFileSync(process.env.ANYCODE_SETTINGS_PATH!, JSON.stringify(settings));
          if (resumed) {
            const db = new SqlitePersistenceAdapter(process.env.ANYCODE_DB_PATH!);
            await db.createSession({ id: "effort-child", workspace: process.cwd(), model: "both", mode: "build", parentSessionId: "parent", spawnToolCallId: "call" });
            await db.close();
          }
          await import("./index.js");
        },
      });
      if (result.error !== null) throw result.error;
      expect(result.stopped).toBe(true);
    } finally {
      process.argv = oldArgv;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 60000);
}
