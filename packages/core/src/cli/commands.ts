/**

 * slice-4.1-cut.md §2.4). A line whose first non-whitespace character is "/"
 * never reaches the model: `/compact` drives AgentLoop.compactNow through the
 * same renderEvent used for turns; `/allow` manages the session's

 * status tables; slice-4.1 adds `/help` (renders COMMAND_HELP), `/quit` and

 * design §2.6); anything else prints an unknown-command notice + the known list.
 *
 * Task 4.1.1 moved this out of main.ts verbatim and added the §2.4 deltas
 * (KNOWN_SLASH_COMMANDS -> 8, SlashCommandDeps.requestExit, /help skeleton +
 * COMMAND_HELP structure/render). Task 4.1.4 filled in the final /help summary
 * TEXTS below. Slice 4.3 (design slice-4.3-cut.md §2.6) adds `/mode`
 * (KNOWN_SLASH_COMMANDS -> 10, SlashCommandDeps.getMode/setMode): show the live
 * permission mode or switch it between turns. Slice 4.6 (design
 * slice-4.6-cut.md §2.3) adds `/model` (KNOWN_SLASH_COMMANDS -> 12,
 * SlashCommandDeps.model): show the session's live model id plus catalog
 * hints, or switch it between turns — same shape as `/mode`. Slice 4.7
 * (design slice-4.7-cut.md §2.8) adds `/rewind` (KNOWN_SLASH_COMMANDS -> 13,
 * SlashCommandDeps.rewind): list this session's workspace checkpoints, or
 * restore files and/or the conversation to one, behind a y/N confirmation.
 * Slice 5.4 (design slice-5.4-cut.md §2.5) adds the git grain `/status`,
 * `/diff`, `/commit` (KNOWN_SLASH_COMMANDS -> 16, SlashCommandDeps.git): show
 * the working tree's status, the unified diff vs HEAD, or stage-all-and-commit
 * behind the same y/N confirmation `/rewind` uses. Rendering/parsing is done by
 * the pure helpers in cli/git.ts; every GitPort result is a GitOpResult whose
 * reason is printed verbatim (the port never throws, so a git error never
 * crashes the REPL). Slice 5.6 wave C (design slice-5.6-cut.md) adds `/hooks`
 * (KNOWN_SLASH_COMMANDS -> 17, SlashCommandDeps.hooks): a read-only listing of
 * the boot-resolved CommandHookDeclarations (event/matcher/command), rendered
 * by cli/render.ts's renderHooksTable — no execution, no mutation, mirroring
 * the /mcp and /skills introspection commands above. Slice 5.5 wave C (design
 * slice-5.5-cut.md §2/C3) adds `/tasks` (KNOWN_SLASH_COMMANDS -> 18,
 * SlashCommandDeps.tasks): a bare `/tasks` lists this session's background
 * Bash tasks (cli/render.ts's renderTasksTable, mirroring renderHooksTable's
 * shape); `/tasks kill <id>` stops one and reports an honest result — no
 * confirmation prompt (killing a registry-owned background task is a strictly
 * narrower action than the write/execute permission the task's own launch

 * §2-D2) adds `/lsp` (KNOWN_SLASH_COMMANDS -> 19, SlashCommandDeps.lsp): a
 * read-only listing of the configured language servers' live status (name,
 * state, pid, extensions, a truncated stderr tail when crashed) via
 * cli/render.ts's renderLspTable, mirroring /hooks/renderHooksTable's shape —
 * no execution, no mutation, no kill (a server's life is the session; it is

 * adds `/image` (KNOWN_SLASH_COMMANDS -> 20, SlashCommandDeps.images): stages
 * a local image file for the NEXT submitted prompt with IMMEDIATE load/sniff/
 * cap validation (`/image <path>`, success or an honest reason verbatim), or
 * lists/clears the current stage (bare `/image` / `/image clear`) — no
 * execution, no mutation of the model's history until the stage actually

 * slice-6.4-cut.md §2-C2) adds `/context` (KNOWN_SLASH_COMMANDS -> 21): a
 * read-only token-budget snapshot straight off AgentLoop.contextInfo() via
 * cli/render.ts's formatContextInfo, mirroring /hooks/lsp — no execution, no
 * mutation, no event emission. Slice 6.6 (design slice-6.6-cut.md §2-C2) adds
 * `/telemetry` (KNOWN_SLASH_COMMANDS -> 22, SlashCommandDeps.telemetry): a
 * read-only status snapshot of the opt-in JSONL sink (enabled/disabled, sink
 * file, written/dropped counts) via cli/render.ts's renderTelemetryStatus,
 * same class as /context/hooks/lsp above — no execution, no mutation, no
 * event emission. No module outside cli/ imports from here.
 */

