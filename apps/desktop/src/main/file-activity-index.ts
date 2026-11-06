import { lstatSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

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
  toolName: 'Edit' | 'Write' | 'NotebookEdit';
  at: number;
  evidence: 'reported_write';
}
interface PathOptions {
  platform?: NodeJS.Platform;
  realpath?: (value: string) => string;
  lstat?: (value: string) => unknown;
  stat?: (value: string) => { isFile(): boolean; isDirectory(): boolean };
}
interface IndexOptions extends PathOptions {
  // Supplied by main from the current tab/process, never from reported metadata.
  current: (sessionId: string) => FileIdentity | undefined;
  now?: () => number;
}
const TTL = 30 * 60_000;
const MAX_PATH = 4096;

export function canonicalFile(workspace: string, input: string, options: PathOptions = {}): string | undefined {
  const windows = (options.platform ?? process.platform) === 'win32';
  const paths = windows ? path.win32 : path.posix;
  const realpath = options.realpath ?? realpathSync;
  const stat = options.stat ?? statSync;
  const key = (value: string) => windows ? paths.normalize(value).toLowerCase() : value;
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
    const resolved = paths.resolve(base, input);
    if (!contained(base, resolved)) return;
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
  constructor(private readonly options: IndexOptions) {}

  private current(identity: FileIdentity): boolean {
    const live = this.options.current(identity.sessionId);
    return live?.workspaceKey === identity.workspaceKey && live.generation === identity.generation;
  }

  private prune(at: number): void {
    for (const [key, row] of this.records) {
      if (at - row.at >= TTL || !this.current(row)) this.records.delete(key);
    }
  }

  record(identity: FileIdentity, report: ReportedWrite): boolean {
    const at = (this.options.now ?? Date.now)();
    this.prune(at);
    if (!this.current(identity) || !['Edit', 'Write', 'NotebookEdit'].includes(report.toolName)
      || typeof report.toolCallId !== 'string' || !report.toolCallId.length
      || report.toolCallId.length > 256 || report.toolCallId.includes('\0')) return false;
    const canonicalPath = canonicalFile(identity.workspaceKey, report.filePath, this.options);
    if (!canonicalPath) return false;
    const paths = (this.options.platform ?? process.platform) === 'win32' ? path.win32 : path.posix;
    const key = JSON.stringify([identity.workspaceKey, canonicalPath, identity.sessionId]);
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
      at, evidence: 'reported_write',
    });
    return true;
  }

  lookup(workspaceKey: string, filePath: string): FileActivity[] {
    this.prune((this.options.now ?? Date.now)());
    const canonicalPath = canonicalFile(workspaceKey, filePath, this.options);
    if (!canonicalPath) return [];
    const result: FileActivity[] = [];
    for (const row of this.records.values()) {
      if (row.workspaceKey === workspaceKey && row.canonicalPath === canonicalPath) {
        result.push({ ...row });
        if (result.length === 20) break;
      }
    }
    return result;
  }
}
