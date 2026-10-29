import { mkdtemp, mkdir, writeFile, readFile, stat, rm, realpath } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createNetServer } from "node:net";
import { EventEmitter } from "node:events";
import { TabHostManager, type HostForkFn } from "./tabs.js";
import type { MessagePortMain, UtilityProcess } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client, StreamableHTTPClientTransport, StdioClientTransport } from "@anycode/core/communication-mcp";
import { canonicalWorkspaceKey } from "@anycode/core/workspace-trust";
import { startCommunicationServer, writePrivateFile, type CloseSessionOutcome, type CreateSessionOutcome, type CreateSessionRequest } from "./communication-server.js";
import { createSessionForAgent, type CreateSessionByAgentDeps } from "./create-session-by-agent.js";
import { createSessionAccessStore } from "./communication-sessions.js";
import { primeNewSessionPin } from "./session-pin.js";
import type { AgentDelivery, AgentEnvelope } from "../shared/communication.js";
import type { AnycodeSettings } from "../shared/settings.js";
import { createHarness, finishStep, ScriptedModelPort } from "../host/test-harness.js";
import type { Session } from "../host/session.js";
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
/** Connects a fresh client to a restarted server over the SAME durable discovery file. */
async function reconnect(discoveryFile: string): Promise<Client> {
  const discovery = JSON.parse(await readFile(discoveryFile, "utf8")) as { url: string; token: string };
  const client = new Client({ name: "restart-supervisor", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(discovery.url), { requestInit: { headers: { Authorization: `Bearer ${discovery.token}` } } }));
  cleanups.push(() => client.close());
  return client;
}
describe("production communication MCP over real SDK HTTP", () => {
  it("connects a portable stdio MCP client through the discovery-file adapter", async () => {
    const f = await fixture();
    const client = new Client({ name: "portable-supervisor", version: "1" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../../../../examples/agent-communication/stdio.mjs", import.meta.url)), f.discoveryFile] }));
    cleanups.push(() => client.close());
    expect((await client.listTools()).tools).toHaveLength(11);
    expect(value(await client.callTool({ name: "get_session_status", arguments: { sessionId: "allowed" } })).engine).toBe("codex");
  });
  it("returns an authorized terminal status without contacting the host", async () => {
    const f = await fixture();
    const failure = { code: "per_tab_crash_loop" as const, message: "Session host stopped after repeated crashes.", exitCode: 1 };
    f.manager.listTabs = () => [{ sessionId: "allowed", workspace: f.dir, state: "crash_looped", pid: 10, engine: "core", hostFailure: failure }, { sessionId: "forbidden", workspace: tmpdir(), state: "crash_looped", pid: 10, engine: "core", hostFailure: failure }];
    const status = value(await f.client.callTool({ name: "get_session_status", arguments: { sessionId: "allowed" } }));
    expect(status).toMatchObject({ state: "crash_looped", engine: "core", hostFailure: failure });
    expect(status).not.toHaveProperty("model");
    const sessions = value(await f.client.callTool({ name: "list_sessions", arguments: {} })).sessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0].hostFailure).toEqual(status.hostFailure);
    expect((await f.client.callTool({ name: "get_session_status", arguments: { sessionId: "forbidden" } })).isError).toBe(true);
    expect((await f.client.callTool({ name: "get_session_status", arguments: { sessionId: "unknown" } })).isError).toBe(true);
    expect(f.request).not.toHaveBeenCalled();
  });
  it("initializes, lists/calls tools and enforces auth, origin and workspace scope", async () => {
    const f = await fixture();
    expect((await f.client.listTools()).tools.map((t) => t.name)).toEqual(["list_sessions", "get_session_status", "get_session_result", "send_message", "get_message_status", "wait_for_result", "list_pending_approvals", "answer_approval", "cancel_turn", "create_session", "close_session"]);
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
    // Reopen the same durable ledger (GitHub #19): a SETTLED record keeps its
    // state and detail — a runtime restart is not evidence that the delivery was
    // lost — and it is still never redelivered to the model.
    const restart = await startCommunicationServer({ manager: f.manager, configFile: f.configFile, userData: f.dir }); cleanups.push(() => restart.close());
    const records = JSON.parse(await readFile(`${f.discoveryFile}.messages`, "utf8"));
    expect(records[0]).toMatchObject({ state: "acknowledged", detail: "transport accepted", idempotencyKey: "clarification-1" });
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
  // GitHub #19: a renderer reload does NOT restart this server at all; these
  // cover the separate app/server restart, which must not rewrite settled
  // delivery history (acknowledged is transport acceptance, not model success).
  it("restarting the server preserves acknowledged rejected and unknown records and idempotency keys", async () => {
    const f = await fixture();
    f.request.mockImplementation(async (_session, op, payload) => {
      if (op !== "send_message") return undefined;
      const text = (payload as AgentEnvelope).payload;
      if (text === "acked") return { envelope: payload, state: "acknowledged", detail: "transport accepted" };
      if (text === "rejected") return { envelope: payload, state: "rejected", detail: "steering refused; use next_turn" };
      throw new Error("Host died after applying message");
    });
    const send = async (payload: string, idempotencyKey: string) =>
      value(await f.client.callTool({ name: "send_message", arguments: { sessionId: "allowed", payload, mode: "next_turn", idempotencyKey } }));
    const acked = await send("acked", "key-acked");
    const rejected = await send("rejected", "key-rejected");
    const unknown = await send("unknown", "key-unknown");
    expect([acked.state, rejected.state, unknown.state]).toEqual(["acknowledged", "rejected", "unknown"]);
    await f.client.close(); await f.service.close();

    const restart = await startCommunicationServer({ manager: f.manager, configFile: f.configFile, userData: f.dir });
    cleanups.push(() => restart.close());
    const client = await reconnect(f.discoveryFile);
    const statusOf = async (messageId: string) => value(await client.callTool({ name: "get_message_status", arguments: { messageId } }));
    expect(await statusOf(acked.envelope.messageId)).toMatchObject({ state: "acknowledged", detail: "transport accepted" });
    expect(await statusOf(rejected.envelope.messageId)).toMatchObject({ state: "rejected", detail: "steering refused; use next_turn" });
    expect(await statusOf(unknown.envelope.messageId)).toMatchObject({ state: "unknown", detail: "Host response unavailable; do not blindly resend" });

    const ledger = JSON.parse(await readFile(`${f.discoveryFile}.messages`, "utf8")) as Array<{ idempotencyKey?: string; state: string }>;
    expect(ledger.map((record) => record.idempotencyKey)).toEqual(["key-acked", "key-rejected", "key-unknown"]);
    expect(ledger.map((record) => record.state)).toEqual(["acknowledged", "rejected", "unknown"]);
    // Same idempotency key after the restart still resolves to the settled record: never resent.
    const retried = value(await client.callTool({ name: "send_message", arguments: { sessionId: "allowed", payload: "acked", mode: "next_turn", idempotencyKey: "key-acked" } }));
    expect(retried.envelope.messageId).toBe(acked.envelope.messageId);
    expect(f.request.mock.calls.filter((c) => c[1] === "send_message")).toHaveLength(3);
  });
  it("reports recovered delivery detail when a live host retains stale pending state", async () => {
    const f = await fixture();
    const record = value(await f.client.callTool({ name: "send_message", arguments: { sessionId: "allowed", payload: "hello", mode: "next_turn" } }));
    await f.client.close(); await f.service.close();
    const host = createHarness({ steps: [finishStep()] });
    try {
      const stale = { ...record, envelope: { ...record.envelope, recipientSessionId: "test-session" }, state: "unknown", detail: "Dispatch pending" };
      host.session.restoreAgentMessages([stale]);
      await writeFile(`${f.discoveryFile}.messages`, JSON.stringify([stale]));
      f.manager.listTabs = () => [{ sessionId: "test-session", workspace: f.dir, state: "running", pid: 10 }];
      f.request.mockImplementation(async (_session, op, payload) => {
        if (op === "get_message_status") return host.session.agentMessageStatus(String(payload));
        if (op === "get_message_result") return host.session.communicationMessageResult(String(payload)) as never;
        if (op === "restore_agent_messages") host.session.restoreAgentMessages(payload as never);
        return undefined;
      });
      const restart = await startCommunicationServer({ manager: f.manager, configFile: f.configFile, userData: f.dir });
      cleanups.push(() => restart.close());
      const client = await reconnect(f.discoveryFile);
      const detail = "Host response unavailable; do not blindly resend";
      expect(host.session.agentMessageStatus(record.envelope.messageId)?.detail).toBe("Dispatch pending");
      expect(value(await client.callTool({ name: "get_message_status", arguments: { messageId: record.envelope.messageId } })).detail).toBe(detail);
      expect(value(await client.callTool({ name: "wait_for_result", arguments: { sessionId: "test-session", messageId: record.envelope.messageId, timeoutMs: 1000 } })).detail).toBe(detail);
      expect(f.request.mock.calls.filter((c) => c[1] === "send_message")).toHaveLength(1);
    } finally { host.close(); }
  });

  it("a queued record survives a restart against the same live host and reconciles its status", async () => {
    const f = await fixture();
    const record = value(await f.client.callTool({ name: "send_message", arguments: { sessionId: "allowed", payload: "still queued", mode: "next_turn" } }));
    expect(record.state).toBe("queued");
    await f.client.close(); await f.service.close();

    let hostState: "queued" | "acknowledged" = "queued";
    let hostPolls = 0;
    f.request.mockImplementation(async (_session, op) => {
      if (op !== "get_message_status") return undefined;
      hostPolls += 1;
      return { envelope: record.envelope, state: hostState, ...(hostState === "queued" ? {} : { detail: "host accepted after restart" }) };
    });
    // Same host generation (same pid): the queued record must NOT be downgraded.
    const restart = await startCommunicationServer({ manager: f.manager, configFile: f.configFile, userData: f.dir });
    cleanups.push(() => restart.close());
    await vi.waitFor(() => expect(hostPolls).toBeGreaterThan(1), { timeout: 2500, interval: 30 });
    const stillQueued = JSON.parse(await readFile(`${f.discoveryFile}.messages`, "utf8")) as Array<{ state: string }>;
    expect(stillQueued[0]!.state).toBe("queued");
    expect(value(await (await reconnect(f.discoveryFile)).callTool({ name: "get_message_status", arguments: { messageId: record.envelope.messageId } })).state).toBe("queued");

    // A real live transition reconciles into the ledger without any model resend.
    hostState = "acknowledged";
    await vi.waitFor(async () => {
      const records = JSON.parse(await readFile(`${f.discoveryFile}.messages`, "utf8")) as Array<{ state: string; detail?: string }>;
      expect(records[0]).toMatchObject({ state: "acknowledged", detail: "host accepted after restart" });
    }, { timeout: 2500, interval: 30 });
    expect(f.request.mock.calls.filter((c) => c[1] === "send_message")).toHaveLength(1);
  });
  it("keeps a queued delivery after a status timeout and reconciles recovery on the same host", async () => {
    const f = await fixture();
    const record = value(await f.client.callTool({ name: "send_message", arguments: { sessionId: "allowed", payload: "pending", mode: "next_turn" } }));
    let recovered = false;
    f.request.mockImplementation(async (_session, op) => {
      if (op === "get_message_status") {
        if (!recovered) throw new Error("status request timed out");
        return { envelope: record.envelope, state: "acknowledged", detail: "accepted after recovery" };
      }
      return undefined;
    });
    const status = () => f.client.callTool({ name: "get_message_status", arguments: { messageId: record.envelope.messageId } });
    expect(value(await status()).state).toBe("queued");
    const ledger = JSON.parse(await readFile(`${f.discoveryFile}.messages`, "utf8"));
    expect(ledger[0].state).toBe("queued");
    recovered = true;
    await vi.waitFor(async () => {
      const records = JSON.parse(await readFile(`${f.discoveryFile}.messages`, "utf8"));
      expect(records[0]).toMatchObject({ state: "acknowledged", detail: "accepted after recovery" });
    }, { timeout: 2500, interval: 30 });
    expect(value(await status()).state).toBe("acknowledged");
    expect(f.request.mock.calls.filter((c) => c[1] === "send_message")).toHaveLength(1);
  });
  it("persists unknown when a queued recipient closes or disappears between polls", async () => {
    for (const lost of ["closing", "removed", "during query"] as const) {
      const f = await fixture();
      const record = value(await f.client.callTool({ name: "send_message", arguments: { sessionId: "allowed", payload: lost, mode: "next_turn" } }));
      expect(record.state).toBe("queued");
      if (lost === "closing") f.manager.listTabs = () => [{ sessionId: "allowed", workspace: f.dir, state: "closing", pid: 10 }];
      if (lost === "removed") f.manager.listTabs = () => [];
      if (lost === "during query") f.request.mockImplementation(async (_session, op) => {
        if (op === "get_message_status") {
          f.manager.listTabs = () => [];
          throw new Error("host closed");
        }
        return undefined;
      });
      const status = value(await f.client.callTool({ name: "get_message_status", arguments: { messageId: record.envelope.messageId } }));
      expect(status).toMatchObject({ state: "unknown", detail: "Host restarted before queued delivery could be confirmed; no automatic model replay" });
      const ledger = JSON.parse(await readFile(`${f.discoveryFile}.messages`, "utf8"));
      expect(ledger[0].state).toBe("unknown");
      expect(f.request.mock.calls.filter((c) => c[1] === "send_message")).toHaveLength(1);
    }
  });
  it("reconciliation persists unknown when a queued recipient disappears", async () => {
    const f = await fixture();
    const record = value(await f.client.callTool({ name: "send_message", arguments: { sessionId: "allowed", payload: "pending", mode: "next_turn" } }));
    f.manager.listTabs = () => [];
    await vi.waitFor(async () => {
      const ledger = JSON.parse(await readFile(`${f.discoveryFile}.messages`, "utf8"));
      expect(ledger[0]).toMatchObject({ state: "unknown", detail: "Host restarted before queued delivery could be confirmed; no automatic model replay" });
    }, { timeout: 2500, interval: 30 });
    expect(value(await f.client.callTool({ name: "get_message_status", arguments: { messageId: record.envelope.messageId } })).state).toBe("unknown");
  });
  it("a queued record becomes unknown only after its host generation is lost across a restart", async () => {
    const f = await fixture();
    const record = value(await f.client.callTool({ name: "send_message", arguments: { sessionId: "allowed", payload: "queued before restart", mode: "next_turn" } }));
    expect(record.state).toBe("queued");
    await f.client.close(); await f.service.close();
    // Different pid = a lost host generation: the transport never confirmed this one.
    f.manager.listTabs = () => [{ sessionId: "allowed", workspace: f.dir, state: "running", pid: 999 }];
    const restart = await startCommunicationServer({ manager: f.manager, configFile: f.configFile, userData: f.dir });
    cleanups.push(() => restart.close());
    await vi.waitFor(async () => {
      const records = JSON.parse(await readFile(`${f.discoveryFile}.messages`, "utf8")) as Array<{ state: string; detail: string }>;
      expect(records[0]).toMatchObject({ state: "unknown", detail: "Host restarted before queued delivery could be confirmed; no automatic model replay" });
    }, { timeout: 2500, interval: 30 });
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

describe("a listed folder that is missing (live config)", () => {
  type Tab = { sessionId: string; workspace: string; state: string; pid: number };
  type FixtureSetup = { workspaces: string[]; tabs: Tab[]; realpath?: (path: string) => Promise<string> };
  /** `setup` lets a test choose the listed folders, the live tabs and a resolver seam. */
  async function missingFixture(setup?: (paths: { dir: string; present: string; missing: string }) => Promise<FixtureSetup>) {
    const dir = await mkdtemp(join(tmpdir(), "anycode-missing-")); cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const present = join(dir, "present"); const missing = join(dir, "gone");
    await mkdir(present);
    const discoveryFile = join(dir, "communication.json");
    const request = vi.fn(async (_session: string, op: string, payload?: unknown) => {
      if (op === "send_message") return { envelope: payload, state: "queued" };
      if (op === "get_session_status") return { engine: "core", state: "idle" };
      return undefined;
    });
    const defaults: FixtureSetup = {
      workspaces: [missing, present],
      tabs: [
        { sessionId: "present", workspace: present, state: "running", pid: 1 },
        { sessionId: "gone", workspace: missing, state: "running", pid: 2 },
        { sessionId: "outside", workspace: tmpdir(), state: "running", pid: 3 },
      ],
    };
    const built: FixtureSetup = setup ? await setup({ dir, present, missing }) : defaults;
    const tabs = built.tabs;
    const warn = vi.fn();
    const create = vi.fn(async () => ({ ok: true as const, sessionId: "created", tabId: "tab-created" }));
    const manager = { listTabs: () => tabs, communicationRequest: request };
    // The missing folder is listed FIRST: the start must survive hitting it first.
    const service = await startCommunicationServer({ manager, userData: dir, config: { workspaces: built.workspaces, port: 0, discoveryFile }, warn, createSessionByAgent: create, ...(built.realpath ? { realpath: built.realpath } : {}) });
    cleanups.push(() => service.close());
    const discovery = JSON.parse(await readFile(discoveryFile, "utf8")) as { url: string; token: string; workspaces: string[] };
    const client = new Client({ name: "missing-folder", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(discovery.url), { requestInit: { headers: { Authorization: `Bearer ${discovery.token}` } } }));
    cleanups.push(() => client.close());
    const ids = async () => value(await client.callTool({ name: "list_sessions", arguments: {} })).sessions.map((s: { sessionId: string }) => s.sessionId) as string[];
    return { dir, present, missing, discoveryFile, discovery, client, request, warn, create, ids };
  }

  it("starts and serves the folders that exist, without granting the missing one", async () => {
    const f = await missingFixture();
    // The discovery file keeps the canonical paths of the folders that resolved.
    expect(f.discovery.workspaces).toEqual([await realpath(f.present)]);
    expect(await f.ids()).toEqual(["present"]);
    expect(value(await f.client.callTool({ name: "get_session_status", arguments: { sessionId: "present" } })).state).toBe("idle");
    expect(value(await f.client.callTool({ name: "send_message", arguments: { sessionId: "present", payload: "hello", mode: "next_turn" } })).state).toBe("queued");
    // A tab whose workspace string IS the missing entry stays unauthorised: the check
    // compares canonical paths only, so the stored string never authorises anything.
    expect(errorText(await f.client.callTool({ name: "get_session_status", arguments: { sessionId: "gone" } }))).toBe("Session unavailable or outside authorized workspace");
    expect(errorText(await f.client.callTool({ name: "send_message", arguments: { sessionId: "gone", payload: "no", mode: "next_turn" } }))).toBe("Session unavailable or outside authorized workspace");
    expect(errorText(await f.client.callTool({ name: "create_session", arguments: { workspace: f.missing } }))).toMatch(/^create_session folder_not_found/);
    expect(errorText(await f.client.callTool({ name: "create_session", arguments: { workspace: f.dir } }))).toMatch(/^create_session not_allowed/);
    // The folder that does exist is still allowed through the same check.
    expect(value(await f.client.callTool({ name: "create_session", arguments: { workspace: f.present } })).sessionId).toBe("created");
    // One warning at startup naming how many listed folders are missing.
    expect(f.warn).toHaveBeenCalledTimes(1);
    expect(f.warn.mock.calls[0]![0]).toContain("1 of 2 allowed folders are missing");
    expect(f.warn.mock.calls[0]![0]).toContain(f.missing);
  });

  it("allows the folder again once it is back, without restarting the server", async () => {
    const f = await missingFixture();
    expect(await f.ids()).toEqual(["present"]);
    const before = await readFile(f.discoveryFile, "utf8");
    await mkdir(f.missing);
    // No restart and no timer: the next authorisation check resolves the entry again.
    expect(await f.ids()).toEqual(["present", "gone"]);
    expect(value(await f.client.callTool({ name: "get_session_status", arguments: { sessionId: "gone" } })).state).toBe("idle");
    expect(value(await f.client.callTool({ name: "send_message", arguments: { sessionId: "gone", payload: "welcome back", mode: "next_turn" } })).state).toBe("queued");
    // The same instance is still serving: same URL, same token, one warning in total.
    const after = JSON.parse(await readFile(f.discoveryFile, "utf8")) as { url: string; token: string; workspaces: string[] };
    expect(after).toMatchObject({ url: f.discovery.url, token: f.discovery.token });
    // The discovery file is written at startup only: recovery authorises the folder but
    // leaves the file byte-identical, so no write of this server can outlive close().
    expect(await readFile(f.discoveryFile, "utf8")).toBe(before);
    expect(after.workspaces).toEqual([await realpath(f.present)]);
    expect(f.warn).toHaveBeenCalledTimes(1);
  });

  it("overlapping re-resolutions of one entry authorise exactly one target", async () => {
    // A listed folder that is missing at start, then appears as a symlink. Its two
    // canonical targets are live tabs, so whichever target gets authorised shows up
    // in list_sessions. The seam holds every re-resolution until the test releases it.
    let link = "";
    let targetA = ""; let targetB = "";
    const gates: Array<(target: string) => void> = [];
    let calls = 0; let settled: string | undefined;
    const f = await missingFixture(async ({ dir, present, missing }) => {
      link = missing; await mkdir(join(dir, "target-a")); await mkdir(join(dir, "target-b"));
      // Canonical: the temp root itself is behind a symlink on macOS.
      targetA = await realpath(join(dir, "target-a")); targetB = await realpath(join(dir, "target-b"));
      return {
        workspaces: [link, present],
        tabs: [
          { sessionId: "to-a", workspace: targetA, state: "running", pid: 1 },
          { sessionId: "to-b", workspace: targetB, state: "running", pid: 2 },
          { sessionId: "swapped", workspace: link, state: "running", pid: 3 },
        ],
        realpath: (path: string): Promise<string> => {
          if (path !== link) return realpath(path);
          calls += 1;
          // Missing at startup: only the request-time retries are gated.
          if (calls === 1) return Promise.reject(Object.assign(new Error("gone"), { code: "ENOENT" }));
          if (settled !== undefined) return Promise.resolve(settled);
          return new Promise<string>((release) => { gates.push((target) => { settled = target; release(target); }); });
        },
      };
    });
    // Two concurrent authorisation checks; both find the entry unresolved.
    const first = f.ids(); const second = f.ids();
    await vi.waitFor(() => expect(gates.length).toBeGreaterThanOrEqual(1), { timeout: 3000, interval: 5 });
    // Without a shared in-flight pass the second request reaches the seam as well.
    const until = Date.now() + 400;
    while (gates.length < 2 && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
    const overlapping = gates.length;
    // Release the first resolution, let it settle and delist the entry, then the second.
    gates[0]!(targetA);
    await new Promise((r) => setTimeout(r, 30));
    if (gates[1]) gates[1](targetB);
    const listed = new Set((await Promise.all([first, second])).flat());
    expect(listed).not.toContain("to-b"); // the losing target was never authorised
    expect(listed).toContain("to-a");
    expect(listed).toContain("swapped");
    expect(overlapping).toBe(1); // one pass shared by both concurrent requests
  });

  it("the reconciliation timer never re-resolves a missing folder", async () => {
    const counts: string[] = [];
    const f = await missingFixture(async ({ present, missing }) => ({
      workspaces: [missing, present],
      // No tab lives in the missing folder, so every count below is a retry pass.
      tabs: [
        { sessionId: "present", workspace: present, state: "running", pid: 1 },
        { sessionId: "outside", workspace: tmpdir(), state: "running", pid: 3 },
      ],
      realpath: (path: string): Promise<string> => { counts.push(path); return realpath(path); },
    }));
    const resolves = () => counts.filter((path) => path === f.missing).length;
    expect(resolves()).toBe(1); // the startup attempt
    // More than the 1 s reconciliation interval: the timer must not touch the entry.
    await new Promise((r) => setTimeout(r, 1300));
    expect(resolves()).toBe(1);
    // One request-time check performs one pass, and no more.
    expect(await f.ids()).toEqual(["present"]);
    expect(resolves()).toBe(2);
  }, 10000);
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

  it("tools list has 11 tools in order (close_session last; Taskana 4880)", async () => {
    const f = await waitFixture();
    expect((await f.client.listTools()).tools.map((t) => t.name)).toEqual(["list_sessions", "get_session_status", "get_session_result", "send_message", "get_message_status", "wait_for_result", "list_pending_approvals", "answer_approval", "cancel_turn", "create_session", "close_session"]);
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

/** A live-config server with the per-session approval switch wired (Taskana 4763). */
async function approvalFixture(options: { approvals: Set<string>; exposed: Set<string>; request?: (session: string, op: string, payload?: unknown) => Promise<unknown> | unknown }) {
  const dir = await mkdtemp(join(tmpdir(), "anycode-approvals-")); cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const discoveryFile = join(dir, "endpoint.json");
  const tabs = [
    { sessionId: "on", workspace: dir, state: "running", pid: 10 },
    { sessionId: "off-approvals", workspace: dir, state: "running", pid: 11 },
    { sessionId: "unshared-approving", workspace: dir, state: "running", pid: 12 },
    { sessionId: "child", workspace: dir, state: "running", pid: 13, childOf: { parentTabId: "on", requestId: "req-1" } },
  ];
  const request = vi.fn(async (session: string, op: string, payload?: unknown) => {
    const custom = options.request ? await options.request(session, op, payload) : undefined;
    if (custom !== undefined) return custom;
    if (op === "list_pending_approvals") return [];
    if (op === "cancel_turn") return { cancelled: false, reason: "idle" };
    return undefined;
  });
  const manager = { listTabs: () => tabs, communicationRequest: request };
  const service = await startCommunicationServer({
    manager, config: { workspaces: [dir], discoveryFile }, userData: dir,
    isSessionExposed: (id) => options.exposed.has(id),
    isExternalApprovalEnabled: (id) => options.approvals.has(id),
  });
  cleanups.push(() => service.close());
  const discovery = JSON.parse(await readFile(discoveryFile, "utf8")) as { url: string; token: string };
  const client = new Client({ name: "approvals-test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(discovery.url), { requestInit: { headers: { Authorization: `Bearer ${discovery.token}` } } }));
  cleanups.push(() => client.close());
  return { client, request, service, dir };
}
const errorText = (result: unknown): string => (result as { content: Array<{ text: string }> }).content[0]!.text;

describe("External approvals on the Sessions API (Taskana 4763)", () => {
  it("T15 approval tools are listed with strict schemas (extra key and a bad decision are rejected)", async () => {
    const f = await approvalFixture({ approvals: new Set(), exposed: new Set(["on"]) });
    const tools = (await f.client.listTools()).tools;
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["list_pending_approvals", "answer_approval"]));
    expect(tools.find((t) => t.name === "answer_approval")?.inputSchema).toMatchObject({ additionalProperties: false, required: ["sessionId", "approvalId", "decision"] });
    expect((await f.client.callTool({ name: "answer_approval", arguments: { sessionId: "on", approvalId: "a", decision: "always" } })).isError).toBe(true);
    expect((await f.client.callTool({ name: "answer_approval", arguments: { sessionId: "on", approvalId: "a", decision: "allow", remember: true } })).isError).toBe(true);
    expect(f.request.mock.calls.filter((c) => c[1] === "answer_approval")).toHaveLength(0);
  });

  it("T18 with the switch off (or the option absent) the sessionId forms throw the fixed error and the host is not called", async () => {
    const f = await approvalFixture({ approvals: new Set(), exposed: new Set(["on"]) });
    const list = await f.client.callTool({ name: "list_pending_approvals", arguments: { sessionId: "on" } });
    expect(list.isError).toBe(true);
    expect(errorText(list)).toBe("External approval is off for this session");
    const answer = await f.client.callTool({ name: "answer_approval", arguments: { sessionId: "on", approvalId: "a", decision: "allow" } });
    expect(errorText(answer)).toBe("External approval is off for this session");
    expect(f.request.mock.calls.filter((c) => c[1] === "list_pending_approvals" || c[1] === "answer_approval")).toHaveLength(0);
  });

  it("T19 with the switch on, the list returns exactly the whitelisted fields even if the host returns input or updatedInput", async () => {
    const f = await approvalFixture({
      approvals: new Set(["on"]), exposed: new Set(["on"]),
      request: (_s, op) => (op === "list_pending_approvals" ? [{ approvalId: "a1", tool: "Write", description: "/w/a.txt", presented: true, expiresInMs: 5000, answerable: true, input: { content: "SECRET_BODY" }, updatedInput: { x: "SECRET_UPDATE" } }] : undefined),
    });
    const body = value(await f.client.callTool({ name: "list_pending_approvals", arguments: { sessionId: "on" } }));
    expect(body).toEqual({ approvals: [{ sessionId: "on", approvalId: "a1", tool: "Write", description: "/w/a.txt", presented: true, expiresInMs: 5000, answerable: true }], truncated: false });
    expect(JSON.stringify(body)).not.toContain("SECRET");
  });

  it("T20 aggregate list: only sessions with both switches on; a failing tab is skipped; 60 approvals -> 50 and truncated; child entries carry childOf", async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ approvalId: `c${i}`, tool: "Bash", description: "ls", presented: i === 0, expiresInMs: null, answerable: true }));
    const f = await approvalFixture({
      approvals: new Set(["on", "child", "unshared-approving"]), exposed: new Set(["on", "off-approvals", "child"]),
      request: (session, op) => {
        if (op !== "list_pending_approvals") return undefined;
        if (session === "on") throw new Error("boom");
        return many;
      },
    });
    const body = value(await f.client.callTool({ name: "list_pending_approvals", arguments: {} }));
    expect(body.approvals).toHaveLength(50);
    expect(body.truncated).toBe(true);
    expect(body.approvals.every((a: { sessionId: string }) => a.sessionId === "child")).toBe(true);
    expect(body.approvals[0]).toMatchObject({ childOf: { parentTabId: "on", requestId: "req-1" } });
    const asked = f.request.mock.calls.filter((c) => c[1] === "list_pending_approvals").map((c) => c[0]);
    expect(asked).not.toContain("off-approvals");
    expect(asked).not.toContain("unshared-approving");
  });

  it("T21 the access switch wins: an approving but unshared session is unavailable", async () => {
    const f = await approvalFixture({ approvals: new Set(["unshared-approving"]), exposed: new Set(["on"]) });
    for (const call of [
      { name: "list_pending_approvals", arguments: { sessionId: "unshared-approving" } },
      { name: "answer_approval", arguments: { sessionId: "unshared-approving", approvalId: "a", decision: "deny" } },
    ]) {
      expect(errorText(await f.client.callTool(call))).toBe("Session unavailable or outside authorized workspace");
    }
    expect(f.request.mock.calls.filter((c) => c[0] === "unshared-approving")).toHaveLength(0);
  });

  it("T22 answer_approval statuses map correctly and none is an error", async () => {
    const f = await approvalFixture({
      approvals: new Set(["on"]), exposed: new Set(["on"]),
      request: (_s, op, payload) => {
        if (op !== "answer_approval") return undefined;
        const id = (payload as { approvalId: string }).approvalId;
        if (id === "a-ok") return { result: "answered" };
        if (id === "a-dup") return { result: "already_answered", settledBy: "ui" };
        if (id === "a-plan") return { result: "not_answerable" };
        return { result: "not_found" };
      },
    });
    const call = async (approvalId: string) => f.client.callTool({ name: "answer_approval", arguments: { sessionId: "on", approvalId, decision: "allow" } });
    expect(value(await call("a-ok"))).toEqual({ sessionId: "on", approvalId: "a-ok", status: "answered", decision: "allow" });
    expect(value(await call("a-dup"))).toEqual({ sessionId: "on", approvalId: "a-dup", status: "already_answered", settledBy: "ui" });
    expect(value(await call("a-plan"))).toEqual({ sessionId: "on", approvalId: "a-plan", status: "not_answerable" });
    expect(value(await call("a-gone"))).toEqual({ sessionId: "on", approvalId: "a-gone", status: "not_found" });
    for (const id of ["a-ok", "a-dup", "a-plan", "a-gone"]) expect((await call(id)).isError).toBeFalsy();
  });

  it("T23 two concurrent answers for one approval: exactly one answered, one already_answered", async () => {
    let settled = false;
    const f = await approvalFixture({
      approvals: new Set(["on"]), exposed: new Set(["on"]),
      request: async (_s, op) => {
        if (op !== "answer_approval") return undefined;
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (settled) return { result: "already_answered", settledBy: "external" };
        settled = true;
        return { result: "answered" };
      },
    });
    const call = () => f.client.callTool({ name: "answer_approval", arguments: { sessionId: "on", approvalId: "race", decision: "allow" } });
    const [first, second] = [value(await call()), value(await call())];
    expect([first.status, second.status].sort()).toEqual(["already_answered", "answered"]);
  });

  it("T24 live switches: turning approvals off takes effect on the next call; turning access off hides the session from both tools", async () => {
    const approvals = new Set(["on"]);
    const exposed = new Set(["on"]);
    const f = await approvalFixture({ approvals, exposed, request: (_s, op) => (op === "answer_approval" ? { result: "answered" } : undefined) });
    expect(value(await f.client.callTool({ name: "answer_approval", arguments: { sessionId: "on", approvalId: "a", decision: "allow" } })).status).toBe("answered");
    approvals.delete("on");
    expect(errorText(await f.client.callTool({ name: "answer_approval", arguments: { sessionId: "on", approvalId: "a", decision: "allow" } }))).toBe("External approval is off for this session");
    approvals.add("on");
    exposed.delete("on");
    expect(errorText(await f.client.callTool({ name: "list_pending_approvals", arguments: { sessionId: "on" } }))).toBe("Session unavailable or outside authorized workspace");
    expect(value(await f.client.callTool({ name: "list_pending_approvals", arguments: {} })).approvals).toEqual([]);
  });

  it("T25 list_sessions carries externalApproval only when the option is wired; the legacy env-file server never allows approvals", async () => {
    const wired = await approvalFixture({ approvals: new Set(["on"]), exposed: new Set(["on", "off-approvals", "child"]) });
    const sessions = value(await wired.client.callTool({ name: "list_sessions", arguments: {} })).sessions as Array<{ sessionId: string; externalApproval?: boolean }>;
    expect(Object.fromEntries(sessions.map((s) => [s.sessionId, s.externalApproval]))).toEqual({ on: true, "off-approvals": false, child: false });

    const legacy = await fixture();
    const legacySessions = value(await legacy.client.callTool({ name: "list_sessions", arguments: {} })).sessions as Array<Record<string, unknown>>;
    expect(legacySessions.length).toBeGreaterThan(0);
    for (const s of legacySessions) expect(s).not.toHaveProperty("externalApproval");
    expect(errorText(await legacy.client.callTool({ name: "list_pending_approvals", arguments: { sessionId: "allowed" } }))).toBe("External approval is off for this session");
    expect(legacy.request.mock.calls.filter((c) => c[1] === "answer_approval" || c[1] === "list_pending_approvals")).toHaveLength(0);
  });
});


describe("Sessions API create_session (Taskana 4768)", () => {
  type FixtureTab = { sessionId: string; workspace: string; state: string; pid: number };
  async function createFixture(options: { opened?: Set<string>; exposed?: (id: string) => boolean; closer?: (id: string, tabs: FixtureTab[]) => Promise<CloseSessionOutcome>; creator?: (request: CreateSessionRequest, tabs: FixtureTab[]) => Promise<CreateSessionOutcome>; ready?: boolean; clock?: { now: number }; dispatchTimeoutMs?: number; writeLedger?: (path: string, text: string) => Promise<void> } = {}) {
    const dir = await mkdtemp(join(tmpdir(), "anycode-create-")); cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const discoveryFile = join(dir, "communication.json");
    const tabs: FixtureTab[] = [];
    const request = vi.fn(async (_session: string, op: string, payload?: unknown) => {
      if (op === "get_session_status") { if (options.ready === false) throw new Error("host not ready"); return { engine: "core", state: "idle" }; }
      if (op === "send_message") return { envelope: payload, state: "queued" };
      return undefined;
    });
    let counter = 0;
    const creator = options.creator ?? (async (input: CreateSessionRequest, liveTabs: FixtureTab[]) => {
      const sessionId = `agent-${++counter}`;
      liveTabs.push({ sessionId, workspace: input.workspace, state: "running", pid: 100 + counter });
      return { ok: true, sessionId, tabId: `tab-${counter}`, ...(input.handle ? { handle: input.handle } : {}) };
    });
    const clock = options.clock;
    const manager = { listTabs: () => tabs, communicationRequest: request };
    const service = await startCommunicationServer({
      manager, userData: dir, config: { workspaces: [], discoveryFile },
      createSessionByAgent: (input) => creator(input, tabs),
      ...(options.opened ? { agentOpenedSessions: options.opened } : {}),
      ...(options.exposed ? { isSessionExposed: options.exposed } : {}),
      ...(options.closer ? { closeSessionByAgent: (id: string) => options.closer!(id, tabs) } : {}), ...(clock ? { now: () => clock.now } : {}), readyTimeoutMs: 120, readyPollMs: 10,
      ...(options.dispatchTimeoutMs !== undefined ? { dispatchTimeoutMs: options.dispatchTimeoutMs } : {}),
      ...(options.writeLedger ? { writeLedger: options.writeLedger } : {}),
    });
    cleanups.push(() => service.close());
    const discovery = JSON.parse(await readFile(discoveryFile, "utf8")) as { url: string; token: string };
    const client = new Client({ name: "create-test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(discovery.url), { requestInit: { headers: { Authorization: `Bearer ${discovery.token}` } } }));
    cleanups.push(() => client.close());
    return { dir, client, request, tabs, manager };
  }
  const errorText = (result: unknown) => (result as { isError?: boolean; content: Array<{ text: string }> }).content[0]!.text;

  it("close_session validates input and fails closed without a hook", async () => {
    const f = await fixture();
    const tool = (await f.client.listTools()).tools.find((t) => t.name === "close_session")!;
    expect(tool.inputSchema).toMatchObject({ required: ["sessionId"], additionalProperties: false });
    for (const input of [{}, { sessionId: "" }, { sessionId: "allowed", extra: true }]) {
      expect((await f.client.callTool({ name: "close_session", arguments: input })).isError).toBe(true);
    }
    expect(errorText(await f.client.callTool({ name: "close_session", arguments: { sessionId: "allowed" } }))).toMatch(/^close_session not_allowed:/);
  });

  it("close_session hides unshared sessions without invoking the main hook", async () => {
    const closer = vi.fn(async () => ({ ok: true as const }));
    const f = await createFixture({ closer, exposed: () => false });
    await f.client.callTool({ name: "create_session", arguments: { workspace: f.dir } });
    expect(errorText(await f.client.callTool({ name: "close_session", arguments: { sessionId: "agent-1" } }))).toMatch(/^close_session not_found:/);
    expect(closer).not.toHaveBeenCalled();
  });

  it.each(["not_found", "not_agent_opened", "busy", "not_allowed", "last_tab"] as const)("close_session preserves %s refusal", async (reason) => {
    const f = await createFixture({ closer: async () => ({ ok: false, reason }) });
    await f.client.callTool({ name: "create_session", arguments: { workspace: f.dir } });
    expect(errorText(await f.client.callTool({ name: "close_session", arguments: { sessionId: "agent-1" } }))).toMatch(new RegExp(`^close_session ${reason}:`));
  });

  it("close_session removes the session from list_sessions and frees the alive budget", async () => {
    const clock = { now: 0 };
    const opened = new Set<string>();
    const f = await createFixture({ clock, opened, closer: async (id, tabs) => {
      tabs.splice(tabs.findIndex((t) => t.sessionId === id), 1);
      return { ok: true };
    } });
    for (let i = 0; i < 8; i++) {
      clock.now += 61000;
      await f.client.callTool({ name: "create_session", arguments: { workspace: f.dir } });
    }
    expect(opened.size).toBe(8);
    expect(errorText(await f.client.callTool({ name: "create_session", arguments: { workspace: f.dir } }))).toMatch(/^create_session too_many:/);
    expect(value(await f.client.callTool({ name: "close_session", arguments: { sessionId: "agent-1" } }))).toEqual({ sessionId: "agent-1", closed: true });
    expect(opened.size).toBe(7);
    expect(value(await f.client.callTool({ name: "list_sessions", arguments: {} })).sessions.some((t: { sessionId: string }) => t.sessionId === "agent-1")).toBe(false);
    expect(value(await f.client.callTool({ name: "create_session", arguments: { workspace: f.dir } })).sessionId).toBe("agent-9");
    expect(errorText(await f.client.callTool({ name: "close_session", arguments: { sessionId: "missing" } }))).toMatch(/^close_session not_found:/);
  });

  it("create_session: lists in tools and refuses not_allowed when no creator hook is wired (env-file mode)", async () => {
    const f = await fixture();
    expect((await f.client.listTools()).tools.map((t) => t.name)).toContain("create_session");
    const result = await f.client.callTool({ name: "create_session", arguments: { workspace: f.dir } });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(errorText(result)).toMatch(/^create_session not_allowed/);
  });

  it("create_session: folder_not_found for a vanished path", async () => {
    const f = await createFixture();
    const result = await f.client.callTool({ name: "create_session", arguments: { workspace: join(f.dir, "gone") } });
    expect(errorText(result)).toMatch(/^create_session folder_not_found/);
    expect(f.tabs).toHaveLength(0);
  });

  it("create_session: a folder that vanished DURING creation is folder_not_found and spends no creation budget (GitHub #6)", async () => {
    let refusedLeft = 5;
    let successes = 0;
    const f = await createFixture({ creator: async () => {
      if (refusedLeft-- > 0) return { ok: false, reason: "folder_not_found" };
      successes++;
      return { ok: true, sessionId: `agent-${successes}`, tabId: `tab-${successes}` };
    } });
    for (let i = 0; i < 5; i++) {
      expect(errorText(await f.client.callTool({ name: "create_session", arguments: { workspace: f.dir } }))).toMatch(/^create_session folder_not_found:/);
    }
    // No tab survived from any attempt, and the 5/min window is still empty.
    expect(f.tabs).toHaveLength(0);
    expect(value(await f.client.callTool({ name: "create_session", arguments: { workspace: f.dir } }))).toMatchObject({ sessionId: "agent-1" });
  });

  it("create_session: not_trusted when the creator reports an untrusted folder", async () => {
    const f = await createFixture({ creator: async () => ({ ok: false, reason: "not_trusted" }) });
    expect(errorText(await f.client.callTool({ name: "create_session", arguments: { workspace: f.dir } }))).toMatch(/^create_session not_trusted/);
  });

  it("create_session: not_ready is mapped to its own code", async () => {
    const f = await createFixture({ creator: async () => ({ ok: false, reason: "not_ready" }) });
    expect(errorText(await f.client.callTool({ name: "create_session", arguments: { workspace: f.dir } }))).toMatch(/^create_session not_ready/);
  });

  it("create_session: a priming failure's safe reason reaches the API answer, not a generic not_ready", async () => {
    // Main's create_session hook now classifies a priming failure (vault read,
    // provider probe) into this fixed-vocabulary sentence. Before it, the client
    // got "sign-in or tab limit" with no way to tell it was the connection.
    const detail = "could not prepare connection conn-glm: Sign-in failed or expired. Sign in again in Settings, then retry.";
    const f = await createFixture({ creator: async () => ({ ok: false, reason: "not_ready", detail }) });
    const text = errorText(await f.client.callTool({ name: "create_session", arguments: { workspace: f.dir, model: "glm-5.3" } }));
    expect(text).toMatch(/^create_session not_ready: /);
    expect(text).toContain(detail);
    // No tab was created, so the refusal consumed no capacity.
    expect(f.tabs).toHaveLength(0);
  });

  it("create_session: invalid_model is its own code and its text carries main's candidate list verbatim (Taskana 4888)", async () => {
    const detail = 'no connection offers "deepseek-flash"; connections: conn-a (deepseek: deepseek-flash); conn-b (zai: glm-5)';
    const f = await createFixture({ creator: async () => ({ ok: false, reason: "invalid_model", detail }) });
    const text = errorText(await f.client.callTool({ name: "create_session", arguments: { workspace: f.dir, model: "deepseek-flash" } }));
    expect(text).toMatch(/^create_session invalid_model: /);
    expect(text).toContain(detail);
    expect(f.tabs).toHaveLength(0);
  });

  it("create_session: an invalid_model refusal does not consume the 5/min budget (Taskana 4888)", async () => {
    let refusedLeft = 5;
    let successes = 0;
    const f = await createFixture({ creator: async () => {
      if (refusedLeft-- > 0) return { ok: false, reason: "invalid_model", detail: "ambiguous model" };
      successes++;
      return { ok: true, sessionId: `agent-${successes}`, tabId: `tab-${successes}` };
    } });
    for (let i = 0; i < 5; i++) {
      expect(errorText(await f.client.callTool({ name: "create_session", arguments: { workspace: f.dir, model: "x" } }))).toMatch(/^create_session invalid_model: /);
    }
    expect(value(await f.client.callTool({ name: "create_session", arguments: { workspace: f.dir } }))).toMatchObject({ sessionId: "agent-1" });
  });

  it("create_session: the tool description documents how core picks a connection from model (Taskana 4888)", async () => {
    const f = await createFixture();
    const tool = (await f.client.listTools()).tools.find((t) => t.name === "create_session")!;
    expect(tool.description).toContain("provider connection");
    expect(tool.description).toContain("invalid_model");
  });

  it("create_session: refused creations do not consume the 5/min budget (Taskana 4808, review F2)", async () => {
    let refusedLeft = 5;
    let successes = 0;
    const f = await createFixture({ creator: async () => {
      if (refusedLeft-- > 0) return { ok: false, reason: "not_trusted" };
      successes++;
      return { ok: true, sessionId: `agent-${successes}`, tabId: `tab-${successes}` };
    } });
    // Five refusals in a row (untrusted folder) — these must NOT count towards the rate window.
    for (let i = 0; i < 5; i++) expect(errorText(await f.client.callTool({ name: "create_session", arguments: { workspace: f.dir } }))).toMatch(/^create_session not_trusted/);
    expect(f.tabs).toHaveLength(0);
    // The next, now-valid creation must still succeed (pre-fix it was rate_limited).
    expect(value(await f.client.callTool({ name: "create_session", arguments: { workspace: f.dir } }))).toMatchObject({ sessionId: "agent-1", tabId: "tab-1" });
    // Four more successful creations and the window is full again (5 successes).
    for (let i = 0; i < 4; i++) {
      const sessionId = `agent-${i + 2}`;
      expect(value(await f.client.callTool({ name: "create_session", arguments: { workspace: f.dir } }))).toMatchObject({ sessionId });
    }
    expect(errorText(await f.client.callTool({ name: "create_session", arguments: { workspace: f.dir } }))).toMatch(/^create_session rate_limited/);
  });

  it("create_session: a throwing creator maps to not_ready and does not consume the budget", async () => {
    let threwLeft = 5;
    let successes = 0;
    const f = await createFixture({ creator: async () => {
      if (threwLeft-- > 0) throw new Error("hook blew up");
      successes++;
      return { ok: true, sessionId: `agent-${successes}`, tabId: `tab-${successes}` };
    } });
    for (let i = 0; i < 5; i++) expect(errorText(await f.client.callTool({ name: "create_session", arguments: { workspace: f.dir } }))).toMatch(/^create_session not_ready/);
    expect(f.tabs).toHaveLength(0);
    expect(value(await f.client.callTool({ name: "create_session", arguments: { workspace: f.dir } }))).toMatchObject({ sessionId: "agent-1", tabId: "tab-1" });
  });

  it("create_session: rate_limited on the 6th creation within one minute", async () => {
    const f = await createFixture();
    for (let i = 0; i < 5; i++) expect(value(await f.client.callTool({ name: "create_session", arguments: { workspace: f.dir } })).sessionId).toBe(`agent-${i + 1}`);
    expect(errorText(await f.client.callTool({ name: "create_session", arguments: { workspace: f.dir } }))).toMatch(/^create_session rate_limited/);
    expect(f.tabs).toHaveLength(5);
  });

  it("create_session: too_many at 9 alive agent-opened tabs", async () => {
    const clock = { now: 1_000_000 };
    const f = await createFixture({ clock });
    for (let i = 0; i < 8; i++) {
      expect(value(await f.client.callTool({ name: "create_session", arguments: { workspace: f.dir } })).sessionId).toBe(`agent-${i + 1}`);
      clock.now += 20_000;
    }
    expect(errorText(await f.client.callTool({ name: "create_session", arguments: { workspace: f.dir } }))).toMatch(/^create_session too_many/);
    // Closing one frees a slot.
    f.tabs.shift();
    clock.now += 60_000;
    expect(value(await f.client.callTool({ name: "create_session", arguments: { workspace: f.dir } })).sessionId).toBe("agent-9");
  });

  it("create_session: two concurrent calls at the alive cap cannot both create (Taskana 4808, review F4)", async () => {
    const clock = { now: 0 };
    let creatorCalls = 0;
    let successes = 0;
    let releaseSecond!: () => void;
    const secondEntered = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const f = await createFixture({
      clock,
      creator: async (input, tabs) => {
        creatorCalls++;
        // The racing pair (calls 8 and 9): hold the first inside the creator until the second
        // one enters too, proving both passed the alive-cap check (pre-fix TOCTOU). The 1 s
        // safety release matters post-fix, where the second call never reaches the creator.
        if (creatorCalls === 8) await Promise.race([secondEntered, new Promise((resolve) => setTimeout(resolve, 1000))]);
        if (creatorCalls === 9) releaseSecond();
        successes++;
        const sessionId = `agent-${successes}`;
        tabs.push({ sessionId, workspace: input.workspace, state: "running", pid: 100 + successes });
        return { ok: true, sessionId, tabId: `tab-${successes}` };
      },
    });
    // Seven alive agent-opened tabs, spread across clock minutes so the rate window never bites.
    for (let i = 0; i < 7; i++) {
      expect(value(await f.client.callTool({ name: "create_session", arguments: { workspace: f.dir } }))).toMatchObject({ sessionId: `agent-${i + 1}` });
      clock.now += 20_000;
    }
    clock.now += 60_000; // a fresh minute: the rate window is empty for the racing pair
    const settled = await Promise.all([
      f.client.callTool({ name: "create_session", arguments: { workspace: f.dir } }),
      f.client.callTool({ name: "create_session", arguments: { workspace: f.dir } }),
    ]);
    const refused = settled.filter((r) => (r as { isError?: boolean }).isError).map((r) => errorText(r));
    const created = settled.filter((r) => !(r as { isError?: boolean }).isError).map((r) => value(r));
    expect(refused).toEqual([expect.stringMatching(/^create_session too_many/)]);
    expect(created).toEqual([expect.objectContaining({ sessionId: "agent-8" })]);
    expect(f.tabs).toHaveLength(8); // pre-fix both created and 9 tabs were alive
  }, 20000);

  it("create_session: creates a shared session, returns ids+handle, and delivers firstMessage through the next_turn ledger", async () => {
    const f = await createFixture();
    const created = value(await f.client.callTool({ name: "create_session", arguments: { workspace: f.dir, handle: "worker-1", firstMessage: "do the thing" } }));
    expect(created).toMatchObject({ sessionId: "agent-1", tabId: "tab-1", handle: "worker-1" });
    expect(typeof created.messageId).toBe("string");
    const sent = f.request.mock.calls.find((c) => c[1] === "send_message")!;
    expect(sent[2]).toMatchObject({ recipientSessionId: "agent-1", payload: "do the thing", mode: "next_turn" });
    const status = value(await f.client.callTool({ name: "get_message_status", arguments: { messageId: created.messageId } }));
    expect(status.envelope.recipientSessionId).toBe("agent-1");
    expect(value(await f.client.callTool({ name: "list_sessions", arguments: {} })).sessions.map((s: { sessionId: string }) => s.sessionId)).toEqual(["agent-1"]);
  });

  it("delivers the first turn when the host is still starting and restoration overlaps dispatch", async () => {
    const h = createHarness({ steps: [finishStep()] });
    try {
      // One tab for the whole test: the seed message and the firstMessage share it, so
      // the reconcile sweep has a settled record to restore into this host.
      const f = await createFixture({ creator: async (input, tabs) => {
        if (!tabs.length) tabs.push({ sessionId: "test-session", workspace: input.workspace, state: "running", pid: 101 });
        return { ok: true, sessionId: "test-session", tabId: "tab-1" };
      } });
      await f.client.callTool({ name: "create_session", arguments: { workspace: f.dir } });
      const order: string[] = [];
      let releaseRestore!: () => void;
      const restored = new Promise<void>((resolve) => { releaseRestore = resolve; });
      let dispatching = false;
      let probes = 0;
      f.request.mockImplementation(async (_session, op, payload: any) => {
        // The host is not ready at first: the readiness loop must keep probing without
        // spending the message, and an early probe answering must not lose the envelope.
        if (op === "get_session_status") { probes += 1; if (probes < 2) throw new Error("host still starting"); return { engine: "core", state: "idle" }; }
        if (op === "restore_agent_messages") {
          // Restoration is allowed to run only while the firstMessage dispatch is in
          // flight, so the overlap is forced rather than merely close in time.
          if (!dispatching) throw new Error("no dispatch to overlap");
          order.push("restore"); h.session.restoreAgentMessages(payload); releaseRestore();
          return undefined;
        }
        if (op === "send_message") {
          if (payload.payload === "seed") return { envelope: payload, state: "rejected" };
          order.push("dispatch"); dispatching = true;
          await restored; // settle only after the restore landed on this host
          order.push("deliver");
          return await h.session.receiveAgentMessage(payload);
        }
        return undefined;
      });
      await f.client.callTool({ name: "send_message", arguments: { sessionId: "test-session", payload: "seed", mode: "next_turn" } });
      const result = value(await f.client.callTool({ name: "create_session", arguments: { workspace: f.dir, firstMessage: "first turn" } }));
      expect(order).toEqual(["dispatch", "restore", "deliver"]);
      expect(probes).toBeGreaterThanOrEqual(2);
      expect(result.messageId).toBeTruthy();
      expect(f.request.mock.calls.filter((c) => c[1] === "send_message" && (c[2] as { payload?: string }).payload === "first turn")).toHaveLength(1);
      await vi.waitFor(() => expect((h.config.modelPort as ScriptedModelPort).requests).toHaveLength(1));
      expect(JSON.stringify((h.config.modelPort as ScriptedModelPort).requests[0])).toContain("first turn");
      const ledger = JSON.parse(await readFile(join(f.dir, "communication.json.messages"), "utf8"));
      expect(ledger.find((r: any) => r.envelope.messageId === result.messageId)).toMatchObject({ state: "acknowledged" });
    } finally { h.close(); }
  }, 15000);

  /**
   * A host process stand-in that answers main's communication channel the way
   * `host/index.ts` does: nothing is answered before the boot `ready` resolves,
   * and every operation is forwarded to a REAL host `Session` (built by the
   * harness around a scripted model provider). Nothing here invents a delivery:
   * `send_message` returns whatever that session's own `receiveAgentMessage`
   * answered, so an acknowledged record is only possible because a turn really
   * started, and `restore_agent_messages` uses the session's own dedupe — a
   * restored record makes the real envelope a no-op and starts no turn.
   * Boot time is the test's (`boot()`), so readiness lands after the spawn
   * rather than at it, and every operation is recorded in send order.
   */
  function controllableHost(pidValue: number, session: Session) {
    const order: string[] = [];
    const events: Array<{ op: "restore" | "send"; ids: string[]; payload?: string }> = [];
    const proc = Object.assign(new EventEmitter(), { pid: pidValue, kill: () => true }) as EventEmitter & {
      pid: number; kill: () => boolean; postMessage: (message: unknown) => void;
    };
    let boot!: () => void;
    const booted = new Promise<void>((resolve) => { boot = resolve; });
    let sawProbe!: () => void;
    const probeSeen = new Promise<void>((resolve) => { sawProbe = resolve; });
    const reply = (requestId: unknown, result: unknown) => proc.emit("message", { type: "communication_response", requestId, result });
    // Mirror the host's own delivery observation (host/index.ts forwards each
    // delivery to main): the session's REAL state transitions drive the ledger.
    session.observeAgentDeliveries((delivery) => proc.emit("message", { type: "communication_delivery", delivery }));
    proc.postMessage = (raw: unknown) => {
      const message = raw as { requestId?: string; operation?: string; payload?: unknown };
      void (async () => {
        switch (message.operation) {
          case "get_session_status":
            // The host routes its whole communication channel through
            // `ready.then(...)`: before boot a probe gets no answer at all.
            sawProbe();
            await booted;
            order.push("ready");
            reply(message.requestId, session.communicationStatus());
            return;
          case "restore_agent_messages": {
            const deliveries = message.payload as AgentDelivery[];
            events.push({ op: "restore", ids: deliveries.map((entry) => entry.envelope.messageId) });
            session.restoreAgentMessages(deliveries);
            reply(message.requestId, {});
            return;
          }
          case "send_message": {
            const envelope = message.payload as AgentEnvelope;
            events.push({ op: "send", ids: [envelope.messageId], payload: envelope.payload });
            order.push("send");
            reply(message.requestId, await session.receiveAgentMessage(envelope));
            return;
          }
          case "get_message_status":
            reply(message.requestId, session.agentMessageStatus(String(message.payload)));
            return;
          default:
            reply(message.requestId, undefined);
        }
      })();
    };
    return { proc, order, events, boot: () => boot(), probeSeen };
  }

  it("create_session firstMessage: the production creation path starts exactly one turn in a host that becomes ready after spawn", async () => {
    // GitHub #21 on the wiring main actually uses: the `create_session` hook is
    // `createSessionForAgent` over a REAL TabHostManager, the ledger and the
    // session switch are the real files, and the host spawns at once but answers
    // only when it boots (a few ms later, on the test's word). The pre-dispatch
    // ledger write of the firstMessage is held open, so a full reconciliation
    // sweep runs in the production window between "record durable" and "envelope
    // posted" instead of hoping to hit its few milliseconds. The held write also
    // outlives the record's own dispatch deadline, which rewrites the displayed
    // detail while the dispatch is still open — the exact shape in which a
    // detail-based eligibility rule re-reads an unposted record as restorable.
    const dir = await mkdtemp(join(tmpdir(), "anycode-create-prod-")); cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const discoveryFile = join(dir, "communication.json");
    const key = canonicalWorkspaceKey(dir, realpathSync);
    // The host side of the stand-in is a REAL Session (real core loop, real
    // delivery bookkeeping) whose only substitute is the scripted model: what
    // lands there is what the model really receives.
    const h = createHarness({ steps: [finishStep()] });
    cleanups.push(async () => h.close());
    const host = controllableHost(4242, h.session);
    const sessions = createSessionAccessStore({ file: join(dir, "access.json"), handlesFile: join(dir, "handles.json"), defaultOn: () => false });
    const agentOpenedSessions = new Set<string>();
    const manager = new TabHostManager({
      fork: (() => {
        queueMicrotask(() => host.proc.emit("spawn"));
        return host.proc as unknown as UtilityProcess;
      }) as HostForkFn,
      hostEntry: "/fake/host.js",
      createChannel: () => ({ port1: {} as MessagePortMain, port2: {} as MessagePortMain }),
      getWindow: () => null,
      env: () => ({ PATH: "/fake" }),
      engineEnv: () => ({}),
      engineReady: () => true,
      logger: { log: () => {}, warn: () => {}, error: () => {} },
      limits: {},
      onSessionRegistered: ({ sessionId }) => (sessions.register({ sessionId }) ? () => sessions.remove(sessionId) : undefined),
    });
    const settings: AnycodeSettings = {
      version: 2,
      provider: { connections: [{ id: "conn-active", providerId: "custom", model: "deepseek-flash", authOptional: true }], activeConnectionId: "conn-active" },
      tools: {},
      permissions: { alwaysAllow: [] },
      ui: { theme: "system" },
      security: { allowWeakSecretStorage: false },
    };
    const deps: CreateSessionByAgentDeps = {
      projects: { isAllowed: () => true },
      manager: () => manager,
      sessions: () => sessions,
      realpathSync,
      readTrustStore: async () => ({ version: 1, folders: { [key]: { decision: "trusted", hash: "h", decidedAt: "2026-10-26T00:00:00.000Z" } } }),
      mcpSecretPrime: async () => {},
      currentSettings: () => settings,
      primeNewSessionPin,
      resolveResumePin: async () => ({ ok: true, release: () => {} }),
      // The host side is the harness Session, whose id is fixed: minting the
      // tab under that id is what makes the stand-in genuinely the host of the
      // session main just created (envelopes are addressed by this id).
      randomUUID: () => "test-session",
      agentOpenedSessions,
      agentSessionTitles: new Map<string, string>(),
      listTabs: () => manager.listTabs(),
    };
    let holding = false;
    let atGate!: () => void;
    const atWrite = new Promise<void>((resolve) => { atGate = resolve; });
    let releaseWrite!: () => void;
    const writeReleased = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const snapshots: string[] = [];
    const service = await startCommunicationServer({
      manager,
      userData: dir,
      config: { workspaces: [dir], discoveryFile },
      createSessionByAgent: (request) => createSessionForAgent(request, deps),
      isSessionExposed: (sessionId) => sessions.isExposed(sessionId),
      agentOpenedSessions,
      readyTimeoutMs: 5_000,
      readyPollMs: 10,
      dispatchTimeoutMs: 60,
      writeLedger: async (path, text) => {
        snapshots.push(text);
        // The FIRST durable snapshot carrying the firstMessage is the pre-dispatch
        // one: park it there, exactly where production awaits its ledger write.
        if (!holding && text.includes("first turn")) { holding = true; host.order.push("write"); atGate(); await writeReleased; }
        await writePrivateFile(path, text);
      },
    });
    cleanups.push(() => service.close());
    const discovery = JSON.parse(await readFile(discoveryFile, "utf8")) as { url: string; token: string };
    const client = new Client({ name: "create-production-path", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(discovery.url), { requestInit: { headers: { Authorization: `Bearer ${discovery.token}` } } }));
    cleanups.push(() => client.close());

    const created = client.callTool({ name: "create_session", arguments: { workspace: dir, firstMessage: "first turn" } });
    // Spawn already returned, but the host has not booted: the readiness probe
    // waits inside the host and no turn, ledger write or envelope exists yet.
    await host.probeSeen;
    expect(host.order).toEqual([]);
    expect((h.config.modelPort as ScriptedModelPort).requests).toEqual([]);
    host.boot();
    await atWrite;
    expect(host.order).toEqual(["ready", "write"]);

    // A reconciliation pass must run inside the open window. While the write is
    // held the dispatch is parked in `persist`, so the only `listTabs` reads come
    // from sweeps (one per pass): two means one pass finished and the next began.
    let counting = false;
    let passes = 0;
    let sweepDone!: () => void;
    const swept = new Promise<void>((resolve) => { sweepDone = resolve; });
    const listTabs = manager.listTabs.bind(manager);
    manager.listTabs = () => { if (counting) { passes += 1; if (passes >= 2) sweepDone(); } return listTabs(); };
    counting = true;
    await swept;
    releaseWrite();

    const result = await created;
    expect((result as { isError?: boolean }).isError).toBeFalsy();
    const messageId = value(result).messageId as string;
    expect(messageId).toBeTruthy();
    // Exactly one envelope, and the turn it started is the firstMessage's — read
    // on the MODEL side, where a session that stopped starting a turn (or
    // stopped forwarding the payload) shows up as zero requests or a miss.
    expect(host.events.filter((event) => event.op === "send")).toHaveLength(1);
    const requests = (h.config.modelPort as ScriptedModelPort).requests;
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    const userText = requests[0]!.messages.flatMap((message) => (message.role === "user" ? [message.content] : [])).join("\n");
    expect(userText).toContain("first turn");
    await h.flush();
    expect(requests).toHaveLength(1); // one turn: not a retry and not a second dispatch
    // The record's own dispatch deadline passed while its envelope was still
    // unposted (the displayed detail was rewritten), and the delivery still
    // settled after it.
    const expired = snapshots.findIndex((text) => text.includes("first turn") && text.includes("Host response unavailable; do not blindly resend"));
    const accepted = snapshots.findIndex((text) => text.includes("first turn") && text.includes("Host started a next turn"));
    expect(expired).toBeGreaterThan(-1);
    expect(accepted).toBeGreaterThan(expired);
    // Nothing may be restored into this host before its envelope is posted.
    const postedAt = host.events.findIndex((event) => event.op === "send");
    expect(host.events.slice(0, postedAt).filter((event) => event.op === "restore" && event.ids.includes(messageId))).toEqual([]);
    // The delivery is settled, never unknown / "Dispatch pending" — in the durable
    // ledger and through the status tool the reporter used. A real host publishes
    // queued and then acknowledged, and each delivery observation persists on its
    // own, so the durable snapshot is read after those writes flush.
    await vi.waitFor(async () => {
      const ledger = JSON.parse(await readFile(`${discoveryFile}.messages`, "utf8")) as Array<{ envelope: AgentEnvelope; state: string; detail?: string }>;
      expect(ledger.find((record) => record.envelope.messageId === messageId)).toMatchObject({ state: "acknowledged", detail: "Host started a next turn; model application unverified" });
    }, { timeout: 4000, interval: 20 });
    expect(value(await client.callTool({ name: "get_message_status", arguments: { messageId } }))).toMatchObject({ state: "acknowledged", detail: "Host started a next turn; model application unverified" });
  }, 20000);

  it("keeps an in-flight record out of restoration after its dispatch deadline rewrote the detail", async () => {
    // The same window, now longer than the record's own dispatch deadline: a
    // detail-based restore filter re-opened #21 here, because the deadline
    // rewrites "Dispatch pending" to "Host response unavailable…" while the
    // envelope has still not been posted. Eligibility must follow the in-flight
    // id, not the displayed text.
    const h = createHarness({ steps: [finishStep()] });
    try {
      const order: string[] = [];
      const ledgers: string[] = [];
      let releaseWrite!: () => void;
      const writeHeld = new Promise<void>((resolve) => { releaseWrite = resolve; });
      let gateEntered!: () => void;
      const atGate = new Promise<void>((resolve) => { gateEntered = resolve; });
      let holdFirstMessage = true;
      const f = await createFixture({
        dispatchTimeoutMs: 60,
        creator: async (input, tabs) => {
          if (!tabs.length) tabs.push({ sessionId: "test-session", workspace: input.workspace, state: "running", pid: 101 });
          return { ok: true, sessionId: "test-session", tabId: "tab-1" };
        },
        writeLedger: async (path, text) => {
          ledgers.push(text);
          if (holdFirstMessage && text.includes("first turn") && text.includes("Dispatch pending")) {
            holdFirstMessage = false; order.push("write"); gateEntered(); await writeHeld;
          }
          await writePrivateFile(path, text);
        },
      });
      f.request.mockImplementation(async (_session: string, op: string, payload: any): Promise<any> => {
        if (op === "get_session_status") { order.push("ready"); return { engine: "core", state: "idle" }; }
        if (op === "restore_agent_messages") { order.push("restore"); h.session.restoreAgentMessages(payload); return {}; }
        if (op === "send_message") { order.push("send"); return await h.session.receiveAgentMessage(payload); }
        return undefined;
      });
      const created = f.client.callTool({ name: "create_session", arguments: { workspace: f.dir, firstMessage: "first turn" } });
      await atGate;
      let sweeps = 0;
      let sweepPassed!: () => void;
      const fullSweep = new Promise<void>((resolve) => { sweepPassed = resolve; });
      const bareListTabs = f.manager.listTabs;
      f.manager.listTabs = () => { sweeps += 1; if (sweeps >= 2) sweepPassed(); return bareListTabs(); };
      await fullSweep;
      releaseWrite();
      const result = await created;
      expect((result as { isError?: boolean }).isError).toBeFalsy();
      expect(order.slice(0, order.indexOf("send"))).toEqual(["ready", "write"]);
      // The deadline did pass while the envelope was still unposted: the durable
      // snapshots show the expired detail before the accepted one.
      const expired = ledgers.findIndex((text) => text.includes("first turn") && text.includes("Host response unavailable; do not blindly resend"));
      const accepted = ledgers.findIndex((text) => text.includes("first turn") && text.includes("Host started a next turn"));
      expect(expired).toBeGreaterThan(-1);
      expect(accepted).toBeGreaterThan(expired);
      await vi.waitFor(() => expect((h.config.modelPort as ScriptedModelPort).requests).toHaveLength(1));
      expect(JSON.stringify((h.config.modelPort as ScriptedModelPort).requests[0])).toContain("first turn");
      expect(f.request.mock.calls.filter((c) => c[1] === "send_message")).toHaveLength(1);
    } finally { h.close(); }
  }, 20000);

  it("expires pending dispatch while reconciliation is blocked on a host", async () => {
    // The record's own deadline must fire without waiting for reconciliation:
    // here a sweep is parked on a host request the whole time.
    const f = await createFixture({ dispatchTimeoutMs: 80 });
    await f.client.callTool({ name: "create_session", arguments: { workspace: f.dir } });
    let releaseRestore!: () => void;
    let enteredRestore!: () => void;
    const held = new Promise<void>((resolve) => { releaseRestore = resolve; });
    const entered = new Promise<void>((resolve) => { enteredRestore = resolve; });
    let finish!: (value: any) => void;
    f.request.mockImplementation(async (_session, op, payload: any) => {
      if (op === "get_session_status") return { engine: "core", state: "idle" };
      if (op === "restore_agent_messages") { enteredRestore(); await held; return undefined; }
      if (op === "send_message") {
        if (payload.payload === "seed") return { envelope: payload, state: "rejected" };
        return await new Promise((resolve) => { finish = resolve; });
      }
      return undefined;
    });
    await f.client.callTool({ name: "send_message", arguments: { sessionId: "agent-1", payload: "seed", mode: "next_turn" } });
    await entered;
    const startedAt = Date.now();
    const pending = f.client.callTool({ name: "create_session", arguments: { workspace: f.dir, firstMessage: "hello" } });
    try {
      await vi.waitFor(async () => {
        const ledger = JSON.parse(await readFile(join(f.dir, "communication.json.messages"), "utf8"));
        expect(ledger.find((r: any) => r.envelope.payload === "hello")?.detail).toBe("Host response unavailable; do not blindly resend");
      }, { timeout: 4000, interval: 10 });
      // Its own deadline, not the next tick of a scanner: well inside one second.
      expect(Date.now() - startedAt).toBeLessThan(400);
    } finally {
      releaseRestore();
      finish?.({ state: "unknown", detail: "Host response unavailable; do not blindly resend" });
    }
    expect((await pending).isError).toBe(true);
  });

  it("reports a host generation lost during dispatch", async () => {
    const f = await createFixture();
    f.request.mockImplementation(async (_session, op, payload) => {
      if (op === "get_session_status") return { engine: "core", state: "idle" };
      if (op === "send_message") { f.tabs[0]!.pid++; return { envelope: payload, state: "queued" }; }
      return undefined;
    });
    const result = await f.client.callTool({ name: "create_session", arguments: { workspace: f.dir, firstMessage: "hello" } });
    expect(errorText(result)).toContain("Host restarted");
    const ledger = JSON.parse(await readFile(join(f.dir, "communication.json.messages"), "utf8"));
    expect(ledger[0].state).toBe("unknown");
  });

  it("does not retry after a post-dispatch ledger write fails", async () => {
    const f = await createFixture();
    f.request.mockImplementation(async (_session, op, payload) => {
      if (op === "get_session_status") return { engine: "core", state: "idle" };
      if (op === "send_message") {
        await rm(join(f.dir, "communication.json.messages"));
        await mkdir(join(f.dir, "communication.json.messages"));
        return { envelope: payload, state: "acknowledged" };
      }
      return undefined;
    });
    const result = await f.client.callTool({ name: "create_session", arguments: { workspace: f.dir, firstMessage: "hello" } });
    expect(result.isError).toBe(true);
    expect(f.request.mock.calls.filter((c) => c[1] === "send_message")).toHaveLength(1);
    await rm(join(f.dir, "communication.json.messages"), { recursive: true });
    f.request.mockImplementation(async (_session, op, payload) => op === "send_message" ? { envelope: payload, state: "acknowledged" } : undefined);
    await f.client.callTool({ name: "send_message", arguments: { sessionId: "agent-1", payload: "later", mode: "next_turn" } });
  });

  it("settles a host error with an explicit delivery error", async () => {
    const f = await createFixture();
    f.request.mockImplementation(async (_session, op, payload) => {
      if (op === "get_session_status") return { engine: "core", state: "idle" };
      if (op === "send_message") throw new Error("host error");
      return undefined;
    });
    const result = await f.client.callTool({ name: "create_session", arguments: { workspace: f.dir, firstMessage: "hello" } });
    expect(errorText(result)).toContain("Host response unavailable");
    expect(f.request.mock.calls.filter((c) => c[1] === "send_message")).toHaveLength(1);
    const ledger = JSON.parse(await readFile(join(f.dir, "communication.json.messages"), "utf8"));
    expect(ledger[0]).toMatchObject({ state: "unknown", detail: "Host response unavailable; do not blindly resend" });
  });

  it.each(["timeout", "disconnect"] as const)("settles %s through the host request boundary", async (failure) => {
    const snapshots: string[] = [];
    let expired!: () => void;
    const expiryWritten = new Promise<void>((resolve) => { expired = resolve; });
    const f = await createFixture({ dispatchTimeoutMs: 1_000, writeLedger: async (path, text) => {
      snapshots.push(text);
      await writePrivateFile(path, text);
      if (text.includes("Host response unavailable; do not blindly resend")) expired();
    } });
    const host = new EventEmitter() as EventEmitter & { postMessage: (message: any) => void };
    let posted!: () => void;
    const postedMessage = new Promise<void>((resolve) => { posted = resolve; });
    host.postMessage = (message) => {
      if (message.operation === "send_message") posted();
      if (message.operation === "get_session_status") {
        queueMicrotask(() => host.emit("message", { type: "communication_response", requestId: message.requestId, result: { engine: "core", state: "idle" } }));
      } else if (message.operation === "send_message" && failure === "disconnect") {
        queueMicrotask(() => host.emit("exit", 1));
      } else if (message.operation !== "send_message") {
        queueMicrotask(() => host.emit("message", { type: "communication_response", requestId: message.requestId, result: undefined }));
      }
    };
    const manager = { tabs: new Map([["tab-1", { sessionId: "agent-1", workspace: f.dir, state: "running", proc: host }]]) } as unknown as TabHostManager;
    let hostOutcome: Promise<unknown> | undefined;
    f.request.mockImplementation((session, op, payload) => {
      const request = TabHostManager.prototype.communicationRequest.call(manager, session, op, payload, f.dir);
      if (op === "send_message") hostOutcome = request.then(() => "resolved", (error: Error) => error.message);
      return request as never;
    });
    if (failure === "timeout") vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let settled = false;
      const pending = f.client.callTool({ name: "create_session", arguments: { workspace: f.dir, firstMessage: "hello" } }).then((result) => { settled = true; return result; });
      if (failure === "timeout") {
        await postedMessage;
        await vi.advanceTimersByTimeAsync(1_000);
        expect(snapshots.some((text) => text.includes("Host response unavailable; do not blindly resend"))).toBe(true);
        await expiryWritten;
        expect(settled).toBe(false);
        expect(host.listenerCount("message")).toBe(1);
        const expiredLedger = JSON.parse(await readFile(join(f.dir, "communication.json.messages"), "utf8"));
        expect(expiredLedger[0]).toMatchObject({ state: "unknown", detail: "Host response unavailable; do not blindly resend" });
        await vi.advanceTimersByTimeAsync(19_000);
        expect(await hostOutcome).toBe("Host response timed out; delivery unknown");
      }
      const result = await pending;
      expect(errorText(result)).toContain("Host response unavailable");
      const ledger = JSON.parse(await readFile(join(f.dir, "communication.json.messages"), "utf8"));
      expect(ledger[0]).toMatchObject({ state: "unknown", detail: "Host response unavailable; do not blindly resend" });
      expect(host.listenerCount("message")).toBe(0);
      expect(host.listenerCount("exit")).toBe(0);
    } finally {
      if (failure === "timeout") vi.useRealTimers();
    }
  }, 30000);

  it("create_session: returns without messageId when the host never becomes ready", async () => {
    const f = await createFixture({ ready: false });
    const created = await f.client.callTool({ name: "create_session", arguments: { workspace: f.dir, firstMessage: "hello" } });
    expect(errorText(created)).toMatch(/^create_session not_ready/);
    expect(f.request.mock.calls.filter((c) => c[1] === "send_message")).toHaveLength(0);
  });

  it("create_session: firstMessage to a session outside the folders list is an explicit error, not a silent messageId omit (Taskana 4808, review F1)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "anycode-create-f1a-")); cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const other = await mkdtemp(join(tmpdir(), "anycode-create-f1b-")); cleanups.push(() => rm(other, { recursive: true, force: true }));
    const discoveryFile = join(dir, "communication.json");
    const tabs: Array<{ sessionId: string; workspace: string; state: string; pid: number }> = [];
    const request = vi.fn(async (_session: string, op: string, payload?: unknown) => {
      if (op === "get_session_status") return { engine: "core", state: "idle" };
      if (op === "send_message") return { envelope: payload, state: "queued" };
      return undefined;
    });
    // Restricted server (folders = [dir]) whose creator lands the tab in `other` — the
    // orphan F1 describes: the tab exists but list_sessions/send_message cannot see it.
    const service = await startCommunicationServer({
      manager: { listTabs: () => tabs, communicationRequest: request }, userData: dir, config: { workspaces: [dir], discoveryFile },
      createSessionByAgent: async () => { tabs.push({ sessionId: "orphan-1", workspace: other, state: "running", pid: 100 }); return { ok: true, sessionId: "orphan-1", tabId: "tab-1" }; },
      readyTimeoutMs: 150, readyPollMs: 10,
    });
    cleanups.push(() => service.close());
    const discovery = JSON.parse(await readFile(discoveryFile, "utf8")) as { url: string; token: string };
    const client = new Client({ name: "create-f1", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(discovery.url), { requestInit: { headers: { Authorization: `Bearer ${discovery.token}` } } }));
    cleanups.push(() => client.close());
    const result = await client.callTool({ name: "create_session", arguments: { workspace: dir, firstMessage: "hello" } });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(errorText(result)).toMatch(/^create_session not_allowed: /);
    // The tab ids are never lost: the error names the created session and tab.
    expect(errorText(result)).toContain("orphan-1");
    expect(errorText(result)).toContain("tab-1");
    expect(request.mock.calls.filter((c) => c[1] === "send_message")).toHaveLength(0);
  });

  it("create_session: not_allowed for a workspace outside a non-empty folders list (restricted branch)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "anycode-create-res-")); cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const outside = await mkdtemp(join(tmpdir(), "anycode-create-out-")); cleanups.push(() => rm(outside, { recursive: true, force: true }));
    const discoveryFile = join(dir, "communication.json");
    const creator = vi.fn(async () => ({ ok: true as const, sessionId: "never", tabId: "never" }));
    const request = vi.fn(async () => undefined);
    const service = await startCommunicationServer({
      manager: { listTabs: () => [], communicationRequest: request }, userData: dir, config: { workspaces: [dir], discoveryFile },
      createSessionByAgent: creator, readyTimeoutMs: 100, readyPollMs: 10,
    });
    cleanups.push(() => service.close());
    const discovery = JSON.parse(await readFile(discoveryFile, "utf8")) as { url: string; token: string };
    const client = new Client({ name: "create-restricted", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(discovery.url), { requestInit: { headers: { Authorization: `Bearer ${discovery.token}` } } }));
    cleanups.push(() => client.close());
    const result = await client.callTool({ name: "create_session", arguments: { workspace: outside } });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(errorText(result)).toMatch(/^create_session not_allowed/);
    // Refused before any tab was opened and before any host call.
    expect(creator).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    // The same workspace inside the list is not refused on this branch.
    expect(value(await client.callTool({ name: "create_session", arguments: { workspace: dir } })).sessionId).toBe("never");
  });

  // ── create_session effort (Sessions API) ────────────────────────────────
  it("advertises and forwards create_session effort", async () => {
    const seen: CreateSessionRequest[] = [];
    const f = await createFixture({
      creator: async (input) => {
        seen.push(input);
        return { ok: true, sessionId: "effort-1", tabId: "tab-1" };
      },
    });
    const tool = (await f.client.listTools()).tools.find((t) => t.name === "create_session")!;
    // Advertised as a plain string: the allowed values are MODEL-dependent, so
    // a static enum here would be a lie for every native engine.
    expect(tool.inputSchema).toMatchObject({
      properties: { effort: { type: "string" } },
      additionalProperties: false,
    });
    expect((tool.inputSchema as unknown as { properties: Record<string, unknown> }).properties.effort).not.toHaveProperty("enum");

    const created = value(await f.client.callTool({ name: "create_session", arguments: { workspace: f.dir, engine: "codex", model: "gpt-6.1-terra", effort: "xhigh" } }));
    expect(created.sessionId).toBe("effort-1");
    // Forwarded UNCHANGED — no trimming, no case folding, no enum check in main.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ engine: "codex", model: "gpt-6.1-terra", effort: "xhigh" });

    // Omitting it stays an omission (the engine's own default applies).
    value(await f.client.callTool({ name: "create_session", arguments: { workspace: f.dir } }));
    expect(seen[1]).not.toHaveProperty("effort");
  });

  it("returns invalid_effort with allowed levels verbatim", async () => {
    const detail = 'engine=codex; model="gpt-6.1-terra"; effort="turbo"; allowed=["low","medium","high","xhigh"]; reason=not_advertised';
    const f = await createFixture({ creator: async () => ({ ok: false, reason: "invalid_effort", detail }) });
    const result = await f.client.callTool({ name: "create_session", arguments: { workspace: f.dir, engine: "codex", model: "gpt-6.1-terra", effort: "turbo" } });

    expect((result as { isError?: boolean }).isError).toBe(true);
    // The COMPLETE text, including the fixed code sentence and the host's own
    // detail: the allowed list is what lets a client correct itself.
    expect(errorText(result)).toBe(`create_session invalid_effort: reasoning effort is not supported — ${detail}`);
  });

  it("invalid effort refusals do not consume the creation rate budget", async () => {
    const clock = { now: 1_000_000 };
    let refuse = true;
    const f = await createFixture({
      clock,
      creator: async () => (refuse
        ? { ok: false, reason: "invalid_effort", detail: "engine=codex; model=\"gpt-6.1-terra\"; effort=\"turbo\"; allowed=[\"low\"]; reason=not_advertised" }
        : { ok: true, sessionId: "after-refusals", tabId: "tab-after" }),
    });
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const refused = await f.client.callTool({ name: "create_session", arguments: { workspace: f.dir, effort: "turbo" } });
      expect((refused as { isError?: boolean }).isError).toBe(true);
      expect(errorText(refused)).toMatch(/^create_session invalid_effort: /);
    }
    refuse = false;
    // Eight refusals in the SAME window still leave the full budget: only a
    // successful creation is charged.
    expect(value(await f.client.callTool({ name: "create_session", arguments: { workspace: f.dir, effort: "high" } })).sessionId).toBe("after-refusals");
  });

  it("delivers firstMessage only after effort preparation succeeds", async () => {
    // Invalid effort: the caller gets the classified refusal, and the message
    // was never handed to a session that does not exist.
    const detail = 'engine=codex; model="gpt-6.1-terra"; effort="turbo"; allowed=["low"]; reason=not_advertised';
    const invalid = await createFixture({ creator: async () => ({ ok: false, reason: "invalid_effort", detail }) });
    const refused = await invalid.client.callTool({ name: "create_session", arguments: { workspace: invalid.dir, effort: "turbo", firstMessage: "hello" } });
    expect((refused as { isError?: boolean }).isError).toBe(true);
    expect(invalid.request.mock.calls.filter((call) => call[1] === "send_message")).toHaveLength(0);

    // Preparation that could not complete (a timeout/control failure on the
    // host side) is not_ready — and equally delivers nothing.
    const timedOut = await createFixture({ creator: async () => ({ ok: false, reason: "not_ready", detail: "the new session could not confirm its reasoning effort" }) });
    const failed = await timedOut.client.callTool({ name: "create_session", arguments: { workspace: timedOut.dir, effort: "high", firstMessage: "hello" } });
    expect((failed as { isError?: boolean }).isError).toBe(true);
    expect(errorText(failed)).toMatch(/^create_session not_ready: /);
    expect(timedOut.request.mock.calls.filter((call) => call[1] === "send_message")).toHaveLength(0);
    expect(timedOut.tabs).toEqual([]);
  });

  it("send_message schema errors name sessionId, payload and mode instead of a zod issue list", async () => {
    const f = await fixture();
    const result = await f.client.callTool({ name: "send_message", arguments: { sessionId: "allowed" } });
    const text = errorText(result);
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(text).toMatch(/payload/);
    expect(text).toMatch(/next_turn/);
    expect(text.startsWith("[")).toBe(false);
  });
});
