import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

type Probe = {
  name: string;
  source: string;
  endReason: string;
};

const probes: Probe[] = [
  { name: "loop", source: "while(true){}", endReason: "limit" },
  { name: "regex", source: '/(a+)+$/.test("a".repeat(40)+"b")', endReason: "limit" },
  { name: "allocation", source: "return new ArrayBuffer(1024 ** 3);", endReason: "limit" },
  { name: "stalled", source: "await new Promise(() => {});", endReason: "stalled" },
  { name: "stack", source: "function recurse() { recurse(); } recurse();", endReason: "limit" },
  { name: "busy-abort", source: 'await call("Bash", {}); while(true){}', endReason: "cancelled" },
  { name: "abort", source: 'await call("Bash", {});', endReason: "cancelled" },
];

let fixtureDir: string | undefined;
let runtimeUrl: string;

beforeAll(async () => {
  // Exercise the shipped JS-worker path and exclude the development TS loader
  // from steady-state RSS sampling across repeated worker creation.
  const { default: ts } = await import("typescript");
  const dir = fixtureDir = await mkdtemp(join(tmpdir(), "anycode-repl-stress-"));
  const dependencies = fileURLToPath(new URL("../../node_modules", import.meta.url));
  await Promise.all([
    writeFile(join(dir, "package.json"), '{"type":"module"}'),
    symlink(dependencies, join(dir, "node_modules"), process.platform === "win32" ? "junction" : "dir"),
    ...["runtime", "runtime-worker"].map(async (name) => {
      const source = await readFile(new URL(`./${name}.ts`, import.meta.url), "utf8");
      const { outputText } = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 },
      });
      await writeFile(join(dir, `${name}.js`), outputText);
    }),
  ]);
  runtimeUrl = pathToFileURL(join(dir, "runtime.js")).href;
});

afterAll(async () => {
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
});

const childProgram = () => `
  import { warmCodeModeWorker, runCodeMode } from ${JSON.stringify(runtimeUrl)};
  const probe = JSON.parse(process.argv[1]);
  await warmCodeModeWorker();
  const abortedRun = () => {
    const controller = new AbortController();
    return {
      signal: controller.signal,
      dispatch: () => {
        setImmediate(() => controller.abort());
        return new Promise(() => {});
      },
    };
  };
  process.stdout.write("ready\\n");
  const start = performance.now();
  let elapsed, endReason, rss;
  if (probe.name === "mixed") {
    const runs = [
      ["return { answer: 42 };", "ok"],
      ["throw new Error('boom');", "uncaught"],
      ["let x = ;", "syntax"],
      ["await new Promise(() => {});", "stalled"],
      ['await call("Bash", {});', "cancelled"],
    ];
    rss = [];
    for (let i = 0; i < 500; i++) {
      const [source, expected] = runs[i % runs.length];
      const actual = await runCodeMode(source, "/", expected === "cancelled" ? abortedRun() : {});
      if (actual.endReason !== expected) throw new Error(JSON.stringify({ i, actual, expected }));
      if ((i + 1) % 50 === 0) {
        global.gc();
        rss.push(process.memoryUsage.rss());
        process.stderr.write("completed " + (i + 1) + " mixed runs\\n");
      }
    }
    elapsed = performance.now() - start;
  } else {
    let options = {};
    if (probe.name === "abort") options = abortedRun();
    if (probe.name === "busy-abort") {
      const controller = new AbortController();
      options = { signal: controller.signal, dispatch: async () => {
        setTimeout(() => controller.abort(), 50);
        return { status: "ok", output: null };
      } };
    }
    if (probe.name === "long-dispatch") {
      options = {
        dispatch: () => new Promise(resolve =>
          setTimeout(() => resolve({ status: "ok", output: 42 }), 2300)),
      };
    }
    const result = await runCodeMode(probe.source, "/", options);
    elapsed = performance.now() - start;
    endReason = result.endReason;
  }
  console.log(JSON.stringify({ elapsed, endReason, rss }));
  const control = await runCodeMode("return 42;", "/");
  console.log(JSON.stringify(control.value));
`;

interface Measurement {
  elapsed: number;
  endReason?: string;
  rss?: number[];
  control: string;
}

async function executeProbe(probe: Pick<Probe, "name"> & Partial<Probe>): Promise<Measurement> {
  const child = spawn(process.execPath, [
    "--expose-gc", "--input-type=module", "--eval", childProgram(), JSON.stringify(probe),
  ], { stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((resolve, reject) => {
    let output = "";
    let stderr = "";
    let timeout: ReturnType<typeof setTimeout>;
    let started: number | undefined;
    let measured = false;
    function watchdog(ms: number) {
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        child.kill("SIGKILL");
        const phase = started === undefined
          ? "startup" : measured ? "control" : `eval at ${(performance.now() - started).toFixed(0)} ms`;
        reject(new Error(`${probe.name}: watchdog killed probe during ${phase}\n${stderr}`));
      }, ms);
    }
    watchdog(8_000);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
      if (started === undefined && output.startsWith("ready\n")) {
        started = performance.now();
        watchdog(probe.name === "mixed" ? 25_000 : probe.name === "long-dispatch" ? 5_000 : 2_600);
      }
      const lines = output.split("\n");
      if (started !== undefined && !measured && lines.length >= 3) {
        measured = true;
        watchdog(8_000);
      }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      if (code !== 0 || started === undefined) {
        reject(new Error(`${probe.name}: probe exited ${code ?? signal}\n${stderr.slice(0, 1_000)}`));
        return;
      }
      try {
        const [, result, control] = output.split("\n");
        resolve({ ...JSON.parse(result!), control: JSON.parse(control!) } as Measurement);
      } catch (error) {
        reject(error);
      }
    });
  });
}

describe("stopsWithin2200msAndSurvives500Runs", () => {
  it.each(probes)("$name stops and leaves a working VM", async (probe) => {
    const measurement = await executeProbe(probe);
    console.log(probe.name, measurement);
    expect(measurement.control).toBe("42");
    expect(measurement.endReason).toBe(probe.endReason);
    expect(measurement.elapsed).toBeLessThanOrEqual(probe.name === "busy-abort" ? 1_000 : 2_200);
  }, 18_000);

  it("allows a dispatch longer than the entire active JS budget", async () => {
    const measurement = await executeProbe({ name: "long-dispatch", source: 'return await call("Bash", {});' });
    console.log("long-dispatch", measurement);
    expect(measurement.elapsed).toBeGreaterThanOrEqual(2_300);
    expect(measurement.endReason).toBe("ok");
    expect(measurement.control).toBe("42");
  }, 18_000);

  it("stabilizes RSS after mixed success, failures and aborts", async () => {
    const measurement = await executeProbe({ name: "mixed" });
    console.log("mixed", measurement);
    expect(measurement.control).toBe("42");
    expect(measurement.rss).toHaveLength(10);
    const settled = measurement.rss!.slice(3);
    const median = (samples: number[]) => samples.sort((a, b) => a - b)[1]!;
    // Reject sustained growth. In a busy test suite the OS can reclaim
    // resident pages between samples without changing the live heap.
    const growth = median(settled.slice(-3)) - median(settled.slice(0, 3));
    expect(growth).toBeLessThanOrEqual(16 * 1024 ** 2);
  }, 35_000);
});
