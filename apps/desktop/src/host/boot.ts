/**

 * pieces of the resume-aware bootstrap, split out of index.ts so they are
 * exercisable off a real in-memory persistence adapter without the utilityProcess
 * side effects (process.parentPort / top-level boot()) that make index.ts
 * un-importable from a test.
 *
 *  - parseHostArgs: mirror of cli/main.ts's parseCliArgs `--resume` branch, plus
 *    the new `--session` branch (§3.5). tabId never reaches the host — the host
 *    stays tab-agnostic; only the session id crosses the process boundary.
 *  - resolveBootSession: `--session <id>` creates a fresh session with that id;
 *    `--resume <id>` loads it (creating a fresh one with the same id + a warn
 *    signal when absent — covers a respawn that races the write-behind queue);
 *    no id creates a brand-new random session (legacy / dev boot).
 *  - repairDanglingToolCalls: closes any assistant tool_call left unanswered by
 *    a mid-turn crash with a synthesized `cancelled` tool_result BEFORE the first
 *    resumed turn, mirroring AgentLoop.emitLoopEnd's straggler net so the strict

 *  - seedAlwaysAllowRules (slice 2.2.3, design §5): boot-time READ of the
 *    persisted `permissions.alwaysAllow` rules from settings.json (main is the
 *    only writer — permission-rule-add / settings-set, 2.2.2), fail-soft. This
 *    is the read half of the persistence loop: main persists a rule when the
 *    user clicks "Always allow", every subsequent host boot re-reads it here so
 *    the rule survives a restart from turn one (design §5's "new hosts read on
 *    boot" clause).
 *  - scrubSecretEnv (slice 2.2.3, ruling §3): deletes SECRET_ENV_KEYS from the
 *    host's own live `process.env` after boot, so Bash children spawned later
 *    via node-execution.ts (`{...process.env, ...request.env}`) never inherit
 *    ANYCODE_API_KEY.
 *  - createMainCredentialProvider / buildResolveApiKey (slice 2.5 §3.3): the
 *    host-side `MainCredentialProvider` — an `AnthropicEndpointConfig.
 *    resolveApiKey` implementation that asks main for a fresh access token
 *    over the parentPort credential channel (shared/credentials.ts) when this
 *    fork is booted with `ANYCODE_AUTH_MODE=oauth`; TTL-cached, falls back to
 *    the fork's own static env key on timeout or a blank/absent answer.
 *    `buildResolveApiKey` is the gate index.ts wires: unset/non-"oauth" mode
 *    returns `undefined` so `AiSdkModelPort` never receives the field at all
 *    (byte-for-byte the 2.2 static-key path).
 */

import { randomUUID } from "node:crypto";
import { ConversationHistory, SessionPermissionRules } from "@anycode/core";
import type { DiagnosticSink, HistoryItem, HistorySink, PersistencePort, SessionMeta } from "@anycode/core";
import { SECRET_ENV_KEYS } from "../shared/settings.js";
import { defaultSettingsPath, loadSettings } from "../settings/files.js";
import { CREDENTIAL_REQUEST_TYPE, type CredentialRequest, type CredentialResponse } from "../shared/credentials.js";

export interface HostArgs {
  /** Session id from `--session`/`--resume` (undefined = brand-new random session). */
  sessionId?: string;
  /** True for `--resume` (load, create-if-absent); false for `--session`/no id (create). */
  resume: boolean;
}

/**
 * Parses `--session <id>|--session=<id>` and `--resume <id>|--resume=<id>` from
 * argv (mirror of cli/main.ts:60-105). The last id-bearing flag wins; `--resume`
 * sets resume=true, `--session` sets resume=false.
 */
export function parseHostArgs(argv: string[]): HostArgs {
  let sessionId: string | undefined;
  let resume = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--session") {
      const value = argv[i + 1];
      i++;
      if (value !== undefined) {
        sessionId = value;
        resume = false;
      }
      continue;
    }
    if (arg.startsWith("--session=")) {
      sessionId = arg.slice("--session=".length);
      resume = false;
      continue;
    }
    if (arg === "--resume") {
      const value = argv[i + 1];
      i++;
      if (value !== undefined) {
        sessionId = value;
        resume = true;
      }
      continue;
    }
    if (arg.startsWith("--resume=")) {
      sessionId = arg.slice("--resume=".length);
      resume = true;
    }
  }

  return { sessionId, resume };
}

