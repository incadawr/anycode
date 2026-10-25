#!/usr/bin/env node
/**
 * Taskana 4732 S1-B (design §3/§4): signs an `index.json` for the official
 * plugin channel — `node scripts/plugins/sign-index.mjs <index.json> <private.pem> [keyId]`.
 *
 * Signs the EXACT index.json bytes (the client verifies over precisely
 * them, never a re-serialization) and writes `<index.json>.sig` holding
 * `{keyId, sig}` (base64 ed25519). Also validates the index against the
 * v1 schema shape before signing so a malformed document cannot be
 * published. node:crypto only — no dependencies.
 */

import { createPrivateKey, sign as ed25519Sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

function die(message) {
  console.error(`sign-index: ${message}`);
  process.exit(1);
}

const [indexArg, keyArg, keyIdArg] = process.argv.slice(2);
if (indexArg === undefined || keyArg === undefined) {
  die("usage: node scripts/plugins/sign-index.mjs <index.json> <private.pem> [keyId]");
}

let raw;
try {
  raw = readFileSync(indexArg, "utf8");
} catch (error) {
  die(`cannot read ${indexArg}: ${error.message}`);
}

// Schema-shape validation (mirrors apps/desktop/src/main/plugins/index-client.ts).
let parsed;
try {
  parsed = JSON.parse(raw);
} catch (error) {
  die(`index.json is not JSON: ${error.message}`);
}
const problems = [];
if (parsed.schemaVersion !== "anycode.plugins-index.v1") problems.push("schemaVersion must be anycode.plugins-index.v1");
if (!Number.isInteger(parsed.serial) || parsed.serial < 0) problems.push("serial must be a non-negative integer");
if (typeof parsed.issuedAt !== "string") problems.push("issuedAt must be an ISO string");
if (typeof parsed.expiresAt !== "string") problems.push("expiresAt must be an ISO string");
if (Date.parse(parsed.expiresAt) <= Date.parse(parsed.issuedAt)) problems.push("expiresAt must be after issuedAt");
if (!Array.isArray(parsed.plugins)) problems.push("plugins must be an array");
for (const [i, entry] of (parsed.plugins ?? []).entries()) {
  if (typeof entry.name !== "string" || entry.name === "") problems.push(`plugins[${i}].name`);
  if (!Array.isArray(entry.versions) || entry.versions.length === 0) problems.push(`plugins[${i}].versions must be non-empty`);
  for (const [j, version] of (entry.versions ?? []).entries()) {
    if (typeof version.version !== "string" || version.version === "") problems.push(`plugins[${i}].versions[${j}].version`);
    if (typeof version.url !== "string" || !version.url.startsWith("https://")) problems.push(`plugins[${i}].versions[${j}].url must be https`);
    if (!/^[0-9a-f]{64}$/.test(version.sha256 ?? "")) problems.push(`plugins[${i}].versions[${j}].sha256 must be 64 hex`);
    if (!Number.isInteger(version.size) || version.size < 0) problems.push(`plugins[${i}].versions[${j}].size`);
  }
}
if (problems.length > 0) {
  die(`index.json schema violations:\n  ${problems.join("\n  ")}`);
}

let privateKeyPem;
try {
  privateKeyPem = readFileSync(keyArg, "utf8");
} catch (error) {
  die(`cannot read ${keyArg}: ${error.message}`);
}
let privateKey;
try {
  privateKey = createPrivateKey(privateKeyPem);
} catch (error) {
  die(`private key invalid: ${error.message}`);
}
if (privateKey.asymmetricKeyType !== "ed25519") {
  die(`private key is ${privateKey.asymmetricKeyType}, expected ed25519`);
}

const keyId = keyIdArg ?? "test-2026-1";
const signature = ed25519Sign(null, Buffer.from(raw, "utf8"), privateKey).toString("base64");
const out = `${indexArg}.sig`;
writeFileSync(out, `${JSON.stringify({ keyId, sig: signature }, null, 2)}\n`);
console.log(`signed ${indexArg} as keyId ${keyId} -> ${out} (${Buffer.from(signature, "base64").length} bytes)`);
