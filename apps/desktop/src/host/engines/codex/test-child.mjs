import { readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import readline from "node:readline";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  if (args.includes("--bad-version")) process.stdout.write("codex-cli 0.145.0\n");
  else if (args.includes("--hang-version")) setInterval(() => {}, 1_000);
  else process.stdout.write("codex-cli 0.144.1\n");
  if (!args.includes("--hang-version")) process.exit(0);
} else {
  const fixture = args.find((arg) => arg.startsWith("--fixture="));
  if (args.includes("--malformed")) process.stdout.write("not-json\n");
  if (args.includes("--oversize")) process.stdout.write(`${"x".repeat(2_048)}\n`);
  if (fixture) process.stdout.write(readFileSync(fixture.slice("--fixture=".length), "utf8"));
  if (args.includes("--env")) {
    process.stdout.write(`${JSON.stringify({ method: "test/env", params: process.env })}\n`);
  }
  if (args.includes("--stubborn-group")) {
    process.on("SIGTERM", () => {});
    const pidFile = args.find((arg) => arg.startsWith("--pid-file="));
    const grandchild = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], {
      stdio: "ignore",
    });
    if (pidFile && grandchild.pid !== undefined) writeFileSync(pidFile.slice("--pid-file=".length), String(grandchild.pid));
  }
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    const request = JSON.parse(line);
    if (request.method === "echo") {
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
