/**
 * The proxy spawn-probe (TASK.141 §6): "does this profile actually carry traffic
 * to this target?", answered the only way it can be answered honestly — by
 * SPAWNING a child with the profile's materialised env and letting it make one
 * real request.
 *
 * Main cannot answer it with its own `fetch`. `NODE_USE_ENV_PROXY` is read once
 * at bootstrap (measured, TASK.132), so main's global fetch ignores every proxy
 * env assigned afterwards: a probe done in-process would go straight out, get a
 * 401 from the provider, and report a dead proxy as healthy. The child is
 * `process.execPath` with `ELECTRON_RUN_AS_NODE=1` — the same runtime, the same
 * undici, the same env composition path a real spawn uses.
 *
 * What the probe does NOT claim (design review B-11): equivalence with a
 * production spawn. A real spawn ends in the native Codex or Claude CLI, each
 * with its own allow-list and CA handling; this is a Node `fetch`. The narrower
 * guarantee it does make is the one worth having — same materialisation, one
 * named target, and `proxyUsed` reported honestly so a green request that never
 * touched the proxy can never be read as "the proxy works".
 *
 * ── Live measurement (2026-08-22) ──
 *
 * Every error shape below was MEASURED, not guessed, on this repo's runtime —
 * Electron 43.0.0 / Node 24.17.0 / undici 7.28.0 — against local stub proxies,
 * because a guessed error string is the exact class of defect this track has
 * already shipped twice: a green gate resting on behaviour nobody observed. The
 * strings are pinned as `MEASURED_*` fixtures below and the unit tests classify
 * those literals.
 */

import { spawn as spawnChild } from "node:child_process";
import type { ProxyCheckVerdict } from "../shared/proxy.js";

/** Marks the child's one result line on stdout. Anything else the runtime prints is ignored. */
export const PROXY_PROBE_MARKER = "##anycode-proxy-probe##";

/** Default budget for the whole probe: one request, ~10 s, zero retries (TASK.141 §6). */
export const PROXY_PROBE_TIMEOUT_MS = 10_000;

/**
 * Extra grace the PARENT waits before killing the child, on top of the child's
 * own abort budget.
 *
 * Not defensive padding — a MEASURED necessity. With a proxy that accepts the
 * CONNECT and then stalls, the child's `AbortController` fires on time and the
 * result is printed, but the process does NOT exit: the aborted socket keeps the
 * event loop alive. The child therefore exits explicitly after writing its line,
 * and the parent kills anything still standing after the grace.
 */
export const PROXY_PROBE_KILL_GRACE_MS = 2_000;

/**
 * The child program, passed to `electron -e`.
 *
 * Contract: exactly one line on stdout, `PROXY_PROBE_MARKER` + JSON, then an
 * explicit exit. `process.exit` is called from the write CALLBACK because stdout
 * to a pipe is asynchronous on POSIX and exiting before the flush would truncate
 * the only output the classifier has.
 *
 * `redirect: "manual"` keeps a redirect from turning into a second request to a
 * host the user never named — the probe is one request by definition.
 */
export const PROXY_PROBE_SCRIPT = [
  'const marker = "##anycode-proxy-probe##";',
  "const target = process.argv[1];",
  "const timeoutMs = Number(process.argv[2]) || 10000;",
  "const controller = new AbortController();",
  "const timer = setTimeout(() => controller.abort(), timeoutMs);",
  "function chain(err) {",
  "  const out = [];",
  "  let cur = err;",
  "  for (let depth = 0; cur !== undefined && cur !== null && depth < 8; depth += 1) {",
  "    out.push({",
  '      name: typeof cur.name === "string" ? cur.name : undefined,',
  '      message: typeof cur.message === "string" ? cur.message : String(cur),',
  "      code: cur.code === undefined || cur.code === null ? undefined : String(cur.code),",
  "    });",
  "    cur = cur.cause;",
  "  }",
  "  return out;",
  "}",
  "function emit(payload) {",
  '  process.stdout.write(marker + JSON.stringify(payload) + "\\n", () => process.exit(0));',
  "}",
  'fetch(target, { signal: controller.signal, redirect: "manual" }).then(',
  "  (res) => { clearTimeout(timer); emit({ ok: true, status: res.status }); },",
  "  (err) => { clearTimeout(timer); emit({ ok: false, aborted: controller.signal.aborted, chain: chain(err) }); },",
  ");",
].join("\n");

