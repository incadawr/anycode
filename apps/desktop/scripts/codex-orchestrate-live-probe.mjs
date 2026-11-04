// Invoked by codex-orchestrate-probe.mjs --live. Outputs only scrubbed facts.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';

const RPC_MS = 20_000, TURN_MS = 120_000, OUTPUT_TOKEN_LIMIT = 512, TEXT_BYTE_LIMIT = 4096;
const usage = 'Usage: --live --bin PATH --root EMPTY_DIR --auth-from AUTH_JSON [--model MODEL]';
const schemaFile = 'codex_app_server_protocol.schemas.json';

// Only structured, correlated tool activity can prove an attempted operation.
export function attempted(events, name, path) {
  return events.some(({ method, params }) => {
    if (method?.includes('requestApproval')) return name === 'escalation' && JSON.stringify(params).includes(path);
    if (method !== 'item/started' && method !== 'item/completed') return false;
    const item = params?.item;
    const kinds = name === 'patch' ? ['fileChange'] : name === 'native-spawn' ? ['collabAgentToolCall', 'collabAgent'] : ['commandExecution'];
    return name !== 'escalation' && kinds.includes(item?.type) && JSON.stringify(item).includes(path);
  });
}
export function correlatedEvidence(message, threadId, turnId) {
  return !!turnId && message.params?.threadId === threadId && message.params?.turnId === turnId &&
    (message.method === 'item/started' || message.method === 'item/completed' || !!message.method?.includes('requestApproval'));
}
export function turnDiagnostics(turn) {
  // Do not expose paths, credentials, arbitrary identifiers or model-provided secrets.
  const excerpt = turn.messages.join(' ').slice(0, 300).replace(/(?:\/[^\s]+)+/g, '[path]').replace(/[A-Za-z0-9_\-]{16,}/g, '[redacted]');
  const types = {};
  for (const event of turn.evidence) { const type = event.params?.item?.type; if (type) types[type] = (types[type] || 0) + 1; }
  return { turnStatus: turn.status ?? null, modelExcerpt: excerpt, itemEvents: types };
}

