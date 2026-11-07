import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SessionPermissionRules, type ModelStreamEvent } from "@anycode/core";
import { createHarness, MemFs, textStep } from "./test-harness.js";
import { Outbound, Session } from "./session.js";
import { IpcPermissionBroker } from "./permission-broker.js";
import { CodexEngine } from "./engines/codex/codex-engine.js";
import { FakeAppServer, THREAD } from "./engines/codex/test-app-server.js";
import { ClaudeEngine, type ClaudeTransport } from "./engines/claude/claude-engine.js";
import type { ClaudeStreamMessage } from "./engines/claude/protocol.js";
import { createSessionPeerBridge } from "./engines/session-peer-bridge.js";
import { createSessionPeersPort } from "./session-peers-port.js";
import { createSessionPeerDrainTransport } from "./session-peer-drain.js";
import { createCommunicationBroker } from "../main/communication-broker.js";
import { createSessionPeersHandler, type PeerHost } from "../main/session-peers.js";
import { createSessionPeerOpener } from "../main/session-peer-open.js";
import { createSessionAccessStore } from "../main/communication-sessions.js";
import type { CreateSessionByAgentDeps } from "../main/create-session-by-agent.js";
import { createSessionPeerAccess } from "../main/session-peer-access.js";
import { createSessionPeerPolicyStore } from "../main/session-peer-policy.js";
import { createSessionPeerReplies } from "../main/session-peer-replies.js";
import { createSessionPeerReplyCoordinator } from "../main/session-peer-reply-coordinator.js";
import { createSessionPeerDrain } from "../main/session-peer-drain.js";
import { createSessionPeerTurns } from "../main/session-peer-turns.js";
import type { AgentDelivery, AgentEnvelope } from "../shared/communication.js";
import type { SessionPeerTurnEvent } from "../shared/session-peers.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const engines = ["core", "claude", "codex"] as const;
const pairs = engines.flatMap(a => engines.map(b => [a, b] as const));

/** Only provider/CLI bytes are scripted; engines and Session remain production objects. */
function endpoint(id: string, kind: PeerHost["engine"], workspace: string) {
  const requests: unknown[] = [];
  const finishes: Array<(answer: string) => void> = [];
  const base = createHarness({ steps: [] });
  cleanups.push(async () => base.close());
  base.config.modelPort = { streamText(request) {
    requests.push(request);
    return (async function* (): AsyncIterable<ModelStreamEvent> {
      const answer = await new Promise<string>(resolve => finishes.push(resolve));
      yield* textStep(answer);
    })();
  } };
  const server = new FakeAppServer();
  const send = server.request.bind(server);
  server.request = async (method, params, options) => {
    if (method === "turn/start") {
      requests.push(params);
      finishes.push(answer => {
        server.stream.push({ method: "item/agentMessage/delta", params: { threadId: THREAD, turnId: server.turnId, itemId: "answer", delta: answer } });
        server.completeTurn("completed");
      });
    }
    return send(method, params, options);
  };
  const frames: ClaudeStreamMessage[] = [];
  let waiter: ((v: IteratorResult<ClaudeStreamMessage>) => void) | undefined;
  const push = (value: ClaudeStreamMessage) => { if (waiter) { const next = waiter; waiter = undefined; next({ value, done: false }); } else frames.push(value); };
  const transport: ClaudeTransport = {
    initialize: async () => ({ commands: [], models: [], account: {} }), controlRequest: async <T>() => ({} as T),
    getContextUsage: async () => ({}), interrupt: async () => ({ stillQueued: [] }),
    sendUserMessage(content) {
      requests.push(content);
      finishes.push(answer => {
        push({ type: "assistant", message: { model: "fixture", role: "assistant", content: [{ type: "text", text: answer }] } } as ClaudeStreamMessage);
        push({ type: "result", subtype: "success", result: answer, is_error: false, session_id: id, duration_ms: 1, duration_api_ms: 1, num_turns: 1, total_cost_usd: 0, usage: {} } as ClaudeStreamMessage);
      });
    },
    notifications: () => ({ [Symbol.asyncIterator]: () => ({ next: () => frames.length
      ? Promise.resolve({ value: frames.shift()!, done: false }) : new Promise(resolve => { waiter = resolve; }) }) }),
    close: async () => { waiter?.({ value: undefined, done: true }); },
  };
  const engine = kind === "core" ? base.engine : kind === "codex" ? new CodexEngine(server, THREAD) : new ClaudeEngine(transport, id);
  const session = new Session({ engine, outbound: new Outbound(), broker: new IpcPermissionBroker(() => {}),
    fs: new MemFs(), workspace, sessionId: id, model: "fixture", rules: new SessionPermissionRules(),
    persistence: { touch: async () => {}, commitTitle: async () => {} } });
  cleanups.push(async () => { session.closeAdmissions(); for (const finish of finishes.splice(0)) finish("cleanup"); await session.shutdown(); });
  return { session, requests, finishes };
}

