/** Protocol gates use production queues/hosts with scripted transports, separately from GUI evidence. */
import { spawn } from "node:child_process";
import { readFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildSmokeEnv } from "./model-overrides-smoke-env.mjs";

const host = "apps/desktop/src/host/";
export const protocolFiles = [
  "orchestration-delivery.integration.test.ts",
  "session-orchestration-recovery.test.ts",
  "engines/claude/claude-engine.connect.test.ts",
  "engines/claude/orchestration-policy.test.ts",
  "engine-child-report-durability.test.ts",
].map(file => host + file).concat("packages/core/src/cli/child-notification.test.ts");

export const protocolChecks = [
  ["dispatch-report-wake", "queues concurrent reports without steering or losing an origin", 3],
  ["off-report-reload", "keeps an OFF detached report pending across failed saves and reload", 3],
  ["restart-report", "holds reports through restart to enabled=", 6],
  ["restart-refusal-retry", "retries explicit pre-accept refusal after stable enabled=", 4],
  ["cancel", "cascades synchronous cancellation while admitted detached work survives", 3],
  ["rights", "preserves restricted routing and rejects spoofed terminal ownership", 3],
  ["errors", "wakes with honest child failure status", 9],
  ["host-restart-pending", "a restart with one pending report delivers it once", 2],
  ["host-restart-acked", "after an ack, a restart delivers nothing", 2],
  ["length-partial", 'finalTurnFinishReason "length" + status completed maps to failed', 1],
  ["off-recovery", "clears unavailable intent only after proof", 2],
  ["native-off-recovery", "verifies OFF spawn contract before payload with overlay unavailable", 2],
  ["client-restart-report", "keeps host user/report admission closed until restart confirms", 2],
  ["unqualified-unavailable", "keeps synthetic and unknown versions unavailable", 1],
];

export function judgeProtocol(report, exitCode) {
  const suites = report?.testResults ?? [];
  const assertions = suites.flatMap(suite => suite.assertionResults ?? []);
  const results = protocolChecks.map(([name, phrase, count]) => {
    const matches = assertions.filter(item => item.fullName?.includes(phrase) && item.status !== "pending" && item.status !== "skipped");
    const passed = matches.length === count && matches.every(item => item.status === "passed");
    return { name: `protocol-${name}`, status: passed ? "PASS" : "FAIL", detail: `scripted transport: ${matches.filter(item => item.status === "passed").length}/${count} assertions` };
  });
  if (exitCode !== 0 || report?.success !== true || assertions.some(item => item.status === "failed"))
    results.push({ name: "protocol-runner", status: "FAIL", detail: "targeted runner failed or evidence is incomplete" });
  return results;
}

export function judgeNativeProof({ attempted = false, available = false, observed = false, reason = "native proof not requested" } = {}) {
  if (!attempted || !available) return { status: "SKIP", detail: reason };
  return { status: observed ? "PASS" : "FAIL", detail: observed ? "native observation verified" : "required native observation absent" };
}

export function smokeExitCode(results) {
  return results.length > 0 && results.every(item => ["PASS", "SKIP"].includes(item.status)) ? 0 : 1;
}

export async function runProtocolChecks(repoRoot, profile) {
  const root = join(profile, "protocol");
  mkdirSync(root, { recursive: true });
  const output = join(root, "judgement.json");
  const env = { ...buildSmokeEnv({}, root, 0, join(root, "unavailable")), HOME: root };
  // Invoke the installed runner directly: no package-manager home or ambient auth.
  const child = spawn(process.execPath, [join(repoRoot, "node_modules/vitest/vitest.mjs"), "run", ...protocolFiles,
    "--reporter=json", `--outputFile=${output}`], { cwd: repoRoot, env, stdio: "ignore" });
  const code = await new Promise(resolve => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, 120_000);
    child.once("error", () => { clearTimeout(timer); resolve(-1); });
    child.once("exit", code => { clearTimeout(timer); resolve(code); });
  });
  let report;
  try { report = JSON.parse(readFileSync(output, "utf8")); } catch { /* missing evidence fails closed */ }
  const results = judgeProtocol(report, code);
  // Keep only per-check counts: runner diagnostics can contain unsanitized stack paths.
  rmSync(output, { force: true });
  return results;
}
