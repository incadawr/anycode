/**
 * Taskana 4702 Stage 1: the ask-zone classifier — pure core (no I/O).
 *
 * The classifier is consulted ONLY on a call the deterministic layer already
 * left as "ask" (the dispatcher's ask branch, decision 1 of the card). Its one
 * power is to turn that ask into "allow". It never produces "deny", never runs
 * on an allow/deny ruling, never overrides a hook, and every failure path
 * (throw, timeout, abort, bad output, missing classifier) resolves to "ask".
 *
 * Three pure pieces live here:
 *   - `isClassifiableAsk`: the eligibility gate (what may even be consulted);
 *   - `validateAskVerdict`: the strict verdict-shape check;
 *   - `classifyAsk`: the fail-closed wrapper (hard timeout, caller abort, never throws);
 * plus `recentUserTurns`, the bounded human-only context the classifier sees.
 */

import type { HistoryItem } from "../types/history.js";
import type { PermissionRequest, PermissionRuling } from "../types/permissions.js";
import { splitBashSegments } from "./rules.js";

/** Commands longer than this are never consulted (card decision 1). */
export const ASK_CLASSIFIER_MAX_COMMAND_CHARS = 2000;
/** Hard deadline for one classification (card decision 3). */
export const ASK_CLASSIFIER_DEFAULT_TIMEOUT_MS = 5000;
/** Cap on any reason string that leaves the classifier boundary. */
export const ASK_CLASSIFIER_REASON_MAX_CHARS = 300;
/** Human turns handed to the classifier, newest last. */
export const ASK_CLASSIFIER_USER_TURNS = 3;
/** Per-turn truncation of the human context. */
export const ASK_CLASSIFIER_USER_TURN_MAX_CHARS = 500;

/** Privilege escalators: never auto-decided, whatever the classifier says. */
export const NEVER_AUTO_BINARIES: ReadonlySet<string> = new Set(["sudo", "su", "doas", "pkexec"]);

/** `git push` flags that rewrite or delete remote history. `-f`/`-d` and
 * short clusters containing them, and `+ref` refspecs, are matched in code. */
export const FORCE_PUSH_FLAGS: ReadonlySet<string> = new Set([
  "--force",
  "--force-with-lease",
  "--mirror",
  "--delete",
]);

/** Shells and evaluators: a pipe into one of these is a "download and run" shape. */
export const SHELL_PIPE_TARGETS: ReadonlySet<string> = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "eval",
  // Taskana 4730 xfix D2: script RUNTIMES are the same "download and run"
  // shape as a shell — a pipe into node/python/perl/ruby/env/deno/bun
  // executes attacker-controlled code exactly like `curl | sh`, so it is
  // never classifiable no matter what the context says.
  "node",
  "python",
  "python3",
  "perl",
  "ruby",
  "env",
  "deno",
  "bun",
]);

/** The classifier's input. Deliberately closed: no registry, ports, history or tool objects. */
export interface AskClassifierInput {
  toolName: "Bash";
  /** The raw command line, as the model proposed it (bounded by the gate). */
  command: string;
  /** The parsed segments of `command` (splitBashSegments), blanks kept. */
  segments: string[];
  cwd: string;
  /** The last human turns, truncated; never assistant text or tool output. */
  userContext: string[];
}

/** What a classifier may say. There is no `deny`: the type cannot express one. */
export interface AskClassifierVerdict {
  decision: "allow" | "ask";
  reason: string;
  score?: number;
}

export interface AskClassifier {
  /** Stable identity for the journal, e.g. `command:da`. */
  readonly id: string;
  classify(input: AskClassifierInput, opts: { signal?: AbortSignal }): Promise<AskClassifierVerdict>;
}

export type AskEligibility =
  | { eligible: true; segments: string[] }
  | { eligible: false; reason: string };

