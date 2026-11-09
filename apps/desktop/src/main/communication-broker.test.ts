import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createCommunicationController } from "./communication-controller.js";
import { createCommunicationBroker } from "./communication-broker.js";
import type { AgentDelivery, AgentDisplayCard } from "../shared/communication.js";
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
it("keeps native delivery and display recovery alive without HTTP, sharing one custom ledger across rebinds", async () => {
  const dir = await mkdtemp(join(tmpdir(), "communication-broker-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const discoveryFile = join(dir, "custom.json");
  const configFile = join(dir, "config.json");
  await writeFile(configFile, JSON.stringify({ workspaces: [dir], discoveryFile }));
  const listeners = new Set<(id: string, delivery: AgentDelivery) => void>();
  const tab = { sessionId: "peer", workspace: dir, state: "running", pid: 1 };
  const manager = {
    listTabs: () => [tab],
    onCommunicationDelivery: (listener: (id: string, delivery: AgentDelivery) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    communicationRequest: vi.fn(async (_id: string, op: string) => op === "send_message" ? { state: "acknowledged" } : undefined),
  };
  let env: string | undefined = configFile;
  const brokers: unknown[] = [];
  const controller = createCommunicationController({ manager: () => manager, userData: dir, env: () => env,
    logger: { error: vi.fn() }, isSessionExposed: () => true,
    startServer: async (options) => { brokers.push(await options.getBroker!(discoveryFile)); return { url: "http://127.0.0.1:4321/mcp", discoveryFile, close: vi.fn(async () => {}) }; },
  });
  cleanup.push(() => controller.dispose());
  expect(await readdir(dir)).toEqual(["config.json"]);
  const broker = await controller.broker();
  const access = { tabs: async () => [tab], requireSession: async () => tab };
  broker.observe(access);
  expect(listeners.size).toBe(1);
  const input = { sessionId: "peer", payload: "hello", mode: "next_turn" as const, kind: "agent_message" as const, idempotencyKey: "same" };
  const principal = { kind: "session" as const, sessionId: "sender", tabId: "sender-tab" };
  const [a, b] = await Promise.all([broker.send(principal, input, access.requireSession), broker.send(principal, input, access.requireSession)]);
  expect(a).toBe(b);
  expect(manager.communicationRequest.mock.calls.filter(([, op]) => op === "send_message")).toHaveLength(1);
  await broker.reconcile();
  expect(manager.communicationRequest).toHaveBeenCalledWith("peer", "restore_agent_messages", [a], dir);
  expect(await readdir(dir)).toEqual(["config.json", "custom.json.messages"]);
  env = undefined;
  await controller.apply({ enabled: true, workspaces: [] });
  await controller.regenerateToken();
  await controller.apply({ enabled: true, workspaces: [], port: 4322 });
  await controller.apply({ enabled: false, workspaces: [] });
  expect(brokers).toEqual([broker, broker, broker]);
  expect(listeners.size).toBe(1);
  for (const listener of listeners) listener("peer", { ...a, state: "rejected", detail: "late" });
  await vi.waitFor(async () => expect(JSON.parse(await readFile(`${discoveryFile}.messages`, "utf8"))[0].state).toBe("rejected"));
  await controller.dispose();
  await controller.dispose();
  expect(listeners.size).toBe(0);
  await expect(broker.send(principal, input, access.requireSession)).rejects.toThrow("closed");
  const restored = await createCommunicationBroker({ manager, ledgerFile: `${discoveryFile}.messages` });
  cleanup.push(() => restored.dispose());
  restored.observe(access);
  await restored.reconcile();
  expect(restored.ledger.messages.get(a.envelope.messageId)?.state).toBe("rejected");
  expect(manager.communicationRequest.mock.calls.filter(([, op]) => op === "send_message")).toHaveLength(1);
});

it("keeps deliveryKind and reasonCode from a host push with no reconcile poll", async () => {
  const dir = await mkdtemp(join(tmpdir(), "communication-push-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const listeners = new Set<(id: string, delivery: AgentDelivery) => void>();
  const tab = { sessionId: "peer", workspace: dir, state: "running", pid: 1 };
  const post = vi.fn(async (_id: string, op: string) => op === "send_message" ? { state: "queued", detail: "Queued for the next turn" } : undefined);
  const ledgerFile = join(dir, "ledger");
  const broker = await createCommunicationBroker({ ledgerFile,
    manager: { listTabs: () => [tab], communicationRequest: post,
      onCommunicationDelivery: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; } } });
  cleanup.push(() => broker.dispose());
  const access = { tabs: async () => [tab], requireSession: async () => tab };
  broker.observe(access);
  const sent = await broker.send({ kind: "session", sessionId: "sender", tabId: "tab" },
    { sessionId: "peer", payload: "hello", mode: "next_turn", kind: "agent_message" }, access.requireSession);
  const id = sent.envelope.messageId;
  for (const listener of listeners) listener("peer", { ...sent, state: "acknowledged", detail: "Delivered at a tool seam", deliveryKind: "core_seam" });
  await vi.waitFor(() => expect(broker.ledger.messages.get(id)?.deliveryKind).toBe("core_seam"));
  expect(broker.ledger.messages.get(id)).toMatchObject({ state: "acknowledged", detail: "Delivered at a tool seam" });
  await vi.waitFor(async () => expect(JSON.parse(await readFile(ledgerFile, "utf8"))[0].deliveryKind).toBe("core_seam"));
  expect(post.mock.calls.some(([, op]) => op === "get_message_status")).toBe(false);
  // A later push without the optional fields clears them, like the poll paths.
  for (const listener of listeners) listener("peer", { envelope: sent.envelope, state: "acknowledged", detail: "Seen" });
  await vi.waitFor(() => expect(broker.ledger.messages.get(id)?.detail).toBe("Seen"));
  expect(broker.ledger.messages.get(id)).not.toHaveProperty("deliveryKind");
});

it("shares the durability barrier for native and external sends", async () => {
  const dir = await mkdtemp(join(tmpdir(), "communication-writer-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let writing = 0, maximum = 0;
  const post = vi.fn(async () => ({ state: "acknowledged" }));
  const tab = { sessionId: "peer", workspace: dir, state: "running", pid: 1 };
  const broker = await createCommunicationBroker({ ledgerFile: join(dir, "ledger"),
    manager: { listTabs: () => [tab], communicationRequest: post },
    writeLedger: async (_path, text) => {
      maximum = Math.max(maximum, ++writing);
      if (text !== "[]") await held;
      writing--;
    },
  });
  cleanup.push(() => broker.dispose());
  const input = { sessionId: "peer", payload: "hello", mode: "next_turn" as const, kind: "agent_message" as const };
  const native = broker.send({ kind: "session", sessionId: "sender", tabId: "tab" }, input, async () => tab);
  const external = broker.send({ kind: "external" }, input, async () => tab);
  await vi.waitFor(() => expect(broker.ledger.messages.size).toBe(2));
  expect(post).not.toHaveBeenCalled();
  release();
  await Promise.all([native, external]);
  expect(post).toHaveBeenCalledTimes(2);
  expect(maximum).toBe(1);
});

it("disposal rejects a send still awaiting authorization and removes every observer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "communication-shutdown-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const tab = { sessionId: "peer", workspace: dir, state: "running", pid: 1 };
  const unsubscribe = vi.fn();
  const post = vi.fn();
  const broker = await createCommunicationBroker({ ledgerFile: join(dir, "ledger"),
    manager: { listTabs: () => [tab], communicationRequest: post, onCommunicationDelivery: () => unsubscribe } });
  broker.observe({ tabs: async () => [tab], requireSession: async () => tab });
  broker.observe({ tabs: async () => [tab], requireSession: async () => tab });
  let authorize!: (value: typeof tab) => void;
  const send = broker.send({ kind: "external" }, { sessionId: "peer", payload: "hello", mode: "next_turn", kind: "agent_message" },
    () => new Promise((resolve) => { authorize = resolve; }));
  const rejected = expect(send).rejects.toThrow("closed");
  const disposal = broker.dispose();
  authorize(tab);
  await Promise.all([rejected, disposal]);
  expect(unsubscribe).toHaveBeenCalledTimes(2);
  expect(post).not.toHaveBeenCalled();
});

it("projects both ledger sides, refreshes settled and new cards, and recovers without send replay", async () => {
  const dir = await mkdtemp(join(tmpdir(), "display-ledger-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const tabs = ["a", "b"].map(sessionId => ({ sessionId, workspace: dir, state: "running", pid: 1 }));
  const request = vi.fn(async (_id: string, op: string, _payload?: unknown) => op === "send_message" ? { state: "queued" } : undefined);
  const manager = { listTabs: () => tabs, communicationRequest: request };
  const options = { manager, ledgerFile: join(dir, "ledger"), nativeSessionsEnabled: true };
  let broker = await createCommunicationBroker(options);
  cleanup.push(() => broker.dispose());
  const principal = { kind: "session" as const, sessionId: "a", tabId: "tab-a" };
  const input = { sessionId: "b", payload: "private body", mode: "next_turn" as const, kind: "agent_message" as const, correlationId: "chain" };
  const record = await broker.send(principal, input, async () => tabs[1]!);
  expect(record.envelope).toHaveProperty("principal", principal);
  // Old records have identity only at the ledger level; prose is never authority.
  delete record.envelope.principal;
  Object.assign(record, { secret: "sentinel" });
  const cards = (id: string) => request.mock.calls.filter(([target, op]) => target === id && op === "restore_agent_display");
  await broker.reconcile();
  for (const [id, direction] of [["a", "outgoing"], ["b", "incoming"]]) {
    const wire = cards(id!).at(-1)![2] as AgentDisplayCard[];
    expect(wire).toEqual([{ envelope: { ...record.envelope, principal }, state: "queued", direction }]);
    expect(JSON.stringify(wire)).not.toMatch(/sentinel|hostPid|workspace|idempotencyKey/);
  }
  request.mockImplementation(async (_id, op) => op === "get_message_status" ? { state: "acknowledged" } : op === "send_message" ? { state: "queued" } : undefined);
  await broker.reconcile();
  expect((cards("a").at(-1)![2] as AgentDisplayCard[])[0]!.state).toBe("acknowledged");
  await broker.send(principal, { ...input, payload: "second" }, async () => tabs[1]!);
  await broker.reconcile();
  expect((cards("a").at(-1)![2] as AgentDisplayCard[])).toHaveLength(2);
  const before = cards("a").length;
  tabs[0]!.pid = 2;
  await broker.reconcile();
  expect(cards("a")).toHaveLength(before + 1);
  await broker.dispose();
  broker = await createCommunicationBroker(options);
  await broker.reconcile();
  expect((cards("b").at(-1)![2] as AgentDisplayCard[])).toHaveLength(2);
  expect(request.mock.calls.filter(([, op]) => op === "send_message")).toHaveLength(2);
  const fake = await broker.send({ kind: "external" }, input, async () => tabs[1]!);
  fake.envelope.sender = "session:a";
  fake.envelope.principal = principal;
  await broker.reconcile();
  expect((cards("a").at(-1)![2] as AgentDisplayCard[])).toHaveLength(2);
  expect((cards("b").at(-1)![2] as AgentDisplayCard[]).at(-1)!.envelope.principal).toBeUndefined();
  // Disabled transport retains legacy bytes, including the restoration request.
  {
    const dir = await mkdtemp(join(tmpdir(), "display-off-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const tab = { sessionId: "b", workspace: dir, state: "running", pid: 1 };
    const request = vi.fn(async (_id: string, _op: string, _payload?: unknown) => ({ state: "acknowledged" }));
    const broker = await createCommunicationBroker({ manager: { listTabs: () => [tab], communicationRequest: request }, ledgerFile: join(dir, "ledger"), nativeSessionsEnabled: false });
    cleanup.push(() => broker.dispose());
    broker.observe({ tabs: async () => [tab], requireSession: async () => tab });
    const record = await broker.send({ kind: "session", sessionId: "a", tabId: "tab-a" }, { sessionId: "b", payload: "body", mode: "next_turn", kind: "agent_message" }, async () => tab);
    const legacy = { messageId: record.envelope.messageId, sender: "session:a", recipientSessionId: "b", payload: "body", mode: "next_turn", kind: "agent_message", createdAt: record.envelope.createdAt };
    expect(JSON.stringify(record.envelope)).toBe(JSON.stringify(legacy));
    await broker.reconcile();
    const restore = request.mock.calls;
    expect(JSON.stringify(restore.find(([, op]) => op === "restore_agent_messages")?.[2])).toBe(JSON.stringify([record]));
    expect(restore.some(([, op]) => op === "restore_agent_display")).toBe(false);
  }
});
