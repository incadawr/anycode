/**
 * TASK.182 / Taskana 4136: one load, two forwards. `prepareEngineMcpForward`
 * loads the MCP server specs ONCE per boot via the existing core reader
 * `loadMcpServerSpecs` (project → user → .mcp.json precedence, resolved
 * env/headers, inherited env when requested) and serializes them for each
 * requested engine. Claude additionally gets a private 0600 file; Codex gets
 * the thread config map (sent later on thread/start / thread/resume).
 *
 * Every diagnostic this helper emits goes through mcp-forward-diagnostic.ts's
 * fixed templates: no source content, no loader strings, no values. Loader
 * problems surface even when every server was skipped or disabled — and
 * independently of whether either map is empty.
 */
import { unlinkSync } from "node:fs";
import type { FileSystemPort, McpServerSpec } from "@anycode/core";
import { loadMcpServerSpecs, type AgentEvent } from "@anycode/core";
import { buildClaudeMcpForwardDocument } from "./claude/mcp-forward.js";
import { materializeMcpForwardFile, sweepOrphanedMcpForwardFiles } from "./claude/mcp-forward-file.js";
import { buildCodexThreadMcpServers } from "./codex/mcp-thread-config.js";
import { mcpForwardLoaderNotices, mcpForwardProblemNotices, type McpForwardProblem } from "./mcp-forward-diagnostic.js";

export interface PrepareEngineMcpForwardOptions {
  fs: FileSystemPort;
  workspace: string;
  home: string;
  tmpDir: string;
  pid: number;
  /** Which engines this boot forwards for; at least one is expected. */
  engines: ReadonlyArray<"claude" | "codex">;
}

export interface PreparedEngineMcpForward {
  /** Serialized Claude document JSON, or null when nothing survived. */
  claudeJson: string | null;
  /** Absolute path of the materialized private file, or null. */
  claudeConfigPath: string | null;
  /** Codex thread config map (untyped on purpose: engine-layer shape), or null. */
  codexServers: Record<string, unknown> | null;
  /** Forwarded server names per engine, in spec order. */
  claudeNames: string[];
  codexNames: string[];
  /** Controlled, secret-free warnings to drain on the first turn. */
  notices: AgentEvent[];
  /** Idempotent cleanup for the materialized Claude file (no-op when null). */
  cleanupFile: () => void;
}

/**
 * Loads the specs once and prepares both engines' forward payloads. Never
 * throws on loader/serializer problems — those become controlled notices.
 * A materialization failure of the private file IS thrown (as the generic
 * secret-safe McpForwardFileError) so the boot can abort rather than run
 * Claude with --strict-mcp-config and no servers.
 */
export async function prepareEngineMcpForward(
  opts: PrepareEngineMcpForwardOptions,
): Promise<PreparedEngineMcpForward> {
  const specs: McpServerSpec[] = [];
  let loaderProblemCount = 0;
  try {
    const loaded = await loadMcpServerSpecs(opts.fs, opts.workspace, opts.home);
    specs.push(...loaded.specs);
    loaderProblemCount = loaded.problems.length;
  } catch {
    // The loader is fail-soft by contract; an unexpected throw is still just
    // "some configured MCP servers could not be loaded".
    loaderProblemCount = Math.max(loaderProblemCount, 1);
  }

  const problems: McpForwardProblem[] = [];
  const wantsClaude = opts.engines.includes("claude");
  const wantsCodex = opts.engines.includes("codex");

  const claude = wantsClaude ? buildClaudeMcpForwardDocument(specs) : null;
  if (claude !== null) problems.push(...claude.problems);
  const codex = wantsCodex ? buildCodexThreadMcpServers(specs) : null;
  if (codex !== null) problems.push(...codex.problems);

  const notices: AgentEvent[] = [
    ...mcpForwardLoaderNotices({ problemCount: loaderProblemCount }),
    ...mcpForwardProblemNotices(problems),
  ];

  let claudeConfigPath: string | null = null;
  let cleanupFile = (): void => {};
  if (claude !== null && claude.json !== null) {
    // Remove dead-pid leftovers from previous host runs before creating ours.
    sweepOrphanedMcpForwardFiles(opts.tmpDir, { pid: opts.pid });
    const materialized = materializeMcpForwardFile(claude.json, { tmpDir: opts.tmpDir, pid: opts.pid });
    claudeConfigPath = materialized.path;
    let cleaned = false;
    cleanupFile = (): void => {
      if (cleaned) return;
      cleaned = true;
      cleanupForwardPath(materialized.path);
    };
  }

  return {
    claudeJson: claude?.json ?? null,
    claudeConfigPath,
    codexServers: codex?.servers ?? null,
    claudeNames: claude?.names ?? [],
    codexNames: codex?.names ?? [],
    notices,
    cleanupFile,
  };
}

export { sweepOrphanedMcpForwardFiles };

/**
 * TASK.182: names we expected in the first `system/init.mcp_servers[]` but
 * the CLI did not report. Expected = the forwarded server names PLUS the
 * in-band "anycode" bridge name when a bridge exists (a child boot or a
 * bridge-less tab never expects it). Pure — the host logs a controlled
 * warning per missing NAME; values and paths never enter this seam.
 */
export function missingForwardedMcpServerNames(
  reported: readonly string[],
  forwarded: readonly string[],
  bridgePresent: boolean,
): string[] {
  const expected = bridgePresent ? [...forwarded, "anycode"] : [...forwarded];
  const seen = new Set(reported);
  return expected.filter((name) => !seen.has(name));
}

function cleanupForwardPath(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // idempotent no-op
  }
}
