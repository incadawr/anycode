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

if (args.includes("--version")) {
  if (args.includes("--version-grandchild")) {
    // A version wrapper that forks a grandchild and hangs. The preflight runs
    // BEFORE the long-lived client exists, so killing only the direct wrapper
    // on timeout strands this grandchild with nothing left to reap it.
    forkStubbornGrandchild();
    setInterval(() => {}, 1_000);
  } else if (args.includes("--bad-version")) process.stdout.write("codex-cli 0.145.0\n");
  else if (args.includes("--hang-version")) setInterval(() => {}, 1_000);
  else process.stdout.write("codex-cli 0.144.1\n");
  if (!args.includes("--hang-version") && !args.includes("--version-grandchild")) process.exit(0);
} else {
  const fixture = args.find((arg) => arg.startsWith("--fixture="));
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
    } else if (request.method === "echo") {
      process.stdout.write(`${JSON.stringify({ id: request.id, result: request.params })}\n`);
    } else if (request.id === 88 || request.id === "request-88") {
      process.stdout.write(`${JSON.stringify({ method: "test/server-response", params: request })}\n`);
    } else if (request.method === "emit-server-request") {
      process.stdout.write(`${JSON.stringify({ id: 88, method: "item/commandExecution/requestApproval", params: { command: "pwd" } })}\n`);
    } else if (request.method === "emit-server-request-string") {
      process.stdout.write(`${JSON.stringify({ id: "request-88", method: "item/commandExecution/requestApproval", params: { command: "pwd" } })}\n`);
    } else if (request.method === "exit") {
      process.exit(0);
    }
  });
}
