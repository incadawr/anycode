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
 *  - createPreviewRpcClient / routePreviewMessage (night-track wave-1 cut
 *    §2.3): the host-side `PreviewPort` — an RPC client that asks main to run
 *    one open/read/screenshot op over the SAME parentPort control plane
 *    (shared/preview.ts), correlating the answer by requestId (mirror of
 *    createMainCredentialProvider's req/resp pattern, just without the TTL
 *    cache — a preview op is not a credential). `routePreviewMessage` is the
 *    pure parentPort filter index.ts's `on("message")` handler calls into: it
 *    recognizes PREVIEW_RESPONSE_TYPE (fans out to the requestId-matched RPC
 *    waiter) and PREVIEW_EVENT_TYPE (a recognized no-op seam for slice 96-D's
 *    console/pageerror -> AgentEvent bridge — not built here).
 */

import { randomUUID } from "node:crypto";
import { ConversationHistory, PERMISSION_MODES, SessionPermissionRules } from "@anycode/core";
import type {
  DiagnosticSink,
  HistoryItem,
  HistorySink,
  PermissionMode,
  PersistencePort,
  SessionMeta,
} from "@anycode/core";
import { SECRET_ENV_KEYS } from "../shared/settings.js";
import { defaultSettingsPath, loadSettings } from "../settings/files.js";
import { CREDENTIAL_REQUEST_TYPE, type CredentialRequest, type CredentialResponse } from "../shared/credentials.js";
import type {
  PreviewOpenSuccess,
  PreviewPort,
  PreviewReadSuccess,
  PreviewScreenshotSuccess,
} from "@anycode/core";
import {
  PREVIEW_EVENT_TYPE,
  PREVIEW_REQUEST_TYPE,
  PREVIEW_RESPONSE_TYPE,
  type PreviewEventMessage,
  type PreviewOp,
  type PreviewRequestMessage,
  type PreviewResponseMessage,
  type PreviewResult,
} from "../shared/preview.js";

/**
 * Child-mode argv, present only for a host main forked to run a session
 * spawned by another session's `Agent tier:"session"` call (TASK.102 CUT-S2
 * §2.6.2). `parentSessionId`/`spawnToolCallId` become this session's durable
 * `parent_session_id`/`spawn_tool_call_id` columns (§2.4, migration v13);
 * `initialMode` is a SNAPSHOT of the parent's permission mode at the moment
 * `Agent` was invoked (§0.8) — a child never tracks the parent's LIVE mode
 * after that.
 */
export interface HostChildArgs {
  parentSessionId: string;
  spawnToolCallId: string;
  initialMode: PermissionMode;
}

export interface HostArgs {
  /** Session id from `--session`/`--resume` (undefined = brand-new random session). */
  sessionId?: string;
  /** True for `--resume` (load, create-if-absent); false for `--session`/no id (create). */
  resume: boolean;
  /** Present only for a child-mode boot (§2.6.2); absent for every root/legacy boot. */
  child?: HostChildArgs;
}

/**
 * Parses `--session <id>|--session=<id>`, `--resume <id>|--resume=<id>`, and
 * the child-mode triple `--child-parent <id>`, `--child-spawn-call <id>`,
 * `--child-mode <mode>` from argv (mirror of cli/main.ts:60-105; child flags
 * added by TASK.102 CUT-S2 §2.6.2). The last id-bearing flag of each kind
 * wins; `--resume` sets resume=true, `--session` sets resume=false. `child`
 * is populated ONLY when all three child flags were seen with well-formed
 * values (an unrecognized `--child-mode` value is dropped rather than
 * accepted — main is a trusted, non-adversarial sender of this argv, but a
 * malformed child triple must never silently produce a HALF-populated
 * `HostArgs.child`, which downstream code treats as an all-or-nothing signal).
 */
