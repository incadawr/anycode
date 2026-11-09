import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { MessagePortMain, UtilityProcess } from "electron";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "@anycode/core";
import { Client, StreamableHTTPClientTransport } from "@anycode/core/communication-mcp";
import { TabHostManager, type HostForkFn } from "./tabs.js";
import { startCommunicationServer } from "./communication-server.js";
import { createHarness } from "../host/test-harness.js";
import { startHostWithActivity } from "../host/activity-forwarding.js";
import { CORE_ENGINE_CAPABILITIES, type SessionEngine } from "../host/engines/session-engine.js";

const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const value = (result: unknown): any => JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text);

/** A real host session whose activity is forwarded into a real tab manager and served over the public MCP tools. */
async function rig() {
  const dir = await mkdtemp(join(tmpdir(), "anycode-network-api-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const queue: AgentEvent[] = [];
  let wake: (() => void) | undefined;
  let finish = false;
  const engine: SessionEngine = {
    id: "core", capabilities: CORE_ENGINE_CAPABILITIES, mode: () => "build", reasoningEffort: () => undefined,
    setReasoningEffort: () => {}, historyItems: () => [], dispose: async () => {},
    async *runTurn() {
      finish = false;
      while (!finish) {
        if (queue.length) yield queue.shift()!;
        else await new Promise<void>((resolve) => { wake = resolve; });
      }
      yield { type: "loop_end", reason: "completed", turns: 1 };
    },
  };
  const h = createHarness({ steps: [], engine });
  cleanups.push(() => h.close());
  const push = (event: AgentEvent) => { queue.push(event); wake?.(); wake = undefined; };
  const stop = () => { finish = true; wake?.(); };
  cleanups.push(stop);
  const hostReplies = { enabled: true };
  const proc = Object.assign(new EventEmitter(), { pid: 123, kill: () => true, postMessage: (message: any) => {
    if (hostReplies.enabled && message.operation === "get_session_status") {
      queueMicrotask(() => proc.emit("message", { type: "communication_response", requestId: message.requestId, result: h.session.communicationStatus() }));
    }
  } });
  const manager = new TabHostManager({ fork: (() => proc as unknown as UtilityProcess) as HostForkFn,
    hostEntry: "/fake/host.js", createChannel: () => ({ port1: {} as MessagePortMain, port2: {} as MessagePortMain }),
    getWindow: () => null, env: () => ({}), engineEnv: () => ({}), engineReady: () => true,
    logger: { log: () => {}, warn: () => {}, error: () => {} } });
  manager.createTab({ workspace: dir, sessionId: "net-session", resume: false });
  await startHostWithActivity(async () => {}, () => h.session, (message) => proc.emit("message", message));
  const service = await startCommunicationServer({ manager, userData: dir, config: { workspaces: [dir], discoveryFile: join(dir, "endpoint.json") } });
  cleanups.push(() => service.close());
  const discovery = JSON.parse(await readFile(service.discoveryFile, "utf8")) as { url: string; token: string };
  const client = new Client({ name: "network-api-test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(discovery.url), { requestInit: { headers: { Authorization: `Bearer ${discovery.token}` } } }));
  cleanups.push(() => client.close());
  const view = async () => ({
    row: value(await client.callTool({ name: "list_sessions", arguments: {} })).sessions[0],
    status: value(await client.callTool({ name: "get_session_status", arguments: { sessionId: "net-session" } })),
  });
  const settled = async (state: string, wait?: (n: any) => boolean) => {
    // Activity forwarding is asynchronous; wait for main's cache before reading both tools.
    await h.waitUntil(() => h.session.communicationStatus().state === state);
    const deadline = Date.now() + 2_000;
    for (;;) {
      const v = await view();
      if (v.row.state === state && v.status.state === state && (!wait || (wait(v.row.networkWait) && wait(v.status.networkWait)))) return v;
      if (Date.now() > deadline) return v;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  return { h, push, stop, view, settled, hostReplies };
}

describe("session network wait through the public session tools", () => {
  it("reports start, overlapping waits, one recovery and the final recovery", async () => {
    const { h, push, stop, view, settled } = await rig();
    expect((await view()).status).toMatchObject({ state: "idle", turnStartedAt: null, lastProviderActivityAt: null });
    h.send({ type: "user_message", requestId: "one", text: "hello" });
    await h.waitUntil(() => h.session.communicationStatus().state === "running");
    let v = await settled("running");
    expect(typeof v.status.turnStartedAt).toBe("number");
    expect(v.status.lastProviderActivityAt).toBeNull();
    expect(v.row).not.toHaveProperty("networkWait");

    push({ type: "waiting_for_network", waitId: "p", startedAt: 20, deadlineAt: 90, failureCode: "network" });
    v = await settled("waiting_network", (n) => n?.startedAt === 20);
    expect(v.row.networkWait).toEqual({ source: "parent", startedAt: 20, deadlineAt: 90, failureCode: "network" });
    expect(v.status.networkWait).toEqual(v.row.networkWait);

    push({ type: "waiting_for_network", waitId: "a", startedAt: 10, waitSource: "subagent", failureCode: "secret-token" });
    push({ type: "waiting_for_network", waitId: "b", startedAt: 30, waitSource: "subagent" });
    v = await settled("waiting_network", (n) => n?.startedAt === 10);
    expect(v.status.networkWait).toEqual({ source: "subagent", startedAt: 10 });

    push({ type: "network_wait_end", waitId: "a", outcome: "recovered" });
    v = await settled("waiting_network", (n) => n?.startedAt === 20);
    expect(v.row.networkWait).toMatchObject({ source: "parent", startedAt: 20 });

    push({ type: "network_wait_end", waitId: "p", outcome: "recovered" });
    v = await settled("waiting_network", (n) => n?.startedAt === 30);
    expect(v.status.networkWait).toEqual({ source: "subagent", startedAt: 30 });

    push({ type: "network_wait_end", waitId: "b", outcome: "recovered" });
    v = await settled("running");
    expect(v.row).not.toHaveProperty("networkWait");
    expect(v.status).not.toHaveProperty("networkWait");
    expect(v.status.lastProviderActivityAt).toBeNull();

    stop();
    v = await settled("idle");
    expect(v.status).toMatchObject({ turnStartedAt: null, lastProviderActivityAt: null });
    expect(v.status).not.toHaveProperty("networkWait");
  });

  it("serves the cached wait when the host does not answer", async () => {
    const { h, push, stop, view, settled, hostReplies } = await rig();
    h.send({ type: "user_message", requestId: "one", text: "hello" });
    await h.waitUntil(() => h.session.communicationStatus().state === "running");
    push({ type: "waiting_for_network", waitId: "p", startedAt: 20, deadlineAt: 90, failureCode: "network" });
    await settled("waiting_network", (n) => n?.startedAt === 20);
    hostReplies.enabled = false;
    const { row, status } = await view();
    expect(status).toMatchObject({ state: "waiting_network", networkWait: { source: "parent", startedAt: 20, deadlineAt: 90, failureCode: "network" } });
    expect(row.networkWait).toEqual(status.networkWait);
    hostReplies.enabled = true;
    stop();
    expect((await settled("idle")).status).not.toHaveProperty("networkWait");
  }, 15_000);
});
