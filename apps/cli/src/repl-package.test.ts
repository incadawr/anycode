import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { SqlitePersistenceAdapter } from "../../../packages/core/src/adapters/node/sqlite-persistence.js";

const execFileAsync = promisify(execFile);
const cliRoot = fileURLToPath(new URL("../", import.meta.url));
const runtimePackages = [
  "quickjs-emscripten-core",
  "@jitl/quickjs-singlefile-mjs-release-sync",
];

function packageDependencies(relative: string): Record<string, string> {
  return (JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8")) as {
    dependencies: Record<string, string>;
  }).dependencies;
}

it("pins the same singlefile runtime in CLI production dependencies", () => {
  const core = packageDependencies("../../../packages/core/package.json");
  const cli = packageDependencies("../package.json");
  for (const name of runtimePackages) {
    expect(cli[name]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(cli[name]).toBe(core[name]);
  }
});

async function withInstalledCLI(
  check: (cwd: string, installed: string, env: NodeJS.ProcessEnv) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "anycode-repl-package-"));
  const env = { ...process.env };
  delete env.NODE_PATH;
  delete env.NODE_OPTIONS;
  const pnpm = async (cwd: string, args: string[]) => {
    const shell = process.platform === "win32";
    // A cold store download of the tarball's dependency tree can exceed 2 minutes.
    const timeout = args[0] === "add" ? 240_000 : 120_000;
    try {
      await execFileAsync("pnpm", shell ? args.map(arg => `"${arg}"`) : args, {
        cwd, env, shell, timeout,
      });
    } catch (error) {
      const failure = error as Error & { stdout?: string; stderr?: string };
      throw new Error([failure.message, failure.stdout].filter(Boolean).join("\n"));
    }
  };
  try {
    await pnpm(cliRoot, ["run", "build"]);
    await pnpm(cliRoot, ["pack", "--pack-destination", root]);
    const tarball = (await readdir(root)).find(name => name.endsWith(".tgz"));
    expect(tarball).toBeDefined();
    const { packageManager } = JSON.parse(
      readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
    ) as { packageManager: string };
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true, packageManager }));
    await pnpm(root, ["add", "--ignore-scripts", "--store-dir", join(root, "store"), join(root, tarball!)]);
    await check(root, join(root, "node_modules", "@anycode", "cli"), env);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

it.runIf(process.env.ANYCODE_REPL_PACKAGE_SMOKE === "1")(
  "tarballLoadsSinglefileOutsideRepo",
  async () => {
    await withInstalledCLI(async (cwd, installed, env) => {
      const program = `
        import { Worker } from "node:worker_threads";
        import { pathToFileURL } from "node:url";
        const worker = new Worker(pathToFileURL(process.argv[1]), {
          execArgv: [],
          workerData: new BigInt64Array(new SharedArrayBuffer(16)),
        });
        const result = await new Promise((resolve, reject) => {
          worker.on("error", reject);
          worker.on("message", event => {
            if (event.type === "ready") worker.postMessage({ type: "run", source: "return 42;", cwd: process.cwd() });
            else resolve(event);
          });
        });
        await worker.terminate();
        console.log(JSON.stringify(result));
      `;
      const { stdout } = await execFileAsync(process.execPath, [
        "--input-type=module", "--eval", program, join(installed, "dist", "runtime-worker.js"),
      ], { cwd, env, timeout: 20_000 });
      expect(JSON.parse(stdout)).toMatchObject({
        type: "result", result: { endReason: "ok", value: "42" },
      });
    });
  },
  420_000,
);

function fixtureResponse(step: number, code: string): string {
  const tool = step === 1;
  const chunks = [
    { type: "message_start", message: {
      id: `msg_${step}`, type: "message", role: "assistant", content: [], model: "fixture",
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 8, output_tokens: 0 },
    } },
    { type: "content_block_start", index: 0, content_block: tool
      ? { type: "tool_use", id: "repl_call", name: "REPL", input: {} }
      : { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: tool
      ? { type: "input_json_delta", partial_json: JSON.stringify({ code, description: "Update retries" }) }
      : { type: "text_delta", text: "Done." } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } },
    { type: "message_stop" },
  ];
  return chunks.map(chunk => `event: ${chunk.type}\ndata: ${JSON.stringify(chunk)}\n\n`).join("");
}