export function parseHostArgs(argv: string[]): HostArgs {
  let sessionId: string | undefined;
  let resume = false;
  let childParent: string | undefined;
  let childSpawnCall: string | undefined;
  let childMode: PermissionMode | undefined;

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
      continue;
    }
    if (arg === "--child-parent") {
      const value = argv[i + 1];
      i++;
      if (value !== undefined) {
        childParent = value;
      }
      continue;
    }
    if (arg.startsWith("--child-parent=")) {
      childParent = arg.slice("--child-parent=".length);
      continue;
    }
    if (arg === "--child-spawn-call") {
      const value = argv[i + 1];
      i++;
      if (value !== undefined) {
        childSpawnCall = value;
      }
      continue;
    }
    if (arg.startsWith("--child-spawn-call=")) {
      childSpawnCall = arg.slice("--child-spawn-call=".length);
      continue;
    }
    if (arg === "--child-mode") {
      const value = argv[i + 1];
      i++;
      if (value !== undefined && isPermissionMode(value)) {
        childMode = value;
      }
      continue;
    }
    if (arg.startsWith("--child-mode=")) {
      const value = arg.slice("--child-mode=".length);
      if (isPermissionMode(value)) {
        childMode = value;
      }
    }
  }

  const child =
    childParent !== undefined && childSpawnCall !== undefined && childMode !== undefined
      ? { parentSessionId: childParent, spawnToolCallId: childSpawnCall, initialMode: childMode }
      : undefined;

  return child !== undefined ? { sessionId, resume, child } : { sessionId, resume };
}

function isPermissionMode(value: string): value is PermissionMode {
  return (PERMISSION_MODES as readonly string[]).includes(value);
}

/**
 * Second, independent authority feeding non-recursion lock #2
 * (`host/index.ts`'s `config.sessionSubagents` wiring — TASK.102 CUT-S2
 * §10.9.2 arbitration). True when EITHER signal says "this boot is a
 * child": the argv authority (`args.child`, the same fact lock #1 reads,
 * before persistence is even consulted) OR the durable authority
 * (`meta.parentSessionId`, main's own `tabs.ts` ledger replayed back
 * through `resolveBootSession`) — two genuinely different sources of
 * truth, not the same fact read twice. OR-semantics = fail-closed: either
 * signal alone withholds the session-tier capability; agreement between
 * them is never required. Lock #1 (the tool-registry ternary, built
 * BEFORE `resolveBootSession` runs) deliberately stays argv-only — `meta`
 * does not exist yet at that point in boot, and reordering boot to make it
 * exist buys nothing because lock #2 (this predicate) and lock #3
 * (`main/tabs.ts`'s own `childOf` ledger + sender check) already close the
 * capability independently of lock #1's schema (CUT-S2 §10.9.2 p.4).
 */
