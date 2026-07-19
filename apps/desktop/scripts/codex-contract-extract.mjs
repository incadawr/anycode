#!/usr/bin/env node
/**
 * Extract + canonicalize the CONSUMED subset of the Codex app-server JSON
 * schema into a small, diff-able pinned contract (design/slice-codex-fixes-cut.md
 * §2(h)). Reused by BOTH (1) the one-off regeneration that produced the
 * committed apps/desktop/src/host/engines/codex/contract/pinned-contract.json,
 * and (2) contract-drift.test.ts's env-gated layer-2 (`ANYCODE_CODEX_DRIFT_BIN`):
 * running `codex app-server generate-json-schema --out <tmp>` and then this
 * same extractor must reproduce the pinned file byte-for-byte, or the live
 * binary has drifted from what AnyCode's Codex adapter was built against.
 *
 * Usage:
 *   node codex-contract-extract.mjs <schemaDir> [outFile]
 *
 * <schemaDir> is whatever `codex app-server generate-json-schema --out <dir>`
 * produced; this script reads exactly one file from it:
 *   <schemaDir>/codex_app_server_protocol.schemas.json
 * (the merged schema that command also writes — every per-type file in that
 * same directory is a strict subset of it, so this is the one file this
 * extractor needs). Canonicalization = recursive key-sort of the WHOLE output
 * (cut §1: "JSON-schema отличается только порядком ключей ⇒ drift-гейт обязан
 * канонизировать сортировкой ключей"), so two schema dumps that differ only in
 * property insertion order extract to byte-identical output.
 *
 * With no <outFile>, the canonical JSON is written to stdout.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The consumed vocabulary (design cut §2(h)/§3.1-3.8): every method/type
 * AnyCode's Codex adapter actually speaks. The METHOD NAMES and RESULT refs
 * below are a deliberate, reviewed act — NOT something the extractor infers
 * from the schema on its own; the cut's own minor-strategy note (§2(h)) is
 * that widening it requires a regen+extract+review of the diff in ONE commit.
 *
 * Deliberately absent: a hardcoded `paramsRef`. A JSON-RPC schema has no
 * per-method link from a method name to its RESULT type (`JSONRPCResponse`'s
 * `result` is untyped `true` — every codebase pairing method->response is a
 * maintained convention, not something the wire format encodes), so
 * `resultRef` stays declared here. The PARAMS type, however, genuinely IS
 * encoded, in the `ClientRequest`/`ServerRequest`/`ServerNotification`
 * discriminated-union registries the live schema ships (each variant carries
 * both `properties.method.enum[0]` and `properties.params.$ref`) — so
 * `resolveMethodParamsRef` below looks it up from THOSE registries by
 * matching on the method name, instead of trusting a second hardcoded ref
 * string. This is load-bearing: a CLI that renames `turn/start` while leaving
 * `TurnStartParams`'s shape untouched must make this extractor throw (its
 * variant search finds no method named `turn/start` left in the union), not
 * silently keep resolving the old params type by name and emit a byte-identical
 * pinned contract.
 */
const CLIENT_REQUEST_METHODS = [
  { method: "initialize", resultRef: "InitializeResponse" },
  { method: "account/read", resultRef: "v2/GetAccountResponse" },
  { method: "model/list", resultRef: "v2/ModelListResponse" },
  { method: "thread/start", resultRef: "v2/ThreadStartResponse" },
  { method: "thread/resume", resultRef: "v2/ThreadResumeResponse" },
  { method: "thread/read", resultRef: "v2/ThreadReadResponse" },
  { method: "turn/start", resultRef: "v2/TurnStartResponse" },
  { method: "turn/interrupt", resultRef: "v2/TurnInterruptResponse" },
  { method: "account/login/start", resultRef: "v2/LoginAccountResponse" },
  { method: "account/login/cancel", resultRef: "v2/CancelLoginAccountResponse" },
  { method: "account/logout", resultRef: "v2/LogoutAccountResponse" },
  // codex-profiles cut §1.1/§8.4, amended §A6: consumed IMMEDIATELY (doctor +
  // host, cut §6.1) so it is pinned, not just observed as benign. Called
  // WITHOUT a `params` key on the wire (amended §A3.7) — `resolveMethodParamsRef`
  // returns `null` for a `{type:"null"}` params schema, exactly like this one.
  { method: "account/rateLimits/read", resultRef: "v2/GetAccountRateLimitsResponse" },
  // Not consumed by this track (F19-residual, cut §11) — pinned PROACTIVELY
  // per amended §A6.1: verified live (W0-R1), named next consumer exists
  // (F19), and a silent rename would erode that consumer's premise
  // unnoticed. Also called WITHOUT a `params` key (amended §A3.7).
  { method: "account/usage/read", resultRef: "v2/GetAccountTokenUsageResponse" },
];

