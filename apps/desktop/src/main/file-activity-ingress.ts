import { realpathSync } from "node:fs";
import { normalizePeerWorkspaceKey } from "./session-peer-policy.js";
import { createShellObservation } from './shell-observation.js';
import { fileActivitySchema, shellActivitySchema } from '../shared/file-activity.js';
import { FileActivityIndex } from './file-activity-index.js';
import type { PeerHost } from './session-peers.js';

export function createFileActivityIngress(enabled: boolean, current: (tabId: string) => PeerHost | undefined) {
  if (!enabled) return undefined;
  const observation = createShellObservation({ record: (identity, path, interval) => index.candidate(identity, path, interval) });
  const tabs = new Map<string, string>();
  const identity = (host: PeerHost | undefined) => {
    if (!host?.live || !host.proc || !host.workspaceKey) return undefined;
    try {
      if (normalizePeerWorkspaceKey(realpathSync(host.workspace)) !== host.workspaceKey) return undefined;
      return { sessionId: host.sessionId, generation: host.generation, workspaceKey: host.workspaceKey };
    } catch { return undefined; }
  };
  const index = new FileActivityIndex({ observation: observation.observation, current: sessionId => {
    const tabId = tabs.get(sessionId);
    const live = tabId ? identity(current(tabId)) : undefined;
    if (!live || live.sessionId !== sessionId) { tabs.delete(sessionId); return undefined; }
    return live;
  } });
  const sync = (tabId: string) => {
    const author = identity(current(tabId));
    if (author) {
      if (!tabs.has(author.sessionId) && tabs.size >= 10000) tabs.delete(tabs.keys().next().value!);
      tabs.set(author.sessionId, tabId);
    }
    observation.sync(tabId, author);
  };
  return { index, sync, observation: observation.observation, dispose: observation.dispose, accept(tabId: string, proc: object, raw: unknown): boolean {
    const parsed = fileActivitySchema.or(shellActivitySchema).safeParse(raw);
    const host = current(tabId);
    const author = identity(host);
    if (!parsed.success || !author || host?.proc !== proc || author.generation !== parsed.data.generation) return false;
    if (!tabs.has(author.sessionId) && tabs.size >= 10000) tabs.delete(tabs.keys().next().value!);
    tabs.set(author.sessionId, tabId);
    if (parsed.data.type === 'shell_activity') {
      sync(tabId);
      return observation.accept(tabId, parsed.data.toolCallId, parsed.data.phase);
    }
    return index.record(author, parsed.data.report);
  } };
}