async function fixture(a: PeerHost["engine"] = "core", b: PeerHost["engine"] = "codex", generation = 1) {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "peer-integration-")));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const other = join(dir, "other"); await mkdir(other);
  const hosts: PeerHost[] = [a, b].map((engine, i) => ({ sessionId: i ? "b" : "a", tabId: i ? "b" : "a", proc: {}, generation,
    workspace: i ? other : dir, workspaceKey: i ? other : dir, live: true, root: true, restricted: false, readOnly: false, engine, activity: "idle" }));
  const ends = hosts.map(h => endpoint(h.sessionId, h.engine, h.workspace));
  const policy = createSessionPeerPolicyStore({ file: join(dir, "policy") });
  expect(policy.setPairGrant(dir, other, true)).toBe(true);
  const access = createSessionPeerAccess({ policy, enabled: () => true, isTrusted: async () => true, realpathSync, statSync });
  const current = (id: string) => hosts.find(h => h.sessionId === id);
  const tabs = () => hosts.map(h => ({ sessionId: h.sessionId, workspace: h.workspace, pid: h.generation, state: "running" }));
  let terminal: (id: string, event: SessionPeerTurnEvent) => void = () => {};
  let delivery: (id: string, value: AgentDelivery) => void = () => {};
  const post = vi.fn(async (id: string, operation: string, payload?: unknown) => {
    if (operation !== "send_message") return {};
    const envelope = payload as AgentEnvelope, record = broker.ledger.messages.get(envelope.messageId)!;
    const sender = current(record.principal!.kind === "session" ? record.principal!.sessionId : "")!;
    const recipient = current(id)!;
    expect(drain.register(record, sender, recipient)).toBe(true);
    turns.expectMessage(recipient.proc!, envelope.messageId);
    return ends[hosts.indexOf(recipient)]!.session.receiveAgentMessage(envelope, true);
  });
  const options = { ledgerFile: join(dir, "ledger"), nativeSessionsEnabled: true,
    manager: { listTabs: tabs, communicationRequest: post,
      onSessionPeerTerminal: (fn: typeof terminal) => { terminal = fn; return () => { terminal = () => {}; }; },
      onCommunicationDelivery: (fn: typeof delivery) => { delivery = fn; return () => { delivery = () => {}; }; } } };
  const broker = await createCommunicationBroker(options); cleanups.push(() => broker.dispose());
  const drain = createSessionPeerDrain({ lookup: id => broker.ledger.messages.get(id), current, access, prepare: async () => {} });
  cleanups.push(async () => drain.dispose());
  const turns = createSessionPeerTurns();
  const authorize = (caller: PeerHost) => async (id: string) => {
    const target = current(id)!;
    if (!await access.canAccess(caller, target, "send")) throw new Error("refused");
    return { ...target, pid: target.generation, state: "running" };
  };
  const coordinator = createSessionPeerReplyCoordinator(broker, { current,
    sendAuto: (caller, source, payload) => replies.auto(caller, source, payload, authorize(caller)) });
  const replies = createSessionPeerReplies(broker, Date.now, coordinator);
  const prepare = vi.fn(async () => {});
  const openers = new Map<string, string>();
  const fork = vi.fn(async (input: any) => {
    const host = { ...hosts[0]!, ...input, tabId: input.sessionId, proc: {}, generation: 1 };
    hosts.push(host); ends.push(endpoint(host.sessionId, host.engine, host.workspace));
    doors.push(connect(host, ends.length - 1));
    return { ok: true, tab: host };
  });
  const manager = { atCapacity: () => false, createTabAwaitingInitialSpawn: fork,
    deliverTabPort: vi.fn(), publishPreparedTab: () => true,
    communicationRequest: vi.fn(async () => ({ ok: true })) };
  const creator = { projects: { isAllowed: () => false }, manager: () => manager,
    sessions: () => createSessionAccessStore({ file: join(dir, "sessions"), defaultOn: () => false }), realpathSync,
    readTrustStore: async () => ({ folders: { [dir]: { decision: "trusted" }, [other]: { decision: "trusted" } } }),
    mcpSecretPrime: async () => {}, currentSettings: () => ({ provider: { connections: [] } }),
    primeNewSessionPin: async () => ({ ok: true, release: () => {} }),
    randomUUID: () => `opened-${hosts.length}`, agentOpenedSessions: new Set<string>(),
    agentSessionOpeners: openers, agentSessionTitles: new Map(), listTabs: tabs,
  } as unknown as CreateSessionByAgentDeps;
  const handler = createSessionPeersHandler({ open: createSessionPeerOpener(creator), current, targets: () => hosts, access, prepare, send: (caller, input, authorizePeer) => replies.send(caller, input, async id => { const host = await authorizePeer(id); return { ...host, pid: host.generation, state: "running" }; }) });
  const terminals: SessionPeerTurnEvent[] = [];
  let terminalGeneration = generation;
  const connect = (host: PeerHost, i: number) => {
    const port = createSessionPeersPort((message: any) => {
      void handler(host.tabId, host.proc!, message.request).then(result => port.handle({ type: "session_peers_response", requestId: message.request.requestId, result }));
    });
    const wire = createSessionPeerDrainTransport((request: any) => {
      if (request.type === "session_peer_drain_release") drain.release(host.proc!, request);
      else void drain.request(host.proc!, request).then(permit => { if (permit) wire.handle(permit); else wire.disconnect(); });
    }, { recipientSessionId: host.sessionId, generation: host.generation });
    ends[i]!.session.configurePeerDrain(wire);
    ends[i]!.session.observeAgentDeliveries(value => delivery(host.sessionId, value));
    ends[i]!.session.observePeerTurns(event => {
      const accepted = turns.accept(host, host.proc!, { ...event, generation: host.generation });
      if (!accepted) return;
      host.turnContext = turns.active(host.proc!);
      if (accepted.type === "session_peer_terminal") {
        const emitted = { ...accepted, generation: terminalGeneration };
        terminals.push(emitted); terminal(host.sessionId, emitted);
      }
    });
    cleanups.push(async () => { port.dispose(); wire.dispose(); });
    const permission = { requestPermission: vi.fn(async () => ({ behavior: "allow" as const })) };
    const authority = { mode: "yolo" as "yolo" | "plan", root: true, orchestrate: false };
    const bridge = createSessionPeerBridge({ port, cwd: host.workspace, broker: permission, authority: () => authority });
    return { call: (name: string, input: unknown) => bridge.call(name, input, new AbortController().signal, "call"), authority, permission, port };
  };
  const doors = hosts.map(connect);
  return { dir, other, hosts, ends, broker, drain, policy, doors, post, prepare, options, openers, fork, manager, creator, terminals, terminalGeneration: (value: number) => { terminalGeneration = value; } };
}