/** Both approval families (cut §1.1): command-execution AND file-change. `paramsRef` derived, same rationale as CLIENT_REQUEST_METHODS above. */
const SERVER_REQUEST_METHODS = [
  { method: "item/commandExecution/requestApproval", resultRef: "CommandExecutionRequestApprovalResponse" },
  { method: "item/fileChange/requestApproval", resultRef: "FileChangeRequestApprovalResponse" },
];

/** Notification families the translator/pre-turn buffer/doctor observe or must not mis-count (cut §1.6/§2(i)). `paramsRef` derived from the `ServerNotification` registry, same rationale as the request tables above — this is the MOST safety-critical of the three (a renamed `turn/completed` or `error` notification silently stops reaching TurnTranslator, with no wire-level error). */
const SERVER_NOTIFICATION_METHODS = [
  { method: "error" },
  { method: "item/started" },
  { method: "item/completed" },
  { method: "item/agentMessage/delta" },
  { method: "thread/tokenUsage/updated" },
  { method: "turn/completed" },
  // Codex's own todo list (the `update_plan` tool's effect). Turn-scoped, not
  // a thread item — the translator projects each revision into a synthetic
  // settled `TodoWrite` card so the renderer's TodoPanel reads it unchanged.
  { method: "turn/plan/updated" },
  { method: "thread/settings/updated" },
  { method: "account/login/completed" },
  { method: "account/updated" },
  { method: "account/rateLimits/updated" },
  // Amended §A6.2/§A3.8: server emits this AROUND initialize (pre-handshake)
  // — clients drop ANY pre-init notification silently, and this one is also
  // added to the pre-turn benign list so it never counts toward
  // PRE_TURN_NOTIFICATION_LIMIT.
  { method: "remoteControl/status/changed" },
];

/** Standalone defs pulled in beyond what the method table's BFS already reaches: the error shape and the turn-status enum (cut §2(h) layer-1: "error/turn-status/notification-families"). */
const EXTRA_ROOT_REFS = ["JSONRPCError", "JSONRPCErrorError", "v2/TurnStatus"];

/** Decision unions (cut §1.1) — recorded as their OWN section (`decisionEnums`) so the always-on test can assert code's decision literals stay a subset without re-parsing the raw schema shape. */
const DECISION_ENUM_REFS = {
  commandExecution: "CommandExecutionApprovalDecision",
  fileChange: "FileChangeApprovalDecision",
};

function parseRef(ref) {
  // "Name" -> top-level; "v2/Name" -> nested under definitions.v2.
  const slash = ref.indexOf("/");
  return slash === -1 ? { scope: "top", name: ref } : { scope: "v2", name: ref.slice(slash + 1) };
}

function lookupDef(schema, ref) {
  const { scope, name } = parseRef(ref);
  const bag = scope === "top" ? schema.definitions : schema.definitions.v2;
  const def = bag?.[name];
  if (def === undefined) {
    throw new Error(`codex-contract-extract: unresolved definition "${ref}" (scope=${scope})`);
  }
  return def;
}

/** `#/definitions/(v2/)?Name` -> our flat `"Name"` / `"v2/Name"` ref form. Shared by `collectRefs` (below) and `resolveMethodParamsRef` (method-registry lookup). */
const DOLLAR_REF_PATTERN = /^#\/definitions\/(?:(v2)\/)?(.+)$/;

