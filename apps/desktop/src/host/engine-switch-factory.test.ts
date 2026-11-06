import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentLoop, ConversationHistory, SessionPermissionRules } from "@anycode/core";
import { createSwitchEngineFactory, type SwitchEngineFactoryContext } from "./engine-switch-factory.js";
import { buildClaudeLaunchOptions, buildCodexLaunchOptions, buildCoreLaunchOptions } from "./engine-launch-options.js";
import { IpcPermissionBroker } from "./permission-broker.js";
import { createHarness, finishStep, MemFs, ScriptedModelPort } from "./test-harness.js";

const executable = fileURLToPath(new URL("./engine-switch-fixtures/native-double.mjs", import.meta.url));
const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function context() {
  const dir = mkdtempSync(join(tmpdir(), "engine-switch-"));
  directories.push(dir);
  const broker = new IpcPermissionBroker(() => {});
  const common = {
    workspace: dir, binaryPath: process.execPath, sourceEnv: { HOME: dir },
    binaryTrust: () => null, broker,
  };
  const cleanup = vi.fn();
  const ctx: SwitchEngineFactoryContext = {
    engineSwitchEnabled: true, workspace: dir, sessionId: "logical-session",
    resolveCore: vi.fn(async () => undefined),
    resolveCodex: vi.fn(async () => ({ options: {
      ...buildCodexLaunchOptions({ ...common, fs: new MemFs(), rules: new SessionPermissionRules(), profile: null, forwardOptions: {} }),
      binaryArgs: [executable, `--double-log=${join(dir, "codex.log")}`],
      selection: { presetId: "read-only", origin: "draft" as const },
    }, cleanup })),
    resolveClaude: vi.fn(async () => ({ options: {
      ...buildClaudeLaunchOptions({ ...common, projectTrusted: false, mcpConfigPath: null, bootNotices: [], agentCatalogNonEmpty: false }),
      binaryArgs: [executable, "--double-claude", `--double-log=${join(dir, "claude.log")}`],
      selection: { presetId: "read-only", origin: "draft" as const },
    }, cleanup })),
  };
  return { ctx, dir, cleanup };
}

describe("host switch engine factory", () => {
  it.each(["codex", "claude"] as const)("starts %s through the real transport with the selected model", async engine => {
    const { ctx, dir, cleanup } = context();
    const factory = createSwitchEngineFactory(ctx)!;
    const runtime = await factory(engine, "model-chosen");
    expect("engine" in runtime).toBe(true);
    if (!("engine" in runtime)) throw new Error("missing runtime");
    try {
      expect(runtime.engine.id).toBe(engine);
      expect(runtime.engineSettings?.snapshot().model).toBe("model-chosen");
      const messages = readFileSync(join(dir, `${engine}.log`), "utf8").trim().split("\n").map(line => JSON.parse(line));
      if (engine === "codex") expect(messages.find(message => message.method === "thread/start").params.model).toBe("model-chosen");
      else expect(messages.find(message => message.request?.subtype === "set_model").request.model).toBe("model-chosen");
      expect(engine === "codex" ? ctx.resolveCodex : ctx.resolveClaude).toHaveBeenCalledWith({ workspace: dir, sessionId: "logical-session", model: "model-chosen" });
      expect(cleanup).not.toHaveBeenCalled();
    } finally { await runtime.engine.dispose("session-close"); }
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("receives the chosen model from Session and leaves the source usable after rejection", async () => {
    const { ctx } = context();
    const h = createHarness({ steps: [finishStep()], switchEngineFactory: createSwitchEngineFactory(ctx) });
    try {
      h.send({ type: "ui_ready" });
      await h.waitUntil(() => h.received.some(m => m.type === "host_ready"));
      h.send({ type: "engine_switch_request", requestId: "bad-model", engine: "codex", model: "unsupported" });
      await h.waitUntil(() => h.received.some(m => m.type === "engine_switch_failed" && m.requestId === "bad-model"));
      h.send({ type: "user_message", requestId: "source-turn", text: "still here" });
      await h.waitUntil(() => h.received.some(m => m.type === "agent_event" && m.event.type === "loop_end"));
      h.send({ type: "engine_switch_request", requestId: "chosen", engine: "codex", model: "model-chosen" });
      await h.waitUntil(() => h.received.some(m => m.type === "engine_switched" && m.requestId === "chosen"));
      expect(ctx.resolveCodex).toHaveBeenLastCalledWith(expect.objectContaining({ model: "model-chosen" }));
    } finally { await h.session.shutdown(); h.close(); }
  });

  it("builds a fresh core loop using only the resolved connection's model port", async () => {
    const { ctx } = context();
    const h = createHarness({ steps: [] });
    const port = new ScriptedModelPort([finishStep()]);
    ctx.resolveCore = async ({ model }) => {
      if (model !== "model-chosen") return undefined;
      const config = { ...h.config, modelPort: port, history: new ConversationHistory(), mode: "plan" as const };
      return { model, options: buildCoreLaunchOptions({ config, loop: new AgentLoop(config) }) };
    };
    const runtime = await createSwitchEngineFactory(ctx)!("core", "model-chosen");
    if (!("engine" in runtime)) throw new Error("missing runtime");
    try {
      expect(runtime.engine.id).toBe("core");
      expect(runtime.engine.historyItems()).toEqual([]);
      for await (const _ of runtime.engine.runTurn("hello", { signal: new AbortController().signal })) { /* drain */ }
      expect(port.requests).toHaveLength(1);
      expect(h.engine.historyItems()).toEqual([]);
    } finally { await runtime.engine.dispose("session-close"); h.close(); }
  });

  it.each([undefined, false])("keeps the unavailable-host refusal when enabled=%s", async enabled => {
    const { ctx } = context();
    ctx.engineSwitchEnabled = enabled;
    const factory = createSwitchEngineFactory(ctx);
    expect(factory).toBeUndefined();
    const h = createHarness({ steps: [], switchEngineFactory: factory });
    try {
      h.send({ type: "ui_ready" });
      await h.waitUntil(() => h.received.some(m => m.type === "host_ready"));
      h.send({ type: "engine_switch_request", requestId: "off", engine: "codex", model: "model-chosen" });
      await h.waitUntil(() => h.received.some(m => m.type === "engine_switch_failed"));
      expect(h.received).toContainEqual({ type: "engine_switch_failed", requestId: "off", reason: "engine switch is not available in this host" });
      expect(ctx.resolveCodex).not.toHaveBeenCalled();
    } finally { h.close(); }
  });

  it.each(["core", "codex", "claude"] as const)("rejects unsupported %s models and releases candidate resources", async engine => {
    const { ctx, cleanup } = context();
    await expect(createSwitchEngineFactory(ctx)!(engine, "unsupported")).rejects.toThrow(/unavailable/);
    expect(cleanup).toHaveBeenCalledTimes(engine === "core" ? 0 : 1);
  });

  it("rejects malformed selections before privileged resolution", async () => {
    const { ctx } = context();
    await expect(createSwitchEngineFactory(ctx)!("codex", "")).rejects.toThrow("Invalid engine switch selection");
    expect(ctx.resolveCodex).not.toHaveBeenCalled();
  });

  it("does not infer a core connection when the host cannot resolve one", async () => {
    const { ctx } = context();
    await expect(createSwitchEngineFactory(ctx)!("core", "model-chosen")).rejects.toThrow("unavailable for core");
  });
});
