import { lstatSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ChangeInterval } from './shell-correlation.js';
import type { WorkspaceFileSample } from './workspace-file-observer.js';

export interface FileIdentity {
  sessionId: string;
  workspaceKey: string;
  generation: number;
}
interface ReportedWrite {
  filePath: string;
  toolCallId: string;
  toolName: string;
}
interface FileActivity extends FileIdentity {
  canonicalPath: string;
  relativePath: string;
  toolCallId: string;
  toolName: 'Edit' | 'Write' | 'NotebookEdit' | 'Bash';
  at: number;
  evidence: 'reported_write' | 'observed_during_shell';
  confidence?: 'candidate';
  interval?: ChangeInterval;
}
export interface PathOptions {
  platform?: NodeJS.Platform;
  realpath?: (value: string) => string;
  lstat?: (value: string) => unknown;
  stat?: (value: string) => { isFile(): boolean; isDirectory(): boolean };
}
interface IndexOptions extends PathOptions {
  // Supplied by main from the current tab/process, never from reported metadata.
  current: (sessionId: string) => FileIdentity | undefined;
  now?: () => number;
  observation?: (workspace: string) => { sample?: WorkspaceFileSample; freshness: 'stale' | 'fresh' } | undefined;
}
const TTL = 30 * 60_000;
const MAX_PATH = 4096;

function pathKey(value: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return value;
  const normalized = path.win32.normalize(value).toLowerCase();
  return normalized.length > path.win32.parse(normalized).root.length
    ? normalized.replace(/\\$/, '') : normalized;
}

