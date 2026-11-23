import { relative, resolve, sep } from "node:path";
import { z } from "zod";
import { DEFAULT_TOOL_TIMEOUT_MS } from "../types/config.js";
import type { ReplCallInput, ReplCallSnapshot, ReplMetrics, ReplToolName } from "../types/subagent-card.js";
import type { ToolCallOutcome, ToolDefinition } from "../types/tools.js";
import { capUtf8Bytes } from "../util/bytes.js";
import { imageExtensionOf } from "../util/images.js";
import { RUNTIME_UNAVAILABLE, runCodeMode, type ScriptReply, type ScriptResult } from "./runtime.js";

const TOOL_NAMES = ["Read", "Write", "Edit", "Glob", "Grep", "Bash"] as const;
const tools: ReadonlySet<string> = new Set(TOOL_NAMES);
const PATH_TOOLS = new Set<ReplToolName>(["Read", "Write", "Edit"]);
const IMAGE_UNAVAILABLE = "image files are not readable from a script";

const description = `Run a JavaScript snippet that calls tools, to do several dependent steps
(search → read → edit → test) in ONE call and get back only what you need.

The code is the body of an async function. Plain JavaScript only: no require,
import, fs, process, fetch or timers. Every run starts fresh.

await call(tool, input) runs a tool with the same input fields as calling it
directly, with the same permission checks. It returns:
  Read  {file_path, offset?, limit?}  -> {content, totalLines, truncated}
        (check truncated; use offset/limit for big files)
  Write {file_path, content}          -> {bytesWritten, created}
  Edit  {file_path, old_string, new_string, replace_all?} -> {replacements}
  Glob  {pattern, path?}              -> {files, totalMatched, truncated}
  Grep  {pattern, path?, glob?, output_mode?, "-i"?, head_limit?}
        default output_mode "files_with_matches" -> {files, totalMatches}
        "content" -> {matches: [{path, lineNumber, line}]}; "count" -> {counts}
  Bash  {command, timeout?}           -> {exitCode, stdout, stderr}
        A nonzero exitCode does NOT throw: check it.
Paths may be relative to the global string \`cwd\`.
A failed call throws an Error with .tool, .status, .message; use try/catch
when failure is expected. A permission denial or Stop ends the script.

Rules:
- await every call; calls run one at a time, in order.
- return small, filtered data (paths, counts, matching lines, exit code, log
  tail), never whole files. Strings are returned as-is. console.log output
  is returned too (last 8 KB).
- Changes made before an error stay applied; the result lists them.

const g = await call("Grep", {pattern: "retryLimit = 3", output_mode: "content"});
const hit = g.matches[0];
await call("Edit", {file_path: hit.path, old_string: "retryLimit = 3", new_string: "retryLimit = 5"});
const t = await call("Bash", {command: "npm test -- retry"});
return {file: hit.path, exitCode: t.exitCode, tail: (t.stdout + t.stderr).slice(-1500)};

const g = await call("Glob", {pattern: "packages/*/package.json"});
const names = [];
for (const path of g.files) {
  const r = await call("Read", {file_path: path});
  names.push(JSON.parse(r.content).name);
}
return names;`;

const schema = z.object({ code: z.string(), description: z.string().optional() });

