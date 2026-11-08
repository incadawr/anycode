/** Shared credential-free executable and loopback fixtures for isolated GUI smoke. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, statSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";

/** The doubles read a session-peer script only when `<profile>/<engine>-script.json` exists. */
export async function createEngineSmokeFixtures(profile) {
  const fixturePath = fileURLToPath(new URL("../src/host/engine-switch-fixtures/native-double.mjs", import.meta.url));
  const binaries = {};
  const consents = [];
  for (const engine of ["codex", "claude"]) {
    const binary = join(profile, `${engine}-double`);
    const source = readFileSync(fixturePath, "utf8").replace(/^#![^\n]*\n/, "");
    const prefix = `#!${realpathSync(process.execPath)}\nprocess.argv.push("--double-orchestration", ${JSON.stringify(`--double-log=${join(profile, `${engine}.jsonl`)}`)}${engine === "claude" ? ', "--double-claude"' : ""});\n`;
    writeFileSync(binary, prefix + source, { mode: 0o700 });
    const stat = statSync(binary);
    consents.push({ path: realpathSync(binary), fingerprint: { mode: stat.mode, uid: stat.uid, gid: stat.gid, size: stat.size, mtimeMs: stat.mtimeMs }, grantedAt: new Date().toISOString() });
    binaries[engine] = binary;
  }
  let providerCalls = 0;
  const providerInputs = [];
  const fixture = createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      if (request.method === "GET") { response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ data: [{ id: "core-model" }] })); return; }
      const input = JSON.parse(body);
      assert(["core-model","core-other"].includes(input.model));
      providerCalls++;
      providerInputs.push(input.messages);
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      const base = { id: "local-fixture", object: "chat.completion.chunk", created: 0, model: input.model };
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "core fixture answer" }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise((resolve, reject) => { fixture.once("error", reject); fixture.listen(0, "127.0.0.1", resolve); });
  const baseUrl = `http://127.0.0.1:${fixture.address().port}/v1`;
  return { binaries, consents, fixture, baseUrl, providerInputs, get providerCalls() { return providerCalls; } };
}

/** Shared renderer operations for isolated fixture drivers. */
export async function evaluateSmoke(cdp, expression) {
  const result = await cdp.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}

export async function selectSmokeEngine(evaluate, wait, engine) {
  assert(["core", "codex", "claude"].includes(engine));
  await evaluate("document.querySelector('button[aria-label=\"Switch engine\"]').click()");
  const label = engine === "core" ? "Core ·" : engine === "codex" ? "Codex ·" : "Claude ·";
  await wait(() => evaluate(`!![...document.querySelectorAll('select[aria-label="Target engine and model"] option')].find(option => option.textContent.startsWith(${JSON.stringify(label)}))`));
  await evaluate(`(() => {const select = document.querySelector('select[aria-label="Target engine and model"]'); select.value = [...select.options].find(option => option.textContent.startsWith(${JSON.stringify(label)})).value; select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await evaluate("[...document.querySelectorAll('[role=dialog] button')].find(button => button.textContent === 'Switch engine').click()");
}
