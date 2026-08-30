/**
 * The Vision panel's "Probe" button (TASK.198 срез E2): "does THIS
 * connection/model pair, resolved the exact way a live run would resolve it,
 * actually answer a vision question?" — answered by spawning a real child
 * process that calls the SAME `ask()` primitive a live host uses
 * (packages/core/src/vision/recognizer.ts), against a tiny embedded probe
 * image, and returning the answer as-is.
 *
 * ── Why a spawned child, not an in-process `ask()` call ──
 *
 * `ask()` needs `@anycode/core`'s full AI-SDK model-port stack, which main
 * does not otherwise load (main/index.ts imports core ONLY through curated,
 * narrow subpaths — persistence, node-execution, catalog, ...). Loading it
 * in-process here would make this ONE feature the reason main's bundle
 * carries the whole provider/model-port graph. A spawned child
 * (`process.execPath` + `ELECTRON_RUN_AS_NODE=1`, same canon as
 * proxy-probe.ts's TASK.141 §6 probe) sidesteps that for free: the child is
 * its OWN bundled entry point (electron.vite.config.ts's third main-target
 * input), so only ITS process pays for loading core's model layer.
 *
 * ── Why the candidate is resolved through `resolveRecognizerConfig`, never a
 * second ladder ──
 *
 * `resolveRecognizerConfig` (main/host-env.ts) is the ONE normative resolver
 * a live run's fork-env and its live config push both go through — it already
 * carries the connection -> catalog baseUrl fallback, the transport ladder and
 * the oauth/dangling/blank-address refusals, and a real defect in that ladder
 * (TASK.198 follow-up) cost a whole extra live-run cycle to find. A probe that
 * resolved its candidate any other way could go green on a connection the
 * real path would refuse, which is worse than no probe at all. The candidate
 * is not necessarily SAVED to `settings.recognizer` yet — the caller hands a
 * `{connectionId, modelId}` pair, and this module builds a shallow settings
 * copy with `recognizer` overridden to that pair before calling the resolver,
 * so "try before you save" costs nothing extra in the resolver itself.
 *
 * `toRecognizerEndpoint` below mirrors host/index.ts's own
 * `recognizerEndpointFromFields` (TASK.198 срез C) FIELD FOR FIELD — same
 * transport allow-list, same "anthropic-messages" default for an absent
 * transport, same empty-string-drop for apiKey/providerName. That function is
 * private to host/index.ts (not exported, and host/index.ts is out of this
 * slice's file list), so this is a deliberate, documented duplicate of a
 * SMALL field-shaping step — not the "build a request by transport" ladder
 * the design explicitly forbids re-implementing (that ladder is `ask()`
 * itself, run for real inside the child, never touched here).
 *
 * ── Every result is a tagged object, never a thrown exception ──
 *
 * `handleRecognizerProbeRequest` never rejects: a probe that could crash the
 * IPC round trip on a bad connection would be worse than the tool it is
 * meant to de-risk. Every failure carries a machine-readable `reason` (for
 * the panel's own branching) and a human `message` that has ALREADY had the
 * candidate's resolved api key scrubbed out of it — the same
 * split-and-join idiom proxy-probe.ts's `maskProxyCredentials` uses, applied
 * to a value this module resolves itself, never one the caller passes in.
 */

import { spawn as spawnChild } from "node:child_process";
import type { ImageMediaType, ProviderTransport, RecognizerEndpoint } from "@anycode/core";
import { resolveRecognizerConfig, type RecognizerCatalogInfo, type SecretReader } from "./host-env.js";
import type { AnycodeSettings } from "../shared/settings.js";
import type {
  RecognizerProbeFailureReason,
  RecognizerProbeRequest,
  RecognizerProbeResult,
  RecognizerWireConfig,
} from "../shared/recognizer.js";

// ── the embedded probe image (TASK.69's two-square probe, partially closed) ──

/**
 * Fixed question the probe always asks — TASK.69's own two-square wording,
 * unchanged so this probe partially closes that task's original ask. Never
 * user-editable: the point of the button is "does the ROUND TRIP work",
 * which a fixed, known-answer question tests more honestly than a free-form
 * one the user might phrase ambiguously.
 */
export const RECOGNIZER_PROBE_QUESTION = "what colors are the two squares?";

export const RECOGNIZER_PROBE_IMAGE_MEDIA_TYPE: ImageMediaType = "image/png";

