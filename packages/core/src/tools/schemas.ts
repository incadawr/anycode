/**
 * Input schemas (Zod, single source of truth) and output payload types for the
 * ten built-in tools (five Phase 0 + Glob/TodoRead/TodoWrite/WebFetch from
 * Phase 1, design §2.14 + Agent from Phase 3, design §3.4). Field names and
 * shapes follow the established conventions; description strings are original.
 * Deferred: Read `pages`, Bash `dangerouslyDisableSandbox`, Grep `type` / `-o` /
 * `offset`. (Bash `run_in_background` landed in slice 5.5 as a CLI-only schema
 * extension — see backgroundBashInputSchema below; the base bashInputSchema is

 */

import { z } from "zod";
import { BASH_MAX_TIMEOUT_MS, WEBSEARCH_MAX_RESULTS } from "../types/config.js";
import type { ExecStatus } from "../ports/execution.js";
import type { BackgroundTaskStatus } from "../ports/tasks.js";
import type { TodoItem } from "./todo-store.js";

// ---------------------------------------------------------------------------
// Read

export const readInputSchema = z.object({
  file_path: z.string().min(1).describe("Absolute path of the file to read"),
  offset: z.number().int().min(0).optional().describe("Line number to start reading from (0-based)"),
  limit: z.number().int().positive().optional().describe("Maximum number of lines to return"),
});

export type ReadInput = z.output<typeof readInputSchema>;

