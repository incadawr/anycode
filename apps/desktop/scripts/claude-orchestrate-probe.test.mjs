import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { compareSnapshots, preflight, runProbe, spawnArgs, tools } from './claude-orchestrate-probe.mjs';

const fixture = JSON.parse(await readFile(new URL('./claude-orchestrate-fixture.json', import.meta.url), 'utf8'));
const secret = 'SENTINEL_SECRET_owner@example.invalid_/private/sentinel/auth-source';
test('OFF/ON/OFF compares resolved auth, provider, model, env and helper without serializing values', () => {
  const base = { authSource: secret, provider: 'synthetic', baseUrl: 'http://endpoint.invalid', model: 'model', env: { B: secret, A: 'a' }, apiKeyHelper: secret };
  assert.deepEqual(compareSnapshots(base, { ...base, env: { A: 'a', B: secret } }, base), fixture.facts.equivalence);
  for (const field of Object.keys(base)) {
    assert.equal(compareSnapshots(base, { ...base, [field]: 'different' }, base)[field], 'changed');
    assert.equal(compareSnapshots(base, base, { ...base, [field]: undefined })[field], 'unknown');
    assert.equal(compareSnapshots(base, { ...base, [field]: null }, base)[field], 'unknown');
  }
  assert.ok(!JSON.stringify(compareSnapshots(base, base, base)).includes(secret));
  assert.ok(Object.values(compareSnapshots(base, base)).every(v => v === 'unknown'));
});
test('settings, auth and managed gates fail closed before any transport replacement', () => {
  assert.deepEqual(preflight(fixture.facts), []);
  for (const group of ['equivalence', 'suppression']) for (const key of Object.keys(fixture.facts[group])) {
    for (const value of [undefined, 'unknown', 'changed']) {
      const facts = structuredClone(fixture.facts); facts[group][key] = value;
      assert.ok(preflight(facts).some(r => r.includes(key)));
    }
  }
  for (const managed of [undefined, {}, { state: 'unknown', hooks: false, permissions: false }, { state: 'absent', hooks: true, permissions: false }, { state: 'safe-verified', hooks: false, permissions: true }])
    assert.ok(preflight({ ...fixture.facts, managed }).some(r => r.includes('managed policy')));
  assert.deepEqual(preflight({ ...fixture.facts, managed: { state: 'safe-verified', hooks: false, permissions: false } }), []);
  assert.ok(preflight({ ...fixture.facts, prePayload: undefined }).some(r => r.includes('before sending')));
});