export function canonicalFile(workspace: string, input: string, options: PathOptions = {}): string | undefined {
  const windows = (options.platform ?? process.platform) === 'win32';
  const paths = windows ? path.win32 : path.posix;
  // The JS realpath implementation resolves dot-dot lexically before traversing links.
  const realpath = options.realpath ?? ((value: string) =>
    value.split(windows ? /[\\/]/ : /\//).includes('..')
      ? realpathSync.native(value) : realpathSync(value));
  const stat = options.stat ?? statSync;
  const key = (value: string) => pathKey(value, options.platform);
  const valid = (value: string) => typeof value === 'string' && value.length > 0
    && value.length <= MAX_PATH && !value.includes('\0');
  const git = (value: string) => value.split(windows ? /[\\/]/ : /\//)
    .some(part => (windows ? part.toLowerCase() : part) === '.git');
  const contained = (base: string, target: string) => {
    const relative = paths.relative(base, target);
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${paths.sep}`)
      && !paths.isAbsolute(relative) && !git(relative);
  };
  if (!valid(workspace) || !valid(input) || !paths.isAbsolute(workspace) || git(input)) return;
  if (windows) {
    // Drive-relative, device namespace, root-relative and alternate streams are ambiguous.
    if (/^[a-z]:(?![\\/])/i.test(input) || /^[\\/](?![\\/])/.test(input)
      || /^[\\/]{2}[?.]/.test(input)) return;
    const tail = input.slice(paths.parse(input).root.length);
    if (tail.split(/[\\/]/).some(part => /[<>:"|?*\x00-\x1f]/.test(part)
      || (part !== '.' && part !== '..' && /[. ]$/.test(part))
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) return;
  }
  try {
    const base = key(realpath(workspace));
    // Pin the exact main-known workspace; aliases/retargeting cannot silently rebind it.
    if (base !== key(workspace) || !stat(base).isDirectory()) return;
    // Keep dot-dot segments for the filesystem to traverse after symlinks.
    const resolved = paths.isAbsolute(input) ? input : `${base}${paths.sep}${input}`;
    let canonical: string;
    try {
      canonical = key(realpath(resolved));
      if (!stat(canonical).isFile()) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return;
      // A dangling symlink is an existing entry, not a safe new leaf.
      try {
        (options.lstat ?? lstatSync)(resolved);
        return;
      } catch (leafError) {
        if ((leafError as NodeJS.ErrnoException).code !== 'ENOENT') return;
      }
      const parent = key(realpath(paths.dirname(resolved)));
      if (!stat(parent).isDirectory()) return;
      canonical = paths.join(parent, paths.basename(resolved));
    }
    if (valid(canonical) && contained(base, canonical)) return canonical;
  } catch {
    // Missing/inaccessible workspace or parent is not an authorization proof.
  }
}

export class FileActivityIndex {
  private readonly records = new Map<string, FileActivity>();
  private batchState?: { remaining: number; live: Map<string, FileIdentity | undefined>; paths: Map<string, string | undefined> };
  readonly startsAt: number;
  constructor(private readonly options: IndexOptions) {
    this.startsAt = (options.now ?? Date.now)();
  }

  /** Synchronous observation transaction: caches never survive a sample or a lifecycle change. */
  batch(action: () => void): void {
    if (this.batchState) { action(); return; }
    this.batchState = { remaining: 512, live: new Map(), paths: new Map() };
    try { this.prune((this.options.now ?? Date.now)(), false); action(); }
    finally { this.batchState = undefined; }
  }

  canonical(workspace: string, input: string) { return canonicalFile(workspace, input, this.options); }

  sampler(workspace: string) {
    const value = this.options.observation?.(workspace);
    return { coverage: value?.sample?.coverage ?? 'unknown', baselineCoverage: value?.sample?.baselineCoverage ?? 'unknown',
      freshness: value?.freshness ?? 'stale' };
  }

  recent(workspaceKey: string, sessionId: string): string[] {
    this.prune((this.options.now ?? Date.now)());
    return [...this.records.values()].reverse()
      .filter(row => row.workspaceKey === workspaceKey && row.sessionId === sessionId)
      .map(row => row.relativePath).filter((value, i, all) => all.indexOf(value) === i).slice(0, 5);
  }

  private current(identity: FileIdentity): boolean {
    const cache = this.batchState?.live;
    if (cache && !cache.has(identity.sessionId)) cache.set(identity.sessionId, this.options.current(identity.sessionId));
    const live = cache ? cache.get(identity.sessionId) : this.options.current(identity.sessionId);
    return live?.workspaceKey === identity.workspaceKey && live.generation === identity.generation;
  }

  private prune(at: number, validate = true): void {
    const live = new Map<string, FileIdentity | undefined>();
    for (const [key, row] of this.records) {
      if (validate && !live.has(row.sessionId)) live.set(row.sessionId, this.options.current(row.sessionId));
      const current = live.get(row.sessionId);
      if (at < row.at || at - row.at >= TTL || (validate &&
        (current?.workspaceKey !== row.workspaceKey || current.generation !== row.generation))) this.records.delete(key);
    }
  }

  candidate(identity: FileIdentity, filePath: string, interval: ChangeInterval): boolean {
    if (!Number.isFinite(interval.start) || !Number.isFinite(interval.end) || interval.start > interval.end) return false;
    return this.insert(identity, { filePath, toolName: 'Bash', toolCallId: 'observation' }, interval);
  }

  record(identity: FileIdentity, report: ReportedWrite): boolean {
    return this.insert(identity, report);
  }

  private insert(identity: FileIdentity, report: ReportedWrite, interval?: ChangeInterval): boolean {
    const at = (this.options.now ?? Date.now)();
    if (this.batchState) {
      if (this.batchState.remaining-- <= 0) return false;
    } else this.prune(at, false);
    if (!this.current(identity) || !(interval ? report.toolName === 'Bash' : ['Edit', 'Write', 'NotebookEdit'].includes(report.toolName))
      || typeof report.toolCallId !== 'string' || !report.toolCallId.length
      || report.toolCallId.length > 256 || report.toolCallId.includes('\0')) return false;
    const cache = this.batchState?.paths;
    const pathKey = JSON.stringify([identity.workspaceKey, report.filePath]);
    if (cache && !cache.has(pathKey)) cache.set(pathKey, canonicalFile(identity.workspaceKey, report.filePath, this.options));
    const canonicalPath = cache ? cache.get(pathKey) : canonicalFile(identity.workspaceKey, report.filePath, this.options);
    if (!canonicalPath) return false;
    const paths = (this.options.platform ?? process.platform) === 'win32' ? path.win32 : path.posix;
    const key = JSON.stringify([identity.workspaceKey, canonicalPath, identity.sessionId, interval ? 'candidate' : 'reported']);
    this.records.delete(key);
    let count = 0;
    let oldest: string | undefined;
    for (const [recordKey, row] of this.records) {
      if (row.sessionId === identity.sessionId) {
        oldest ??= recordKey;
        count++;
      }
    }
    if (count >= 200 && oldest !== undefined) this.records.delete(oldest);
    if (this.records.size >= 10000) this.records.delete(this.records.keys().next().value!);
    this.records.set(key, {
      sessionId: identity.sessionId, workspaceKey: identity.workspaceKey, generation: identity.generation,
      canonicalPath, relativePath: paths.relative(identity.workspaceKey, canonicalPath),
      toolCallId: report.toolCallId, toolName: report.toolName as FileActivity['toolName'],
      at, evidence: interval ? 'observed_during_shell' : 'reported_write',
      ...(interval ? { confidence: 'candidate' as const, interval: { ...interval } } : {}),
    });
    return true;
  }

  lookup(workspaceKey: string, filePath: string): FileActivity[] {
    this.prune((this.options.now ?? Date.now)());
    const canonicalPath = canonicalFile(workspaceKey, filePath, this.options);
    if (!canonicalPath) return [];
    const result: FileActivity[] = [];
    for (const row of this.records.values()) {
      if (pathKey(row.workspaceKey, this.options.platform) === pathKey(workspaceKey, this.options.platform)
        && row.canonicalPath === canonicalPath) {
        result.push({ ...row });
        if (result.length === 20) break;
      }
    }
    return result;
  }
}
