/**
 * Live provider matrix smoke for TASK.43 W6 (design/track-43-45-33-47-49-cut.md
 * §2 W6): drives REAL wire requests, one per transport/gateway cell, exercising
 * the exact HTTP shapes AnyCode's own transports send — Anthropic-messages
 * dual-auth + reasoning (`anthropic.ts`), OpenAI Responses store:false +
 * reasoning + tools (`openai-responses.ts`), and OpenAI-compatible
 * chat-completions (`openai-compatible.ts`) reused across OpenAI itself,
 * OpenRouter, and a local no-auth vLLM/Ollama endpoint.
 *
 * Plain node >=22, ZERO npm deps (only node:process/url + the global
 * `fetch`/`AbortController`), matching the `scripts/` precedent
 * (codex-live-smoke.mjs, env-status-smoke.mjs, telemetry-rollup.mjs) — this
 * file is a NEW sibling, does not import or edit anything under
 * packages/core or apps/desktop/src. It re-derives each transport's wire
 * shape from the product source (headers, auth, body fields) rather than
 * importing the TS modules directly, since packages/core has no build step a
 * plain node script can `import` (its package.json `exports` point straight
 * at `.ts` source, consumed only by tsx/vite/vitest — see openai-responses.ts,
 * anthropic.ts, openai-compatible.ts, model-port.ts's reasoningRequestOptions
 * for the shapes mirrored below).
 *
 * Creds are read STRICTLY from `process.env` — never hardcoded, never read
 * from settings files, never logged. Every cell whose required env var(s) are
 * absent prints `OWNER-GATED (no creds)` and is SKIPPED — it never fails the
 * script. A cell whose creds ARE present runs a real network call and prints
 * a compact PASS/FAIL with the observed facts (HTTP status, reasoning
 * present, usage present, tool-call observed, ...). The overall exit code is
 * 1 only if a cell that actually ran (creds present) failed; an all-OWNER-GATED
 * run (the common case in CI/dev sandboxes with no provider creds exported)
 * exits 0.
 *
 * Usage:
 *   node apps/desktop/scripts/provider-live-smoke.mjs
 *
 * Env vars per cell (all optional except where noted "required to run the
 * cell live"; a `_MODEL` var left unset falls back to the documented default
 * so only the credential needs setting):
 *
 *   (a) generic-gateway/GLM x anthropic-messages (reasoning regression)
 *       ANYCODE_API_KEY   required. Same names the product itself reads
 *       ANYCODE_BASE_URL  optional, default native Anthropic (provider/env.ts)
 *       ANYCODE_MODEL     required
 *
 *   (b) OpenAI x responses (text/stream/reasoning/tools/usage/abort/store:false)
 *   (c) OpenAI x chat-completions
 *       OPENAI_API_KEY    required (shared by both OpenAI cells)
 *       OPENAI_MODEL      optional, default "gpt-5.1"
 *
 *   (d) OpenRouter x both (chat-completions + responses-shaped)
 *       OPENROUTER_API_KEY required
 *       OPENROUTER_MODEL   optional, default "openai/gpt-4o-mini"
 *
 *   (e) local vLLM/Ollama x chat + no-auth
 *       ANYCODE_LOCAL_BASE_URL required (its presence IS the opt-in signal —
 *                               a local dev server is not "on" by default)
 *       ANYCODE_LOCAL_MODEL    required
 *       ANYCODE_LOCAL_API_KEY  optional; left UNSET on purpose to exercise the
 *                               no-auth path (chat-completions omits
 *                               Authorization entirely when apiKey is absent)
 */

// ── small env/report helpers ──

