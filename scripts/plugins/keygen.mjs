#!/usr/bin/env node
/**
 * Taskana 4732 S1-B (design §4/§9.14): ed25519 keypair generator for the
 * official plugin index — `node scripts/plugins/keygen.mjs [--test]`.
 *
 * `--test` mints a TEST key (id `test-YYYY-N`): usable in non-packaged
 * builds; a packaged build carrying only test keys reports the index
 * "not configured". WITHOUT the flag the script still generates a
 * production-shaped key but REFUSES to tell you to commit it — the real
 * production private key is generated OFFLINE by owner ops and never lives
 * in this repo (design §9.14: no real private key is ever generated or
 * committed here as a build artifact).
 *
 * Output: the SPKI public PEM (safe to compile into shared/plugin-trust.ts)
 * and the PKCS8 private PEM (goes to the signer's secret storage ONLY).
 */

import { generateKeyPairSync } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const isTest = args.includes("--test");
const year = new Date().getFullYear();
// test-2026-1 style — the shared/plugin-trust.ts OFFICIAL_PLUGIN_TEST_KEY_ID_PREFIX.
const keyId = isTest ? `test-${year}-1` : `ac-${year}-1`;

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "..", "working-docs", "plugins-keys");
mkdirSync(outDir, { recursive: true });

const suffix = isTest ? "TEST" : "PRODUCTION";
writeFileSync(join(outDir, `${keyId}.pub.pem`), publicKeyPem);
if (isTest) {
  // A test private key is a fixture, not a secret — keep it beside the pub.
  writeFileSync(join(outDir, `${keyId}.private.pem`), privateKeyPem);
} else {
  // Print only; the operator pipes it to their secret store BY HAND.
  console.log("=== PRODUCTION PRIVATE KEY — do NOT commit. Store offline ===");
  console.log(privateKeyPem);
}

console.log(`keyId: ${keyId} (${suffix})`);
console.log(`public:  ${outDir}/${keyId}.pub.pem`);
if (isTest) {
  console.log(`private: ${outDir}/${keyId}.private.pem (TEST fixture)`);
  console.log("\nCompile this entry into apps/desktop/src/shared/plugin-trust.ts OFFICIAL_PLUGIN_KEYS:");
  console.log(JSON.stringify({ keyId, publicKeyPem: publicKeyPem.replace(/\n/g, "\\n") + "\\n" }, null, 2));
} else {
  console.log("\nReminder (§9.14): production private keys never live in this repository.");
}
