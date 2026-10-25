/**
 * Adapter smoke (Taskana 4750a): a real `process.execPath -e` child that exits
 * on its own — stdout and stderr arrive as text and the exit code is reported.
 * No long-lived process is started here.
 */
import { describe, expect, it } from "vitest";
import { spawnServiceProcess } from "./service-process.js";
import type { ServiceSpawnSpec } from "./service-supervisor.js";

describe("spawnServiceProcess (real child, short-lived)", () => {
  it("delivers stdout and stderr as text and reports the exit code", async () => {
    const spec: ServiceSpawnSpec = {
      command: process.execPath,
      args: ["-e", "process.stdout.write('hi\\n'); process.stderr.write('oops\\n')"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    };
    const proc = spawnServiceProcess(spec);
    const out: string[] = [];
    const err: string[] = [];
    const exit = new Promise<number | null>((resolve, reject) => {
      proc.onStdout((c) => out.push(c));
      proc.onStderr((c) => err.push(c));
      proc.onError(reject);
      proc.onExit((code) => resolve(code));
    });
    expect(await exit).toBe(0);
    expect(out.join("")).toBe("hi\n");
    expect(err.join("")).toBe("oops\n");
  });
});
