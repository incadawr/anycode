#!/usr/bin/env node
/**
 * fake-lsp-server.cjs (slice 6.1 B5): a REAL stdio LSP server in bare Node (CJS,
 * zero deps) used by the hermetic client/manager tests. It speaks correct LSP
 * base-protocol framing, replies to `initialize`, and on `textDocument/didOpen`
 * and `textDocument/didChange` publishes diagnostics deterministically:
 *   - each line containing the marker `DIAG:` yields one error diagnostic on that
 *     line (message = the text after `DIAG:`);
 *   - clean text yields an empty publish.
 *
 * Behavioral modes are selected via argv flags so one fixture drives the whole
 * §6 adversarial matrix:
 *   --ignore-term         teardown-hostile: ignore SIGTERM AND the shutdown/exit
 *                         handshake, forcing SIGKILL escalation (kill-path étude)
 *   --no-init-reply       never answer initialize (init-timeout étude)
 *   --garbage             emit an unframed/garbage byte stream (protocol-error étude)
 *   --huge-header         emit Content-Length: 100MB (message-cap-before-alloc étude)
 *   --wrong-uri           publish under a foreign URI (mis-attribution étude)
 *   --exit-now            exit immediately (crash / no-restart étude)
 *   --spawn-grandchild    spawn `sh -c 'sleep 300'`, write self+grandchild pid files (pgid-reap étude)
 *   --echo-argv           write JSON of argv to FIXTURE_ARGV_FILE (no-shell injection proof)
 *   --stale-then-current  publish version N-1 then version N (version-preference étude)
 *
 * Pid-file / argv-file paths are passed via env so the LSP argv stays clean:
 *   FIXTURE_SELF_PIDFILE, FIXTURE_GRAND_PIDFILE, FIXTURE_ARGV_FILE.
 */

"use strict";

const fs = require("node:fs");
const cp = require("node:child_process");

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);

if (has("--ignore-term")) {
  process.on("SIGTERM", () => {});
}

if (has("--echo-argv") && process.env.FIXTURE_ARGV_FILE) {
  try {
    fs.writeFileSync(process.env.FIXTURE_ARGV_FILE, JSON.stringify(args));
  } catch {
    // best-effort
  }
}

if (has("--spawn-grandchild")) {
  const grandchild = cp.spawn("sh", ["-c", "sleep 300"], { stdio: "ignore" });
  if (process.env.FIXTURE_SELF_PIDFILE) {
    try {
      fs.writeFileSync(process.env.FIXTURE_SELF_PIDFILE, String(process.pid));
    } catch {
      // best-effort
    }
  }
  if (process.env.FIXTURE_GRAND_PIDFILE) {
    try {
      fs.writeFileSync(process.env.FIXTURE_GRAND_PIDFILE, String(grandchild.pid));
    } catch {
      // best-effort
    }
  }
}

if (has("--exit-now")) {
  process.exit(1);
}

if (has("--garbage")) {
  // A header block with no valid Content-Length -> the client's frame decoder
  // fails on the header alone. Stay alive so the client can observe + kill us.
  process.stdout.write("!!!not-a-valid-lsp-header!!!\r\n\r\nnonsense-body");
  setInterval(() => {}, 1000);
  return;
}

if (has("--huge-header")) {
  // 100MB declared length: the client caps at header-parse time, before body
  // allocation. Stay alive so the client can observe + kill us.
  process.stdout.write("Content-Length: 104857600\r\n\r\n");
  setInterval(() => {}, 1000);
  return;
}

const WRONG_URI = "file:///fixture/wrong/other-file.ts";
const docs = new Map();

function send(message) {
  const body = Buffer.from(JSON.stringify(message), "utf-8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function computeDiagnostics(text) {
  const diagnostics = [];
  text.split("\n").forEach((line, index) => {
    const marker = line.indexOf("DIAG:");
    if (marker !== -1) {
      diagnostics.push({
        range: {
          start: { line: index, character: marker },
          end: { line: index, character: line.length },
        },
        severity: 1,
        message: line.slice(marker + "DIAG:".length).trim() || "diagnostic marker",
        source: "fake-lsp",
        code: "DIAG",
      });
    }
  });
  return diagnostics;
}

function fixedDiag(line, message) {
  return {
    range: { start: { line, character: 0 }, end: { line, character: 1 } },
    severity: 1,
    message,
    source: "fake-lsp",
  };
}

function diagnosticsNotification(uri, version, diagnostics) {
  return {
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: { uri, version, diagnostics },
  };
}

function publish(realUri, version) {
  const publishUri = has("--wrong-uri") ? WRONG_URI : realUri;
  if (has("--stale-then-current")) {
    send(diagnosticsNotification(publishUri, version - 1, [fixedDiag(0, "STALE")]));
    send(diagnosticsNotification(publishUri, version, [fixedDiag(1, "CURRENT")]));
    return;
  }
  const text = docs.get(realUri) || "";
  send(diagnosticsNotification(publishUri, version, computeDiagnostics(text)));
}

function handle(message) {
  if (!message || typeof message !== "object") return;
  const method = message.method;

  if (method === "initialize") {
    if (has("--no-init-reply")) return;
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        capabilities: { textDocumentSync: 1 },
        serverInfo: { name: "fake-lsp", version: "0.0.0" },
      },
    });
    return;
  }

  if (method === "textDocument/didOpen") {
    const td = message.params.textDocument;
    docs.set(td.uri, td.text);
    publish(td.uri, td.version);
    return;
  }

  if (method === "textDocument/didChange") {
    const td = message.params.textDocument;
    const changes = message.params.contentChanges;
    const text =
      Array.isArray(changes) && changes.length > 0
        ? changes[changes.length - 1].text
        : docs.get(td.uri) || "";
    docs.set(td.uri, text);
    publish(td.uri, td.version);
    return;
  }

  if (method === "shutdown") {
    // --ignore-term is fully teardown-hostile: no shutdown reply, so the polite
    // path times out and the owner must escalate to the kill path.
    if (has("--ignore-term")) return;
    send({ jsonrpc: "2.0", id: message.id, result: null });
    return;
  }

  if (method === "exit") {
    // --ignore-term refuses to exit on request too — only SIGKILL stops it.
    if (has("--ignore-term")) return;
    process.exit(0);
  }
}

// Byte-counted stdin frame decoder (bare, mirrors the client's framing).
let buffer = Buffer.alloc(0);
let expected = null;

process.stdin.on("data", (chunk) => {
  buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
  for (;;) {
    if (expected === null) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = buffer.subarray(0, headerEnd).toString("ascii");
      const match = /content-length:\s*(\d+)/i.exec(header);
      expected = match ? Number(match[1]) : 0;
      buffer = buffer.subarray(headerEnd + 4);
    }
    if (buffer.length < expected) return;
    const body = buffer.subarray(0, expected);
    buffer = buffer.subarray(expected);
    expected = null;
    let message;
    try {
      message = JSON.parse(body.toString("utf-8"));
    } catch {
      continue;
    }
    handle(message);
  }
});

process.stdin.resume();
