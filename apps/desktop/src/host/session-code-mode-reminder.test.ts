import { MessageChannel } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { CODE_MODE_REMINDER, SessionPermissionRules, type AgentEvent, type PermissionMode } from "@anycode/core";
import { stripReminderBlocks } from "../renderer/src/transcript-sanitize.js";
import type { HostToUiMessage } from "../shared/protocol.js";
import type { SessionEngine } from "./engines/session-engine.js";
import { IpcPermissionBroker } from "./permission-broker.js";
import { Outbound, Session } from "./session.js";
import { createHarness, MemFs, nodeWirePort } from "./test-harness.js";

const isHostReady = (m: HostToUiMessage): m is Extract<HostToUiMessage, { type: "host_ready" }> => m.type === "host_ready";
const REMINDER = `<system-reminder>\n${CODE_MODE_REMINDER}\n</system-reminder>`;
const CAPS = {
  supportsCorePermissions: true, supportsRewind: true, supportsWorkflow: true, supportsGitMutations: true,
  supportsContextUsage: true, supportsContextBreakdown: true, supportsInteractiveApprovals: true,
  costAccounting: true, supportsModelSelection: true, supportsReasoningEffort: true, supportsImages: true,
  supportsTasks: true, supportsFileSnapshots: true, supportsManualCompact: true,
};

function engineOf(id: "core" | "codex", inputs: string[], initialMode: PermissionMode = "build"): SessionEngine {
  let mode = initialMode;
  return {
    id,
    capabilities: id === "core" ? CAPS : { ...CAPS, supportsCorePermissions: false },
    mode: () => mode,
    setMode: (next: PermissionMode) => { mode = next; },
    reasoningEffort: () => undefined,
    setReasoningEffort: () => {},
    async *runTurn(input: string): AsyncIterable<AgentEvent> {
      inputs.push(input);
      yield { type: "turn_end", turn: 1, finishReason: "stop" };
    },
    historyItems: () => [],
    dispose: async () => {},
  } as SessionEngine;
}

async function turn(h: ReturnType<typeof createHarness>, requestId: string, text: string): Promise<void> {
  const before = h.received.filter((m) => m.type === "agent_event" && m.event.type === "turn_end").length;
  h.send({ type: "user_message", requestId, text });
  await h.waitUntil(() => h.received.filter((m) => m.type === "agent_event" && m.event.type === "turn_end").length > before);
  await h.flush();
}

const count = (text: string, needle: string): number => text.split(needle).length - 1;

describe("Session — Code Mode user-turn reminder", () => {
  it("appends exactly one reminder per turn when REPL is offered on the core engine", async () => {
    const inputs: string[] = [];
    const h = createHarness({ steps: [], engine: engineOf("core", inputs), codeModeReminderActive: () => true });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);
      await turn(h, "r1", "find the bug");
      await turn(h, "r2", "and fix it");
      expect(inputs).toEqual([`find the bug\n${REMINDER}`, `and fix it\n${REMINDER}`]);
      expect(inputs.every((i) => count(i, "<system-reminder>") === 1)).toBe(true);
    } finally { h.close(); }
  });

  it("adds nothing when Code Mode is off or the gate is absent", async () => {
    for (const gate of [() => false, undefined]) {
      const inputs: string[] = [];
      const h = createHarness({ steps: [], engine: engineOf("core", inputs), ...(gate ? { codeModeReminderActive: gate } : {}) });
      try {
        h.send({ type: "ui_ready" });
        await h.waitFor(isHostReady);
        await turn(h, "r1", "hello");
        expect(inputs).toEqual(["hello"]);
      } finally { h.close(); }
    }
  });

  it("follows the live REPL check between turns", async () => {
    const inputs: string[] = [];
    let on = true;
    const h = createHarness({ steps: [], engine: engineOf("core", inputs), codeModeReminderActive: () => on });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);
      await turn(h, "r1", "one");
      on = false;
      await turn(h, "r2", "two");
      expect(inputs).toEqual([`one\n${REMINDER}`, "two"]);
    } finally { h.close(); }
  });

  it("does not touch Codex or Claude style engines", async () => {
    const inputs: string[] = [];
    const h = createHarness({ steps: [], engine: engineOf("codex", inputs), codeModeReminderActive: () => true });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);
      await turn(h, "r1", "hello");
      expect(inputs).toEqual(["hello"]);
    } finally { h.close(); }
  });

  it("stacks plan reminder, then Code Mode reminder, one of each", async () => {
    const inputs: string[] = [];
    const h = createHarness({ steps: [], engine: engineOf("core", inputs, "plan"), codeModeReminderActive: () => true });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);
      await turn(h, "r1", "plan it");
      expect(inputs).toHaveLength(1);
      const input = inputs[0]!;
      expect(count(input, CODE_MODE_REMINDER)).toBe(1);
      expect(count(input, "<plan-mode-reminder>")).toBe(1);
      expect(count(input, "<system-reminder>")).toBe(1);
      expect(input.indexOf("<plan-mode-reminder>")).toBeLessThan(input.indexOf("<system-reminder>"));
      expect(input.startsWith("plan it\n")).toBe(true);
      expect(input.endsWith(REMINDER)).toBe(true);
      expect(stripReminderBlocks(input).trim()).toBe("plan it");
    } finally { h.close(); }
  });

  it("adds the reminder for a child session with REPL", async () => {
    const inputs: string[] = [];
    const channel = new MessageChannel();
    const received: HostToUiMessage[] = [];
    channel.port1.on("message", (m: unknown) => { received.push(m as HostToUiMessage); });
    channel.port1.start();
    const outbound = new Outbound();
    const broker = new IpcPermissionBroker((m: HostToUiMessage) => outbound.emit(m));
    const session = new Session({
      outbound, engine: engineOf("core", inputs), broker, fs: new MemFs(), workspace: "/workspace",
      projectRoot: "/workspace", model: "m", sessionId: "child", rules: new SessionPermissionRules(),
      persistence: { touch() {} },
      codeModeReminderActive: () => true,
      child: { onReady() {}, flushHistory: async () => {}, onTerminal() {}, onProgress() {}, now: () => 0 },
    });
    session.bindPort(nodeWirePort(channel.port2));
    try {
      channel.port1.postMessage({ type: "ui_ready" });
      await new Promise((r) => setTimeout(r, 20));
      channel.port1.postMessage({ type: "user_message", requestId: "r1", text: "child task" });
      for (let i = 0; i < 100 && inputs.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
      expect(inputs).toEqual([`child task\n${REMINDER}`]);
    } finally { channel.port1.close(); channel.port2.close(); }
  });

  it("the visible transcript text drops the reminder", () => {
    expect(stripReminderBlocks(`find it\n${REMINDER}`)).toBe("find it");
  });
});
