import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertProductionPaths, assertSmokeAbsentFromAsar } from '../apps/desktop/scripts/smoke-package-guard.mjs';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'package-guard-'));
  roots.push(root);
  mkdirSync(join(root, 'app.asar.unpacked'));
  return { root, archive: join(root, 'app.asar') };
}
function pack(archive: string, files: object) {
  const header = Buffer.from(JSON.stringify({ files }));
  const prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(header.length, 12);
  writeFileSync(archive, Buffer.concat([prefix, header]));
}
function cli(root: string) {
  return spawnSync(process.execPath, ['apps/desktop/scripts/assert-package.mjs', root], { encoding: 'utf8' });
}

describe('production archive smoke guard', () => {
  it('allows dependency-owned scripts and fixture names, including nested dependencies', () => {
    assertProductionPaths(['/node_modules/node-pty/scripts/x', 'node_modules/dep/compact-fixtures/x', '/out/node_modules/dep/session-peers-smoke.js']);
    const { archive } = fixture();
    pack(archive, { node_modules: { files: { 'node-pty': { files: { scripts: { files: { x: { size: 0 } } } } } } } });
    assertSmokeAbsentFromAsar(archive);
  });
  it.each(['/scripts/x', '/scripts', 'scripts/x', '/dist/session-peers-smoke.js', '/out/engine-smoke-fixtures/x', '/out/native-double.mjs', '/out/compact-fixtures/x'])(
    'rejects app-owned %s and identifies the path', path => {
      expect(() => assertProductionPaths([path])).toThrow(`Development smoke shipped in package: ${path}`);
    });
  it('reports a leaked archive entry through the package CLI', () => {
    const { root, archive } = fixture();
    pack(archive, { dist: { files: { 'session-peers-smoke.js': { size: 0 } } } });
    const result = cli(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Development smoke shipped in package: /dist/session-peers-smoke.js');
    expect(result.stderr).not.toContain('Cannot parse archive header');
  });
  it.each(['json', 'prefix', 'length', 'files'])('distinguishes malformed %s from shipped smoke', kind => {
    const { root, archive } = fixture();
    if (kind === 'prefix') writeFileSync(archive, 'bad');
    else if (kind === 'files') pack(archive, null as unknown as object);
    else {
      const prefix = Buffer.alloc(16);
      prefix.writeUInt32LE(kind === 'length' ? 0 : 1, 12);
      writeFileSync(archive, Buffer.concat([prefix, Buffer.from('{')]));
    }
    expect(() => assertSmokeAbsentFromAsar(archive)).toThrow('Cannot parse archive header:');
    const result = cli(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('production archive check failed: Cannot parse archive header:');
    expect(result.stderr).not.toContain('Development smoke shipped');
  });
});
