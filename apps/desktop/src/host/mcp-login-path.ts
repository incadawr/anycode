import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { delimiter, join } from "node:path";
import { redactSecrets, type McpServerSpec, type McpServerStatus } from "@anycode/core";
import { mcpForwardProblemNotice, type McpForwardProblem } from "./engines/mcp-forward-diagnostic.js";

/** How long the login-shell probe may take before the directory fallback takes over. */
const SHELL_PROBE_TIMEOUT_MS = 5000;

/**
 * Conventional launcher directories a login shell typically adds to PATH
 * (`npx`/`uvx`/`node` installed by Homebrew, nvm, volta, asdf, pipx, cargo…).
 * Used only when the login shell cannot be asked — the shell's own answer
 * always wins, because it is the one a terminal uses.
 */
function conventionalBinDirs(home: string): string[] {
  return [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/opt/local/bin",
    join(home, ".local/bin"),
    join(home, ".cargo/bin"),
    join(home, ".bun/bin"),
    join(home, ".volta/bin"),
    join(home, ".asdf/shims"),
    join(home, ".npm-global/bin"),
    join(home, "Library/pnpm"),
  ];
}

/** nvm's per-version bin dirs, newest first (numeric compare — `v9` is older than `v20`). */
function nvmBinDirs(home: string): string[] {
  const root = join(home, ".nvm", "versions", "node");
  let versions: string[];
  try {
    versions = readdirSync(root);
  } catch {
    return [];
  }
  const numeric = (value: string): number => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value);
    return match ? Number(match[1]) * 1e6 + Number(match[2]) * 1e3 + Number(match[3]) : -1;
  };
  return versions
    .sort((a, b) => numeric(b) - numeric(a))
    .map((version) => join(root, version, "bin"));
}

/**
 * Discovery failure fallback (GitHub #3): the minimal GUI PATH plus the
 * conventional launcher directories, deduplicated in place. A server whose
 * launcher lives in one of those directories still starts when the login-shell
 * probe is unavailable (no `SHELL`, a failing shell, or a timeout).
 */
function fallbackLoginPath(env: NodeJS.ProcessEnv, home: string): string {
  const entries = [
    ...(env.PATH ?? "").split(delimiter).filter(Boolean),
    ...conventionalBinDirs(home),
    ...nvmBinDirs(home),
  ];
  return [...new Set(entries)].join(delimiter);
}

/**
 * Resolves the user's PATH the way a terminal sees it: ask the login shell,
 * read ONLY the PATH line back, and never forward the shell environment.
 * Falls back to the conventional launcher directories when the shell cannot
 * answer (GitHub #3 — a Dock-launched app gets `/usr/bin:/bin:/usr/sbin:/sbin`).
 */
export async function discoverLoginPath(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  if (process.platform === "win32") return env.PATH;
  const home = env.HOME || homedir();
  let accountShell: string | undefined;
  try {
    accountShell = userInfo().shell || undefined;
  } catch {
    // No passwd entry (containers, odd sandboxes): rely on the fallback.
  }
  const shell = env.SHELL || accountShell;
  const found = shell
    ? await new Promise<string | undefined>((resolve) => {
        execFile(
          shell,
          ["-ilc", 'printf "\\n__ANYCODE_PATH__%s\\n" "$PATH"'],
          { env, timeout: SHELL_PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
          (error, stdout) => {
            if (error) {
              resolve(undefined);
              return;
            }
            resolve(stdout.match(/(?:^|\n)__ANYCODE_PATH__([^\n]+)\n/)?.[1]);
          },
        );
      })
    : undefined;
  return found || fallbackLoginPath(env, home);
}

/**
 * Loader `problems[]` → failed status rows (GitHub #3 gap 2). A skipped entry
 * never becomes a spec, so it never appears in `McpManager.status()`; this is
 * the only channel that makes it visible. Loader strings name at most a server,
 * a config path, an env-var name and a zod field — never a resolved value (the
 * JSON parse diagnostic is deliberately content-free, and refs fail closed).
 */
export function mcpProblemStatuses(problems: readonly string[]): McpServerStatus[] {
  return problems.map((problem) => ({
    name: /^MCP server '([^']+)'/.exec(problem)?.[1] ?? "MCP config",
    transport: "stdio",
    state: "failed",
    toolCount: 0,
    toolsTruncated: false,
    error: problem,
  }));
}

