/**
 * Child-env proxy sanitisation (TASK.135 / Taskana 4074).
 *
 * Non-engine children (Bash tool + background tasks + hooks via `run`,
 * rg/git plumbing via `runBinary`, LSP servers via `spawnPersistent`, and the
 * desktop PTY terminal) get their env from THIS module instead of a raw
 * `{...process.env, ...request.env}`: a proxy URL that carries credentials
 * (`user:pass@`) is DROPPED, never rewritten to a credential-less URL — behind
 * an authenticating proxy such a child simply connects the way it would
 * without the variable, rather than silently re-routing or leaking the
 * password to anything the agent asks to run `env`. Engine children (claude/
 * codex CLIs) and the host's own model traffic are deliberately NOT scrubbed:
 * they read the live `process.env` through their own builders
 * (`buildClaudeChildEnv`/`buildCodexChildEnv`, `sourceEnv: process.env`), and
 * core's own provider port needs the env proxy (`NODE_USE_ENV_PROXY=1`).
 * That is why the scrub lives here, in the child-env builder — the single
 * choke point every non-engine spawn passes through — and never mutates any
 * `process.env`.
 *
 * RELAY FOLLOW-UP (Taskana 4074): dropping the vars closed the leak but broke
 * npm/git/curl behind an authenticating proxy. When the host runs the
 * credential-free loopback relay (`proxy-relay.ts`, `resolveProxyRelay`),
 * `buildChildEnv`'s optional THIRD argument replaces the dropped values with
 * `http://127.0.0.1:<port>`: children regain the network, still see no
 * credential, and the `ANYCODE_*_PROXY_URL` carriers stay removed. Callers
 * that have not resolved a relay pass nothing and keep the plain drop.
 * Taskana 4685: that relay URL embeds a per-process random token as a PATH
 * SEGMENT (`http://127.0.0.1:<port>/<token>`); pass it through verbatim —
 * the token is the relay's cross-user auth boundary and contains no `@`, so
 * `proxyValueHasUserinfo` never trips on it.
 *
 * Why a literal-`@` rule and not `maskProxyCredentials` (main/proxy-probe.ts):
 * that regex needs `//` and `:` separators, so it misses user-only
 * `http://TOKEN@proxy`, scheme-less `user:pass@proxy:3128` and `http:/u:p@h`.
 * A value is credentialed iff it contains a literal `@` — inside legal
 * userinfo an `@` is always percent-encoded (`%40`), so this is exact, and
 * origin-agnostic: a credentialed proxy exported by the user's shell is
 * dropped just the same.
 */

const PROXY_NAME_RE = /^(?:.*_)?proxy$/i;
const NO_PROXY_NAME_RE = /^no_proxy$/i;
const CARRIER_NAME_RE = /^ANYCODE_[A-Z0-9_]*_PROXY_URL$/;

/** True for any proxy-family name in any case (`HTTP_PROXY`, `https_proxy`, `ALL_PROXY`, `npm_config_proxy`, …). `no_proxy` is NOT proxy-carrying and never matches. */
export function isProxyVarName(name: string): boolean {
  return PROXY_NAME_RE.test(name) && !NO_PROXY_NAME_RE.test(name);
}

/** True for the internal engine proxy carriers (`ANYCODE_CLAUDE_PROXY_URL`, `ANYCODE_CODEX_PROXY_URL`) — always dropped from non-engine children whatever the value. */
export function isEngineProxyCarrierName(name: string): boolean {
  return CARRIER_NAME_RE.test(name);
}

/** True when the value carries userinfo credentials: a literal `@` (a legal one inside userinfo is percent-encoded). */
export function proxyValueHasUserinfo(value: string): boolean {
  return value.includes("@");
}

