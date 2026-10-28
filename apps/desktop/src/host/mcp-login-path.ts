import { execFile } from "node:child_process";

/** Read only PATH from the login shell; never forward the shell environment. */
export function discoverLoginPath(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  if (process.platform === "win32" || !env.SHELL) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile(env.SHELL!, ["-ilc", "printf \"\\n__ANYCODE_PATH__%s\\n\" \"$PATH\""],
      { env, timeout: 5000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
        if (error) return resolve(undefined);
        const match = stdout.match(/(?:^|\n)__ANYCODE_PATH__([^\n]+)\n/);
        resolve(match?.[1]);
      });
  });
}

export function mcpProblemStatuses(problems: string[]): import("@anycode/core").McpServerStatus[] {
  return problems.map((problem) => ({
    name: /^MCP server '([^']+)'/.exec(problem)?.[1] ?? "MCP config",
    transport: "stdio", state: "failed", toolCount: 0, toolsTruncated: false, error: problem,
  }));
}