it.each(pairs)("%s → %s automatic public result reaches the next native request, idle and busy", async (a, b) => {
  const f = await fixture(a, b), [sender, recipient] = f.ends;
  for (const busy of [false, true]) {
    if (busy) {
      await sender!.session.receiveAgentMessage({ messageId: "human", sender: "fixture", recipientSessionId: "a", payload: "busy", mode: "next_turn", kind: "agent_message", createdAt: new Date().toISOString() });
      await vi.waitFor(() => expect(sender!.finishes).toHaveLength(1));
    }
    const before = sender!.requests.length;
    const result = await f.doors[0]!.call("SessionSend", { sessionId: "b", payload: "question", reply: "on_turn_end" });
    expect(result).toMatchObject({ ok: true, output: { status: "sent" } });
    await vi.waitFor(() => expect(recipient!.finishes).toHaveLength(1));
    const source = [...f.broker.ledger.messages.values()].at(-1)!;
    expect(source.envelope).toMatchObject({ sender: "session:a", principal: { kind: "session", sessionId: "a", tabId: "a" } });
    const nonce = `reply-${a}-${b}-${busy}`;
    recipient!.finishes.shift()!(nonce);
    await vi.waitFor(() => expect(source.subscription?.state).toBe("auto"));
    const auto = f.broker.ledger.messages.get(source.subscription!.messageId!)!;
    expect(auto.subscription).toBeUndefined();
    if (busy) { expect(sender!.requests).toHaveLength(before); sender!.finishes.shift()!("busy done"); }
    await vi.waitFor(() => expect(sender!.requests).toHaveLength(before + 1));
    expect(JSON.stringify(sender!.requests.at(-1))).toContain(nonce);
    await vi.waitFor(() => expect(sender!.finishes).toHaveLength(1));
    sender!.finishes.shift()!("received");
    await vi.waitFor(() => expect(sender!.session.communicationStatus().state).toBe("idle"));
    expect(f.broker.ledger.messages.size).toBe(busy ? 4 : 2);
  }
});

