/**
 * Config-driven command hooks (design §2.11). Sources, merged user < project
 * with BOTH sets executed:
 *   <workspace>/.anycode/config.json  and  ~/.anycode/config.json
 * Command hooks are trusted user configuration (like git hooks), NOT model
 * input: no permission gate on the hooks themselves; execution goes through
 * ExecutionPort (same SIGTERM -> SIGKILL kill chain, per-hook timeout).
 *
 * Protocol: the JSON payload is delivered to the command on stdin (then EOF),
 * alongside the bounded metadata env vars ANYCODE_HOOK_EVENT /
 * ANYCODE_TOOL_NAME / ANYCODE_PROJECT_DIR. PreToolUse stdout is parsed as
 * JSON { permissionDecision?, reason?, updatedInput? }; a non-zero PreToolUse
 * exit code = deny (fail-closed), observers log a warning. stdout cap 32 KB.
 */

import { z } from "zod";
import type { ExecResult, ExecutionPort, FileSystemPort } from "../ports/index.js";
import { DEFAULT_HOOK_TIMEOUT_MS } from "../types/config.js";
import type {
  HookEvent,
  HookRegistration,
  PostToolUseHook,
  PreToolUseHook,
  PreToolUseHookResult,
  StopHook,
  SubagentStopHook,
  UserPromptSubmitHook,
} from "../types/hooks.js";

/** Cap on captured hook stdout. */
export const HOOK_STDOUT_CAP_BYTES = 32_768;

const hookEventNames = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "UserPromptSubmit",
  "Stop",
  "SubagentStop",
] as const satisfies readonly HookEvent[];

export const commandHookEntrySchema = z.object({
  /** Regex source tested against the tool name (or prompt text for UserPromptSubmit). */
  matcher: z.string().optional(),
  command: z.string().min(1),
  timeoutMs: z.number().int().positive().optional(),
});

/** Shape of the "hooks" section in .anycode/config.json. */
export const hookConfigFileSchema = z.object({
  hooks: z.partialRecord(z.enum(hookEventNames), z.array(commandHookEntrySchema)).optional(),
});

export type CommandHookEntry = z.output<typeof commandHookEntrySchema>;
export type HookConfigFile = z.output<typeof hookConfigFileSchema>;

/** One declaration ready for createCommandHook: entry + the event it registers on. */
export interface CommandHookDeclaration extends CommandHookEntry {
  event: HookEvent;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length ? issue.path.join(".") : "(root)"}: ${issue.message}`)
    .join("; ");
}

/** `<baseDir>/.anycode/config.json`, tolerating a trailing separator on baseDir. */
function configPath(baseDir: string): string {
  return `${baseDir.replace(/[/\\]+$/, "")}/.anycode/config.json`;
}

/** Turns a validated config file into a flat, event-tagged declaration list. */
function flattenDeclarations(config: HookConfigFile): CommandHookDeclaration[] {
  const declarations: CommandHookDeclaration[] = [];
  const hooks = config.hooks;
  if (!hooks) {
    return declarations;
  }
  for (const event of hookEventNames) {
    const entries = hooks[event];
    if (!entries) {
      continue;
    }
    for (const entry of entries) {
      declarations.push({ event, ...entry });
    }
  }
  return declarations;
}

/**
 * Reads one config file. Missing file -> no declarations. Malformed JSON or a
 * schema violation throws a descriptive error naming the file so the caller can
 * decline to register any hooks (rather than crash).
 */
async function loadOneConfig(
  fs: FileSystemPort,
  path: string,
): Promise<CommandHookDeclaration[]> {
  if (!(await fs.exists(path))) {
    return [];
  }
  const raw = await fs.readFile(path);
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in hook config ${path}: ${describeError(error)}`);
  }
  const result = hookConfigFileSchema.safeParse(parsedJson);
  if (!result.success) {
    throw new Error(`Invalid hook config ${path}: ${formatZodError(result.error)}`);
  }
  return flattenDeclarations(result.data);
}

