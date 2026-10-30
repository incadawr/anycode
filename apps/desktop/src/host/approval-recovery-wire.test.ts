import { MessageChannel, type MessagePort } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { SessionPermissionRules } from "@anycode/core";
import type { HostToUiMessage, UiToHostMessage } from "../shared/protocol.js";
import { createDesktopStore } from "../renderer/src/store.js";
import { IpcPermissionBroker } from "./permission-broker.js";
import { Outbound, Session } from "./session.js";
import { MemFs, nodeWirePort } from "./test-harness.js";
import { ClaudeApprovalBridge } from "./engines/claude/approval-bridge.js";
import { ClaudeEngine, type ClaudeTransport } from "./engines/claude/claude-engine.js";
import { CodexApprovalBridge } from "./engines/codex/approval-bridge.js";
import { CodexEngine, type CodexClient } from "./engines/codex/codex-engine.js";

for (const kind of ["claude", "codex"] as const) {
  it(`${kind} preserves a real deadline on reconnect and prompts after recovery`, async () => {
    const outbound = new Outbound();
    const broker = new IpcPermissionBroker((message) => outbound.emit(message), 100);
    const claude = new ClaudeApprovalBridge({ broker, activePresetId: () => "ask" });
    const codex = new CodexApprovalBridge({ broker, activeTurn: () => ({ threadId: "thread", turnId: "turn" }) });
    const stream = { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<never>>(() => {}) }) };
    const engine = kind === "claude"
      ? new ClaudeEngine({ notifications: () => stream, close: async () => {} } as unknown as ClaudeTransport, "native", claude)
      : new CodexEngine({ close: async () => {} } as unknown as CodexClient, "thread", codex);
    const channel = new MessageChannel();
    const messages: HostToUiMessage[] = [];
    channel.port1.on("message", (message: HostToUiMessage) => messages.push(message));
    channel.port1.start();
    const session = new Session({ outbound, engine, broker, fs: new MemFs(), workspace: "/workspace", model: "native", sessionId: "session", rules: new SessionPermissionRules() });
    session.bindPort(nodeWirePort(channel.port2 as MessagePort));
    const send = (message: UiToHostMessage) => channel.port1.postMessage(message);
    const wait = async (predicate: () => boolean) => {
      const until = Date.now() + 3000;
      while (!predicate()) {
        if (Date.now() > until) throw new Error("timed out waiting for host message");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    };
    const ask = () => kind === "claude"
      ? claude.handle({ requestId: "control", subtype: "can_use_tool", request: { tool_name: "Bash", tool_use_id: "tool", input: { command: "ls" } }, signal: new AbortController().signal }, { success: vi.fn(), error: vi.fn() })
      : codex.handle({ id: "rpc", method: "item/commandExecution/requestApproval", params: { threadId: "thread", turnId: "turn", itemId: "item", command: "ls" } }, { result: vi.fn(), error: vi.fn() });
    try {
      send({ type: "ui_ready" });
      await wait(() => messages.some((message) => message.type === "host_ready"));
      const first = ask();
      await wait(() => messages.some((message) => message.type === "permission_settled" && message.origin === "timeout"));
      await first;
      const recoveryAt = messages.length;
      send({ type: "approval_recover" });
      await wait(() => messages.slice(recoveryAt).some((message) => message.type === "approval_state" && !message.unattended));
      const count = messages.filter((message) => message.type === "permission_request").length;
      const second = ask();
      await wait(() => messages.filter((message) => message.type === "permission_request").length > count);
      const original = messages.filter((message) => message.type === "permission_request").at(-1)!;
      if (original.type !== "permission_request") throw new Error("missing request");
      expect(original.deadline).toEqual(expect.any(Number));
      const before = messages.length;
      send({ type: "ui_ready" });
      await wait(() => messages.slice(before).some((message) => message.type === "approval_state"));
      const fresh = createDesktopStore();
      for (const message of messages.slice(before)) fresh.getState().applyHostMessage(message);
      expect(fresh.getState().permission?.deadline).toBe(original.deadline);
      send({ type: "permission_response", requestId: original.requestId, behavior: "deny" });
      await second;
    } finally {
      channel.port1.close(); channel.port2.close();
      await session.shutdown();
    }
  });
}
