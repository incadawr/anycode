import { mkdtempSync, mkdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileActivityIndex, canonicalFile, type FileIdentity } from './file-activity-index.js';

let root: string;
let now: number;
let live: Map<string, FileIdentity>;
let index: FileActivityIndex;
const write = (filePath: string, toolCallId = 'call') => ({ filePath, toolCallId, toolName: 'Write' as const });
const identity = (sessionId: string, workspaceKey = root, generation = 1) => ({ sessionId, workspaceKey, generation });
const add = (id: FileIdentity) => { live.set(id.sessionId, id); return id; };
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'file-index-')));
  now = 0;
  live = new Map();
  index = new FileActivityIndex({ current: id => live.get(id), now: () => now });
  writeFileSync(path.join(root, 'file'), '');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('reported file activity', () => {
  it('keeps both root writers, canonical aliases and exact workspace separation', () => {
    const a = add(identity('a'));
    const b = add(identity('b'));
    mkdirSync(path.join(root, 'other'));
    const other = add(identity('other', path.join(root, 'other')));
    expect(index.record(a, write('./file'))).toBe(true);
    expect(index.record(b, write(path.join(root, 'file')))).toBe(true);
    expect(index.record(other, write('file'))).toBe(true);
    symlinkSync(path.join(root, 'file'), path.join(root, 'alias'));
    expect(index.lookup(root, 'alias').map(r => r.sessionId)).toEqual(['a', 'b']);
    expect(index.lookup(other.workspaceKey, 'file').map(r => r.sessionId)).toEqual(['other']);
    expect(index.lookup(root, 'other/file')).toEqual([]);
    expect(index.recent(other.workspaceKey, 'a')).toEqual([]);
    expect(index.recent(root, 'a')).toEqual(['file']);
    expect(index.record(a, write('alias', 'new-call'))).toBe(true);
    expect(index.lookup(root, 'file')).toHaveLength(2);
  });

  it('supports new and deleted files with an existing canonical parent', () => {
    const a = add(identity('a'));
    mkdirSync(path.join(root, 'dir'));
    symlinkSync(path.join(root, 'dir'), path.join(root, 'link'));
    expect(index.record(a, write('link/new'))).toBe(true);
    expect(index.lookup(root, 'dir/new')).toHaveLength(1);
    expect(index.record(a, write('file'))).toBe(true);
    unlinkSync(path.join(root, 'file'));
    expect(index.lookup(root, 'file')).toHaveLength(1);
    expect(index.record(a, write('missing/leaf'))).toBe(false);
    expect(index.record(a, write('dir'))).toBe(false);
  });

  it('rejects outside, git, symlink escape and malformed paths', () => {
    const a = add(identity('a'));
    mkdirSync(path.join(root, '.git'));
    writeFileSync(path.join(root, '.git', 'config'), '');
    symlinkSync(tmpdir(), path.join(root, 'escape'));
    symlinkSync(path.join(root, '..', 'absent-outside-target'), path.join(root, 'dangling'));
    symlinkSync(path.join(root, '.git'), path.join(root, 'git-alias'));
    for (const file of ['../outside', root + '-sibling/file', '.git/config', '.git/../file',
      'escape/outside', 'dangling', 'git-alias/config', '', 'file\0bad', 'x'.repeat(4097)]) {
      expect(index.record(a, write(file)), file).toBe(false);
      expect(index.lookup(root, file), file).toEqual([]);
    }
    expect(index.record(a, write('file'))).toBe(true);
    const moved = path.join(root, 'moved');
    mkdirSync(moved);
    symlinkSync(moved, path.join(root, 'workspace-alias'));
    expect(index.lookup(path.join(root, 'workspace-alias'), '../file')).toEqual([]);
  });

  it.each(['victim', 'file'])('refuses symlink dot-dot escape to %s on the real filesystem', leaf => {
    const workspace = path.join(root, 'workspace');
    const outside = path.join(root, 'outside');
    mkdirSync(workspace);
    mkdirSync(outside);
    mkdirSync(path.join(outside, 'dir'));
    writeFileSync(path.join(workspace, 'file'), '');
    writeFileSync(path.join(outside, 'file'), '');
    symlinkSync(path.join(outside, 'dir'), path.join(workspace, 'escape'));
    const a = add(identity('a', workspace));
    for (const input of [`escape/../${leaf}`, `${workspace}/escape/../${leaf}`]) {
      expect(index.record(a, write(input)), input).toBe(false);
      expect(index.lookup(workspace, input)).toEqual([]);
      expect(index.lookup(workspace, leaf)).toEqual([]);
    }
  });

  it('records dot-dot after a real directory with the canonical key', () => {
    mkdirSync(path.join(root, 'sub'));
    expect(index.record(add(identity('a')), write('sub/../file'))).toBe(true);
    expect(index.lookup(root, 'file')[0]?.canonicalPath).toBe(path.join(root, 'file'));
  });

  it('does not fold POSIX workspace case even with identical canonical file facts', () => {
    const a = add(identity('a', '/Repo'));
    const posix = new FileActivityIndex({ current: id => live.get(id), platform: 'linux',
      realpath: value => value.endsWith('/file') ? '/Repo/file' : value,
      stat: () => ({ isFile: () => true, isDirectory: () => true }) });
    expect(posix.record(a, write('file'))).toBe(true);
    expect(posix.lookup('/repo', 'file')).toEqual([]);
    expect(posix.lookup('/Repo', 'file')).toHaveLength(1);
  });

  it('expires records when the injected clock steps backwards', () => {
    now = 1000;
    expect(index.record(add(identity('a')), write('file'))).toBe(true);
    now = -1000;
    expect(index.lookup(root, 'file')).toEqual([]);
  });

  it('refuses a pinned workspace that was replaced by a symlink', () => {
    const pinned = path.join(root, 'pinned');
    const moved = path.join(root, 'moved');
    mkdirSync(pinned);
    writeFileSync(path.join(pinned, 'file'), '');
    const a = add(identity('a', pinned));
    expect(index.record(a, write('file'))).toBe(true);
    renameSync(pinned, moved);
    symlinkSync(moved, pinned);
    expect(index.lookup(pinned, 'file')).toEqual([]);
    expect(index.record(a, write('file'))).toBe(false);
  });

  it('preserves POSIX case and refuses filesystem failures', () => {
    const a = add(identity('a'));
    expect(index.record(a, write('File'))).toBe(true);
    expect(index.lookup(root, 'file')).toEqual([]);
    const failing = new FileActivityIndex({ current: id => live.get(id), realpath: () => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    } });
    expect(failing.record(a, write('file'))).toBe(false);
  });

  it('filters closed sessions, old generations and relocated workspaces at ingress and lookup', () => {
    const a = add(identity('a'));
    index.record(a, write('file'));
    live.delete('a');
    expect(index.lookup(root, 'file')).toEqual([]);
    expect(index.record(a, write('file'))).toBe(false);
    add(a);
    index.record(a, write('file'));
    add(identity('a', root, 2));
    expect(index.lookup(root, 'file')).toEqual([]);
    expect(index.record(a, write('file'))).toBe(false);
    const fresh = live.get('a')!;
    index.record(fresh, write('file'));
    add(identity('a', path.join(root, 'elsewhere'), 2));
    expect(index.lookup(root, 'file')).toEqual([]);
  });

  it('expires at thirty minutes and refreshes an existing session/path record', () => {
    const a = add(identity('a'));
    index.record(a, write('file'));
    now = 30 * 60_000 - 1;
    expect(index.lookup(root, 'file')).toHaveLength(1);
    index.record(a, write('file', 'refresh'));
    now += 30 * 60_000 - 1;
    expect(index.lookup(root, 'file')[0]?.toolCallId).toBe('refresh');
    now++;
    expect(index.lookup(root, 'file')).toEqual([]);
  });

  it('bounds paths per session, evicting least recently reported paths', () => {
    const a = add(identity('a'));
    for (let n = 0; n < 200; n++) index.record(a, write(`new-${n}`));
    index.record(a, write('new-0', 'refresh'));
    index.record(a, write('new-200'));
    expect(index.lookup(root, 'new-0')).toHaveLength(1);
    expect(index.lookup(root, 'new-1')).toEqual([]);
    expect(index.lookup(root, 'new-200')).toHaveLength(1);
  });

  it('bounds app records and exact query sessions', () => {
    for (let n = 0; n < 10001; n++) index.record(add(identity(`s${n}`)), write(`new-${n}`));
    expect(index.lookup(root, 'new-0')).toEqual([]);
    expect(index.lookup(root, 'new-1')).toHaveLength(1);
    expect(index.lookup(root, 'new-10000')).toHaveLength(1);
    for (let n = 0; n < 21; n++) index.record(add(identity(`writer${n}`)), write('file'));
    expect(index.lookup(root, 'file')).toHaveLength(20);
  });

  it('projects only allowlisted metadata and returns detached records', () => {
    const a = add(identity('a'));
    const payload = { ...write('file'), content: 'CONTENT_SENTINEL', diff: 'DIFF_SENTINEL',
      command: 'COMMAND_SENTINEL', arguments: { secret: 'ARG_SENTINEL' }, sessionId: 'forged' };
    expect(index.record(a, payload)).toBe(true);
    const rows = index.lookup(root, 'file');
    expect(rows).toEqual([{ ...a, canonicalPath: path.join(root, 'file'), relativePath: 'file',
      toolName: 'Write', toolCallId: 'call', at: 0, evidence: 'reported_write' }]);
    rows[0]!.sessionId = 'mutated';
    expect(index.lookup(root, 'file')[0]?.sessionId).toBe('a');
    for (const toolName of ['Bash', '', 'Write'.repeat(100)]) {
      expect(index.record(a, { ...write('file'), toolName })).toBe(false);
    }
    expect(index.record(a, { ...write('file'), toolCallId: 'x'.repeat(257) })).toBe(false);
    for (const toolName of ['Edit', 'NotebookEdit']) expect(index.record(a, { ...write('file'), toolName })).toBe(true);
  });
});

