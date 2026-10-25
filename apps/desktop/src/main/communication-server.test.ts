import { mkdtemp, writeFile, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createNetServer } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client, StreamableHTTPClientTransport, StdioClientTransport } from "@anycode/core/communication-mcp";
import { startCommunicationServer } from "./communication-server.js";
import type { AgentEnvelope } from "../shared/communication.js";
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "anycode-communication-")); cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const configFile = join(dir, "config.json"); const discoveryFile = join(dir, "endpoint.json");
  await writeFile(configFile, JSON.stringify({ workspaces: [dir], discoveryFile }));
  const request = vi.fn(async (_session: string, op: string, payload?: unknown) => {
    if (op === "send_message") return { envelope: payload, state: "queued" };
    if (op === "get_session_status") return { engine: "codex", state: "idle" };
    if (op === "get_session_result") return { availability: "available", latestResult: { publicAnswer: "PUBLIC_ANSWER", terminalReason: "completed", turnId: "host-turn" } };
    return undefined;
  });
  const manager = { listTabs: () => [{ sessionId: "allowed", workspace: dir, state: "running", pid: 10 }, { sessionId: "forbidden", workspace: tmpdir(), state: "running", pid: 11 }], communicationRequest: request };
  const service = await startCommunicationServer({ manager, configFile, userData: dir }); cleanups.push(() => service.close());
  const discovery = JSON.parse(await readFile(discoveryFile, "utf8")) as { url: string; token: string };
  const client = new Client({ name: "supervisor-test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(discovery.url), { requestInit: { headers: { Authorization: `Bearer ${discovery.token}` } } }));
  cleanups.push(() => client.close());
  return { dir, discoveryFile, configFile, client, manager, request, service, discovery };
}
function value(result: unknown): any { return JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text); }
describe("production communication MCP over real SDK HTTP", () => {
  it("connects a portable stdio MCP client through the discovery-file adapter", async () => {
    const f = await fixture();
    const client = new Client({ name: "portable-supervisor", version: "1" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../../../../examples/agent-communication/stdio.mjs", import.meta.url)), f.discoveryFile] }));
    cleanups.push(() => client.close());
    expect((await client.listTools()).tools).toHaveLength(5);
    expect(value(await client.callTool({ name: "get_session_status", arguments: { sessionId: "allowed" } })).engine).toBe("codex");
  });
  it("initializes, lists/calls tools and enforces auth, origin and workspace scope", async () => {
    const f = await fixture();
    expect((await f.client.listTools()).tools.map((t) => t.name)).toEqual(["list_sessions", "get_session_status", "get_session_result", "send_message", "get_message_status"]);
    expect(value(await f.client.callTool({ name: "list_sessions", arguments: {} })).sessions.map((s: { sessionId: string }) => s.sessionId)).toEqual(["allowed"]);
    expect(value(await f.client.callTool({ name: "get_session_status", arguments: { sessionId: "allowed" } })).state).toBe("idle");
    expect((await f.client.callTool({ name: "send_message", arguments: { sessionId: "forbidden", payload: "no", mode: "next_turn" } })).isError).toBe(true);
    expect((await f.client.callTool({ name: "send_message", arguments: { sessionId: "allowed", payload: "no", mode: "next_turn", sender: "system" } })).isError).toBe(true);
    expect(value(await f.client.callTool({ name: "get_session_result", arguments: { sessionId: "allowed" } })).latestResult.publicAnswer).toBe("PUBLIC_ANSWER");
    expect((await f.client.callTool({ name: "get_session_result", arguments: { sessionId: "forbidden" } })).isError).toBe(true);
    expect(await stat(f.discoveryFile).then((s) => s.mode & 0o777)).toBe(0o600);
    expect((await fetch(f.discovery.url, { method: "POST" })).status).toBe(401);
    expect((await fetch(f.discovery.url, { method: "POST", headers: { Authorization: `Bearer ${f.discovery.token}`, Origin: "http://localhost" } })).status).toBe(403);
    expect(f.request.mock.calls.filter((c) => c[1] === "send_message")).toHaveLength(0);
  });
  it("persists before dispatch, stamps identity, and deduplicates retries without replay", async () => {
    const f = await fixture();
    f.request.mockImplementation(async (_session, op, payload) => {
      if (op !== "send_message") return undefined;
      const saved = JSON.parse(await readFile(`${f.discoveryFile}.messages`, "utf8"));
      expect(saved[0].envelope.messageId).toBe((payload as AgentEnvelope).messageId);
      return { envelope: payload, state: "acknowledged", detail: "transport accepted" };
    });
    const input = { sessionId: "allowed", payload: "Please preserve running child", mode: "steer", idempotencyKey: "clarification-1" };
    const first = value(await f.client.callTool({ name: "send_message", arguments: input }));
    const second = value(await f.client.callTool({ name: "send_message", arguments: input }));
    expect(second.envelope.messageId).toBe(first.envelope.messageId);
    expect(first.envelope.sender).toBe("authenticated-local-supervisor");
    expect(first.state).toBe("acknowledged");
    expect(f.request.mock.calls.filter((c) => c[1] === "send_message")).toHaveLength(1);
    expect((await f.client.callTool({ name: "send_message", arguments: { ...input, payload: "changed" } })).isError).toBe(true);
    await f.client.close(); await f.service.close();
    // Reopen same durable ledger: acknowledged becomes unknown, never redelivered to model.
    const restart = await startCommunicationServer({ manager: f.manager, configFile: f.configFile, userData: f.dir }); cleanups.push(() => restart.close());
    const records = JSON.parse(await readFile(`${f.discoveryFile}.messages`, "utf8"));
    expect(records[0].state).toBe("unknown");
    expect(f.request.mock.calls.filter((c) => c[1] === "send_message")).toHaveLength(1);
  });
  it("marks a queued delivery unknown when its host generation changes without replaying it", async () => {
    const f = await fixture();
    const record = value(await f.client.callTool({ name: "send_message", arguments: { sessionId: "allowed", payload: "queued input", mode: "next_turn" } }));
    expect(record.state).toBe("queued");
    f.manager.listTabs = () => [{ sessionId: "allowed", workspace: f.dir, state: "running", pid: 999 }];
    await vi.waitFor(async () => {
      const records = JSON.parse(await readFile(`${f.discoveryFile}.messages`, "utf8"));
      expect(records[0].state).toBe("unknown");
    }, { timeout: 2500, interval: 30 });
    expect(f.request.mock.calls.filter((c) => c[1] === "send_message")).toHaveLength(1);
  });
  it("reports uncertain transport delivery without automatic retry", async () => {
    const f = await fixture(); f.request.mockRejectedValue(new Error("Host died after applying message"));
    const record = value(await f.client.callTool({ name: "send_message", arguments: { sessionId: "allowed", payload: "clarification", mode: "steer", idempotencyKey: "uncertain" } }));
    expect(record.state).toBe("unknown");
    expect(value(await f.client.callTool({ name: "send_message", arguments: { sessionId: "allowed", payload: "clarification", mode: "steer", idempotencyKey: "uncertain" } })).envelope.messageId).toBe(record.envelope.messageId);
    expect(f.request.mock.calls.filter((c) => c[1] === "send_message")).toHaveLength(1);
  });
});

describe("live config option and session exposure (Taskana 4747)", () => {
  async function liveFixture(options: { workspaces: string[]; port?: number; exposed?: (sessionId: string) => boolean; tabs?: Array<{ sessionId: string; workspace: string; state: string; pid: number }> }) {
    const dir = await mkdtemp(join(tmpdir(), "anycode-live-")); cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const discoveryFile = join(dir, "communication.json");
    const request = vi.fn(async (..._args: unknown[]) => undefined);
    const tabs = options.tabs ?? [{ sessionId: "a", workspace: dir, state: "running", pid: 1 }, { sessionId: "b", workspace: tmpdir(), state: "running", pid: 2 }];
    const manager = { listTabs: () => tabs, communicationRequest: request };
    const service = await startCommunicationServer({ manager, userData: dir, config: { workspaces: options.workspaces, port: options.port ?? 0, discoveryFile }, isSessionExposed: options.exposed });
    cleanups.push(() => service.close());
    return { dir, discoveryFile, service, request, manager };
  }
  async function connect(discoveryFile: string) {
    const discovery = JSON.parse(await readFile(discoveryFile, "utf8")) as { url: string; token: string };
    const client = new Client({ name: "live-test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(discovery.url), { requestInit: { headers: { Authorization: `Bearer ${discovery.token}` } } }));
    cleanups.push(() => client.close());
    return client;
  }

  it("starts from an object config with the same tools and folder scope as the file form", async () => {
    const f = await liveFixture({ workspaces: [tmpdir()] });
    const client = await connect(f.discoveryFile);
    expect(value(await client.callTool({ name: "list_sessions", arguments: {} })).sessions.map((s: { sessionId: string }) => s.sessionId)).toEqual(["b"]);
  });

  it("with an empty folder list, lists only sessions the exposure predicate allows", async () => {
    const f = await liveFixture({ workspaces: [], exposed: (id) => id === "b" });
    const client = await connect(f.discoveryFile);
    expect(value(await client.callTool({ name: "list_sessions", arguments: {} })).sessions.map((s: { sessionId: string }) => s.sessionId)).toEqual(["b"]);
  });

  it("refuses a not-exposed session as unavailable, with the same message as an unknown one (no existence leak)", async () => {
    const f = await liveFixture({ workspaces: [], exposed: () => false });
    const client = await connect(f.discoveryFile);
    const unknown = await client.callTool({ name: "get_session_status", arguments: { sessionId: "missing" } });
    const hidden = await client.callTool({ name: "get_session_status", arguments: { sessionId: "a" } });
    expect(hidden.isError).toBe(true);
    expect(hidden.content).toEqual(unknown.content);
    expect(f.request.mock.calls.filter((c) => c[1] === "get_session_status")).toHaveLength(0);
  });

  it("flips exposure live without restarting the server", async () => {
    let on = false;
    const f = await liveFixture({ workspaces: [], exposed: () => on });
    const client = await connect(f.discoveryFile);
    expect(value(await client.callTool({ name: "list_sessions", arguments: {} })).sessions).toEqual([]);
    on = true;
    expect(value(await client.callTool({ name: "list_sessions", arguments: {} })).sessions.map((s: { sessionId: string }) => s.sessionId)).toEqual(["a", "b"]);
  });

  it("writes the discovery file with mode 0600 and removes it on close", async () => {
    const f = await liveFixture({ workspaces: [] });
    expect(await stat(f.discoveryFile).then((s) => s.mode & 0o777)).toBe(0o600);
    await f.service.close();
    await expect(stat(f.discoveryFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a relative folder in the object config with a rejected promise", async () => {
    const dir = await mkdtemp(join(tmpdir(), "anycode-live-rel-")); cleanups.push(() => rm(dir, { recursive: true, force: true }));
    await expect(startCommunicationServer({ manager: { listTabs: () => [], communicationRequest: vi.fn() }, userData: dir, config: { workspaces: ["relative/dir"], port: 0, discoveryFile: join(dir, "d.json") } })).rejects.toThrow(/absolute/);
  });

  it("refuses an invalid object config (port out of range) with a rejected promise", async () => {
    const dir = await mkdtemp(join(tmpdir(), "anycode-live-port-")); cleanups.push(() => rm(dir, { recursive: true, force: true }));
    await expect(startCommunicationServer({ manager: { listTabs: () => [], communicationRequest: vi.fn() }, userData: dir, config: { workspaces: [], port: 70000 } as never })).rejects.toThrow();
  });

  it("still refuses an empty folder list in the env config FILE (backward-compatible contract)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "anycode-file-empty-")); cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const configFile = join(dir, "config.json"); await writeFile(configFile, JSON.stringify({ workspaces: [], discoveryFile: join(dir, "d.json") }));
    await expect(startCommunicationServer({ manager: { listTabs: () => [], communicationRequest: vi.fn() }, userData: dir, configFile })).rejects.toThrow();
  });

  it("starts, closes and restarts on the same fixed port", async () => {
    const probe = createNetServer(); await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
    const port = (probe.address() as { port: number }).port; await new Promise<void>((r) => probe.close(() => r()));
    const first = await liveFixture({ workspaces: [], port });
    await first.service.close();
    const again = await startCommunicationServer({ manager: first.manager, userData: first.dir, config: { workspaces: [], port, discoveryFile: first.discoveryFile } });
    expect(again.url).toBe(`http://127.0.0.1:${port}/mcp`);
    await again.close();
  });
});