const sandboxChecks = ['read', 'patch', 'workspace-command', 'tmp-command', 'escalation', 'native-spawn'];
const nestedUnavailable = 'nested seatbelt unavailable in this environment: negative checks are not evidence';
export function nestedSeatbeltAvailable(run = spawnSync) {
  const result = run('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], { encoding: 'utf8', timeout: 10_000 });
  return result.status === 0 && !result.error && !/operation not permitted/i.test(`${result.stdout || ''} ${result.stderr || ''}`);
}
function sandboxFailure(turn) {
  return /exit(?:ed)?(?: with)? code\s*[:=]?\s*71\b|sandbox_apply[^\n]*operation not permitted/i.test(turn.messages.join(' ') + ' ' + JSON.stringify(turn.evidence)) ||
    turn.evidence.some(event => event.params?.item?.exitCode === 71);
}
export function smokeOutcome(available, checks) {
  return available && Object.values(checks).some(c => c.status === 'FAIL') ? 'failed' : 'incomplete';
}
export async function runSandboxChecks({ available, checks, cwd, root, turn, ctx }) {
  if (!available) {
    for (const name of sandboxChecks) checks[name] = { status: 'SKIP', note: nestedUnavailable };
    return;
  }
  const readPath = join(cwd, 'read-fixture.txt');
  writeFileSync(readPath, 'READ_FIXTURE_OK');
  const readTurn = await turn(`Read ${readPath} with a tool and report its contents.`, ctx);
  const readSucceeded = readTurn.evidence.some(event => event.method === 'item/completed' && event.params?.item?.type === 'commandExecution' && event.params.item.exitCode === 0);
  checks.read = sandboxFailure(readTurn) || !readSucceeded || readTurn.status !== 'completed'
    ? { status: 'SKIP', note: 'read tool did not complete successfully' }
    : { status: readTurn.messages.join(' ').includes('READ_FIXTURE_OK') ? 'PASS' : 'FAIL' };
  if (checks.read.status !== 'PASS') checks.read.diagnostics = turnDiagnostics(readTurn);
  const cases = [
    ['patch', join(cwd, 'sentinel-patch'), 'Use apply_patch to create the file'],
    ['workspace-command', join(cwd, 'sentinel-command'), 'Use a shell command to create the file'],
    ['tmp-command', join(root, 'sentinel-tmp'), 'Use a shell command to create the file'],
    ['escalation', join(root, 'sentinel-escalation'), 'Request sandbox escalation and then use a shell command to create the file'],
    ['native-spawn', join(root, 'sentinel-spawn'), 'Use a native agent spawn tool and ask the agent to create the file'],
  ];
  for (const [name, path, instruction] of cases) {
    const t = await turn(`${instruction} ${path}. Do not use anycode_agent. Report the result.`, ctx);
    const created = existsSync(path);
    const observed = !sandboxFailure(t) && attempted(t.evidence, name, path);
    checks[name] = created ? { status: 'FAIL', note: 'sentinel created' } : observed ? { status: 'PASS', note: 'attempt observed; sentinel absent' } : { status: 'SKIP', note: sandboxFailure(t) ? 'sandbox execution failed; attempt is not evidence' : 'no sentinel; attempt not observed' };
    if (t.status !== 'completed') checks[name].note += '; turn did not complete';
    if (checks[name].status !== 'PASS') checks[name].diagnostics = turnDiagnostics(t);
  }
}

export async function runLive(args, { smoke = false } = {}) {
  const result = { mode: 'live', outcome: 'incomplete', steps: {}, limits: { outputTokens: OUTPUT_TOKEN_LIMIT, outputBytes: TEXT_BYTE_LIMIT, note: 'client interrupt on observed usage or streamed bytes; not a server-side hard token limit' } };
  if (smoke) result.checks = { 'role-dispatch-detach-report': { status: 'SKIP', note: 'role dispatch/detach/report: not covered by live smoke (covered by integration tests)' } };
  let child, timer, currentTurn;
  const pending = new Map();
  let nextId = 0, activeTurn;
  const finish = () => console.log(JSON.stringify(result));
  try {
    const parsed = {};
    for (let i = 0; i < args.length; i++) {
      const key = args[i];
      if (key === '--live') { if (parsed.live) throw Error('arguments'); parsed.live = true; continue; }
      if (!['--bin', '--root', '--auth-from', '--model'].includes(key) || parsed[key] || !args[i + 1] || args[i + 1].startsWith('--')) throw Error('arguments');
      parsed[key] = args[++i];
    }
    if (!parsed.live || !parsed['--bin'] || !parsed['--root'] || !parsed['--auth-from']) throw Error('arguments');
    if (process.platform !== 'darwin') throw Error('auth-write-guard-requires-macos');
    const bin = resolve(parsed['--bin']), root = resolve(parsed['--root']), auth = realpathSync(resolve(parsed['--auth-from']));
    if (smoke) result.binary = bin;
    const ownerDir = dirname(auth);
    if (!lstatSync(auth).isFile() || root === '/' || root === realpathSync(process.env.HOME || '/') || root === ownerDir || root.startsWith(ownerDir + '/')) throw Error('unsafe-path');
    mkdirSync(root, { recursive: true });
    if (lstatSync(root).isSymbolicLink() || readdirSync(root).length) throw Error('root-not-empty');
    const canonicalRoot = realpathSync(root);
    if (canonicalRoot === ownerDir || canonicalRoot.startsWith(ownerDir + '/')) throw Error('unsafe-path');
    const home = join(root, 'home'), codexHome = join(root, 'codex-home'), cwd = join(root, 'workspace'), userData = join(root, 'user-data'), schemaDir = join(root, 'schema');
    for (const dir of [home, codexHome, cwd, userData, schemaDir]) mkdirSync(dir);
    symlinkSync(auth, join(codexHome, 'auth.json'));
    // The real auth directory is explicitly read-only even when invoked outside the caller's sandbox.
    const quote = s => '"' + s.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
    const profile = `(version 1)(allow default)(deny file-write* (subpath ${quote(ownerDir)}))`;
    const env = { PATH: process.env.PATH, HOME: home, CODEX_HOME: codexHome, ANYCODE_USER_DATA_DIR: userData, TMPDIR: root };
    const launch = (...argv) => new Promise((resolve, reject) => {
      const proc = process.env.ORCH_PROBE_NO_SANDBOX_EXEC === '1' ? spawn(bin, argv, { cwd, env, stdio: ['ignore', 'pipe', 'ignore'], detached: true }) : spawn('/usr/bin/sandbox-exec', ['-p', profile, bin, ...argv], { cwd, env, stdio: ['ignore', 'pipe', 'ignore'], detached: true });
      let stdout = '', finished = false;
      const kill = () => { if (proc.pid) { try { process.kill(-proc.pid, 'SIGKILL'); } catch {} } };
      const deadline = setTimeout(() => { kill(); settle(Error('command-timeout')); }, RPC_MS);
      const settle = (error, status) => { if (finished) return; finished = true; clearTimeout(deadline); kill(); error ? reject(error) : resolve({ status, stdout }); };
      proc.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); if (stdout.length > 1024 * 1024) { kill(); settle(Error('command-output-limit')); } });
      proc.on('error', () => settle(Error('command-failed')));
      proc.on('close', status => settle(null, status));
    });
    const version = await launch('--version');
    const match = /^codex-cli (0\.(\d+)\.\d+)/m.exec(version.stdout || '');
    if (version.status !== 0 || !match || +match[2] < 144 || +match[2] >= 167) throw Error('unsupported-version-or-launch-failed');
    result.version = match[1];
    result.authWriteGuard = process.env.ORCH_PROBE_NO_SANDBOX_EXEC === '1' ? 'external-required' : 'sandbox-exec';
    const help = await launch('app-server', 'generate-json-schema', '--help');
    if (help.status !== 0 || !help.stdout.includes('--experimental')) throw Error('experimental-schema-unavailable');
    const generated = await launch('app-server', 'generate-json-schema', '--experimental', '--out', schemaDir);
    if (generated.status !== 0) throw Error('schema-generation-failed');
    const schema = JSON.parse(readFileSync(join(schemaDir, schemaFile), 'utf8'));
    const resumeDynamic = !!schema.definitions?.v2?.ThreadResumeParams?.properties?.dynamicTools;
    const defs = schema.definitions || {}, v2 = defs.v2 || {}, turnProperties = v2.TurnStartParams?.properties || {};
    const methods = (defs.ClientRequest?.oneOf || []).map(x => x.properties?.method?.enum?.[0]).filter(Boolean);
    result.schema = { resumeDynamicTools: resumeDynamic, turnFields: Object.fromEntries(['collaborationMode', 'additionalContext', 'permissions', 'disabledPluginIds'].map(k => [k, !!turnProperties[k]])),
      modes: v2.ModeKind?.enum || [], contextKinds: v2.AdditionalContextKind?.enum || [],
      mcpMethods: methods.filter(x => /^(mcpServer|config\/mcpServer|thread\/mcp)/.test(x)) };
    if (match[1] !== '0.166.0') { result.outcome = 'schema-only'; return; }
    // Two local MCP servers expose harmless fixture tools, never external services.
    const fixture = join(root, 'fixture-mcp.mjs');
    writeFileSync(fixture, `import { createInterface } from 'node:readline';
const name = process.argv[2];
createInterface({ input: process.stdin }).on('line', line => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined) return;
  let result;
  if (m.method === 'initialize') result = { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name, version: '1.0.0' } };
  else if (m.method === 'tools/list') result = { tools: [{ name: 'fixture_' + name, description: 'Read-only fixture', inputSchema: { type: 'object', properties: {} } }] };
  else if (m.method === 'tools/call') result = { content: [{ type: 'text', text: 'fixture' }] };
  else if (m.method === 'resources/list') result = { resources: [] };
  else if (m.method === 'resources/templates/list') result = { resourceTemplates: [] };
  else result = {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
});
`);
    const fixtureConfig = name => ({ command: process.execPath, args: [fixture, name] });
    const tomlString = value => JSON.stringify(value);
    writeFileSync(join(codexHome, 'config.toml'), `[features]\nmulti_agent = true\n[mcp_servers.ambient]\ncommand = ${tomlString(process.execPath)}\nargs = [${tomlString(fixture)}, "ambient"]\n[mcp_servers.second]\ncommand = ${tomlString(process.execPath)}\nargs = [${tomlString(fixture)}, "second"]\n`);
    const send = message => child.stdin.write(JSON.stringify(message) + '\n');
    const failPending = () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Error('server-exited')); } pending.clear(); if (activeTurn) activeTurn.reject(Error('server-exited')); };
    function request(method, params, timeout = RPC_MS) {
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => { pending.delete(id); reject(Error('rpc-timeout')); }, timeout);
        pending.set(id, { resolve, reject, timer });
        send({ id, method, params });
      });
    }
    function interrupt() {
      if (!activeTurn || activeTurn.interrupted || !activeTurn.id) return;
      activeTurn.interrupted = true;
      request('turn/interrupt', { threadId: activeTurn.threadId, turnId: activeTurn.id }).catch(() => {});
    }
    function startServer(overrides = []) {
      const argv = [...overrides.flatMap(value => ['-c', value]), 'app-server', '--stdio'];
      const proc = process.env.ORCH_PROBE_NO_SANDBOX_EXEC === '1' ? spawn(bin, argv, { cwd, env, stdio: ['pipe', 'pipe', 'ignore'], detached: true }) : spawn('/usr/bin/sandbox-exec', ['-p', profile, bin, ...argv], { cwd, env, stdio: ['pipe', 'pipe', 'ignore'], detached: true });
      child = proc;
      proc.stdin.on('error', () => {});
      proc.on('error', () => { if (child === proc) failPending(); });
      proc.on('exit', () => { if (child === proc) failPending(); });
      createInterface({ input: proc.stdout }).on('line', line => {
      if (child !== proc) return;
      let m; try { m = JSON.parse(line); } catch { return; }
      if (activeTurn && correlatedEvidence(m, activeTurn.threadId, activeTurn.id)) activeTurn.evidence.push({ method: m.method, params: m.params });
      // Server request IDs may overlap client request IDs.
      if (m.id !== undefined && m.method) {
        if (m.method === 'item/tool/call' && activeTurn && m.params?.threadId === activeTurn.threadId && m.params?.turnId === activeTurn.id && m.params?.tool === 'anycode_agent') {
          activeTurn.agentCalls++;
          send({ id: m.id, result: { success: true, contentItems: [{ type: 'inputText', text: 'FIXTURE_AGENT_RESPONSE_OK' }] } });
        } else send({ id: m.id, error: { code: -32601, message: 'Not available in probe' } });
        return;
      }
      if (m.id !== undefined && pending.has(m.id)) {
        const p = pending.get(m.id); pending.delete(m.id); clearTimeout(p.timer);
        m.error ? p.reject(Error('rpc-rejected')) : p.resolve(m.result); return;
      }
      if (!activeTurn || m.params?.threadId !== activeTurn.threadId) return;
      if (m.method === 'turn/started') { activeTurn.id = m.params.turn?.id; interruptIfNeeded(); }
      if (m.params?.turnId && activeTurn.id && m.params.turnId !== activeTurn.id) return;
      if (m.method === 'item/agentMessage/delta') { const delta = String(m.params.delta || ''); activeTurn.deltas.set(m.params.itemId, (activeTurn.deltas.get(m.params.itemId) || '') + delta); activeTurn.bytes += Buffer.byteLength(delta); interruptIfNeeded(); }
      if (m.method === 'item/completed') {
        const item = m.params.item;
        if (item?.type === 'agentMessage') { activeTurn.messages.push(String(item.text || activeTurn.deltas.get(item.id) || '').slice(0, TEXT_BYTE_LIMIT)); activeTurn.deltas.delete(item.id); }
        if (item?.type === 'commandExecution' || item?.type === 'fileChange') activeTurn.fileOrCommandObserved = true;
      }
      if (m.method === 'thread/tokenUsage/updated') {
        const usage = m.params.tokenUsage?.last;
        if (usage) activeTurn.outputTokens = Math.max(activeTurn.outputTokens ?? 0, (usage.outputTokens || 0) + (usage.reasoningOutputTokens || 0));
        interruptIfNeeded();
      }
      if (m.method === 'turn/completed' && (!activeTurn.id || m.params.turn?.id === activeTurn.id)) {
        clearTimeout(activeTurn.timer); const done = activeTurn; activeTurn = undefined;
        const errorText = String(m.params.turn?.error?.message || '').toLowerCase();
        const errorClass = !errorText ? null : /auth|unauthori[sz]ed|forbidden|401|403/.test(errorText) ? 'auth-or-access' : /network|connect|stream|routing|dns|timeout/.test(errorText) ? 'network-or-routing' : /rate|quota|limit/.test(errorText) ? 'quota-or-rate' : 'other';
        done.resolve({ id: m.params.turn?.id, status: m.params.turn?.status, errorClass, messages: [...done.messages, ...done.deltas.values()], evidence: done.evidence, fileOrCommandObserved: done.fileOrCommandObserved, agentCalls: done.agentCalls, outputTokens: done.outputTokens, interrupted: done.interrupted });
      }
      });
    }
    async function restartServer(overrides = []) {
      const old = child;
      child = undefined;
      if (old?.pid) {
        old.stdin.end();
        try { process.kill(-old.pid, 'SIGTERM'); } catch {}
        await Promise.race([new Promise(resolve => old.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 1000))]);
        try { process.kill(-old.pid, 'SIGKILL'); } catch {}
      }
      startServer(overrides);
      await request('initialize', { clientInfo: { name: 'orchestration-probe', version: '0.0.0' }, capabilities: { experimentalApi: true } });
      send({ method: 'initialized', params: {} });
    }
    function interruptIfNeeded() { if (activeTurn && (activeTurn.bytes >= TEXT_BYTE_LIMIT || (activeTurn.outputTokens ?? 0) >= OUTPUT_TOKEN_LIMIT)) interrupt(); }
    async function turn(threadId, text, extra = {}, processPolicy = false) {
      const done = new Promise((resolve, reject) => {
        activeTurn = { threadId, resolve, reject, messages: [], deltas: new Map(), evidence: [], bytes: 0, outputTokens: null, fileOrCommandObserved: false, agentCalls: 0, interrupted: false,
          timer: setTimeout(() => { interrupt(); reject(Error('turn-timeout')); activeTurn = undefined; }, TURN_MS) };
      });
      // Attach rejection handler immediately in case turn/start fails or times out.
      done.catch(() => {});
      try {
        const started = await request('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }], effort: 'low', ...(processPolicy ? {} : { approvalPolicy: 'never', approvalsReviewer: 'user', sandboxPolicy: { type: 'readOnly', networkAccess: false } }), ...extra });
        if (activeTurn) { activeTurn.id = started.turn?.id; interruptIfNeeded(); }
        return await done;
      } catch (error) { if (activeTurn) { clearTimeout(activeTurn.timer); activeTurn = undefined; } throw error; }
    }
    async function configSnapshot(threadId, marker) {
      const out = {};
      try { const r = await request('config/read', { cwd, includeLayers: true }); out.configRead = { ambient: !!r.config?.mcp_servers?.ambient, ambientEnabled: r.config?.mcp_servers?.ambient?.enabled ?? null, second: !!r.config?.mcp_servers?.second, secondEnabled: r.config?.mcp_servers?.second?.enabled ?? null, multiAgent: r.config?.features?.multi_agent ?? null, appsDefaultEnabled: r.config?.apps?._default?.enabled ?? null, sandboxMode: r.config?.sandbox_mode ?? null, approvalPolicy: r.config?.approval_policy ?? null, developerMarkerInConfig: marker ? String(r.config?.developer_instructions || '').includes(marker) : null, layers: Array.isArray(r.layers) }; } catch { out.configRead = null; }
      try { const r = await request('mcpServerStatus/list', { threadId }); const items = r.data || []; out.mcp = Object.fromEntries(['ambient', 'second'].map(name => { const item = items.find(x => x.name === name); return [name, { listed: !!item, fixtureToolListed: item ? Object.keys(item.tools || {}).some(key => key.includes('fixture_' + name)) : false }]; })); } catch { out.mcp = null; }
      return out;
    }
    const recordTurn = t => ({ status: t.status, errorClass: t.errorClass, fileOrCommandObserved: t.fileOrCommandObserved, agentCalls: t.agentCalls, outputTokensObserved: t.outputTokens, interrupted: t.interrupted });
    const baseMarker = 'BASE' + randomBytes(6).toString('hex').toUpperCase(), onMarker = 'ON' + randomBytes(6).toString('hex').toUpperCase();
    const baseInstructions = `In each final answer include the exact current base marker ${baseMarker}. Keep responses brief.`;
    const onInstructions = `${baseInstructions}\nWhile this instruction is active, include the exact current additional marker ${onMarker} in each final answer.`;
    const tools = [{ type: 'function', name: 'anycode_agent', description: 'Call this harmless fixture when asked to call anycode_agent; returns a short fixed response.', inputSchema: { type: 'object', properties: {} } }];
    const common = { cwd, sandbox: 'read-only', approvalPolicy: 'never', approvalsReviewer: 'user' };
    const baseConfig = { features: { multi_agent: true }, mcp_servers: { ambient: fixtureConfig('ambient'), second: fixtureConfig('second') } };
    const onConfig = { features: { multi_agent: false }, mcp_servers: { ambient: { enabled: false }, second: { enabled: false } } };
    startServer();
    await request('initialize', { clientInfo: { name: 'orchestration-probe', version: '0.0.0' }, capabilities: { experimentalApi: true } });
    send({ method: 'initialized', params: {} });
    const models = await request('model/list', { limit: 100 });
    const available = models.data || [];
    const model = parsed['--model'] ? available.find(x => x.id === parsed['--model'] || x.model === parsed['--model']) : available.find(x => /luna/i.test(x.id) && x.supportedReasoningEfforts?.some(e => e.reasoningEffort === 'low')) || available.find(x => /mini/i.test(x.id) && x.supportedReasoningEfforts?.some(e => e.reasoningEffort === 'low'));
    if (!model || !model.supportedReasoningEfforts?.some(e => e.reasoningEffort === 'low')) throw Error('no-low-effort-cheap-model');
    result.model = model.id;
    const empty = await request('thread/start', { ...common, model: model.id, developerInstructions: baseInstructions, config: baseConfig, dynamicTools: tools });
    const replacement = await request('thread/start', { ...common, model: model.id, developerInstructions: onInstructions, config: onConfig, dynamicTools: tools });
    result.steps.emptyThread = { replacementHasDifferentId: replacement.thread?.id !== empty.thread?.id, oldTurns: empty.thread?.turns?.length ?? null, replacementTurns: replacement.thread?.turns?.length ?? null, note: 'new identity; metadata and external references are not automatically migrated' };
    try { await request('thread/resume', { ...common, threadId: empty.thread.id, developerInstructions: onInstructions, config: onConfig, ...(resumeDynamic ? { dynamicTools: tools } : {}) }); result.steps.emptyThread.resumeAccepted = true; } catch { result.steps.emptyThread.resumeAccepted = false; }
    result.steps.startWithOnConfig = await configSnapshot(replacement.thread.id);
    try { await request('config/mcpServer/reload', null); result.steps.mcpReload = { accepted: true, after: await configSnapshot(replacement.thread.id) }; } catch { result.steps.mcpReload = { accepted: false }; }
    try {
      const profiles = await request('permissionProfile/list', { cwd });
      const candidate = profiles.data?.find(p => p.allowed && /read.?only/i.test(p.id));
      result.steps.permissionProfiles = { availableCount: profiles.data?.length ?? null, allowedCount: profiles.data?.filter(p => p.allowed).length ?? null, readOnlyCandidate: !!candidate, note: 'profile listing does not prove MCP filtering; permissions cannot be combined with sandbox' };
      if (candidate) {
        try {
          const trial = await request('thread/start', { cwd, model: model.id, permissions: candidate.id, approvalPolicy: 'never', developerInstructions: baseInstructions, config: onConfig, dynamicTools: tools });
          result.steps.permissionProfiles.trial = { accepted: true, sandbox: trial.sandbox?.type ?? null, config: await configSnapshot(trial.thread.id) };
        } catch { result.steps.permissionProfiles.trial = { accepted: false }; }
      }
    } catch { result.steps.permissionProfiles = null; }
    const start = await request('thread/start', { ...common, model: model.id, developerInstructions: baseInstructions, config: baseConfig, dynamicTools: tools });
    const threadId = start.thread.id;
    result.steps.before = await configSnapshot(threadId);
    currentTurn = await turn(threadId, 'Ответь OK.');
    result.steps.firstTurn = recordTurn(currentTurn);
    if (currentTurn.status !== 'completed') {
      result.steps.firstTurn.diagnostics = turnDiagnostics(currentTurn);
      throw Error('first-turn-not-completed');
    }
    const firstTurnId = currentTurn.id;
    if (smoke) {
      const checks = result.checks;
      const mark = (name, ok, note, turn) => { checks[name] = { status: ok ? 'PASS' : 'FAIL', ...(note ? { note } : {}), ...(!ok && turn ? { diagnostics: turnDiagnostics(turn) } : {}) }; };
      const ts = await import('typescript');
      const policySource = readFileSync(new URL('../src/host/engines/codex/orchestration-policy.ts', import.meta.url), 'utf8');
      const policyJs = ts.transpileModule(policySource, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
      const policy = await import(`data:text/javascript;base64,${Buffer.from(policyJs).toString('base64')}`);
      const inventory = await request('config/read', { cwd, includeLayers: true });
      await restartServer(policy.orchestrationOverrides(policy.captureBaseConfig(inventory)));
      const resumed = await request('thread/resume', { ...common, threadId });
      const config = await configSnapshot(threadId);
      mark('restart-resume', resumed.thread?.id === threadId && resumed.sandbox?.type === 'readOnly' && resumed.sandbox?.networkAccess === false && resumed.approvalPolicy === 'never' && config.configRead?.ambientEnabled === false && config.configRead?.secondEnabled === false && config.configRead?.multiAgent === false && config.configRead?.appsDefaultEnabled === false && config.configRead?.sandboxMode === 'read-only' && config.configRead?.approvalPolicy === 'never');
      if (checks['restart-resume'].status !== 'PASS') throw Error('policy-not-confirmed');
      const marker = 'SMOKE' + randomBytes(6).toString('hex').toUpperCase();
      const ctx = { additionalContext: { orchestration: { kind: 'application', value: `For this turn include exactly this marker in your final response: ${marker}` } } };
      const markerTurn = await turn(threadId, 'Follow the additional context and report the marker.', ctx);
      mark('context-on', markerTurn.status === 'completed' && markerTurn.messages.join(' ').includes(marker), undefined, markerTurn);
      const seatbeltAvailable = nestedSeatbeltAvailable();
      result.nestedSeatbelt = seatbeltAvailable ? 'available' : 'unavailable';
      await runSandboxChecks({ available: seatbeltAvailable, checks, cwd, root, turn: (text, extra) => turn(threadId, text, extra), ctx });
      const agent = await turn(threadId, 'Call anycode_agent with an empty object and report its response.', ctx);
      mark('anycode-agent', agent.status === 'completed' && agent.agentCalls > 0, undefined, agent);
      await restartServer();
      const off = await request('thread/resume', { ...common, threadId });
      const restoredConfig = await configSnapshot(threadId);
      mark('config-off', restoredConfig.configRead?.ambientEnabled !== false && restoredConfig.configRead?.secondEnabled !== false && restoredConfig.configRead?.multiAgent === true);
      const offTurn = await turn(threadId, 'Reply ONLY with NONE if there is no additional turn context.');
      mark('context-off', off.thread?.id === threadId && offTurn.status === 'completed' && !offTurn.messages.join(' ').includes(marker), undefined, offTurn);
      checks.ui = { status: 'SKIP', note: 'UI menu, slash and reconnect are outside this app-server probe' };
      result.outcome = smokeOutcome(seatbeltAvailable, checks);
      if (result.outcome === 'failed') process.exitCode = 1;
      return;
    }
    const onResume = await request('thread/resume', { ...common, threadId, developerInstructions: onInstructions, config: onConfig, ...(resumeDynamic ? { dynamicTools: tools } : {}) });
    result.steps.resumeOn = { sameThread: onResume.thread?.id === threadId, sandbox: onResume.sandbox?.type ?? null, approval: onResume.approvalPolicy ?? null };
    result.steps.onConfig = await configSnapshot(threadId);
    const inside = join(cwd, 'probe-sentinel-inside'), outside = join(root, 'probe-sentinel-outside');
    currentTurn = await turn(threadId, `Назови действующий дополнительный маркер из developer-инструкций. Попробуй создать файлы ${inside} и ${outside}. Ответь кратко.`);
    const onText = currentTurn.messages.join('\n');
    result.steps.onTurn = { ...recordTurn(currentTurn), baseMarkerObserved: onText.includes(baseMarker), additionalMarkerObserved: onText.includes(onMarker), insideSentinelCreated: existsSync(inside), outsideSentinelCreated: existsSync(outside) };
    if (currentTurn.status !== 'completed') throw Error('on-turn-not-completed');
    const onTurnId = currentTurn.id;
    const offResume = await request('thread/resume', { ...common, threadId, developerInstructions: baseInstructions, config: baseConfig, ...(resumeDynamic ? { dynamicTools: tools } : {}) });
    result.steps.resumeOff = { sameThread: offResume.thread?.id === threadId, sandbox: offResume.sandbox?.type ?? null, approval: offResume.approvalPolicy ?? null };
    result.steps.offConfig = await configSnapshot(threadId);
    currentTurn = await turn(threadId, 'Назови только действующие сейчас маркеры из developer-инструкций, не используя историю. Если дополнительного маркера нет, ответь NONE.');
    const offText = currentTurn.messages.join('\n');
    result.steps.offTurn = { ...recordTurn(currentTurn), baseMarkerObserved: offText.includes(baseMarker), oldAdditionalMarkerObserved: offText.includes(onMarker), note: 'prior marker remains in conversation history; this is a model observation, not proof of instruction removal' };
    if (currentTurn.status !== 'completed') throw Error('off-turn-not-completed');
    const history = await request('thread/read', { threadId, includeTurns: true });
    const turns = history.thread?.turns;
    result.steps.history = { sameThread: history.thread?.id === threadId, turnCount: turns?.length ?? null,
      threeTurnIdsPreserved: Array.isArray(turns) && [firstTurnId, onTurnId, currentTurn.id].every((id, index) => !!id && turns[index]?.id === id),
      firstThreeCompleted: Array.isArray(turns) && turns.length >= 3 && turns.slice(0, 3).every(t => t.status === 'completed') };
    if (match[1] === '0.166.0') {
      const toolPrompt = 'Вызови инструмент anycode_agent с пустым объектом и кратко сообщи его ответ. Если инструмента нет, скажи что он недоступен.';
      async function toolObservation() {
        const t = await turn(threadId, toolPrompt);
        return { ...recordTurn(t), toolCallObserved: t.agentCalls > 0, fixtureReplyInAssistantText: t.messages.join('\n').includes('FIXTURE_AGENT_RESPONSE_OK') };
      }
      try { result.steps.agentBeforeRestart = await toolObservation(); }
      catch (error) { result.steps.agentBeforeRestart = { error: /^[a-z-]+$/.test(error.message) ? error.message : 'probe-failed' }; }
      const collabMarker = 'COLLAB' + randomBytes(6).toString('hex').toUpperCase();
      const contextMarker = 'CONTEXT' + randomBytes(6).toString('hex').toUpperCase();
      const restartMarker = 'RESTART' + randomBytes(6).toString('hex').toUpperCase();
      try {
        const instructions = `${baseInstructions} Include the additional current marker ${collabMarker} in every final answer.`;
        const t = await turn(threadId, 'Назови действующие сейчас маркеры из developer-инструкций.', { collaborationMode: { mode: 'default', settings: { model: model.id, reasoning_effort: 'low', developer_instructions: instructions } } });
        const text = t.messages.join('\n');
        result.steps.collaborationOn = { ...recordTurn(t), baseMarkerObserved: text.includes(baseMarker), markerObserved: text.includes(collabMarker), mode: 'default' };
        const next = await turn(threadId, 'Назови только действующие сейчас маркеры developer-инструкций, игнорируя историю.');
        const nextText = next.messages.join('\n');
        result.steps.collaborationOmitted = { ...recordTurn(next), baseMarkerObserved: nextText.includes(baseMarker), oldMarkerObserved: nextText.includes(collabMarker), note: 'model may recall marker from history; omission may preserve sticky mode' };
      } catch (error) { result.steps.collaborationError = /^[a-z-]+$/.test(error.message) ? error.message : 'probe-failed'; }
      try {
        const t = await turn(threadId, 'Назови маркер, переданный в дополнительном контексте.', { additionalContext: { fixture: { kind: 'application', value: `Fixture marker: ${contextMarker}` } } });
        const read = await request('thread/read', { threadId, includeTurns: true });
        const items = read.thread?.turns?.flatMap(x => x.items || []) || [];
        result.steps.additionalContext = { ...recordTurn(t), markerObserved: t.messages.join('\n').includes(contextMarker), markerInNonMessageHistory: items.filter(x => x.type !== 'agentMessage' && x.type !== 'userMessage').some(x => JSON.stringify(x).includes(contextMarker)), markerInAssistantHistory: items.filter(x => x.type === 'agentMessage').some(x => String(x.text || '').includes(contextMarker)), historyAvailable: Array.isArray(read.thread?.turns), kind: 'application', note: 'context is not established as developer-priority instruction' };
      } catch (error) { result.steps.additionalContext = { error: /^[a-z-]+$/.test(error.message) ? error.message : 'probe-failed' }; }
      try {
        await restartServer();
        const resumed = await request('thread/resume', { ...common, threadId, developerInstructions: `${baseInstructions} Include the current additional marker ${restartMarker} in every final answer.`, config: onConfig, ...(resumeDynamic ? { dynamicTools: tools } : {}) });
        const snapshot = await configSnapshot(threadId);
        const read = await request('thread/read', { threadId, includeTurns: true });
        const t = await turn(threadId, 'Назови действующие сейчас маркеры из developer-инструкций.');
        const text = t.messages.join('\n');
        result.steps.restartResume = { ...recordTurn(t), sameThread: resumed.thread?.id === threadId, priorHistoryTurns: read.thread?.turns?.length ?? null, config: snapshot, baseMarkerObserved: text.includes(baseMarker), markerObserved: text.includes(restartMarker) };
      } catch (error) { result.steps.restartResume = { error: /^[a-z-]+$/.test(error.message) ? error.message : 'probe-failed' }; }
      try {
        await restartServer(['mcp_servers.ambient.enabled=false', 'mcp_servers.second.enabled=false', 'features.multi_agent=false']);
        const resumed = await request('thread/resume', { ...common, threadId });
        const snapshot = await configSnapshot(threadId);
        const read = await request('thread/read', { threadId, includeTurns: true });
        result.steps.cliIsolation = { sameThread: resumed.thread?.id === threadId, historyTurns: read.thread?.turns?.length ?? null, config: snapshot };
        try { result.steps.agentAfterRestartWithoutResumeDeclaration = await toolObservation(); } catch (error) { result.steps.agentAfterRestartWithoutResumeDeclaration = { error: /^[a-z-]+$/.test(error.message) ? error.message : 'probe-failed' }; }
        try { await request('config/mcpServer/reload', null); result.steps.cliIsolation.afterReload = await configSnapshot(threadId); } catch { result.steps.cliIsolation.reloadAccepted = false; }
        await restartServer();
        const restored = await request('thread/resume', { ...common, threadId });
        const restoredRead = await request('thread/read', { threadId, includeTurns: true });
        result.steps.cliRestored = { sameThread: restored.thread?.id === threadId, historyTurns: restoredRead.thread?.turns?.length ?? null, config: await configSnapshot(threadId) };
      } catch (error) { result.steps.cliIsolationError = /^[a-z-]+$/.test(error.message) ? error.message : 'probe-failed'; }
      try {
        await restartServer();
        const resumed = await request('thread/resume', { ...common, threadId, dynamicTools: tools });
        result.steps.agentResumeWithUndeclaredField = { sameThread: resumed.thread?.id === threadId, schemaDeclaresField: resumeDynamic, observation: await toolObservation() };
      } catch (error) { result.steps.agentResumeWithUndeclaredField = { schemaDeclaresField: resumeDynamic, error: /^[a-z-]+$/.test(error.message) ? error.message : 'probe-failed' }; }
      const processMarker = 'PROCESS' + randomBytes(6).toString('hex').toUpperCase();
      try {
        await restartServer([`developer_instructions=${JSON.stringify(`Include the marker ${processMarker} in every final answer.`)}`, 'sandbox_mode="read-only"', 'approval_policy="never"', 'mcp_servers.ambient.enabled=false', 'mcp_servers.second.enabled=false', 'features.multi_agent=false']);
        // Omit per-thread sandbox/approval and instructions to observe the process layer.
        const resumed = await request('thread/resume', { threadId, cwd });
        const config = await configSnapshot(threadId, processMarker);
        const read = await request('thread/read', { threadId, includeTurns: true });
        result.steps.processInstructionsOn = { sameThread: resumed.thread?.id === threadId, historyTurns: read.thread?.turns?.length ?? null, echoedSandbox: resumed.sandbox?.type ?? null, echoedNetworkAccess: resumed.sandbox?.networkAccess ?? null, echoedApproval: resumed.approvalPolicy ?? null, config };
        if (resumed.sandbox?.type !== 'readOnly' || resumed.sandbox?.networkAccess !== false || resumed.approvalPolicy !== 'never') throw Error('process-policy-not-confirmed');
        const t = await turn(threadId, 'Назови действующие сейчас маркеры из developer-инструкций, не используя историю.', {}, true);
        const text = t.messages.join('\n');
        Object.assign(result.steps.processInstructionsOn, recordTurn(t), { baseMarkerObserved: text.includes(baseMarker), processMarkerObserved: text.includes(processMarker), note: 'base marker can be recalled from history; observed response is not proof of instruction composition' });
        await restartServer();
        const restored = await request('thread/resume', { threadId, cwd });
        const afterConfig = await configSnapshot(threadId, processMarker);
        const after = await turn(threadId, 'Назови только действующие сейчас маркеры из developer-инструкций, не используя историю. Если дополнительного нет, ответь NONE.');
        const afterText = after.messages.join('\n');
        result.steps.processInstructionsOff = { ...recordTurn(after), sameThread: restored.thread?.id === threadId, config: afterConfig, baseMarkerObserved: afterText.includes(baseMarker), oldProcessMarkerObserved: afterText.includes(processMarker), note: 'old marker remains in history, so its repetition is not proof of a still-active instruction' };
      } catch (error) { result.steps.processInstructionsError = /^[a-z-]+$/.test(error.message) ? error.message : 'probe-failed'; }
    } else {
      result.steps.alternatives = { skipped: 'live alternatives are scoped to 0.166.0; fields reported from schema' };
    }
    result.outcome = 'completed';
  } catch (error) {
    result.error = /^[a-z-]+$/.test(error.message) ? error.message : 'probe-failed';
    if (result.error === 'arguments') result.usage = usage;
    process.exitCode = 1;
  } finally {
    if (result.checks) for (const check of Object.values(result.checks)) {
      if (check.status !== 'PASS' && !check.diagnostics) check.diagnostics = { turnStatus: null, modelExcerpt: '', itemEvents: {} };
    }
    if (activeTurn) { clearTimeout(activeTurn.timer); activeTurn.reject(Error('closed')); activeTurn = undefined; }
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Error('closed')); }
    pending.clear();
    if (child?.pid) {
      child.stdin.end();
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => { timer = setTimeout(resolve, 1000); })]);
      clearTimeout(timer);
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    }
    finish();
  }
}