// ── measured error shapes (2026-08-22, Electron 43.0.0 / node 24.17.0 / undici 7.28.0) ──

/**
 * Dead proxy — nothing listening on the proxy port.
 * Measured against `http://127.0.0.1:9`.
 */
export const MEASURED_PROXY_DEAD = {
  ok: false,
  aborted: false,
  chain: [
    { name: "TypeError", message: "fetch failed" },
    { name: "Error", message: "connect ECONNREFUSED 127.0.0.1:9", code: "ECONNREFUSED" },
  ],
} as const;

/**
 * 407 Proxy Authentication Required.
 *
 * The shape is NOT a 407 HTTP response: undici tunnels through the proxy with
 * CONNECT and turns a non-200 tunnel answer into an ABORT, three levels deep.
 * The status only survives inside the message text, which is why the classifier
 * parses that sentence rather than reading a status field.
 *
 * Measured against a local stub answering every CONNECT with
 * `HTTP/1.1 407 Proxy Authentication Required`. Measured a second time with a
 * PLAIN `http://` target: identical shape — undici's env proxying tunnels
 * regardless of the target scheme, so there is no separate non-tunnel 407 path
 * to classify.
 */
export const MEASURED_PROXY_407 = {
  ok: false,
  aborted: false,
  chain: [
    { name: "TypeError", message: "fetch failed" },
    { name: "Error", message: "Request was cancelled.", code: "0" },
    {
      name: "AbortError",
      message: "Proxy response (407) !== 200 when HTTP Tunneling",
      code: "UND_ERR_ABORTED",
    },
  ],
} as const;

/**
 * MITM TLS interception, self-signed leaf — the shape a naive interception proxy
 * produces. Measured against a stub that answers CONNECT with 200 and then
 * terminates TLS itself with a self-signed certificate for the target host.
 */
export const MEASURED_TLS_SELF_SIGNED = {
  ok: false,
  aborted: false,
  chain: [
    { name: "TypeError", message: "fetch failed" },
    {
      name: "Error",
      message: "self signed certificate; if the root CA is installed locally, try running Node.js with --use-system-ca",
      code: "DEPTH_ZERO_SELF_SIGNED_CERT",
    },
  ],
} as const;

/**
 * MITM TLS interception, corporate CA — the shape a real appliance produces: a
 * leaf signed by a private root the child does not trust. Measured against a
 * stub presenting a leaf + self-signed CA chain. The CODE differs from the
 * self-signed case, which is why the classifier matches the certificate FAMILY
 * rather than a single code.
 */
export const MEASURED_TLS_CORPORATE_CA = {
  ok: false,
  aborted: false,
  chain: [
    { name: "TypeError", message: "fetch failed" },
    { name: "Error", message: "self signed certificate in certificate chain", code: "SELF_SIGNED_CERT_IN_CHAIN" },
  ],
} as const;

/** Proxy accepted the TCP connection and destroyed it mid-CONNECT. Measured against a stub that calls `socket.destroy()`. */
export const MEASURED_PROXY_RESET = {
  ok: false,
  aborted: false,
  chain: [
    { name: "TypeError", message: "fetch failed" },
    { name: "Error", message: "read ECONNRESET", code: "ECONNRESET" },
  ],
} as const;

/** No proxy in play, target host does not resolve. Measured direct against `https://target.invalid/`. */
export const MEASURED_TARGET_DNS = {
  ok: false,
  aborted: false,
  chain: [
    { name: "TypeError", message: "fetch failed" },
    { name: "Error", message: "getaddrinfo ENOTFOUND target.invalid", code: "ENOTFOUND" },
  ],
} as const;