function dollarRefToOurForm(dollarRef) {
  const m = DOLLAR_REF_PATTERN.exec(dollarRef);
  if (!m) {
    throw new Error(`codex-contract-extract: unrecognized $ref shape "${dollarRef}"`);
  }
  return m[1] === "v2" ? `v2/${m[2]}` : m[2];
}

/** Every `$ref` string reachable anywhere inside `value`, normalized to the same `"Name"` / `"v2/Name"` form used above. */
function collectRefs(value, out) {
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, out);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (key === "$ref" && typeof child === "string") {
        const m = DOLLAR_REF_PATTERN.exec(child);
        if (m) out.add(m[1] === "v2" ? `v2/${m[2]}` : m[2]);
        continue;
      }
      collectRefs(child, out);
    }
  }
}

/**
 * Resolves a CONSUMED method's params ref by matching its name against the
 * live schema's OWN method registry (`ClientRequest` / `ServerRequest` /
 * `ServerNotification` — each a `oneOf` of `{method:{enum:[name]}, params?}`
 * variants, the real discriminated unions the codex-cli wire protocol uses to
 * dispatch by method string). This is the structural drift check (cut §2(h)
 * harden): a CLI that renames a consumed method — even leaving its params/
 * result TYPE names untouched — has no variant left whose `method` matches,
 * so this throws instead of the extractor silently trusting a hardcoded
 * params-ref string that would still happen to resolve.
 */
function resolveMethodParamsRef(schema, registryName, method) {
  const registry = schema.definitions[registryName];
  if (!registry || !Array.isArray(registry.oneOf)) {
    throw new Error(
      `codex-contract-extract: schema has no "${registryName}" method-registry union — cannot verify consumed method "${method}"`,
    );
  }
  const variant = registry.oneOf.find((candidate) => candidate?.properties?.method?.enum?.[0] === method);
  if (!variant) {
    throw new Error(
      `codex-contract-extract: consumed method "${method}" is no longer present in the schema's ${registryName} union ` +
        `(renamed or removed) — this is real protocol drift, review before widening the pin (contract/README.md)`,
    );
  }
  const paramsSchema = variant.properties?.params;
  // Some variants declare `params: {"type":"null"}` for a zero-argument
  // request/notification (e.g. `account/logout`) rather than omitting the
  // property outright — either shape means "no params type to track".
  if (paramsSchema === undefined || typeof paramsSchema.$ref !== "string") {
    return null;
  }
  return dollarRefToOurForm(paramsSchema.$ref);
}

/** BFS closure of every definition transitively reachable from `rootRefs`. */
function resolveClosure(schema, rootRefs) {
  const visited = new Set();
  const queue = [...rootRefs];
  const resolved = {}; // "Name" -> def, "v2/Name" -> def (flat, ref-string keyed)
  while (queue.length > 0) {
    const ref = queue.shift();
    if (visited.has(ref)) continue;
    visited.add(ref);
    const def = lookupDef(schema, ref);
    resolved[ref] = def;
    const nested = new Set();
    collectRefs(def, nested);
    for (const child of nested) if (!visited.has(child)) queue.push(child);
  }
  return resolved;
}

/** Recreates the source's two-level shape (`{ ...top, v2: {...} }`) from the flat ref-keyed closure, so `pinned-contract.json` stays a simple, `$ref`-compatible JSON-Schema subset. */
function nestDefinitions(resolved) {
  const definitions = {};
  const v2 = {};
  for (const [ref, def] of Object.entries(resolved)) {
    const { scope, name } = parseRef(ref);
    if (scope === "top") definitions[name] = def;
    else v2[name] = def;
  }
  definitions.v2 = v2;
  return definitions;
}

function refResultShape(schema, ref) {
  if (ref === null) return null;
  return ref;
}