export interface BootSessionResult {
  sessionMeta: SessionMeta;
  /** Prior persisted history for a resumed session; empty for a freshly created one. */
  initialHistory: HistoryItem[];
  /**
   * True when `--resume` named a session absent from the DB and a fresh one was
   * created with that same id (respawn before the write-behind queue flushed).
   * The caller warns on this — it is expected, not an error.
   */
  resumedMissing: boolean;
}

/**
 * Resolves the boot session from parsed args against persistence (§3.5). Mirror
 * of cli/main.ts:239-253: a resumed session's meta+history is loaded; anything
 * else creates a fresh session. `mode` for a freshly created session defaults to
 * "build" (a new session has no prior mode); a resumed session keeps its
 * persisted mode.
 */
export async function resolveBootSession(
  persistence: PersistencePort,
  opts: { args: HostArgs; workspace: string; model: string; connectionId?: string },
): Promise<BootSessionResult> {
  const { args, workspace, model, connectionId } = opts;
  // TASK.45 W10: the pinned provider connection is written only on session
  // CREATION. A resumed existing session keeps whatever it was pinned to — main
  // never re-pins a live thread to the current default (session-pinning invariant).
  const pin = connectionId !== undefined && connectionId !== "" ? { connectionId } : {};

  if (args.resume && args.sessionId !== undefined) {
    const existing = await persistence.getSession(args.sessionId);
    if (existing) {
      const initialHistory = await persistence.loadHistory(args.sessionId);
      return { sessionMeta: existing, initialHistory, resumedMissing: false };
    }
    const sessionMeta = await persistence.createSession({
      id: args.sessionId,
      workspace,
      model,
      mode: "build",
      ...pin,
    });
    return { sessionMeta, initialHistory: [], resumedMissing: true };
  }

  // `--session <id>` (id supplied by main) or no id at all (legacy/dev boot).
  const id = args.sessionId ?? randomUUID();
  const sessionMeta = await persistence.createSession({ id, workspace, model, mode: "build", ...pin });
  return { sessionMeta, initialHistory: [], resumedMissing: false };
}

/**
 * Closes every dangling assistant tool_call (a mid-turn crash persisted a
 * tool_call but no matching tool_result) with a synthesized `cancelled`
 * tool_result, mirroring AgentLoop.emitLoopEnd's straggler net. The appends flow
 * through the ConversationHistory's own write-behind sink; the passed sink is
 * flushed so the synthesized results reach disk BEFORE the first resumed turn,

 * number of tool_calls repaired (0 = clean history, a no-op).
 */
export async function repairDanglingToolCalls(
  history: ConversationHistory,
  sink: HistorySink,
): Promise<number> {
  const dangling = history.unansweredToolCallIds();
  if (dangling.length === 0) {
    return 0;
  }

  const names = new Map<string, string>();
  for (const item of history.items) {
    if (item.message.role === "assistant") {
      for (const part of item.message.content) {
        if (part.type === "tool_call") {
          names.set(part.toolCallId, part.toolName);
        }
      }
    }
  }

  for (const toolCallId of dangling) {
    const toolName = names.get(toolCallId) ?? "unknown";
    history.append({
      role: "tool",
      content: [
        {
          type: "tool_result",
          toolCallId,
          toolName,
          text: `Tool ${toolName} was cancelled before it produced a result.`,
          status: "cancelled",
        },
      ],
    });
  }

  // Drain the write-behind queue so the repair is durable before the first turn.
  await sink.flush();
  return dangling.length;
}

// ── always-allow persistence: boot-time seed from settings.json (design §5) ──

/**
 * Seeds a fresh `SessionPermissionRules` from the persisted `permissions.
 * alwaysAllow` rules in settings.json (mirror of cli/main.ts:341's /allow
 * wiring, but pre-populated instead of starting empty). A rule persisted by a
 * PRIOR session's "Always allow" click (main dedup-appends it via
 * `permission-rule-add`, design §5) auto-allows a matching `ask` ruling from
 * the very first turn of every NEW host boot — that re-read on every boot is
 * what makes the rule survive an app restart.
 *
 * Fail-soft (never crashes host boot): `loadSettings` itself already degrades
 * a missing/corrupt/unreadable file to in-memory defaults (empty
 * `alwaysAllow`), so the try/catch here is a defensive outer net for anything
 * unexpected (e.g. a future schema change) — either way a broken settings.json
 * only costs the user the always-allow convenience for this boot, never the
 * host itself. Host never writes settings.json (main is the sole writer).
 */
