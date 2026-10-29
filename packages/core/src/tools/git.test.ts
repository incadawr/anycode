import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ToolContext } from "../types/tools.js";
import { gitTool } from "./git.js";

const context = (): ToolContext => ({ toolCallId: "git-test", cwd: "/workspace", abortSignal: new AbortController().signal, ports: {} as ToolContext["ports"] });

describe("Git tool", () => {
  it("declares a strict object schema without execution escape hatches", () => {
    const schema = z.toJSONSchema(gitTool.inputSchema);
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties).not.toHaveProperty("argv");
    expect(schema.properties).not.toHaveProperty("cwd");
    expect(schema.properties).not.toHaveProperty("env");
    expect(schema.properties).not.toHaveProperty("config");
  });
  it("fails clearly when no capability is provided", async () => {
    const result = await gitTool.handler({ operation: "status" }, context());
    expect(result.ok).toBe(false); expect(result.error).toContain("unavailable");
  });
  it("passes the current workspace and cancellation signal to the capability", async () => {
    const ctx = context();
    const read = vi.fn().mockResolvedValue({ status: "completed", exitCode: 0, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false });
    ctx.ports.gitRead = { read };
    expect((await gitTool.handler({ operation: "branch" }, ctx)).ok).toBe(true);
    expect(read).toHaveBeenCalledWith({ operation: "branch" }, ctx.cwd, ctx.abortSignal);
  });
});
