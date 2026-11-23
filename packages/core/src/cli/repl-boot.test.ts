import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import { SqlitePersistenceAdapter, WriteBehindHistorySink } from "../adapters/node/sqlite-persistence.js";
import { ConversationHistory, INTERRUPTED_REPL_MESSAGE } from "../context/history.js";
import type { ModelRequest } from "../ports/model.js";
import { runCli } from "./main.js";
import { CODE_MODE_REMINDER } from "../prompts/code-mode-reminder.js";

async function withProfile(check: (fixture: Awaited<ReturnType<typeof createProfile>>) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "anycode-repl-boot-")));
  try {
    await check(await createProfile(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function createProfile(root: string) {
  const cwd = join(root, "project");
  const home = join(root, "home");
  const settings = join(home, ".anycode", "settings.json");
  const dbPath = join(root, "sessions.sqlite");
  await mkdir(cwd);
  await mkdir(join(home, ".anycode"), { recursive: true });
  await writeFile(settings, '{"tools":{"codeMode":true}}');
  const env: NodeJS.ProcessEnv = {
    ANYCODE_API_KEY: "test-key",
    ANYCODE_MODEL: "fixture",
    ANYCODE_DB_PATH: dbPath,
    ANYCODE_SETTINGS_PATH: settings,
  };
  async function run(args: string[], code?: string, override?: string) {
    const frames: ModelRequest[] = [];
    const output = new PassThrough();
    const errorOutput = new PassThrough();
    let stdout = "";
    let stderr = "";
    output.on("data", chunk => { stdout += String(chunk); });
    errorOutput.on("data", chunk => { stderr += String(chunk); });
    const exit = await runCli({
      argv: [...args, "-p", "check state"], cwd, home,
      env: { ...env, ANYCODE_EXPERIMENTAL_CODE_MODE: override },
      input: new PassThrough(), output, errorOutput,
      modelPort: {
        async *streamText(request) {
          frames.push(request);
          yield { type: "start" };
          if (code !== undefined && frames.length === 1) {
            yield { type: "tool_call", toolCall: { id: "fresh", name: "REPL", input: { code } } };
            yield { type: "finish", finishReason: "tool_calls", usage: {} };
          } else {
            yield { type: "text_delta", id: "answer", text: "Done." };
            yield { type: "finish", finishReason: "stop", usage: {} };
          }
        },
      },
    });
    expect(exit).toBe(0);
    return { stdout, stderr, frames };
  }
  return { cwd, home, env, dbPath, run };
}

it("passes Code Mode to CLI native children only while enabled", async () => {
  await withProfile(async ({ cwd, home, env }) => {
    for (const enabled of [true, false]) {
      const frames: ModelRequest[] = [];
      let spawned = false;
      const exit = await runCli({
        argv: ["--yolo", "-p", "delegate"], cwd, home,
        env: { ...env, ANYCODE_EXPERIMENTAL_CODE_MODE: enabled ? "1" : "0" },
        input: new PassThrough(), output: new PassThrough(), errorOutput: new PassThrough(),
        modelPort: { async *streamText(request) {
          frames.push(request);
          yield { type: "start" };
          if (!spawned) {
            spawned = true;
            yield { type: "tool_call", toolCall: { id: "agent", name: "Agent", input: { agent_type: "general-purpose", description: "child", prompt: "child task" } } };
            yield { type: "finish", finishReason: "tool_calls", usage: {} };
          } else {
            yield { type: "text_delta", id: "t", text: "done" };
            yield { type: "finish", finishReason: "stop", usage: {} };
          }
        } },
      });
      expect(exit).toBe(0);
      const child = frames.find(frame => frame.system?.includes("child task") === false && frame.messages.some(message => message.role === "user" && typeof message.content === "string" && message.content.startsWith("child task")));
      expect(child).toBeDefined();
      expect(child!.tools.some(tool => tool.name === "REPL")).toBe(enabled);
      expect(JSON.stringify(child!.messages).includes(CODE_MODE_REMINDER)).toBe(enabled);
    }
  });
}, 20_000);

it("resumeOffRepairsOnceAndPrintDenies: repairs a durable parent exactly once with the flag off", async () => {
  await withProfile(async ({ cwd, dbPath, run }) => {
    const db = new SqlitePersistenceAdapter(dbPath);
    try {
      await db.createSession({ id: "fixture", workspace: cwd, model: "fixture", mode: "build" });
      await db.touchSession("fixture", { title: "Fixture" });
      const history = new ConversationHistory({ sink: new WriteBehindHistorySink(db, "fixture") });
      history.append({ role: "user", content: "write once" });
      history.append({ role: "assistant", content: [{
        type: "tool_call", toolCallId: "interrupted", toolName: "REPL",
        input: { code: 'await call("Write", {file_path:"replayed.txt", content:"unexpected"});' },
      }] }, { turnId: "interrupted-turn", step: 1 });
      await history.flushChecked();
    } finally {
      await db.close();
    }

    const { frames, stdout, stderr } = await run(["--resume", "fixture"], "return 42", "0");
    const again = await run(["--resume", "fixture"], undefined, "0");
    for (const requests of [frames, again.frames]) {
      expect(requests[0]!.tools.map(tool => tool.name)).not.toContain("REPL");
      expect(requests[0]!.messages.flatMap(message => message.role === "tool" ? message.content : [])
        .filter(result => result.toolCallId === "interrupted")).toMatchObject([
        { status: "cancelled", text: INTERRUPTED_REPL_MESSAGE },
      ]);
    }
    expect(frames[1]!.messages.at(-1)).toMatchObject({ role: "tool", content: [{
      toolCallId: "fresh", status: "error", text: "Unknown tool: REPL.",
    }] });
    expect(stdout).toBe("Done.");
    expect(stderr).not.toContain("Code Mode (experimental) is on");
    await expect(readFile(join(cwd, "replayed.txt"))).rejects.toMatchObject({ code: "ENOENT" });

    const reloaded = new SqlitePersistenceAdapter(dbPath);
    try {
      const persisted = await reloaded.loadHistory("fixture");
      expect(persisted.filter(item => item.message.role === "tool" &&
        item.message.content.some(result => result.toolCallId === "interrupted")))
        .toMatchObject([{ turnId: "interrupted-turn", step: 1 }]);
      expect(await reloaded.getRootSession("fixture")).not.toHaveProperty("codeMode");
    } finally {
      await reloaded.close();
    }
  });
}, 20_000);

it("resumeOffRepairsOnceAndPrintDenies: build denies headless asks and explicit yolo keeps its broker", async () => {
  await withProfile(async ({ cwd, run }) => {
    const code = 'await call("Write", {file_path:"result.txt", content:"done"});';
    const build = await run([], code);
    const parent = build.frames.at(-1)!.messages.at(-1);
    expect(parent).toMatchObject({ role: "tool", content: [{
      type: "tool_result", toolName: "REPL", status: "error",
      text: expect.stringMatching(/denied/i),
    }] });
    expect(build.stdout).toBe("Done.");
    expect(build.stderr).toContain("Code Mode (experimental) is on");
    await expect(readFile(join(cwd, "result.txt"))).rejects.toMatchObject({ code: "ENOENT" });

    const yolo = await run(["--yolo"], code, "1");
    expect(yolo.frames[0]!.tools.some(tool => tool.name === "REPL")).toBe(true);
    expect(yolo.frames.at(-1)!.messages.at(-1)).toMatchObject({ role: "tool", content: [{
      toolName: "REPL", status: "success",
    }] });
    expect(await readFile(join(cwd, "result.txt"), "utf8")).toBe("done");
  });
}, 20_000);
