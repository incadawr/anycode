import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createEngineSmokeFixtures, evaluateSmoke, selectSmokeEngine } from "./engine-smoke-fixtures.mjs";

test("shared fixture serves loopback requests and executable doubles without credentials", async () => {
  const profile = mkdtempSync(join(tmpdir(), "anycode-fixture-test-"));
  let fixtures;
  try {
    fixtures = await createEngineSmokeFixtures(profile);
    assert.match(fixtures.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    for (const engine of ["codex", "claude"]) {
      const binary = fixtures.binaries[engine];
      const version = execFileSync(binary, ["--version"], { env: { HOME: profile }, encoding: "utf8" });
      assert.match(version, engine === "codex" ? /codex-cli 0\.166\.0/ : /2\.1\.212/);
      const consent = fixtures.consents.find(item => item.path.endsWith(`${engine}-double`));
      assert.equal(consent.fingerprint.size, statSync(binary).size);
      assert.equal(statSync(binary).mode & 0o777, 0o700);
    }
    const messages = [{ role: "user", content: "fixture nonce" }];
    const response = await fetch(`${fixtures.baseUrl}/chat/completions`, {
      method: "POST", body: JSON.stringify({ model: "core-model", messages }),
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /core fixture answer[\s\S]*\[DONE\]/);
    assert.equal(fixtures.providerCalls, 1);
    assert.deepEqual(fixtures.providerInputs, [messages]);
  } finally {
    if (fixtures) await new Promise(resolve => fixtures.fixture.close(resolve));
    rmSync(profile, { recursive: true, force: true });
  }
});

test("driver refuses launch without explicit fixture opt-in or with unsupported arguments", () => {
  const driver = fileURLToPath(new URL("./orchestrate-mode-smoke.mjs", import.meta.url));
  for (const args of [[], ["--port", "1234"], ["--fixture-only", "--engines", "unknown"]]) {
    const result = spawnSync(process.execPath, [driver, ...args], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Explicit --fixture-only is required|Unsupported argument|Unsupported engines/);
    assert.doesNotMatch(result.stdout, /PASS/);
  }
});

test("shared renderer helpers propagate exceptions and reject unknown engines before clicking", async () => {
  const exceptionDetails = { text: "fixture evaluation failed" };
  await assert.rejects(evaluateSmoke({ call: async () => ({ exceptionDetails }) }, "bad()"), /fixture evaluation failed/);
  let clicks = 0;
  await assert.rejects(selectSmokeEngine(() => { clicks++; }, () => {}, "unknown"));
  assert.equal(clicks, 0);
});