/** Quotes and backslashes removed, so `"sudo"`, `'sudo'` and `s"udo"` all compare equal to `sudo`. */
function normalizedTokens(segment: string): string[] {
  return segment
    .split(/\s+/)
    .map((token) => token.replace(/["'\\]/g, ""))
    .filter((token) => token.length > 0);
}

function basename(token: string): string {
  return token.split("/").pop() ?? token;
}

const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** The first token that is not a `VAR=value` assignment: the command word. */
function commandWord(segment: string): string | undefined {
  for (const token of normalizedTokens(segment)) {
    if (!ASSIGNMENT_RE.test(token)) return basename(token);
  }
  return undefined;
}

function isForceLike(token: string): boolean {
  if (FORCE_PUSH_FLAGS.has(token)) return true;
  if (token.startsWith("--force-with-lease=")) return true;
  if (token.startsWith("+")) return true; // `+ref` refspec forces the update
  // Short-option cluster containing f (force) or d (delete): `-f`, `-fu`, `-d`.
  if (/^-[a-zA-Z]+$/.test(token) && /[fd]/.test(token)) return true;
  return false;
}

function isForcePush(segment: string): boolean {
  const tokens = normalizedTokens(segment).map(basename);
  const gitIndex = tokens.indexOf("git");
  if (gitIndex === -1) return false;
  const pushIndex = tokens.indexOf("push", gitIndex + 1);
  if (pushIndex === -1) return false;
  return normalizedTokens(segment).slice(pushIndex + 1).some(isForceLike);
}

export type ClassifierEligibilityReason =
  | "not-ask"
  | "hook-escalated"
  | "not-bash"
  | "no-command"
  | "command-too-long"
  | "unparseable"
  | "never-auto-binary"
  | "force-push"
  | "pipe-to-shell";

/**
 * Decides whether a Bash ask may be shown to the classifier at all. Pure.
 * Every exclusion keeps the ask; only a fully eligible call is consulted.
 * Workspace and sandbox boundaries are enforced upstream by the engines and
 * are not re-decided here.
 */
export function isClassifiableAsk(
  request: PermissionRequest,
  ruling: PermissionRuling,
  hookEscalated: boolean,
): AskEligibility {
  const refuse = (reason: ClassifierEligibilityReason): AskEligibility => ({ eligible: false, reason });
  if (ruling.decision !== "ask") return refuse("not-ask");
  if (hookEscalated) return refuse("hook-escalated");
  if (request.toolName !== "Bash") return refuse("not-bash");
  const input = request.input;
  const command =
    input !== null && typeof input === "object" ? (input as { command?: unknown }).command : undefined;
  if (typeof command !== "string" || command.trim().length === 0) return refuse("no-command");
  if (command.length > ASK_CLASSIFIER_MAX_COMMAND_CHARS) return refuse("command-too-long");
  const parsed = splitBashSegments(command);
  if (parsed === undefined) return refuse("unparseable");

  for (const segment of parsed.segments) {
    for (const token of normalizedTokens(segment)) {
      if (NEVER_AUTO_BINARIES.has(basename(token))) return refuse("never-auto-binary");
    }
    if (isForcePush(segment)) return refuse("force-push");
  }

  // A `|` (also the `|&` spelling) whose next non-blank segment is a shell.
  for (let i = 0; i < parsed.separators.length; i++) {
    if (parsed.separators[i] !== "|") continue;
    for (let j = i + 1; j < parsed.segments.length; j++) {
      const target = parsed.segments[j] ?? "";
      if (target.trim().length === 0) continue;
      const word = commandWord(target);
      if (word !== undefined && SHELL_PIPE_TARGETS.has(word)) return refuse("pipe-to-shell");
      break;
    }
  }

  return { eligible: true, segments: parsed.segments };
}

export type AskVerdictValidation =
  | { ok: true; verdict: AskClassifierVerdict }
  | { ok: false; error: string };

export function capReason(text: string): string {
  return text.length > ASK_CLASSIFIER_REASON_MAX_CHARS
    ? text.slice(0, ASK_CLASSIFIER_REASON_MAX_CHARS)
    : text;
}

/**
 * Strict verdict-shape check. Anything except a well-formed allow/ask with a
 * non-empty string reason (and, when present, a finite score) is rejected, so
 * the caller falls back to ask with the error recorded.
 */
export function validateAskVerdict(value: unknown): AskVerdictValidation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "classifier output is not an object" };
  }
  const record = value as { decision?: unknown; reason?: unknown; score?: unknown };
  if (record.decision !== "allow" && record.decision !== "ask") {
    return { ok: false, error: "classifier decision is not allow or ask" };
  }
  if (typeof record.reason !== "string" || record.reason.trim().length === 0) {
    return { ok: false, error: "classifier reason is missing" };
  }
  const verdict: AskClassifierVerdict = {
    decision: record.decision,
    reason: capReason(record.reason.trim()),
  };
  if (record.score !== undefined) {
    if (typeof record.score !== "number" || !Number.isFinite(record.score)) {
      return { ok: false, error: "classifier score is not a finite number" };
    }
    verdict.score = record.score;
  }
  return { ok: true, verdict };
}