/**
 * Loads and merges hook declarations from the user config (~/.anycode/config.json)
 * and the project config (<workspace>/.anycode/config.json); user entries come
 * first, both sets execute. A malformed config produces a descriptive error;
 * a missing file contributes nothing.
 */
export async function loadHookConfigs(
  fs: FileSystemPort,
  workspace: string,
  homedir: string,
): Promise<CommandHookDeclaration[]> {
  const userPath = configPath(homedir);
  const projectPath = configPath(workspace);

  const userDeclarations = await loadOneConfig(fs, userPath);
  // When workspace and homedir resolve to the same config, load it only once.
  const projectDeclarations =
    userPath === projectPath ? [] : await loadOneConfig(fs, projectPath);

  return [...userDeclarations, ...projectDeclarations];
}

/** Shape of a PreToolUse hook's stdout JSON (unknown keys are ignored). */
const preHookOutputSchema = z.object({
  permissionDecision: z.enum(["allow", "ask", "deny"]).optional(),
  reason: z.string().optional(),
  updatedInput: z.unknown().optional(),
});

/** The command ran to completion with a zero exit code. */
function exitedCleanly(result: ExecResult): boolean {
  return result.status === "completed" && result.exitCode === 0;
}

/** Human-readable cause for a non-clean exit (non-zero code, timeout, cancel, spawn error). */
function describeExit(result: ExecResult): string {
  return result.exitCode !== null ? `exit code ${result.exitCode}` : `status ${result.status}`;
}

function compileMatcher(matcher: string | undefined): RegExp | undefined {
  if (matcher === undefined) {
    return undefined;
  }
  try {
    return new RegExp(matcher);
  } catch (error) {
    throw new Error(`Invalid hook matcher /${matcher}/: ${describeError(error)}`);
  }
}

/**
 * Runs the command through ExecutionPort. The JSON payload is passed on
 * stdin (then EOF); the bounded metadata env vars ANYCODE_HOOK_EVENT /
 * ANYCODE_TOOL_NAME / ANYCODE_PROJECT_DIR are also set. stdout is capped at
 * HOOK_STDOUT_CAP_BYTES; the caller's abort signal is forwarded so the same
 * SIGTERM -> SIGKILL kill chain cancels the child.
 */
function runHookCommand(
  exec: ExecutionPort,
  decl: CommandHookDeclaration,
  cwd: string,
  toolName: string,
  payload: Record<string, unknown>,
  signal: AbortSignal,
): Promise<ExecResult> {
  return exec.run({
    command: decl.command,
    cwd,
    env: {
      ANYCODE_HOOK_EVENT: decl.event,
      ANYCODE_TOOL_NAME: toolName,
      ANYCODE_PROJECT_DIR: cwd,
    },
    stdin: JSON.stringify(payload),
    timeoutMs: decl.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS,
    maxOutputBytes: HOOK_STDOUT_CAP_BYTES,
    abortSignal: signal,
  });
}

/**
 * PreToolUse mapping: clean exit -> parse stdout JSON into a decision (empty or
 * unparseable stdout = no opinion); any non-clean exit = deny (fail-closed).
 */
function interpretPreToolUse(
  result: ExecResult,
  command: string,
): PreToolUseHookResult | undefined {
  if (exitedCleanly(result)) {
    const text = result.stdout.trim();
    if (!text) {
      return undefined;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      console.warn(`PreToolUse command hook '${command}' emitted non-JSON stdout — ignored`);
      return undefined;
    }
    const parsed = preHookOutputSchema.safeParse(json);
    if (!parsed.success) {
      console.warn(
        `PreToolUse command hook '${command}' emitted an invalid decision object — ignored`,
      );
      return undefined;
    }
    const output: PreToolUseHookResult = {};
    if (parsed.data.permissionDecision) {
      output.permissionDecision = parsed.data.permissionDecision;
    }
    if (parsed.data.reason !== undefined) {
      output.reason = parsed.data.reason;
    }
    if (parsed.data.updatedInput !== undefined) {
      output.updatedInput = parsed.data.updatedInput;
    }
    return output;
  }

  const stderr = result.stderr.trim();
  return {
    permissionDecision: "deny",
    reason: `PreToolUse command hook '${command}' denied (${describeExit(result)})${
      stderr ? `: ${stderr}` : ""
    }`,
  };
}

