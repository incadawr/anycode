import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeExecutionAdapter } from "../adapters/node/node-execution.js";
import { NodeFileSystemAdapter } from "../adapters/node/node-file-system.js";
import { NodeHttpAdapter } from "../adapters/node/node-http.js";
import { InMemoryTodoStore } from "./todo-store.js";
import type { ToolContext } from "../types/tools.js";
import { readTool } from "./read.js";
import { DEFAULT_TOOL_RESULT_BUDGET, READ_MAX_TOKENS } from "../types/config.js";
import { estimateTokens } from "../util/tokens.js";

const fs = new NodeFileSystemAdapter();
const exec = new NodeExecutionAdapter();

function ctxFor(cwd: string): ToolContext {
  return { toolCallId: "t1", abortSignal: new AbortController().signal, cwd, ports: { fs, exec, http: new NodeHttpAdapter(), todos: new InMemoryTodoStore() } };
}

describe("readTool", () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  it("reads the full content of a file", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "anycode-read-"));
    const filePath = join(tmpDir, "a.txt");
    await fs.writeFile(filePath, "line1\nline2\nline3");

    const result = await readTool.handler({ file_path: filePath }, ctxFor(tmpDir));

    expect(result.ok).toBe(true);
    expect(result.output?.content).toBe("line1\nline2\nline3");
    expect(result.output?.truncated).toBe(false);
    expect(result.output?.totalLines).toBe(3);
  });

  it("applies offset/limit line windowing", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "anycode-read-"));
    const filePath = join(tmpDir, "a.txt");
    await fs.writeFile(filePath, "l1\nl2\nl3\nl4\nl5");

    const result = await readTool.handler({ file_path: filePath, offset: 1, limit: 2 }, ctxFor(tmpDir));

    expect(result.ok).toBe(true);
    expect(result.output?.content).toBe("l2\nl3");
    expect(result.output?.truncated).toBe(true);
  });

  it("returns a handler error for a missing file", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "anycode-read-"));

    const result = await readTool.handler({ file_path: join(tmpDir, "missing.txt") }, ctxFor(tmpDir));

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  // TASK.93 §4: a whole-file Read is the sharpest unbounded path into the
  // request, so the tool caps itself in tokens before the dispatcher ever
  // budgets bytes.
  describe("token cap", () => {
    // ~40 chars/line * 30k lines ≈ 400k estimated tokens, far over the cap.
    const hugeFile = (): string =>
      Array.from({ length: 30_000 }, (_, i) => `line ${i} ${"x".repeat(32)}`).join("\n");

    it("returns a partial view with a continuation notice when no window was asked for", async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "anycode-read-"));
      const filePath = join(tmpDir, "big.txt");
      await fs.writeFile(filePath, hugeFile());

      const result = await readTool.handler({ file_path: filePath }, ctxFor(tmpDir));

      expect(result.ok).toBe(true);
      expect(result.output?.truncated).toBe(true);
      expect(estimateTokens(result.output?.content ?? "")).toBeLessThanOrEqual(READ_MAX_TOKENS);
      expect(result.output?.totalLines).toBe(30_000);
      expect(result.output?.notice).toBeTruthy();
      // The notice must carry a usable continuation, not just a complaint.
      expect(result.output?.notice).toMatch(/offset \d+/);
      expect(result.output?.notice).toMatch(/limit \d+/);
    });

    it("continues exactly where the notice says, without re-reading the same lines", async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "anycode-read-"));
      const filePath = join(tmpDir, "big.txt");
      await fs.writeFile(filePath, hugeFile());

      const first = await readTool.handler({ file_path: filePath }, ctxFor(tmpDir));
      const offset = Number(/offset (\d+)/.exec(first.output?.notice ?? "")?.[1]);
      const limit = Number(/limit (\d+)/.exec(first.output?.notice ?? "")?.[1]);
      const next = await readTool.handler({ file_path: filePath, offset, limit }, ctxFor(tmpDir));

      const firstLines = (first.output?.content ?? "").split("\n");
      const nextLines = (next.output?.content ?? "").split("\n");
      expect(next.ok).toBe(true);
      expect(nextLines[0]).toBe(`line ${firstLines.length} ${"x".repeat(32)}`);
    });

    it("fails honestly when an explicitly requested window does not fit", async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "anycode-read-"));
      const filePath = join(tmpDir, "big.txt");
      await fs.writeFile(filePath, hugeFile());

      const result = await readTool.handler(
        { file_path: filePath, offset: 0, limit: 30_000 },
        ctxFor(tmpDir),
      );

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/offset/);
      expect(result.error).toMatch(new RegExp(String(READ_MAX_TOKENS)));
    });

    it("cuts inside the line when the first line alone is over the cap", async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "anycode-read-"));
      const filePath = join(tmpDir, "bundle.min.js");
      await fs.writeFile(filePath, "a".repeat(500_000));

      const result = await readTool.handler({ file_path: filePath }, ctxFor(tmpDir));

      expect(result.ok).toBe(true);
      expect(result.output?.content.length).toBeGreaterThan(0);
      expect(estimateTokens(result.output?.content ?? "")).toBeLessThanOrEqual(READ_MAX_TOKENS);
      expect(result.output?.notice).toBeTruthy();
    });

    it("cuts a single long line on a code-point boundary", async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "anycode-read-"));
      const filePath = join(tmpDir, "bundle.min.js");
      // The leading char shifts the cut off the UTF-16 pair boundary.
      await fs.writeFile(filePath, `x${"😀".repeat(200_000)}`);

      const result = await readTool.handler({ file_path: filePath }, ctxFor(tmpDir));

      expect(result.ok).toBe(true);
      expect(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
          result.output?.content ?? "",
        ),
      ).toBe(false);
    });

    it("keeps a Cyrillic partial view inside the default model budget", async () => {
      // 400k Cyrillic chars: the estimator charges a third of a token each, but
      // the wire charges two BYTES each — a token-only cap lets ~127 KB through.
      tmpDir = await mkdtemp(join(tmpdir(), "anycode-read-"));
      const filePath = join(tmpDir, "doc.md");
      await fs.writeFile(filePath, Array.from({ length: 4_000 }, () => "я".repeat(100)).join("\n"));

      const result = await readTool.handler({ file_path: filePath }, ctxFor(tmpDir));

      expect(result.ok).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(result.output), "utf8")).toBeLessThanOrEqual(
        DEFAULT_TOOL_RESULT_BUDGET.maxModelBytes,
      );
    });

    it("puts the continuation advice ahead of the content, where a head-cut cannot eat it", async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "anycode-read-"));
      const filePath = join(tmpDir, "big.txt");
      await fs.writeFile(filePath, hugeFile());

      const result = await readTool.handler({ file_path: filePath }, ctxFor(tmpDir));

      expect(JSON.stringify(result.output).slice(0, 600)).toMatch(/offset \d+/);
    });

    it("leaves a file under the cap untouched", async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "anycode-read-"));
      const filePath = join(tmpDir, "small.txt");
      await fs.writeFile(filePath, "line1\nline2");

      const result = await readTool.handler({ file_path: filePath }, ctxFor(tmpDir));

      expect(result.output?.content).toBe("line1\nline2");
      expect(result.output?.truncated).toBe(false);
      expect(result.output?.notice).toBeUndefined();
    });
  });
});