it('handles Windows drive, UNC, separators and case with injected filesystem facts', () => {
  const realpath = (value: string) => {
    if (/missing$/i.test(value)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return path.win32.normalize(value);
  };
  const options = { platform: 'win32' as const, realpath,
    lstat: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }, stat: () => ({ isFile: () => true, isDirectory: () => true }) };
  for (const workspace of ['C:\\Repo', '\\\\server\\share\\Repo']) {
    const canonical = (file: string) => canonicalFile(workspace, file, options);
    expect(canonical('Dir/File')).toBe(canonical('dir\\file'));
    expect(canonical('missing')).toBe(path.win32.join(workspace, 'missing').toLowerCase());
    for (const file of ['C:relative', '\\rooted', 'D:\\outside', '..\\outside', '.GIT\\config',
      '\\\\other\\share\\file', 'file:stream', 'bad*name', 'bad?name', 'bad|name', 'bad\x01name', 'CON.txt', 'trailing.', 'trailing ', '\\\\?\\C:\\Repo\\file']) {
      expect(canonical(file), file).toBeUndefined();
    }
  }
});

it('uses Windows canonical file and workspace keys in the index', () => {
  const current = identity('win', 'C:\\Repo');
  const win = new FileActivityIndex({ current: () => current, platform: 'win32',
    realpath: value => path.win32.normalize(value),
    stat: () => ({ isFile: () => true, isDirectory: () => true }) });
  expect(win.record(current, write('DIR/File'))).toBe(true);
  expect(win.lookup(current.workspaceKey, 'c:/repo/dir/file')).toHaveLength(1);
  expect(win.lookup('c:/repo', 'dir/file')).toHaveLength(1);
  expect(win.lookup(current.workspaceKey + path.win32.sep, 'dir/file')).toHaveLength(1);
  expect(win.lookup('C:\\Other', 'dir/file')).toEqual([]);
});