/** UserPromptSubmit mapping: clean exit -> trimmed stdout as additionalContext (fail-open). */
function interpretUserPromptSubmit(
  result: ExecResult,
  command: string,
): { additionalContext?: string } | undefined {
  if (exitedCleanly(result)) {
    const text = result.stdout.trim();
    return text ? { additionalContext: text } : undefined;
  }
  console.warn(
    `UserPromptSubmit command hook '${command}' failed (${describeExit(result)}) — skipped`,
  );
  return undefined;
}

/** Observer mapping (PostToolUse/PostToolUseFailure/Stop): a non-clean exit is warn-logged only. */
function warnObserverFailure(event: HookEvent, result: ExecResult, command: string): void {
  if (!exitedCleanly(result)) {
    const stderr = result.stderr.trim();
    console.warn(
      `${event} command hook '${command}' failed (${describeExit(result)})${
        stderr ? `: ${stderr}` : ""
      }`,
    );
  }
}

/**
 * Wraps a declaration into a HookRegistration whose hook function executes the
 * command through ExecutionPort. PreToolUse hooks map stdout/exit-code into a
 * permission decision (non-zero exit = deny, fail-closed); observer and
 * UserPromptSubmit hooks are fail-open (a failed command is warn-logged and
 * never propagates).
 */
export function createCommandHook(
  exec: ExecutionPort,
  decl: CommandHookDeclaration,
  cwd: string,
): HookRegistration {
  const matcher = compileMatcher(decl.matcher);

  switch (decl.event) {
    case "PreToolUse": {
      const hook: PreToolUseHook = async (input, signal) => {
        const result = await runHookCommand(
          exec,
          decl,
          cwd,
          input.toolName,
          { event: "PreToolUse", ...input },
          signal,
        );
        return interpretPreToolUse(result, decl.command);
      };
      return { event: "PreToolUse", matcher, hook };
    }

    case "PostToolUse":
    case "PostToolUseFailure": {
      const event = decl.event;
      const hook: PostToolUseHook = async (input, signal) => {
        const result = await runHookCommand(
          exec,
          decl,
          cwd,
          input.toolName,
          { event, ...input },
          signal,
        );
        warnObserverFailure(event, result, decl.command);
      };
      return { event, matcher, hook };
    }

    case "UserPromptSubmit": {
      const hook: UserPromptSubmitHook = async (input, signal) => {
        const result = await runHookCommand(
          exec,
          decl,
          cwd,
          "",
          { event: "UserPromptSubmit", ...input },
          signal,
        );
        return interpretUserPromptSubmit(result, decl.command);
      };
      return { event: "UserPromptSubmit", matcher, hook };
    }

    case "Stop": {
      const hook: StopHook = async (input, signal) => {
        const result = await runHookCommand(
          exec,
          decl,
          cwd,
          "",
          { event: "Stop", ...input },
          signal,
        );
        warnObserverFailure("Stop", result, decl.command);
      };
      return { event: "Stop", hook };
    }

    case "SubagentStop": {
      const hook: SubagentStopHook = async (input, signal) => {
        const result = await runHookCommand(
          exec,
          decl,
          cwd,
          // agentType is the matcher subject, exposed as ANYCODE_TOOL_NAME (the
          // same env slot PostToolUse fills with toolName).
          input.agentType,
          { event: "SubagentStop", ...input },
          signal,
        );
        warnObserverFailure("SubagentStop", result, decl.command);
      };
      return { event: "SubagentStop", matcher, hook };
    }

    default: {
      const exhaustive: never = decl.event;
      throw new Error(`Unknown hook event: ${String(exhaustive)}`);
    }
  }
}
