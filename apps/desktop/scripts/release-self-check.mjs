/** Usage: node release-self-check.mjs /absolute/path/to/AnyCode[.exe]
 * Runs the actual shipped executable; no dev automation flags or real account. */
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { isAbsolute } from "node:path";
const binary = process.argv[2];
assert(binary && isAbsolute(binary), "Supply the absolute packaged executable path");
const env = { ...process.env };
for (const key of ["ELECTRON_RUN_AS_NODE", "ELECTRON_RENDERER_URL", "REMOTE_DEBUGGING_PORT"]) delete env[key];
const child = spawn(binary, ["--self-check"], { env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
let output = "";
for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { output = (output + chunk).slice(-128000); });
let forceTimer;
const timer = setTimeout(() => {
  child.kill("SIGTERM");
  forceTimer = setTimeout(() => {
    try { if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch {}
  }, 5000);
}, 45000);
try {
  const exitCode = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
  const line = output.split("\n").find(line => line.startsWith("ANYCODE_SELF_CHECK "));
  assert(line, `No self-check result (exit ${exitCode}): ${output}`);
  const result = JSON.parse(line.slice("ANYCODE_SELF_CHECK ".length));
  assert.equal(exitCode, 0, JSON.stringify(result));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.packaged, true, "This check must run against a packaged release artifact");
  console.log(JSON.stringify(result, null, 2));
} finally { clearTimeout(timer); clearTimeout(forceTimer); }