import type { RewindScope } from "../checkpoints/shadow-git.js";
import type { CommandHookDeclaration } from "../dispatch/index.js";
import type { AgentLoop } from "../loop/index.js";
import type { McpManager } from "../mcp/index.js";
import type { SessionPermissionRules } from "../permissions/index.js";
import type { CheckpointMeta } from "../ports/checkpoints.js";
import type { GitOpResult, GitStatusSummary } from "../ports/git.js";
import type { LspServerStatus } from "../ports/lsp.js";
import type { SessionMeta } from "../ports/persistence.js";
import type { TelemetryStatus } from "../ports/telemetry.js";
import type { SkillPort } from "../ports/skills.js";
import type { BackgroundTaskSnapshot } from "../ports/tasks.js";
import type { WorkflowMeta } from "../ports/workflow.js";
import type { CatalogModel, CatalogProviderEntry } from "../provider/catalog.js";
import type { ReasoningEffort } from "../types/config.js";
import type { ImageMediaType } from "../types/images.js";
import { PERMISSION_MODES, type PermissionMode, type PermissionRule } from "../types/permissions.js";
import {
  parseCommitCommand,
  parseDiffCommand,
  renderCommitSummary,
  renderGitStatus,
  truncateDiff,
} from "./git.js";
import { formatModelInfo } from "./model.js";
import {
  formatContextBreakdown,
  formatContextInfo,
  renderEvent,
  renderHooksTable,
  renderLspTable,
  renderMcpStatusTable,
  renderSkillsTable,
  renderTasksTable,
  renderTelemetryStatus,
  renderWorkflowsTable,
} from "./render.js";
import { parseRewindCommand, renderCheckpointsTable, resolveCheckpointRef } from "./rewind.js";
import { formatRelativeTime, renderSessionsTable, SESSIONS_LIST_LIMIT } from "./sessions.js";

export const KNOWN_SLASH_COMMANDS = [
  "/compact",
  "/allow",
  "/mcp",
  "/skills",
  "/workflows",
  "/sessions",
  "/rewind",
  "/reasoning",
  "/mode",
  "/model",
  "/status",
  "/diff",
  "/commit",
  "/hooks",
  "/tasks",
  "/lsp",
  "/image",
  "/context",
  "/telemetry",
  "/repo-map",
  "/help",
  "/quit",
  "/exit",
] as const;

/**
 * One-line summaries for `/help` (design §2.4/§3.3). Task 4.1.1 froze the
 * structure and the render; task 4.1.4 (this file) fills in the final texts.
 */
export const COMMAND_HELP: ReadonlyArray<{ command: string; summary: string }> = [
  { command: "/compact", summary: "manually summarize the conversation now (same machinery as auto-compaction)" },
  { command: "/allow", summary: "list always-allow rules (persisted across sessions), or add one: /allow <Tool> [glob]" },
  { command: "/mcp", summary: "show configured MCP servers and their connection status" },
  { command: "/skills", summary: "list discovered skills (project/user/plugin)" },
  { command: "/workflows", summary: "list discovered declarative workflows" },
  { command: "/sessions", summary: "list recent sessions for this workspace, or /sessions all for every workspace" },
  { command: "/rewind", summary: "list workspace checkpoints, or restore one: /rewind <#|id> [files|conversation]" },
  { command: "/reasoning", summary: "toggle reasoning rendering, or set model effort: /reasoning <off|low|medium|high|max>" },
  { command: "/mode", summary: "show the current permission mode, or switch it: /mode <plan|build|edit|auto|yolo>" },
  { command: "/model", summary: "show the session's model and provider hints, or switch it: /model <model-id>" },
  { command: "/status", summary: "show the working tree's git status (branch, staged/unstaged/untracked files)" },
  { command: "/diff", summary: "show the unified diff vs HEAD, or a single path: /diff [path]" },
  { command: "/commit", summary: "stage every change and commit it behind a y/N confirm: /commit <message>" },
  { command: "/hooks", summary: "list the command hooks configured for this session (event, matcher, command)" },
  { command: "/tasks", summary: "list background Bash tasks in this session, or stop one: /tasks kill <id>" },
  { command: "/lsp", summary: "show configured language servers and their live status (state, pid, extensions)" },
  { command: "/image", summary: "stage an image for the next prompt: /image <path>, or list/clear the stage: /image [clear]" },
  { command: "/context", summary: "show context usage: tokens used, window, auto-compact threshold and breaker state" },
  { command: "/telemetry", summary: "show telemetry status: enabled/disabled, sink file, written/dropped record counts" },
  { command: "/repo-map", summary: "show the boot-frozen repository map currently included in the system prompt" },
  { command: "/help", summary: "show this command list" },
  { command: "/quit", summary: "end the session (flushes history and disconnects cleanly)" },
  { command: "/exit", summary: "same as /quit" },
];

