// Offline Claude catalog probe. Only initialize; never a user/model frame.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
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
    guarded(['--help'], undefined, root); guarded([], frame, root); console.log('Isolation self-test PASS');
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
