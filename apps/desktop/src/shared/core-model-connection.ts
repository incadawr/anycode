/**
 * Taskana 4888: the pure policy behind `create_session {engine:"core", model}`
 * — which provider CONNECTION a requested model selects.
 *
 * The core engine has no `--engine-model`: its model and endpoint come from the
 * ONE pinned connection (`connectionId` -> `ANYCODE_MODEL`/`ANYCODE_BASE_URL`/
 * the key in that connection's env). Passing `model` to the core engine as an
 * "engine model" therefore did nothing; main silently opened the tab on the
 * ACTIVE connection instead. This resolver turns the requested value into a
 * connection (plus, when the request named a model inside that connection, the
 * model override to stamp over the connection's own default).
 *
 * Rules (frozen by the task): the value is matched EXACTLY against
 *  1. a connection `id`,
 *  2. a connection `label`,
 *  3. a model id the connection offers (`connection.model` or `models[]`),
 *  4. `<providerId>/<model>` — the connection whose `providerId` is the prefix,
 *     with the remainder as the model override (this is the one form that can
 *     name a model the connection has not listed yet).
 * Every match across all four forms is collected first. Exactly one connection
 * wins; zero or several are an EXPLICIT refusal (never a quiet fallback to the
 * active connection) whose text lists the candidates. Nothing here reads
 * `activeConnectionId`: with a `model` the request is always resolved by the
 * value alone, and without a `model` main never calls this function.
 *
 * Pure/synchronous and renderer-safe (types only), next to the other
 * value-only helpers in `shared/settings.ts`.
 */
import type { AnycodeSettings, ProviderConnection } from "./settings.js";

/** The settings slice the resolver reads; narrowed so tests and callers can pass a partial. */
export type CoreModelConnectionSettings = Pick<AnycodeSettings, "provider">;

/**
 * `ok` carries the winning connection and, when the request named a model id
 * inside it, `model` — the per-fork override main stamps as `ANYCODE_MODEL`
 * (absent when the request named the connection only, or named its own default).
 *
 * `!ok` carries the two refusal shapes (`unknown` = nothing matched,
 * `ambiguous` = several connections matched) and a ready-to-show `detail` that
 * lists the candidates — the Sessions API refusal text appends it verbatim.
 */
export type CoreModelConnectionResolution =
  | { ok: true; connectionId: string; model?: string }
  | { ok: false; reason: "unknown" | "ambiguous"; detail: string };

/** Model ids a connection advertises: its configured default first, then `models[]`, deduped. */
function offeredModels(connection: ProviderConnection): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of [connection.model, ...(connection.models ?? [])]) {
    if (typeof id !== "string") continue;
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** How many model ids one candidate descriptor lists before collapsing into `+N more`. */
const CANDIDATE_MODEL_LIMIT = 6;

/** One connection as it appears in a refusal: id, optional label, provider and (capped) models. */
function describeCandidate(connection: ProviderConnection): string {
  const provider = connection.providerId === "" ? "custom" : connection.providerId;
  const models = offeredModels(connection);
  const shown = models.slice(0, CANDIDATE_MODEL_LIMIT);
  const rest = models.length - shown.length;
  const modelText = shown.length === 0 ? "" : `: ${shown.join(", ")}${rest > 0 ? `, +${rest} more` : ""}`;
  const label = connection.label === undefined || connection.label === "" ? "" : ` "${connection.label}"`;
  return `${connection.id}${label} (${provider}${modelText})`;
}

export function resolveCoreConnectionForModel(
  settings: CoreModelConnectionSettings,
  raw: string,
): CoreModelConnectionResolution {
  const value = raw.trim();
  const connections = settings.provider.connections;
  const matched = new Map<string, { connection: ProviderConnection; model?: string }>();
  const add = (connection: ProviderConnection, model?: string): void => {
    const existing = matched.get(connection.id);
    if (existing === undefined) {
      matched.set(connection.id, { connection, ...(model !== undefined ? { model } : {}) });
    } else if (existing.model === undefined && model !== undefined) {
      // A connection-level selector and a model selector both hit the same
      // connection: the model id is what the request actually asked to run.
      existing.model = model;
    }
  };

  if (value !== "") {
    // `<providerId>/<model>` is parsed at the FIRST slash: provider ids never
    // contain one (builtin ids, the bare "" sentinel, `custom:<slug>`), while
    // model ids may (vendor/name).
    const slash = value.indexOf("/");
    const providerPrefix = slash > 0 ? value.slice(0, slash) : "";
    const providerModel = slash > 0 ? value.slice(slash + 1) : "";
    for (const connection of connections) {
      if (connection.id === value) add(connection);
      if (connection.label !== undefined && connection.label !== "" && connection.label === value) add(connection);
      if (offeredModels(connection).includes(value)) add(connection, value);
      if (providerPrefix !== "" && providerModel !== "" && connection.providerId === providerPrefix) {
        add(connection, providerModel);
      }
    }
  }

  if (matched.size === 1) {
    const [only] = [...matched.values()];
    const connection = only!.connection;
    // The connection's own default needs no override: stamping an identical
    // ANYCODE_MODEL would change nothing and hide the "no override" case.
    const model = only!.model === undefined || only!.model === connection.model ? undefined : only!.model;
    return { ok: true, connectionId: connection.id, ...(model !== undefined ? { model } : {}) };
  }

  if (matched.size > 1) {
    const candidates = [...matched.values()].map((entry) => describeCandidate(entry.connection));
    return {
      ok: false,
      reason: "ambiguous",
      detail: `"${value}" matches more than one connection: ${candidates.join("; ")}`,
    };
  }

  const candidates = connections.map(describeCandidate);
  return {
    ok: false,
    reason: "unknown",
    detail:
      candidates.length === 0
        ? `no provider connections are configured, so "${value}" cannot be resolved`
        : `no connection offers "${value}"; connections: ${candidates.join("; ")}`,
  };
}