/** Renders COMMAND_HELP as a fixed-width `command  summary` table (mirror of the render.ts tables). */
export function renderCommandHelp(entries: ReadonlyArray<{ command: string; summary: string }>): string {
  if (entries.length === 0) {
    return "[help] no commands\n";
  }
  const width = Math.max(...entries.map((entry) => entry.command.length));
  return entries.map((entry) => `${entry.command.padEnd(width)}  ${entry.summary}`.trimEnd()).join("\n") + "\n";
}

export function isSlashCommand(line: string): boolean {
  return line.trimStart().startsWith("/");
}

/** Strips one layer of matching outer "..."/'...' quotes, if present. */
function stripSurroundingQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

export type AllowCommandParse =
  | { kind: "list" }
  | { kind: "add"; rule: PermissionRule }
  | { kind: "invalid" };

/**
 * Parses the text after `/allow`: empty (or whitespace-only) -> list; a bare
 * tool name -> a pattern-less rule; a tool name followed by the REST of the
 * line as the pattern (quote-stripped, so `/allow Bash "git *"` and
 * `/allow Bash git *` both yield pattern `git *`) -> a patterned rule. A
 * quoted-empty tool name (e.g. `/allow ""`) is invalid usage.
 */
export function parseAllowCommand(rest: string): AllowCommandParse {
  const trimmed = rest.trim();
  if (trimmed === "") {
    return { kind: "list" };
  }
  const spaceIdx = trimmed.search(/\s/);
  const toolNameRaw = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const patternRaw = spaceIdx === -1 ? undefined : trimmed.slice(spaceIdx + 1).trim();

  const toolName = stripSurroundingQuotes(toolNameRaw);
  if (toolName === "") {
    return { kind: "invalid" };
  }
  const pattern = patternRaw && patternRaw.length > 0 ? stripSurroundingQuotes(patternRaw) : undefined;
  return { kind: "add", rule: pattern !== undefined ? { toolName, pattern } : { toolName } };
}

function handleAllowCommand(
  rest: string,
  rules: SessionPermissionRules,
  write: (text: string) => void,
): void {
  const parsed = parseAllowCommand(rest);
  switch (parsed.kind) {
    case "list": {
      const list = rules.list();
      if (list.length === 0) {
        write("[allow] no rules for this session\n");
        return;
      }
      for (const rule of list) {
        write(`[allow] ${rule.toolName}${rule.pattern !== undefined ? ` ${rule.pattern}` : ""}\n`);
      }
      return;
    }
    case "add":
      rules.add(parsed.rule);
      write(
        `[allow] added rule: ${parsed.rule.toolName}${
          parsed.rule.pattern !== undefined ? ` ${parsed.rule.pattern}` : ""
        }\n`,
      );
      return;
    case "invalid":
      write("[allow] usage: /allow <ToolName> [glob-pattern]\n");
      return;
  }
}

/**
 * Handles `/mode` (design §2.6): empty argument prints the current mode plus the
 * switchable list; a known mode calls deps.setMode (printing its refusal reason
 * verbatim, or `[mode] now <m>` on success followed by a mode-specific hint);
 * anything else prints the usage line. Switching INTO plan hints at the
 * ExitPlanMode flow; switching into yolo warns that every action is auto-allowed.
 */
function handleModeCommand(rest: string, deps: SlashCommandDeps): void {
  const arg = rest.trim();
  if (arg === "") {
    deps.write(
      `[mode] ${deps.getMode()} — available: ${PERMISSION_MODES.join(", ")} (switch: /mode <mode>)\n`,
    );
    return;
  }
  const target = PERMISSION_MODES.find((mode) => mode === arg);
  if (target === undefined) {
    deps.write(`[mode] usage: /mode [${PERMISSION_MODES.join("|")}]\n`);
    return;
  }
  const reason = deps.setMode(target);
  if (reason !== null) {
    deps.write(`[mode] ${reason}\n`);
    return;
  }
  deps.write(`[mode] now ${target}\n`);
  if (target === "plan") {
    deps.write(
      "[mode] research with read-only tools, then call ExitPlanMode with your plan to switch back\n",
    );
  } else if (target === "yolo") {
    deps.write("[mode] warning: every action is auto-allowed for this session\n");
  }
}

