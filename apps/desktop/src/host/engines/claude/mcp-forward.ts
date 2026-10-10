/**
 * TASK.182 / Taskana 4136: serializes core-resolved MCP server specs into the
 * Claude Code `--mcp-config` JSON document.
 *
 * Grammar (version-matched probe evidence, planner P1–P7):
 *  - stdio server  -> { "command": …, "args": […], "env": {…} }  (never `cwd`:
 *    Claude ignores an MCP server's cwd, so a server that CONFIGURED one is
 *    skipped with a controlled notice rather than silently run in the wrong
 *    directory)
 *  - http server   -> { "type": "http", "url": …, "headers": {…}? }
 *  - resolved env (including explicitly requested inheritEnv) is passed
 *    VERBATIM: the authorized private 0600 file is the transport for those
 *    values, and none of them may ever be logged.
 *  - the reserved name "anycode" (the in-band bridge server) and dangerous
 *    object keys are skipped with controlled notices.
 *
 * `--strict-mcp-config` plus this file means ONLY our configured servers (and
 * the unchanged in-band anycode bridge, announced separately via
 * `sdkMcpServers`) apply.
 */
import type { McpHttpServerSpec, McpServerSpec, McpStdioServerSpec } from "@anycode/core";
import type { McpForwardProblem } from "../mcp-forward-diagnostic.js";

/** Reserved for AnyCode's own in-band MCP bridge (mcp-bridge.ts). */
export const CLAUDE_MCP_RESERVED_NAME = "anycode";

export interface ClaudeMcpServerJson {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface ClaudeMcpHttpServerJson {
  type: "http";
  url: string;
  headers?: Record<string, string>;
}

export interface ClaudeMcpForwardDocument {
  mcpServers: Record<string, ClaudeMcpServerJson | ClaudeMcpHttpServerJson>;
}

export interface ClaudeMcpForwardResult {
  /** null when zero servers survived the skip rules — no --mcp-config at all. */
  json: string | null;
  /** Forwarded server names, in spec order. */
  names: string[];
  /** Controlled problems (rendered by mcp-forward-diagnostic.ts, never here). */
  problems: McpForwardProblem[];
}

/**
 * A key is "dangerous" when it could alter the JSON document's shape rather
 * than name a server (prototype pollution into the parsed object) or is empty.
 */
function isSafeServerKey(key: string): boolean {
  return key.length > 0 && key !== "__proto__" && key !== "constructor" && key !== "prototype";
}

function isSafeRecord(record: Record<string, string>): boolean {
  for (const key of Object.keys(record)) {
    if (!isSafeServerKey(key)) return false;
  }
  return true;
}

export function buildClaudeMcpForwardDocument(specs: readonly McpServerSpec[]): ClaudeMcpForwardResult {
  const servers: Record<string, ClaudeMcpServerJson | ClaudeMcpHttpServerJson> = {};
  const names: string[] = [];
  const problems: McpForwardProblem[] = [];
  for (const spec of specs) {
    if (spec.name === CLAUDE_MCP_RESERVED_NAME) {
      problems.push({ kind: "reserved-name", server: spec.name });
      continue;
    }
    if (!isSafeServerKey(spec.name)) {
      problems.push({ kind: "dangerous-key", server: "<unnamed>" });
      continue;
    }
    if (spec.kind === "stdio") {
      const stdio = spec as McpStdioServerSpec;
      if (stdio.cwd !== undefined) {
        // Claude ignores MCP cwd — running the server in the wrong directory
        // is worse than not running it.
        problems.push({ kind: "claude-cwd-unsupported", server: spec.name });
        continue;
      }
      if (!isSafeRecord(stdio.env)) {
        problems.push({ kind: "dangerous-key", server: spec.name });
        continue;
      }
      servers[spec.name] = { command: stdio.command, args: [...stdio.args], env: { ...stdio.env } };
      names.push(spec.name);
      continue;
    }
    const http = spec as McpHttpServerSpec;
    if (http.headers !== undefined && !isSafeRecord(http.headers)) {
      problems.push({ kind: "dangerous-key", server: spec.name });
      continue;
    }
    const entry: ClaudeMcpHttpServerJson = { type: "http", url: http.url };
    if (http.headers !== undefined) entry.headers = { ...http.headers };
    servers[spec.name] = entry;
    names.push(spec.name);
  }
  return {
    json: names.length > 0 ? JSON.stringify({ mcpServers: servers }) : null,
    names,
    problems,
  };
}
