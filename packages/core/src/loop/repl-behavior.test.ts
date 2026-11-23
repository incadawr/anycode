import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { NodeExecutionAdapter } from "../adapters/node/node-execution.js";
import { NodeFileSystemAdapter } from "../adapters/node/node-file-system.js";
import { NodeHttpAdapter } from "../adapters/node/node-http.js";
import { InMemoryHookRunner } from "../dispatch/hook-runner.js";
import { DenyPermissionBroker, ModePermissionEngine } from "../permissions/index.js";
import type { ModelRequest } from "../ports/model.js";
import type { ProviderTransport } from "../provider/catalog.js";
import { AiSdkModelPort } from "../provider/model-port.js";
import { createDefaultToolRegistry } from "../tools/registry.js";
import { InMemoryTodoStore } from "../tools/todo-store.js";
import { toToolDeclarations } from "../tools/to-model-tools.js";
import type { ChatMessage } from "../types/history.js";
import { AgentLoop } from "./agent-loop.js";

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

it("oneScriptChangesOnceAndExplainsFailedTest", async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "anycode-repl-behavior-")));
  try {
    const source = join(cwd, "retry.js");
    const readSentinel = "INTERMEDIATE_READ_7f2";
    const logSentinel = "FULL_TEST_LOG_c39";
    const before = "export const retryLimit = 3;\n// " + readSentinel + "\n" +
      "// fixture text longer than the persisted preview\n".repeat(300);
    await writeFile(source, before);
    await writeFile(join(cwd, "retry.test.mjs"), `
      import { appendFileSync, readFileSync } from "node:fs";
      appendFileSync("runs.txt", "run\\n");
      console.log(${JSON.stringify(logSentinel)} + " test output".repeat(1000));
      const text = readFileSync("retry.js", "utf8");
      const count = Number(text.match(/retryLimit = (\\d+)/)[1]);
      if (count !== 6) {
        console.log("Expected retry limit 6, received " + count);
        process.exitCode = 1;
      }
    `);
    const code = `
      const found = await call("Grep", {pattern:"retryLimit = 3", glob:"retry.js", output_mode:"content"});
      const hit = found.matches[0];
      const read = await call("Read", {file_path:hit.path});
      if (!read.content.includes("retryLimit = 3")) throw new Error("source changed");
      await call("Edit", {file_path:hit.path, old_string:"retryLimit = 3", new_string:"retryLimit = 5"});
      const result = await call("Bash", {command:"node retry.test.mjs"});
      return {exitCode:result.exitCode, tail:result.stdout.slice(-100)};
    `;
    const fs = new NodeFileSystemAdapter();
    const write = vi.spyOn(fs, "writeFile");
    const requests: ModelRequest[] = [];
    const loop = new AgentLoop({
      modelPort: {
        async *streamText(request) {
          requests.push(request);
          yield { type: "start" };
          if (requests.length === 1) {
            yield { type: "tool_call", toolCall: { id: "parent", name: "REPL", input: { code } } };
            yield { type: "finish", finishReason: "tool_calls", usage: {} };
          } else {
            yield { type: "finish", finishReason: "stop", usage: {} };
          }
        },
      },
      registry: createDefaultToolRegistry({ codeMode: true }),
      hooks: new InMemoryHookRunner(),
      permissionEngine: new ModePermissionEngine(),
      permissionBroker: new DenyPermissionBroker(),
      mode: "yolo", cwd,
      ports: { fs, exec: new NodeExecutionAdapter(), http: new NodeHttpAdapter(), todos: new InMemoryTodoStore() },
    });
    const events = await collect(loop.runTurn("Raise the retry limit to five and run the test."));
    expect(events.filter(event => event.type === "repl_call_start").map(event => event.toolName))
      .toEqual(["Grep", "Read", "Edit", "Bash"]);
    expect(events.filter(event => event.type === "tool_result")).toMatchObject([
      { outcome: { toolCallId: "parent", toolName: "REPL", status: "success" } },
    ]);
    expect(write).toHaveBeenCalledOnce();
    expect(await readFile(source, "utf8")).toBe(before.replace(" = 3", " = 5"));
    expect(await readFile(join(cwd, "runs.txt"), "utf8")).toBe("run\n");

    expect(requests).toHaveLength(2);
    const next = requests[1]!;
    expect(next.messages.filter(message => message.role === "assistant" || message.role === "tool")).toMatchObject([
      { role: "assistant", content: [{ type: "tool_call", toolCallId: "parent", toolName: "REPL" }] },
      { role: "tool", content: [{ type: "tool_result", toolCallId: "parent", toolName: "REPL",
        text: expect.stringContaining("Expected retry limit 6, received 5") }] },
    ]);
    const result = next.messages.find(message => message.role === "tool")!.content[0]!;
    expect(result.text).toContain('"exitCode": 1');
    expect(result.text).toContain('effects: Edit retry.js (1); Bash "node retry.test.mjs" exit 1');
    expect(JSON.stringify(next)).not.toMatch(new RegExp(readSentinel + "|" + logSentinel + "|parent\\.[1-4]"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

const transports: ProviderTransport[] = ["anthropic-messages", "openai-chat-completions", "openai-responses"];
it.each(transports)("serializes mixed historical REPL pairs with Code Mode off on %s", async transport => {
  const baseUrl = "https://code-mode-fixture.invalid/v1";
  const model = "fixture";
  const text = "stored-reasoning";
  const port = new AiSdkModelPort({
    transport, baseUrl, model, apiKey: "fixture",
    providerName: transport === "openai-chat-completions" ? "DeepSeek" : undefined,
    preserveReasoning: true, retry: { maxRetries: 0 },
  });
  const messages: ChatMessage[] = [
    { role: "user", content: "Update and verify." },
    { role: "assistant", content: [
      { type: "reasoning", text, source: port.reasoningReplaySource(), providerMetadata: {
        anthropic: { signature: "fixture-signature" },
        openai: { itemId: "rs_fixture", reasoningEncryptedContent: "fixture-encrypted-content" },
      } },
      { type: "tool_call", toolCallId: "call_repl", toolName: "REPL", input: { code: "return 42" } },
      { type: "tool_call", toolCallId: "call_read", toolName: "Read", input: { file_path: "retry.js" } },
    ] },
    { role: "tool", content: [
      { type: "tool_result", toolCallId: "call_repl", toolName: "REPL", text: "42", status: "success",
        presentation: { repl: { code: "presentation-only", calls: [] } } },
      { type: "tool_result", toolCallId: "call_read", toolName: "Read", text: "read-result", status: "success" },
    ] },
  ];
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { tools: unknown[]; messages?: unknown[]; input?: unknown[] };
    expect(JSON.stringify(body.tools)).not.toContain("REPL");
    const wire = JSON.stringify(body.messages ?? body.input);
    expect(wire).toContain(text);
    expect(wire).toContain("REPL");
    expect(wire).toContain("Read");
    expect(wire).toContain("42");
    expect(wire).toContain("read-result");
    expect(wire.match(/call_repl/g)).toHaveLength(2);
    expect(wire.match(/call_read/g)).toHaveLength(2);
    expect(wire).not.toContain("presentation-only");
    return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  });
  vi.stubGlobal("fetch", fetch);
  try {
    await collect(port.streamText({ messages, tools: toToolDeclarations(createDefaultToolRegistry()) }));
    expect(fetch).toHaveBeenCalledOnce();
    // The model port converts a failed fetch to an error event, so surface any
    // failed assertion from inside the fetch fixture here.
    await fetch.mock.results[0]!.value;
  } finally {
    vi.unstubAllGlobals();
  }
});
