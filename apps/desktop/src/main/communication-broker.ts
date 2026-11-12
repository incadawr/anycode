import { realpath } from "node:fs/promises";
import { applyDeliveryUpdate, createCommunicationLedger, deliveryExtras, type CommunicationRecord } from "./communication-ledger.js";
import { createCommunicationDispatch, type CommunicationPrincipal, type CommunicationSendInput } from "./communication-dispatch.js";
import type { CommunicationManager } from "./communication-server.js";
import type { AgentDelivery, AgentDisplayCard, AgentEnvelope } from "../shared/communication.js";
type Tab = ReturnType<CommunicationManager["listTabs"]>[number];
type Access = { tabs(retryMissing: boolean): Promise<ReadonlyArray<Tab>>; requireSession(sessionId: string): Promise<Tab> };

/** App-owned storage and observers; access policy belongs to each entry point. */
export async function createCommunicationBroker(options: {
  manager: CommunicationManager; ledgerFile: string;
  writeLedger?: (path: string, text: string) => Promise<void>;
  nativeSessionsEnabled?: boolean;
  dispatchTimeoutMs?: number; realpath?: (path: string) => Promise<string>;
}) {
  const { manager } = options;
  const resolvePath = options.realpath ?? realpath;
  const ledger = await createCommunicationLedger(options.ledgerFile, options.writeLedger);
  const { messages, persist } = ledger;
  const markLostGeneration = async (record: CommunicationRecord) => {
    if (record.state !== "queued") return false;
    const tab = manager.listTabs().find((t) => t.sessionId === record.envelope.recipientSessionId);
    if (tab && tab.state === "running" && tab.pid != null && tab.pid === record.hostPid) return false;
    record.state = "unknown";
    record.detail = "Host restarted before queued delivery could be confirmed; no automatic model replay";
    await persist();
    return true;
  };
  let closed = false;
  const pending = new Set<Promise<unknown>>();
  const lifecycles = new Set<{ reconcile(): Promise<void>; dispose(): Promise<void> }>();
  const observers = new Set<{ reconcile(): Promise<void>; stop(): void }>();
  const dispatch = createCommunicationDispatch({ ledger, resolvePath: async (path) => {
      const resolved = await resolvePath(path);
      if (closed) throw new Error("Communication broker closed");
      return resolved;
    }, markLostGeneration,
    authorize: async () => { throw new Error("Access policy required"); },
    dispatchTimeoutMs: options.dispatchTimeoutMs, nativeSessionsEnabled: options.nativeSessionsEnabled,
    post: (id, envelope, workspace) => manager.communicationRequest(id, "send_message", envelope, workspace),
  });
  const changed = (record: CommunicationRecord, current: AgentDelivery) => {
    const extras = deliveryExtras(current);
    return current.state !== record.state || current.detail !== record.detail
      || extras.deliveryKind !== record.deliveryKind || extras.reasonCode !== record.reasonCode;
  };
  const observe = ({ tabs, requireSession }: Access) => {
    if (closed) throw new Error("Communication broker closed");
    let stopped = false;
    const unsubscribe = manager.onCommunicationDelivery?.((sessionId, delivery) => {
      const task = (async () => {
        const tab = await requireSession(sessionId);
        if (closed || stopped) return;
        const workspace = await resolvePath(tab.workspace);
        const projectRoot = tab.projectRoot;
        if (closed || stopped) return;
        const existing = messages.get(delivery.envelope.messageId);
        if (existing && delivery.detail !== "Dispatch pending") { applyDeliveryUpdate(existing, delivery); }
        else if (!existing && !ledger.isFull()) { messages.set(delivery.envelope.messageId, { ...delivery, workspace, ...(projectRoot !== undefined && projectRoot !== workspace ? { projectRoot } : {}), hostPid: tab.pid }); }
        await persist();
      })().catch(() => { /* closing or no longer authorized */ });
      pending.add(task); void task.finally(() => pending.delete(task));
    });

    // Rehydrate visible envelopes only, never replay payloads to the model.
    const restoredHosts = new Set<string>();
    const deferredRestores = new Map<string, Set<string>>();
    const settled = (record: CommunicationRecord) => record.detail !== "Dispatch pending" && !dispatch.inFlight.has(record.envelope.messageId);
    let reconciling = false;
    const reconcile = async () => {
      if (options.nativeSessionsEnabled || closed || stopped || reconciling) return;
      reconciling = true;
      try {
        for (const record of messages.values()) await markLostGeneration(record);
        // Forget bookkeeping for host generations that are gone (a new pid replaces them).
        const liveGenerations = new Set(manager.listTabs().map((tab) => `${tab.sessionId}:${tab.pid}`));
        for (const key of [...restoredHosts]) if (!liveGenerations.has(key)) restoredHosts.delete(key);
        for (const key of [...deferredRestores.keys()]) if (!liveGenerations.has(key)) deferredRestores.delete(key);
        for (const tab of await tabs(false)) {
          if (closed || stopped) return;
          const key = `${tab.sessionId}:${tab.pid}`;
          const records = [...messages.values()].filter((r) => r.envelope.recipientSessionId === tab.sessionId);
          if (!records.length) continue;
          const waiting = deferredRestores.get(key) ?? new Set<string>();
          for (const record of records) if (!settled(record)) waiting.add(record.envelope.messageId);
          const eligible = records.filter(settled);
          if (!restoredHosts.has(key)) {
            if (eligible.length) {
              await manager.communicationRequest(tab.sessionId, "restore_agent_messages", eligible, tab.workspace);
              restoredHosts.add(key);
              for (const record of eligible) waiting.delete(record.envelope.messageId);
            }
          } else {
            const retry = eligible.filter((r) => waiting.has(r.envelope.messageId));
            if (retry.length) {
              await manager.communicationRequest(tab.sessionId, "restore_agent_messages", retry, tab.workspace);
              for (const record of retry) waiting.delete(record.envelope.messageId);
            }
          }
          if (waiting.size) deferredRestores.set(key, waiting); else deferredRestores.delete(key);
          for (const record of eligible.filter((r) => r.state === "queued")) {
            const current = await manager.communicationRequest(tab.sessionId, "get_message_status", record.envelope.messageId, tab.workspace) as AgentDelivery | undefined;
            if (record.state === "queued" && !await markLostGeneration(record) && current && changed(record, current)) { applyDeliveryUpdate(record, current); await persist(); }
          }
        }
      } catch { /* a closing/crashed host cannot authorize replay */ }
      finally { reconciling = false; }
    };
    const observer = { reconcile, stop() { stopped = true; unsubscribe?.(); observers.delete(observer); } };
    observers.add(observer);
    return observer.stop;
  };
  // Display recovery is app-owned even when the external endpoint is off.
  const displaySnapshots = new Map<string, string>();
  let projecting = false;
  const reconcileDisplay = async () => {
    if (!options.nativeSessionsEnabled || closed || projecting) return;
    projecting = true;
    try {
      const tabs = manager.listTabs();
      const live = new Set(tabs.map(tab => `${tab.sessionId}:${tab.pid}`));
      for (const key of displaySnapshots.keys()) if (!live.has(key)) displaySnapshots.delete(key);
      for (const record of messages.values()) {
        await markLostGeneration(record);
        const tab = tabs.find(tab => tab.sessionId === record.envelope.recipientSessionId);
        if (record.state !== "queued" || !tab || dispatch.inFlight.has(record.envelope.messageId)) continue;
        try {
          const current = await manager.communicationRequest(tab.sessionId, "get_message_status", record.envelope.messageId, tab.workspace) as AgentDelivery | undefined;
          if (current && record.state === "queued" && changed(record, current)) {
            applyDeliveryUpdate(record, current); await persist();
          }
        } catch { /* closing host; display remains recoverable */ }
      }
      for (const tab of tabs) {
        const cards: AgentDisplayCard[] = [];
        for (const record of messages.values()) {
          const e = record.envelope, p = record.principal;
          const principal = p?.kind === "session" && typeof p.sessionId === "string" && typeof p.tabId === "string"
            ? { kind: "session" as const, sessionId: p.sessionId, tabId: p.tabId } : undefined;
          const incoming = e.recipientSessionId === tab.sessionId;
          if (!incoming && principal?.sessionId !== tab.sessionId) continue;
          if (dispatch.inFlight.has(e.messageId) || record.detail === "Dispatch pending") continue;
          const envelope: AgentEnvelope = { messageId: e.messageId, sender: e.sender, recipientSessionId: e.recipientSessionId,
            payload: e.payload, mode: e.mode, kind: e.kind, createdAt: e.createdAt };
          if (e.correlationId !== undefined) envelope.correlationId = e.correlationId;
          if (e.replyTo !== undefined) envelope.replyTo = e.replyTo;
          if (principal) envelope.principal = principal;
          cards.push({ envelope, state: record.state, ...(record.detail !== undefined ? { detail: record.detail } : {}), direction: incoming ? "incoming" : "outgoing" });
        }
        const key = `${tab.sessionId}:${tab.pid}`, snapshot = JSON.stringify(cards);
        if (!cards.length || displaySnapshots.get(key) === snapshot || closed) continue;
        try {
          await manager.communicationRequest(tab.sessionId, "restore_agent_display", cards, tab.workspace);
          displaySnapshots.set(key, snapshot);
        } catch { /* retry on the next reconcile */ }
      }
    } catch { /* persistence unavailable; retry without replay */ }
    finally { projecting = false; }
  };
  if (options.nativeSessionsEnabled) observe({ tabs: async () => manager.listTabs(), requireSession: async id => {
    const tab = manager.listTabs().find(tab => tab.sessionId === id);
    if (!tab) throw new Error("Host unavailable");
    return tab;
  } });
  const reconcile = () => {
    const task = Promise.all([...[...messages.values()].map(markLostGeneration), ...[...lifecycles, ...observers].map(observer => observer.reconcile())]).then(reconcileDisplay).catch(() => {});
    pending.add(task); void task.finally(() => pending.delete(task)); return task;
  };
  const timer = setInterval(() => { void reconcile(); }, 1000);
  timer.unref();
  let disposal: Promise<void> | undefined;
  return { ledger, markLostGeneration, observe, reconcile,
    onPeerTerminal: (listener: Parameters<NonNullable<CommunicationManager["onSessionPeerTerminal"]>>[0]) => manager.onSessionPeerTerminal?.(listener) ?? (() => {}),
    onPeerDelivery: () => manager.onCommunicationDelivery?.((sessionId, delivery) => {
      const record = messages.get(delivery.envelope.messageId);
      const tab = manager.listTabs().find(t => t.sessionId === sessionId);
      if (closed || !record?.peer || record.envelope.recipientSessionId !== sessionId || tab?.pid !== record.hostPid ||
          JSON.stringify(record.envelope) !== JSON.stringify(delivery.envelope) || delivery.detail === "Dispatch pending") return;
      applyDeliveryUpdate(record, delivery);
      const task = persist().catch(() => {});
      pending.add(task); void task.finally(() => pending.delete(task));
    }) ?? (() => {}),
    lifecycle: (hook: { reconcile(): Promise<void>; dispose(): Promise<void> }) => { lifecycles.add(hook); },
    send(principal: CommunicationPrincipal, input: CommunicationSendInput, authorize: Access["requireSession"], signal?: AbortSignal, admit?: (record: CommunicationRecord) => void) {
      if (closed) return Promise.reject(new Error("Communication broker closed"));
      const task = dispatch.send(principal, input, signal, async (id) => {
        const tab = await authorize(id);
        if (closed) throw new Error("Communication broker closed");
        return tab;
      }, admit);
      pending.add(task); void task.then(() => pending.delete(task), () => pending.delete(task));
      return task;
    },
    dispose() {
      return disposal ??= (async () => {
        closed = true; clearInterval(timer);
        for (const observer of [...observers]) observer.stop();
        dispatch.dispose(); await Promise.allSettled([...pending]);
        for (const hook of lifecycles) await hook.dispose();
        lifecycles.clear(); await ledger.flush();
      })();
    },
  };
}
export type CommunicationBroker = Awaited<ReturnType<typeof createCommunicationBroker>>;