export async function seedAlwaysAllowRules(
  settingsPath: string = defaultSettingsPath(),
): Promise<SessionPermissionRules> {
  const rules = new SessionPermissionRules();
  try {
    const { settings } = await loadSettings(settingsPath);
    for (const rule of settings.permissions.alwaysAllow) {
      rules.add(toPermissionRule(rule));
    }
  } catch (error) {
    console.error(
      `[host] failed to seed always-allow rules from ${settingsPath}; starting with none: ` +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  return rules;
}

/**
 * Drops an `undefined` `pattern` rather than assigning it (mirrors core's
 * `PermissionRule` shape structurally — `SessionPermissionRules.add` accepts
 * any `{toolName: string; pattern?: string}`). NOTE: `PermissionRule` itself is
 * NOT re-exported from `@anycode/core`'s `types/index.ts` (unlike its
 * neighbors `PermissionRequest`/`PermissionRuling`/`PermissionDecision`), so
 * this stays a structural match instead of a named import — flagged as a
 * candidate one-line barrel addition for whoever next touches core's types
 * barrel; additive, out of this lane's scope to fix directly (core = zero
 * files this slice).
 */
function toPermissionRule(rule: { toolName: string; pattern?: string }): { toolName: string; pattern?: string } {
  return rule.pattern !== undefined ? { toolName: rule.toolName, pattern: rule.pattern } : { toolName: rule.toolName };
}

// ── env-hardening: scrub secrets from the host's own live process.env (ruling §3) ──

/**
 * Deletes every `SECRET_ENV_KEYS` entry (currently just `ANYCODE_API_KEY`)
 * from the live `process.env` of THIS host process. Called from `boot()`'s
 * `finally` in index.ts, which — by construction of `finally` — runs strictly
 * AFTER the try block, i.e. after `AiSdkModelPort` has already captured
 * `envConfig.apiKey` into its own constructor-held config object (the SDK
 * adapter never re-reads `process.env` later; see provider/model-port.ts /
 * adapters/node/anthropic.ts), so the running model port keeps working. Tools
 * (and therefore any Bash child spawned by node-execution.ts, which builds a
 * child's env as `{...process.env, ...request.env}`) only ever run once a
 * `Session` exists and a turn starts — strictly after `boot()` returns — so
 * there is no race: by the time a Bash child could spawn, the key is already
 * gone from `process.env`. Also runs on the init-failure path (`finally` fires
 * even when the try block throws) — defense-in-depth: a degraded host that
 * never got a session still leaks nothing. Idempotent. Non-secret `ANYCODE_*`
 * vars (MODEL/BASE_URL/DB_PATH/AUTOMATION/...) are untouched.
 *
 * Deliberate small duplication: main/host-env.ts exports the equivalent
 * one-liner for main's OWN process.env (ruling §3.3). Host does not import
 * main/* (that would be a host->main layering violation — see this module's
 * file header and settings/schema.ts's), so each process owns its own copy of
 * the same single-purpose primitive over the single shared constant
 * (`SECRET_ENV_KEYS`, shared/settings.ts).
 */
export function scrubSecretEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const key of SECRET_ENV_KEYS) {
    delete env[key];
  }
}

// ── host-side DiagnosticSink: named seam for provider diagnostics (slice 6.DP-1) ──

/** Named host-side DiagnosticSink (slice 6.DP-1, 5.6 deferred host-half):
 *  the desktop host's explicit seam for provider diagnostics. Format = the
 *  default sink's bytes with the host log prefix; a future slice may route
 *  this to the wire/telemetry without touching the provider. */
export const hostDiagnosticSink: DiagnosticSink = (event) => {
  switch (event.kind) {
    case "provider_stream_artifact":
      console.warn(`[host] dropping unparsable provider stream artifact: ${event.signature}`);
      return;
  }
};

// ── MainCredentialProvider: host-side resolveApiKey for oauth mode (design §3.3) ──

/** Per-request timeout before falling back to the fork's static env key. */
export const CREDENTIAL_REQUEST_TIMEOUT_MS = 5_000;

/** Cache window for a successfully resolved key before re-asking main. */
export const CREDENTIAL_CACHE_TTL_MS = 60_000;

