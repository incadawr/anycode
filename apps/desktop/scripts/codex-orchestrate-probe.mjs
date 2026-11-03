#!/usr/bin/env node
// Isolated orchestration probes. Never prints raw server replies or config.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync, realpathSync, lstatSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
if (args.includes('--help')) {
  console.log('Usage: node codex-orchestrate-probe.mjs --no-inference --bin PATH --root EMPTY_DIR\n       node codex-orchestrate-probe.mjs --live --bin PATH --root EMPTY_DIR --auth-from AUTH_JSON [--model MODEL]');
  process.exit(0);
}
if (args.includes('--live')) {
  const { runLive } = await import('./codex-orchestrate-live-probe.mjs');
  await runLive(args);
  process.exit(process.exitCode || 0);
}

if (!args.includes('--bin') || !args.includes('--root') || !args.includes('--no-inference')) {
  throw new Error('Usage: --bin PATH --root EMPTY_DIRECTORY --no-inference');
}
const bin = resolve(value('--bin'));
const root = resolve(value('--root'));
if (root === '/' || root === realpathSync(process.env.HOME || '/')) throw new Error('Use an isolated root');
mkdirSync(root, { recursive: true });
if (lstatSync(root).isSymbolicLink() || readdirSync(root).length !== 0) throw new Error('Root must be an empty, non-symlink directory');
const home = join(root, 'home'), codexHome = join(root, 'codex-home'), cwd = join(root, 'workspace');
for (const dir of [home, codexHome, cwd, join(root, 'user-data')]) mkdirSync(dir, { recursive: true });
const env = { PATH: process.env.PATH, HOME: home, CODEX_HOME: codexHome, ANYCODE_USER_DATA_DIR: join(root, 'user-data'), TMPDIR: root };
const run = (...argv) => spawnSync(bin, argv, { env, cwd, encoding: 'utf8', timeout: 10000 });
const version = run('--version');
if (version.status !== 0) throw new Error('version probe failed');
const match = /^codex-cli (0\.(\d+)\.\d+)/m.exec(version.stdout);
if (!match || +match[2] < 144 || +match[2] >= 167) throw new Error('SKIP: version outside supported manifest range');
const help = run('app-server', 'generate-json-schema', '--help');
if (help.status !== 0 || !help.stdout.includes('--experimental')) throw new Error('experimental schema flag unavailable');
writeFileSync(join(codexHome, 'config.toml'), '[features]\nmulti_agent = true\n[mcp_servers.ambient]\ncommand = "/usr/bin/true"\n[mcp_servers.second]\ncommand = "/usr/bin/true"\n');
const child = spawn(bin, ['app-server', '--stdio'], { env, cwd, stdio: ['pipe', 'pipe', 'ignore'], detached: process.platform !== 'win32' });
const pending = new Map(); let id = 0;
const fail = (error) => { for (const p of pending.values()) p.reject(error); pending.clear(); };
child.on('error', fail); child.on('exit', () => fail(new Error('server exited')));
createInterface({ input: child.stdout }).on('line', line => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  const p = pending.get(msg.id); if (!p) return;
  pending.delete(msg.id); clearTimeout(p.timer);
  if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`)); else p.resolve(msg.result);
});
function request(method, params) {
  return new Promise((resolve, reject) => {
    const n = ++id;
    const timer = setTimeout(() => { pending.delete(n); reject(new Error(`${method}: deadline`)); }, 10000);
    pending.set(n, { resolve, reject, timer, method });
    child.stdin.write(JSON.stringify({ id: n, method, params }) + '\n');
  });
}
const tools = [{ type: 'function', name: 'anycode_agent', description: 'fixture agent', inputSchema: { type: 'object', properties: {} } }];
const common = { cwd, sandbox: 'read-only', approvalPolicy: 'never', approvalsReviewer: 'user', dynamicTools: tools };
const off = { mcp_servers: { ambient: { enabled: false }, second: { enabled: false } }, features: { multi_agent: false } };
const on = { mcp_servers: { second: { command: '/usr/bin/true' } }, features: { multi_agent: true } };
const summary = x => ({ id: x.thread?.id, turns: x.thread?.turns?.length, sandbox: x.sandbox, approvalPolicy: x.approvalPolicy, approvalsReviewer: x.approvalsReviewer });
try {
  await request('initialize', { clientInfo: { name: 'orchestration-probe', version: '0.0.0' }, capabilities: { experimentalApi: true } });
  child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  const config = await request('config/read', { cwd, includeLayers: true });
  const c = config.config || {};
  console.log(JSON.stringify({ version: match[1], config: { ambient: !!c.mcp_servers?.ambient, second: !!c.mcp_servers?.second, multi_agent: c.features?.multi_agent, layers: Array.isArray(config.layers) } }));
  const start = await request('thread/start', { ...common, developerInstructions: 'fixture base', config: on });
  console.log(JSON.stringify({ step: 'start', ...summary(start) }));
  const threadId = start.thread.id;
  try {
    // Neither tested experimental schema declares dynamicTools on resume.
    const { dynamicTools: _declarations, ...resumeCommon } = common;
    for (const [label, instructions, config] of [['on', 'fixture base\nfixture orchestrate', off], ['off', 'fixture base', on]]) {
      const res = await request('thread/resume', { ...resumeCommon, threadId, developerInstructions: instructions, config });
      console.log(JSON.stringify({ step: label, sameThread: res.thread?.id === threadId, ...summary(res) }));
    }
  } catch (error) {
    console.log(JSON.stringify({ step: 'resume', accepted: false, reason: error.message.includes('no rollout found') ? 'no rollout found' : 'other error' }));
    process.exitCode = 1;
  }
  try {
    const read = await request('thread/read', { threadId, includeTurns: true });
    console.log(JSON.stringify({ step: 'read', sameThread: read.thread?.id === threadId, turns: read.thread?.turns?.length }));
  } catch { console.log(JSON.stringify({ step: 'read', accepted: false })); }
  const fresh = await request('thread/start', { ...common, developerInstructions: 'fixture base\nfixture orchestrate', config: off });
  console.log(JSON.stringify({ step: 'start-on', newThread: fresh.thread?.id !== threadId, turns: fresh.thread?.turns?.length, sandbox: fresh.sandbox, approvalPolicy: fresh.approvalPolicy }));
  try {
    const status = await request('mcpServerStatus/list', { threadId: fresh.thread.id });
    const names = status.data?.map(item => item.name) || [];
    console.log(JSON.stringify({ step: 'start-on-mcp', ambient: names.includes('ambient'), second: names.includes('second') }));
  } catch { console.log(JSON.stringify({ step: 'start-on-mcp', available: false })); }
  console.log('No-inference: response acceptance does not establish effective instructions or tools.');
} catch (error) {
  console.error(String(error.message)); process.exitCode = 1;
} finally {
  child.stdin.end();
  if (process.platform !== 'win32' && child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
  else child.kill();
  setTimeout(() => { if (child.exitCode === null) { try { process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-child.pid, 'SIGKILL'); } catch {} } }, 1000).unref();
}