it("awaits pair access and refuses an ungranted workspace before durable acceptance", async () => {
  const f = await fixture(); f.policy.setPairGrant(f.dir, f.other, false);
  expect(await f.doors[0]!.call("SessionSend", { sessionId: "b", payload: "forbidden" })).toMatchObject({ output: { status: "refused" } });
  expect(f.post).not.toHaveBeenCalled(); expect(f.broker.ledger.messages.size).toBe(0);
});

it("revocation while the automatic result is queued prevents the next model request", async () => {
  const f = await fixture();
  await f.ends[0]!.session.receiveAgentMessage({ messageId: "busy", sender: "fixture", recipientSessionId: "a", payload: "busy", mode: "next_turn", kind: "agent_message", createdAt: new Date().toISOString() });
  await vi.waitFor(() => expect(f.ends[0]!.finishes).toHaveLength(1));
  await f.doors[0]!.call("SessionSend", { sessionId: "b", payload: "question", reply: "on_turn_end" });
  await vi.waitFor(() => expect(f.ends[1]!.finishes).toHaveLength(1));
  f.ends[1]!.finishes.shift()!("must not wake");
  await vi.waitFor(() => expect([...f.broker.ledger.messages.values()].at(-1)?.state).toBe("queued"));
  const auto = [...f.broker.ledger.messages.values()].at(-1)!;
  f.policy.setPairGrant(f.dir, f.other, false); f.ends[0]!.finishes.shift()!("done");
  await vi.waitFor(() => expect(f.ends[0]!.session.agentMessageStatus(auto.envelope.messageId)?.state).toBe("rejected"));
  expect(f.ends[0]!.requests).toHaveLength(1);
});

it("plan and child authority cannot escape through the peer tool", async () => {
  const f = await fixture(), door = f.doors[0]!;
  door.authority.mode = "plan";
  expect((await door.call("SessionSend", { sessionId: "b", payload: "plan" })).ok).toBe(false);
  door.authority.mode = "yolo"; door.authority.root = false;
  expect((await door.call("SessionSend", { sessionId: "b", payload: "child" })).ok).toBe(false);
  expect(f.post).not.toHaveBeenCalled();
});