/**
 * Handles `/model` (design slice-4.6-cut.md §2.3): empty argument shows the
 * live model id plus catalog hints via `formatModelInfo` (cli/model.ts) — the
 * deps carry `hints`/`providerName` separately (the shape main.ts's boot
 * wiring produces from a matched catalog entry), so a minimal
 * CatalogProviderEntry-shaped object is assembled here purely to reuse that
 * renderer without duplicating its string-building; the placeholder
 * id/baseUrl/transport/auth fields are never read by formatModelInfo, which
 * only inspects `.name` and `.models`. An argument containing whitespace (or
 * blank after trim, handled above) is ambiguous — free-text model ids never
 * legitimately contain a space — and prints the usage line, mirroring
 * handleModeCommand; otherwise deps.model.set is called and its refusal
 * reason (or the new id) is printed verbatim.
 */
function handleModelCommand(rest: string, deps: SlashCommandDeps): void {
  const arg = rest.trim();
  if (arg === "") {
    const entry: CatalogProviderEntry | undefined =
      deps.model.providerName !== undefined
        ? {
            id: deps.model.providerName,
            name: deps.model.providerName,
            baseUrl: "",
            defaultTransport: "anthropic-messages",
            supportedTransports: ["anthropic-messages"],
            auth: { kind: "api_key" },
            models: [...deps.model.hints],
          }
        : undefined;
    deps.write(formatModelInfo(deps.model.get(), entry));
    return;
  }
  if (/\s/.test(arg)) {
    deps.write("[model] usage: /model [model-id]\n");
    return;
  }
  const reason = deps.model.set(arg);
  if (reason !== null) {
    deps.write(`[model] ${reason}\n`);
    return;
  }
  deps.write(`[model] now ${arg}\n`);
}

/**
 * Handles `/context` (design slice-6.4-cut.md §2-C2, breakdown appendix per
 * slice-P7.17-cut.md §2.1 W1): a bare `/context` renders the live
 * token-budget snapshot off AgentLoop.contextInfo() via formatContextInfo,
 * then appends the per-category breakdown off AgentLoop.contextBreakdown()
 * via formatContextBreakdown (both cli/render.ts); any argument prints the
 * usage line. Read-only introspection mirroring /hooks and /lsp — no
 * execution, no mutation, no event emission; contextBreakdown() is a pure
 * read like contextInfo(), so calling both here is free of side effects.
 */
function handleContextCommand(rest: string, deps: SlashCommandDeps): void {
  if (rest.trim() !== "") {
    deps.write("[context] usage: /context\n");
    return;
  }
  deps.write(formatContextInfo(deps.loop.contextInfo()));
  deps.write(formatContextBreakdown(deps.loop.contextBreakdown()));
}

/**
 * Handles `/telemetry` (design slice-6.6-cut.md §2-C2): a bare `/telemetry`
 * renders the sink status via renderTelemetryStatus (cli/render.ts); null
 * from the grain means telemetry is disabled (opt-in). Any argument prints
 * the usage line. Read-only introspection mirroring /hooks/lsp/context — no
 * execution, no mutation, no event emission.
 */
function handleTelemetryCommand(rest: string, deps: SlashCommandDeps): void {
  if (rest.trim() !== "") {
    deps.write("[telemetry] usage: /telemetry\n");
    return;
  }
  deps.write(renderTelemetryStatus(deps.telemetry.status()));
}

function handleRepoMapCommand(rest: string, deps: SlashCommandDeps): void {
  if (rest.trim() !== "") {
    deps.write("[repo-map] usage: /repo-map\n");
    return;
  }
  if (deps.repoMap === undefined) {
    deps.write('[repo-map] disabled — enable via ANYCODE_REPO_MAP=1 or .anycode/config.json: { "repoMap": { "enabled": true } }\n');
    return;
  }
  deps.write(`${deps.repoMap.render()}\n`);
}

/** Human-readable scope label for the /rewind confirmation question (design §2.8). */
function formatRewindScope(scope: RewindScope): string {
  return scope === "both" ? "files+conversation" : scope;
}

/**
 * Handles `/rewind` (design slice-4.7-cut.md §2.8): disabled sessions (print/
 * injected model port/`--no-checkpoints`) refuse every form of the command up
 * front. Otherwise: no argument lists this session's checkpoints (newest
 * first, capped at SESSIONS_LIST_LIMIT, mirroring /sessions); an invalid
 * argument shape prints the usage line; `<#|id> [files|conversation]`
 * resolves the ref against a freshly-fetched list, asks a y/N confirmation
 * through deps.rewind.confirm (a refusal — anything but yes — cancels with no
 * further calls), then restores and reports which parts moved plus the
 * mandatory pre-rewind safety checkpoint. Order: parse -> enabled gate ->
 * list -> resolve -> confirm -> restore -> render (§2.8).
 */