it.runIf(process.env.ANYCODE_REPL_PACKAGE_SMOKE === "1")(
  "installedBinPrintsOneParent",
  async () => {
    await withInstalledCLI(async (root, installed, env) => {
      const cwd = join(root, "workspace");
      const profile = join(root, "profile");
      await mkdir(cwd);
      await mkdir(profile);
      const source = join(cwd, "retry.js");
      const before = "export const retryLimit = 3;\n";
      await writeFile(source, before);
      await writeFile(join(cwd, "retry.test.cjs"), `
        const {appendFileSync,readFileSync} = require("node:fs");
        appendFileSync("runs.txt","run\\n");
        const text = readFileSync("retry.js","utf8");
        const count = Number(text.match(/retryLimit = (\\d+)/)[1]);
        if (count !== 6) {
          console.log("Expected retry limit 6, received " + count);
          process.exitCode = 1;
        }
      `);
      const code = [
        'const g = await call("Grep", {pattern:"retryLimit = 3", glob:"retry.js", output_mode:"content"});',
        'const r = await call("Read", {file_path:g.matches[0].path});',
        'if (!r.content.includes("retryLimit = 3")) throw new Error("Unexpected source");',
        'await call("Edit", {file_path:g.matches[0].path, old_string:"retryLimit = 3", new_string:"retryLimit = 5"});',
        'const run = await call("Bash", {command:"node retry.test.cjs"});',
        'return {exitCode:run.exitCode, failure:run.stdout.trim()};',
      ].join("\n");
      const requests: Array<{ tools?: Array<{ name: string }>; messages: unknown[] }> = [];
      const server = createServer((req, res) => {
        let body = "";
        req.setEncoding("utf8");
        req.on("data", chunk => { body += chunk; });
        req.on("end", () => {
          requests.push(JSON.parse(body));
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(fixtureResponse(requests.length, code));
        });
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      try {
        const cliEnv: NodeJS.ProcessEnv = {
          PATH: env.PATH, SystemRoot: env.SystemRoot, TMPDIR: env.TMPDIR, TEMP: env.TEMP,
          HOME: profile, USERPROFILE: profile,
          ANYCODE_SETTINGS_PATH: join(profile, "settings.json"),
          ANYCODE_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
          ANYCODE_API_KEY: "fixture",
          ANYCODE_MODEL: "fixture",
          ANYCODE_PROVIDER_TRANSPORT: "anthropic-messages",
          ANYCODE_EXPERIMENTAL_CODE_MODE: "1",
        };
        const bin = join(installed, "bin", "anycode.js");
        const run = (args: string[], flag: "0" | "1" = "1") => execFileAsync(process.execPath, [bin, ...args], {
          cwd, env: { ...cliEnv, ANYCODE_EXPERIMENTAL_CODE_MODE: flag }, timeout: 30_000,
        });
        const { stdout, stderr } = await run([
          "--yolo", "--no-checkpoints", "--no-color", "--verbose",
          "--output-format", "stream-json", "--print", "Raise the retry limit and run the test.",
        ]);
        const frames: Array<{
          type: string;
          toolCallId?: string;
          callId?: string;
          toolName?: string;
          toolCall?: { id: string; name: string };
          outcome?: { toolCallId?: string; toolName: string; modelText?: string; status: string };
        }> = stdout.trim().split("\n").map(line => JSON.parse(line));
        expect(frames[0]).toMatchObject({ type: "init" });
        expect(frames.at(-1)).toMatchObject({ type: "result", result: "Done." });
        expect(frames.filter(frame => frame.type === "tool_call").map(frame => frame.toolCall))
          .toMatchObject([{ id: "repl_call", name: "REPL" }]);
        expect(frames.filter(frame => frame.type === "tool_result")).toMatchObject([
          { outcome: { toolCallId: "repl_call", status: "success", modelText: expect.stringContaining("Expected retry limit 6, received 5") } },
        ]);
        const methods = ["Grep", "Read", "Edit", "Bash"];
        expect(frames.filter(frame => frame.type.startsWith("repl_call_"))).toMatchObject(methods.flatMap((toolName, index) => {
          const callId = `repl_call.${index + 1}`;
          return [
            { type: "repl_call_start", toolCallId: "repl_call", callId, toolName },
            { type: "repl_call_end", toolCallId: "repl_call", callId, outcome: { toolName, status: "success" } },
          ];
        }));
        expect(stderr).toContain("Code Mode (experimental) is on");
        expect(stderr).toContain("● REPL Update retries");
        expect(stderr).toContain(code);
        expect(stderr).toContain("↳ Edit (success,");
        expect(stdout).not.toContain("Code Mode (experimental) is on");
        expect(await readFile(source, "utf8")).toBe(before.replace(" = 3", " = 5"));
        expect(await readFile(join(cwd, "runs.txt"), "utf8")).toBe("run\n");
        expect(requests).toHaveLength(2);
        expect(requests[0]!.tools?.some(tool => tool.name === "REPL")).toBe(true);
        expect(JSON.stringify(requests[1]!.messages)).toContain("Expected retry limit 6, received 5");

        const off = await run(["--no-color", "--print", "Say done."], "0");
        expect(off.stdout).toBe("Done.");
        expect(off.stderr).not.toContain("Code Mode (experimental) is on");
        expect(requests[2]!.tools?.some(tool => tool.name === "REPL")).toBe(false);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
    });
  },
  420_000,
);

it.runIf(process.env.ANYCODE_REPL_PACKAGE_SMOKE === "1")(
  "installedInterruptedRunResumesWithOneOutcome",
  async () => {
    await withInstalledCLI(async (root, installed, env) => {
      const cwd = join(root, "workspace");
      const profile = join(root, "profile");
      await mkdir(cwd);
      await mkdir(profile);
      await writeFile(join(cwd, "crash.txt"), "before\n");
      const code = 'await call("Edit", {file_path:"crash.txt", old_string:"before", new_string:"after"}); await call("Bash", {command:"sleep 30"});';
      // Only the first run asks for the REPL script; resumed runs answer with text.
      let resuming = false;
      const server = createServer((req, res) => {
        req.resume();
        req.on("end", () => {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(fixtureResponse(resuming ? 2 : 1, code));
        });
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const cliEnv: NodeJS.ProcessEnv = {
        PATH: env.PATH, SystemRoot: env.SystemRoot, TMPDIR: env.TMPDIR, TEMP: env.TEMP,
        HOME: profile, USERPROFILE: profile,
        ANYCODE_SETTINGS_PATH: join(profile, "settings.json"),
        ANYCODE_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        ANYCODE_API_KEY: "fixture", ANYCODE_MODEL: "fixture",
        ANYCODE_PROVIDER_TRANSPORT: "anthropic-messages",
        ANYCODE_DB_PATH: join(profile, "history.sqlite"),
        ANYCODE_EXPERIMENTAL_CODE_MODE: "1",
      };
      const bin = join(installed, "bin", "anycode.js");
      const child = spawn(process.execPath, [bin, "--yolo", "--output-format", "stream-json", "-p", "crash"], {
        cwd, env: cliEnv, stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", chunk => { output += String(chunk); });
      child.stderr.resume();
      const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
      try {
        const deadline = Date.now() + 60_000;
        while ((await readFile(join(cwd, "crash.txt"), "utf8")) !== "after\n") {
          if (child.exitCode !== null || Date.now() > deadline) throw new Error("installed CLI did not edit before the deadline");
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        const init = JSON.parse(output.split("\n").find(line => line.includes('"type":"init"'))!) as { sessionId: string };
        child.kill("SIGKILL");
        await exited;
        resuming = true;
        for (let index = 0; index < 2; index++) {
          await execFileAsync(process.execPath, [bin, "--resume", init.sessionId, "-p", "continue"], {
            cwd, env: { ...cliEnv, ANYCODE_EXPERIMENTAL_CODE_MODE: "0" }, timeout: 60_000,
          });
        }
        const db = new SqlitePersistenceAdapter(join(profile, "history.sqlite"));
        try {
          const history = JSON.stringify(await db.loadHistory(init.sessionId));
          expect(history.match(/Some actions may have completed/g)).toHaveLength(1);
        } finally {
          await db.close();
        }
        expect(await readFile(join(cwd, "crash.txt"), "utf8")).toBe("after\n");
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await exited;
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
    });
  },
  420_000,
);

it.runIf(process.env.ANYCODE_REPL_PACKAGE_SMOKE === "1")(
  "installedPrintWithoutYoloDeniesNestedEditOnce",
  async () => {
    await withInstalledCLI(async (root, installed, env) => {
      const cwd = join(root, "workspace");
      const profile = join(root, "profile");
      await mkdir(cwd);
      await mkdir(profile);
      const source = join(cwd, "retry.js");
      await writeFile(source, "export const retryLimit = 3;\n");
      const code = 'await call("Edit", {file_path:"retry.js", old_string:"retryLimit = 3", new_string:"retryLimit = 5"}); return "unreachable";';
      let requests = 0;
      const server = createServer((req, res) => {
        req.resume();
        req.on("end", () => {
          requests += 1;
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(fixtureResponse(requests, code));
        });
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      try {
        const { stdout, stderr } = await execFileAsync(process.execPath, [
          join(installed, "bin", "anycode.js"), "--output-format", "stream-json", "-p", "Raise the retry limit.",
        ], {
          cwd,
          env: {
            PATH: env.PATH, SystemRoot: env.SystemRoot, TMPDIR: env.TMPDIR, TEMP: env.TEMP,
            HOME: profile, USERPROFILE: profile,
            ANYCODE_SETTINGS_PATH: join(profile, "settings.json"),
            ANYCODE_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
            ANYCODE_API_KEY: "fixture", ANYCODE_MODEL: "fixture",
            ANYCODE_PROVIDER_TRANSPORT: "anthropic-messages",
            ANYCODE_EXPERIMENTAL_CODE_MODE: "1",
          },
          timeout: 60_000,
        });
        expect(await readFile(source, "utf8")).toBe("export const retryLimit = 3;\n");
        const frames = stdout.trim().split("\n").map(line => JSON.parse(line) as { type: string; outcome?: { toolName?: string; status?: string } });
        expect(frames[0]).toMatchObject({ type: "init" });
        expect(frames.filter(frame => frame.type === "repl_call_end")).toHaveLength(1);
        expect(frames.filter(frame => frame.type === "repl_call_end")[0]).toMatchObject({
          outcome: { toolName: "Edit", status: "denied" },
        });
        expect(stderr).not.toContain('"type":"init"');
        // One model request asks for the script; a second carries the denied result back.
        expect(requests).toBe(2);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
    });
  },
  420_000,
);