/**
 * Proxy alive, target never answers — the abort fires. Measured through a live
 * forwarding proxy against an unresolvable host: the proxy accepted the CONNECT
 * and then hung, and the child's own `AbortController` produced this. Note the
 * TOP-level error is the DOMException, with no `fetch failed` wrapper.
 */
export const MEASURED_TIMEOUT = {
  ok: false,
  aborted: true,
  chain: [{ name: "AbortError", message: "This operation was aborted", code: "20" }],
} as const;

/** Target answered through a live proxy. Measured through a local CONNECT-logging forwarder to `https://api.anthropic.com/v1/models`. */
export const MEASURED_OK_401 = { ok: true, status: 401 } as const;

// ── classification (pure) ──

export interface ProxyProbeRawOutput {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/**
 * What the child's one request actually hit. Deliberately finer-grained than
 * `ProxyCheckVerdict`: the same TCP failure means "the proxy is dead" when a
 * proxy is in play and "the target is dead" when one is not, and that decision
 * needs a fact the child does not have. `probeVerdict` makes it.
 */
export type ProbeClassification =
  | { kind: "http_response"; status: number }
  | { kind: "proxy_auth"; status: number }
  | { kind: "proxy_tunnel_rejected"; status: number }
  | { kind: "tls"; code: string; message: string }
  | { kind: "connect_refused"; message: string }
  | { kind: "connect_reset"; message: string }
  | { kind: "dns"; message: string }
  | { kind: "timeout" }
  | { kind: "unknown"; message: string };

/** `Proxy response (407) !== 200 when HTTP Tunneling` — the only place the tunnel status survives (measured). */
const TUNNEL_STATUS_RE = /Proxy response \((\d{3})\)\s*!==\s*200/;

/** Codes that mean "the TLS handshake was not trusted", covering both measured MITM shapes and their siblings. */
function isTlsCode(code: string | undefined, message: string): boolean {
  if (code !== undefined && (code.includes("CERT") || code.startsWith("ERR_TLS") || code.startsWith("ERR_SSL"))) {
    return true;
  }
  return /certificate|ssl|tls handshake/i.test(message) && !/proxy response/i.test(message);
}

interface ProbeChainEntry {
  name?: string;
  message?: string;
  code?: string;
}

interface ProbePayload {
  ok?: boolean;
  status?: number;
  aborted?: boolean;
  chain?: ProbeChainEntry[];
}

/**
 * Extracts the child's result line from raw stdout, or undefined when there is
 * none. The LAST marker line wins: the Electron runtime is entitled to print
 * warnings, and only the child writes this prefix.
 */
export function readProbePayload(stdout: string): unknown {
  let found: string | undefined;
  for (const line of stdout.split("\n")) {
    const at = line.indexOf(PROXY_PROBE_MARKER);
    if (at !== -1) {
      found = line.slice(at + PROXY_PROBE_MARKER.length).trim();
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

/**
 * Classifies ONE probe run from its raw output — a pure function of exit code,
 * stdout and stderr, so every branch is pinned by a test over the measured
 * fixtures above instead of by a live network.
 *
 * A child that produced no result line at all is `unknown` rather than any
 * network verdict: not knowing is a different fact from a failed request, and
 * dressing it up as one would put an invented cause in front of the user.
 */
export function classifyProbeOutput(raw: ProxyProbeRawOutput): ProbeClassification {
  const payload = readProbePayload(raw.stdout) as ProbePayload | undefined;
  if (payload === undefined || typeof payload !== "object") {
    const detail = raw.stderr.trim() === "" ? `probe produced no result (exit ${String(raw.exitCode)})` : raw.stderr.trim();
    return { kind: "unknown", message: detail };
  }
  if (payload.ok === true && typeof payload.status === "number") {
    // A 407 arriving as an ordinary HTTP status cannot happen on the measured
    // runtime (undici tunnels every target, so a 407 comes back as the abort
    // below), but a proxy that answers a non-tunneled request would produce one
    // and it is unambiguously a proxy-auth failure, never a target answer.
    return payload.status === 407 ? { kind: "proxy_auth", status: 407 } : { kind: "http_response", status: payload.status };
  }
  const chain = Array.isArray(payload.chain) ? payload.chain : [];
  for (const entry of chain) {
    const message = typeof entry.message === "string" ? entry.message : "";
    const code = typeof entry.code === "string" ? entry.code : undefined;
    const tunnel = TUNNEL_STATUS_RE.exec(message);
    if (tunnel !== null) {
      const status = Number(tunnel[1]);
      return status === 407 ? { kind: "proxy_auth", status } : { kind: "proxy_tunnel_rejected", status };
    }
    if (isTlsCode(code, message)) {
      return { kind: "tls", code: code ?? "", message };
    }
    if (code === "ECONNREFUSED") {
      return { kind: "connect_refused", message };
    }
    if (code === "ECONNRESET" || code === "UND_ERR_SOCKET" || /socket hang up/i.test(message)) {
      return { kind: "connect_reset", message };
    }
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
      return { kind: "dns", message };
    }
    if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT" || code === "UND_ERR_HEADERS_TIMEOUT") {
      return { kind: "timeout" };
    }
  }
  if (payload.aborted === true || chain.some((entry) => entry.name === "AbortError")) {
    return { kind: "timeout" };
  }
  const first = chain.find((entry) => typeof entry.message === "string" && entry.message !== "");
  return { kind: "unknown", message: first?.message ?? `probe failed (exit ${String(raw.exitCode)})` };
}

/**
 * Maps a classification to the frozen verdict enum, given the one fact the child
 * cannot know: whether a proxy was in play at all.
 *
 * `proxyUsed` is what makes the same TCP error two different answers. With a
 * proxy configured, the child's socket goes to the PROXY, so a refusal, a reset
 * or a DNS failure is about the proxy host — the target's name is never resolved
 * locally. Without one, every such failure is about the target.
 *
 * A timeout is `target_unreachable` in both cases and that is the measured
 * truth, not a shrug: the abort only fires after a connection was ESTABLISHED
 * (a dead proxy refuses in milliseconds), so the thing that failed to answer is
 * whatever sits at the far end.
 */
export function probeVerdict(classification: ProbeClassification, context: { proxyUsed: boolean }): ProxyCheckVerdict {
  switch (classification.kind) {
    case "http_response":
      return "ok";
    case "proxy_auth":
      return "proxy_auth";
    case "tls":
      return "tls";
    case "proxy_tunnel_rejected":
      return "proxy_unreachable";
    case "connect_refused":
    case "connect_reset":
    case "dns":
      return context.proxyUsed ? "proxy_unreachable" : "target_unreachable";
    case "timeout":
      return "target_unreachable";
    case "unknown":
      // No verdict means "we do not know", so this lands on the least specific
      // arm the frozen enum has, and the raw message rides `detail` unmasked of
      // nothing but the credentials.
      return "target_unreachable";
  }
}

// ── credential masking ──

/** `//user:pass@host` in ANY text (not just a parseable URL) → `//user:***@host`. */
const USERINFO_RE = /(\/\/)([^/\s:@]+):([^/\s@]*)@/g;

/**
 * Redacts every credential that could appear in a text the renderer will see.
 *
 * Two independent passes, because either alone leaks: the regex catches
 * `//user:pass@host` wherever it is embedded (an error message, a stack line) —
 * including forms `new URL` cannot parse, which is precisely when a password is
 * most likely to be sitting in raw text — and the literal pass catches a
 * password that reached the output WITHOUT its URL around it (a proxy that
 * echoes a header, a runtime that prints the value alone).
 */
export function maskProxyCredentials(text: string, secrets: readonly string[] = []): string {
  let out = text.replace(USERINFO_RE, "$1$2:***@");
  for (const secret of secrets) {
    if (secret !== "") {
      out = out.split(secret).join("***");
    }
  }
  return out;
}

/** One-line human description of a classification, credentials already masked. */
export function describeClassification(classification: ProbeClassification, secrets: readonly string[] = []): string {
  const mask = (text: string): string => maskProxyCredentials(text, secrets);
  switch (classification.kind) {
    case "http_response":
      return `target answered HTTP ${String(classification.status)}`;
    case "proxy_auth":
      return `proxy refused the tunnel with ${String(classification.status)} Proxy Authentication Required`;
    case "proxy_tunnel_rejected":
      return `proxy refused the tunnel with HTTP ${String(classification.status)}`;
    case "tls":
      return `TLS verification failed (${mask(classification.code === "" ? classification.message : classification.code)})`;
    case "connect_refused":
      return `connection refused (${mask(classification.message)})`;
    case "connect_reset":
      return `connection reset (${mask(classification.message)})`;
    case "dns":
      return `host did not resolve (${mask(classification.message)})`;
    case "timeout":
      return "no answer before the probe timed out";
    case "unknown":
      return mask(classification.message);
  }
}

// ── the spawn ──

export interface ProxyProbeSpawnRequest {
  execPath: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  /** Hard wall-clock budget for the child, INCLUDING the kill grace. */
  timeoutMs: number;
}

/** Runs one probe child. Injected so the handler's tests never spawn anything. */
export type ProxyProbeSpawner = (request: ProxyProbeSpawnRequest) => Promise<ProxyProbeRawOutput>;

export interface ProxyProbeInput {
  targetUrl: string;
  /** The FULL env the child runs with — composed by the caller down the same path a real spawn takes. */
  env: NodeJS.ProcessEnv;
  /** `process.execPath`; with `ELECTRON_RUN_AS_NODE=1` (added here) this is a plain node runtime. */
  execPath: string;
  /** Whether the request actually went through a proxy — decided by the caller, never guessed here. */
  proxyUsed: boolean;
  timeoutMs?: number;
  /** Plaintext values that must never appear in the emitted text (the profile password). */
  secrets?: readonly string[];
}

export interface ProxyProbeOutcome {
  verdict: ProxyCheckVerdict;
  /** Display text, credentials already masked. */
  detail: string;
  classification: ProbeClassification;
}

/**
 * Runs the probe once. ONE spawn, one request, zero retries — a retry would turn
 * a "dead proxy" answer into a multi-second wait and would be the beginning of
 * the retry storm TASK.134 exists to fix, not a kindness.
 *
 * `ELECTRON_RUN_AS_NODE=1` is forced here rather than expected from the caller:
 * without it `process.execPath` boots a full Electron app, which would open a
 * window and never answer.
 */
export async function runProxyProbe(spawner: ProxyProbeSpawner, input: ProxyProbeInput): Promise<ProxyProbeOutcome> {
  const timeoutMs = input.timeoutMs ?? PROXY_PROBE_TIMEOUT_MS;
  const raw = await spawner({
    execPath: input.execPath,
    args: ["-e", PROXY_PROBE_SCRIPT, input.targetUrl, String(timeoutMs)],
    env: { ...input.env, ELECTRON_RUN_AS_NODE: "1" },
    timeoutMs: timeoutMs + PROXY_PROBE_KILL_GRACE_MS,
  });
  const classification = classifyProbeOutput(raw);
  return {
    verdict: probeVerdict(classification, { proxyUsed: input.proxyUsed }),
    detail: describeClassification(classification, input.secrets ?? []),
    classification,
  };
}

/**
 * The real spawner. Kills the child at `timeoutMs` because a probe child is
 * MEASURED to outlive its own abort: an aborted socket keeps the event loop
 * alive, so "the child always exits by itself" is false and a probe without this
 * kill would hang the IPC call forever.
 */
export const spawnProxyProbe: ProxyProbeSpawner = (request) =>
  new Promise<ProxyProbeRawOutput>((resolve) => {
    const child = spawnChild(request.execPath, [...request.args], {
      env: request.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (exitCode: number | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, request.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", (error: Error) => {
      stderr += `${stderr === "" ? "" : "\n"}${error.message}`;
      finish(null);
    });
    child.on("close", (code) => {
      finish(code);
    });
  });