export interface ReadOutput {
  content: string;
  totalLines: number;
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Write

export const writeInputSchema = z.object({
  file_path: z.string().min(1).describe("Absolute path of the file to create or overwrite"),
  content: z.string().describe("Full UTF-8 content to write"),
});

export type WriteInput = z.output<typeof writeInputSchema>;

export interface WriteOutput {
  bytesWritten: number;
  created: boolean;
}

// ---------------------------------------------------------------------------
// Edit

export const editInputSchema = z.object({
  file_path: z.string().min(1).describe("Absolute path of the file to modify"),
  old_string: z.string().min(1).describe("Exact text to find (must be unique unless replace_all)"),
  new_string: z.string().describe("Replacement text (must differ from old_string)"),
  replace_all: z
    .boolean()
    .default(false)
    .describe("Replace every occurrence instead of requiring a unique match"),
});

export type EditInput = z.output<typeof editInputSchema>;

export interface EditOutput {
  replacements: number;
}

// ---------------------------------------------------------------------------
// Bash

export const bashInputSchema = z.object({
  command: z.string().min(1).describe("Shell command to execute"),
  timeout: z
    .number()
    .int()
    .positive()
    .max(BASH_MAX_TIMEOUT_MS)
    .optional()
    .describe("Timeout in milliseconds (max 600000)"),
  description: z
    .string()
    .optional()
    .describe("Short human-readable summary of what the command does"),
});

export type BashInput = z.output<typeof bashInputSchema>;

export interface BashOutput {
  status: ExecStatus;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Background Bash / BashOutput / BashKill (Phase 5 slice 5.5, design §2 Wave B)
//

// non-destructive `.extend` used ONLY by backgroundCapableBashTool, which the
// CLI wiring registers over the default Bash. The default tool registry and the


/**
 * bashInputSchema + an optional `run_in_background` flag. When true, the CLI's
 * background-capable Bash starts a session-scoped task and returns a task id
 * immediately; when false/absent it delegates byte-for-byte to the sync Bash.
 */
export const backgroundBashInputSchema = bashInputSchema.extend({
  run_in_background: z
    .boolean()
    .optional()
    .describe(
      "Run the command as a session-scoped background task and return a task id immediately; poll it with BashOutput. Unavailable in some clients — a clear error is returned, then rerun synchronously.",
    ),
});

export type BackgroundBashInput = z.output<typeof backgroundBashInputSchema>;

/** Immediate result of a started background task (the process runs on past this turn). */
export interface BashBackgroundStartedOutput {
  taskId: string;
  status: "running";
  command: string;
}

export const bashOutputInputSchema = z.object({
  task_id: z.string().min(1).describe("Id of the background task to read output from (e.g. \"task-1\")"),
});

export type BashOutputInput = z.output<typeof bashOutputInputSchema>;

/** Incremental read of a background task: output appended since the last read plus a status snapshot. */
export interface BashOutputToolOutput {
  taskId: string;
  status: BackgroundTaskStatus;
  exitCode: number | null;
  /** Output appended since the previous BashOutput read (per-task cursor). */
  newOutput: string;
  outputTruncated: boolean;
  /** Wall-clock time since the task started, in milliseconds. */
  runningForMs: number;
}

export const bashKillInputSchema = z.object({
  task_id: z.string().min(1).describe("Id of the background task to kill (e.g. \"task-1\")"),
});

export type BashKillInput = z.output<typeof bashKillInputSchema>;

/** Result of a BashKill request: whether a live task was signalled and its status afterward. */
export interface BashKillOutput {
  taskId: string;
  killed: boolean;
  status: BackgroundTaskStatus;
}

// ---------------------------------------------------------------------------
// Grep

export const grepInputSchema = z.object({
  pattern: z.string().min(1).describe("Regular expression to search file contents for"),
  path: z.string().optional().describe("File or directory to search in (default: working directory)"),
  glob: z.string().optional().describe("Glob filter for file paths, e.g. \"*.ts\""),
  output_mode: z
    .enum(["content", "files_with_matches", "count"])
    .default("files_with_matches")
    .describe("What to return: matching lines, file paths, or per-file match counts"),
  "-i": z.boolean().optional().describe("Case-insensitive matching"),
  "-n": z.boolean().default(true).describe("Include line numbers in content mode"),
  "-A": z.number().int().min(0).optional().describe("Lines of context after each match (content mode)"),
  "-B": z.number().int().min(0).optional().describe("Lines of context before each match (content mode)"),
  "-C": z.number().int().min(0).optional().describe("Lines of context around each match (content mode)"),
  head_limit: z
    .number()
    .int()
    .min(0)
    .default(250)
    .describe("Maximum number of result entries (0 = unlimited)"),
  multiline: z
    .boolean()
    .default(false)
    .describe("Allow patterns to span line boundaries"),
});

export type GrepInput = z.output<typeof grepInputSchema>;

export interface GrepMatch {
  path: string;
  lineNumber?: number;
  line?: string;
}

export interface GrepOutput {
  mode: "content" | "files_with_matches" | "count";
  matches?: GrepMatch[];
  files?: string[];
  counts?: Record<string, number>;
  totalMatches: number;
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Glob (Phase 1, design §2.14)

export const globInputSchema = z.object({
  pattern: z.string().min(1).describe("Glob pattern to match file paths against, e.g. \"src/**/*.ts\""),
  path: z.string().optional().describe("Directory to search in (default: working directory)"),
});

export type GlobInput = z.output<typeof globInputSchema>;

export interface GlobOutput {
  /** Matches sorted by modification time, most recent first; capped at 1000. */
  files: string[];
  totalMatched: number;
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// TodoRead / TodoWrite (Phase 1, design §2.14)

export const todoReadInputSchema = z.object({}).strict();

export type TodoReadInput = z.output<typeof todoReadInputSchema>;

export interface TodoReadOutput {
  todos: TodoItem[];
}

export const todoWriteInputSchema = z.object({
  todos: z
    .array(
      z.object({
        id: z.string().optional().describe("Stable item id; omit to have one assigned"),
        content: z.string().min(1).describe("Task description"),
        status: z
          .enum(["pending", "in_progress", "completed"])
          .describe("Current state of the task"),
      }),
    )
    .describe("Full todo list; replaces the previous list entirely"),
});

export type TodoWriteInput = z.output<typeof todoWriteInputSchema>;

export interface TodoWriteOutput {
  todos: TodoItem[];
  count: number;
}

// ---------------------------------------------------------------------------
// WebFetch (Phase 1, design §2.14)

export const webFetchInputSchema = z.object({
  url: z.url().describe("HTTP(S) URL to fetch"),
  prompt: z
    .string()
    .min(1)
    .describe("Question to answer using the fetched page content"),
});

export type WebFetchInput = z.output<typeof webFetchInputSchema>;

export interface WebFetchOutput {
  finalUrl: string;
  status: number;
  contentType: string | null;
  /** Page content converted to text, prefixed with the caller's question. */
  content: string;
  truncated: boolean;
  cacheHit: boolean;
}

// ---------------------------------------------------------------------------
// Agent (Phase 3 slice 3.1, design §3.4)

/**
 * agent_type is a plain string, NOT a zod-enum: the handler validates it
 * against the persona registry so slice 3.3 can add md-profiles without
 * touching this frozen schema (design §3.4). Absent => "general-purpose".
 */
export const agentInputSchema = z.object({
  description: z.string().min(1).describe("Short 3-5 word description of the subagent task"),
  prompt: z.string().min(1).describe("The task the subagent should carry out"),
  agent_type: z
    .string()
    .optional()
    .describe("Persona to run (e.g. \"general-purpose\", \"explore\"); default general-purpose"),
  model: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Exact model id to run the subagent on (defaults to the parent's model); if this host cannot honor it the call fails with an explanation",
    ),
});

export type AgentInput = z.output<typeof agentInputSchema>;

export interface AgentOutput {
  status: "completed" | "max_turns" | "cancelled" | "error";
  /** The subagent's final assistant text (capped at SUBAGENT_OUTPUT_MAX_BYTES). */
  finalText: string;
  truncated: boolean;
  turns: number;
  toolCalls: number;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Skill (Phase 3 slice 3.3, design §2.7)

/**
 * `name` is a key into the discovery snapshot — there are NO paths from the
 * model, so the handler loads only by registry key (no path-traversal surface).
 * An unknown name is a handler-level invalid_input carrying the available list
 * (mirror of Agent/agent_type).
 */
export const skillInputSchema = z.object({
  name: z.string().min(1).describe("Name of the skill to load full instructions for"),
});

export type SkillInput = z.output<typeof skillInputSchema>;

export interface SkillOutput {
  name: string;
  source: string;
  /** Skill body (frontmatter stripped), capped at SKILL_BODY_MAX_BYTES. */
  body: string;
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Workflow (Phase 3 slice 3.4, design §2.6)

/**
 * `name` is a plain string, NOT a zod-enum: the handler validates it against the
 * WorkflowPort's discovery snapshot (mirror of Agent/agent_type and Skill/name),
 * so future workflow sources never touch this frozen schema. `input` is the task
 * text substituted for ${input} in the step prompts.
 */
export const workflowInputSchema = z.object({
  name: z.string().min(1).describe("Name of the workflow to run"),
  input: z.string().optional().describe("Task text substituted for ${input} in step prompts"),
});

export type WorkflowInput = z.output<typeof workflowInputSchema>;

/** Tool payload: a WorkflowRunOutcome projection (step finalText/truncated dropped). */
export interface WorkflowOutput {
  status: "completed" | "failed" | "cancelled";
  output: string;
  truncated: boolean;
  steps: Array<{
    stepId: string;
    agentType: string;
    status: string;
    turns: number;
    toolCalls: number;
    durationMs: number;
  }>;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// ExitPlanMode (Phase 4 slice 4.3, design §2.5)

/**
 * The input carries ONLY the plan text — there is deliberately no target-mode

 * chooses the mode it lands in, which is fixed by the client wiring's
 * planExitMode. A schema field would be model-spoofable, so it stays absent.
 */
export const exitPlanModeInputSchema = z.object({
  plan: z.string().min(1).describe("The full implementation plan to present to the user for approval"),
});

export type ExitPlanModeInput = z.output<typeof exitPlanModeInputSchema>;

export interface ExitPlanModeOutput {
  previousMode: string;
  mode: string;
}

// ---------------------------------------------------------------------------
// WebSearch (Phase 6 slice 6.3, design slice-6.3-cut.md §2-B1)

export const webSearchInputSchema = z.object({
  query: z.string().min(1).describe("Web search query"),
  max_results: z
    .number()
    .int()
    .min(1)
    .max(WEBSEARCH_MAX_RESULTS)
    .optional()
    .describe("Maximum results to return (default 5)"),
});

export type WebSearchInput = z.output<typeof webSearchInputSchema>;

export interface WebSearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchOutput {
  backend: string;
  query: string;
  results: WebSearchResultItem[];
  /** True when the backend yielded more parseable results than were returned. */
  truncated: boolean;
}
