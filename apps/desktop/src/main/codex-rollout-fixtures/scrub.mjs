#!/usr/bin/env node
// Extracts a line range from a real ~/.codex/sessions rollout-*.jsonl file and
// scrubs it for use as a committed test fixture. Read-only against the source
// tree; never writes back into ~/.codex.
//
// Usage:
//   node scrub.mjs <src-file> <out-file> --lines <startIdx-endIdx> [--corrupt-line <idx>]
//
// --lines a-b selects 0-based line indices [a,b] inclusive from the source file.
// Line 0 (session_meta) is ALWAYS prepended even if outside the requested range,
// per the fixture invariant "session_meta stays the first line".
//
// --corrupt-line <idx> intentionally truncates that line's JSON mid-string to
// produce a malformed-JSON-line fixture (see slice-codex-profiles-cut.md §8.2:
// "invalid JSON line -> DROP, stats.malformedLines++, do not throw"). This does
// NOT occur naturally in the 721 real rollout files scanned; it is injected on
// purpose and documented in README.md.
//
// Scrub rules applied to every leaf string in the JSON tree:
//   1. e-mail addresses (other than already-scrubbed) -> user@example.com
//   2. absolute home paths /Users/<name>/            -> /Users/scrubbed/
//   3. base64 PNG data URIs                          -> tiny valid 1x1 PNG (structure kept)
//   4. secret-shaped tokens (sk-, ghp_, Bearer, api_key=, generic long hex/b64
//      assigned to a token/key/secret-looking field)  -> SCRUBBED
//   5. reasoning.encrypted_content / agent_message encrypted_content parts -> "SCRUBBED-OPAQUE"
//   6. git remote URLs with embedded credentials/usernames -> scrubbed
//   7. any single leaf string longer than TRUNCATE_AT chars -> truncated with a
//      marker (keeps fixtures small; the record SHAPE is never altered, only the
//      content payload)

import fs from "node:fs";

const TRUNCATE_AT = 4000;

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const HOME_PATH_RE = /\/Users\/[^/\s"]+\//g;
const DATA_PNG_RE = /data:image\/png;base64,[A-Za-z0-9+/=]+/g;
const DATA_JPEG_RE = /data:image\/jpe?g;base64,[A-Za-z0-9+/=]+/g;
const SECRET_RES = [
  /sk-[A-Za-z0-9]{10,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /gh[oprsu]_[A-Za-z0-9]{20,}/g,
  /Bearer\s+[A-Za-z0-9._-]{10,}/g,
  /("?(?:api[_-]?key|apikey|secret|access[_-]?token|auth[_-]?token)"?\s*[:=]\s*"?)[A-Za-z0-9_\-./]{12,}/gi,
];
// git remote URL with an embedded username, e.g. https://user@github.com/... or
// git@host:owner/repo (the ssh form embeds the account/org slug, which is
// scrubbed too since it identifies the real owner).
const GIT_URL_CRED_RE = /(https?:\/\/)[^/@\s]+@/g;
const GIT_SSH_REMOTE_RE = /\b[\w.-]+@[\w.-]+:[\w-]+\/[\w.-]+\b/g;

function scrubString(value) {
  let s = value;
  s = s.replace(DATA_PNG_RE, `data:image/png;base64,${TINY_PNG_BASE64}`);
  s = s.replace(DATA_JPEG_RE, `data:image/png;base64,${TINY_PNG_BASE64}`);
  // SSH-style git remotes (git@host:owner/repo.git) BEFORE the generic e-mail
  // regex, which would otherwise treat "git@host" as an address and leave the
  // owner/repo slug (real identity) untouched.
  s = s.replace(GIT_SSH_REMOTE_RE, "git@scrubbed:scrubbed/scrubbed.git");
  s = s.replace(EMAIL_RE, (m) => (m.endsWith("@example.com") ? m : "user@example.com"));
  s = s.replace(HOME_PATH_RE, "/Users/scrubbed/");
  s = s.replace(GIT_URL_CRED_RE, "$1scrubbed@");
  for (const re of SECRET_RES) {
    s = s.replace(re, (m, prefix) => (prefix !== undefined ? `${prefix}SCRUBBED` : "SCRUBBED"));
  }
  if (s.length > TRUNCATE_AT) {
    s = s.slice(0, TRUNCATE_AT) + `…[truncated ${s.length - TRUNCATE_AT} chars for fixture size]`;
  }
  return s;
}

function scrubValue(value, keyHint) {
  if (typeof value === "string") {
    if (keyHint === "encrypted_content") return "SCRUBBED-OPAQUE";
    return scrubString(value);
  }
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, keyHint));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubValue(v, k);
    return out;
  }
  return value;
}

function parseArgs(argv) {
  const [src, out, ...rest] = argv;
  const opts = { src, out, corruptLine: null, lines: null };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--lines") {
      const [a, b] = rest[++i].split("-").map(Number);
      opts.lines = [a, b];
    } else if (rest[i] === "--corrupt-line") {
      opts.corruptLine = Number(rest[++i]);
    }
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.src || !opts.out) {
    console.error("usage: node scrub.mjs <src> <out> --lines a-b [--corrupt-line idx]");
    process.exit(1);
  }
  const rawLines = fs.readFileSync(opts.src, "utf8").split("\n");
  const selected = [];
  const seenIdx = new Set();
  const pushIdx = (i) => {
    if (i < 0 || i >= rawLines.length) return;
    if (!rawLines[i].trim()) return;
    if (seenIdx.has(i)) return;
    seenIdx.add(i);
    selected.push(i);
  };
  pushIdx(0); // session_meta always first
  if (opts.lines) {
    const [a, b] = opts.lines;
    for (let i = a; i <= b; i++) pushIdx(i);
  }
  selected.sort((x, y) => x - y);

  const outLines = [];
  for (const idx of selected) {
    const line = rawLines[idx];
    if (opts.corruptLine !== null && idx === opts.corruptLine) {
      // Truncate mid-string to produce a deliberately invalid JSON line.
      const cut = Math.max(10, Math.floor(line.length * 0.6));
      outLines.push(line.slice(0, cut));
      continue;
    }
    let rec;
    try {
      rec = JSON.parse(line);
    } catch (e) {
      console.error(`WARN: source line ${idx} already invalid JSON, copying verbatim`);
      outLines.push(line);
      continue;
    }
    const scrubbed = scrubValue(rec, null);
    outLines.push(JSON.stringify(scrubbed));
  }
  fs.writeFileSync(opts.out, outLines.join("\n") + "\n");
  console.error(`wrote ${opts.out}: ${outLines.length} lines, ${fs.statSync(opts.out).size} bytes`);
}

main();
