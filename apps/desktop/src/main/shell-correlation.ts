import type { FileIdentity } from './file-activity-index.js';
import type { WorkspaceFileSample } from './workspace-file-observer.js';

export interface ChangeInterval { start: number; end: number }
/** Conservative metadata intervals include both walks, not just their completion times. */
export function createShellCorrelation(now: () => number,
  record: (identity: FileIdentity, path: string, interval: ChangeInterval) => void,
  batch: (action: () => void) => void = action => action()) {
  const windows = new Map<string, { identity: FileIdentity; start: number; end?: number }>();
  const active = new Map<string, string>();
  let serial = 0;
  let priorStart: number | undefined;
  let last: WorkspaceFileSample | undefined;
  const prune = () => {
    for (const [key, window] of windows) {
      if (now() < window.start || now() - window.start >= 30 * 60_000) windows.delete(key);
    }
    for (const [key, id] of active) if (!windows.has(id)) active.delete(key);
  };
  return {
    start(key: string, identity: FileIdentity) {
      prune();
      if (windows.size >= 512) windows.delete(windows.keys().next().value!);
      const id = String(++serial);
      windows.set(id, { identity: { ...identity }, start: now() });
      active.set(key, id);
      prune();
    },
    end(key: string) {
      const window = windows.get(active.get(key) ?? "");
      if (window) window.end = now();
      active.delete(key);
    },
    forget(sessionId: string) {
      for (const [key, window] of windows) if (window.identity.sessionId === sessionId) windows.delete(key);
      prune();
    },
    consume(sample: WorkspaceFileSample, scanStart: number) {
      if (sample === last) return; // frozen native IO must not advance the baseline interval
      prune();
      const interval = { start: priorStart ?? scanStart, end: sample.at };
      last = sample;
      // Partial baselines can retain old per-file metadata. Keep the earlier lower bound.
      if (sample.coverage === 'complete') priorStart = scanStart;
      else priorStart ??= scanStart;
      if (sample.baseline || interval.end < interval.start || now() < sample.at || now() - sample.at > 2000) return;
      batch(() => {
        let remaining = 4096, emitted = 0;
        for (const change of sample.changes.slice(0, 4096)) for (const window of windows.values()) {
          if (--remaining < 0 || emitted >= 512) return;
          if (window.start <= interval.end && (window.end ?? now()) >= interval.start) {
            record(window.identity, change.path, interval);
            emitted++;
          }
        }
      });
    },
  };
}
