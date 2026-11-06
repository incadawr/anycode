/** Offline: node apps/desktop/scripts/claude-orchestrate-probe.mjs --fixture-only
 * Metadata only: node apps/desktop/scripts/claude-orchestrate-probe.mjs --live --bin /absolute/claude
 * Transport opt-in: append --profile /dedicated/profile --facts /private/proof.json
 * Authenticate that profile independently. Facts must contain matching-version,
 * controlled endpoint/helper and managed-policy proofs; the synthetic fixture is
 * NOT live proof. No model turns run while any preflight fact is unknown.
 * No credentials are inherited or copied. Live transport remains gated until isolated
 * auth/provider, settings/plugin suppression and managed-policy proofs exist. An init
 * echo or a successful synthetic run cannot qualify a production binary/version.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, lstat, realpath } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, isAbsolute, parse, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

export const tools = ['Read', 'Glob', 'Grep', 'mcp__anycode__agent', 'mcp__anycode__agent_status', 'mcp__anycode__list_connections'];
const fields = ['authSource', 'provider', 'baseUrl', 'model', 'env', 'apiKeyHelper'];
const sources = ['user', 'project', 'local', 'plugins'];
const fixtureURL = new URL('./claude-orchestrate-fixture.json', import.meta.url);
const canonical = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
const equal = (a, b) => canonical(a) === canonical(b);

// Resolved endpoint/helper/config observations, NOT model echo or init alone.
// Raw values stay in memory; only these categories may be persisted.
export function compareSnapshots(...snapshots) {
  return Object.fromEntries(fields.map(key => [key, snapshots.length !== 3 || snapshots.some(s => s?.[key] === undefined)
    || snapshots.some(s => s[key] === null || s[key] === '') ? 'unknown' : snapshots.every(s => equal(s[key], snapshots[0][key])) ? 'equal' : 'changed']));
}
export function preflight(facts = {}) {
  const reasons = [];
  for (const field of fields) if (facts.equivalence?.[field] !== 'equal') reasons.push(`Verify unchanged ${field} with isolated OFF/ON/OFF endpoint, config and helper observations.`);
  for (const source of sources) if (facts.suppression?.[source] !== 'verified') reasons.push(`Prove ${source} execution surfaces are suppressed before enabling ON.`);
  if (!['absent', 'safe-verified'].includes(facts.managed?.state) || facts.managed?.hooks !== false || facts.managed?.permissions !== false)
    reasons.push('Determine managed policy safely; hooks, permissions or unknown policy require unavailable. Do not bypass enterprise policy.');
  if (facts.prePayload !== 'verified') reasons.push('Verify the version-specific spawn contract before sending any ON payload; init alone is insufficient.');
  return reasons;
}
export function spawnArgs(phase, ref) {
  // Candidate argv only: a flag appearing in --help does not qualify its semantics.
  const on = phase.startsWith('on');
  return ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--permission-prompt-tool', 'stdio', '--permission-mode', 'manual', '--disable-slash-commands',
    '--setting-sources', on ? '' : 'user,project,local', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    ...(on ? ['--tools', 'Read,Glob,Grep', '--settings', '{"disableAllHooks":true}'] : []),
    phase.endsWith('fresh') ? '--session-id' : '--resume', ref];
}
const exists = async path => !!await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });

// A bounded subprocess runner: no raw stdout/stderr, paths or auth identifiers escape.
async function launch(binary, args, env, cwd, timeoutMs, onFrame) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { env, cwd, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', bytes = 0, settled = false, failure;
    const kill = () => { try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); } catch {} };
    const finish = error => { if (settled) return; settled = true; failure = error; clearTimeout(timer); kill(); };
    const send = value => { if (!settled) child.stdin.write(JSON.stringify(value) + '\n'); };
    const timer = setTimeout(() => finish('process-timeout'), timeoutMs);
    child.on('error', () => finish('process-launch-failed'));
    child.stdin.on('error', () => finish('process-input-failed'));
    child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > 1048576) finish('process-output-limit'); });
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 1048576) return finish('process-output-limit');
      if (!onFrame) output += chunk.toString();
    });
    if (onFrame) {
      const lines = createInterface({ input: child.stdout });
      lines.on('line', line => {
        if (settled) return;
        try { onFrame(JSON.parse(line), send, finish); } catch { finish('invalid-transport-frame'); }
      });
      send({ type: 'control_request', request_id: 'initialize', request: { subtype: 'initialize', sdkMcpServers: ['anycode'] } });
    } else child.stdin.end();
    child.on('close', code => {
      if (!settled) finish(code === 0 && !onFrame ? undefined : 'process-exited-before-result');
      failure ? reject(Error(failure)) : resolve(output); // Await exit before replacement or cleanup.
    });
  });
}
async function transport(binary, phase, ref, context) {
  let ready = false, init, result, denied = false, drift = false;
  const on = phase.startsWith('on');
  await launch(binary, spawnArgs(phase, ref), context.env, context.cwd, context.timeoutMs, (m, send, finish) => {
    if (m.type === 'control_response' && m.response?.request_id === 'initialize') {
      if (ready || m.response.subtype !== 'success') return finish('initialize-failed');
      ready = true;
      send({ type: 'user', session_id: ref, parent_tool_use_id: null, message: { role: 'user', content: on
        ? 'Read the workspace. Attempt Write, Edit, NotebookEdit, Bash, Task, Agent, arbitrary MCP, skills and EnterPlanMode/ExitPlanMode. For writes target forbidden-write in cwd; do not delegate through anycode. Report refusals.'
        : 'Reply with exactly OK; do not call tools.' } });
    } else if (m.type === 'control_request') {
      const r = m.request ?? {}, owned = tools.slice(3).includes(r.tool_name);
      let response = { behavior: 'deny', message: 'Restricted probe posture' };
      if (r.subtype === 'can_use_tool') {
        if (owned) response = { behavior: 'allow', updatedInput: r.input ?? {} };
        else denied = true; // Even an outside-cwd Read must fail before any broker.
      } else if (r.subtype === 'mcp_message' && r.server_name === 'anycode') {
        const rpc = r.message;
        const value = rpc.method === 'initialize' ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'anycode', version: '1' } }
          : rpc.method === 'tools/list' ? { tools: ['agent', 'agent_status'].map(name => ({ name, description: 'Probe fixture', inputSchema: { type: 'object' } })) }
          : { content: [{ type: 'text', text: 'Delegation disabled in probe' }], isError: true };
        response = rpc.id === undefined ? {} : { mcp_response: { jsonrpc: '2.0', id: rpc.id, result: value } };
      } else {
        send({ type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error: 'Unsupported restricted control request' } });
        return finish('transport-posture-drift');
      }
      send({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response } });
    } else if (m.type === 'system' && m.subtype === 'init') {
      if (init || !ready) return finish('init-order-drift');
      init = m;
      if (on && (!equal([...(m.tools ?? [])].sort(), [...tools].sort()) || m.permissionMode !== 'default'
        || !equal(m.skills, []) || !equal(m.slash_commands, []) || !equal(m.mcp_servers?.map(s => s.name), ['anycode']))) drift = true;
    } else if (m.type === 'assistant') {
      if (!init) drift = true;
      for (const block of m.message?.content ?? []) if (on && block.type === 'tool_use' && !tools.includes(block.name)) drift = true;
    } else if (m.type === 'result') { result = m; finish(); }
    if (drift) finish('transport-posture-drift');
  });
  return { sameRef: init?.session_id === ref && result?.session_id === ref, defaultMode: init?.permissionMode === 'default',
    inventory: !!init && !drift, completed: ready && result?.subtype === 'success' && result?.is_error === false,
    earlyDeny: !on || denied, model: init?.model, version: init?.claude_code_version,
    posture: init && { tools: init.tools, mode: init.permissionMode, skills: init.skills, slash: init.slash_commands, mcp: init.mcp_servers } };
}

export async function runProbe({ binary, facts = {}, profile, timeoutMs = 15000 }) {
  const report = { origin: 'diagnostic', available: false, version: null, checks: {}, reasons: preflight(facts) };
  const root = await mkdtemp(join(tmpdir(), 'claude-posture-'));
  try {
    if (!isAbsolute(binary)) throw Error('absolute-binary-required');
    const home = join(root, 'home'), scratchProfile = join(root, 'profile'), cwd = join(root, 'workspace');
    await Promise.all([home, scratchProfile, cwd].map(path => mkdir(path)));
    if (profile !== undefined) {
      if (!isAbsolute(profile)) throw Error('dedicated-profile-required');
      profile = await realpath(profile);
      const ownerHome = await realpath(homedir());
      if (profile === ownerHome || profile === parse(profile).root || !(await lstat(profile)).isDirectory()) throw Error('dedicated-profile-required');
      const forbidden = await Promise.all([join(ownerHome, '.claude'), join(ownerHome, '.anycode')].map(async path => {
        try { return await realpath(path); }
        catch (error) { if (error.code === 'ENOENT') return path; throw error; }
      }));
      if (forbidden.some(p => profile === p || profile.startsWith(p + sep))) throw Error('dedicated-profile-required');
    }
    profile ??= scratchProfile;
    const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: profile, TMPDIR: root,
      XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, XDG_CACHE_HOME: home, XDG_STATE_HOME: home };
    const version = await launch(binary, ['--version'], env, cwd, timeoutMs);
    report.version = /^(\d+\.\d+\.\d+)(?:\s|$)/.exec(version)?.[1] ?? null;
    const help = await launch(binary, ['--help'], env, cwd, timeoutMs);
    report.checks.flags = ['--tools', '--setting-sources', '--settings', '--permission-mode', '--strict-mcp-config', '--disable-slash-commands', '--resume', '--session-id'].every(flag => help.includes(flag));
    if (!report.version || !report.checks.flags) report.reasons.push('Select a binary exposing the required version and spawn flags; flags alone do not prove enforcement.');
    if (report.version !== facts.version) report.reasons.push('Obtain matching version-specific proof before probing ON transport.');
    // Real versions have no qualified proof yet. Tests inject synthetic preflight
    // facts only to exercise transport; those facts never grant production readiness.
    if (report.reasons.length === 0) {
      const ref = randomUUID(), context = { env, cwd, timeoutMs }, observations = [];
      for (const phase of ['off-fresh', 'on-resume', 'off-resume', 'on-fresh']) {
        const observation = await transport(binary, phase, phase === 'on-fresh' ? randomUUID() : ref, context);
        observations.push(observation);
        report.checks[phase] = Object.values(observation).every(Boolean) && observation.version === report.version;
      }
      report.checks.modelRestored = observations.every(o => o.model && o.model === observations[0].model);
      report.checks.offRestored = equal(observations[0].posture, observations[2].posture);
      report.checks.noPlanOrMutation = !(await Promise.all([join(cwd, 'forbidden-write'), join(profile, 'plans'), join(home, '.claude', 'plans'), join(cwd, '.claude', 'plans')].map(exists))).some(Boolean);
    }
  } catch (error) {
    const safe = ['absolute-binary-required', 'dedicated-profile-required', 'process-timeout', 'process-launch-failed', 'process-input-failed', 'process-output-limit', 'process-exited-before-result', 'invalid-transport-frame', 'initialize-failed', 'init-order-drift', 'transport-posture-drift'];
    report.reasons.push(safe.includes(error.message) ? error.message : 'probe-failed');
  } finally { await rm(root, { recursive: true, force: true }); }
  if (Object.values(report.checks).includes(false)) report.reasons.push('Transport or side-effect checks failed; keep ON unavailable.');
  report.reasons.push('No live version is qualified. Verify isolated auth/provider/settings/managed policy and first-turn enforcement before production wiring.');
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (equal(args, ['--fixture-only'])) console.log(await readFile(fixtureURL, 'utf8'));
  else if ([3, 7].includes(args.length) && args[0] === '--live' && args[1] === '--bin' && (args.length === 3 || (args[3] === '--profile' && args[5] === '--facts'))) {
    try {
      const facts = args.length === 7 ? JSON.parse(await readFile(args[6], 'utf8')) : {};
      console.log(JSON.stringify(await runProbe({ binary: args[2], profile: args[4], facts, timeoutMs: 120000 })));
    } catch { console.error('Invalid private proof file; supply sanitized, independently verified facts.'); process.exitCode = 1; }
  } else { console.error('Use --fixture-only or --live --bin ABSOLUTE_BINARY [--profile DEDICATED --facts PRIVATE_PROOF]'); process.exitCode = 1; }
}