export interface ClassifyAskOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  now?: () => number;
}

export interface ClassifyAskResult {
  verdict: AskClassifierVerdict;
  /** Present exactly when the verdict is a fallback to ask because something went wrong. */
  error?: string;
  latencyMs: number;
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return capReason(text.length > 0 ? text : "classifier failed");
}

/**
 * Runs one classification with a hard deadline and the caller's abort, and
 * never throws. Every path other than a valid allow/ask verdict resolves to
 * ask with `error` set. The classifier's own signal is aborted on timeout and
 * on caller abort so an out-of-process classifier can be killed.
 */
export async function classifyAsk(
  classifier: AskClassifier,
  input: AskClassifierInput,
  opts: ClassifyAskOptions = {},
): Promise<ClassifyAskResult> {
  const now = opts.now ?? Date.now;
  const started = now();
  const timeoutMs = opts.timeoutMs ?? ASK_CLASSIFIER_DEFAULT_TIMEOUT_MS;
  const latency = (): number => Math.max(0, now() - started);
  const fallback = (error: string): ClassifyAskResult => ({
    verdict: { decision: "ask", reason: capReason(error) },
    error: capReason(error),
    latencyMs: latency(),
  });

  if (opts.signal?.aborted === true) return fallback("classifier aborted before it started");

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const guard = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`classifier timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      onAbort = (): void => {
        controller.abort();
        reject(new Error("classifier aborted by the caller"));
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });
    });
    // `Promise.resolve().then` turns a synchronous throw into a rejection.
    const call = Promise.resolve().then(() => classifier.classify(input, { signal: controller.signal }));
    const raw: unknown = await Promise.race([call, guard]);
    const checked = validateAskVerdict(raw);
    if (!checked.ok) return fallback(checked.error);
    return { verdict: checked.verdict, latencyMs: latency() };
  } catch (error) {
    return fallback(errorText(error));
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) opts.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * The last `count` human turns, oldest first, each truncated to `maxChars`.
 * Only `role: "user"` text counts. Assistant text and tool results are never
 * included (prompt-injection guard), and neither are background-injected
 * frames (`origin: "system"`), which the human did not type.
 */
export function recentUserTurns(
  items: readonly HistoryItem[],
  count: number,
  maxChars: number,
): string[] {
  const out: string[] = [];
  for (let i = items.length - 1; i >= 0 && out.length < count; i--) {
    const item = items[i];
    if (item === undefined || item.origin === "system") continue;
    const message = item.message;
    if (message.role !== "user" || typeof message.content !== "string") continue;
    out.push(message.content.length > maxChars ? message.content.slice(0, maxChars) : message.content);
  }
  return out.reverse();
}
