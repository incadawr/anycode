import { parseSessionPeerRequest, parseSessionPeerResponse, type SessionPeerRequest, type SessionPeerResponse } from "../shared/session-peers.js";
import type { PeerSessionFacts, createSessionPeerAccess } from "./session-peer-access.js";

export interface PeerHost extends PeerSessionFacts {
  title?: string; model?: string; effort?: string;
  tabId: string; sessionId: string; proc: object | null; generation: number;
  engine: "core" | "claude" | "codex";
  activity: "idle" | "running" | "waiting_approval" | "closing";
}
/** The process reference is supplied by tabs' listener, never by the wire. */
export function createSessionPeersHandler(deps: {
  current(tabId: string): PeerHost | undefined;
  targets(): PeerHost[];
  access: Pick<ReturnType<typeof createSessionPeerAccess>, "canAccess">;
  prepare(): Promise<void>;
  send?(caller: PeerHost, input: Extract<SessionPeerRequest, { operation: "send" }>["input"], authorize: (id: string) => PeerHost): Promise<{ envelope: { messageId: string }; state: "queued" | "acknowledged" | "rejected" | "unknown" }>;
}) {
  const pending = new Map<object, Set<string>>();
  return async (tabId: string, proc: object, raw: unknown): Promise<SessionPeerResponse | null> => {
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
          !deps.access.canAccess(now, now, request.operation)) return { status: "refused" };
      if (request.operation === "send" && deps.send) {
        if (request.input.reply === "on_turn_end" || request.input.mode === "steer") return { status: "unavailable" };
        const authorize = (id: string) => {
          const sender = current();
          const target = deps.targets().find(t => t.sessionId === id);
          if (!sender || sender.workspace !== caller.workspace || sender.workspaceKey !== caller.workspaceKey ||
              !target || !deps.access.canAccess(sender, target, "send")) throw new Error("Peer access refused");
          return target;
        };
        try {
          const delivery = await deps.send(now, request.input, authorize);
          return current() ? parseSessionPeerResponse({ status: "sent", messageId: delivery.envelope.messageId, state: delivery.state }) : null;
        } catch (error) {
          return current() ? (error instanceof Error && error.message === "loop_limited"
            ? { status: "refused", reason: "loop_limited" } : { status: "refused" }) : null;
        }
      }
      // Other mutations and file queries retain their dedicated admission boundary.
      if (request.operation !== "list" || request.input.cursor || request.input.ownMessageId) return { status: "unavailable" };
      const sessions = deps.targets().filter(target =>
        (request.input.scope === "granted" || target.workspaceKey === now.workspaceKey) &&
        deps.access.canAccess(now, target, "list"))
        .slice(0, request.input.limit ?? 20).map(target => ({
          sessionId: target.sessionId, tabId: target.tabId, workspace: target.workspace,
          title: target.title?.slice(0, 200), model: target.model?.slice(0, 200), effort: target.effort?.slice(0, 200),
          engine: target.engine, activity: target.activity, addressable: target.live && target.root && !target.restricted,
        }));
      return parseSessionPeerResponse({ status: "ok", sessions });
    } catch { return current() ? { status: "unknown" } : null; }
    finally {
      clearTimeout(timer); active.delete(request.requestId);
      if (!active.size) pending.delete(proc);
    }
  };
}