function decisionEnumMembers(schema, ref) {
  const def = lookupDef(schema, ref);
  return def.oneOf
    .filter((variant) => variant.type === "string" && Array.isArray(variant.enum))
    .map((variant) => variant.enum[0]);
}

/** Recursively sorts every plain object's keys (arrays keep their order — order is semantic there). */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

export function extractContract(schema, generatedFrom) {
  // Resolve each consumed method's params ref AGAINST THE LIVE SCHEMA's own
  // registry first (throws on a renamed/removed method — see
  // resolveMethodParamsRef) — only then do we know which refs need closing.
  const resolvedClient = CLIENT_REQUEST_METHODS.map((entry) => ({
    ...entry,
    paramsRef: resolveMethodParamsRef(schema, "ClientRequest", entry.method),
  }));
  const resolvedServerRequests = SERVER_REQUEST_METHODS.map((entry) => ({
    ...entry,
    paramsRef: resolveMethodParamsRef(schema, "ServerRequest", entry.method),
  }));
  const resolvedNotifications = SERVER_NOTIFICATION_METHODS.map((entry) => ({
    ...entry,
    paramsRef: resolveMethodParamsRef(schema, "ServerNotification", entry.method),
  }));

  const rootRefs = new Set();
  for (const entry of [...resolvedClient, ...resolvedServerRequests]) {
    if (entry.paramsRef) rootRefs.add(entry.paramsRef);
    if (entry.resultRef) rootRefs.add(entry.resultRef);
  }
  for (const entry of resolvedNotifications) if (entry.paramsRef) rootRefs.add(entry.paramsRef);
  for (const ref of EXTRA_ROOT_REFS) rootRefs.add(ref);
  for (const ref of Object.values(DECISION_ENUM_REFS)) rootRefs.add(ref);

  const resolved = resolveClosure(schema, rootRefs);
  const definitions = nestDefinitions(resolved);

  const methods = {
    clientRequests: Object.fromEntries(
      resolvedClient.map((entry) => [
        entry.method,
        { params: refResultShape(schema, entry.paramsRef), result: refResultShape(schema, entry.resultRef) },
      ]),
    ),
    serverRequests: Object.fromEntries(
      resolvedServerRequests.map((entry) => [
        entry.method,
        { params: refResultShape(schema, entry.paramsRef), result: refResultShape(schema, entry.resultRef) },
      ]),
    ),
    serverNotifications: Object.fromEntries(
      resolvedNotifications.map((entry) => [entry.method, { params: refResultShape(schema, entry.paramsRef) }]),
    ),
  };

  const decisionEnums = Object.fromEntries(
    Object.entries(DECISION_ENUM_REFS).map(([family, ref]) => [family, decisionEnumMembers(schema, ref)]),
  );

  return canonicalize({ generatedFrom, methods, decisionEnums, definitions });
}

function main() {
  const [, , schemaDir, outFile, generatedFrom] = process.argv;
  // `generatedFrom` is REQUIRED, no hardcoded default (cut §2(h) harden):
  // the caller must supply the string a real binary actually reported (e.g.
  // `codex --version`), never a stamped literal — see contract-drift.test.ts's
  // layer 2 for the live-binary recipe and contract/README.md for the pin
  // recipe.
  if (!schemaDir || !generatedFrom) {
    console.error("usage: codex-contract-extract.mjs <schemaDir> [outFile] <generatedFrom>");
    console.error('  <generatedFrom> is a required, EXPLICIT provenance string (e.g. the real `codex --version` output) —');
    console.error("  never inferred or defaulted, so a stale/wrong value cannot silently ride along.");
    process.exit(1);
  }
  const schemaPath = join(schemaDir, "codex_app_server_protocol.schemas.json");
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  const contract = extractContract(schema, generatedFrom);
  const json = JSON.stringify(contract, null, 2) + "\n";
  if (outFile) writeFileSync(outFile, json);
  else process.stdout.write(json);
}

// Only run as a CLI when invoked directly (import.meta.url === entry script) — importable from
// contract-drift.test.ts's env-gated layer 2 without a side-effecting main() call.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
