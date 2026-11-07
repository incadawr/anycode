// Offline Claude catalog probe. Only initialize; never a user/model frame.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const frame = { type: 'control_request', request_id: 'catalog', request: { subtype: 'initialize' } };
function isolated(root) {
  const env = { HOME: path.join(root, 'home'), CLAUDE_CONFIG_DIR: path.join(root, 'config'),
    XDG_CONFIG_HOME: path.join(root, 'xdg'), XDG_CACHE_HOME: path.join(root, 'cache'),
    TMPDIR: path.join(root, 'tmp'), PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' };
  for (const [key, value] of Object.entries(env)) if (key !== 'PATH' && key !== 'LANG') fs.mkdirSync(value, { recursive: true, mode: 0o700 });
  return env;
}
function guarded(args, payload, root) {
  assert(!args.some(arg => /auth|login|continue|resume/i.test(arg)));
  for (const arg of args) {
    assert(!arg.includes(os.homedir()) && !arg.includes('~'), 'Ambient home argument refused');
    for (const value of arg.split('=')) if (path.isAbsolute(value)) {
      const relative = path.relative(root, value);
      assert(relative !== '..' && !relative.startsWith('../') && !path.isAbsolute(relative), 'Argument outside disposable root');
    }
  }
  assert(payload === undefined || JSON.stringify(payload) === JSON.stringify(frame));
}
async function run(binary, args, root, env, payload) {
  guarded(args, payload, root);
  return new Promise(resolve => {
    const child = spawn(binary, args, { cwd: root, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', bytes = 0, settled = false;
    const stop = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
    const finish = status => { if (settled) return; settled = true; clearTimeout(timer); stop(); resolve({ status, stdout }); };
    const timer = setTimeout(() => finish('timeout'), 5000);
    child.on('error', () => finish('spawn-error'));
    child.on('close', code => finish(`exit-${code}`));
    child.stdout.on('data', chunk => {
      bytes += chunk.length; if (bytes > 256 * 1024) return finish('output-limit');
      stdout += chunk;
      if (payload) for (const line of stdout.split('\n')) {
        try { const event = JSON.parse(line);
          if (event.type === 'control_response' && event.response?.request_id === 'catalog') finish('control-response');
        } catch {}
      }
    });
    child.stderr.on('data', () => {}); // No raw diagnostics or account data in reports.
    if (payload) child.stdin.write(JSON.stringify(payload) + '\n'); else child.stdin.end();
    child.stdin.on('error', () => {});
  });
}
// Fixed control-only RPC allowlist, independent of any user-provided frames.
function codexFrame(method, params, root) {
  assert(['initialize', 'initialized', 'skills/list', 'skills/extraRoots/set'].includes(method));
  if (method === 'skills/list' || method === 'skills/extraRoots/set') {
    const paths = method === 'skills/list' ? params.cwds : params.extraRoots;
    assert(Array.isArray(paths) && paths.every(p => typeof p === 'string' && path.isAbsolute(p))); guarded(paths, undefined, root);
  }
  return { jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) };
}
async function codexProbe(binary, root, env) {
  assert(binary && path.isAbsolute(binary), 'Supply the absolute trusted native executable');
  assert(fs.lstatSync(binary).isFile(), 'Use the native executable, not a symlink/wrapper');
  const magic = fs.readFileSync(binary).subarray(0, 4).toString('hex');
  assert(['cffaedfe', 'feedfacf', '7f454c46', 'cafebabe'].includes(magic), 'Native executable required');
  for (const key of ['CODEX_HOME', 'XDG_DATA_HOME']) { env[key] = path.join(root, key); fs.mkdirSync(env[key], { mode: 0o700 }); }
  const cwd = path.join(root, 'cwd'); fs.mkdirSync(cwd, { mode: 0o700 });
  const sandbox = ['-p', '(version 1)(allow default)(deny network*)'];
  const denial = process.platform === 'darwin' ? spawnSync('/usr/bin/sandbox-exec', [...sandbox, '/usr/bin/nc', '-vz', '127.0.0.1', '9'], { env, cwd, encoding: 'utf8', timeout: 3000 }) : null;
  const guardedNetwork = denial?.stderr?.includes('Operation not permitted') === true;
  const command = guardedNetwork ? '/usr/bin/sandbox-exec' : binary;
  const prefix = guardedNetwork ? [...sandbox, binary] : [];
  const offline = args => {
    guarded(args, undefined, root);
    const r = spawnSync(command, [...prefix, ...args], { env, cwd, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
    assert.equal(r.status, 0, 'Offline command failed'); return r.stdout;
  };
  const version = offline(['--version']).trim(); assert(/^codex-cli \d+\.\d+\.\d+$/.test(version));
  console.log(JSON.stringify({ executable: binary, version, sha256: crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex'), os: os.release(), arch: os.arch() }));
  const schema = path.join(root, 'schema'); fs.mkdirSync(schema);
  offline(['app-server', '--help']); offline(['app-server', 'generate-json-schema', '--out', schema]);
  for (const [file, field] of [['SkillsExtraRootsSetParams', 'extraRoots'], ['SkillsListParams', 'forceReload']]) {
    assert(JSON.parse(fs.readFileSync(path.join(schema, 'v2', file + '.json'), 'utf8')).properties[field]);
  }
  console.log('Offline schema PASS');
  if (!guardedNetwork) { console.log('Egress guard unavailable; handshake NOT RUN'); return; }
  console.log('Egress denial sentinel PASS');
  const children = [];
  function client() {
    const child = spawn(command, [...prefix, 'app-server', '--stdio'], { env, cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'] }); children.push(child);
    let nextId = 0, buffer = '', bytes = 0; const pending = new Map();
    const fail = () => { for (const p of pending.values()) p.reject(new Error('Control transport unavailable')); pending.clear(); };
    child.stderr.resume(); child.stdin.on('error', fail); child.on('error', fail); child.on('close', fail);
    child.stdout.on('data', chunk => {
      bytes += chunk.length; if (bytes > 1024 * 1024) { fail(); child.stdout.destroy(); return; }
      buffer += chunk; let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
        try { const m = JSON.parse(line), p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(new Error('Control RPC refused')) : p.resolve(m.result); } } catch { fail(); }
      }
    });
    return { request(method, params) {
      const frame = codexFrame(method, params, root), id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Control RPC timeout: ' + method)); }, 15000);
        pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
        child.stdin.write(JSON.stringify({ ...frame, id }) + '\n');
      });
    }, notify() { child.stdin.write(JSON.stringify(codexFrame('initialized', undefined, root)) + '\n'); } };
  }
  const skill = name => {
    const base = path.join(root, name, 'skills'), dir = path.join(base, name); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, 'SKILL.md'), body = `---\nname: ${name}\ndescription: Synthetic offline sentinel.\n---\nNever request a model turn.\n`;
    fs.writeFileSync(file, body, { mode: 0o400 }); fs.chmodSync(dir, 0o500); fs.chmodSync(base, 0o500);
    return { base, file, body };
  };
  const a = skill('px-a'), b = skill('px-b');
  fs.chmodSync(a.base, 0o700); const sibling = path.join(a.base, 'px-sibling'); fs.mkdirSync(sibling);
  fs.writeFileSync(path.join(sibling, 'SKILL.md'), a.body.replaceAll('px-a', 'px-sibling'), { mode: 0o400 }); fs.chmodSync(sibling, 0o500); fs.chmodSync(a.base, 0o500);
  const init = async (c, experimentalApi = false) => { await c.request('initialize', { clientInfo: { name: 'offline-probe', version: '0' }, capabilities: { experimentalApi } }); c.notify(); };
  const list = async c => {
    const r = await c.request('skills/list', { cwds: [cwd], forceReload: true });
    assert(r.data?.length === 1 && r.data[0].errors?.length === 0 && Array.isArray(r.data[0].skills)); return r.data[0].skills;
  };
  const set = (c, roots) => c.request('skills/extraRoots/set', { extraRoots: roots });
  try {
    const A = client(); await init(A); const B = client(); await init(B);
    assert(!(await list(A)).some(s => s.name.startsWith('px-')));
    for (const rootCandidate of [path.dirname(a.base), a.base, path.dirname(a.file)]) {
      await set(A, [rootCandidate]); assert((await list(A)).some(s => s.name === 'px-a' && s.path === a.file && s.enabled === true));
    }
    assert(!(await list(A)).some(s => s.name === 'px-sibling')); // Individual root excludes its sibling.
    await set(B, [b.base]);
    for (const [c, own, other] of [[A, a, b], [B, b, a]]) {
      const rows = await list(c); assert(rows.some(s => s.path === own.file)); assert(!rows.some(s => s.path === other.file));
    }
    const C = client(); await init(C); assert(!(await list(C)).some(s => s.name.startsWith('px-')));
    await set(A, []); assert(!(await list(A)).some(s => s.path === a.file));
    const native = path.join(env.CODEX_HOME, 'skills/px-a'); fs.mkdirSync(native, { recursive: true }); fs.writeFileSync(path.join(native, 'SKILL.md'), a.body);
    const D = client(); await init(D, true); await set(D, [a.base]); const clash = (await list(D)).filter(s => s.name === 'px-a');
    assert(clash.some(s => s.path === a.file) && clash.some(s => s.path === path.join(native, 'SKILL.md')));
    for (const s of [a, b]) { assert.equal(fs.readFileSync(s.file, 'utf8'), s.body); assert.equal(fs.statSync(s.file).mode & 0o777, 0o400); assert.equal(fs.statSync(s.base).mode & 0o777, 0o500); }
    console.log('Parent/skills/individual roots, sibling omission, nonexperimental RPC, locality, reset, duplicate coexistence, sealed bytes/modes PASS; model use NOT RUN');
  } finally {
    await Promise.all(children.map(child => new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once('close', resolve); try { process.kill(-child.pid, 'SIGKILL'); } catch { resolve(); }
    })));
  }
}
const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'engine-skills-probe-'));
try {
  const env = isolated(root);
  if (process.argv[2] === '--self-test') {
    assert.deepEqual(Object.keys(env).sort(), ['HOME','CLAUDE_CONFIG_DIR','XDG_CONFIG_HOME','XDG_CACHE_HOME','TMPDIR','PATH','LANG'].sort());
    for (const key of ['HOME','CLAUDE_CONFIG_DIR','XDG_CONFIG_HOME','XDG_CACHE_HOME','TMPDIR']) assert(env[key].startsWith(root + '/'));
    for (const bad of [{ type: 'user', message: 'hello' }, { type: 'assistant' }, { ...frame, extra: true }]) assert.throws(() => guarded([], bad, root));
    for (const flag of ['--resume', 'login', 'auth']) assert.throws(() => guarded([flag], undefined, root));
    for (const arg of [os.homedir(), path.join(os.homedir(), '.claude'), '--plugin-dir=' + path.join(os.homedir(), '.claude'), '/outside/plugin']) assert.throws(() => guarded([arg], undefined, root));
    guarded(['--plugin-dir', path.join(root, 'plugin')], undefined, root);
    for (const method of ['turn/start', 'thread/start', 'account/read']) assert.throws(() => codexFrame(method, {}, root));
    assert.throws(() => codexFrame('skills/extraRoots/set', { extraRoots: [os.homedir()] }, root));
    codexFrame('skills/list', { cwds: [root], forceReload: true }, root);
    guarded(['--help'], undefined, root); guarded([], frame, root); console.log('Isolation self-test PASS');
  } else if (process.argv[2] === 'codex') {
    try { await codexProbe(process.argv[3], root, env); }
    catch (error) { console.log(JSON.stringify({ status: 'FAIL', reason: error?.message?.startsWith('Control RPC') ? error.message : 'Probe assertion or offline failure', modelUse: 'NOT RUN' })); process.exitCode = 1; }
  } else {
    assert.equal(process.argv[2], 'claude');
    const binary = process.argv[3]; assert(binary && path.isAbsolute(binary), 'Supply an absolute installed CLI executable');
    const help = await run(binary, ['--help'], root, env);
    if (!help.stdout.includes('--plugin-dir')) console.log(JSON.stringify({ adapter: 'unavailable', help: help.status }));
    else {
      const plugin = path.join(root, 'plugin'); fs.mkdirSync(path.join(plugin, '.claude-plugin'), { recursive: true });
      fs.writeFileSync(path.join(plugin, '.claude-plugin/plugin.json'), '{"name":"anycode-app"}');
      const skillDir = path.join(plugin, 'skills/anycode-setup'); fs.mkdirSync(skillDir, { recursive: true });
      const skill = path.join(skillDir, 'SKILL.md');
      const body = '---\nname: anycode-setup\ndescription: Synthetic offline catalog sentinel.\n---\nNever request a model turn.\n';
      fs.writeFileSync(skill, body); fs.chmodSync(skill, 0o400);
      for (const dir of [skillDir, path.dirname(skillDir), path.join(plugin, '.claude-plugin'), plugin]) fs.chmodSync(dir, 0o500);
      fs.chmodSync(path.join(plugin, '.claude-plugin/plugin.json'), 0o400);
      const result = await run(binary, ['-p', '--input-format','stream-json','--output-format','stream-json','--verbose',
        '--setting-sources','', '--strict-mcp-config', '--plugin-dir', plugin], root, env, frame);
      const events = result.stdout.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
      const catalog = events.find(e => e.type === 'control_response' && e.response?.request_id === 'catalog');
      console.log(JSON.stringify({ status: result.status, control: catalog?.response?.subtype ?? 'unavailable (possibly login required)',
        appCommandObserved: JSON.stringify(catalog?.response?.response?.commands ?? []).includes('anycode-app:'),
        sealedBodyUnchanged: fs.readFileSync(skill, 'utf8') === body, modelUse: 'not tested' }));
      for (const dir of [plugin, path.join(plugin, '.claude-plugin'), path.dirname(skillDir), skillDir]) fs.chmodSync(dir, 0o700);
    }
  }
} finally {
  const unseal = dir => {
    if (!fs.lstatSync(dir).isDirectory()) return;
    fs.chmodSync(dir, 0o700); for (const name of fs.readdirSync(dir)) unseal(path.join(dir, name));
  };
  unseal(root); fs.rmSync(root, { recursive: true, force: true });
}
