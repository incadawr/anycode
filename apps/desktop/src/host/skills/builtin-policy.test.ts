import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import ts from "typescript";
import { ENGINE_BUILTIN_SKILLS } from "../../shared/engine-skills.js";
import { builtinPolicyWorkerUrl, readBuiltinPolicy } from "./builtin-policy.js";

const harness = vi.hoisted(() => ({ entry: "", stall: false, script: "", terminated: 0, data: [] as unknown[], output: "" }));
vi.mock("node:worker_threads", async () => {
  const { Worker } = await vi.importActual<typeof import("node:worker_threads")>("node:worker_threads");
  return { Worker: class extends Worker {
    constructor(_url: URL, options: import("node:worker_threads").WorkerOptions) {
      harness.data.push(options.workerData);
      super(harness.script || (harness.stall ? "setInterval(() => {}, 1000)" : harness.entry),
        { ...options, ...(harness.stall || harness.script ? { eval: true } : {}) });
      this.stdout?.on("data", data => { harness.output += String(data); });
      this.stderr?.on("data", data => { harness.output += String(data); });
    }
    override terminate() { harness.terminated++; return super.terminate(); }
  } };
});
let root: string;
let user: string;
let project: string;
const ids = ENGINE_BUILTIN_SKILLS.map(s => s.id);
const read = (trusted = true) => readBuiltinPolicy({ userConfigPath: user, projectConfigPath: project, projectTrusted: trusted, ids });
const enabled = (result: Awaited<ReturnType<typeof read>>) => ids.map(id => result[id].enabled);
const refused = async (reason: string) => {
  const result = await read();
  expect(enabled(result)).toEqual([false, false, false]);
  expect(ids.map(id => result[id].reason)).toEqual([reason, reason, reason]);
};
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "builtin-policy-"));
  harness.entry = join(root, "worker.mjs");
  const source = await readFile(new URL("./builtin-policy-worker.ts", import.meta.url), "utf8");
  await writeFile(harness.entry, ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } }).outputText);
});
beforeEach(async () => {
  const dir = await mkdtemp(join(root, "case-"));
  user = join(dir, "user", ".anycode", "config.json"); project = join(dir, "project", ".anycode", "config.json");
  await mkdir(join(dir, "user", ".anycode"), { recursive: true });
  await mkdir(join(dir, "project", ".anycode"), { recursive: true });
  harness.data = []; harness.output = ""; harness.stall = false; harness.script = "";
});
afterAll(async () => { vi.useRealTimers(); await rm(root, { recursive: true, force: true }); });
it("enables absent files and valid objects without disabled", async () => {
  expect(enabled(await read())).toEqual([true, true, true]);
  await writeFile(user, '{"other":1,"skills":{}}');
  expect(enabled(await read())).toEqual([true, true, true]);
});
it("unions user/project source ids and ignores unrelated names", async () => {
  await writeFile(user, JSON.stringify({ skills: { disabled: [ids[0], "unknown"] } }));
  await writeFile(project, JSON.stringify({ skills: { disabled: [ids[1]] } }));
  const result = await read();
  expect(enabled(result)).toEqual([false, false, true]);
  expect(result["anycode-setup"].reason).toBe("disabled");
});
it.each(['', '{', 'null', '[]', '{"skills":null}', '{"skills":[]}',
  '{"skills":{"disabled":false}}', '{"skills":{"disabled":["ok",1]}}',
  '{"skills":{},"sk\\u0069lls":{}}', '{"other":{"x":1,"\\u0078":2}}',
  '{"skills":{"disabled":[],"disabled":[]}}', '{"x":NaN}', '{"x":01}'])
("refuses malformed, duplicate decoded keys or wrong types: %s", async raw => {
  await writeFile(user, raw); await refused("invalid-config");
});
it("does not send untrusted project location to worker; retains user disabled", async () => {
  await writeFile(user, JSON.stringify({ skills: { disabled: [ids[0]] } }));
  project = join(root, "credentials-DO-NOT-OPEN");
  expect(enabled(await read(false))).toEqual([false, true, true]);
  expect(JSON.stringify(harness.data)).not.toContain(project);
});
it("refuses symlink leaf and directory", async () => {
  await writeFile(project, '{}'); await symlink(project, user);
  await refused("unsafe-file");
  await rm(user); await mkdir(user); await refused("unsafe-file");
});
it("refuses FIFO without hanging", async () => {
  execFileSync("mkfifo", [user]); await refused("unsafe-file");
});
it("caps reads at one MiB, accepting the exact boundary", async () => {
  await writeFile(user, '{}' + ' '.repeat(1024 * 1024 - 2));
  expect(enabled(await read())).toEqual([true, true, true]);
  await writeFile(user, '{}' + ' '.repeat(1024 * 1024 - 1));
  await refused("too-large");
});
it("accepts depth 64 and refuses depth 65", async () => {
  await writeFile(user, '{"x":' + '['.repeat(63) + '0' + ']'.repeat(63) + '}');
  expect(enabled(await read())).toEqual([true, true, true]);
  await writeFile(user, '{"x":' + '['.repeat(64) + '0' + ']'.repeat(64) + '}');
  await refused("too-deep");
});
it("terminates a stalled worker after five seconds", async () => {
  vi.useFakeTimers(); harness.stall = true;
  const before = harness.terminated;
  const pending = read(); await vi.advanceTimersByTimeAsync(4999);
  expect(harness.terminated).toBe(before);
  await vi.advanceTimersByTimeAsync(1);
  expect(enabled(await pending)).toEqual([false, false, false]);
  expect((await pending)[ids[0]!].reason).toBe("timeout");
  expect(harness.terminated).toBe(before + 1); vi.useRealTimers();
});
it("never emits unrelated secret values, including parse failures", async () => {
  const sentinel = "SYNTHETIC_SECRET_SENTINEL";
  for (const suffix of ['}', ',"bad":}']) {
    await writeFile(user, '{"token":"' + sentinel + '"' + suffix);
    expect(JSON.stringify(await read()) + harness.output).not.toContain(sentinel);
  }
});

it.each(["throw new Error('SYNTHETIC_SECRET_SENTINEL')", "process.exit(0)",
  "require('node:worker_threads').parentPort.postMessage({disabled:['unknown']})"])
("refuses worker failures without propagating diagnostics: %s", async script => {
  harness.script = script;
  await refused("worker-error");
});
it("rejects credential or skill leaf locations before starting a worker", async () => {
  user = join(root, "auth.json");
  await refused("invalid-config");
  expect(harness.data).toEqual([]);
});
it("rejects invalid UTF-8 without leaking bytes", async () => {
  await writeFile(user, Buffer.from([0xff]));
  await refused("invalid-config");
});
it("still refuses invalid user config with untrusted project", async () => {
  await writeFile(user, '{');
  expect(enabled(await read(false))).toEqual([false, false, false]);
});

it("resolves worker from either build entry or shared chunk", () => {
  expect(String(builtinPolicyWorkerUrl("file:///app/out/main/host.js"))).toBe("file:///app/out/main/builtin-policy-worker.js");
  expect(String(builtinPolicyWorkerUrl("file:///app/out/main/chunks/shared.js"))).toBe("file:///app/out/main/builtin-policy-worker.js");
});
it("ignores a valid-shaped untrusted project while retaining user policy", async () => {
  await writeFile(project, JSON.stringify({ skills: { disabled: ids } }));
  expect(enabled(await read(false))).toEqual([true, true, true]);
  expect(JSON.stringify(harness.data)).not.toContain(project);
});
