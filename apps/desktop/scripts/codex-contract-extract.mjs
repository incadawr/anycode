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
 * AnyCode's Codex adapter actually speaks. This list is a deliberate, reviewed
 * act — NOT something the extractor infers from the schema on its own; the
 * cut's own minor-strategy note (§2(h)) is that widening it requires a
 * regen+extract+review of the diff in ONE commit.
 */
const CLIENT_REQUEST_METHODS = [
  { method: "initialize", paramsRef: "InitializeParams", resultRef: "InitializeResponse" },
  { method: "account/read", paramsRef: "v2/GetAccountParams", resultRef: "v2/GetAccountResponse" },
  { method: "model/list", paramsRef: "v2/ModelListParams", resultRef: "v2/ModelListResponse" },
  { method: "thread/start", paramsRef: "v2/ThreadStartParams", resultRef: "v2/ThreadStartResponse" },
  { method: "thread/resume", paramsRef: "v2/ThreadResumeParams", resultRef: "v2/ThreadResumeResponse" },
  { method: "thread/read", paramsRef: "v2/ThreadReadParams", resultRef: "v2/ThreadReadResponse" },
  { method: "turn/start", paramsRef: "v2/TurnStartParams", resultRef: "v2/TurnStartResponse" },
  { method: "turn/interrupt", paramsRef: "v2/TurnInterruptParams", resultRef: "v2/TurnInterruptResponse" },
  { method: "account/login/start", paramsRef: "v2/LoginAccountParams", resultRef: "v2/LoginAccountResponse" },
  { method: "account/login/cancel", paramsRef: "v2/CancelLoginAccountParams", resultRef: "v2/CancelLoginAccountResponse" },
  { method: "account/logout", paramsRef: null, resultRef: "v2/LogoutAccountResponse" },
];

/** Both approval families (cut §1.1): command-execution AND file-change. */
const SERVER_REQUEST_METHODS = [
  {
    method: "item/commandExecution/requestApproval",
    paramsRef: "CommandExecutionRequestApprovalParams",
    resultRef: "CommandExecutionRequestApprovalResponse",
  },
  {
    method: "item/fileChange/requestApproval",
    paramsRef: "FileChangeRequestApprovalParams",
    resultRef: "FileChangeRequestApprovalResponse",
  },
];

/** Notification families the translator/pre-turn buffer/doctor observe or must not mis-count (cut §1.6/§2(i)). */
const SERVER_NOTIFICATION_METHODS = [
  { method: "error", paramsRef: "v2/ErrorNotification" },
  { method: "item/started", paramsRef: "v2/ItemStartedNotification" },
  { method: "item/completed", paramsRef: "v2/ItemCompletedNotification" },
  { method: "item/agentMessage/delta", paramsRef: "v2/AgentMessageDeltaNotification" },
  { method: "thread/tokenUsage/updated", paramsRef: "v2/ThreadTokenUsageUpdatedNotification" },
  { method: "turn/completed", paramsRef: "v2/TurnCompletedNotification" },
  { method: "thread/settings/updated", paramsRef: "v2/ThreadSettingsUpdatedNotification" },
  { method: "account/login/completed", paramsRef: "v2/AccountLoginCompletedNotification" },
  { method: "account/updated", paramsRef: "v2/AccountUpdatedNotification" },
  { method: "account/rateLimits/updated", paramsRef: "v2/AccountRateLimitsUpdatedNotification" },
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

/** Every `$ref` string reachable anywhere inside `value`, normalized to the same `"Name"` / `"v2/Name"` form used above. */
function collectRefs(value, out) {
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, out);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (key === "$ref" && typeof child === "string") {
        const m = /^#\/definitions\/(?:(v2)\/)?(.+)$/.exec(child);
        if (m) out.add(m[1] === "v2" ? `v2/${m[2]}` : m[2]);
        continue;
      }
      collectRefs(child, out);
    }
  }
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
  const rootRefs = new Set();
  for (const entry of [...CLIENT_REQUEST_METHODS, ...SERVER_REQUEST_METHODS]) {
    if (entry.paramsRef) rootRefs.add(entry.paramsRef);
    if (entry.resultRef) rootRefs.add(entry.resultRef);
  }
  for (const entry of SERVER_NOTIFICATION_METHODS) if (entry.paramsRef) rootRefs.add(entry.paramsRef);
  for (const ref of EXTRA_ROOT_REFS) rootRefs.add(ref);
  for (const ref of Object.values(DECISION_ENUM_REFS)) rootRefs.add(ref);

  const resolved = resolveClosure(schema, rootRefs);
  const definitions = nestDefinitions(resolved);

  const methods = {
    clientRequests: Object.fromEntries(
      CLIENT_REQUEST_METHODS.map((entry) => [
        entry.method,
        { params: refResultShape(schema, entry.paramsRef), result: refResultShape(schema, entry.resultRef) },
      ]),
    ),
    serverRequests: Object.fromEntries(
      SERVER_REQUEST_METHODS.map((entry) => [
        entry.method,
        { params: refResultShape(schema, entry.paramsRef), result: refResultShape(schema, entry.resultRef) },
      ]),
    ),
    serverNotifications: Object.fromEntries(
      SERVER_NOTIFICATION_METHODS.map((entry) => [entry.method, { params: refResultShape(schema, entry.paramsRef) }]),
    ),
  };

  const decisionEnums = Object.fromEntries(
    Object.entries(DECISION_ENUM_REFS).map(([family, ref]) => [family, decisionEnumMembers(schema, ref)]),
  );

  return canonicalize({ generatedFrom, methods, decisionEnums, definitions });
}

function main() {
  const [, , schemaDir, outFile] = process.argv;
  if (!schemaDir) {
    console.error("usage: codex-contract-extract.mjs <schemaDir> [outFile]");
    process.exit(1);
  }
  const schemaPath = join(schemaDir, "codex_app_server_protocol.schemas.json");
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  const contract = extractContract(schema, "codex-cli 0.144.x");
  const json = JSON.stringify(contract, null, 2) + "\n";
  if (outFile) writeFileSync(outFile, json);
  else process.stdout.write(json);
}

// Only run as a CLI when invoked directly (import.meta.url === entry script) — importable from
// contract-drift.test.ts's env-gated layer 2 without a side-effecting main() call.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