async function handleRewindCommand(rest: string, deps: SlashCommandDeps): Promise<void> {
  const parsed = parseRewindCommand(rest);
  if (!deps.rewind.enabled) {
    deps.write("[rewind] checkpoints are disabled for this session\n");
    return;
  }
  switch (parsed.kind) {
    case "invalid":
      deps.write("[rewind] usage: /rewind [<#|id> [files|conversation]]\n");
      return;
    case "list": {
      const metas = await deps.rewind.list({ limit: SESSIONS_LIST_LIMIT });
      if (metas.length === 0) {
        deps.write("[rewind] no checkpoints yet in this session\n");
        return;
      }
      deps.write(renderCheckpointsTable(metas, { now: Date.now() }));
      return;
    }
    case "restore": {
      const metas = await deps.rewind.list({ limit: SESSIONS_LIST_LIMIT });
      const target = resolveCheckpointRef(metas, parsed.ref);
      if (target === null) {
        deps.write(`[rewind] no checkpoint matches "${parsed.ref}"\n`);
        return;
      }
      const age = formatRelativeTime(target.createdAt, Date.now());
      const confirmed = await deps.rewind.confirm(
        `[rewind] restore ${formatRewindScope(parsed.scope)} to checkpoint ${target.id.slice(0, 8)} (${target.label}, ${age})? [y/N] `,
      );
      if (!confirmed) {
        deps.write("[rewind] cancelled\n");
        return;
      }
      const result = await deps.rewind.restore(target.id, parsed.scope);
      if (!result.ok) {
        deps.write(`[rewind] ${result.reason}\n`);
        return;
      }
      if (result.restoredPaths !== null && (parsed.scope === "both" || parsed.scope === "files")) {
        deps.write(`[rewind] restored files: ${result.restoredPaths} paths\n`);
      }
      if (result.conversationRestored) {
        deps.write("[rewind] conversation rewound to before that turn\n");
      }
      deps.write(`[rewind] safety checkpoint ${result.safetyCheckpointId.slice(0, 8)} captures the pre-rewind state\n`);
      return;
    }
  }
}

/**
 * Handles `/status` (design slice-5.4-cut.md §2.5): disabled sessions (not a git
 * repo, or an execution port with no runBinary) refuse up front; otherwise one
 * `deps.git.status()` fetch is rendered by renderGitStatus. A failed status


 */
async function handleStatusCommand(deps: SlashCommandDeps): Promise<void> {
  if (!deps.git.enabled) {
    deps.write("[status] not a git repository\n");
    return;
  }
  const result = await deps.git.status();
  if (!result.ok) {
    deps.write(`[status] ${result.reason}\n`);
    return;
  }
  deps.write(renderGitStatus(result.value));
}

/**

 * otherwise the rest is parsed into an optional single pathspec and the diff vs
 * HEAD (worktree+index — the "what has the agent changed since the last commit"


 * no-changes notice; a failed diff prints the reason verbatim.
 */
async function handleDiffCommand(rest: string, deps: SlashCommandDeps): Promise<void> {
  if (!deps.git.enabled) {
    deps.write("[diff] not a git repository\n");
    return;
  }
  const result = await deps.git.diff(parseDiffCommand(rest));
  if (!result.ok) {
    deps.write(`[diff] ${result.reason}\n`);
    return;
  }
  if (result.value === "") {
    deps.write("[diff] no changes vs HEAD\n");
    return;
  }
  deps.write(truncateDiff(result.value));
}

/**
 * Handles `/commit` (design slice-5.4-cut.md §2.5): disabled ⇒ refuse; an empty
 * message ⇒ usage. Order: gate → parse → pre-commit status snapshot → clean repo
 * ⇒ nothing-to-commit (with NO confirmation asked) → renderCommitSummary → y/N

 * deps.git.commit (stage-all then commit). The committed file count N is computed
 * HERE from the pre-commit status snapshot (staged + unstaged + untracked — every
 * file `stageAll` will capture), NOT returned by deps.git.commit: that keeps
 * deps.git.commit a pure stageAll+commit composition and avoids a double count
 * (ratified §2.5/§2.6 divergence — deps.git.commit resolves to `{ sha }`, not
 * `{ sha, files }`).
 */