/**
 * A 100x50 PNG, left half solid red (#d62728) and right half solid blue
 * (#1f77b4) — generated with Pillow, not hand-assembled, and verified twice
 * before being pasted here: the raw bytes decode back to a 100x50 two-tone
 * image, AND `sniffImageMediaType` (packages/core/src/util/images.ts) reads
 * its first 8 bytes as the PNG magic number. Both checks are pinned in
 * recognizer-probe.test.ts.
 */
export const RECOGNIZER_PROBE_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAGQAAAAyCAIAAAAlV+npAAAAZElEQVR42u3QMREAIAwAsYKZYoUNYehDTy0wdsgr+Mt4uaJf+9yGVzMECxYsWLBgCRYsWLBgwRIsWLBgwYIlWLBgwYIFS7BgwYIFC5ZgwYIFCxYswYIFCxYsWIIFCxYsWLD0XQGhSgKuSqFnMgAAAABJRU5ErkJggg==";

// ── candidate resolution (production path, never a second ladder) ──

/**
 * Mirrors host/index.ts's own `RECOGNIZER_TRANSPORT_VALUES` (TASK.198 срез C)
 * verbatim — literal copy, not imported, for the same cross-layer reason
 * every other host/main mirror in this codebase gives (main never imports
 * from `../host/`, host never imports from `../main/`).
 */
const RECOGNIZER_TRANSPORT_VALUES: readonly string[] = ["anthropic-messages", "openai-chat-completions", "openai-responses"];

/**
 * Wire config -> core `RecognizerEndpoint`, mirroring host/index.ts's private
 * `recognizerEndpointFromFields` field for field: a still-blank baseUrl or an
 * unrecognised transport STRING refuses (returns undefined) rather than
 * guessing, and an absent transport defaults to `"anthropic-messages"` —
 * the one shared fallback every consumer of a resolved recognizer config
 * applies, never a second policy invented for the probe.
 */
function toRecognizerEndpoint(wire: RecognizerWireConfig): RecognizerEndpoint | undefined {
  if (wire.baseUrl === undefined || wire.baseUrl.trim() === "") {
    return undefined;
  }
  if (wire.transport !== undefined && !RECOGNIZER_TRANSPORT_VALUES.includes(wire.transport)) {
    return undefined;
  }
  return {
    transport: (wire.transport as ProviderTransport | undefined) ?? "anthropic-messages",
    baseUrl: wire.baseUrl,
    model: wire.model,
    ...(wire.apiKey !== undefined && wire.apiKey !== "" ? { apiKey: wire.apiKey } : {}),
    ...(wire.providerName !== undefined && wire.providerName !== "" ? { providerName: wire.providerName } : {}),
  };
}

/**
 * Resolves a `{connectionId, modelId}` candidate — which need not be the
 * SAVED `settings.recognizer` value — into the endpoint a live run would
 * build from it, or undefined when the pair does not resolve to a usable
 * endpoint (no such connection, an OAuth connection, or a still-blank
 * address). Builds only a SHALLOW settings copy: every other field of
 * `settings` rides through to `resolveRecognizerConfig` untouched, so the
 * catalog/custom-provider branches it takes still see the real document.
 */
export async function resolveRecognizerProbeCandidate(
  settings: AnycodeSettings,
  request: RecognizerProbeRequest,
  getSecret: SecretReader,
  authKindFor?: (providerId: string) => "api_key" | "oauth" | undefined,
  catalogFor?: (providerId: string) => RecognizerCatalogInfo | undefined,
): Promise<RecognizerEndpoint | undefined> {
  const candidateSettings: AnycodeSettings = {
    ...settings,
    recognizer: { connectionId: request.connectionId, modelId: request.modelId },
  };
  const wire = await resolveRecognizerConfig(candidateSettings, getSecret, authKindFor, catalogFor);
  return wire === undefined ? undefined : toRecognizerEndpoint(wire);
}

// ── the spawn (canon: process.execPath + ELECTRON_RUN_AS_NODE=1, proxy-probe.ts) ──

/** Marks the child's one result line on stdout — same purpose as proxy-probe.ts's own marker, a different literal so the two probes' output can never be confused if a log ever interleaves them. */
export const RECOGNIZER_PROBE_MARKER = "##anycode-recognizer-probe##";

