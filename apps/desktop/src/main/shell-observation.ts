import { createShellCorrelation, type ChangeInterval } from './shell-correlation.js';
import { createWorkspaceFileObserver, type WorkspaceFileSample } from './workspace-file-observer.js';
import type { FileIdentity } from './file-activity-index.js';

type Observer = ReturnType<typeof createWorkspaceFileObserver>;
interface Workspace {
  observer: Observer;
  correlation: ReturnType<typeof createShellCorrelation>;
  members: Map<string, FileIdentity>;
  shells: Map<string, number>;
  sample?: WorkspaceFileSample;
  requested: boolean;
  running: boolean;
}
/** Main-owned metadata sampling only. Windows are approximate, never authorship evidence. */
export function createShellObservation(deps: {
  now?: () => number;
  batch?: (action: () => void) => void;
  record?: (identity: FileIdentity, path: string, interval: ChangeInterval) => void;
  observer?: typeof createWorkspaceFileObserver;
} = {}) {
  const now = deps.now ?? Date.now;
  const workspaces = new Map<string, Workspace>();
  const tabs = new Map<string, FileIdentity>();
  const request = (workspace: string, state: Workspace) => {
    state.requested = true;
    if (state.running) return;
    state.running = true;
    void (async () => {
      try {
        while (state.requested && workspaces.get(workspace) === state) {
          state.requested = false;
          const scanStart = now();
          const sample = await state.observer.refresh();
          if (workspaces.get(workspace) === state) {
            state.correlation.consume(sample, scanStart);
            state.sample = sample;
          }
        }
      } catch { state.sample = undefined; }
      finally { state.running = false; }
    })();
  };
  const forget = (tabId: string) => {
    const old = tabs.get(tabId);
    tabs.delete(tabId);
    if (!old) return;
    const state = workspaces.get(old.workspaceKey);
    if (!state) return;
    state.members.delete(tabId);
    state.correlation.forget(old.sessionId);
    for (const key of state.shells.keys()) if (JSON.parse(key)[0] === tabId) state.shells.delete(key);
    if (!state.members.size) { workspaces.delete(old.workspaceKey); state.observer.dispose(); }
  };
  return {
    sync(tabId: string, identity?: FileIdentity) {
      const old = tabs.get(tabId);
      if (old && identity && old.sessionId === identity.sessionId && old.generation === identity.generation
        && old.workspaceKey === identity.workspaceKey) return;
      forget(tabId);
      if (!identity || tabs.size >= 10000) return;
      let state = workspaces.get(identity.workspaceKey);
      if (!state) {
        if (workspaces.size >= 128) return;
        state = { observer: (deps.observer ?? createWorkspaceFileObserver)({ workspace: identity.workspaceKey,
          enabled: () => workspaces.has(identity.workspaceKey), now }),
          correlation: createShellCorrelation(now, deps.record ?? (() => {}), deps.batch),
          members: new Map(), shells: new Map(), requested: false, running: false };
        workspaces.set(identity.workspaceKey, state);
        request(identity.workspaceKey, state);
      }
      tabs.set(tabId, identity);
      state.members.set(tabId, identity);
    },
    accept(tabId: string, id: string, phase: 'start' | 'end'): boolean {
      const identity = tabs.get(tabId);
      const state = identity && workspaces.get(identity.workspaceKey);
      if (!identity || !state) return false;
      const at = now();
      for (const [key, start] of state.shells) if (at < start || at - start >= 30 * 60_000) state.shells.delete(key);
      const key = JSON.stringify([tabId, id]);
      if (phase === 'start') {
        if (state.shells.has(key)) return false;
        if (state.shells.size >= 256) {
          const oldest = state.shells.keys().next().value!;
          state.correlation.end(oldest); state.shells.delete(oldest);
        }
        state.shells.set(key, at);
        state.correlation.start(key, identity);
      } else {
        if (!state.shells.delete(key)) return false;
        state.correlation.end(key);
      }
      request(identity.workspaceKey, state);
      return true;
    },
    observation(workspace: string) {
      const state = workspaces.get(workspace);
      if (!state) return undefined;
      const sample = state.sample;
      return { sample, freshness: !sample || now() < sample.at || now() - sample.at > 2000 ? 'stale' as const : 'fresh' as const };
    },
    forget,
    dispose() { for (const tabId of tabs.keys()) forget(tabId); },
  };
}