async function handleCommitCommand(rest: string, deps: SlashCommandDeps): Promise<void> {
  if (!deps.git.enabled) {
    deps.write("[commit] not a git repository\n");
    return;
  }
  const parsed = parseCommitCommand(rest);
  if (parsed.kind === "invalid") {
    deps.write("[commit] usage: /commit <message>\n");
    return;
  }
  const statusResult = await deps.git.status();
  if (!statusResult.ok) {
    deps.write(`[commit] ${statusResult.reason}\n`);
    return;
  }
  const summary = statusResult.value;
  const fileCount = summary.staged.length + summary.unstaged.length + summary.untracked.length;
  if (fileCount === 0) {
    deps.write("[commit] nothing to commit\n");
    return;
  }
  const confirmed = await deps.git.confirm(`${renderCommitSummary(summary)} [y/N] `);
  if (!confirmed) {
    deps.write("[commit] cancelled\n");
    return;
  }
  const result = await deps.git.commit(parsed.message);
  if (!result.ok) {
    deps.write(`[commit] ${result.reason}\n`);
    return;
  }
  const label = fileCount === 1 ? "file" : "files";
  deps.write(`[commit] ${result.value.sha.slice(0, 8)} (${fileCount} ${label})\n`);
}

/**
 * Handles `/hooks` (design slice-5.6-cut.md wave C): a read-only listing of
 * the boot-resolved command hooks (event, matcher, command) via
 * renderHooksTable — no execution, no confirmation, mirroring /mcp and
 * /skills above (the list is a session-boot snapshot, not re-read live).
 */
function handleHooksCommand(deps: SlashCommandDeps): void {
  deps.write(renderHooksTable(deps.hooks.list()));
}

/**
 * Handles `/tasks` (design slice-5.5-cut.md §2/C3): a bare `/tasks` renders
 * the session's background Bash tasks via renderTasksTable (read-only
 * introspection, mirroring /hooks above). `/tasks kill <id>` stops one and
 * reports the honest boolean result — `killed` or `no running task "<id>"`
 * (deps.tasks.kill already fails closed on an unknown/already-terminal id,
 * design §2 ports/tasks.ts's `kill()` contract). Any other shape (missing id,
 * a third token, a typo'd subcommand) prints the usage line; no confirmation

 */
function handleTasksCommand(rest: string, deps: SlashCommandDeps): void {
  const arg = rest.trim();
  if (arg === "") {
    deps.write(renderTasksTable(deps.tasks.list()));
    return;
  }
  const parts = arg.split(/\s+/);
  if (parts.length !== 2 || parts[0] !== "kill") {
    deps.write("[tasks] usage: /tasks [kill <id>]\n");
    return;
  }
  const id = parts[1]!;
  const killed = deps.tasks.kill(id);
  deps.write(killed ? `[tasks] killed ${id}\n` : `[tasks] no running task "${id}"\n`);
}

/**
 * Handles `/lsp` (design slice-6.1-cut.md §2-D2): a read-only listing of the
 * session's configured language servers' live status via renderLspTable —
 * no execution, no confirmation, mirroring /hooks above (unlike /hooks'
 * boot-time snapshot, deps.lsp.status() re-reads the manager's LIVE state on
 * every call, since a server's state can change mid-session, e.g. a crash).
 */
function handleLspCommand(deps: SlashCommandDeps): void {
  deps.write(renderLspTable(deps.lsp.status()));
}

/**

 * and validates IMMEDIATELY — success reports the staged file's basename,
 * sniffed media type, size, and the running staged count; failure (capability
 * off, over-cap, per-message cap reached, unreadable, not a supported image)
 * prints deps.images.stage's reason verbatim, never touching the stage. A bare
 * `/image` lists the current stage (or an honest "nothing staged" notice);
 * `/image clear` empties it and reports how many were dropped. This handler
 * never touches the model or the stage's eventual drain — that happens once,

 */
async function handleImageCommand(rest: string, deps: SlashCommandDeps): Promise<void> {
  const arg = rest.trim();
  if (arg === "") {
    const staged = deps.images.list();
    if (staged.length === 0) {
      deps.write("[image] no images staged\n");
      return;
    }
    for (const entry of staged) {
      deps.write(`[image] staged ${entry.basename} (${entry.mediaType}, ${entry.kb} KB)\n`);
    }
    return;
  }
  if (arg === "clear") {
    const count = deps.images.clear();
    deps.write(`[image] cleared ${count} staged image${count === 1 ? "" : "s"}\n`);
    return;
  }
  const result = await deps.images.stage(arg);
  if (!result.ok) {
    deps.write(`[image] ${result.reason}\n`);
    return;
  }
  deps.write(`[image] staged ${result.basename} (${result.mediaType}, ${result.kb} KB) — ${result.staged} staged\n`);
}

