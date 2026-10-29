import { closeSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import readline from "node:readline";

const args = process.argv.slice(2);
const pidFileArg = args.find((arg) => arg.startsWith("--pid-file="));
const pidFilePath = pidFileArg ? pidFileArg.slice("--pid-file=".length) : undefined;

/** A grandchild that ignores SIGTERM: only a process-GROUP SIGKILL ends it. */
const forkStubbornGrandchild = () => {
  const grandchild = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], {
    stdio: "ignore",
  });
  if (pidFilePath && grandchild.pid !== undefined) writeFileSync(pidFilePath, String(grandchild.pid));
};

if (args.includes("generate-json-schema")) {
  if (args.includes("--schema-grandchild")) forkStubbornGrandchild();
  if (args.includes("--schema-hang") || args.includes("--schema-grandchild")) { setInterval(() => {}, 1000); }
  else {
    const out = new URL(`file://${args[args.indexOf("--out") + 1]}/codex_app_server_protocol.schemas.json`);
    if (args.includes("--schema-fail")) process.exit(1);
    if (!args.includes("--schema-missing")) {
      const schema = JSON.parse(readFileSync(new URL("./contract/fixtures/schema-0.144.3/codex_app_server_protocol.schemas.json", import.meta.url), "utf8"));
      if (args.includes("--schema-unsupported")) schema.definitions.ClientRequest.oneOf = schema.definitions.ClientRequest.oneOf.filter(v => !v.properties.method.enum.includes("thread/compact/start"));
      writeFileSync(out, args.includes("--schema-malformed") ? "{" : args.includes("--schema-oversized") ? " ".repeat(16 * 1024 * 1024 + 1) : JSON.stringify(schema));
    }
    process.exit(0);
  }
} else if (args.includes("--version")) {
  if (args.includes("--version-grandchild")) {
    // A version wrapper that forks a grandchild and hangs. The preflight runs
    // BEFORE the long-lived client exists, so killing only the direct wrapper
    // on timeout strands this grandchild with nothing left to reap it.
    forkStubbornGrandchild();
    setInterval(() => {}, 1_000);
  } else if (args.includes("--bad-version")) {
    // TASK.173 (owner decision, 2026-08-29): SUPPORTED_CODEX_VERSION dropped
    // its floor and is now a bare ceiling, so the only way left to be
    // unsupported is ABOVE it — a below-floor probe (e.g. 0.100.0) would now
    // pass. Every codex-cli release observed so far (W0 through the 0.150.1
    // measurement) has stayed on major 0, so a next-major placeholder stays
    // above the ceiling no matter how far a future edit raises it within 0.x.
    process.stdout.write("codex-cli 1.0.0\n");
  } else if (args.includes("--hang-version")) setInterval(() => {}, 1_000);
  else process.stdout.write("codex-cli 0.144.1\n");
  if (!args.includes("--hang-version") && !args.includes("--version-grandchild")) process.exit(0);
} else {
  const fixture = args.find((arg) => arg.startsWith("--fixture="));
  // Taskana 4265 cross-review M2: the last id:88 RESPONSE line this fake
  // app-server received (what the host answered an emitted approval with).
  // `read-approval-answer` replays it so a driving test can observe the
  // wrapped bridge's real accept without touching host internals.
  let lastApprovalAnswer = null;
  if (args.includes("--malformed")) process.stdout.write("not-json\n");
  if (args.includes("--oversize")) process.stdout.write(`${"x".repeat(2_048)}\n`);
  if (args.includes("--pre-init-noise")) {
    // Live-observed shape (amendment §A3.8): the real 0.144.5 server emits
    // notifications AROUND initialize; the client must silently drop these.
    process.stdout.write(`${JSON.stringify({ method: "remoteControl/status/changed", params: { status: "disabled" } })}\n`);
    process.stdout.write(`${JSON.stringify({ method: "test/pre-init", params: { leaked: true } })}\n`);
  }
  if (args.includes("--stubborn-group")) {
    process.on("SIGTERM", () => {});
    forkStubbornGrandchild();
  }
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    const request = JSON.parse(line);
    if (request.method === "initialize") {
      // Notification-bearing scenarios emit AFTER the initialize response so
      // their lines survive the client's pre-init drop (amendment §A3.8).
      process.stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
      if (fixture) process.stdout.write(readFileSync(fixture.slice("--fixture=".length), "utf8"));
      if (args.includes("--env")) {
        process.stdout.write(`${JSON.stringify({ method: "test/env", params: process.env })}\n`);
      }
      if (args.includes("--pre-init-noise")) {
        process.stdout.write(`${JSON.stringify({ method: "test/after-init" })}\n`);
      }
      if (args.includes("--close-stdin")) {
        // A live app-server that closes fd 0 under us: the next write raises an
        // asynchronous EPIPE on the parent's stdin socket, which with no `error`
        // listener installed there terminates the OWNING process.
        process.stdout.write(`${JSON.stringify({ method: "test/stdin-closed" })}\n`);
        closeSync(0);
      }
    } else if (request.method === "account/read") {
      // TASK.180 wrapper tests: the minimum usable boot-RPC shapes so
      // startCodexEngine/resumeCodexEngine can run end-to-end here.
      process.stdout.write(`${JSON.stringify({ id: request.id, result: { account: { id: "acct" }, requiresOpenaiAuth: false } })}\n`);
    } else if (request.method === "model/list") {
      process.stdout.write(`${JSON.stringify({ id: request.id, result: { data: [], nextCursor: null } })}\n`);
    } else if (request.method === "account/rateLimits/read") {
      process.stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
    } else if (request.method === "thread/start") {
      if (request.params?.config?.mcp_servers?.broken) process.stdout.write(`${JSON.stringify({ method: "mcpServer/startupStatus/updated", params: { name: "broken", status: "failed", error: "spawn failed" } })}\n`);
      process.stdout.write(`${JSON.stringify({ id: request.id, result: { thread: { id: "thread-180", turns: [] }, model: "gpt-test" } })}\n`);
    } else if (request.method === "thread/resume") {
      if (request.params?.config?.mcp_servers?.broken) process.stdout.write(`${JSON.stringify({ method: "mcpServer/startupStatus/updated", params: { name: "broken", status: "failed", error: "spawn failed" } })}\n`);
      process.stdout.write(`${JSON.stringify({ id: request.id, result: { thread: { id: "thread-180", turns: [] }, model: "gpt-test" } })}\n`);
    } else if (request.method === "thread/read") {
      process.stdout.write(`${JSON.stringify({ id: request.id, result: { thread: { id: "thread-180", turns: [] } } })}\n`);
    } else if (request.method === "turn/start") {
      // Taskana 4265 cross-review M2: answers with a REAL native turn id so a
      // driven turn can pass Phase A and own an active turn the approval
      // correlates against. The turn is then left deliberately un-terminated
      // (the driving test disposes the engine), matching a live turn parked
      // on an approval.
      process.stdout.write(`${JSON.stringify({ id: request.id, result: { turn: { id: "native-turn-1", status: "inProgress" } } })}\n`);
    } else if (request.method === "emit-notification") {
      // Forwards an arbitrary notification verbatim (no id to answer — this is
      // a notify): the engine's transport tap indexes `item/started` lines at
      // dispatch, exactly as a live app-server's stream would.
      process.stdout.write(`${JSON.stringify(request.params)}\n`);
    } else if (request.method === "echo") {
      process.stdout.write(`${JSON.stringify({ id: request.id, result: request.params })}\n`);
    } else if (request.method === "read-approval-answer") {
      process.stdout.write(`${JSON.stringify({ id: request.id, result: lastApprovalAnswer })}\n`);
    } else if (request.id === 88 || request.id === "request-88") {
      lastApprovalAnswer = request.result ?? null;
      process.stdout.write(`${JSON.stringify({ method: "test/server-response", params: request })}\n`);
    } else if (request.method === "emit-server-request") {
      process.stdout.write(`${JSON.stringify({ id: 88, method: "item/commandExecution/requestApproval", params: { command: "pwd" } })}\n`);
    } else if (request.method === "emit-server-request-file") {
      // Taskana 4265 cross-review M2: emits a file-change approval whose
      // identity (threadId/turnId/itemId) the REQUEST's params carry — the
      // driving test supplies the live turn's real values, so the wrapped
      // bridge correlates it against the item the same stdout stream indexed.
      const emit = { id: 88, ...request.params };
      process.stdout.write(`${JSON.stringify(emit)}\n`);
    } else if (request.method === "emit-server-request-string") {
      process.stdout.write(`${JSON.stringify({ id: "request-88", method: "item/commandExecution/requestApproval", params: { command: "pwd" } })}\n`);
    } else if (request.method === "exit") {
      process.exit(0);
    }
  });
}