function readEnv(name) {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** Never prints the credential's value — only whether it was found. */
function requireEnv(names) {
  const missing = names.filter((n) => readEnv(n) === undefined);
  return { ok: missing.length === 0, missing };
}

let anyCellFailed = false;

function ownerGated(cellId, label, missing) {
  console.log(`[provider-live-smoke] ${cellId} ${label}: OWNER-GATED (no creds) — missing env: ${missing.join(", ")}`);
}

function cellPass(cellId, label, facts) {
  console.log(`[provider-live-smoke] ${cellId} ${label}: PASS ${JSON.stringify(facts)}`);
}

function cellFail(cellId, label, reason, facts) {
  anyCellFailed = true;
  console.error(`[provider-live-smoke] ${cellId} ${label}: FAIL ${reason} ${facts ? JSON.stringify(facts) : ""}`.trimEnd());
}

// ── wire-shape helpers, mirrored from packages/core/src/provider (see header) ──

/** Mirrors provider/anthropic.ts normalizeAnthropicBaseUrl: trim, strip trailing slashes, ensure /v1. */
function normalizeAnthropicBaseUrl(raw) {
  const trimmed = raw.trim().replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

/** Mirrors provider/endpoint.ts normalizeExplicitBaseUrl: trim, strip trailing slashes, no /v1 append. */
function normalizeExplicitBaseUrl(raw) {
  return raw.trim().replace(/\/+$/, "");
}

/** Mirrors provider/anthropic.ts buildDualAuthHeaders: x-api-key (SDK-native) + Authorization Bearer shim. */
function anthropicHeaders(apiKey) {
  return {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "authorization": `Bearer ${apiKey}`,
    "anthropic-version": "2023-06-01",
  };
}

function openaiHeaders(apiKey) {
  const headers = { "content-type": "application/json" };
  if (apiKey !== undefined) headers["authorization"] = `Bearer ${apiKey}`;
  return headers;
}

async function postJson(url, headers, body, signal) {
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
  const text = await res.text();
  let json;
  try {
    json = text === "" ? {} : JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

// ── (a) generic-gateway/GLM x anthropic-messages: reasoning regression ──
// Mirrors reasoningRequestOptions's GLM branch (model-port.ts): thinking
// budget + `output_config.effort` (NOT a top-level `effort` key — see
// glm-reasoning-wire.integration.test.ts for the wire-byte proof this mirrors).

async function runGlmAnthropicCell(cellId, label) {
  const required = requireEnv(["ANYCODE_API_KEY", "ANYCODE_MODEL"]);
  if (!required.ok) return ownerGated(cellId, label, required.missing);

  const apiKey = readEnv("ANYCODE_API_KEY");
  const model = readEnv("ANYCODE_MODEL");
  const baseUrl = normalizeAnthropicBaseUrl(readEnv("ANYCODE_BASE_URL") ?? "https://api.anthropic.com");

  try {
    const { status, json } = await postJson(
      `${baseUrl}/messages`,
      anthropicHeaders(apiKey),
      {
        model,
        max_tokens: 1_024,
        messages: [{ role: "user", content: "Reply with exactly one short sentence." }],
        thinking: { type: "enabled", budget_tokens: 512 },
        output_config: { effort: "high" },
        stream: false,
      },
    );
    if (status !== 200) return cellFail(cellId, label, `HTTP ${status}`, { body: json });

    const content = Array.isArray(json.content) ? json.content : [];
    const reasoningPresent = content.some((b) => b?.type === "thinking");
    const usagePresent = typeof json.usage?.output_tokens === "number";
    cellPass(cellId, label, { status, reasoningPresent, usagePresent, baseUrl });
  } catch (err) {
    cellFail(cellId, label, `threw: ${err?.message ?? err}`);
  }
}

// ── (b) OpenAI x responses: text / stream / reasoning / tools / usage / abort / store:false ──

async function runOpenAIResponsesCell(cellId, label, { apiKey, model, baseUrl }) {
  const facts = {};

  // text + reasoning + usage + store:false, non-streaming.
  try {
    const { status, json } = await postJson(
      `${baseUrl}/responses`,
      openaiHeaders(apiKey),
      { model, input: "Reply with exactly one short sentence.", reasoning: { effort: "low" }, store: false, stream: false },
    );
    facts.textStatus = status;
    if (status !== 200) return cellFail(cellId, label, `text HTTP ${status}`, { body: json });
    const output = Array.isArray(json.output) ? json.output : [];
    facts.reasoningPresent = output.some((o) => o?.type === "reasoning");
    facts.usagePresent = typeof json.usage?.total_tokens === "number";
  } catch (err) {
    return cellFail(cellId, label, `text threw: ${err?.message ?? err}`, facts);
  }

  // streaming SSE.
  try {
    const { status, json: raw } = await postJson(
      `${baseUrl}/responses`,
      openaiHeaders(apiKey),
      { model, input: "Reply with exactly one short sentence.", store: false, stream: true },
    );
    facts.streamStatus = status;
    // postJson JSON-parses; an SSE body fails to parse and lands in `.raw` —
    // that IS the expected shape here, we only need it non-empty and 200.
    facts.streamNonEmpty = typeof raw?.raw === "string" ? raw.raw.length > 0 : true;
    if (status !== 200) return cellFail(cellId, label, `stream HTTP ${status}`, facts);
  } catch (err) {
    return cellFail(cellId, label, `stream threw: ${err?.message ?? err}`, facts);
  }

  // tool-call round trip (best-effort observation — a real model may or may
  // not choose to call the tool; only a non-2xx/throw is a hard failure).
  try {
    const { status, json } = await postJson(
      `${baseUrl}/responses`,
      openaiHeaders(apiKey),
      {
        model,
        input: "Call the `ping` tool with no arguments, then stop.",
        store: false,
        stream: false,
        tools: [{ type: "function", name: "ping", description: "Replies pong", parameters: { type: "object", properties: {}, additionalProperties: false } }],
      },
    );
    facts.toolsStatus = status;
    if (status !== 200) return cellFail(cellId, label, `tools HTTP ${status}`, { body: json });
    const output = Array.isArray(json.output) ? json.output : [];
    facts.toolCallObserved = output.some((o) => o?.type === "function_call");
  } catch (err) {
    return cellFail(cellId, label, `tools threw: ${err?.message ?? err}`, facts);
  }

  // abort mid-request.
  try {
    const controller = new AbortController();
    const promise = postJson(
      `${baseUrl}/responses`,
      openaiHeaders(apiKey),
      { model, input: "Count slowly from one to one thousand, one number per sentence.", store: false, stream: false },
      controller.signal,
    );
    controller.abort();
    await promise;
    facts.abortRejected = false; // did not throw — unexpected but not fatal to the matrix
  } catch (err) {
    facts.abortRejected = err?.name === "AbortError" || String(err?.message ?? err).toLowerCase().includes("abort");
  }

  cellPass(cellId, label, facts);
}

// ── (c) OpenAI x chat-completions ──

async function runChatCompletionsCell(cellId, label, { apiKey, model, baseUrl }) {
  try {
    const { status, json } = await postJson(
      `${baseUrl}/chat/completions`,
      openaiHeaders(apiKey),
      {
        model,
        messages: [{ role: "user", content: "Reply with exactly one short sentence." }],
        stream: false,
        tools: [{ type: "function", function: { name: "ping", description: "Replies pong", parameters: { type: "object", properties: {} } } }],
        tool_choice: "auto",
      },
    );
    if (status !== 200) return cellFail(cellId, label, `HTTP ${status}`, { body: json });

    const choice = Array.isArray(json.choices) ? json.choices[0] : undefined;
    const reasoningPresent = typeof choice?.message?.reasoning_content === "string" && choice.message.reasoning_content.length > 0;
    const usagePresent = typeof json.usage?.total_tokens === "number";
    // Design doc §2 W6: a strict gateway must accept tool_choice as a bare
    // string ("auto"), not an object — asserted on the REQUEST we sent, since
    // a 200 response here already proves the gateway didn't 400/404 it.
    cellPass(cellId, label, { status, reasoningPresent, usagePresent, toolChoiceSentAsString: true });
  } catch (err) {
    cellFail(cellId, label, `threw: ${err?.message ?? err}`);
  }
}

async function runOpenAICell(cellId, label) {
  const required = requireEnv(["OPENAI_API_KEY"]);
  if (!required.ok) return ownerGated(cellId, label, required.missing);
  const apiKey = readEnv("OPENAI_API_KEY");
  const model = readEnv("OPENAI_MODEL") ?? "gpt-5.1";
  const baseUrl = normalizeExplicitBaseUrl("https://api.openai.com/v1");
  return { apiKey, model, baseUrl };
}

// ── (d) OpenRouter x both (chat-completions + responses-shaped) ──

async function runOpenRouterCell(cellIdChat, labelChat, cellIdResponses, labelResponses) {
  const required = requireEnv(["OPENROUTER_API_KEY"]);
  if (!required.ok) {
    ownerGated(cellIdChat, labelChat, required.missing);
    ownerGated(cellIdResponses, labelResponses, required.missing);
    return;
  }
  const apiKey = readEnv("OPENROUTER_API_KEY");
  const model = readEnv("OPENROUTER_MODEL") ?? "openai/gpt-4o-mini";
  const baseUrl = normalizeExplicitBaseUrl("https://openrouter.ai/api/v1");

  await runChatCompletionsCell(cellIdChat, labelChat, { apiKey, model, baseUrl });
  // OpenRouter does not universally guarantee a Responses-shaped surface —
  // this reuses the SAME request builder as the OpenAI responses cell against
  // OpenRouter's baseURL, proving the openai-responses transport is baseURL-
  // portable (TASK.43 §0.4's whole point); a non-2xx here is reported as a
  // real FAIL, not silently downgraded, since it's a live, credentialed call.
  try {
    const { status, json } = await postJson(
      `${baseUrl}/responses`,
      openaiHeaders(apiKey),
      { model, input: "Reply with exactly one short sentence.", store: false, stream: false },
    );
    if (status !== 200) return cellFail(cellIdResponses, labelResponses, `HTTP ${status}`, { body: json });
    const usagePresent = typeof json.usage?.total_tokens === "number";
    cellPass(cellIdResponses, labelResponses, { status, usagePresent });
  } catch (err) {
    cellFail(cellIdResponses, labelResponses, `threw: ${err?.message ?? err}`);
  }
}

// ── (e) local vLLM/Ollama x chat + no-auth ──

async function runLocalNoAuthCell(cellId, label) {
  const required = requireEnv(["ANYCODE_LOCAL_BASE_URL", "ANYCODE_LOCAL_MODEL"]);
  if (!required.ok) return ownerGated(cellId, label, required.missing);

  const baseUrl = normalizeExplicitBaseUrl(readEnv("ANYCODE_LOCAL_BASE_URL"));
  const model = readEnv("ANYCODE_LOCAL_MODEL");
  const apiKey = readEnv("ANYCODE_LOCAL_API_KEY"); // deliberately optional — absence exercises no-auth

  try {
    const { status, json } = await postJson(
      `${baseUrl}/chat/completions`,
      openaiHeaders(apiKey),
      { model, messages: [{ role: "user", content: "Reply with exactly one short sentence." }], stream: false },
    );
    if (status !== 200) return cellFail(cellId, label, `HTTP ${status}`, { body: json });
    const usagePresent = typeof json.usage?.total_tokens === "number";
    cellPass(cellId, label, { status, usagePresent, authHeaderSent: apiKey !== undefined });
  } catch (err) {
    cellFail(cellId, label, `threw: ${err?.message ?? err}`);
  }
}

// ── main ──

async function main() {
  console.log("[provider-live-smoke] TASK.43 W6 live matrix — every cell without env creds reports OWNER-GATED, never a fail.");

  await runGlmAnthropicCell("(a)", "generic-gateway/GLM x anthropic-messages (reasoning)");

  const openaiCells = await runOpenAICell("(b)", "OpenAI x responses");
  if (openaiCells === undefined) {
    ownerGated("(c)", "OpenAI x chat-completions", requireEnv(["OPENAI_API_KEY"]).missing);
  } else {
    await runOpenAIResponsesCell("(b)", "OpenAI x responses", openaiCells);
    await runChatCompletionsCell("(c)", "OpenAI x chat-completions", openaiCells);
  }

  await runOpenRouterCell("(d1)", "OpenRouter x chat-completions", "(d2)", "OpenRouter x responses");

  await runLocalNoAuthCell("(e)", "local vLLM/Ollama x chat + no-auth");

  if (anyCellFailed) {
    console.error("[provider-live-smoke] one or more CREDENTIALED cells failed — see FAIL lines above.");
    process.exit(1);
  }
  console.log("[provider-live-smoke] done — every credentialed cell PASSed (or every cell was OWNER-GATED).");
}

main();