it('passes raw Windows dot-dot paths and missing parents to the injected filesystem', () => {
  const seen: string[] = [];
  const options = { platform: 'win32' as const, realpath: (value: string) => {
    seen.push(value);
    if (value.endsWith('victim')) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return value.includes('escape') ? 'D:\\outside' : path.win32.normalize(value);
  }, lstat: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
  stat: () => ({ isFile: () => true, isDirectory: () => true }) };
  expect(canonicalFile('C:\\Repo', 'escape\\..\\file', options)).toBeUndefined();
  expect(seen).toContain('c:\\repo\\escape\\..\\file');
  expect(canonicalFile('C:\\Repo', 'escape\\..\\victim', options)).toBeUndefined();
  expect(seen).toContain('c:\\repo\\escape\\..');
});

it('refuses outside candidate paths and keeps candidate confidence separate from reports', () => {
  const a = add(identity('a'));
  expect(index.candidate(a, '../outside', { start: 0, end: 1 })).toBe(false);
  expect(index.record(a, { ...write('file'), toolName: 'Bash' })).toBe(false);
  expect(index.candidate(a, 'file', { start: 2, end: 1 })).toBe(false);
  expect(index.candidate(a, 'file', { start: 0, end: 1 })).toBe(true);
  expect(index.lookup(root, 'file')).toMatchObject([{ evidence: 'observed_during_shell', confidence: 'candidate' }]);
});