export function isChildSessionBoot(args: HostArgs, meta: SessionMeta): boolean {
  return args.child !== undefined || meta.parentSessionId !== undefined;
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
 * The session-row fields a freshly CREATED session gets from `args.child`
 * (TASK.102 CUT-S2 §2.6.2/§0's "Строку сессии ребёнка создаёт ХОСТ ребёнка,
 * из argv"): `parentSessionId`/`spawnToolCallId` (durable parent-link,
 * migration v13) plus `mode: initialMode` — the parent's permission-mode
 * SNAPSHOT at spawn, in place of the hardcoded `"build"` every non-child
 * creation still gets (a fresh root session has no prior mode to inherit).
 * Applied identically at BOTH create call-sites below: the normal
 * `--session <childId>` creation AND the `resumedMissing` respawn-race
 * branch — a missing child row respawned before the write-behind queue
 * flushed must become a child row again, never a nameless ROOT row that
 * would then sit forever in the Sidebar (the S2a residual this closes).
 */
function childCreateFields(args: HostArgs): { parentSessionId?: string; spawnToolCallId?: string; mode: PermissionMode } {
  if (args.child === undefined) {
    return { mode: "build" };
  }
  return {
    parentSessionId: args.child.parentSessionId,
    spawnToolCallId: args.child.spawnToolCallId,
    mode: args.child.initialMode,
  };
}

/**
 * Resolves the boot session from parsed args against persistence (§3.5). Mirror
 * of cli/main.ts:239-253: a resumed session's meta+history is loaded; anything
 * else creates a fresh session. `mode` for a freshly created session defaults to
 * "build" (a new session has no prior mode) UNLESS this is a child-mode boot, in
 * which case it is the parent's permission-mode snapshot (`childCreateFields`
 * above); a resumed EXISTING session keeps its own persisted mode either way.
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
    // Internal read by id (TASK.102 S2a §2.4): a child-mode boot resumes by
    // the exact id main built into its argv (root or child) — not a
    // UX-facing selection, so root-filtering here would break child boot.
    const existing = await persistence.getSessionById(args.sessionId);
    if (existing) {
      const initialHistory = await persistence.loadHistory(args.sessionId);
      return { sessionMeta: existing, initialHistory, resumedMissing: false };
    }
    // resumedMissing: `--resume <childId>` raced the write-behind queue and
    // found no row. Without `childCreateFields` here this would silently
    // create a PARENT-LESS root row under the child's own id — permanently
    // visible in the Sidebar with no owner (the S2a residual, CUT-S2 §10.4).
    const sessionMeta = await persistence.createSession({
      id: args.sessionId,
      workspace,
      model,
      ...childCreateFields(args),
      ...pin,
    });
    return { sessionMeta, initialHistory: [], resumedMissing: true };
  }

  // `--session <id>` (id supplied by main) or no id at all (legacy/dev boot).
  const id = args.sessionId ?? randomUUID();
  const sessionMeta = await persistence.createSession({
    id,
    workspace,
    model,
    ...childCreateFields(args),
    ...pin,
  });
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
 * Deletes every `SECRET_ENV_KEYS` entry (`ANYCODE_API_KEY`, and since TASK.198
 * срез C also `ANYCODE_RECOGNIZER_API_KEY`) from the live `process.env`
 * of THIS host process. Called from `boot()`'s
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
    case "include_usage_disabled":
      console.warn(
        `[host] ${event.baseUrl} (model ${event.model}) rejected stream_options.include_usage with HTTP 400 — ` +
          `disabling it for this endpoint. Token usage will not be tracked here. ` +
          `Set ANYCODE_INCLUDE_USAGE=0 to skip this probe and disable it permanently.`,
      );
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

// ── PreviewPort RPC client: host-side over process.parentPort (night-track wave-1 cut §2.3) ──

/** Per-request deadline before a preview op reports an honest timeout rather than hanging the tool call forever on an unresponsive main. */
export const PREVIEW_REQUEST_TIMEOUT_MS = 45_000;

export interface CreatePreviewRpcClientOptions {
  /** Sends a PreviewRequestMessage to main (index.ts: process.parentPort.postMessage). */
  send: (request: PreviewRequestMessage) => void;
  /**
   * Registers a listener for PreviewResponseMessage messages arriving on the
   * control-plane channel (index.ts: filtered off process.parentPort's
   * "message" event via routePreviewMessage below, matched by requestId).
   * Returns an unsubscribe function — mirrors MainCredentialProviderOptions.subscribe.
   */
  subscribe: (listener: (response: PreviewResponseMessage) => void) => () => void;
  /** Overrides PREVIEW_REQUEST_TIMEOUT_MS (tests only). */
  timeoutMs?: number;
  /** Injectable request-id generator (tests only); defaults to randomUUID. */
  createRequestId?: () => string;
}

/**
 * Builds the host-side `PreviewPort` (night-track wave-1 cut §2.3): an RPC
 * client that asks main to run one open/read/screenshot op over the
 * parentPort control plane, correlating the answer by `requestId` (mirror of
 * `createMainCredentialProvider`'s req/resp pattern, §3.3 — without a TTL
 * cache, since a preview op is a one-shot action, not a reusable credential).
 *
 * Every call:
 *  - resolves immediately with a cancelled `PreviewResult` when the caller's
 *    `AbortSignal` is already aborted, and finishes the SAME way if it aborts
 *    mid-flight (dispatcher/handler abort, e.g. a parent turn cancel);
 *  - times out after `timeoutMs` (default `PREVIEW_REQUEST_TIMEOUT_MS`) with
 *    an honest `{ok:false, errorKind:"timeout"}` instead of hanging forever
 *    on an unresponsive or crashed main;
 *  - never throws — a broker hiccup can never fail the calling tool's await
 *    (mirrors every other PreviewResult-returning path: always produced).
 */
export function createPreviewRpcClient(options: CreatePreviewRpcClientOptions): PreviewPort {
  const timeoutMs = options.timeoutMs ?? PREVIEW_REQUEST_TIMEOUT_MS;
  const createRequestId = options.createRequestId ?? randomUUID;

  function call<T>(op: PreviewOp, signal: AbortSignal): Promise<PreviewResult<T>> {
    if (signal.aborted) {
      return Promise.resolve({ ok: false, error: "Preview request was cancelled.", errorKind: "cancelled" });
    }

    const requestId = createRequestId();
    return new Promise<PreviewResult<T>>((resolve) => {
      let settled = false;

      const finish = (result: PreviewResult<T>): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      };

      const onAbort = (): void => {
        finish({ ok: false, error: "Preview request was cancelled.", errorKind: "cancelled" });
      };

      const unsubscribe = options.subscribe((response) => {
        if (response.requestId !== requestId) {
          return;
        }
        // The wire envelope carries a union of all three success shapes
        // (shared/preview.ts does not re-encode the op kind in the response);
        // each PreviewPort method below pins its own T when it calls here,
        // exactly like the request op it sent determines what main returns.
        finish(response.result as PreviewResult<T>);
      });

      const timer = setTimeout(() => {
        finish({
          ok: false,
          error: `Preview request timed out after ${timeoutMs}ms.`,
          errorKind: "timeout",
        });
      }, timeoutMs);

      signal.addEventListener("abort", onAbort, { once: true });
      options.send({ type: PREVIEW_REQUEST_TYPE, requestId, op });
    });
  }

  return {
    open: (req, opts) =>
      call<PreviewOpenSuccess>(
        {
          kind: "open",
          ...(req.path !== undefined ? { path: req.path } : {}),
          ...(req.url !== undefined ? { url: req.url } : {}),
          ...(req.previewId !== undefined ? { previewId: req.previewId } : {}),
          ...(opts.allowRemote !== undefined ? { allowRemote: opts.allowRemote } : {}),
        },
        opts.signal,
      ),
    read: (req, opts) =>
      call<PreviewReadSuccess>(
        {
          kind: "read",
          ...(req.previewId !== undefined ? { previewId: req.previewId } : {}),
          ...(req.selector !== undefined ? { selector: req.selector } : {}),
          ...(req.format !== undefined ? { format: req.format } : {}),
          ...(req.waitForSelector !== undefined ? { waitForSelector: req.waitForSelector } : {}),
          ...(req.waitMs !== undefined ? { waitMs: req.waitMs } : {}),
          ...(req.includeConsole !== undefined ? { includeConsole: req.includeConsole } : {}),
        },
        opts.signal,
      ),
    screenshot: (req, opts) =>
      call<PreviewScreenshotSuccess>(
        { kind: "screenshot", ...(req.previewId !== undefined ? { previewId: req.previewId } : {}) },
        opts.signal,
      ),
  };
}

