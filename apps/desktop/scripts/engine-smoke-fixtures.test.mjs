import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

/** Drives one scripted double over its real stdio protocol. */
function scriptedDouble(binary, claude) {
  const child = spawn(binary, [], { stdio: ["pipe", "pipe", "ignore"] });
  const frames = [];
  let buffer = "";
  child.stdout.on("data", chunk => {
    buffer += chunk;
    const lines = buffer.split("\n"); buffer = lines.pop();
    for (const line of lines) if (line) frames.push(JSON.parse(line));
  });
  const write = message => child.stdin.write(`${JSON.stringify(message)}\n`);
  const until = async probe => { for (let i = 0; i < 100; i++) { const value = probe(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error("Timed out"); };
  return { child, frames, write, until, claude };
}

test("scripted codex double calls a bridge tool, awaits the response, then completes; unscripted turns stay instant", async () => {
  const profile = mkdtempSync(join(tmpdir(), "anycode-fixture-test-"));
  let fixtures, double;
  try {
    fixtures = await createEngineSmokeFixtures(profile, { scripted: true });
    double = scriptedDouble(fixtures.binaries.codex);
    double.write({ id: 1, method: "thread/start", params: {} });
    await double.until(() => double.frames.find(frame => frame.id === 1));
    const turn = (id, text) => double.write({ id, method: "turn/start", params: { input: [{ type: "text", text }] } });
    turn(2, "unscripted");
    await double.until(() => double.frames.find(frame => frame.method === "turn/completed"));
    assert.equal(double.frames.some(frame => frame.method === "item/tool/call"), false);
    const completed = () => double.frames.filter(frame => frame.method === "turn/completed").length;
    writeFileSync(join(profile, "codex-script.json"), JSON.stringify({ peerCommands: true }));
    turn(3, `peer-command:${JSON.stringify({ tool: "SessionSend", input: { sessionId: "target", payload: "hello" } })}`);
    const call = await double.until(() => double.frames.find(frame => frame.method === "item/tool/call"));
    assert.equal(call.params.tool, "anycode_session_send");
    assert.deepEqual(call.params.arguments, { sessionId: "target", payload: "hello" });
    assert.equal(call.params.turnId, double.frames.find(frame => frame.id === 3).result.turn.id);
    assert.equal(completed(), 1, "turn must wait for the tool response");
    double.write({ id: call.id, result: { success: true, contentItems: [{ type: "inputText", text: "{\"status\":\"sent\"}" }] } });
    await double.until(() => completed() === 2);
    const logged = readFileSync(join(profile, "codex.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(logged.find(frame => frame.doubleToolResponse).doubleToolResponse.result.success, true);
    // Without a script file the same text is just another turn.
    rmSync(join(profile, "codex-script.json"));
    turn(4, `peer-command:${JSON.stringify({ tool: "SessionSend", input: {} })}`);
    await double.until(() => completed() === 3);
    assert.equal(double.frames.filter(frame => frame.method === "item/tool/call").length, 1);
  } finally {
    double?.child.kill();
    if (fixtures) await new Promise(resolve => fixtures.fixture.close(resolve));
    rmSync(profile, { recursive: true, force: true });
  }
});

test("scripted codex double answers a marker, replies explicitly, and holds busy until released", async () => {
  const profile = mkdtempSync(join(tmpdir(), "anycode-fixture-test-"));
  let fixtures, double;
  try {
    fixtures = await createEngineSmokeFixtures(profile, { scripted: true });
    double = scriptedDouble(fixtures.binaries.codex);
    double.write({ id: 1, method: "thread/start", params: {} });
    await double.until(() => double.frames.find(frame => frame.id === 1));
    const header = JSON.stringify({ sender: "session:a", recipientSessionId: "b", messageId: "original-id", kind: "agent_message" });
    const turn = (id, text) => double.write({ id, method: "turn/start", params: { input: [{ type: "text", text: `[AnyCode authenticated agent message ${header}]\n${text}` }] } });
    const release = join(profile, "release");
    writeFileSync(join(profile, "codex-script.json"), JSON.stringify({
      reply: { kind: "explicit", trigger: "explicit-trigger", nonce: "explicit-reply" },
      hold: { trigger: "hold-trigger", releaseFile: release },
    }));
    turn(2, "explicit-trigger");
    const call = await double.until(() => double.frames.find(frame => frame.method === "item/tool/call"));
    assert.deepEqual(call.params.arguments, { replyTo: "original-id", payload: "explicit-reply" });
    double.write({ id: call.id, result: { success: true, contentItems: [] } });
    await double.until(() => double.frames.find(frame => frame.method === "turn/completed"));
    writeFileSync(join(profile, "codex-script.json"), JSON.stringify({
      reply: { kind: "automatic", trigger: "auto-trigger", nonce: "auto-reply" },
      hold: { trigger: "hold-trigger", releaseFile: release },
    }));
    turn(3, "hold-trigger");
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(double.frames.filter(frame => frame.method === "turn/completed").length, 1, "held turn finished early");
    writeFileSync(release, "");
    await double.until(() => double.frames.filter(frame => frame.method === "turn/completed").length === 2);
    turn(4, "auto-trigger");
    const delta = await double.until(() => double.frames.filter(frame => frame.method === "item/agentMessage/delta").at(-1)?.params.delta === "auto-reply");
    assert(delta);
    assert(existsSync(release));
  } finally {
    double?.child.kill();
    if (fixtures) await new Promise(resolve => fixtures.fixture.close(resolve));
    rmSync(profile, { recursive: true, force: true });
  }
});

test("scripted claude double holds its result until released and answers the reply marker", async () => {
  const profile = mkdtempSync(join(tmpdir(), "anycode-fixture-test-"));
  let fixtures, double;
  try {
    fixtures = await createEngineSmokeFixtures(profile, { scripted: true });
    double = scriptedDouble(fixtures.binaries.claude, true);
    const release = join(profile, "release");
    writeFileSync(join(profile, "claude-script.json"), JSON.stringify({
      reply: { kind: "automatic", trigger: "auto-trigger", nonce: "auto-reply" },
      hold: { trigger: "hold-trigger", releaseFile: release },
    }));
    const user = text => double.write({ type: "user", message: { role: "user", content: text } });
    const results = () => double.frames.filter(frame => frame.type === "result");
    user("hold-trigger");
    await double.until(() => double.frames.find(frame => frame.subtype === "init"));
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(results().length, 0, "held turn finished early");
    writeFileSync(release, "");
    await double.until(() => results().length === 1);
    user("auto-trigger");
    await double.until(() => results().length === 2);
    assert.equal(results()[1].result, "auto-reply");
    assert.equal(results()[0].result, "native fixture answer");
  } finally {
    double?.child.kill();
    if (fixtures) await new Promise(resolve => fixtures.fixture.close(resolve));
    rmSync(profile, { recursive: true, force: true });
  }
});