export interface MainCredentialProviderOptions {
  /** Sends a CredentialRequest to main (index.ts: process.parentPort.postMessage). */
  send: (request: CredentialRequest) => void;
  /**
   * Registers a listener for CredentialResponse messages arriving on the
   * control-plane channel (index.ts: filtered off process.parentPort's
   * "message" event, matched by requestId — main replies to whichever process
   * asked; the host itself stays tab-agnostic). Returns an unsubscribe function.
   */
  subscribe: (listener: (response: CredentialResponse) => void) => () => void;
  /**
   * Static fallback key — the fork's own `ANYCODE_API_KEY` (envConfig.apiKey,
   * the access token this fork was spawned with) — used when a request times
   * out or main answers with no usable key. Optional because `envConfig.apiKey`
   * itself is optional (TASK.43 §0.4, no-auth openai transports); oauth mode is
   * anthropic-only in practice, so this stays undefined only on a mis-wired fork.
   */
  fallbackApiKey: string | undefined;
  /** Overrides CREDENTIAL_REQUEST_TIMEOUT_MS (tests only). */
  timeoutMs?: number;
  /** Overrides CREDENTIAL_CACHE_TTL_MS (tests only). */
  ttlMs?: number;
  /** Injectable clock (tests only); defaults to Date.now. */
  now?: () => number;
  /** Injectable request-id generator (tests only); defaults to randomUUID. */
  createRequestId?: () => string;
}

/**
 * Builds the host-side `MainCredentialProvider` (design slice-2.5-cut.md
 * §3.3): an `AnthropicEndpointConfig.resolveApiKey` implementation that asks
 * main for a fresh access token over the parentPort credential channel
 * (`CREDENTIAL_REQUEST_TYPE`/`CREDENTIAL_RESPONSE_TYPE`, shared/credentials.ts),
 * correlating the answer by `requestId`.
 *
 * - TTL-cached (~60s default, `CREDENTIAL_CACHE_TTL_MS`): a resolved key is
 *   reused across attempts inside the window instead of re-asking main on
 *   every attempt.
 * - A request that times out (~5s default, `CREDENTIAL_REQUEST_TIMEOUT_MS`),
 *   or a response carrying no usable `apiKey` (absent / blank after trim),
 *   resolves to `fallbackApiKey` WITHOUT caching it — so the very next
 *   attempt asks main again rather than being pinned to a stale fallback for
 *   the whole TTL window. The returned promise never rejects: even without
 *   `AiSdkModelPort`'s own try/catch (model-port.ts's `buildAttemptModel`), a
 *   broker hiccup can never fail the turn.
 */
export function createMainCredentialProvider(
  options: MainCredentialProviderOptions,
): () => Promise<string | undefined> {
  const timeoutMs = options.timeoutMs ?? CREDENTIAL_REQUEST_TIMEOUT_MS;
  const ttlMs = options.ttlMs ?? CREDENTIAL_CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  const createRequestId = options.createRequestId ?? randomUUID;

  let cached: { apiKey: string; expiresAt: number } | undefined;

  return function resolveApiKey(): Promise<string | undefined> {
    if (cached !== undefined && cached.expiresAt > now()) {
      return Promise.resolve(cached.apiKey);
    }

    const requestId = createRequestId();
    return new Promise<string | undefined>((resolve) => {
      let settled = false;

      const finish = (apiKey: string | undefined): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        resolve(apiKey);
      };

      const unsubscribe = options.subscribe((response) => {
        if (response.requestId !== requestId) {
          return;
        }
        if (response.apiKey !== undefined && response.apiKey.trim() !== "") {
          cached = { apiKey: response.apiKey, expiresAt: now() + ttlMs };
          finish(response.apiKey);
        } else {
          finish(options.fallbackApiKey);
        }
      });

      const timer = setTimeout(() => {
        finish(options.fallbackApiKey);
      }, timeoutMs);

      options.send({ type: CREDENTIAL_REQUEST_TYPE, requestId });
    });
  };
}

export interface BuildResolveApiKeyOptions extends MainCredentialProviderOptions {
  /** `process.env[ENV_AUTH_MODE]` (shared/credentials.ts) — `"oauth"` enables the broker. */
  authMode: string | undefined;
}

/**
 * Wiring gate for index.ts (design §3.3): `authMode !== "oauth"` (unset or any
 * other value) returns `undefined`, so the caller omits `resolveApiKey`
 * entirely from the `AnthropicEndpointConfig` object literal it builds —
 * `AiSdkModelPort` never even sees the field, i.e. byte-for-byte the 2.2
 * static-key path. `authMode === "oauth"` builds the real
 * `MainCredentialProvider` via `createMainCredentialProvider`.
 */
export function buildResolveApiKey(
  options: BuildResolveApiKeyOptions,
): (() => Promise<string | undefined>) | undefined {
  if (options.authMode !== "oauth") {
    return undefined;
  }
  return createMainCredentialProvider(options);
}