export interface SlashCommandDeps {
  loop: AgentLoop;
  rules: SessionPermissionRules;
  write: (text: string) => void;
  signal?: AbortSignal;
  mcp: McpManager;
  skills: SkillPort;
  /** Discovered-workflow metas for `/workflows` (design §2.9's boot snapshot, projected — mirror of `skills`). */
  workflows: WorkflowMeta[];
  /** Sets the REPL's exitRequested flag; `/quit` and `/exit` call it (design slice-4.1-cut.md §2.4/§2.6). */
  requestExit: () => void;
  /** Flips the session's reasoning-render state and returns the NEW value; `/reasoning` calls it (design slice-4.2-cut.md §2.6). */
  toggleReasoning: () => boolean;
  getReasoningEffort: () => ReasoningEffort;
  setReasoningEffort: (effort: ReasoningEffort) => string | null;
  /** Reads the session's live permission mode; `/mode` shows it (design slice-4.3-cut.md §2.6). */
  getMode: () => PermissionMode;
  /**
   * Switches the session's permission mode between turns and returns null on
   * success, or a reason string printed as-is when the switch is refused (e.g.
   * the `--yolo` boot pins the broker); `/mode <m>` calls it (design §2.6/§2.8).
   */
  setMode: (mode: PermissionMode) => string | null;
  /** /model (design slice-4.6-cut.md §2.3): show/switch the session's live model id. */
  model: {
    /** Current model id of the session (live). */
    get: () => string;
    /**
     * Switches the session's model between turns and returns null on success,
     * or a reason string printed as-is when the switch is refused (e.g. an
     * injected test model port with no switch factory); `/model <id>` calls it.
     */
    set: (modelId: string) => string | null;
    /** Catalog hints for the session's current endpoint (boot snapshot; [] = endpoint not in the catalog). */
    hints: readonly CatalogModel[];
    /** Catalog provider name for display (undefined = endpoint not in the catalog). */
    providerName?: string;
  };
  /**
   * /sessions (design slice-4.4-cut.md §2.3): a narrow list callback (plus the
   * current session id and this session's workspace) instead of the whole
   * PersistencePort — the dispatcher renders recent sessions without ever
   * seeing the adapter.
   */
  sessions: {
    list: (opts?: { workspace?: string; limit?: number }) => Promise<SessionMeta[]>;
    currentId: string;
    workspace: string;
  };
  /* */
  rewind: {
    /* */
    enabled: boolean;
    list: (opts?: { limit?: number }) => Promise<CheckpointMeta[]>;
    /* */
    confirm: (question: string) => Promise<boolean>;
    restore: (id: string, scope: RewindScope) => Promise<
      | { ok: true; restoredPaths: number | null; conversationRestored: boolean; safetyCheckpointId: string }
      | { ok: false; reason: string }
    >;
  };
  /**
   * /status, /diff, /commit (design slice-5.4-cut.md §2.5): the git grain over
   * GitPort. `enabled` is `isGitRepo && runBinary present` (false ⇒ every command
   * refuses with a not-a-repo line). status/diff are direct GitPort delegates

   * /commit shares with /rewind's y/N ask; commit is a pure stageAll+commit
   * composition resolving to just the new sha — the committed file count is
   * derived by the handler from its own pre-commit status snapshot (ratified
   * §2.5/§2.6 divergence, so this method never double-counts). The port never

   */
  git: {
    enabled: boolean;
    status: () => Promise<GitOpResult<GitStatusSummary>>;
    diff: (spec?: { path?: string }) => Promise<GitOpResult<string>>;
    confirm: (question: string) => Promise<boolean>;
    commit: (message: string) => Promise<GitOpResult<{ sha: string }>>;
  };
  /** /hooks (slice-5.6): read-only list of the boot-resolved command hooks. */
  hooks: { list: () => readonly CommandHookDeclaration[] };
  /**
   * /tasks (design slice-5.5-cut.md §2/C3): list this session's background
   * Bash tasks, or stop one. `kill` returns false for an unknown id or a
   * task already in a terminal state (the port's own fail-closed contract) —
   * `/tasks kill <id>` prints that result verbatim rather than guessing.
   */
  tasks: {
    list: () => BackgroundTaskSnapshot[];
    kill: (taskId: string) => boolean;
  };
  /** /lsp (design slice-6.1-cut.md §2-D2): read-only live status of configured language servers. */
  lsp: { status: () => LspServerStatus[] };
  /**
   * /telemetry (design slice-6.6-cut.md §2-C1/§2-C2): read-only status
   * projection over the opt-in JSONL sink. `status()` returns null when the
   * sink was never built (config gate off, opt-in default) — the handler
   * renders that as an honest "disabled" line via renderTelemetryStatus.
   */
  telemetry: { status: () => TelemetryStatus | null };
  /** /repo-map: current model-aware rendering of the boot-frozen repository metadata. */
  repoMap?: { render: () => string };
  /**

   * image(s) attached to the NEXT submitted prompt. `stage` loads+validates

   * either the staged file's display info plus the running staged count, or
   * an honest failure reason — the stage is untouched on failure. `list`
   * projects the current stage for display (empty = nothing staged). `clear`
   * empties the stage and returns how many images were dropped.
   */
  images: {
    stage: (path: string) => Promise<
      | { ok: true; basename: string; mediaType: ImageMediaType; kb: number; staged: number }
      | { ok: false; reason: string }
    >;
    list: () => Array<{ basename: string; mediaType: ImageMediaType; kb: number }>;
    clear: () => number;
  };
}