it("orchestrate asks once and a denial never reaches the broker", async () => {
  const f = await fixture(), door = f.doors[0]!;
  door.authority.orchestrate = true;
  door.permission.requestPermission.mockResolvedValueOnce({ behavior: "deny" } as never);
  expect((await door.call("SessionSend", { sessionId: "b", payload: "denied" })).ok).toBe(false);
  expect(door.permission.requestPermission).toHaveBeenCalledTimes(1); expect(f.post).not.toHaveBeenCalled();
  expect(await door.call("SessionSend", { sessionId: "b", payload: "allowed" })).toMatchObject({ output: { status: "sent" } });
  expect(door.permission.requestPermission).toHaveBeenCalledTimes(2); expect(f.post).toHaveBeenCalledTimes(1);
});

it("re-pins a relocated caller after preparation", async () => {
  const f = await fixture();
  f.prepare.mockImplementationOnce(async () => { f.hosts[0]!.workspace = f.other; f.hosts[0]!.workspaceKey = f.other; });
  expect(await f.doors[0]!.call("SessionsList", {})).toMatchObject({ output: { status: "refused" } });
  expect(f.post).not.toHaveBeenCalled();
});

it("model omitted replyTo preserves the automatic wake chain and its hop limit", async () => {
  const f = await fixture();
  await f.doors[0]!.call("SessionSend", { sessionId: "b", payload: "question", reply: "on_turn_end" });
  await vi.waitFor(() => expect(f.ends[1]!.finishes).toHaveLength(1)); f.ends[1]!.finishes.shift()!("wake");
  await vi.waitFor(() => expect(f.ends[0]!.requests).toHaveLength(1));
  const auto = [...f.broker.ledger.messages.values()].at(-1)!; auto.peer!.hop = 8;
  expect(auto.subscription).toBeUndefined();
  expect(await f.doors[0]!.call("SessionSend", { sessionId: "b", payload: "reset", reply: "on_turn_end" })).toMatchObject({ output: { status: "refused", reason: "loop_limited" } });
  expect(f.post).toHaveBeenCalledTimes(2);
});

it.each([false, true])("new broker reads the saved journal without replay, auto accepted=%s", async accepted => {
  const f = await fixture();
  await f.doors[0]!.call("SessionSend", { sessionId: "b", payload: "question", reply: "on_turn_end" });
  const source = [...f.broker.ledger.messages.values()][0]!;
  if (accepted) {
    await vi.waitFor(() => expect(f.ends[1]!.finishes).toHaveLength(1)); f.ends[1]!.finishes.shift()!("wake");
    await vi.waitFor(() => expect(source.subscription?.state).toBe("auto"));
  }
  await f.broker.ledger.flush();
  const restarted = await createCommunicationBroker(f.options); cleanups.push(() => restarted.dispose());
  const saved = restarted.ledger.messages.get(source.envelope.messageId)!;
  expect(saved.envelope).toMatchObject({ sender: "session:a", principal: { kind: "session", sessionId: "a", tabId: "a" } });
  expect(saved.principal).toEqual({ kind: "session", sessionId: "a", tabId: "a" });
  expect(saved.subscription?.state).toBe(accepted ? "auto" : "unknown");
  const count = f.post.mock.calls.length;
  await restarted.reconcile(); expect(f.post.mock.calls.slice(count).every(call => call[1] !== "send_message")).toBe(true);
});

