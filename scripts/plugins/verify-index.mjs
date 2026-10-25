#!/usr/bin/env node
/**
 * Taskana 4732 S1-B (design §4): verifies a signed index exactly the way
 * the shipped client does — `node scripts/plugins/verify-index.mjs <index.json> [index.json.sig] [--key <pub.pem>]...`.
 *
 * Default key source: the compiled-in anchors in
 * apps/desktop/src/shared/plugin-trust.ts (parsed with a tiny regex, no
 * TS import needed). `--key <pub.pem>` adds/overrides keys (repeatable).
 * Exit 0 + "OK" on success; non-zero with the reason otherwise.
 */

import { createPublicKey, verify as ed25519Verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const positional = [];
let cliPems = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--key") {
    cliPems.push(readFileSync(args[++i], "utf8"));
  } else {
    positional.push(args[i]);
  }
}
const [indexArg, sigArg] = positional;
if (indexArg === undefined) {
  console.error("usage: node scripts/plugins/verify-index.mjs <index.json> [index.json.sig] [--key <pub.pem>]...");
  process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));
const keys = [];
if (cliPems.length === 0) {
  // Parse the compiled anchors (id + SPKI PEM pairs) from shared/plugin-trust.ts.
  const trustSrc = readFileSync(join(here, "..", "..", "apps", "desktop", "src", "shared", "plugin-trust.ts"), "utf8");
  const pemRegex = /keyId:\s*"([^"]+)",\s*\n\s*publicKeyPem:\s*`-----BEGIN PUBLIC KEY-----([\s\S]*?)-----END PUBLIC KEY-----/g;
  let match;
  while ((match = pemRegex.exec(trustSrc)) !== null) {
    keys.push([match[1], `-----BEGIN PUBLIC KEY-----${match[2]}-----END PUBLIC KEY-----\n`]);
  }
  if (keys.length === 0) {
    console.error("verify-index: no compiled keys parsed from shared/plugin-trust.ts");
    process.exit(2);
  }
} else {
  // Try to read the keyId from a `# keyId: <id>` comment line in the pem;
  // fall back to matching ANY cli key (the script is a debugging tool —
  // explicit --key trust overrides the compiled anchors entirely).
  for (const pem of cliPems) {
    const fromComment = /^#\s*keyId:\s*(\S+)/m.exec(pem);
    keys.push([fromComment?.[1] ?? "*", pem]);
  }
}

const raw = readFileSync(indexArg, "utf8");
const sigPath = sigArg ?? `${indexArg}.sig`;
let envelope;
try {
  envelope = JSON.parse(readFileSync(sigPath, "utf8"));
} catch (error) {
  console.error(`verify-index: cannot read ${sigPath}: ${error.message}`);
  process.exit(2);
}

const key = keys.find(([id]) => id === envelope.keyId || id === "*");
if (key === undefined) {
  console.error(`verify-index: FAIL — keyId ${JSON.stringify(envelope.keyId)} is not a known key`);
  process.exit(1);
}
const ok = ed25519Verify(null, Buffer.from(raw, "utf8"), createPublicKey(key[1]), Buffer.from(envelope.sig, "base64"));
if (!ok) {
  console.error("verify-index: FAIL — signature does not verify over these exact bytes");
  process.exit(1);
}
const parsed = JSON.parse(raw);
const expires = Date.parse(parsed.expiresAt);
const expired = Number.isFinite(expires) && expires < Date.now();
console.log(`OK — signed by ${envelope.keyId}; serial ${parsed.serial}; ${expired ? "EXPIRED" : `valid until ${parsed.expiresAt}`}`);
process.exit(expired ? 1 : 0);
