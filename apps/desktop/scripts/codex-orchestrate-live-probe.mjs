// Invoked by codex-orchestrate-probe.mjs --live. Outputs only scrubbed facts.
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';

const RPC_MS = 20_000, TURN_MS = 120_000, OUTPUT_TOKEN_LIMIT = 512, TEXT_BYTE_LIMIT = 4096;
const usage = 'Usage: --live --bin PATH --root EMPTY_DIR --auth-from AUTH_JSON [--model MODEL]';
const schemaFile = 'codex_app_server_protocol.schemas.json';

export async function runLive(args) {
  const result = { mode: 'live', outcome: 'incomplete', steps: {}, limits: { outputTokens: OUTPUT_TOKEN_LIMIT, outputBytes: TEXT_BYTE_LIMIT, note: 'client interrupt on observed usage or streamed bytes; not a server-side hard token limit' } };
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
    const help = await launch('app-server', 'generate-json-schema', '--help');
    if (help.status !== 0 || !help.stdout.includes('--experimental')) throw Error('experimental-schema-unavailable');
    const generated = await launch('app-server', 'generate-json-schema', '--experimental', '--out', schemaDir);
    if (generated.status !== 0) throw Error('schema-generation-failed');
    const schema = JSON.parse(readFileSync(join(schemaDir, schemaFile), 'utf8'));
    const resumeDynamic = !!schema.definitions?.v2?.ThreadResumeParams?.properties?.dynamicTools;
    result.schema = { resumeDynamicTools: resumeDynamic };
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
    child = process.env.ORCH_PROBE_NO_SANDBOX_EXEC === '1' ? spawn(bin, ['app-server', '--stdio'], { cwd, env, stdio: ['pipe', 'pipe', 'ignore'], detached: true }) : spawn('/usr/bin/sandbox-exec', ['-p', profile, bin, 'app-server', '--stdio'], { cwd, env, stdio: ['pipe', 'pipe', 'ignore'], detached: true });
    child.stdin.on('error', () => {});
    const send = message => child.stdin.write(JSON.stringify(message) + '\n');
    const failPending = () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Error('server-exited')); } pending.clear(); if (activeTurn) activeTurn.reject(Error('server-exited')); };
    child.on('error', failPending); child.on('exit', failPending);
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
    createInterface({ input: child.stdout }).on('line', line => {
      let m; try { m = JSON.parse(line); } catch { return; }
      // Server request IDs may overlap client request IDs.
      if (m.id !== undefined && m.method) { send({ id: m.id, error: { code: -32601, message: 'Not available in probe' } }); return; }
      if (m.id !== undefined && pending.has(m.id)) {
        const p = pending.get(m.id); pending.delete(m.id); clearTimeout(p.timer);
        m.error ? p.reject(Error('rpc-rejected')) : p.resolve(m.result); return;
      }
      if (!activeTurn || m.params?.threadId !== activeTurn.threadId) return;
      if (m.method === 'turn/started') { activeTurn.id = m.params.turn?.id; interruptIfNeeded(); }
      if (m.method === 'item/agentMessage/delta') { activeTurn.bytes += Buffer.byteLength(m.params.delta || ''); interruptIfNeeded(); }
      if (m.method === 'item/completed') {
        const item = m.params.item;
        if (item?.type === 'agentMessage') activeTurn.messages.push(String(item.text || '').slice(0, TEXT_BYTE_LIMIT));
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
        done.resolve({ id: m.params.turn?.id, status: m.params.turn?.status, errorClass, messages: done.messages, fileOrCommandObserved: done.fileOrCommandObserved, outputTokens: done.outputTokens, interrupted: done.interrupted });
      }
    });
    function interruptIfNeeded() { if (activeTurn && (activeTurn.bytes >= TEXT_BYTE_LIMIT || (activeTurn.outputTokens ?? 0) >= OUTPUT_TOKEN_LIMIT)) interrupt(); }
    async function turn(threadId, text) {
      const done = new Promise((resolve, reject) => {
        activeTurn = { threadId, resolve, reject, messages: [], bytes: 0, outputTokens: null, fileOrCommandObserved: false, interrupted: false,
          timer: setTimeout(() => { interrupt(); reject(Error('turn-timeout')); activeTurn = undefined; }, TURN_MS) };
      });
      // Attach rejection handler immediately in case turn/start fails or times out.
      done.catch(() => {});
      try {
        const started = await request('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }], effort: 'low', approvalPolicy: 'never', approvalsReviewer: 'user', sandboxPolicy: { type: 'readOnly', networkAccess: false } });
        if (activeTurn) { activeTurn.id = started.turn?.id; interruptIfNeeded(); }
        return await done;
      } catch (error) { if (activeTurn) { clearTimeout(activeTurn.timer); activeTurn = undefined; } throw error; }
    }
    async function configSnapshot(threadId) {
      const out = {};
      try { const r = await request('config/read', { cwd, includeLayers: true }); out.configRead = { ambient: !!r.config?.mcp_servers?.ambient, second: !!r.config?.mcp_servers?.second, multiAgent: r.config?.features?.multi_agent ?? null, layers: Array.isArray(r.layers) }; } catch { out.configRead = null; }
      try { const r = await request('mcpServerStatus/list', { threadId }); const items = r.data || []; out.mcp = Object.fromEntries(['ambient', 'second'].map(name => { const item = items.find(x => x.name === name); return [name, { listed: !!item, fixtureToolListed: item ? Object.keys(item.tools || {}).some(key => key.includes('fixture_' + name)) : false }]; })); } catch { out.mcp = null; }
      return out;
    }
    const recordTurn = t => ({ status: t.status, errorClass: t.errorClass, fileOrCommandObserved: t.fileOrCommandObserved, outputTokensObserved: t.outputTokens, interrupted: t.interrupted });
    const baseMarker = 'BASE' + randomBytes(6).toString('hex').toUpperCase(), onMarker = 'ON' + randomBytes(6).toString('hex').toUpperCase();
    const baseInstructions = `In each final answer include the exact current base marker ${baseMarker}. Keep responses brief.`;
    const onInstructions = `${baseInstructions}\nWhile this instruction is active, include the exact current additional marker ${onMarker} in each final answer.`;
    const tools = [{ type: 'function', name: 'anycode_agent', description: 'Fixture agent', inputSchema: { type: 'object', properties: {} } }];
    const common = { cwd, sandbox: 'read-only', approvalPolicy: 'never', approvalsReviewer: 'user' };
    const baseConfig = { features: { multi_agent: true }, mcp_servers: { ambient: fixtureConfig('ambient'), second: fixtureConfig('second') } };
    const onConfig = { features: { multi_agent: false }, mcp_servers: { ambient: { enabled: false }, second: { enabled: false } } };
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
    const start = await request('thread/start', { ...common, model: model.id, developerInstructions: baseInstructions, config: baseConfig, dynamicTools: tools });
    const threadId = start.thread.id;
    result.steps.before = await configSnapshot(threadId);
    currentTurn = await turn(threadId, 'Ответь OK.');
    result.steps.firstTurn = recordTurn(currentTurn);
    if (currentTurn.status !== 'completed') throw Error('first-turn-not-completed');
    const firstTurnId = currentTurn.id;
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
    result.outcome = 'completed';
  } catch (error) {
    result.error = /^[a-z-]+$/.test(error.message) ? error.message : 'probe-failed';
    if (result.error === 'arguments') result.usage = usage;
    process.exitCode = 1;
  } finally {
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
