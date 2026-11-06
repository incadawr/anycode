import test from "node:test";
import assert from "node:assert/strict";
import { judgeProtocol, judgeNativeProof, smokeExitCode, protocolChecks } from "./orchestrate-smoke-checks.mjs";

const evidence = () => ({ success: true, testResults: [{ assertionResults: protocolChecks.flatMap(([, phrase, count]) =>
  Array.from({ length: count }, (_, index) => ({ fullName: `${phrase} ${index}`, status: "passed" }))) }] });

test("protocol PASS requires every mandatory observation, never just a successful runner", () => {
  assert(judgeProtocol(evidence(), 0).every(item => item.status === "PASS"));
  for (const report of [undefined, {}, { success: true }, { ...evidence(), testResults: [] }])
    assert(judgeProtocol(report, 0).some(item => item.status === "FAIL"));
  for (const status of ["failed", "pending", "skipped", "unknown"]) {
    const report = evidence(); report.testResults[0].assertionResults[0].status = status;
    assert.equal(judgeProtocol(report, 0)[0].status, "FAIL");
  }
  const missing = evidence(); missing.testResults[0].assertionResults.pop();
  assert(judgeProtocol(missing, 0).some(item => item.status === "FAIL"));
  const extra = evidence(); extra.testResults[0].assertionResults.push(extra.testResults[0].assertionResults[0]);
  assert.equal(judgeProtocol(extra, 0)[0].status, "FAIL");
  assert.equal(judgeProtocol(evidence(), 1).at(-1).status, "FAIL");
  assert.equal(judgeProtocol({ ...evidence(), success: false }, 0).at(-1).status, "FAIL");
});

test("auth and managed unavailable fixtures are SKIP even when fixture observations succeed", () => {
  for (const reason of ["auth unavailable", "managed policy unknown", "native version unqualified"])
    assert.equal(judgeNativeProof({ attempted: true, available: false, observed: true, reason }).status, "SKIP");
  assert.equal(judgeNativeProof().status, "SKIP");
  assert.equal(judgeNativeProof({ attempted: true, available: true }).status, "FAIL");
  assert.equal(judgeNativeProof({ attempted: true, available: true, observed: true }).status, "PASS");
});

test("exit success permits explicitly listed skips but never an empty run or failed/unknown check", () => {
  assert.equal(smokeExitCode([{ status: "PASS" }, { status: "SKIP" }]), 0);
  for (const results of [[], [{ status: "FAIL" }], [{ status: "unknown" }]]) assert.equal(smokeExitCode(results), 1);
});