/** Default one-shot budget handed to the CHILD's own `AbortSignal.timeout()` — same value `ask()` itself defaults to (packages/core/src/vision/recognizer.ts's `ASK_TIMEOUT_MS`), passed explicitly rather than omitted so there is exactly one literal "60 seconds" governing this probe, not two that could drift apart. */
export const RECOGNIZER_PROBE_TIMEOUT_MS = 60_000;

/**
 * Extra grace the PARENT waits past the child's OWN abort budget before
 * killing it — same reasoning as proxy-probe.ts's `PROXY_PROBE_KILL_GRACE_MS`:
 * the child's `AbortSignal.timeout()` firing does not by itself guarantee the
 * process exits (a stalled socket can keep the event loop alive), so the
 * child always tries to exit on its own first and this is only the backstop.
 */
export const RECOGNIZER_PROBE_KILL_GRACE_MS = 2_000;

/**
 * The one JSON payload written to the child's stdin — endpoint (INCLUDING the
 * resolved api key), image and question. Deliberately the ENTIRE input: the
 * key travels over stdin only, never argv (visible to any process on the
 * machine via `ps`) and never env (the other place a spawned child's secrets
 * are visible to more than the child itself).
 */
export interface RecognizerProbeChildInput {
  endpoint: RecognizerEndpoint;
  image: { mediaType: ImageMediaType; data: string };
  question: string;
  timeoutMs: number;
}

export interface RecognizerProbeSpawnRequest {
  execPath: string;
  /** MUST contain nothing but the child entry path — see the module doc's stdin-only rule. */
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  /** The child's entire input, JSON-encoded — see `RecognizerProbeChildInput`. */
  stdin: string;
  /** Hard wall-clock budget for the whole spawn, INCLUDING the kill grace. */
  timeoutMs: number;
}

