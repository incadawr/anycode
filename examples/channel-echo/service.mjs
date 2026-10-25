/**
 * channel-echo: a copy-and-modify channel template for the AnyCode Sessions API.
 * Zero dependencies (Node built-ins and global fetch only). AnyCode runs this as
 * a plugin service once the user enables the plugin, consents, and shares a session.
 *
 * Three replaceable points (search for the markers):
 *   SOURCE  listInbox()    where work comes from (here: *.txt files in inbox/)
 *   MAP     handleFor()    work item -> session handle (here: "<handle>__<anything>.txt")
 *   SINK    writeAnswer()  where the answer goes (here: outbox/<name>.answer.txt)
 *
 * Contract: the bearer token lives only in the discovery file the service reads
 * itself (ANYCODE_SESSIONS_DISCOVERY). It is never printed or written anywhere.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const TAG = "[channel-echo]";
const log = (message) => console.log(`${TAG} ${message}`);
const discoveryPath = process.env.ANYCODE_SESSIONS_DISCOVERY;
let requestId = 0;

process.on("SIGTERM", () => process.exit(0));

if (!discoveryPath) {
  log("Sessions API is off; enable it in Settings -> Sessions API");
  setInterval(() => {}, 1 << 30); // idle until the plugin is stopped
} else {
  await main();
}

async function main() {
  const dir = process.env.CHANNEL_ECHO_DIR || join(homedir(), "anycode-channel-echo");
  const inbox = join(dir, "inbox");
  const outbox = join(dir, "outbox");
  await mkdir(inbox, { recursive: true });
  await mkdir(outbox, { recursive: true });
  // A run that stopped mid-file leaves "<name>.txt.processing"; put it back once so it is retried.
  for (const name of await readdir(inbox)) {
    if (name.endsWith(".txt.processing")) await rename(join(inbox, name), join(inbox, name.slice(0, -".processing".length)));
  }
  log(`watching ${inbox}`);
  for (;;) {
    // Nothing is touched until the discovery file exists (the server may still be starting).
    if (existsSync(discoveryPath)) {
      for (const name of await listInbox(inbox)) await handleOne(name, inbox, outbox);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

/** SOURCE: pending *.txt files, oldest name first. One file is processed at a time. */
async function listInbox(inbox) {
  return (await readdir(inbox)).filter((name) => name.endsWith(".txt")).sort();
}

/** MAP: "<handle>__<anything>.txt" -> "<handle>", or undefined when the name does not follow the rule. */
function handleFor(fileName) {
  const at = fileName.indexOf("__");
  return at > 0 ? fileName.slice(0, at) : undefined;
}

async function handleOne(name, inbox, outbox) {
  const base = name.slice(0, -".txt".length);
  const input = join(inbox, name);
  const processing = `${input}.processing`;
  // Rename first, so the same file is never sent twice even if this run dies.
  await rename(input, processing);
  try {
    const handle = handleFor(name);
    if (!handle) {
      await writeAnswer(outbox, base, "error", `file name must look like <handle>__<anything>.txt`);
      return;
    }
    const text = await readFile(processing, "utf8");
    const { size, mtimeMs } = await stat(processing);
    const sessions = (await callTool("list_sessions", {})).sessions;
    const target = sessions.find((session) => session.handle === handle);
    if (!target) {
      await writeAnswer(outbox, base, "error", `no live session with handle ${handle}`);
      return;
    }
    const sent = await callTool("send_message", {
      sessionId: target.sessionId,
      payload: text,
      mode: "next_turn",
      correlationId: base.slice(0, 200),
      idempotencyKey: `${base}:${size}:${mtimeMs}`.slice(0, 200),
    });
    if (sent.state === "rejected") {
      await writeAnswer(outbox, base, "answer", `Rejected: ${sent.detail ?? "no detail"}`);
      return;
    }
    const outcome = await waitForOutcome(target.sessionId, sent.envelope.messageId);
    await writeAnswer(outbox, base, "answer", outcome);
    log(`answered ${base}`);
  } catch (error) {
    log(`failed on ${name}: ${error instanceof Error ? error.message : "unknown error"}`);
    await writeAnswer(outbox, base, "error", "channel-echo could not complete this request; see the service log").catch(() => {});
  } finally {
    await rm(processing, { force: true });
  }
}

/** Long-poll wait_for_result in 50 s slices, capped at 10 minutes in total. */
async function waitForOutcome(sessionId, messageId) {
  const deadline = Date.now() + 10 * 60_000;
  for (;;) {
    const result = await callTool("wait_for_result", { sessionId, messageId, timeoutMs: 50000 });
    if (result.status === "done") return result.latestResult?.publicAnswer ?? "(the session finished without text)";
    if (result.status === "rejected") return `Rejected: ${result.detail ?? "no detail"}`;
    if (result.status === "unknown") return `Delivery unknown; not retried: ${result.detail ?? "no detail"}`;
    if (Date.now() >= deadline) return "Timed out waiting for the session.";
  }
}

/** SINK: writes outbox/<base>.<kind>.txt. */
async function writeAnswer(outbox, base, kind, text) {
  await writeFile(join(outbox, `${base}.${kind}.txt`), `${text}\n`, { mode: 0o600 });
}

/** One MCP tools/call over Streamable HTTP (stateless JSON responses). Reads the discovery file on every call, so a regenerated token is picked up. */
async function callTool(name, args) {
  const discovery = JSON.parse(await readFile(discoveryPath, "utf8"));
  const response = await fetch(discovery.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${discovery.token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-11-25",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method: "tools/call", params: { name, arguments: args } }),
    signal: AbortSignal.timeout(65_000),
  });
  if (!response.ok) throw new Error(`AnyCode endpoint returned HTTP ${response.status}`);
  const message = parseMessage(await response.text());
  if (message.error) throw new Error(message.error.message ?? "JSON-RPC error");
  const text = message.result?.content?.[0]?.text ?? "";
  if (message.result?.isError) throw new Error(text || "tool error");
  return JSON.parse(text);
}

/** Accepts a plain JSON body or a Server-Sent Events body (first `data:` line). */
function parseMessage(body) {
  const json = body.trimStart().startsWith("{") ? body : body.split("\n").find((line) => line.startsWith("data:"))?.slice(5) ?? "{}";
  return JSON.parse(json);
}