function transportOf(specs: readonly McpServerSpec[], name: string): "stdio" | "http" {
  return specs.find((spec) => spec.name === name)?.kind ?? "stdio";
}

/**
 * Codex's `mcpServer/startupStatus/updated` notification → a status row for the
 * Settings pane (GitHub #3 — engine sessions spawn the forwarded servers
 * themselves, so their failures never reach `McpManager`). Unknown methods,
 * malformed params and servers we did not forward are ignored. The engine's
 * `error` text is child output and is redacted against the server's resolved
 * environment values before it can reach the renderer.
 */
export function codexMcpStatus(
  notification: { method: string; params?: unknown },
  specs: readonly McpServerSpec[],
): McpServerStatus | undefined {
  if (notification.method !== "mcpServer/startupStatus/updated") return undefined;
  if (!notification.params || typeof notification.params !== "object") return undefined;
  const params = notification.params as Record<string, unknown>;
  if (typeof params.name !== "string") return undefined;
  const spec = specs.find((item) => item.name === params.name);
  if (!spec) return undefined;
  const reported = params.status;
  const state = reported === "ready" ? "connected" : reported === "failed" || reported === "cancelled" ? "failed" : "connecting";
  const reason =
    typeof params.error === "string" && params.error !== ""
      ? params.error
      : params.failureReason === "reauthenticationRequired"
        ? "the server needs re-authentication"
        : "server startup failed";
  return {
    name: params.name,
    transport: spec.kind,
    state,
    toolCount: 0,
    toolsTruncated: false,
    ...(state === "failed" ? { error: redactSecrets(reason, spec.secretValues ?? []) } : {}),
  };
}

/**
 * The one ACTIONABLE next step for a Claude-side MCP failure. The CLI's
 * `system/init` names a status per server and nothing else — no spawn error, no
 * exit code, no stderr — so AnyCode cannot report a reason it never receives.
 * The row says exactly that and points at the CLI's own listing, which does.
 */
const CLAUDE_MCP_SEE_REASON = "Claude does not report the reason; run `claude mcp list` to see it";

/**
 * Claude's `system/init` MCP report → status rows (GitHub #3). The CLI reports a
 * status for every server it started, and simply omits the ones it could not
 * start — the `missing` list (computed from `mcpServerNames` against what we
 * forwarded) covers that half. Claude's report carries no error text, so the row
 * states what is known (the server is not running) and where the reason lives,
 * rather than implying a diagnostic we do not have.
 */
export function claudeMcpStatuses(
  reported: readonly { name: string; status: string | null }[],
  missing: readonly string[],
  specs: readonly McpServerSpec[],
): McpServerStatus[] {
  const rows: McpServerStatus[] = reported.map(({ name, status }) => {
    const failed = status === "failed" || status === "needs-auth";
    return {
      name,
      transport: transportOf(specs, name),
      state: status === "connected" ? "connected" : failed ? "failed" : "connecting",
      toolCount: 0,
      toolsTruncated: false,
      ...(failed
        ? {
            error:
              status === "needs-auth"
                ? "Claude needs authentication for this server (run `claude mcp list` to see it)"
                : `Claude could not start this server (${CLAUDE_MCP_SEE_REASON})`,
          }
        : {}),
    };
  });
  for (const name of missing) {
    rows.push({
      name,
      transport: transportOf(specs, name),
      state: "failed",
      toolCount: 0,
      toolsTruncated: false,
      error: `Claude did not start this server (${CLAUDE_MCP_SEE_REASON})`,
    });
  }
  return rows;
}

/**
 * Forwarding-serializer problems → failed status rows. The text comes from the
 * controlled templates in `mcp-forward-diagnostic.ts` (server name only, never
 * a value or a raw parser message).
 */
export function forwardProblemStatuses(problems: readonly McpForwardProblem[]): McpServerStatus[] {
  return problems.map((problem) => {
    const notice = mcpForwardProblemNotice(problem);
    return {
      name: problem.server,
      transport: "stdio",
      state: "failed",
      toolCount: 0,
      toolsTruncated: false,
      error: notice.type === "engine_notice" ? notice.message : "MCP server could not be forwarded",
    };
  });
}
