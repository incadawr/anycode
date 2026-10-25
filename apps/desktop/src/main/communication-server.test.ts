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
    if (op === "cancel_turn") return { cancelled: false, reason: "idle" };
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
    expect((await client.listTools()).tools).toHaveLength(7);
    expect(value(await client.callTool({ name: "get_session_status", arguments: { sessionId: "allowed" } })).engine).toBe("codex");
  });
  it("initializes, lists/calls tools and enforces auth, origin and workspace scope", async () => {
    const f = await fixture();
    expect((await f.client.listTools()).tools.map((t) => t.name)).toEqual(["list_sessions", "get_session_status", "get_session_result", "send_message", "get_message_status", "wait_for_result", "cancel_turn"]);
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

describe("session handles and wait_for_result (Taskana 4750b)", () => {
  type Live = Array<{ sessionId: string; workspace: string; state: string; pid: number }>;
  async function waitFixture(extra: {
    handleOf?: (sessionId: string) => string | undefined;
    isSessionExposed?: (sessionId: string) => boolean;
    pollMs?: number;
    answer?: (messageId: string) => Promise<unknown> | unknown;
  } = {}) {
    const dir = await mkdtemp(join(tmpdir(), "anycode-wait-")); cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const configFile = join(dir, "config.json"); const discoveryFile = join(dir, "endpoint.json");
    await writeFile(configFile, JSON.stringify({ workspaces: [dir], discoveryFile }));
    const base: Live = [
      { sessionId: "allowed", workspace: dir, state: "running", pid: 10 },
      { sessionId: "allowed2", workspace: dir, state: "running", pid: 12 },
      { sessionId: "forbidden", workspace: tmpdir(), state: "running", pid: 11 },
    ];
    const live = new Set(["allowed", "allowed2", "forbidden"]);
    const request = vi.fn(async (_session: string, op: string, payload?: unknown) => {
      if (op === "send_message") return { envelope: payload, state: "queued" };
      if (op === "get_message_result") return extra.answer ? await extra.answer(payload as string) : { state: "queued" };
      return undefined;
    });
    const manager = { listTabs: () => base.filter((t) => live.has(t.sessionId)), communicationRequest: request };
    const service = await startCommunicationServer({ manager, configFile, userData: dir, handleOf: extra.handleOf, isSessionExposed: extra.isSessionExposed, pollMs: extra.pollMs ?? 10 });
    cleanups.push(() => service.close());
    const discovery = JSON.parse(await readFile(discoveryFile, "utf8")) as { url: string; token: string };
    const client = new Client({ name: "wait-test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(discovery.url), { requestInit: { headers: { Authorization: `Bearer ${discovery.token}` } } }));
    cleanups.push(() => client.close());
    const send = async (sessionId: string, extraArgs: Record<string, unknown> = {}) => value(await client.callTool({ name: "send_message", arguments: { sessionId, payload: "work", mode: "next_turn", ...extraArgs } }));
    return { dir, discoveryFile, discovery, client, request, service, live, send };
  }
  const errorText = (result: unknown) => (result as { content: Array<{ text: string }> }).content[0]!.text;
  const UNAVAILABLE = "Session unavailable or outside authorized workspace";

  it("list_sessions includes handle for a shared session", async () => {
    const f = await waitFixture({ handleOf: (id) => (id === "allowed" ? "build-bot" : undefined) });
    const sessions = value(await f.client.callTool({ name: "list_sessions", arguments: {} })).sessions as Array<{ sessionId: string; handle?: string }>;
    expect(sessions.map((s) => s.sessionId)).toEqual(["allowed", "allowed2"]);
    expect(sessions[0]!.handle).toBe("build-bot");
    expect("handle" in sessions[1]!).toBe(false);
  });

  it("list_sessions omits handle key when option absent", async () => {
    const f = await waitFixture();
    const sessions = value(await f.client.callTool({ name: "list_sessions", arguments: {} })).sessions as Array<Record<string, unknown>>;
    expect(sessions.every((s) => !("handle" in s))).toBe(true);
  });

  it("tools list now has 7 tools in order (cancel_turn appended, Taskana 4763)", async () => {
    const f = await waitFixture();
    expect((await f.client.listTools()).tools.map((t) => t.name)).toEqual(["list_sessions", "get_session_status", "get_session_result", "send_message", "get_message_status", "wait_for_result", "cancel_turn"]);
  });

  it("wait_for_result resolves done for messageId", async () => {
    const f = await waitFixture({ answer: (id) => ({ state: "done", sessionId: "allowed", latestResult: { publicAnswer: `ANSWER ${id}`, turnId: "t1" }, limitation: "L" }) });
    const sent = await f.send("allowed");
    const result = value(await f.client.callTool({ name: "wait_for_result", arguments: { sessionId: "allowed", messageId: sent.envelope.messageId } }));
    expect(result).toMatchObject({ status: "done", sessionId: "allowed", messageId: sent.envelope.messageId, availability: "available", activeTurnId: null, limitation: "L" });
    expect(result.latestResult.publicAnswer).toBe(`ANSWER ${sent.envelope.messageId}`);
  });

  it("wait_for_result resolves done for correlationId (newest record wins)", async () => {
    const f = await waitFixture({ answer: (id) => ({ state: "done", latestResult: { publicAnswer: id }, limitation: "L" }) });
    await f.send("allowed", { correlationId: "c1" });
    const newest = await f.send("allowed", { correlationId: "c1" });
    await f.send("allowed2", { correlationId: "c1" });
    const result = value(await f.client.callTool({ name: "wait_for_result", arguments: { sessionId: "allowed", correlationId: "c1" } }));
    expect(result.status).toBe("done");
    expect(result.messageId).toBe(newest.envelope.messageId);
  });

  it("wait_for_result returns pending on timeout", async () => {
    const f = await waitFixture({ answer: () => ({ state: "running", turnId: "t" }) });
    const sent = await f.send("allowed");
    const started = Date.now();
    const result = value(await f.client.callTool({ name: "wait_for_result", arguments: { sessionId: "allowed", messageId: sent.envelope.messageId, timeoutMs: 150 } }));
    expect(result).toEqual({ status: "pending", sessionId: "allowed", messageId: sent.envelope.messageId });
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
  });

  it("wait_for_result neither or both ids is an error", async () => {
    const f = await waitFixture();
    const neither = await f.client.callTool({ name: "wait_for_result", arguments: { sessionId: "allowed" } });
    const both = await f.client.callTool({ name: "wait_for_result", arguments: { sessionId: "allowed", messageId: "m", correlationId: "c" } });
    expect(neither.isError).toBe(true);
    expect(errorText(neither)).toContain("Provide messageId or correlationId");
    expect(both.isError).toBe(true);
    expect(errorText(both)).toContain("Provide messageId or correlationId");
  });

  it("wait_for_result timeoutMs 120001 is rejected, 120000 accepted", async () => {
    const f = await waitFixture({ answer: () => ({ state: "done", latestResult: { publicAnswer: "x" }, limitation: "L" }) });
    const sent = await f.send("allowed");
    expect((await f.client.callTool({ name: "wait_for_result", arguments: { sessionId: "allowed", messageId: sent.envelope.messageId, timeoutMs: 120001 } })).isError).toBe(true);
    expect((await f.client.callTool({ name: "wait_for_result", arguments: { sessionId: "allowed", messageId: sent.envelope.messageId, timeoutMs: 120000 } })).isError).toBeFalsy();
  });

  it("wait_for_result unknown session is the unavailable error", async () => {
    const f = await waitFixture();
    const result = await f.client.callTool({ name: "wait_for_result", arguments: { sessionId: "ghost", messageId: "m" } });
    expect(result.isError).toBe(true);
    expect(errorText(result)).toBe(UNAVAILABLE);
  });

  it("wait_for_result for a session that is NOT shared returns the identical error as unknown", async () => {
    const f = await waitFixture({ isSessionExposed: (id) => id !== "allowed" });
    const sent = await f.send("allowed2");
    const hidden = await f.client.callTool({ name: "wait_for_result", arguments: { sessionId: "allowed", messageId: sent.envelope.messageId } });
    const unknown = await f.client.callTool({ name: "wait_for_result", arguments: { sessionId: "ghost", messageId: sent.envelope.messageId } });
    expect(hidden.content).toEqual(unknown.content);
    expect(errorText(hidden)).toBe(UNAVAILABLE);
  });

  it("wait_for_result foreign message (recipient is another session) is Message unavailable", async () => {
    const f = await waitFixture({ answer: () => ({ state: "done", latestResult: { publicAnswer: "x" }, limitation: "L" }) });
    const sent = await f.send("allowed2");
    const result = await f.client.callTool({ name: "wait_for_result", arguments: { sessionId: "allowed", messageId: sent.envelope.messageId } });
    expect(result.isError).toBe(true);
    expect(errorText(result)).toBe("Message unavailable");
    expect((await f.client.callTool({ name: "wait_for_result", arguments: { sessionId: "allowed", correlationId: "nothing-here" } })).isError).toBe(true);
  });

  it("wait_for_result session closes mid-wait errors", async () => {
    const f = await waitFixture({ answer: () => { f.live.delete("allowed"); return { state: "queued" }; } });
    const sent = await f.send("allowed");
    const result = await f.client.callTool({ name: "wait_for_result", arguments: { sessionId: "allowed", messageId: sent.envelope.messageId, timeoutMs: 5000 } });
    expect(result.isError).toBe(true);
    expect(errorText(result)).toBe(UNAVAILABLE);
  });

  it("wait_for_result session unshared mid-wait errors", async () => {
    let shared = true;
    const f = await waitFixture({ isSessionExposed: () => shared, answer: () => { shared = false; return { state: "queued" }; } });
    const sent = await f.send("allowed");
    const result = await f.client.callTool({ name: "wait_for_result", arguments: { sessionId: "allowed", messageId: sent.envelope.messageId, timeoutMs: 5000 } });
    expect(result.isError).toBe(true);
    expect(errorText(result)).toBe(UNAVAILABLE);
  });

  it("wait_for_result host RPC failure errors as Session closed", async () => {
    const f = await waitFixture({ answer: () => { throw new Error("Session host unavailable"); } });
    const sent = await f.send("allowed");
    const result = await f.client.callTool({ name: "wait_for_result", arguments: { sessionId: "allowed", messageId: sent.envelope.messageId } });
    expect(result.isError).toBe(true);
    expect(errorText(result)).toBe("Session closed");
  });

  it("wait_for_result rejected delivery returns status rejected", async () => {
    const f = await waitFixture({ answer: () => ({ state: "rejected", detail: "Inbox full" }) });
    const sent = await f.send("allowed");
    const result = value(await f.client.callTool({ name: "wait_for_result", arguments: { sessionId: "allowed", messageId: sent.envelope.messageId } }));
    expect(result).toEqual({ status: "rejected", sessionId: "allowed", messageId: sent.envelope.messageId, detail: "Inbox full" });
  });

  it("wait_for_result aborts when client disconnects (no pending polls)", async () => {
    const f = await waitFixture({ answer: () => ({ state: "queued" }) });
    const sent = await f.send("allowed");
    const controller = new AbortController();
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "wait_for_result", arguments: { sessionId: "allowed", messageId: sent.envelope.messageId, timeoutMs: 60000 } } });
    const pending = fetch(f.discovery.url, { method: "POST", signal: controller.signal, headers: { Authorization: `Bearer ${f.discovery.token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body }).catch(() => undefined);
    await vi.waitFor(() => expect(f.request.mock.calls.filter((c) => c[1] === "get_message_result").length).toBeGreaterThanOrEqual(2), { timeout: 2000, interval: 10 });
    controller.abort(); await pending;
    await new Promise((r) => setTimeout(r, 50));
    const settled = f.request.mock.calls.filter((c) => c[1] === "get_message_result").length;
    await new Promise((r) => setTimeout(r, 150));
    expect(f.request.mock.calls.filter((c) => c[1] === "get_message_result").length).toBe(settled);
  });

  it("server close aborts waiters", async () => {
    const f = await waitFixture({ answer: () => ({ state: "queued" }) });
    const sent = await f.send("allowed");
    const waiting = f.client.callTool({ name: "wait_for_result", arguments: { sessionId: "allowed", messageId: sent.envelope.messageId, timeoutMs: 60000 } }).catch((error: unknown) => ({ isError: true, error }));
    await vi.waitFor(() => expect(f.request.mock.calls.filter((c) => c[1] === "get_message_result").length).toBeGreaterThanOrEqual(2), { timeout: 2000, interval: 10 });
    await f.service.close();
    await waiting;
    const settled = f.request.mock.calls.filter((c) => c[1] === "get_message_result").length;
    await new Promise((r) => setTimeout(r, 120));
    expect(f.request.mock.calls.filter((c) => c[1] === "get_message_result").length).toBe(settled);
  });

  it("33rd concurrent waiter refused", async () => {
    const f = await waitFixture({ answer: () => ({ state: "queued" }) });
    const sent = await f.send("allowed");
    const calls = Array.from({ length: 33 }, () => f.client.callTool({ name: "wait_for_result", arguments: { sessionId: "allowed", messageId: sent.envelope.messageId, timeoutMs: 1500 } }));
    const results = await Promise.all(calls);
    const refused = results.filter((r) => r.isError);
    expect(refused).toHaveLength(1);
    expect(errorText(refused[0])).toBe("Too many waiters");
    expect(results.filter((r) => !r.isError).every((r) => value(r).status === "pending")).toBe(true);
  }, 20000);

  it("two messages queued each get their own turn result (no overwrite)", async () => {
    const f = await waitFixture({ answer: (id) => ({ state: "done", latestResult: { publicAnswer: `FOR ${id}`, turnId: id }, limitation: "L" }) });
    const first = await f.send("allowed");
    const second = await f.send("allowed");
    const a = value(await f.client.callTool({ name: "wait_for_result", arguments: { sessionId: "allowed", messageId: first.envelope.messageId } }));
    const b = value(await f.client.callTool({ name: "wait_for_result", arguments: { sessionId: "allowed", messageId: second.envelope.messageId } }));
    expect(a.latestResult.publicAnswer).toBe(`FOR ${first.envelope.messageId}`);
    expect(b.latestResult.publicAnswer).toBe(`FOR ${second.envelope.messageId}`);
  });
});

describe("Sessions API cancel_turn (Taskana 4763)", () => {
  it("T15 cancel_turn is listed with a strict sessionId-only schema", async () => {
    const f = await fixture();
    const tool = (await f.client.listTools()).tools.find((t) => t.name === "cancel_turn");
    expect(tool?.inputSchema).toMatchObject({ type: "object", required: ["sessionId"], additionalProperties: false });
    expect((await f.client.callTool({ name: "cancel_turn", arguments: { sessionId: "allowed", extra: true } })).isError).toBe(true);
    expect((await f.client.callTool({ name: "cancel_turn", arguments: {} })).isError).toBe(true);
    expect(f.request.mock.calls.filter((c) => c[1] === "cancel_turn")).toHaveLength(0);
  });
  it("T16 cancel_turn forwards to the host pinned to the tab workspace and passes idle through", async () => {
    const f = await fixture();
    f.request.mockImplementation(async (_session, op) => (op === "cancel_turn" ? { cancelled: true, turnId: "host-turn-7" } : undefined) as never);
    expect(value(await f.client.callTool({ name: "cancel_turn", arguments: { sessionId: "allowed" } }))).toEqual({ sessionId: "allowed", cancelled: true, turnId: "host-turn-7" });
    expect(f.request).toHaveBeenLastCalledWith("allowed", "cancel_turn", undefined, f.dir);
    f.request.mockImplementation((async () => ({ cancelled: false, reason: "idle" })) as never);
    expect(value(await f.client.callTool({ name: "cancel_turn", arguments: { sessionId: "allowed" } }))).toEqual({ sessionId: "allowed", cancelled: false, reason: "idle" });
  });
  it("T17 cancel_turn on an unshared, unknown or outside-folder session is refused before the host is called", async () => {
    const f = await fixture();
    for (const sessionId of ["forbidden", "nope"]) {
      const result = await f.client.callTool({ name: "cancel_turn", arguments: { sessionId } });
      expect(result.isError).toBe(true);
      expect((result.content as Array<{ text: string }>)[0]!.text).toBe("Session unavailable or outside authorized workspace");
    }
    expect(f.request.mock.calls.filter((c) => c[1] === "cancel_turn")).toHaveLength(0);
  });
});

