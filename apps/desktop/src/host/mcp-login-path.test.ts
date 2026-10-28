import { describe, expect, it } from "vitest";
import { discoverLoginPath, mcpProblemStatuses } from "./mcp-login-path.js";

describe("MCP startup diagnostics", () => {
  it("reads PATH from a login shell", async () => {
    const path = await discoverLoginPath({ ...process.env, SHELL: "/bin/sh", PATH: "/custom/bin:/usr/bin:/bin" });
    expect(path).toContain("/custom/bin");
  });
  it("exposes skipped entries as failed status rows", () => {
    expect(mcpProblemStatuses(["MCP server 'broken' in config: invalid entry"])).toMatchObject([{ name: "broken", state: "failed", error: expect.stringContaining("invalid entry") }]);
  });
});
