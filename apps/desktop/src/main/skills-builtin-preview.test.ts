import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { builtinSettings, NodeSkillsFs } from "./skills-ipc.js";
const harness = vi.hoisted(() => ({ entry: "", stall: false }));
vi.mock("node:worker_threads", async () => {
  const { Worker } = await vi.importActual<typeof import("node:worker_threads")>("node:worker_threads");
  return { Worker: class extends Worker {
    constructor(_url: URL, options: import("node:worker_threads").WorkerOptions) {
      super(harness.stall ? "setInterval(() => {}, 1000)" : harness.entry, { ...options, ...(harness.stall ? { eval: true } : {}) });
    }
  } };
});
let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "builtin-preview-"));
  harness.entry = join(root, "worker.mjs");
  const source = await readFile(new URL("../host/skills/builtin-policy-worker.ts", import.meta.url), "utf8");
  await writeFile(harness.entry, ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } }).outputText);
});
afterEach(() => { harness.stall = false; vi.useRealTimers(); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const home = await mkdtemp(join(root, "case-"));
  const config = join(home, ".anycode/config.json");
  await mkdir(join(home, ".anycode"));
  const fs = new NodeSkillsFs();
  fs.readFile = async () => { throw new Error("unbounded preview read forbidden"); };
  return { config, read: () => builtinSettings({ home: () => home, workspaceForTab: () => undefined, fs, reveal() {} }) };
}
it("previews disabled IDs through the strict bounded worker, without the unbounded fs port", async () => {
  const f = await fixture();
  await writeFile(f.config, '{"skills":{"disabled":["anycode-setup"]}}');
  expect((await f.read()).builtins?.[0]).toMatchObject({ userDisabled: true, projectDisabled: false });
});
it.each([" ".repeat(1024 * 1024 + 1), '{"skills":{},"skills":{}}', '['.repeat(70) + ']'.repeat(70)])("refuses oversized, duplicate-key or deep preview input", async text => {
  const f = await fixture(); await writeFile(f.config, text);
  expect((await f.read()).builtinNotice).toContain("availability cannot be previewed");
});
it.each(["directory", "symlink"])("refuses a %s config", async kind => {
  const f = await fixture();
  if (kind === "directory") await mkdir(f.config);
  else { await writeFile(f.config + ".target", "{}"); await symlink(f.config + ".target", f.config); }
  expect((await f.read()).builtinNotice).toContain("availability cannot be previewed");
});
it("bounds preview worker latency", async () => {
  const f = await fixture(); harness.stall = true;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const pending = f.read(); await vi.advanceTimersByTimeAsync(5001);
  expect((await pending).builtinNotice).toContain("availability cannot be previewed");
});
