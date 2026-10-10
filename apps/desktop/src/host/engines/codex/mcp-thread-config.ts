/**
 * TASK.182 / Taskana 4136: serializes core-resolved MCP server specs into the
 * `config.mcp_servers` map sent on Codex app-server `thread/start` /
 * `thread/resume` (version-matched Codex 0.144.x probe evidence P1–P7).
 *
 * Grammar:
 *  - stdio server -> { command, args, env, cwd? }  (resolved cwd is PRESERVED —
 *    Codex honors per-server cwd; probe v144-cwd.json observed it applied)
 *  - http server  -> { url, http_headers? }  (core `headers` is RENAMED to the
 *    Codex key `http_headers`; schema acceptance alone does not prove a key,
 *    the rename is pinned by probe-144.js)
 *
 * Native Codex ambient per-name merge stays: our supplied map wins collisions,
 * entries absent from the map keep whatever the profile config.toml provides.
 * Each product boot uses a fresh app-server, so an empty (absent) map cannot
 * resurrect a previously forwarded map. Never write profile config.toml and
 * never put secrets on argv — the map rides the existing JSON-RPC pipe.
 */
import type { McpHttpServerSpec, McpServerSpec, McpStdioServerSpec } from "@anycode/core";
import type { McpForwardProblem } from "../mcp-forward-diagnostic.js";

export interface CodexMcpStdioServer {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
}

export interface CodexMcpHttpServer {
  url: string;
  http_headers?: Record<string, string>;
}

export interface CodexMcpThreadConfigResult {
  /** null when zero servers survived — `config` is omitted from the request. */
  servers: Record<string, CodexMcpStdioServer | CodexMcpHttpServer> | null;
  names: string[];
  problems: McpForwardProblem[];
}

function isSafeServerKey(key: string): boolean {
  return key.length > 0 && key !== "__proto__" && key !== "constructor" && key !== "prototype";
}

function isSafeRecord(record: Record<string, string>): boolean {
  for (const key of Object.keys(record)) {
    if (!isSafeServerKey(key)) return false;
  }
  return true;
}

export function buildCodexThreadMcpServers(specs: readonly McpServerSpec[]): CodexMcpThreadConfigResult {
  const servers: Record<string, CodexMcpStdioServer | CodexMcpHttpServer> = {};
  const names: string[] = [];
  const problems: McpForwardProblem[] = [];
  for (const spec of specs) {
    if (!isSafeServerKey(spec.name)) {
      problems.push({ kind: "dangerous-key", server: "<unnamed>" });
      continue;
    }
    if (spec.kind === "stdio") {
      const stdio = spec as McpStdioServerSpec;
      if (!isSafeRecord(stdio.env)) {
        problems.push({ kind: "dangerous-key", server: spec.name });
        continue;
      }
      const entry: CodexMcpStdioServer = { command: stdio.command, args: [...stdio.args], env: { ...stdio.env } };
      if (stdio.cwd !== undefined) entry.cwd = stdio.cwd;
      servers[spec.name] = entry;
      names.push(spec.name);
      continue;
    }
    const http = spec as McpHttpServerSpec;
    if (http.headers !== undefined && !isSafeRecord(http.headers)) {
      problems.push({ kind: "dangerous-key", server: spec.name });
      continue;
    }
    const entry: CodexMcpHttpServer = { url: http.url };
    if (http.headers !== undefined) entry.http_headers = { ...http.headers };
    servers[spec.name] = entry;
    names.push(spec.name);
  }
  return {
    servers: names.length > 0 ? servers : null,
    names,
    problems,
  };
}
