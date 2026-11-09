import { parseSessionPeerRequest, parseSessionPeerResponse, type SessionPeerRequest, type SessionPeerResponse } from "../shared/session-peers.js";
import path from "node:path";
import { type FileActivityIndex } from "./file-activity-index.js";
import type { createSessionPeerOpener } from "./session-peer-open.js";
import type { PeerSessionFacts } from "./session-peer-access.js";

export interface PeerHost extends PeerSessionFacts {
  turnContext?: import("../shared/session-peers.js").SessionPeerTurnContext;
  title?: string; model?: string; effort?: string;
  tabId: string; sessionId: string; proc: object | null; generation: number;
  engine: "core" | "claude" | "codex";
  activity: "idle" | "running" | "waiting_approval" | "waiting_network" | "closing";
}
/** The process reference is supplied by tabs' listener, never by the wire. */
export function createSessionPeersHandler(deps: {
  current(tabId: string): PeerHost | undefined;
  targets(): PeerHost[];
  access: { canAccess(caller: PeerHost, target: PeerHost, operation: SessionPeerRequest["operation"]): boolean | Promise<boolean>;
    canAccessWorkspace?(caller: PeerHost, workspace: string, key: string, operation: "open", allowsOpen: boolean): Promise<boolean> };
  open?: ReturnType<typeof createSessionPeerOpener>;
  prepare(): Promise<void>;
  files?: FileActivityIndex;
  send?(caller: PeerHost, input: Extract<SessionPeerRequest, { operation: "send" }>["input"], authorize: (id: string) => Promise<PeerHost>): Promise<{ envelope: { messageId: string }; state: "queued" | "acknowledged" | "rejected" | "unknown" }>;
}) {
  const pending = new Map<object, Set<string>>();
  const handle = async (tabId: string, proc: object, raw: unknown): Promise<SessionPeerResponse | null> => {
    const request = parseSessionPeerRequest(raw);
    const host = deps.current(tabId);
    if (!request || !host || host.proc !== proc || !host.live) return null;
    const caller = { ...host };
    const active = pending.get(proc) ?? new Set<string>();
    if (active.has(request.requestId) || active.size >= 64) return null;
    active.add(request.requestId); pending.set(proc, active);
    const current = () => {
      const now = deps.current(tabId);
      return now?.proc === proc && now.generation === caller.generation && now.live ? now : undefined;
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([deps.prepare(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Deadline")), 20_000); timer.unref();
      })]);
      const now = current();
      if (!now) return null;
      if (now.workspace !== caller.workspace || now.workspaceKey !== caller.workspaceKey ||
          !await deps.access.canAccess(now, now, request.operation)) return { status: "refused" };
      if (!current()) return null;
      if (request.operation === "open" && deps.open && deps.access.canAccessWorkspace) {
        const authorize = async (workspace: string, key: string, allowsOpen: boolean) => {
          const sender = current();
          if (!sender || sender.workspace !== caller.workspace || sender.workspaceKey !== caller.workspaceKey) return false;
          const allowed = await deps.access.canAccessWorkspace!(sender, workspace, key, "open", allowsOpen);
          const latest = current();
          return allowed && !!latest?.root && !latest.restricted && !latest.readOnly &&
            latest.workspace === caller.workspace && latest.workspaceKey === caller.workspaceKey;
        };
        const result = await deps.open({ ...request.input, workspace: request.input.workspace ?? caller.workspace,
          engine: request.input.engine ?? caller.engine }, { kind: "native", openerSessionId: caller.sessionId, authorize,
          deliverFirstMessage: async (sessionId, payload) => {
            const response = await handle(tabId, proc, { requestId: `${request.requestId}:first`, operation: "send",
              input: { sessionId, payload, reply: request.input.reply } });
            return response?.status === "sent" ? { state: response.state, messageId: response.messageId }
              : { state: response?.status === "refused" ? "rejected" : "unknown" };
          },
        });
        if (!result.ok) return result.sessionId && result.tabId
          ? { status: "unknown", sessionId: result.sessionId, tabId: result.tabId } : { status: "refused" };
        return parseSessionPeerResponse({ status: "opened", sessionId: result.sessionId, tabId: result.tabId,
          ...(result.handle ? { label: result.handle } : {}), ...(result.delivery ? { delivery: result.delivery } : {}) });
      }
      if (request.operation === "send" && deps.send) {
        if (request.input.mode === "steer") return { status: "unavailable" };
        const authorize = async (id: string) => {
          const sender = current();
          const target = deps.targets().find(t => t.sessionId === id);
          if (!sender || sender.workspace !== caller.workspace || sender.workspaceKey !== caller.workspaceKey ||
              !target || !await deps.access.canAccess(sender, target, "send")) throw new Error("Peer access refused");
          const latest = deps.targets().find(t => t.sessionId === id);
          const liveSender = current();
          if (!liveSender || !liveSender.root || liveSender.restricted || liveSender.readOnly || liveSender.workspace !== caller.workspace || liveSender.workspaceKey !== caller.workspaceKey || !latest?.live || !latest.root || latest.restricted || latest.proc !== target.proc || latest.generation !== target.generation || latest.workspaceKey !== target.workspaceKey) throw new Error("Peer generation changed");
          return target;
        };
        try {
          const delivery = await deps.send({ ...now, turnContext: caller.turnContext }, request.input, authorize);
          return current() ? parseSessionPeerResponse({ status: "sent", messageId: delivery.envelope.messageId, state: delivery.state }) : null;
        } catch (error) {
          return current() ? (error instanceof Error && error.message === "loop_limited"
            ? { status: "refused", reason: "loop_limited" } : { status: "refused" }) : null;
        }
      }
      if (request.operation === "who_edits" && deps.files) {
        const canonical = deps.files.canonical(now.workspaceKey!, request.input.path);
        if (!canonical) return { status: "refused" };
        const rows = deps.files.lookup(now.workspaceKey!, request.input.path);
        const records = rows.filter(row => row.evidence === "reported_write").map(row => ({
          sessionId: row.sessionId, evidence: row.evidence, toolName: row.toolName, at: row.at,
        }));
        return parseSessionPeerResponse({ status: "file_activity",
          path: path.relative(now.workspaceKey!, canonical), records,
          candidates: rows.filter(row => row.evidence === "observed_during_shell").map(row => ({
            sessionId: row.sessionId, evidence: row.evidence, toolName: row.toolName, at: row.at,
            confidence: row.confidence, interval: row.interval,
          })), sampler: deps.files.sampler(now.workspaceKey!),
          coverage: "partial", startsAt: deps.files.startsAt,
          limitations: "An empty result does not mean nobody wrote this file. Only successful Edit/Write/NotebookEdit reports are indexed; MultiEdit is not indexed. " +
            "All engines depend on observed tool events: shell windows require Bash execution starts; file reports require a supported tool name and path. " +
            "Sampling batches are bounded to 512 candidates and 4096 window comparisons; excess changes may be omitted. " +
            "Approximate shell candidates include non-zero writers but never prove authorship. Stale/partial or late baseline can miss writes; binary/unknown changes and background processes cannot be attributed. " +
            "Bounded pending pairs and dedup can omit reports, including reused ids after failed results or interrupted turns. " +
            "Records expire after 30 minutes and may be evicted by capacity limits. No ownership or syscall attribution is proven.",
        });
      }
      // Other mutations retain their dedicated admission boundary.
      if (request.operation !== "list" || request.input.cursor || request.input.ownMessageId) return { status: "unavailable" };
      const candidates = deps.targets();
      const allowed = await Promise.all(candidates.map(target =>
        (request.input.scope === "granted" || target.workspaceKey === now.workspaceKey) &&
        deps.access.canAccess(now, target, "list")));
      if (!current()) return null;
      const sessions = candidates.filter((_, index) => allowed[index])
        .slice(0, request.input.limit ?? 20).map(target => ({
          sessionId: target.sessionId, tabId: target.tabId, workspace: target.workspace,
          title: target.title?.slice(0, 200), model: target.model?.slice(0, 200), effort: target.effort?.slice(0, 200),
          ...(deps.files && target.workspaceKey === now.workspaceKey
            ? { recentPaths: deps.files.recent(now.workspaceKey!, target.sessionId) } : {}),
          engine: target.engine, activity: target.activity, addressable: target.live && target.root && !target.restricted,
        }));
      return parseSessionPeerResponse({ status: "ok", sessions });
    } catch { return current() ? { status: "unknown" } : null; }
    finally {
      clearTimeout(timer); active.delete(request.requestId);
      if (!active.size) pending.delete(proc);
    }
  };
  return handle;
}
