/** Real core-port probe. Run with node; credentials only from the fixed smoke-secret directory. */
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const secretDir = '/Users/dev/projects/tools/anycode/.smoke-secrets';
// Fail closed: error bodies can contain echoed prompts, reasoning or credentials.
export function redact(value, secrets = []) {
  let text = String(value);
  for (const secret of secrets.filter(Boolean)) text = text.split(secret).join('[redacted]');
  return text.replace(/(?:sk-|tp-)[\w.-]+/g, '[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(?:reasoning_content|thinking|encrypted_content|reasoning_details)\b[\s\S]*/gi, '[reasoning omitted]');
}
export function formatTable(rows) {
  const columns = ['cell', 'model', 'host', 'status', 'http', 'retry', 'remembered', 'inputOn', 'inputOff', 'reason'];
  const safe = v => redact(v ?? '—').replace(/[|\r\n]/g, ' ');
  return [columns, columns.map(() => '---'), ...rows.map(r => columns.map(c => r[c]))]
    .map(row => `| ${row.map(safe).join(' | ')} |`).join('\n');
}
async function credentials(name) {
  try {
    const text = await readFile(resolve(secretDir, `${name}.env`), 'utf8');
    return Object.fromEntries(text.split('\n').flatMap(line => {
      const m = line.match(/^(?:export\s+)?([A-Z_]+)=(.*)$/);
      return m ? [[m[1], m[2].trim().replace(/^(['"])(.*)\1$/, '$2')]] : [];
    }));
  } catch { return {}; }
}

async function main() {
  if (!process.argv.includes('--live')) throw new Error('Use --live for the authorised short matrix');
  const profile = await mkdtemp(resolve(tmpdir(), 'reasoning-replay-'));
  // No settings/vault/account imports. Set isolation before loading any production module.
  for (const key of Object.keys(process.env)) {
    if (/^(ANYCODE_|ANTHROPIC_|OPENAI_|OPENROUTER_|CLAUDE_|CODEX_|MINIMAX_|MIMO_|OPENCODE_)/.test(key)) delete process.env[key];
  }
  Object.assign(process.env, { HOME: profile, USERPROFILE: profile, XDG_CONFIG_HOME: profile,
    ANYCODE_HOME: profile, ANYCODE_USER_DATA_DIR: profile, CODEX_HOME: profile, CLAUDE_CONFIG_DIR: profile });
  const require = createRequire(resolve(root, 'packages/core/package.json'));
  const { register } = await import(pathToFileURL(require.resolve('tsx/esm/api')).href);
  register();
  const load = path => import(pathToFileURL(resolve(root, `packages/core/src/${path}.ts`)).href);
  const { AiSdkModelPort } = await load('provider/model-port');
  const { ReasoningCapture } = await load('loop/reasoning-capture');
  const { OPENCODE_GO_MODELS } = await load('provider/opencode-go');
  const all = {};
  for (const name of ['deepseek', 'glm', 'minimax', 'mimo', 'openrouter', 'opencode-go']) all[name] = await credentials(name);
  const rows = [];
  const cells = [
    ['Z.AI', 'glm', 'glm-5.3-flash', all.glm.ANYCODE_BASE_URL ?? 'https://api.z.ai/api/anthropic', 'Z.AI (GLM)'],
    ['DeepSeek', 'deepseek', 'deepseek-flash', all.deepseek.ANYCODE_BASE_URL ?? 'https://api.deepseek.com/anthropic', 'DeepSeek'],
    ['MiniMax', 'minimax', 'MiniMax-M3.1-Flash', 'https://api.minimax.io/anthropic', 'MiniMax'],
    ['MiMo', 'mimo', 'mimo-v2.6-flash', 'https://token-plan-sgp.xiaomimimo.com/anthropic', 'Xiaomi MiMo Token Plan (SGP)'],
    ['OpenRouter', 'openrouter', 'deepseek/deepseek-v4.1-flash', 'https://openrouter.ai/api/v1', 'OpenRouter', 'openai-chat-completions'],
    ['Responses', 'openrouter', 'openai/gpt-5-mini', 'https://openrouter.ai/api/v1', 'OpenRouter', 'openai-responses'],
  ];
  const freeChat = ([, v]) => v.kind === 'route' && v.route.transport === 'openai-chat-completions' &&
    v.route.metadata.pricing?.input === 0 && v.route.metadata.pricing?.output === 0;
  // The one-day Go credential is authorised ONLY for free chat-completions models.
  for (const family of ['deepseek', 'glm', 'kimi', 'minimax', 'qwen', 'mimo']) {
    const entries = Object.entries(OPENCODE_GO_MODELS.models).filter(([id]) => id.startsWith(family));
    const freeFamily = entries.find(freeChat);
    const chosen = freeFamily ?? entries.find(([id]) => /flash/.test(id)) ?? entries[0];
    for (const door of ['anthropic', 'openai']) {
      if (door === 'openai' && freeFamily) {
        cells.push([`Go openai ${family}`, 'opencode-go', freeFamily[0], freeFamily[1].route.baseUrl, 'OpenCode Go (OpenAI)', 'openai-chat-completions']);
        continue;
      }
      rows.push({ cell: `Go ${door} ${family}`, model: chosen?.[0], host: 'opencode.ai',
      status: 'not-measured', reason: door === 'anthropic' ? 'one-day key: chat-completions only' : 'family has no catalog model with zero input/output price' });
    }
  }
  const free = Object.entries(OPENCODE_GO_MODELS.models).find(freeChat);
  if (free) cells.push(['Go free control', 'opencode-go', free[0], free[1].route.baseUrl, 'OpenCode Go (OpenAI)', 'openai-chat-completions']);
  const nativeFetch = globalThis.fetch;
  const total = { input: 0, output: 0, requests: 0 };
  // SDK warnings/errors are not safe report surfaces. Only the allowlisted table is emitted.
  const log = console.log.bind(console);
  console.warn = console.error = () => {};
  try {
    for (const [cell, source, model, baseUrl, providerName, transport = 'anthropic-messages'] of cells) {
      const env = all[source];
      const apiKey = env.ANYCODE_API_KEY ?? env.MINIMAX_API_KEY ?? env.MIMO_API_KEY ?? env.OPENROUTER_API_KEY ?? env.OPENCODE_GO_API_KEY;
      const row = { cell, model, host: new URL(baseUrl).host, status: 'not-measured', http: '', retry: false, remembered: 'not-measured' };
      rows.push(row);
      if (!apiKey) { row.reason = 'missing smoke key'; continue; }
      if (source === 'minimax' && !apiKey.startsWith('sk-cp-')) { row.reason = 'plan key unusable: wrong prefix; PAYG not used'; continue; }
      let phase = 'first', stopped = false, evidence = [];
      globalThis.fetch = async (url, init) => {
        if (stopped) throw new Error('cell stopped');
        const body = JSON.parse(init.body);
        const wire = JSON.stringify(body.messages ?? body.input ?? []);
        const replay = /"(?:thinking|reasoning_content|reasoning_details|encrypted_content)"/.test(wire);
        const fact = { phase, replay, include: body.include?.includes('reasoning.encrypted_content') === true,
          storeFalse: body.store === false, max: body.max_tokens ?? body.max_output_tokens };
        evidence.push(fact);
        if (!Number.isFinite(fact.max) || fact.max <= 0 || fact.max > 2048) { stopped = true; row.reason = 'production wire lacks a safe output cap (1..2048)'; throw new Error('token cap'); }
        let response;
        try { response = await nativeFetch(url, init); }
        catch { row.reason = 'network failure before HTTP response'; throw new Error('network failure'); }
        total.requests++;
        fact.status = response.status;
        row.http += `${phase}:${response.status}${replay ? '(replay)' : ''} `;
        if (!response.ok) {
          const errorBody = await response.clone().text();
          fact.quota = response.status === 429 || /quota|insufficient.*(?:balance|credit)|1008/i.test(errorBody);
          // Retain only fixed classifications; no raw body escapes this scope.
          fact.reason = fact.quota ? 'quota/rate limit' : /reasoning|thinking|encrypted_content|include/i.test(errorBody) ? 'reasoning/include parameter rejection' : `HTTP ${response.status}`;
          row.reason = fact.reason;
          if (fact.quota) stopped = true;
        }
        return response;
      };
      const config = { transport, baseUrl, model, providerName, apiKey, includeUsage: true,
        retry: { maxRetries: 0, stallTimeoutMs: 0 },
        ...(source === 'opencode-go' ? { headers: { 'x-opencode-session': crypto.randomUUID(), 'user-agent': 'Anycode/live-smoke' } } : {}) };
      const port = new AiSdkModelPort(config, d => { if (d.kind === 'reasoning_replay_rejected') row.retry = true; });
      const tools = [{ name: 'read_fixed', description: 'Read the fixed string; no arguments.', inputJsonSchema: { type: 'object', properties: {}, additionalProperties: false } }];
      const messages = [{ role: 'user', content: 'Think briefly: compute 17*19, then call read_fixed exactly once to obtain a check string. After the result, answer with only the number and check string. Do not call any other tool.' }];
      const request = { tools, maxOutputTokens: 512, contextWindowTokens: 8192,
        ...(cell === 'Z.AI' ? {} : { reasoningEffort: 'low' }) };
      async function step(p, history) {
        const capture = new ReasoningCapture(), base = [];
        let usage, finished = false, failed = false;
        for await (const e of p.streamText({ ...request, messages: history, abortSignal: AbortSignal.timeout(60000) })) {
          capture.observe(e);
          if (e.type === 'stream_retry') capture.reset();
          if (e.type === 'text_delta') base.push({ type: 'text', text: e.text });
          if (e.type === 'tool_call') base.push({ type: 'tool_call', toolCallId: e.toolCall.id, toolName: e.toolCall.name, input: e.toolCall.input });
          if (e.type === 'error') failed = true;
          if (e.type === 'finish') { usage = e.usage; finished = true; }
        }
        if (row.retry && p === port) row.remembered = port.reasoningReplaySource(request.reasoningEffort) === undefined;
        total.input += usage?.inputTokens ?? 0; total.output += usage?.outputTokens ?? 0;
        return { parts: capture.weave(base), usage, ok: finished && !failed };
      }
      try {
        const first = await step(port, messages);
        if (!first.ok || stopped) { row.reason ??= 'first step incomplete'; continue; }
        const calls = first.parts.filter(p => p.type === 'tool_call');
        if (!first.parts.some(p => p.type === 'reasoning') || !calls.length) { row.reason = 'first step did not return both replayable reasoning and tool call'; continue; }
        const history = [...messages, { role: 'assistant', content: first.parts }, { role: 'tool', content: calls.map(p => ({ type: 'tool_result', toolCallId: p.toolCallId, toolName: p.toolName, text: 'CHECK', status: 'success' })) }];
        phase = 'on';
        const on = await step(port, history);
        row.inputOn = on.usage?.inputTokens;
        row.remembered = row.retry ? port.reasoningReplaySource(request.reasoningEffort) === undefined : 'not-measured';
        if (stopped || !on.ok) { row.reason ??= 'continuation incomplete'; continue; }
        if (!evidence.some(e => e.phase === 'on' && e.replay)) { row.reason = 'product defect: captured reasoning absent from continuation wire'; continue; }
        if (transport === 'openai-responses' && !evidence.every(e => e.storeFalse) ) { row.reason = 'product defect: store:false absent'; continue; }
        phase = 'off';
        const off = await step(new AiSdkModelPort({ ...config, preserveReasoning: false }, () => {}), history);
        row.inputOff = off.usage?.inputTokens;
        row.status = row.retry ? 'rejected' : 'ok';
        row.reason = off.ok ? 'single pair; token delta is observational' : 'baseline incomplete';
      } catch { row.reason ??= 'network/timeout or SDK failure (raw error omitted)'; }
      finally { globalThis.fetch = nativeFetch; }
    }
    log(formatTable(rows));
    log(JSON.stringify({ requests: total.requests, inputTokens: total.input, outputTokens: total.output,
      spendEstimateUSD: +(total.input * 2 / 1e6 + total.output * 10 / 1e6).toFixed(6),
      estimateBasis: 'conservative $2/M input + $10/M output for ALL reported tokens, including subscription/free; not an invoice; failed-request usage unavailable' }));
  } finally { globalThis.fetch = nativeFetch; await rm(profile, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => {
  process.stderr.write('Live matrix failed; raw error omitted to protect credentials and reasoning.\n'); process.exitCode = 1;
});