// ── parentPort message router: preview control-plane channel (night-track wave-1 cut §2.3) ──

export interface PreviewMessageConsumers {
  /** Fan-out target for a PreviewResponseMessage — index.ts routes it to the requestId-matched RPC waiter above. */
  onResponse: (message: PreviewResponseMessage) => void;
  /**
   * Seam for slice 96-D (console/pageerror -> outbound AgentEvent bridge). No
   * consumer is wired yet: a PREVIEW_EVENT_TYPE message is still recognized
   * here (so it is never treated as an unknown/unhandled message) but is
   * silently dropped until 96-D registers this callback.
   */
  onEvent?: (message: PreviewEventMessage) => void;
}

/**
 * Pure parentPort message filter for the preview control-plane channel
 * (shared/preview.ts). Returns true when `data` matched a known preview
 * message type (so index.ts's `on("message")` handler can skip its own
 * later branches for it); false for anything else, including a message with
 * no recognizable `type` at all. A plain function with no `process.
 * parentPort` reference of its own, so it is exercisable from a test with a
 * literal message object — the same testability rationale as every other
 * export in this file (see the file header).
 */
export function routePreviewMessage(data: unknown, consumers: PreviewMessageConsumers): boolean {
  const message = data as { type?: unknown } | null | undefined;
  if (!message || typeof message.type !== "string") {
    return false;
  }
  if (message.type === PREVIEW_RESPONSE_TYPE) {
    consumers.onResponse(data as PreviewResponseMessage);
    return true;
  }
  if (message.type === PREVIEW_EVENT_TYPE) {
    consumers.onEvent?.(data as PreviewEventMessage);
    return true;
  }
  return false;
}
