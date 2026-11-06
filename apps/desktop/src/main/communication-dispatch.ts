import { randomUUID } from "node:crypto";
import type { AgentDelivery, AgentEnvelope } from "../shared/communication.js";
import type { createCommunicationLedger, CommunicationRecord } from "./communication-ledger.js";

/** Main-owned identity, never decoded from tool arguments. */
export type CommunicationPrincipal = { kind: "external" } | { kind: "session"; sessionId: string; tabId: string };
export type CommunicationSendInput = Pick<AgentEnvelope, "payload" | "mode" | "kind" | "correlationId" | "replyTo"> & { sessionId: string; idempotencyKey?: string };
const unavailable = "Host response unavailable; do not blindly resend";
function projectResponse(raw: unknown): Pick<AgentDelivery, "state" | "detail"> {
  if (!raw || typeof raw !== "object") return { state: "unknown", detail: unavailable };
  const { state, detail } = raw as Record<string, unknown>;
  if (!["queued", "acknowledged", "rejected", "unknown"].includes(state as string) || (detail !== undefined && typeof detail !== "string")) return { state: "unknown", detail: unavailable };
  return { state: state as AgentDelivery["state"], detail: detail === "Dispatch pending" ? unavailable : detail as string | undefined };
}

export function createCommunicationDispatch(options: {
  ledger: Awaited<ReturnType<typeof createCommunicationLedger>>;
  authorize: (sessionId: string) => Promise<{ workspace: string; pid?: number | null }>;
  resolvePath: (path: string) => Promise<string>;
  post: (sessionId: string, envelope: AgentEnvelope, workspace: string) => Promise<unknown>;
  markLostGeneration: (record: CommunicationRecord) => Promise<unknown>;
  dispatchTimeoutMs?: number;
}) {
  const { messages, persist } = options.ledger;
  // Exclude these records from display restoration until the real post settles,
  // even if the deadline has already rewritten their pending detail.
  const inFlight = new Set<string>();
  const pending = new Map<string, Promise<CommunicationRecord>>();
  const expiryTimers = new Map<string, NodeJS.Timeout>();
  const scheduleExpiry = (record: CommunicationRecord) => {
    const messageId = record.envelope.messageId;
    const due = Date.parse(record.envelope.createdAt) + (options.dispatchTimeoutMs ?? 20_000) - Date.now();
    const timer = setTimeout(() => {
      expiryTimers.delete(messageId);
      if (record.detail !== "Dispatch pending") return;
      record.state = "unknown"; record.detail = unavailable;
      void persist().catch(() => {});
    }, Math.max(0, due));
    timer.unref(); expiryTimers.set(messageId, timer);
  };
  const checkAbort = (signal?: AbortSignal) => { if (signal?.aborted) throw new Error("Send aborted"); };
  const send = async (principal: CommunicationPrincipal, input: CommunicationSendInput, signal?: AbortSignal, authorize = options.authorize, admit?: (record: CommunicationRecord) => void): Promise<CommunicationRecord> => {
    checkAbort(signal);
    const recipient = await authorize(input.sessionId);
    const workspace = await options.resolvePath(recipient.workspace);
    checkAbort(signal);
    // Reservation is synchronous after authorization: a second caller sees the
    // first record before any disk or host await can open a duplicate dispatch.
    if (input.idempotencyKey) {
      const existing = options.ledger.findByIdempotencyKey(input.idempotencyKey, principal);
      if (existing) {
        const e = existing.envelope;
        if (e.recipientSessionId !== input.sessionId || e.payload !== input.payload || e.mode !== input.mode || e.kind !== input.kind || e.correlationId !== input.correlationId || e.replyTo !== input.replyTo) throw new Error("Idempotency key reused with different input");
        const record = await (pending.get(e.messageId) ?? existing);
        checkAbort(signal); return record;
      }
    }
    if (options.ledger.isFull()) throw new Error("Message ledger full; restart with a new discovery file after archiving ledger");
    const sender = principal.kind === "external" ? "authenticated-local-supervisor" : `session:${principal.sessionId}`;
    const envelope: AgentEnvelope = { messageId: randomUUID(), sender, recipientSessionId: input.sessionId, payload: input.payload, mode: input.mode, kind: input.kind, correlationId: input.correlationId, replyTo: input.replyTo, createdAt: new Date().toISOString() };
    const record: CommunicationRecord = { envelope, state: "unknown", detail: "Dispatch pending", idempotencyKey: input.idempotencyKey, workspace, hostPid: recipient.pid };
    if (principal.kind === "session") record.principal = { ...principal };
    admit?.(record); // Synchronous reservation shares the dedup boundary.
    messages.set(envelope.messageId, record);
    inFlight.add(envelope.messageId); scheduleExpiry(record);
    const delivery = (async () => {
      try {
        try { await persist(); } // Durable acceptance BEFORE any delivery side effect.
        catch (error) {
          if (record.peer) {
            messages.delete(envelope.messageId);
            clearTimeout(expiryTimers.get(envelope.messageId)); expiryTimers.delete(envelope.messageId);
          }
          throw error;
        }
        // The shared outcome belongs to the durable message; each caller
        // checks its own cancellation independently after joining it.
        if (signal?.aborted) return record;
        try {
          const response = projectResponse(await options.post(input.sessionId, envelope, recipient.workspace));
          record.state = response.state; record.detail = response.detail;
        } catch { record.state = "unknown"; record.detail = unavailable; }
      } finally { inFlight.delete(envelope.messageId); }
      await options.markLostGeneration(record);
      await persist(); return record;
    })();
    pending.set(envelope.messageId, delivery);
    try { const result = await delivery; checkAbort(signal); return result; } finally { pending.delete(envelope.messageId); }
  };
  return { send, inFlight, dispose() { for (const timer of expiryTimers.values()) clearTimeout(timer); expiryTimers.clear(); } };
}
