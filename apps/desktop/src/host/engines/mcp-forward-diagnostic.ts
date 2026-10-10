/**
 * TASK.182 / Taskana 4136: controlled diagnostics for engine MCP forwarding.
 *
 * The serializers (claude/mcp-forward.ts, codex/mcp-thread-config.ts) and the
 * boot helper (mcp-forward-boot.ts) NEVER forward raw loader problems, zod /
 * parser messages, arbitrary exception text, or config values to the console
 * or the renderer: those strings can quote config file content (including
 * secret-bearing ${env:...} fragments). Everything user-visible comes from
 * this module's FIXED templates over a closed set of categories, naming at
 * most a server name and an unsupported field.
 */
import type { AgentEvent } from "@anycode/core";

/** The closed set of serializer problems a forwarded server can produce. */
export type McpForwardProblem =
  /** A stdio server carries a configured `cwd`, which Claude's --mcp-config ignores. */
  | { kind: "claude-cwd-unsupported"; server: string }
  /** The reserved bridge server name ("anycode") was configured by the user. */
  | { kind: "reserved-name"; server: string }
  /** A map key that cannot be represented safely in the target config. */
  | { kind: "dangerous-key"; server: string }
  /** An entry is neither a valid stdio nor a valid http server. */
  | { kind: "unusable-entry"; server: string };

/**
 * Controlled loader failure flag. Loader `problems[]` strings are untrusted
 * (they quote config content); the diagnostic layer collapses them into ONE
 * fixed generic warning, surfaced even when every server was skipped or
 * disabled — silence would read as "everything forwarded".
 */
export interface McpForwardLoaderFailure {
  /** >0 means "some configured MCP source reported problems"; never the strings. */
  problemCount: number;
}

function warning(message: string): AgentEvent {
  return { type: "engine_notice", level: "warning", message };
}

/**
 * Renders loader failures as controlled warnings. The count is safe (a
 * number); no loader string, file path remainder, or config value appears.
 */
export function mcpForwardLoaderNotices(failure: McpForwardLoaderFailure | null | undefined): AgentEvent[] {
  if (!failure || failure.problemCount <= 0) return [];
  return [
    failure.problemCount === 1
      ? warning("Some configured MCP servers could not be loaded and were skipped.")
      : warning(`Some configured MCP servers could not be loaded and were skipped (${failure.problemCount} problems).`),
  ];
}

/**
 * Renders serializer problems as controlled warnings. Each template names at
 * most the server and the unsupported field/reason — never a value, never a
 * config path, never a raw error message.
 */
export function mcpForwardProblemNotice(problem: McpForwardProblem): AgentEvent {
  switch (problem.kind) {
    case "claude-cwd-unsupported":
      return warning(
        `MCP server "${problem.server}" sets a working directory, which this engine does not support for MCP servers; the server was skipped.`,
      );
    case "reserved-name":
      return warning(
        `MCP server name "${problem.server}" is reserved for AnyCode's own bridge and cannot be forwarded; the server was skipped.`,
      );
    case "dangerous-key":
      return warning(
        `MCP server "${problem.server}" has a configuration key that cannot be forwarded safely; the server was skipped.`,
      );
    case "unusable-entry":
      return warning(
        `MCP server "${problem.server}" is not a usable stdio or http server configuration and was skipped.`,
      );
  }
}

export function mcpForwardProblemNotices(problems: readonly McpForwardProblem[]): AgentEvent[] {
  return problems.map(mcpForwardProblemNotice);
}
