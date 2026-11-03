#!/usr/bin/env node
// Deliberately does not inherit a user profile or connect to a running app.
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const modes = ['--fixture-only', '--live'].filter(x => args.includes(x));
const option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
if (args.includes('--help')) {
  console.log('Usage: --fixture-only [--keep] | --live --bin PATH --auth-from AUTH_JSON [--model MODEL] [--keep]');
  process.exit(0);
}
if (modes.length !== 1) throw Error('Choose exactly one of --fixture-only or --live');
if (modes[0] === '--live' && process.env.ANYCODE_CODEX_ORCHESTRATE_LIVE_SMOKE !== '1') {
  console.error('Live smoke requires ANYCODE_CODEX_ORCHESTRATE_LIVE_SMOKE=1');
  process.exit(1);
}
if (modes[0] === '--live' && (!option('--bin') || !option('--auth-from'))) throw Error('Live smoke requires --bin and --auth-from');
if (modes[0] === '--live' && process.env.ORCH_PROBE_NO_SANDBOX_EXEC === '1') throw Error('Live smoke requires the auth write guard');
const root = mkdtempSync(join(tmpdir(), 'anycode-orchestration-smoke-'));
try {
  if (modes[0] === '--fixture-only') {
    const home = join(root, 'home'), codexHome = join(root, 'codex-home'), userData = join(root, 'user-data');
    for (const dir of [home, codexHome, userData]) mkdirSync(dir);
    const env = { PATH: process.env.PATH, HOME: home, CODEX_HOME: codexHome, ANYCODE_USER_DATA_DIR: userData, TMPDIR: root, CI: '1' };
    const run = spawnSync(process.execPath, [resolve(import.meta.dirname, '../../../node_modules/vitest/vitest.mjs'), 'run', 'apps/desktop/src/host/engines/codex/codex-engine.test.ts', '-t', 'Codex orchestration restart'], { cwd: resolve(import.meta.dirname, '../../..'), env, encoding: 'utf8', timeout: 120000 });
    const pass = run.status === 0;
    console.log(JSON.stringify({ mode: 'fixture-only', binary: 'scripted FakeAppServer', version: 'fixture', status: pass ? 'PASS' : 'FAIL', live: 'SKIP', ui: 'SKIP', ...(args.includes('--keep') ? { root } : {}) }));
    if (!pass) { console.error(run.stderr || run.stdout || 'fixture failed'); process.exitCode = 1; }
  } else {
    const { runLive } = await import('./codex-orchestrate-live-probe.mjs');
    const liveArgs = ['--live', '--bin', resolve(option('--bin')), '--root', root, '--auth-from', resolve(option('--auth-from'))];
    if (option('--model')) liveArgs.push('--model', option('--model'));
    await runLive(liveArgs, { smoke: true });
    if (args.includes('--keep')) console.log(JSON.stringify({ root }));
  }
} finally {
  if (!args.includes('--keep')) rmSync(root, { recursive: true, force: true });
}