it("root SessionOpen reaches the admitted creator with caller defaults and opener identity", async () => {
  const f = await fixture("codex");
  expect(await f.doors[0]!.call("SessionOpen", {})).toEqual({ ok: true, output: { status: "opened", sessionId: "opened-2", tabId: "opened-2" } });
  expect(f.fork).toHaveBeenCalledWith(expect.objectContaining({ workspace: f.dir, engine: "codex", resume: false }));
  expect(f.openers.get("opened-2")).toBe("a");
  expect(await f.doors[0]!.call("SessionOpen", { engine: "claude", model: "offered", effort: "high" })).toMatchObject({ output: { status: "opened" } });
  expect(f.manager.communicationRequest.mock.calls).toEqual(expect.arrayContaining([
    expect.arrayContaining(["set_session_model", { model: "offered" }]),
    expect.arrayContaining(["set_session_effort", { effort: "high" }]),
  ]));
  for (let i = 0; i < 3; i++) expect(await f.doors[0]!.call("SessionOpen", {})).toMatchObject({ output: { status: "opened" } });
  expect(await f.doors[0]!.call("SessionOpen", {})).toMatchObject({ output: { status: "refused" } });
  expect(f.fork).toHaveBeenCalledTimes(5);
});
it("open refuses cross workspace without target opt-in and caller posture escapes", async () => {
  const f = await fixture();
  expect(await f.doors[0]!.call("SessionOpen", { workspace: f.other })).toMatchObject({ output: { status: "refused" } });
  for (const patch of [{ readOnly: true }, { root: false }, { restricted: true }]) {
    Object.assign(f.hosts[0]!, patch);
    expect(await f.doors[0]!.call("SessionOpen", {})).toMatchObject({ output: { status: "refused" } });
    Object.assign(f.hosts[0]!, { readOnly: false, root: true, restricted: false });
  }
  expect(f.fork).not.toHaveBeenCalled();
});

it("drops a stale terminal from the same process after a generation change", async () => {
  const f = await fixture("core", "codex", 2);
  f.terminalGeneration(1);
  await f.doors[0]!.call("SessionSend", { sessionId: "b", payload: "stale", reply: "on_turn_end" });
  const source = [...f.broker.ledger.messages.values()][0]!;
  await vi.waitFor(() => expect(f.ends[1]!.finishes).toHaveLength(1));
  f.ends[1]!.finishes.shift()!("stale-answer");
  await vi.waitFor(() => expect(f.terminals).toHaveLength(1));
  expect(f.terminals[0]).toMatchObject({ generation: 1 });
  f.terminalGeneration(2);
  await f.doors[0]!.call("SessionSend", { sessionId: "b", payload: "barrier", reply: "on_turn_end" });
  const barrier = [...f.broker.ledger.messages.values()].at(-1)!;
  await vi.waitFor(() => expect(f.ends[1]!.finishes).toHaveLength(1));
  f.ends[1]!.finishes.shift()!("current-answer");
  await vi.waitFor(() => expect(barrier.subscription?.state).toBe("auto"));
  await vi.waitFor(() => expect(f.ends[0]!.requests).toHaveLength(1));
  await f.broker.ledger.flush();
  expect(source.subscription).toEqual({ state: "pending" });
  expect(f.broker.ledger.messages.size).toBe(3);
  expect(JSON.stringify(f.ends[0]!.requests)).not.toContain("stale-answer");
  expect(f.post).toHaveBeenCalledTimes(3);
});

it("open first message crosses the real broker and inbox with authenticated attribution", async () => {
  const f = await fixture();
  const result = await f.doors[0]!.call("SessionOpen", { firstMessage: "open-message-nonce" });
  expect(result).toMatchObject({ output: { status: "opened", sessionId: "opened-2", tabId: "opened-2", delivery: { state: "acknowledged" } } });
  await vi.waitFor(() => expect(f.ends[2]!.requests).toHaveLength(1));
  expect(JSON.stringify(f.ends[2]!.requests[0])).toContain("open-message-nonce");
  expect([...f.broker.ledger.messages.values()][0]!.envelope).toMatchObject({ recipientSessionId: "opened-2",
    sender: "session:a", principal: { kind: "session", sessionId: "a", tabId: "a" } });
});
it("cross-workspace open needs both persisted pair consent and target open opt-in", async () => {
  const f = await fixture();
  f.creator.projects = { isAllowed: () => true };
  f.policy.setPairGrant(f.dir, f.other, false);
  expect(await f.doors[0]!.call("SessionOpen", { workspace: f.other })).toMatchObject({ output: { status: "refused" } });
  expect(f.fork).not.toHaveBeenCalled();
  f.policy.setPairGrant(f.dir, f.other, true);
  expect(await f.doors[0]!.call("SessionOpen", { workspace: f.other })).toMatchObject({ output: { status: "opened" } });
  expect(f.fork).toHaveBeenCalledWith(expect.objectContaining({ workspace: f.other }));
});