export interface RecognizerProbeRawOutput {
  /** True when the PARENT killed the child after `timeoutMs` — kept distinct from a spawn failure or a clean exit so the classifier can report "timeout" precisely rather than folding it into a generic error. */
  timedOut: boolean;
  /** Set only when the child process itself could never be started (e.g. `ENOENT` on `execPath`) — distinct from the child starting and then failing. */
  spawnError?: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Runs one probe child. Injected so the handler's tests never spawn anything. */
export type RecognizerProbeSpawner = (request: RecognizerProbeSpawnRequest) => Promise<RecognizerProbeRawOutput>;

/**
 * Extracts the child's result line from raw stdout, or undefined when there
 * is none. The LAST marker line wins — same reasoning as proxy-probe.ts's
 * `readProbePayload`: the runtime is entitled to print warnings of its own,
 * and only the child ever writes this prefix.
 */
function readRecognizerProbePayload(stdout: string): unknown {
  let found: string | undefined;
  for (const line of stdout.split("\n")) {
    const at = line.indexOf(RECOGNIZER_PROBE_MARKER);
    if (at !== -1) {
      found = line.slice(at + RECOGNIZER_PROBE_MARKER.length).trim();
    }
  }
  if (found === undefined || found === "") {
    return undefined;
  }
  try {
    return JSON.parse(found);
  } catch {
    return undefined;
  }
}

/** Loosely-typed shape of the child's own JSON line — the child prints `AskResult` verbatim, but this module parses it defensively rather than trusting an external process's output at its declared type. */
interface RecognizerProbeChildPayload {
  ok?: boolean;
  text?: string;
  kind?: string;
  error?: string;
}

export type RecognizerProbeOutcome =
  | { kind: "success"; text: string }
  | { kind: "empty_response" }
  | { kind: "timeout" }
  | { kind: "spawn_failed"; message: string }
  | { kind: "bad_output"; message: string }
  | { kind: "provider_error"; message: string };

/**
 * Classifies one raw child run — a pure function of exit code/stdout/stderr,
 * so garbage-output and empty-response handling are pinned by tests over
 * fixtures rather than a live child. A child that produced no parseable
 * result at all is `bad_output` rather than any specific provider verdict:
 * not knowing why is a different fact from knowing the call failed, and
 * dressing it up as one would put an invented cause in front of the user.
 */
export function classifyRecognizerProbeOutput(raw: RecognizerProbeRawOutput): RecognizerProbeOutcome {
  if (raw.spawnError !== undefined) {
    return { kind: "spawn_failed", message: raw.spawnError };
  }
  if (raw.timedOut) {
    return { kind: "timeout" };
  }
  const payload = readRecognizerProbePayload(raw.stdout) as RecognizerProbeChildPayload | undefined;
  if (payload === undefined || typeof payload !== "object" || typeof payload.ok !== "boolean") {
    const detail = raw.stderr.trim() === "" ? `probe produced no result (exit ${String(raw.exitCode)})` : raw.stderr.trim();
    return { kind: "bad_output", message: detail };
  }
  if (payload.ok) {
    const text = typeof payload.text === "string" ? payload.text.trim() : "";
    return text === "" ? { kind: "empty_response" } : { kind: "success", text };
  }
  const error = typeof payload.error === "string" && payload.error !== "" ? payload.error : "the recognizer request failed";
  switch (payload.kind) {
    // `ask()`'s `classifyAbort` only ever returns "aborted" for a caller-supplied
    // signal this module never passes — the child's own signal is always
    // `AbortSignal.timeout()` — but the branch is kept for defensive symmetry
    // with `AskResult`'s real shape rather than assuming that can never drift.
    case "timeout":
    case "aborted":
      return { kind: "timeout" };
    case "empty":
      return { kind: "empty_response" };
    default:
      return { kind: "provider_error", message: error };
  }
}

/**
 * The recognizer probe's own secret-scrub — same split/join idiom
 * proxy-probe.ts's `maskProxyCredentials` uses (canon, TASK.141 §6), simpler
 * because there is no proxy-URL userinfo form to also catch here: a
 * recognizer endpoint carries a bare api key, never a credentialed URL.
 * `secret` is always THIS candidate's own freshly-resolved key, never a
 * caller-supplied value.
 */
function redactSecret(text: string, secret: string | undefined): string {
  return secret === undefined || secret === "" ? text : text.split(secret).join("***");
}

// ── the real spawner ──

/**
 * The real spawner. Kills the child at `timeoutMs` because — same measured
 * fact as proxy-probe.ts's own real spawner — a child whose OWN abort fired
 * is not guaranteed to have exited yet (a stalled socket keeps the event loop
 * alive), so "the child always exits by itself" cannot be assumed and a probe
 * without this kill would hang the IPC call forever.
 */
export const spawnRecognizerProbeChild: RecognizerProbeSpawner = (request) =>
  new Promise<RecognizerProbeRawOutput>((resolve) => {
    const child = spawnChild(request.execPath, [...request.args], {
      env: request.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: { timedOut: boolean; spawnError?: string; exitCode: number | null }): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, stdout, stderr });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ timedOut: true, exitCode: null });
    }, request.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", (error: Error) => {
      finish({ timedOut: false, spawnError: error.message, exitCode: null });
    });
    child.on("close", (code) => {
      finish({ timedOut: false, exitCode: code });
    });
    // A write to a child that has already exited (SIGKILL from the timer
    // above, an immediate crash, or a failed spawn racing this line) emits
    // EPIPE / ERR_STREAM_DESTROYED on the stdin stream — and an `error` event
    // with no listener THROWS, here in the main process, where it takes the
    // whole app down. Swallowing it is right rather than merely defensive:
    // the child's real outcome already arrives through `close`/`error` above,
    // which settle this promise; a failed stdin write adds no information the
    // caller does not already get. Same handler every other spawner in this
    // codebase installs for the same reason (claude-doctor.ts,
    // codex-doctor.ts, claude-client.ts, app-server-client.ts,
    // node-execution.ts).
    child.stdin?.on("error", () => {});
    child.stdin?.write(request.stdin, () => {
      child.stdin?.end();
    });
  });

// ── the IPC entry point (recognizer-probe-ipc.ts calls this and NOTHING else) ──

/**
 * Every dependency the probe needs, injected — same discipline as
 * network-ipc.ts's `NetworkIpcDeps`: the whole decision tree (including every
 * branch that must NOT spawn) is unit-testable without Electron, without a
 * vault and without a network. `recognizer-probe-ipc.ts` owns NONE of the
 * logic below — it only builds this bag from main's own state and forwards
 * `ipcMain.handle`'s raw payload into `handleRecognizerProbeRequest`.
 */