async function withStub(scenario, fn) {
  const root = await mkdtemp(join(tmpdir(), 'claude-double-')), binary = join(root, 'claude');
  const source = String.raw`#!${process.execPath}
import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const scenario = ${JSON.stringify(scenario)}, args = process.argv.slice(2), secret = ${JSON.stringify(secret)};
const value = flag => args[args.indexOf(flag) + 1];
const emit = m => process.stdout.write(JSON.stringify(m) + '\n');
assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
assert.equal(process.env.ANTHROPIC_AUTH_TOKEN, undefined);
assert.equal(process.env.CLAUDECODE, undefined);
if (args[0] === '--version') { console.log(scenario === 'version' ? secret : scenario === 'unsupported-version' ? '2.1.999' : '2.1.296 (Claude Code)'); process.exit(0); }
if (args[0] === '--help') { console.log(scenario === 'flags' ? '' : '--tools --setting-sources --settings --permission-mode --strict-mcp-config --disable-slash-commands --resume --session-id'); process.exit(0); }
assert.ok(process.env.CLAUDE_CONFIG_DIR.startsWith(process.env.TMPDIR));
assert.equal(value('--permission-mode'), 'manual');
assert.equal(value('--mcp-config'), '{"mcpServers":{}}');
assert.ok(args.includes('--strict-mcp-config') && args.includes('--disable-slash-commands'));
const on = args.includes('--tools'), ref = value(args.includes('--resume') ? '--resume' : '--session-id');
const history = join(process.env.CLAUDE_CONFIG_DIR, ref);
if (args.includes('--resume')) assert.ok(existsSync(history), 'resume must use a persisted ref');
if (on) { assert.equal(value('--tools'), 'Read,Glob,Grep'); assert.equal(value('--setting-sources'), ''); assert.equal(value('--settings'), '{"disableAllHooks":true}'); }
else assert.equal(value('--setting-sources'), 'user,project,local');
let initialized = false, ack = false, pending = new Set();
function done() {
  if (scenario === 'plan' && on) mkdirSync(join(process.env.CLAUDE_CONFIG_DIR, 'plans'), { recursive: true });
  if (scenario === 'mutation' && on) writeFileSync('forbidden-write', 'bad');
  emit({ type: 'result', subtype: 'success', is_error: scenario === 'result-error', session_id: ref, result: secret });
}
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.type === 'control_request') {
    assert.deepEqual(m.request.sdkMcpServers, ['anycode']); initialized = true;
    emit({ type: 'control_request', request_id: 'mcp', request: { subtype: 'mcp_message', server_name: 'anycode', message: { jsonrpc: '2.0', id: 1, method: 'tools/list' } } });
  } else if (m.type === 'control_response' && m.response.request_id === 'mcp') {
    assert.deepEqual(m.response.response.mcp_response.result.tools.map(t => t.name), ['agent', 'agent_status']); ack = true;
    emit({ type: 'control_response', response: { subtype: 'success', request_id: 'initialize', response: { account: { tokenSource: secret } } } });
  } else if (m.type === 'user') {
    assert.ok(initialized && ack, 'no payload before handshake'); assert.equal(m.session_id, ref);
    writeFileSync(history, 'persisted');
    if (scenario === 'timeout') return;
    if (scenario === 'malformed') { console.log(secret); return; }
    process.stderr.write(secret);
    emit({ type: 'system', subtype: 'init', session_id: scenario === 'ref' ? 'other' : ref, model: on && scenario === 'model' ? 'changed' : 'synthetic-model',
      claude_code_version: scenario === 'version-drift' ? '2.1.999' : '2.1.296', permissionMode: on && scenario === 'mode' ? 'plan' : 'default', apiKeySource: secret, cwd: process.cwd(),
      tools: on && scenario === 'inventory' ? [...${JSON.stringify(tools)}, 'Bash'] : ${JSON.stringify(tools)},
      skills: (on && scenario === 'skills') || (args.includes('--resume') && !on && scenario === 'off-drift') ? [secret] : [], slash_commands: on && scenario === 'slash' ? ['execute'] : [],
      mcp_servers: [{ name: on && scenario === 'mcp' ? 'foreign' : 'anycode' }] });
    emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: on && scenario === 'auto-execution' ? 'Write' : 'Read', input: { path: secret } }] } });
    if (!on || scenario === 'no-deny') return done();
    if (scenario === 'hook') { emit({ type: 'control_request', request_id: 'hook', request: { subtype: 'hook_callback' } }); return; }
    for (const name of ['Write', 'Bash', 'Task', 'Read', 'Glob', 'Grep', 'Unknown', 'mcp__foreign__execute', 'EnterPlanMode']) {
      pending.add(name); emit({ type: 'control_request', request_id: name, request: { subtype: 'can_use_tool', tool_name: name, input: { path: secret } } });
    }
  } else if (m.type === 'control_response') {
    if (scenario === 'hook') { assert.equal(m.response.subtype, 'error'); return done(); }
    assert.equal(m.response.response.behavior, 'deny'); pending.delete(m.response.request_id);
    if (!pending.size) done();
  }
});
`;
  try { await writeFile(binary, source, { mode: 0o700 }); return await fn(binary); }
  finally { await rm(root, { recursive: true, force: true }); }
}
test('executable stub verifies first-payload argv, fresh/resume/default, MCP handshake and early deny', async () => {
  await withStub('ok', async binary => {
    const report = await runProbe({ binary, facts: fixture.facts });
    assert.deepEqual(report.checks, fixture.checks);
    assert.equal(report.available, false); // Synthetic evidence never qualifies a real version.
    assert.equal(report.reasons.length, 1);
    assert.equal(report.version, fixture.version);
    assert.deepEqual(tools, fixture.frames.init.tools);
    assert.deepEqual(spawnArgs('on-resume', 'ref').slice(-2), ['--resume', 'ref']);
    assert.deepEqual(spawnArgs('on-fresh', 'ref').slice(-2), ['--session-id', 'ref']);
  });
});
test('unknown preflight sends no payload; metadata and failures never leak raw values', async () => {
  await withStub('ok', async binary => {
    const report = await runProbe({ binary });
    assert.deepEqual(report.checks, { flags: true });
    assert.ok(report.reasons.some(r => r.includes('managed policy')));
  });
  const cases = { version: 'version', 'unsupported-version': 'version', flags: 'flags', inventory: 'transport-posture-drift', mode: 'transport-posture-drift', skills: 'transport-posture-drift', slash: 'transport-posture-drift', mcp: 'transport-posture-drift', hook: 'transport-posture-drift', 'auto-execution': 'transport-posture-drift', ref: 'off-fresh', model: 'modelRestored', 'version-drift': 'off-fresh', plan: 'noPlanOrMutation', mutation: 'noPlanOrMutation', 'off-drift': 'offRestored', 'result-error': 'off-fresh', 'no-deny': 'on-resume', malformed: 'invalid-transport-frame', timeout: 'process-timeout' };
  for (const [scenario, check] of Object.entries(cases)) {
    await withStub(scenario, async binary => {
      const report = await runProbe({ binary, facts: fixture.facts, timeoutMs: scenario === 'timeout' ? 200 : 5000 });
      assert.ok(report.reasons.length > 1, scenario);
      if (scenario === 'version') assert.equal(report.version, null);
      else if (scenario === 'unsupported-version') { assert.deepEqual(report.checks, { flags: true }); assert.ok(report.reasons.some(r => r.includes('version-specific proof'))); }
      else if (check.includes('-drift') || ['malformed', 'timeout'].includes(scenario)) assert.ok(report.reasons.includes(check), scenario);
      else assert.equal(report.checks[check], false, scenario);
      const text = JSON.stringify(report);
      for (const sentinel of [secret, 'owner@', '/private/', 'auth-source', 'synthetic-model', 'apiKeySource', binary]) assert.ok(!text.includes(sentinel), scenario);
    });
  }
});
test('explicit profiles cannot point to the owner home or ambient credential directories', async () => {
  const { homedir } = await import('node:os');
  for (const profile of ['relative', '/', homedir()]) {
    const report = await runProbe({ binary: '/unused', profile });
    assert.ok(report.reasons.includes('dedicated-profile-required'));
    assert.deepEqual(report.checks, {});
  }
});
for (const ambient of ['.claude', '.anycode']) for (const subdir of ['', 'nested/profile']) {
  test(`rejects symlinked ${ambient}/${subdir} before launching any executable`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'probe-profile-'));
    try {
      const home = join(root, 'owner-home'), target = join(root, 'ambient-target');
      const marker = join(root, 'launched'), binary = join(root, 'binary.mjs');
      await mkdir(home);
      await mkdir(join(target, 'nested/profile'), { recursive: true });
      await symlink(target, join(home, ambient), 'dir');
      await writeFile(binary, `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'launched');\nprocess.exit(1);\n`, { mode: 0o700 });
      // HOME is isolated in a subprocess: neither the parent environment nor
      // the owner's actual credential directories are used by these checks.
      for (const profile of [join(home, ambient, subdir), join(target, subdir)]) {
        const source = `import { runProbe } from ${JSON.stringify(new URL('./claude-orchestrate-probe.mjs', import.meta.url).href)};\nconsole.log(JSON.stringify(await runProbe(${JSON.stringify({ binary, profile, facts: fixture.facts })})));`;
        const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
          encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home }, timeout: 10000,
        });
        assert.equal(result.status, 0, result.stderr);
        const report = JSON.parse(result.stdout);
        assert.ok(report.reasons.includes('dedicated-profile-required'));
        assert.deepEqual(report.checks, {});
        assert.equal(await access(marker).then(() => true, () => false), false);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
test('fixture is scrubbed and offline mode needs no executable, profile or credentials', async () => {
  const script = new URL('./claude-orchestrate-probe.mjs', import.meta.url);
  const result = spawnSync(process.execPath, [script.pathname, '--fixture-only'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(result.status, 0); assert.deepEqual(JSON.parse(result.stdout), fixture);
  assert.equal(fixture.available, false); assert.equal(fixture.origin, 'synthetic');
  assert.equal(fixture.frames.init.session_id, 'synthetic-session');
  assert.doesNotMatch(result.stdout, /SENTINEL|owner@|\/Users\/|\/private\/|apiKeySource|account|email/);
});
