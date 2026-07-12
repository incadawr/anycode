import { readFileSync } from "node:fs";
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
