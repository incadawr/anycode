import { describe, expect, it, vi } from "vitest";
import { createSessionPeerTools, type ConnectionTargets } from "@anycode/core";
import { CodexDynamicToolBridge } from "./codex/dynamic-tool-bridge.js";
import { createBridgePresentationStamp } from "./claude/bridge-presentation-stamp.js";

async function bridge(engine: "codex" | "claude") {
  const { createConnectionTargetsBridge } = await import("./connection-targets-bridge.js");
  const read = vi.fn(() => ({ current: { engine, model: `${engine}-own-model`, connectionId: "wrong-api", token: "SECRET" },
    connections: [{ id: "api", providerId: "test", readiness: "unknown", models: [], apiKey: "SECRET" }],
  } as unknown as ConnectionTargets));
  return { read, connections: createConnectionTargetsBridge(read) };
}

describe("native connection catalog", () => {
  it("Codex declares and calls the catalog without profiles, browser or child port", async () => {
    const { read, connections } = await bridge("codex");
    const door = new CodexDynamicToolBridge([], undefined, undefined, undefined, undefined, undefined, undefined, connections);
    expect(door.declarations()).toEqual([expect.objectContaining({ name: "anycode_list_connections" })]);
    const respond = { result: vi.fn(), error: vi.fn() };
    const active = { threadId: "t", turnId: "u" };
    const request = { id: 1, method: "item/tool/call", params: { ...active, callId: "c", tool: "anycode_list_connections", arguments: {} } };
    await door.handle(request, respond, active, () => {});
    expect(respond.result.mock.calls[0]![0]).toMatchObject({ success: true });
    const text = JSON.stringify(respond.result.mock.calls);
    expect(text).toContain("codex-own-model");
    expect(text).not.toMatch(/SECRET|wrong-api/);
    for (const params of [{ ...request.params, callId: "d", turnId: "old" }, { ...request.params, callId: "d", tool: "unknown" },
      { ...request.params, callId: "d", namespace: "foreign" }, request.params]) {
      await door.handle({ ...request, params }, respond, active, () => {});
      expect(respond.result.mock.lastCall![0]).toMatchObject({ success: false });
    }
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("Claude declares and calls the same catalog while restricted, with no profiles", async () => {
    const { read, connections } = await bridge("claude");
    const door = createBridgePresentationStamp({ catalog: [], resolveCallCatalog: async () => [], onEvent: () => {}, restricted: () => true, connections });
    expect(door.listTools()).toEqual([expect.objectContaining({ name: "list_connections" })]);
    const result = await door.callTool("list_connections", {}, new AbortController().signal, { toolUseId: "c" });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("claude-own-model");
    expect(result.text).not.toMatch(/SECRET|wrong-api/);
    for (const [name, args, signal, meta] of [
      ["unknown", {}, new AbortController().signal, { toolUseId: "u" }],
      ["list_connections", { token: "SECRET" }, new AbortController().signal, { toolUseId: "v" }],
      ["list_connections", {}, AbortSignal.abort(), { toolUseId: "w" }],
      ["list_connections", {}, new AbortController().signal, {}],
    ] as const) expect((await door.callTool(name, args, signal, meta)).isError).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("Codex Stop refuses a read that settles after cancellation", async () => {
    const { connections } = await bridge("codex");
    const door = new CodexDynamicToolBridge([], undefined, undefined, undefined, undefined, undefined, undefined, connections);
    const respond = { result: vi.fn(), error: vi.fn() };
    const active = { threadId: "t", turnId: "u" };
    const pending = door.handle({ id: 1, method: "item/tool/call", params: { ...active, callId: "c", tool: "anycode_list_connections", arguments: {} } }, respond, active, () => {});
    door.cancel();
    await pending;
    expect(respond.result.mock.lastCall![0]).toMatchObject({ success: false });
    expect(JSON.stringify(respond.result.mock.calls)).not.toContain("codex-own-model");
  });

  it.each(["codex", "claude"] as const)("%s keeps peer dispatch separate from catalog reads", async engine => {
    const { connections, read } = await bridge(engine);
    const peers = {
      tools: createSessionPeerTools(() => ({ mode: "build" })),
      call: vi.fn(async (_name: string, _raw: unknown, _signal: AbortSignal, _id: string) => ({ ok: false as const, error: "Peer access refused" })),
    };
    const signal = new AbortController().signal;
    if (engine === "codex") {
      const door = new CodexDynamicToolBridge([], undefined, undefined, undefined, undefined, undefined, peers, connections);
      expect(door.declarations().map(d => d.name)).toEqual([
        "anycode_sessions_list", "anycode_session_open", "anycode_session_send", "anycode_who_edits", "anycode_list_connections",
      ]);
      const active = { threadId: "t", turnId: "u" };
      const respond = { result: vi.fn(), error: vi.fn() };
      for (const [callId, tool] of [["read", "anycode_list_connections"], ["peer", "anycode_session_send"]]) {
        await door.handle({ id: 1, method: "item/tool/call", params: { ...active, callId, tool, arguments: {} } }, respond, active, () => {});
      }
      expect(respond.result.mock.calls.map(([r]) => r.success)).toEqual([true, false]);
    } else {
      const door = createBridgePresentationStamp({ catalog: [], resolveCallCatalog: async () => [], onEvent: () => {}, peers, connections });
      expect(door.listTools().map(d => d.name)).toEqual([
        "sessions_list", "session_open", "session_send", "who_edits", "list_connections",
      ]);
      expect((await door.callTool("list_connections", {}, signal, { toolUseId: "read" })).isError).toBe(false);
      expect((await door.callTool("session_send", {}, signal, { toolUseId: "peer" })).isError).toBe(true);
    }
    expect(read).toHaveBeenCalledTimes(1);
    expect(peers.call).toHaveBeenCalledTimes(1);
    expect(peers.call.mock.calls[0]?.[0]).toBe("SessionSend");
  });

  it("bounds output, sanitizes failures and refuses aborted or malformed reads", async () => {
    const { connections, read } = await bridge("codex");
    for (const args of [null, [], { token: "SECRET" }]) expect((await connections.call(args, new AbortController().signal)).isError).toBe(true);
    expect((await connections.call({}, AbortSignal.abort())).isError).toBe(true);
    expect(read).not.toHaveBeenCalled();
    read.mockImplementation(() => { throw new Error("SECRET"); });
    expect(await connections.call({}, new AbortController().signal)).toMatchObject({ isError: true, text: expect.not.stringContaining("SECRET") });
  });
});
