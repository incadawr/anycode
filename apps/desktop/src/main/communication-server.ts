/** Production, opt-in, local-only MCP. Independent of automation and CDP. */
import { createServer } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, rename, mkdir, rm, realpath } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { Server, StreamableHTTPServerTransport, CallToolRequestSchema, ListToolsRequestSchema } from "@anycode/core/communication-mcp";
import { z } from "zod";
import type { AgentDelivery, AgentEnvelope } from "../shared/communication.js";

export interface CommunicationManager {
  listTabs(): ReadonlyArray<{ sessionId: string; workspace: string; state: string; pid?: number | null; childOf?: { parentTabId: string; requestId?: string } }>;
  onCommunicationDelivery?(listener: (sessionId: string, delivery: AgentDelivery) => void): () => void;
  communicationRequest(sessionId: string, operation: string, payload?: unknown, expectedWorkspace?: string): Promise<unknown>;
}
/**
 * One schema for both config sources. The env file (`configFile`) additionally
 * requires at least one folder (its contract predates the Settings UI); the live
 * `config` object may carry an EMPTY folder list, meaning "no folder restriction":
 * the per-session switch alone gates exposure (Taskana 4747 owner amendment).
 */
const configSchema = z.object({
  workspaces: z.array(z.string()),
  port: z.number().int().min(0).max(65535).default(0),
  discoveryFile: z.string().optional(),
}).strict();
/** Live (settings-driven) communication config, validated by the same schema. */
export type LiveCommunicationConfig = z.input<typeof configSchema>;
const sessionSchema = z.object({ sessionId: z.string().min(1) }).strict();
const messageSchema = z.object({
  sessionId: z.string().min(1), payload: z.string().min(1).max(32000),
  mode: z.enum(["next_turn", "steer"]), kind: z.enum(["agent_message", "task_result"]).default("agent_message"),
  correlationId: z.string().max(200).optional(), replyTo: z.string().max(200).optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
}).strict();
/** Taskana 4768: `create_session` input. `firstMessage` rides the same next_turn path as `send_message`. */
const createSessionSchema = z.object({
  workspace: z.string().min(1).max(4096),
  engine: z.enum(["core", "codex", "claude"]).optional(),
  model: z.string().min(1).max(128).optional(),
  handle: z.string().max(200).optional(),
  firstMessage: z.string().min(1).max(32000).optional(),
}).strict();
const statusSchema = z.object({ messageId: z.string().min(1) }).strict();
/** Long-poll input: exactly one of messageId / correlationId; the wait is capped at 120 s (clients keep a longer request timeout or loop on `pending`). */
const waitSchema = z.object({
  sessionId: z.string().min(1),
  messageId: z.string().min(1).optional(),
  correlationId: z.string().max(200).optional(),
  timeoutMs: z.number().int().min(1).max(120000).default(30000),
}).strict().refine((v) => (v.messageId !== undefined) !== (v.correlationId !== undefined), { message: "Provide messageId or correlationId" });
/** Concurrent wait_for_result calls across all clients; the 33rd is refused. */
const MAX_WAITERS = 32;
/** Taskana 4768: at most this many `create_session` calls per window (per server instance; a restart resets it). */
export const CREATE_SESSION_RATE_LIMIT = 5;
export const CREATE_SESSION_RATE_WINDOW_MS = 60_000;
/** Taskana 4768: most agent-opened tabs alive at once. */
export const MAX_AGENT_OPENED_TABS = 8;
/** Taskana 4880: stable refusal codes for agent-owned tab closing. */
export type CloseSessionRefusal = "not_allowed" | "not_found" | "not_agent_opened" | "busy" | "last_tab";
export type CloseSessionOutcome = { ok: true } | { ok: false; reason: CloseSessionRefusal };
const CLOSE_REFUSAL_TEXT: { [K in CloseSessionRefusal]: string } = {
  not_allowed: "closing agent tabs is unavailable",
  last_tab: "the last remaining tab cannot be closed; open another tab first",
  not_found: "the session is unknown or not shared",
  not_agent_opened: "only tabs opened through create_session can be closed",
  busy: "the session is busy or its host is not ready; use cancel_turn first",
};
const closeRefusal = (code: CloseSessionRefusal) => new Error(`close_session ${code}: ${CLOSE_REFUSAL_TEXT[code]}`);
/** Taskana 4768: fixed create_session refusal codes, prefixed in error text. */
export type CreateSessionRefusal = "not_allowed" | "not_trusted" | "folder_not_found" | "rate_limited" | "too_many" | "not_ready";
export type CreateSessionRequest = { workspace: string; engine?: "core" | "codex" | "claude"; model?: string; handle?: string };
export type CreateSessionOutcome = { ok: true; sessionId: string; tabId: string; handle?: string } | { ok: false; reason: Exclude<CreateSessionRefusal, "rate_limited" | "folder_not_found"> };
const CREATE_REFUSAL_TEXT: { [K in CreateSessionRefusal]: string } = {
  not_allowed: "the project does not allow agents to open tasks (sidebar project menu, off by default)",
  not_trusted: "the folder is not trusted in AnyCode",
  folder_not_found: "the workspace folder does not exist",
  rate_limited: `at most ${CREATE_SESSION_RATE_LIMIT} sessions per minute`,
  too_many: `at most ${MAX_AGENT_OPENED_TABS} agent-opened sessions alive at once`,
  not_ready: "AnyCode could not open the tab right now (engine not signed in or tab limit reached)",
};
const createRefusal = (code: CreateSessionRefusal) => new Error(`create_session ${code}: ${CREATE_REFUSAL_TEXT[code]}`);
/** Taskana 4763: the one message the approval tools use when the per-session switch is off. Clients match on it. */
export const EXTERNAL_APPROVAL_OFF = "External approval is off for this session";
/** Taskana 4763: most approvals one `list_pending_approvals` call returns. */
const APPROVAL_LIMIT = 50;
const listApprovalsSchema = z.object({ sessionId: z.string().min(1).optional() }).strict();
const answerApprovalSchema = z.object({
  sessionId: z.string().min(1),
  approvalId: z.string().min(1).max(100),
  decision: z.enum(["allow", "deny"]),
}).strict();
const tools = [
  { name: "list_sessions", description: "List allowed live GUI sessions; no transcript or credentials.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "get_session_status", description: "Get engine and running/idle status for an allowed session.", inputSchema: { type: "object", properties: { sessionId: { type: "string" } }, required: ["sessionId"], additionalProperties: false } },
  { name: "get_session_result", description: "Read only latest completed public assistant text and terminal/turn identity. No reasoning or transcript. History recovery is unverified; delivery correlation does not prove application.", inputSchema: { type: "object", properties: { sessionId: { type: "string" } }, required: ["sessionId"], additionalProperties: false } },
  { name: "send_message", description: "Send an authenticated agent envelope. next_turn queues while busy; steer uses active Codex turn/steer. Acknowledged is not model-applied.", inputSchema: { type: "object", properties: { sessionId: { type: "string" }, payload: { type: "string", minLength: 1, maxLength: 32000 }, mode: { enum: ["next_turn", "steer"] }, kind: { enum: ["agent_message", "task_result"] }, correlationId: { type: "string" }, replyTo: { type: "string" }, idempotencyKey: { type: "string" } }, required: ["sessionId", "payload", "mode"], additionalProperties: false } },
  { name: "get_message_status", description: "Read delivery state. Unknown means do not blindly retry; the model may have received it.", inputSchema: { type: "object", properties: { messageId: { type: "string" } }, required: ["messageId"], additionalProperties: false } },
  { name: "wait_for_result", description: "Long-poll until the turn that consumed the message reaches a terminal state. Returns the same shape as get_session_result plus status. On timeout returns {status:'pending'}; call again.", inputSchema: { type: "object", properties: { sessionId: { type: "string" }, messageId: { type: "string" }, correlationId: { type: "string", maxLength: 200 }, timeoutMs: { type: "integer", minimum: 1, maximum: 120000, default: 30000 } }, required: ["sessionId"], additionalProperties: false } },
  { name: "list_pending_approvals", description: "List tool requests waiting for an answer, for sessions whose External approvals switch is on. Shows tool and a short scrubbed description, never file contents or raw input. Omit sessionId to list every approving session. Asks that need a human reading or typing (ExitPlanMode, AskUserQuestion) are listed with answerable:false.", inputSchema: { type: "object", properties: { sessionId: { type: "string" } }, additionalProperties: false } },
  { name: "answer_approval", description: "Allow or deny one pending tool request of a session whose External approvals switch is on. First answer wins (UI or this tool); a later answer reports already_answered. No 'always allow' from outside AnyCode.", inputSchema: { type: "object", properties: { sessionId: { type: "string" }, approvalId: { type: "string", minLength: 1, maxLength: 100 }, decision: { enum: ["allow", "deny"] } }, required: ["sessionId", "approvalId", "decision"], additionalProperties: false } },
  { name: "cancel_turn", description: "Stop the running turn of an allowed session, like the Stop button: queued agent messages are rejected and parked approvals are denied. Idle is not an error (cancelled:false, reason:idle). Needs only the Sessions API switch.", inputSchema: { type: "object", properties: { sessionId: { type: "string" } }, required: ["sessionId"], additionalProperties: false } },
  { name: "create_session", description: "Open a new tab in a project where the user switched on 'Allow agents to open tasks here' (sidebar project menu, off by default; trusted folders only; at most 5 per minute and 8 agent-opened alive; only successful creations count towards the per-minute limit). The new session is shared immediately. Optional firstMessage is delivered like send_message next_turn and returns messageId (omitted if the host was not ready within 10 s; then use send_message; refused with not_allowed, naming the tab ids, if the new tab is outside the folders list). Errors start with a code: not_allowed, not_trusted, folder_not_found, rate_limited, too_many, not_ready.", inputSchema: { type: "object", properties: { workspace: { type: "string", minLength: 1, maxLength: 4096 }, engine: { enum: ["core", "codex", "claude"] }, model: { type: "string", minLength: 1, maxLength: 128 }, handle: { type: "string", maxLength: 200 }, firstMessage: { type: "string", minLength: 1, maxLength: 32000 } }, required: ["workspace"], additionalProperties: false } },
  { name: "close_session", description: "Close a shared tab opened by create_session, through the same path as closing it in the UI. A running turn must be stopped with cancel_turn first. Errors start with a code: not_allowed (including env-file mode), not_found (unknown, closing or not shared), not_agent_opened (user tab), busy (running turn or host not ready), last_tab (open another tab first).", inputSchema: { type: "object", properties: { sessionId: { type: "string", minLength: 1 } }, required: ["sessionId"], additionalProperties: false } },
];

async function writePrivateFile(path: string, text: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

export interface CommunicationServerOptions {
  manager: CommunicationManager;
  userData: string;
  /** Per-session exposure gate, read on every request (live switch changes need no restart). Absent = every session. */
  isSessionExposed?: (sessionId: string) => boolean;
  /** Session handle of a session (main-owned). Absent = `list_sessions` carries no `handle` key at all. */
  handleOf?: (sessionId: string) => string | undefined;
  /** Delay between host polls inside wait_for_result (tests shorten it). */
  pollMs?: number;
  /**
   * Taskana 4763: the per-session External approvals switch, read on every
   * request. FAIL CLOSED: absent means OFF for every session (the opposite of
   * isSessionExposed). The legacy env-file mode passes none, so it never allows approvals.
   */
  isExternalApprovalEnabled?: (sessionId: string) => boolean;
  /**
   * Taskana 4768: opens a tab for `create_session`. Main owns the per-project
   * switch, the trust check and tab creation. FAIL CLOSED: absent (the legacy
   * env-file mode) means `create_session` always answers not_allowed.
   */
  createSessionByAgent?: (request: CreateSessionRequest) => Promise<CreateSessionOutcome>;
  /** Main-owned bookkeeping shared by admission, the alive cap and close_session. */
  agentOpenedSessions?: Set<string>;
  closeSessionByAgent?: (sessionId: string) => Promise<CloseSessionOutcome>;
  /** Clock for the creation rate window (tests inject it). */
  now?: () => number;
  /** How long `create_session` waits for the new host before it returns without messageId, and the poll step (tests shorten both). */
  readyTimeoutMs?: number;
  readyPollMs?: number;
}

/** Exactly one source: an env config FILE (legacy) or a live config OBJECT (Settings). */
export type CommunicationServerSource = { configFile: string } | { config: LiveCommunicationConfig };

export async function startCommunicationServer(options: CommunicationServerOptions & CommunicationServerSource): Promise<{ close(): Promise<void>; url: string; discoveryFile: string }> {
  const hasFile = "configFile" in options;
  if (hasFile === ("config" in options)) throw new Error("Communication server needs exactly one of configFile or config");
  const config = configSchema.parse("configFile" in options ? JSON.parse(await readFile(options.configFile, "utf8")) : options.config);
  if (hasFile && config.workspaces.length === 0) throw new Error("Communication workspaces must not be empty");
  if (config.workspaces.some((path) => !isAbsolute(path))) throw new Error("Communication workspaces must be absolute");
  const restricted = config.workspaces.length > 0;
  const allowed = new Set(await Promise.all(config.workspaces.map((path) => realpath(path))));
  const discoveryFile = config.discoveryFile ?? `${options.userData}/communication.json`;
  if (!isAbsolute(discoveryFile)) throw new Error("Communication discoveryFile must be absolute");
  const ledgerFile = `${discoveryFile}.messages`;
  const token = randomBytes(32).toString("hex");
  // This credential represents one supervisor, not an arbitrary client-asserted agent/session.
  const sender = "authenticated-local-supervisor";
  type Record = AgentDelivery & { idempotencyKey?: string; workspace?: string; hostPid?: number | null };
  const messages = new Map<string, Record>();
  try {
    const prior = JSON.parse(await readFile(ledgerFile, "utf8")) as Record[];
    for (const record of prior) {
      if (record.envelope?.messageId) messages.set(record.envelope.messageId, { ...record, state: record.state === "rejected" ? "rejected" : "unknown", detail: "Runtime restarted; no automatic replay to model" });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(dirname(discoveryFile), { recursive: true, mode: 0o700 });
  let writes = Promise.resolve();
  const persist = () => {
    const snapshot = JSON.stringify([...messages.values()]);
    writes = writes.catch(() => {}).then(async () => {
      await writePrivateFile(ledgerFile, snapshot);
    });
    return writes;
  };
  await persist();
  const tabs = async () => {
    const result = [];
    for (const tab of options.manager.listTabs()) {
      if (options.isSessionExposed && !options.isSessionExposed(tab.sessionId)) continue;
      if (!restricted) { result.push(tab); continue; }
      let path: string;
      try { path = await realpath(tab.workspace); } catch { continue; }
      if (allowed.has(path)) result.push(tab);
    }
    return result;
  };
  const requireSession = async (sessionId: string) => {
    const tab = (await tabs()).find((t) => t.sessionId === sessionId);
    if (!tab) throw new Error("Session unavailable or outside authorized workspace");
    return tab;
  };
  const approvalOn = (sessionId: string): boolean => options.isExternalApprovalEnabled?.(sessionId) === true;
  /** Access first (an unshared session never reveals anything), then the approval switch. */
  const requireApprovalSession = async (sessionId: string) => {
    const tab = await requireSession(sessionId);
    if (!approvalOn(sessionId)) throw new Error(EXTERNAL_APPROVAL_OFF);
    return tab;
  };
  /** Only the whitelisted fields of a host approval; nothing from the host payload rides along (no input, no updatedInput). */
  const approvalsOf = async (tab: { sessionId: string; workspace: string; childOf?: { parentTabId: string; requestId?: string } }, limit: number): Promise<{ items: unknown[]; truncated: boolean }> => {
    const raw = await options.manager.communicationRequest(tab.sessionId, "list_pending_approvals", undefined, tab.workspace);
    const hostItems: unknown[] = Array.isArray(raw) ? raw : [];
    const items = hostItems.slice(0, limit).map((item) => {
      const a = (item ?? {}) as { [key: string]: unknown };
      return {
        sessionId: tab.sessionId,
        approvalId: String(a.approvalId ?? ""),
        tool: String(a.tool ?? ""),
        description: String(a.description ?? ""),
        presented: a.presented === true,
        expiresInMs: typeof a.expiresInMs === "number" ? a.expiresInMs : null,
        answerable: a.answerable === true,
        ...(tab.childOf ? { childOf: { parentTabId: tab.childOf.parentTabId, ...(tab.childOf.requestId !== undefined ? { requestId: tab.childOf.requestId } : {}) } } : {}),
      };
    });
    return { items, truncated: hostItems.length > limit };
  };
  const now = options.now ?? Date.now;
  const creationTimes: number[] = [];
  const agentOpenedSessions = options.agentOpenedSessions ?? new Set<string>();
  /**
   * Taskana 4808 (review F4): one in-flight create_session at a time. The rate check, the
   * alive-cap check and the creator hook run as one critical section, so two concurrent
   * calls cannot both pass `aliveAgentOpened() >= MAX_AGENT_OPENED_TABS` and overshoot the
   * cap (a plain per-request handler has no such serialization). The firstMessage readiness
   * wait is deliberately OUTSIDE: it can last 10 s and must not block other creations.
   */
  let creating: Promise<unknown> = Promise.resolve();
  const inCreationSection = <T>(task: () => Promise<T>): Promise<T> => {
    const result = creating.then(task);
    creating = result.catch(() => undefined);
    return result;
  };
  const aliveAgentOpened = (): number => {
    const live = new Set(options.manager.listTabs().map((t) => t.sessionId));
    for (const id of agentOpenedSessions) if (!live.has(id)) agentOpenedSessions.delete(id);
    return agentOpenedSessions.size;
  };
  const parseOr = <T>(schema: z.ZodType<T>, raw: unknown, hint: string): T => {
    try { return schema.parse(raw); } catch (error) { if (error instanceof z.ZodError) throw new Error(hint); throw error; }
  };
  /** Shared by `send_message` and `create_session`'s firstMessage: idempotency -> ledger -> persist -> deliver -> persist. */
  const sendMessage = async (input: z.infer<typeof messageSchema>): Promise<Record> => {
    const recipient = await requireSession(input.sessionId);
    const workspace = await realpath(recipient.workspace);
    if (input.idempotencyKey) {
      const existing = [...messages.values()].find((m) => m.idempotencyKey === input.idempotencyKey);
      if (existing) {
        const e = existing.envelope;
        if (e.recipientSessionId !== input.sessionId || e.payload !== input.payload || e.mode !== input.mode || e.kind !== input.kind || e.correlationId !== input.correlationId || e.replyTo !== input.replyTo) throw new Error("Idempotency key reused with different input");
        return existing;
      }
    }
    if (messages.size >= 10000) throw new Error("Message ledger full; restart with a new discovery file after archiving ledger");
    const envelope: AgentEnvelope = { messageId: randomUUID(), sender, recipientSessionId: input.sessionId, payload: input.payload, mode: input.mode, kind: input.kind, correlationId: input.correlationId, replyTo: input.replyTo, createdAt: new Date().toISOString() };
    const record: Record = { envelope, state: "unknown", detail: "Dispatch pending", idempotencyKey: input.idempotencyKey, workspace, hostPid: recipient.pid };
    messages.set(envelope.messageId, record);
    await persist(); // Durable acceptance BEFORE any delivery side effect.
    try {
      const response = await options.manager.communicationRequest(input.sessionId, "send_message", envelope, recipient.workspace) as AgentDelivery;
      record.state = response.state; record.detail = response.detail;
    } catch { record.state = "unknown"; record.detail = "Host response unavailable; do not blindly resend"; }
    await persist(); return record;
  };
  // Every in-flight wait, so close() can abort them all (no leaked timers or hosts polled after close).
  const waiters = new Set<AbortController>();
  let closing = false;
  const pollMs = options.pollMs ?? 500;
  const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(new Error("Wait aborted")); return; }
    const onAbort = () => { clearTimeout(timer); reject(new Error("Wait aborted")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  /** Resolves the target ledger record for a wait; only records addressed to this session qualify. */
  const resolveWaitTarget = (input: z.infer<typeof waitSchema>): Record | undefined => {
    if (input.messageId !== undefined) {
      const record = messages.get(input.messageId);
      return record && record.envelope.recipientSessionId === input.sessionId ? record : undefined;
    }
    // Newest wins: the ledger is in creation order, so the last match is the newest.
    let found: Record | undefined;
    for (const record of messages.values()) if (record.envelope.recipientSessionId === input.sessionId && record.envelope.correlationId === input.correlationId) found = record;
    return found;
  };
  const waitForResult = async (input: z.infer<typeof waitSchema>, target: Record, workspace: string, signal: AbortSignal): Promise<unknown> => {
    const messageId = target.envelope.messageId;
    const deadline = Date.now() + input.timeoutMs;
    for (;;) {
      if (closing) throw new Error("Wait aborted");
      // Re-authorize on every round: a session closed or unshared mid-wait ends the wait.
      await requireSession(input.sessionId);
      let current: { state: string; [key: string]: unknown };
      try {
        current = await options.manager.communicationRequest(input.sessionId, "get_message_result", messageId, workspace) as typeof current;
      } catch {
        throw new Error("Session closed");
      }
      const base = { sessionId: input.sessionId, messageId };
      if (current.state === "done") {
        const done = current as unknown as { latestResult: unknown; limitation: string };
        return { status: "done", ...base, availability: "available", activeTurnId: null, latestResult: done.latestResult, limitation: done.limitation };
      }
      if (current.state === "rejected") return { status: "rejected", ...base, detail: current.detail };
      if (current.state === "unknown") return { status: "unknown", ...base, detail: current.detail };
      if (current.state === "unknown_message") return { status: "unknown", ...base, detail: target.detail };
      if (Date.now() >= deadline) return { status: "pending", ...base };
      await sleep(Math.max(0, Math.min(pollMs, deadline - Date.now())), signal);
    }
  };
  const call = async (name: string, raw: unknown, signal: AbortSignal = new AbortController().signal): Promise<unknown> => {
    switch (name) {
      case "list_sessions": {
        z.object({}).strict().parse(raw);
        const sessions = await tabs();
        // externalApproval is reported only when the switch is wired at all (Taskana 4763).
        const withApproval = (tab: (typeof sessions)[number]) => options.isExternalApprovalEnabled ? { ...tab, externalApproval: approvalOn(tab.sessionId) } : tab;
        if (!options.handleOf) return { sessions: sessions.map(withApproval) };
        return { sessions: sessions.map((tab) => { const handle = options.handleOf!(tab.sessionId); const row = withApproval(tab); return handle === undefined ? row : { ...row, handle }; }) };
      }
      case "list_pending_approvals": {
        const input = listApprovalsSchema.parse(raw);
        if (input.sessionId !== undefined) {
          const tab = await requireApprovalSession(input.sessionId);
          let page: { items: unknown[]; truncated: boolean };
          try { page = await approvalsOf(tab, APPROVAL_LIMIT); } catch { throw new Error("Session closed"); }
          return { approvals: page.items, truncated: page.truncated };
        }
        // Aggregate: only sessions whose access AND approval switches are both on; a failing tab is skipped.
        const approvals: unknown[] = [];
        let truncated = false;
        for (const tab of (await tabs()).filter((t) => approvalOn(t.sessionId))) {
          let page: { items: unknown[]; truncated: boolean };
          try { page = await approvalsOf(tab, APPROVAL_LIMIT - approvals.length); } catch { continue; }
          approvals.push(...page.items);
          if (page.truncated) { truncated = true; break; }
        }
        return { approvals, truncated };
      }
      case "answer_approval": {
        const input = answerApprovalSchema.parse(raw);
        const tab = await requireApprovalSession(input.sessionId);
        let answer: { result?: unknown; settledBy?: unknown } | undefined;
        try {
          answer = await options.manager.communicationRequest(input.sessionId, "answer_approval", { approvalId: input.approvalId, decision: input.decision }, tab.workspace) as typeof answer;
        } catch {
          throw new Error("Session closed");
        }
        const base = { sessionId: input.sessionId, approvalId: input.approvalId };
        switch (answer?.result) {
          case "answered": return { ...base, status: "answered", decision: input.decision };
          case "already_answered": return { ...base, status: "already_answered", settledBy: typeof answer.settledBy === "string" ? answer.settledBy : "unknown" };
          case "not_answerable": return { ...base, status: "not_answerable" };
          default: return { ...base, status: "not_found" };
        }
      }
      case "wait_for_result": {
        const input = waitSchema.parse(raw);
        // Session authorization FIRST: an unshared or unknown session never reveals whether a message exists.
        const tab = await requireSession(input.sessionId);
        const target = resolveWaitTarget(input);
        if (!target) throw new Error("Message unavailable");
        if (waiters.size >= MAX_WAITERS) throw new Error("Too many waiters");
        const controller = new AbortController();
        waiters.add(controller);
        const onRequestGone = () => controller.abort();
        signal.addEventListener("abort", onRequestGone, { once: true });
        try {
          return await waitForResult(input, target, tab.workspace, controller.signal);
        } finally {
          signal.removeEventListener("abort", onRequestGone);
          waiters.delete(controller);
        }
      }
      case "cancel_turn": {
        const input = sessionSchema.parse(raw); const tab = await requireSession(input.sessionId);
        let result: { cancelled?: unknown; reason?: unknown; turnId?: unknown } | undefined;
        try {
          result = await options.manager.communicationRequest(input.sessionId, "cancel_turn", undefined, tab.workspace) as typeof result;
        } catch {
          throw new Error("Session closed");
        }
        return {
          sessionId: input.sessionId,
          cancelled: result?.cancelled === true,
          ...(typeof result?.reason === "string" ? { reason: result.reason } : {}),
          ...(typeof result?.turnId === "string" ? { turnId: result.turnId } : {}),
        };
      }
      case "get_session_result":
      case "get_session_status": {
        const input = sessionSchema.parse(raw); const tab = await requireSession(input.sessionId);
        const status = await options.manager.communicationRequest(input.sessionId, name, undefined, tab.workspace);
        return { ...tab, ...(status as object) };
      }
      case "send_message": {
        return sendMessage(parseOr(messageSchema, raw, 'send_message expects sessionId, payload (1..32000 chars) and mode ("next_turn" or "steer"); optional: kind, correlationId, replyTo, idempotencyKey'));
      }
      case "close_session": {
        const input = sessionSchema.parse(raw);
        if (!options.closeSessionByAgent) throw closeRefusal("not_allowed");
        try { await requireSession(input.sessionId); } catch { throw closeRefusal("not_found"); }
        let outcome: CloseSessionOutcome;
        try { outcome = await options.closeSessionByAgent(input.sessionId); }
        catch { throw closeRefusal("not_allowed"); }
        if (!outcome.ok) throw closeRefusal(outcome.reason);
        // Main already removes it from the shared Set. Keep fallback server-local
        // bookkeeping consistent when an embedder supplies its own close hook.
        agentOpenedSessions.delete(input.sessionId);
        return { sessionId: input.sessionId, closed: true };
      }
      case "create_session": {
        const input = parseOr(createSessionSchema, raw, "create_session expects workspace (absolute path); optional: engine (core|codex|claude), model, handle, firstMessage (1..32000 chars)");
        if (!options.createSessionByAgent) throw createRefusal("not_allowed");
        const createByAgent = options.createSessionByAgent;
        if (!isAbsolute(input.workspace)) throw createRefusal("folder_not_found");
        let resolved: string;
        try { resolved = await realpath(input.workspace); } catch { throw createRefusal("folder_not_found"); }
        if (restricted && !allowed.has(resolved)) throw createRefusal("not_allowed");
        const outcome = await inCreationSection(async () => {
          const at = now();
          while (creationTimes.length > 0 && creationTimes[0]! <= at - CREATE_SESSION_RATE_WINDOW_MS) creationTimes.shift();
          if (creationTimes.length >= CREATE_SESSION_RATE_LIMIT) throw createRefusal("rate_limited");
          if (aliveAgentOpened() >= MAX_AGENT_OPENED_TABS) throw createRefusal("too_many");
          let created: CreateSessionOutcome;
          try {
            created = await createByAgent({ workspace: resolved, ...(input.engine ? { engine: input.engine } : {}), ...(input.model ? { model: input.model } : {}), ...(input.handle !== undefined ? { handle: input.handle } : {}) });
          } catch { throw createRefusal("not_ready"); }
          if (!created.ok) throw createRefusal(created.reason);
          // Taskana 4808 (review F2): only a successful creation consumes the rate budget — refused
          // attempts (not_trusted, too_many, not_ready, a throwing hook) never count. Still inside
          // the section, together with the cap bookkeeping (review F4).
          creationTimes.push(at);
          agentOpenedSessions.add(created.sessionId);
          return created;
        });
        let messageId: string | undefined;
        if (input.firstMessage !== undefined) {
          // Taskana 4808 (review F1): the new tab must be INSIDE the folders list for firstMessage
          // (its delivery rides list_sessions' requireSession). A tab outside the list can appear
          // when the creator lands it on another workspace; waiting the full readiness timeout and
          // then omitting messageId would silently drop the message. Refuse up front instead — the
          // tab exists, so the error names its ids rather than hiding them.
          const tabWorkspace = options.manager.listTabs().find((t) => t.sessionId === outcome.sessionId)?.workspace;
          if (tabWorkspace !== undefined) {
            let landed: string;
            try { landed = await realpath(tabWorkspace); } catch { landed = tabWorkspace; }
            if (restricted && !allowed.has(landed)) {
              throw new Error(`create_session not_allowed: the new session landed outside the Sessions API folders list, so firstMessage cannot be delivered; the tab exists — sessionId ${outcome.sessionId}, tabId ${outcome.tabId}`);
            }
          }
          const deadline = Date.now() + (options.readyTimeoutMs ?? 10_000);
          const step = options.readyPollMs ?? 250;
          for (;;) {
            if (closing || signal.aborted) break;
            try {
              await options.manager.communicationRequest(outcome.sessionId, "get_session_status", undefined, resolved);
              messageId = (await sendMessage({ sessionId: outcome.sessionId, payload: input.firstMessage, mode: "next_turn", kind: "agent_message" })).envelope.messageId;
              break;
            } catch { /* host still booting, or the tab is not visible yet: poll */ }
            if (Date.now() >= deadline) break;
            await sleep(step, signal).catch(() => {});
          }
        }
        return { sessionId: outcome.sessionId, tabId: outcome.tabId, ...(outcome.handle !== undefined ? { handle: outcome.handle } : {}), ...(messageId !== undefined ? { messageId } : {}) };
      }
      case "get_message_status": {
        const { messageId } = statusSchema.parse(raw); const record = messages.get(messageId);
        if (!record) throw new Error("Message unavailable");
        if (options.isSessionExposed && !options.isSessionExposed(record.envelope.recipientSessionId)) throw new Error("Message unavailable");
        if (record.workspace) { if (restricted && !allowed.has(record.workspace)) throw new Error("Message outside authorized workspace"); }
        else await requireSession(record.envelope.recipientSessionId);
        try {
          const tab = await requireSession(record.envelope.recipientSessionId);
          const current = await options.manager.communicationRequest(record.envelope.recipientSessionId, name, messageId, tab.workspace) as AgentDelivery | undefined;
          if (current) { record.state = current.state; record.detail = current.detail; await persist(); }
        } catch { if (record.state === "queued") { record.state = "unknown"; record.detail = "Host disconnected; queued delivery cannot be confirmed"; await persist(); } }
        return record;
      }
      default: throw new Error("Unknown tool");
    }
  };
  const unsubscribe = options.manager.onCommunicationDelivery?.((sessionId, delivery) => {
    void (async () => {
      const tab = await requireSession(sessionId);
      const workspace = await realpath(tab.workspace);
      const existing = messages.get(delivery.envelope.messageId);
      if (existing) { existing.state = delivery.state; existing.detail = delivery.detail; }
      else if (messages.size < 10000) { messages.set(delivery.envelope.messageId, { ...delivery, workspace, hostPid: tab.pid }); }
      await persist();
    })().catch(() => { /* closing or no longer authorized */ });
  });

  // Rehydrate visible envelopes only, never replay payloads to the model.
  const restoredHosts = new Set<string>();
  let reconciling = false;
  const reconcile = async () => {
    if (reconciling) return;
    reconciling = true;
    try {
      for (const tab of await tabs()) {
        const records = [...messages.values()].filter((r) => r.envelope.recipientSessionId === tab.sessionId);
        if (!records.length) continue;
        for (const record of records.filter((r) => r.state === "queued" && r.hostPid !== tab.pid)) {
          record.state = "unknown"; record.detail = "Host restarted before queued delivery could be confirmed; no automatic model replay";
          await persist();
        }
        const key = `${tab.sessionId}:${tab.pid}`;
        if (!restoredHosts.has(key)) {
          await options.manager.communicationRequest(tab.sessionId, "restore_agent_messages", records, tab.workspace);
          restoredHosts.add(key);
        }
        for (const record of records.filter((r) => r.state === "queued")) {
          const current = await options.manager.communicationRequest(tab.sessionId, "get_message_status", record.envelope.messageId, tab.workspace) as AgentDelivery | undefined;
          if (current && (current.state !== record.state || current.detail !== record.detail)) { record.state = current.state; record.detail = current.detail; await persist(); }
        }
      }
    } catch { /* a closing/crashed host cannot authorize replay */ }
    finally { reconciling = false; }
  };
  const http = createServer(async (req, res) => {
    const deny = (status: number) => { res.writeHead(status); res.end(); };
    // Browser origins are deliberately disallowed, including localhost browser apps.
    if (req.headers.origin || req.url !== "/mcp" || !req.headers.host?.match(/^127\.0\.0\.1:\d+$/)) { deny(403); return; }
    const supplied = Buffer.from(req.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${token}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { deny(401); return; }
    if (req.method !== "POST") { deny(405); return; }
    let size = 0; const chunks: Buffer[] = [];
    const requestGone = new AbortController();
    try {
      for await (const chunk of req) { size += chunk.length; if (size > 65536) { deny(413); return; } chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const server = new Server({ name: "anycode-communication", version: "1.0.0" }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        try { return { content: [{ type: "text" as const, text: JSON.stringify(await call(request.params.name, request.params.arguments ?? {}, requestGone.signal)) }] }; }
        catch (error) { return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : "Communication request failed" }] }; }
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => { requestGone.abort(); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch { if (!res.headersSent) deny(400); else res.end(); }
  });
  http.requestTimeout = 30000;
  await new Promise<void>((resolve, reject) => { http.once("error", reject); http.listen(config.port, "127.0.0.1", resolve); });
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Communication listener unavailable");
  const url = `http://127.0.0.1:${address.port}/mcp`;
  try { await writePrivateFile(discoveryFile, JSON.stringify({ url, token, workspaces: [...allowed] })); }
  catch (error) { http.closeAllConnections(); http.close(); throw error; }
  const reconcileTimer = setInterval(() => { void reconcile(); }, 1000);
  reconcileTimer.unref();
  let closed = false;
  return { url, discoveryFile, async close() { if (closed) return; closed = true; closing = true; for (const waiter of waiters) waiter.abort(); unsubscribe?.(); clearInterval(reconcileTimer); http.closeAllConnections(); await new Promise<void>((resolve) => http.close(() => resolve())); await writes; try { const current = JSON.parse(await readFile(discoveryFile, "utf8")); if (current.token === token) await rm(discoveryFile, { force: true }); } catch { /* already removed or replaced */ } } };
}
