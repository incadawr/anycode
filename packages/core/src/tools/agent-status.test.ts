import { describe, expect, it } from "vitest";
import { agentTool } from "./agent.js";
import { agentStatusTool } from "./agent-status.js";
import { inlineChildStatusStore } from "../subagents/status.js";
import { ModePermissionEngine } from "../permissions/engine.js";
import type { ToolContext } from "../types/tools.js";
import type { SubagentPort, SubagentRunOptions } from "../ports/subagent.js";
import type { CorePorts } from "../ports/index.js";

function context(port: SubagentPort): ToolContext {
  return { toolCallId: "child-call", cwd: "/work", abortSignal: new AbortController().signal, ports: {} as CorePorts, subagents: port };
}

describe("AgentStatus", () => {
  it("reports a live inline child, approval, bounded tail and terminal state only to its owner", async () => {
    let options!: SubagentRunOptions;
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const port: SubagentPort = { run: async (_req, opts) => { options = opts; await gate; return { status: "completed", finalText: "done", truncated: false, turns: 3, toolCalls: 2, durationMs: 10 }; } };
    const ctx = context(port);
    const pending = agentTool.handler({ description: "inspect", prompt: "go" }, ctx);
    options.onProgress?.({ kind: "progress", turns: 2, toolCalls: 1 });
    options.onApproval?.(true);
    for (let i = 0; i < 12; i++) options.onStatusItem?.({ kind: "tool", text: `action ${i} ` + "word ".repeat(100) }, "Read");
    const result = await agentStatusTool.handler({ id: "child-call" }, ctx);
    expect(result.ok).toBe(true);
    const child = result.output!.children[0]!;
    expect(child).toMatchObject({ id: "child-call", state: "waiting for approval", turns: 2, toolCalls: 1, currentTool: "Read" });
    expect(child.tail).toHaveLength(8);
    expect(child.tail[0]!.text).toContain("action 4");
    expect(child.tail.every((item) => Array.from(item.text).length <= 160)).toBe(true);
    const other = context({ run: port.run });
    expect((await agentStatusTool.handler({ id: "child-call" }, other)).ok).toBe(false);
    expect((await agentStatusTool.handler({}, other)).output?.children).toEqual([]);
    finish(); await pending;
    expect((await agentStatusTool.handler({ id: "child-call" }, ctx)).output?.children[0]).toMatchObject({ state: "completed", turns: 3, toolCalls: 2 });
  });


  it("pages retained children and discloses when older records were discarded", async () => {
    const port: SubagentPort = { run: async () => { throw new Error("unused"); } };
    const ctx = context(port);
    const store = inlineChildStatusStore(port);
    for (let i = 0; i < 65; i++) {
      store.start(`child-${i}`, "inspect");
      store.update(`child-${i}`, { state: "completed", endedAt: Date.now() });
    }
    const first = (await agentStatusTool.handler({}, ctx)).output!;
    expect(first).toMatchObject({ total: 64, next_offset: 20, older_discarded: 1 });
    expect(first.children).toHaveLength(20);
    expect(first.children[0]?.id).toBe("child-1");
    const last = (await agentStatusTool.handler({ offset: 60 }, ctx)).output!;
    expect(last.children).toHaveLength(4);
    expect(last.next_offset).toBeUndefined();
  });


  it("redacts credentials and retains the latest assistant text", async () => {
    const port: SubagentPort = { run: async () => { throw new Error("unused"); } };
    const store = inlineChildStatusStore(port);
    store.start("c", "inspect --password=hunter2");
    store.append("c", { kind: "assistant", text: "early ".repeat(40) + "latest progress --token=shortsecret" });
    const child = (await agentStatusTool.handler({ id: "c" }, context(port))).output!.children[0]!;
    expect(child.description).not.toContain("hunter2");
    expect(child.tail[0]!.text).toContain("latest progress");
    expect(child.tail[0]!.text).not.toContain("shortsecret");
    expect(child.tail[0]!.text).toContain("[redacted]");
  });

  it("documents when foreground children can be polled", () => {
    expect(agentStatusTool.metadata.description).toContain("a parent blocked on a foreground child cannot poll until it returns or hands off");
  });

  it.each([
    ['{"password":"hunter2"}', "hunter2"],
    ["Authorization: Bearer secondsecret", "secondsecret"],
    ["Authorization: Basic dXNlcjpwYXNz", "dXNlcjpwYXNz"],
    ['{"password":"first second', "second"],
    ['--password="first second"', "second"],
  ])("scrubs %s through the inline child path", async (credential, secret) => {
    const port: SubagentPort = { run: async (_req, opts) => {
      opts.onStatusItem?.({ kind: "assistant", text: `Progress ${credential}` });
      return { status: "completed", finalText: "done", truncated: false, turns: 1, toolCalls: 0, durationMs: 1 };
    } };
    const ctx = context(port);
    await agentTool.handler({ description: "inspect", prompt: "go" }, ctx);
    const text = JSON.stringify((await agentStatusTool.handler({ id: "child-call" }, ctx)).output);
    expect(text).toContain("Progress");
    expect(text).not.toContain(secret);
  });

  it("is allowed without an approval in every mode", () => {
    const engine = new ModePermissionEngine();
    for (const mode of ["plan", "build", "edit", "auto", "yolo"] as const) {
      expect(engine.check({ mode, toolName: "AgentStatus", metadata: agentStatusTool.metadata, input: {} }).decision).toBe("allow");
    }
    expect(agentStatusTool.metadata).toMatchObject({ readOnly: true, needsApproval: false, sideEffectScope: "none" });
  });
});