/** Dispatches one slash-command line; never sends it to the model. */
export async function handleSlashCommand(line: string, deps: SlashCommandDeps): Promise<void> {
  const withoutSlash = line.trim().slice(1);
  const spaceIdx = withoutSlash.search(/\s/);
  const command = spaceIdx === -1 ? withoutSlash : withoutSlash.slice(0, spaceIdx);
  const rest = spaceIdx === -1 ? "" : withoutSlash.slice(spaceIdx + 1);

  switch (command) {
    case "compact":
      for await (const event of deps.loop.compactNow({ signal: deps.signal })) {
        renderEvent(event, deps.write);
      }
      return;
    case "allow":
      handleAllowCommand(rest, deps.rules, deps.write);
      return;
    case "mcp":
      deps.write(renderMcpStatusTable(deps.mcp.status()));
      return;
    case "skills":
      deps.write(renderSkillsTable(deps.skills.list()));
      return;
    case "workflows":
      deps.write(renderWorkflowsTable(deps.workflows));
      return;
    case "sessions": {
      // Design §2.3: bare `/sessions` lists this workspace's recent sessions;
      // `/sessions all` drops the workspace filter and adds a workspace column.
      // Any other argument is a usage error. Rendered without a theme, byte-
      // consistent with the /mcp/skills/workflows tables above.
      const arg = rest.trim();
      if (arg !== "" && arg !== "all") {
        deps.write("[sessions] usage: /sessions [all]\n");
        return;
      }
      const all = arg === "all";
      const metas = await deps.sessions.list({
        ...(all ? {} : { workspace: deps.sessions.workspace }),
        limit: SESSIONS_LIST_LIMIT,
      });
      deps.write(
        renderSessionsTable(metas, {
          now: Date.now(),
          currentId: deps.sessions.currentId,
          showWorkspace: all,
        }),
      );
      return;
    }
    case "rewind":
      await handleRewindCommand(rest, deps);
      return;
    case "reasoning": {
      const arg = rest.trim();
      if (arg !== "") {
        if (arg !== "off" && arg !== "low" && arg !== "medium" && arg !== "high" && arg !== "max") {
          deps.write("[reasoning] usage: /reasoning <off|low|medium|high|max>\n");
          return;
        }
        const error = deps.setReasoningEffort(arg);
        deps.write(error === null ? `[reasoning] model effort is now ${arg}\n` : `[reasoning] ${error}\n`);
        return;
      }
      const enabled = deps.toggleReasoning();
      deps.write(`[reasoning] rendering is now ${enabled ? "on" : "off"}; model effort=${deps.getReasoningEffort()}\n`);
      return;
    }
    case "mode": {
      handleModeCommand(rest, deps);
      return;
    }
    case "model": {
      handleModelCommand(rest, deps);
      return;
    }
    case "status":
      await handleStatusCommand(deps);
      return;
    case "diff":
      await handleDiffCommand(rest, deps);
      return;
    case "commit":
      await handleCommitCommand(rest, deps);
      return;
    case "hooks":
      handleHooksCommand(deps);
      return;
    case "tasks":
      handleTasksCommand(rest, deps);
      return;
    case "lsp":
      handleLspCommand(deps);
      return;
    case "image":
      await handleImageCommand(rest, deps);
      return;
    case "context":
      handleContextCommand(rest, deps);
      return;
    case "telemetry":
      handleTelemetryCommand(rest, deps);
      return;
    case "repo-map":
      handleRepoMapCommand(rest, deps);
      return;
    case "help":
      deps.write(renderCommandHelp(COMMAND_HELP));
      return;
    case "quit":
    case "exit":
      deps.requestExit();
      return;
    default:
      deps.write(`[unknown command: /${command}] known commands: ${KNOWN_SLASH_COMMANDS.join(", ")}\n`);
  }
}