/**
 * Returns a SANITISED COPY of `env`: every proxy-family variable whose value
 * contains a literal `@` is dropped (credential-less proxies and both
 * `NO_PROXY` spellings pass through verbatim, as does everything else), and so
 * is every `ANYCODE_*_PROXY_URL` engine carrier regardless of value. Never
 * mutates `env`; exact names only, no case normalisation.
 *
 * `relayUrl` (TASK.135 follow-up): when the host runs a credential-free
 * loopback relay, the dropped credentialed variables are REPLACED by it
 * instead of vanishing — npm/git/curl keep working behind the authenticating
 * proxy while the child still sees no credential. The relay URL is written
 * into a four-case HTTP(S)_PROXY name ONLY where the scrub actually removed
 * (or never had) a value: a CLEAN member the user deliberately configured is
 * a routing instruction that must survive VERBATIM, not be re-pointed at the
 * relay of a different upstream (cross-review F3 — the old family-atomic
 * write silently re-routed the user's clean HTTP proxy through the
 * credentialed corporate one). The four-case write is still per-name: both
 * spellings of a dropped name are set so consumers that disagree on case
 * still agree on the relay. `NO_PROXY` keeps whatever the merged env already
 * carried (a relay URL is loopback; if the host exempted loopback that stays
 * correct, and if it did not the child must reach the relay THROUGH the env
 * proxy var itself, so no rewriting either way), and the
 * `ANYCODE_*_PROXY_URL` carriers are STILL removed — the relay replaces the
 * value, never the carrier machinery.
 */
export function sanitizeChildEnv(env: NodeJS.ProcessEnv, relayUrl?: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  /** The four-case HTTP(S)_PROXY names the scrub actually removed (cross-review F3). */
  const droppedNames = new Set<string>();
  /** True when ANY credentialed proxy-family member was dropped, four-name or not (cross-review F4). */
  let droppedAny = false;
  for (const [name, value] of Object.entries(env)) {
    if (isEngineProxyCarrierName(name)) {
      continue;
    }
    if (typeof value === "string" && isProxyVarName(name) && proxyValueHasUserinfo(value)) {
      droppedAny = true;
      if (name === "HTTPS_PROXY" || name === "https_proxy" || name === "HTTP_PROXY" || name === "http_proxy") {
        droppedNames.add(name);
      }
      continue;
    }
    out[name] = value;
  }
  if (relayUrl !== undefined && droppedAny) {
    // Per protocol pair: an ABSENT spelling is filled only when its case
    // sibling did not survive clean — otherwise `HTTP_PROXY=clean` +
    // relay-filled `http_proxy` re-routes every lowercase-preferring consumer
    // (curl reads only `http_proxy`; Python's urllib lets lowercase win)
    // through the credentialed upstream, the very F3 clobber one spelling over.
    for (const [upper, lower] of [["HTTPS_PROXY", "https_proxy"], ["HTTP_PROXY", "http_proxy"]] as const) {
      // Dropped names never reached `out`, so presence here means clean.
      const cleanSibling = upper in out || lower in out;
      for (const name of [upper, lower]) {
        if (droppedNames.has(name) || (!(name in out) && !cleanSibling)) {
          out[name] = relayUrl;
        }
      }
    }
  }
  return out;
}

/**
 * Merges `overlay` over a sanitised copy of `base` and sanitises the RESULT
 * (D6: a credentialed proxy in `request.env` is dropped too; a credential-less
 * one overrides the base and is kept; `undefined`-valued keys — node-git uses
 * them to unset — are preserved as-is). Returns a NEW object; neither input is
 * mutated.
 *
 * `relayUrl` (TASK.135 follow-up): the credential-free loopback relay URL
 * (`http://127.0.0.1:<port>`, from `resolveProxyRelay`). When set AND the
 * merge actually dropped a credentialed proxy value, the four-case
 * HTTP(S)_PROXY family is rewritten to the relay URL — see
 * `sanitizeChildEnv`. Without a relay (or when nothing was dropped) the
 * behaviour is byte-identical to the TASK.135 scrub.
 */
export function buildChildEnv(
  base: NodeJS.ProcessEnv,
  overlay?: Record<string, string | undefined>,
  relayUrl?: string,
): NodeJS.ProcessEnv {
  return sanitizeChildEnv(overlay === undefined ? { ...base } : { ...base, ...overlay }, relayUrl);
}