export interface RecognizerProbeDeps {
  /** The live settings document, or null before boot finished loading it. */
  readSettings: () => AnycodeSettings | null;
  getSecret: SecretReader;
  authKindFor?: (providerId: string) => "api_key" | "oauth" | undefined;
  catalogFor?: (providerId: string) => RecognizerCatalogInfo | undefined;
  /** `process.execPath`. `ELECTRON_RUN_AS_NODE=1` is added here, not by the caller. */
  execPath: string;
  /** Resolved path to the bundled `recognizer-probe-child` entry (main's own dev-vs-packaged path idiom, mirroring `resolveHostEntry`). */
  childEntry: string;
  /** The env the child runs with, BEFORE `ELECTRON_RUN_AS_NODE` is added — main's boot env snapshot, so the child inherits the same ambient proxy the host process itself would use. */
  env: NodeJS.ProcessEnv;
  spawn: RecognizerProbeSpawner;
  timeoutMs?: number;
}

/**
 * Validates the renderer payload at this trust boundary. Hand-rolled rather
 * than zod — same reasoning as network-ipc.ts's `parseProxyCheckRequest`: the
 * shape is two fields and importing a schema module here would buy nothing.
 */
function parseRecognizerProbeRequest(raw: unknown): RecognizerProbeRequest | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const candidate = raw as { connectionId?: unknown; modelId?: unknown };
  if (typeof candidate.connectionId !== "string" || candidate.connectionId === "") {
    return undefined;
  }
  if (typeof candidate.modelId !== "string" || candidate.modelId === "") {
    return undefined;
  }
  return { connectionId: candidate.connectionId, modelId: candidate.modelId };
}

/**
 * The whole probe, start to finish: parse the request, resolve the candidate
 * through the production ladder (no spawn on refusal), spawn the child,
 * classify its output, and scrub the resolved api key out of every text
 * before it leaves this function. Never throws — the outer try/catch is the
 * backstop for anything upstream of the spawner's own promise (a synchronous
 * throw out of `resolveRecognizerProbeCandidate`, for instance), since an IPC
 * handler that can reject would hand the renderer a provider's raw error
 * string with no chance to scrub it first.
 */
export async function handleRecognizerProbeRequest(deps: RecognizerProbeDeps, raw: unknown): Promise<RecognizerProbeResult> {
  let secret: string | undefined;
  try {
    const request = parseRecognizerProbeRequest(raw);
    if (request === undefined) {
      return { ok: false, reason: "not_configured", message: "malformed probe request" };
    }
    const settings = deps.readSettings();
    if (settings === null) {
      return { ok: false, reason: "not_configured", message: "settings have not finished loading yet" };
    }
    const endpoint = await resolveRecognizerProbeCandidate(
      settings,
      request,
      deps.getSecret,
      deps.authKindFor,
      deps.catalogFor,
    );
    if (endpoint === undefined) {
      return {
        ok: false,
        reason: "not_configured",
        message:
          "this connection/model does not resolve to a usable recognizer endpoint (missing connection, an OAuth connection, or no address configured)",
      };
    }
    secret = endpoint.apiKey;
    const timeoutMs = deps.timeoutMs ?? RECOGNIZER_PROBE_TIMEOUT_MS;
    const childInput: RecognizerProbeChildInput = {
      endpoint,
      image: { mediaType: RECOGNIZER_PROBE_IMAGE_MEDIA_TYPE, data: RECOGNIZER_PROBE_IMAGE_BASE64 },
      question: RECOGNIZER_PROBE_QUESTION,
      timeoutMs,
    };
    const output = await deps.spawn({
      execPath: deps.execPath,
      args: [deps.childEntry],
      env: { ...deps.env, ELECTRON_RUN_AS_NODE: "1" },
      stdin: JSON.stringify(childInput),
      timeoutMs: timeoutMs + RECOGNIZER_PROBE_KILL_GRACE_MS,
    });
    const outcome = classifyRecognizerProbeOutput(output);
    const mask = (text: string): string => redactSecret(text, secret);
    if (outcome.kind === "success") {
      return { ok: true, text: mask(outcome.text) };
    }
    if (outcome.kind === "empty_response") {
      return { ok: false, reason: "empty_response", message: "the recognizer returned an empty response" };
    }
    if (outcome.kind === "timeout") {
      return { ok: false, reason: "timeout", message: `no answer from the recognizer within ${String(timeoutMs)}ms` };
    }
    const reason: RecognizerProbeFailureReason = outcome.kind;
    return { ok: false, reason, message: mask(outcome.message) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: "spawn_failed", message: redactSecret(message, secret) };
  }
}
