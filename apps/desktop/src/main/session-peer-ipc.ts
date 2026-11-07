import { basename } from "node:path";
import { z } from "zod";
import { guardedIpcHandle } from "./ipc-guard.js";
import { normalizePeerWorkspaceKey, type SessionPeerPolicyStore } from "./session-peer-policy.js";
import { SESSION_PEER_VIEW_CHANNEL, SESSION_PEER_SET_CHANNEL, type SessionPeerViewResult } from "../shared/session-peer-view.js";

export interface SessionPeerIpcDeps {
  policy: SessionPeerPolicyStore;
  enabled(): boolean;
  tabs(): ReadonlyArray<{ tabId: string; workspace: string; childOf?: unknown }>;
  realpath(path: string): string;
  isDirectory(path: string): boolean;
  isTrusted(key: string): Promise<boolean>;
}
const tabSchema = z.object({ tabId: z.string().min(1).max(200) }).strict();
const changeSchema = tabSchema.extend({ projectKey: z.string().min(1).max(4096), enabled: z.boolean(), peerKey: z.string().min(1).max(4096).optional() }).strict();
export function createSessionPeerIpc(deps: SessionPeerIpcDeps) {
  const keyFor = (path: string): string | null => {
    try { const key = normalizePeerWorkspaceKey(deps.realpath(path)); return key && deps.isDirectory(key) ? key : null; }
    catch { return null; }
  };
  const projects = () => [...new Set([...deps.tabs().filter(t => !t.childOf).map(t => keyFor(t.workspace)).filter((k): k is string => !!k), ...deps.policy.projectKeys()])];
  async function handle(raw: unknown, write = false): Promise<SessionPeerViewResult> {
    const parsed = (write ? changeSchema : tabSchema).safeParse(raw);
    if (!parsed.success) return { ok: false, reason: "invalid" };
    const tab = deps.tabs().find(t => t.tabId === parsed.data.tabId && !t.childOf);
    const key = tab && keyFor(tab.workspace);
    if (!key) return { ok: false, reason: "unavailable" };
    const trusted = async (k: string) => {
      try { return keyFor(k) === k && await deps.isTrusted(k); } catch { return false; }
    };
    if (write) {
      const change = changeSchema.parse(raw);
      if (change.projectKey !== key) return { ok: false, reason: "invalid" };
      const peer = change.peerKey;
      if (!deps.enabled()) return { ok: false, reason: "unavailable" };
      if (peer !== undefined && (peer === key || !projects().includes(peer))) return { ok: false, reason: "invalid" };
      if (change.enabled && (!(await trusted(key)) || (peer !== undefined &&
        (!(await trusted(peer)) || !deps.policy.isNativeEnabled(key) || !deps.policy.isNativeEnabled(peer))))) return { ok: false, reason: "unavailable" };
      if (keyFor(tab.workspace) !== key || (peer !== undefined && change.enabled && keyFor(peer) !== peer)) return { ok: false, reason: "unavailable" };
      const saved = peer === undefined ? deps.policy.setNativeEnabled(key, change.enabled) : deps.policy.setPairGrant(key, peer, change.enabled);
      if (!saved) return { ok: false, reason: "io_error" };
    }
    const row = async (k: string) => ({ key: k, name: basename(k) || k, enabled: deps.policy.isNativeEnabled(k), trusted: await trusted(k), granted: k !== key && deps.policy.hasPairGrant(key, k) });
    return { ok: true, view: { available: deps.enabled(), project: await row(key), peers: await Promise.all(projects().filter(k => k !== key).map(row)) } };
  }
  return { get: (raw: unknown) => handle(raw), set: (raw: unknown) => handle(raw, true) };
}
export function registerSessionPeerIpc(deps: SessionPeerIpcDeps): void {
  const handlers = createSessionPeerIpc(deps);
  guardedIpcHandle(SESSION_PEER_VIEW_CHANNEL, (_event, raw) => handlers.get(raw), { mainWindowOnly: true });
  guardedIpcHandle(SESSION_PEER_SET_CHANNEL, (_event, raw) => handlers.set(raw), { mainWindowOnly: true });
}
