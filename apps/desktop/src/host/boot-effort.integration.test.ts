import { EventEmitter } from "node:events";
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
  it("adjusts an unbound off override when switching from GLM-5.2 to GLM-5.3", async () => {
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
        expect(port.messages.find((m) => m.type === "model_changed")).toMatchObject({ reasoningEffort: "low", effortAdjustment: { from: "off", to: "low" } });
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
