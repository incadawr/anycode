import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeExecutionAdapter } from "../adapters/node/node-execution.js";
import { NodeFileSystemAdapter } from "../adapters/node/node-file-system.js";
import { NodeHttpAdapter } from "../adapters/node/node-http.js";
import type { ToolContext } from "../types/tools.js";
import { bashTool } from "./bash.js";
import { InMemoryTodoStore } from "./todo-store.js";

const fs = new NodeFileSystemAdapter();
const exec = new NodeExecutionAdapter();

function ctxFor(cwd: string, overrides?: Partial<ToolContext>): ToolContext {
  return {
    toolCallId: "t1",
    abortSignal: new AbortController().signal,
    cwd,
    ports: { fs, exec, http: new NodeHttpAdapter(), todos: new InMemoryTodoStore() },
    ...overrides,
  };
}

describe("bashTool", () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  it("runs a command and reports stdout/exit code", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "anycode-bash-"));
    const result = await bashTool.handler({ command: "echo hi-there" }, ctxFor(tmpDir));

    expect(result.ok).toBe(true);
    expect(result.output?.status).toBe("completed");
    expect(result.output?.exitCode).toBe(0);
    expect(result.output?.stdout).toContain("hi-there");
  });

  it("treats a non-zero exit code as a completed (not handler-failed) run", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "anycode-bash-"));
    const result = await bashTool.handler({ command: "exit 7" }, ctxFor(tmpDir));

    expect(result.ok).toBe(true);
    expect(result.output?.status).toBe("failed");
    expect(result.output?.exitCode).toBe(7);
  });

  it(
    "honors a per-call timeout override and reports timed_out",
    async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "anycode-bash-"));
      const result = await bashTool.handler({ command: "sleep 5", timeout: 200 }, ctxFor(tmpDir));

      expect(result.ok).toBe(false);
      expect(result.output?.status).toBe("timed_out");
      expect(result.error).toMatch(/timed_out/);
    },
    10_000,
  );

  it(
    "propagates ctx.abortSignal and reports cancelled",
    async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "anycode-bash-"));
      const controller = new AbortController();
      const handlerPromise = bashTool.handler(
        { command: "sleep 5" },
        ctxFor(tmpDir, { abortSignal: controller.signal }),
      );
      setTimeout(() => controller.abort(), 200);

      const result = await handlerPromise;

      expect(result.ok).toBe(false);
      expect(result.output?.status).toBe("cancelled");
    },
    10_000,
  );
});
