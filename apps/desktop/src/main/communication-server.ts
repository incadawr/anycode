/** Production, opt-in, local-only MCP. Independent of automation and CDP. */
import { createServer } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, rename, mkdir, rm, realpath } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { Server, StreamableHTTPServerTransport, CallToolRequestSchema, ListToolsRequestSchema } from "@anycode/core/communication-mcp";
import { z } from "zod";
import type { AgentDelivery, AgentEnvelope } from "../shared/communication.js";

export interface CommunicationManager {
  listTabs(): ReadonlyArray<{ sessionId: string; workspace: string; state: string; pid?: number | null; childOf?: { parentTabId: string } }>;
  onCommunicationDelivery?(listener: (sessionId: string, delivery: AgentDelivery) => void): () => void;
  communicationRequest(sessionId: string, operation: string, payload?: unknown, expectedWorkspace?: string): Promise<unknown>;
}
const configSchema = z.object({
  workspaces: z.array(z.string()).min(1),
  port: z.number().int().min(0).max(65535).default(0),
  discoveryFile: z.string().optional(),
}).strict();
const sessionSchema = z.object({ sessionId: z.string().min(1) }).strict();
const messageSchema = z.object({
  sessionId: z.string().min(1), payload: z.string().min(1).max(32000),
  mode: z.enum(["next_turn", "steer"]), kind: z.enum(["agent_message", "task_result"]).default("agent_message"),
  correlationId: z.string().max(200).optional(), replyTo: z.string().max(200).optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
}).strict();
const statusSchema = z.object({ messageId: z.string().min(1) }).strict();
const tools = [
  { name: "list_sessions", description: "List allowed live GUI sessions; no transcript or credentials.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "get_session_status", description: "Get engine and running/idle status for an allowed session.", inputSchema: { type: "object", properties: { sessionId: { type: "string" } }, required: ["sessionId"], additionalProperties: false } },
  { name: "get_session_result", description: "Read only latest completed public assistant text and terminal/turn identity. No reasoning or transcript. History recovery is unverified; delivery correlation does not prove application.", inputSchema: { type: "object", properties: { sessionId: { type: "string" } }, required: ["sessionId"], additionalProperties: false } },
  { name: "send_message", description: "Send an authenticated agent envelope. next_turn queues while busy; steer uses active Codex turn/steer. Acknowledged is not model-applied.", inputSchema: { type: "object", properties: { sessionId: { type: "string" }, payload: { type: "string", minLength: 1, maxLength: 32000 }, mode: { enum: ["next_turn", "steer"] }, kind: { enum: ["agent_message", "task_result"] }, correlationId: { type: "string" }, replyTo: { type: "string" }, idempotencyKey: { type: "string" } }, required: ["sessionId", "payload", "mode"], additionalProperties: false } },
  { name: "get_message_status", description: "Read delivery state. Unknown means do not blindly retry; the model may have received it.", inputSchema: { type: "object", properties: { messageId: { type: "string" } }, required: ["messageId"], additionalProperties: false } },
];

async function writePrivateFile(path: string, text: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

export async function startCommunicationServer(options: { manager: CommunicationManager; configFile: string; userData: string }): Promise<{ close(): Promise<void>; url: string; discoveryFile: string }> {
  const config = configSchema.parse(JSON.parse(await readFile(options.configFile, "utf8")));
  if (config.workspaces.some((path) => !isAbsolute(path))) throw new Error("Communication workspaces must be absolute");
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
  const call = async (name: string, raw: unknown): Promise<unknown> => {
    switch (name) {
      case "list_sessions": z.object({}).strict().parse(raw); return { sessions: await tabs() };
      case "get_session_result":
      case "get_session_status": {
        const input = sessionSchema.parse(raw); const tab = await requireSession(input.sessionId);
        const status = await options.manager.communicationRequest(input.sessionId, name, undefined, tab.workspace);
        return { ...tab, ...(status as object) };
      }
      case "send_message": {
        const input = messageSchema.parse(raw); const recipient = await requireSession(input.sessionId);
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
          const response = await options.manager.communicationRequest(input.sessionId, name, envelope, recipient.workspace) as AgentDelivery;
          record.state = response.state; record.detail = response.detail;
        } catch { record.state = "unknown"; record.detail = "Host response unavailable; do not blindly resend"; }
        await persist(); return record;
      }
      case "get_message_status": {
        const { messageId } = statusSchema.parse(raw); const record = messages.get(messageId);
        if (!record) throw new Error("Message unavailable");
        if (record.workspace) { if (!allowed.has(record.workspace)) throw new Error("Message outside authorized workspace"); }
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
    try {
      for await (const chunk of req) { size += chunk.length; if (size > 65536) { deny(413); return; } chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const server = new Server({ name: "anycode-communication", version: "1.0.0" }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        try { return { content: [{ type: "text" as const, text: JSON.stringify(await call(request.params.name, request.params.arguments ?? {})) }] }; }
        catch (error) { return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : "Communication request failed" }] }; }
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => { void server.close(); });
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
  return { url, discoveryFile, async close() { if (closed) return; closed = true; unsubscribe?.(); clearInterval(reconcileTimer); http.closeAllConnections(); await new Promise<void>((resolve) => http.close(() => resolve())); await writes; try { const current = JSON.parse(await readFile(discoveryFile, "utf8")); if (current.token === token) await rm(discoveryFile, { force: true }); } catch { /* already removed or replaced */ } } };
}
