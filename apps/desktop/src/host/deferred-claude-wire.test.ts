import { expect, it } from "vitest";
import { MessageChannel, type MessagePort as NodeMessagePort } from "node:worker_threads";
import { SessionPermissionRules } from "@anycode/core";
import type { HostToUiMessage, UiToHostMessage } from "../shared/protocol.js";
import { IpcPermissionBroker } from "./permission-broker.js";
import { Outbound, Session } from "./session.js";
import { ClaudeEngine, type ClaudeTransport } from "./engines/claude/claude-engine.js";
import { ClaudeModelCatalog } from "./engines/claude/models.js";
import { findClaudePreset } from "./engines/claude/presets.js";
import { ClaudeSettingsSeam } from "./engines/claude/settings-seam.js";
import type { ClaudeStreamMessage } from "./engines/claude/protocol.js";
import { MemFs, nodeWirePort } from "./test-harness.js";

class Transport implements ClaudeTransport {
  readonly inputs: Array<{ input: string | unknown[]; effort: string | undefined }> = [];
  readonly controls: Array<{ subtype: string; request?: Record<string, unknown> }> = [];
  effort: string | undefined;
  private resolveControl: ((value: unknown) => void) | undefined;
  private queue: ClaudeStreamMessage[] = [];
  private waiter: ((result: IteratorResult<ClaudeStreamMessage>) => void) | undefined;
  async initialize() { return { commands: [], models: [], account: { tokenSource: "oauth" } }; }
  controlRequest<T>(subtype: string, request?: Record<string, unknown>): Promise<T> {
    this.controls.push({ subtype, request });
    return new Promise((resolve) => { this.resolveControl = (value) => resolve(value as T); });
  }
  acceptControl(): void {
    const resolve = this.resolveControl;
    if (!resolve) throw new Error("no control request");
    this.resolveControl = undefined;
    this.effort = this.controls.at(-1)?.request?.effortLevel as string;
    resolve({});
  }
  async getContextUsage(): Promise<Record<string, unknown>> { return {}; }
  async interrupt() { return { stillQueued: [] }; }
  sendUserMessage(input: string | unknown[]): void { this.inputs.push({ input, effort: this.effort }); }
  finish(): void {
    const value = { type: "result", subtype: "success", terminal_reason: "completed" } as unknown as ClaudeStreamMessage;
    if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; waiter({ value, done: false }); }
    else this.queue.push(value);
  }
  notifications(): AsyncIterable<ClaudeStreamMessage> {
    return { [Symbol.asyncIterator]: () => ({ next: () => {
      const value = this.queue.shift();
      return value ? Promise.resolve({ value, done: false }) : new Promise((resolve) => { this.waiter = resolve; });
    } }) };
  }
  async close(): Promise<void> {}
}

it("waits for Claude's acknowledged effort control before sending the next input", async () => {
  const transport = new Transport();
  const catalog = ClaudeModelCatalog.fromInitialize([
    { value: "model-a", supportsEffort: true, supportedEffortLevels: ["medium", "high", "xhigh"] },
    { value: "plain" },
  ]);
  const engine = new ClaudeEngine(transport, "session", undefined, { catalog, model: "model-a", preset: findClaudePreset("ask")!, effortsByModel: new Map(), notices: [] });
  const seam = new ClaudeSettingsSeam(engine);
  const channel = new MessageChannel();
  const received: HostToUiMessage[] = [];
  channel.port1.on("message", (message: HostToUiMessage) => received.push(message));
  channel.port1.start();
  const outbound = new Outbound();
  const session = new Session({ outbound, engine, engineSettings: seam, broker: new IpcPermissionBroker((message) => outbound.emit(message)), fs: new MemFs(), workspace: "/work", model: "model-a", sessionId: "session", rules: new SessionPermissionRules() });
  session.bindPort(nodeWirePort(channel.port2 as NodeMessagePort));
  const send = (message: UiToHostMessage) => channel.port1.postMessage(message);
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
  try {
    send({ type: "ui_ready" });
    send({ type: "user_message", requestId: "a", text: "first" });
    await settle();
    expect(transport.inputs).toHaveLength(1);
    send({ type: "set_engine_effort", effort: "high" });
    send({ type: "set_engine_effort", effort: "xhigh" });
    send({ type: "set_engine_effort", effort: "unsupported" });
    await settle();
    expect(transport.controls).toHaveLength(0);
    expect(received).toContainEqual(expect.objectContaining({ type: "mode_change_rejected" }));
    expect(received).toContainEqual(expect.objectContaining({ type: "engine_settings_changed", state: "pending", effort: "xhigh" }));
    transport.finish();
    await settle();
    expect(transport.controls).toEqual([{ subtype: "apply_flag_settings", request: { effortLevel: "xhigh" } }]);
    send({ type: "ui_ready" });
    send({ type: "user_message", requestId: "b", text: "second" });
    await settle();
    expect(transport.inputs).toHaveLength(1);
    transport.acceptControl();
    await settle();
    expect(transport.inputs).toHaveLength(2);
    expect(transport.inputs[1]?.effort).toBe("xhigh");
    expect(received).toContainEqual(expect.objectContaining({ type: "engine_settings_changed", state: "applied", effort: "xhigh" }));
    transport.finish();
    await settle();
    send({ type: "set_model", model: "plain" });
    await settle();
    expect(transport.controls.at(-1)).toEqual({ subtype: "set_model", request: { model: "plain" } });
    transport.acceptControl();
    await settle();
    send({ type: "user_message", requestId: "c", text: "third" });
    await settle();
    const controls = transport.controls.length;
    send({ type: "set_engine_effort", effort: "high" });
    await settle();
    expect(transport.controls).toHaveLength(controls);
    expect(received).toContainEqual(expect.objectContaining({ type: "mode_change_rejected", reason: expect.stringContaining("plain") }));
    transport.finish();
    await settle();
  } finally { channel.port1.close(); channel.port2.close(); await session.shutdown(); }
});