function isToolName(tool: string): tool is ReplToolName {
  return tools.has(tool);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const INPUT_FIELDS: Record<ReplToolName, readonly string[]> = {
  Read: ["file_path", "offset", "limit"],
  Write: ["file_path", "content"],
  Edit: ["file_path", "replace_all", "old_string", "new_string"],
  Glob: ["pattern", "path"],
  Grep: ["pattern", "path", "glob", "output_mode", "-i", "head_limit"],
  Bash: ["command", "description", "timeout"],
};

function inputPreview(tool: ReplToolName, input: unknown): ReplCallInput {
  const fields: Record<string, unknown> = {};
  if (!isRecord(input)) return { fields };
  const keys = INPUT_FIELDS[tool].filter(key => Object.hasOwn(input, key));
  const budget = tool === "Write" || tool === "Edit" ? 32 * 1024 : 2 * 1024;
  // Reserve JSON framing and divide the remaining budget among fields so the
  // old and new text both survive when an Edit exceeds its cap.
  let remaining = budget - 128;
  let truncated = false;
  for (const [index, key] of keys.entries()) {
    const value = input[key];
    if (typeof value === "string") {
      const cap = Math.floor(remaining / (keys.length - index));
      const candidate = capUtf8Bytes(value, cap).text;
      let prefix = candidate;
      if (Buffer.byteLength(JSON.stringify(candidate)) - 2 > cap) {
        const codePoints = Array.from(candidate);
        let low = 0;
        let high = codePoints.length;
        while (low < high) {
          const mid = Math.ceil((low + high) / 2);
          const bytes = Buffer.byteLength(JSON.stringify(codePoints.slice(0, mid).join(""))) - 2;
          if (bytes <= cap) low = mid;
          else high = mid - 1;
        }
        prefix = codePoints.slice(0, low).join("");
      }
      fields[key] = prefix;
      remaining -= Buffer.byteLength(JSON.stringify(prefix)) - 2;
      truncated ||= prefix !== value;
    } else if (typeof value === "number" || typeof value === "boolean" || value === null) {
      fields[key] = value;
      remaining -= Buffer.byteLength(JSON.stringify(value));
    } else {
      truncated = true;
    }
  }
  return truncated ? { fields, truncated: true } : { fields };
}

// Effects are shown to the model with forward slashes on every platform.
export function effectPath(
  cwd: string, filePath: string, api: { relative: typeof relative; sep: string } = { relative, sep },
): string {
  const shown = api.relative(cwd, filePath) || filePath;
  return shown.split(api.sep).join("/");
}

function effect(cwd: string, tool: ReplToolName, input: unknown, outcome: ToolCallOutcome): string | undefined {
  const output = outcome.result?.output;
  if (!isRecord(input) || !isRecord(output)) return undefined;
  const { file_path, command } = input;
  if (tool === "Bash" && typeof command === "string") {
    return `Bash ${JSON.stringify(capUtf8Bytes(command, 160).text)} ${typeof output.exitCode === "number" ? `exit ${output.exitCode}` : outcome.status}`;
  }
  if (outcome.status !== "success" || typeof file_path !== "string") return undefined;
  const path = capUtf8Bytes(effectPath(cwd, file_path), 160).text;
  if (tool === "Edit") return `Edit ${path} (${output.replacements})`;
  if (tool === "Write") return `Write ${path}`;
  return undefined;
}

function modelText(script: ScriptResult, calls: ReplCallSnapshot[], effects: string): string {
  const lines: string[] = [];
  if (script.endReason === "ok") {
    if (script.value !== undefined) lines.push(script.value);
    if (script.console) lines.push(`console:\n${script.console}`);
    if (lines.length === 0) lines.push("(script returned nothing — use return)");
    if (effects) lines.push(`effects: ${effects}`);
    if (script.unawaitedCalls) lines.push(`note: ${script.unawaitedCalls} calls were not awaited`);
    return lines.join("\n");
  }

  const error = script.error;
  const message = error?.message ?? script.endReason;
  // Only a real load failure short-circuits; a guest error with the same wording keeps its effects.
  if (script.unavailable) return message;
  const sourceLine = error?.line ? script.source.split(/\r\n|[\r\n\u2028\u2029]/)[error.line - 1] : undefined;
  const column = script.endReason === "syntax" && error?.column ? `, column ${error.column}` : "";
  const location = error?.line ? ` at line ${error.line}${column}: ${sourceLine ?? ""}` : "";
  lines.push(`error: ${message}${location}`);
  if (script.endReason === "syntax") {
    lines.push("no calls ran; fix and resend");
    return lines.join("\n");
  }
  if (error?.name === "ReferenceError") lines.push("available: call, cwd, console.log");
  if (calls.length) {
    lines.push("calls:");
    for (const [index, call] of calls.entries()) {
      const { file_path, command, pattern } = call.input.fields;
      const label = file_path ?? command ?? pattern;
      const shortInput = typeof label === "string" ? ` ${JSON.stringify(capUtf8Bytes(label, 96).text)}` : "";
      const threw = call.callId === error?.callId ? "   ← threw" : "";
      lines.push(` ${index + 1} ${call.toolName}${shortInput} ${call.status === "success" ? "ok" : call.status}${threw}`);
    }
  }
  lines.push(`effects: ${effects || "none"}`);
  if (script.endReason === "uncaught" && script.unawaitedCalls) {
    lines.push(`note: ${script.unawaitedCalls} calls were not awaited`);
  }
  return lines.join("\n");
}

interface ReplOutput {
  text: string;
  effects: string;
}

export const replTool: ToolDefinition<z.infer<typeof schema>, ReplOutput> = {
  metadata: {
    name: "REPL",
    description,
    readOnly: true,
    destructive: false,
    concurrentSafe: false,
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    composite: true,
    // The composite dispatcher awaits the handler. Children enforce their deadlines.
    timeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
    resultBudget: { maxModelBytes: 32 * 1024, strategy: "artifact", artifact: { retention: "session" } },
  },
  inputSchema: schema,
  async handler({ code }, ctx) {
    const dispatchNested = ctx.dispatchNested;
    const replMetrics: ReplMetrics = { nestedCalls: 0, nestedByTool: {}, endReason: "uncaught", activeJsMs: 0 };
    if (!dispatchNested) return { ok: false, error: RUNTIME_UNAVAILABLE, replMetrics };

    const calls: ReplCallSnapshot[] = [];
    const applied: string[] = [];
    // The runtime drains its accepted calls one at a time. Keep the active
    // dispatch here so Stop can wait for the ordinary child outcome.
    let active: Promise<ScriptReply> | undefined;
    const script = await runCodeMode(code, ctx.cwd, {
      signal: ctx.abortSignal,
      dispatch: (tool, input) => {
        active = dispatch(tool, input);
        return active;
      },
    });
    await active;
    replMetrics.endReason = script.endReason;
    replMetrics.activeJsMs = script.activeJsMs;
    const effects = applied.join("; ");
    const text = modelText(script, calls, effects);
    return {
      ok: script.endReason === "ok",
      output: { text, effects },
      error: script.endReason === "ok" ? undefined : text,
      replMetrics,
      presentation: { repl: { code: capUtf8Bytes(script.source, 32 * 1024).text, calls } },
      errorKind: script.endReason === "cancelled" ? "cancelled" : undefined,
    };

    async function dispatch(tool: string, input: unknown): Promise<ScriptReply> {
      if (!isToolName(tool)) return { status: "invalid_input", message: `Unknown tool: ${tool}` };
      if (isRecord(input)) {
        if (tool === "Bash" && input.run_in_background === true) {
          return { status: "invalid_input", message: "background Bash is not available from a script" };
        }
        if (PATH_TOOLS.has(tool) && typeof input.file_path === "string") {
          const filePath = resolve(ctx.cwd, input.file_path);
          if (tool === "Read" && imageExtensionOf(filePath)) {
            return { status: "invalid_input", message: IMAGE_UNAVAILABLE };
          }
          input = { ...input, file_path: filePath };
        }
      }

      const id = `${ctx.toolCallId}.${++replMetrics.nestedCalls}`;
      replMetrics.nestedByTool[tool] = (replMetrics.nestedByTool[tool] ?? 0) + 1;
      const start = { callId: id, toolName: tool, input: inputPreview(tool, input) };
      ctx.emit?.({ type: "repl_call_start", toolCallId: ctx.toolCallId, ...start });
      const outcome = await dispatchNested!({ id, name: tool, input });
      const effectiveInput = outcome.effectiveInput ?? input;
      const image = Boolean(outcome.result?.images?.length);
      const child: ReplCallSnapshot = {
        ...start,
        input: inputPreview(tool, effectiveInput),
        status: image ? "invalid_input" : outcome.status,
        durationMs: outcome.durationMs,
        outputPreview: capUtf8Bytes(image ? IMAGE_UNAVAILABLE : outcome.modelText, 2 * 1024).text,
      };
      calls.push(child);
      const appliedEffect = effect(ctx.cwd, tool, effectiveInput, outcome);
      if (appliedEffect) applied.push(appliedEffect);
      ctx.emit?.({ type: "repl_call_end", toolCallId: ctx.toolCallId, callId: id, outcome: child });
      if (image) return { status: "invalid_input", message: IMAGE_UNAVAILABLE, callId: id };
      switch (outcome.status) {
        case "success":
          return { status: "ok", output: outcome.result?.output };
        case "max_turns":
          return { status: "error", message: outcome.modelText, callId: id };
        default:
          return { status: outcome.status, message: outcome.modelText, callId: id };
      }
    }
  },
  formatResultForModel: result => result.output?.text ?? result.error ?? "",
  formatPersistedModelContent({ result, path, originalBytes, preview }) {
    const effects = result.output?.effects;
    return [
      "<persisted-output>",
      `Output too large (${originalBytes} bytes). Full output saved to: ${path}`,
      preview,
      ...(effects ? [`effects: ${effects}`] : []),
      "</persisted-output>",
    ].join("\n");
  },
};
