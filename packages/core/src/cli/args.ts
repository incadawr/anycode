/**
 * CLI argument parsing (design slice-4.1-cut.md §2.5/§3.3). Task 4.1.1 moved
 * parseCliArgs/isPermissionMode out of main.ts verbatim and froze the extended
 * return shape; it recognised the new flags (--print/-p, --help/-h, --version,
 * --no-color) additively — the existing --mode/--yolo/--resume flags still
 * parse byte-identically (their tests never moved). Task 4.1.4 (this file)
 * fills in the final `formatUsage()` synopsis (only-real flags, ANYCODE_* env,
 * the slash-command list from commands.ts's COMMAND_HELP) plus the

 * side-effect-free (unknown flags are silently skipped, as before) while
 * `collectUnknownFlags`/`formatUnknownFlagWarning` expose the
 * recognised-vs-unknown split as separate pure helpers a call site can use to
 * print `[warn] unknown flag: --x (see --help)` without parseCliArgs itself
 * writing anywhere.
 */

import { PERMISSION_MODES, type PermissionMode } from "../types/permissions.js";
import {
  ENV_API_KEY,
  ENV_BASE_URL,
  ENV_CONTEXT_WINDOW,
  ENV_DB_PATH,
  ENV_MAX_RETRIES,
  ENV_MAX_OUTPUT_TOKENS,
  ENV_REASONING_EFFORT,
  ENV_MAX_TURNS,
  ENV_MODEL,
  ENV_STALL_TIMEOUT_MS,
  ENV_TOOL_CONCURRENCY,
} from "../provider/env.js";
import { COMMAND_HELP, renderCommandHelp } from "./commands.js";

export interface CliArgs {
  mode: PermissionMode;
  yolo: boolean;
  resumeSessionId?: string;
  help: boolean;
  version: boolean;
  noColor: boolean;
  /** --no-reasoning: start with the model's reasoning stream hidden (design slice-4.2-cut.md §2.6). Default false (shown in interactive). */
  noReasoning: boolean;
  printPrompt?: string;
  /* */
  resumePicker: boolean;
  /* */
  continueSession: boolean;
  /* */
  print: boolean;
  /* */
  outputFormat?: string;
  /* */
  model?: string;
  /* */
  modeExplicit: boolean;
  /* */
  noCheckpoints: boolean;
  /** --image <path> / --image=<path>, repeatable (design slice-6.2-cut.md §2-D1): attaches to the next prompt (print: this run's one-shot prompt; interactive: pre-staged until the first submitted line drains it, or staged/listed/cleared via /image). Default []. */
  images: string[];
}

export function isPermissionMode(value: string): value is PermissionMode {
  return (PERMISSION_MODES as readonly string[]).includes(value);
}

interface ParsedArgv {
  args: CliArgs;
  /**
   * Flag-shaped tokens (leading "-") that matched none of the recognised

   * two-token flag (e.g. the session id after --resume) is never included
   * here even if it happens to start with "-".
   */
  unknownFlags: string[];
}

/**
 * Single recognition pass shared by parseCliArgs and collectUnknownFlags, so
 * the two views of argv can never drift apart. Parses --mode <mode>|
 * --mode=<mode> (default "build"), --yolo, --resume <sessionId>|
 * --resume=<sessionId> (task 1.7), plus the slice-4.1 additions:
 * --print <prompt>|--print=<prompt>|-p <prompt>|-p=<prompt>, --help|-h,
 * --version, --no-color; plus the slice-4.4 additions (design
 * slice-4.4-cut.md §2.1): a trailing bare --resume (no following token) sets
 * resumePicker instead of consuming a value — the existing two-token
 * --resume <id> consume (ANY following token, including one that looks like
 * a flag — design A7, frozen) and --resume=<id> forms are untouched — and
 * --continue|-c sets continueSession; plus the slice-4.5 additions (design
 * slice-4.5-cut.md §2.1): every --print/-p form (incl. trailing bare) sets
 * `print = true` in addition to the byte-frozen two-token consume-any/`=`
 * behaviour above, and a new --output-format <fmt>|--output-format=<fmt>
 * two-token flag (modelled on --mode's consume, but storing the value RAW —
 * no validation here, that lives in main.ts) with a trailing bare form
 * resolving to the empty string (fail-closed downstream, not a silent
 * default); plus the slice-4.6 additions (design slice-4.6-cut.md §2.2): a
 * new --model <id>|--model=<id> two-token flag (same raw-consume/trailing-bare
 * doctrine as --output-format), and `modeExplicit` — set true in the very same
 * conditions where `mode` itself is assigned below (i.e. only when the value
 * satisfies isPermissionMode) so the invalid-value silent-ignore behaviour
 * stays byte-frozen; plus the slice-4.7 addition (design slice-4.7-cut.md
 * §2.5): --no-checkpoints (mirrors --no-color's flat boolean parse) sets

 * plus the slice-6.2 addition (design slice-6.2-cut.md §2-D1): --image <path>|
 * --image=<path>, REPEATABLE (copies the --print/-p two-token consume-any
 * idiom verbatim, one call site per occurrence, appending to `images` instead
 * of overwriting a scalar) — a trailing bare --image (no following token)
 * pushes nothing, mirroring --print's bare-form "leave it unset" doctrine
 * rather than --output-format/--model's empty-string fail-closed doctrine
 * (an image path has no valid empty-string meaning).
 */
function parseArgv(argv: string[]): ParsedArgv {
  let mode: PermissionMode = "build";
  let modeExplicit = false;
  let yolo = false;
  let resumeSessionId: string | undefined;
  let help = false;
  let version = false;
  let noColor = false;
  let noReasoning = false;
  let printPrompt: string | undefined;
  let resumePicker = false;
  let continueSession = false;
  let print = false;
  let outputFormat: string | undefined;
  let model: string | undefined;
  let noCheckpoints = false;
  const images: string[] = [];
  const unknownFlags: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--yolo") {
      yolo = true;
      continue;
    }
    if (arg === "--mode") {
      const value = argv[i + 1];
      i++;
      if (value !== undefined && isPermissionMode(value)) {
        mode = value;
        modeExplicit = true;
      }
      continue;
    }
    if (arg.startsWith("--mode=")) {
      const value = arg.slice("--mode=".length);
      if (isPermissionMode(value)) {
        mode = value;
        modeExplicit = true;
      }
      continue;
    }
    if (arg === "--resume") {
      const value = argv[i + 1];
      if (value === undefined) {
        // Trailing bare --resume (design slice-4.4-cut.md §2.1): open the
        // boot-time resume-picker instead of consuming a (nonexistent) value.
        resumePicker = true;
        continue;
      }
      i++;
      // ANY following token, including one that looks like a flag (e.g.
      // "-abc") — A7, frozen; the picker only triggers on a truly trailing
      // --resume, never on this two-token consume.
      resumeSessionId = value;
      continue;
    }
    if (arg.startsWith("--resume=")) {
      resumeSessionId = arg.slice("--resume=".length);
      continue;
    }
    if (arg === "--continue" || arg === "-c") {
      continueSession = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--version") {
      version = true;
      continue;
    }
    if (arg === "--no-color") {
      noColor = true;
      continue;
    }
    if (arg === "--no-checkpoints") {
      noCheckpoints = true;
      continue;
    }
    if (arg === "--no-reasoning") {
      noReasoning = true;
      continue;
    }
    if (arg === "--print" || arg === "-p") {
      const value = argv[i + 1];
      i++;
      print = true;
      if (value !== undefined) {
        printPrompt = value;
      }
      continue;
    }
    if (arg.startsWith("--print=")) {
      print = true;
      printPrompt = arg.slice("--print=".length);
      continue;
    }
    if (arg.startsWith("-p=")) {
      print = true;
      printPrompt = arg.slice("-p=".length);
      continue;
    }
    if (arg === "--output-format") {
      const value = argv[i + 1];
      i++;
      // Raw store, no validation (parser stays pure — design slice-4.5-cut.md
      // §2.1); trailing bare resolves to "" (fail-closed in main, not a
      // silent default). Same consume-any doctrine as --resume/--mode: the
      // value is skipped over even if it looks like a flag (A8).
      outputFormat = value !== undefined ? value : "";
      continue;
    }
    if (arg.startsWith("--output-format=")) {
      outputFormat = arg.slice("--output-format=".length);
      continue;
    }
    if (arg === "--model") {
      const value = argv[i + 1];
      i++;
      // Raw store, no validation (parser stays pure — design slice-4.6-cut.md
      // §2.2); trailing bare resolves to "" (fail-closed in main, not a
      // silent default). Same consume-any doctrine as --resume/--mode/
      // --output-format: the value is skipped over even if it looks like a
      // flag.
      model = value !== undefined ? value : "";
      continue;
    }
    if (arg.startsWith("--model=")) {
      model = arg.slice("--model=".length);
      continue;
    }
    if (arg === "--image") {
      // Consume-any doctrine (--print/-p idiom, design slice-6.2-cut.md §2-D1):
      // whatever token follows is this occurrence's value, even if it looks
      // like a flag; a trailing bare --image (no next token) pushes nothing.
      const value = argv[i + 1];
      i++;
      if (value !== undefined) {
        images.push(value);
      }
      continue;
    }
    if (arg.startsWith("--image=")) {
      images.push(arg.slice("--image=".length));
      continue;
    }
    if (arg.startsWith("-")) {
      unknownFlags.push(arg);
    }
  }

  return {
    args: {
      mode,
      yolo,
      resumeSessionId,
      help,
      version,
      noColor,
      noReasoning,
      printPrompt,
      resumePicker,
      continueSession,
      print,
      outputFormat,
      model,
      modeExplicit,
      noCheckpoints,
      images,
    },
    unknownFlags,
  };
}

/**
 * Parses argv into the frozen CliArgs shape. Pure/side-effect-free: an
 * unrecognised `--flag` never throws or exits — it is simply absent from the

 * collectUnknownFlags/formatUnknownFlagWarning below).
 */
export function parseCliArgs(argv: string[]): CliArgs {
  return parseArgv(argv).args;
}

/**

 * argv tokens that parseCliArgs did not recognise, in encounter order. A call
 * site can pair each with formatUnknownFlagWarning to print the ratified
 * `[warn] unknown flag: --x (see --help)` diagnostic while parseCliArgs itself
 * stays a pure argv -> CliArgs function.
 */
export function collectUnknownFlags(argv: string[]): string[] {
  return parseArgv(argv).unknownFlags;
}

/* */
export function formatUnknownFlagWarning(flag: string): string {
  return `[warn] unknown flag: ${flag} (see --help)\n`;
}

/**
 * `--help` synopsis (design §3.3): only real flags (no promises of a future
 * slice's flag), the ANYCODE_* environment variables loadEnvConfig actually
 * reads (provider/env.ts), and the slash-command list from commands.ts's
 * COMMAND_HELP — so this text can never advertise a command the dispatcher
 * doesn't also know about. --continue/-c and the reworded --resume line are
 * real as of slice-4.4 (design slice-4.4-cut.md §2.1) — both flags this
 * synopsis mentions are wired end-to-end in this same slice. The reworded
 * --print line and the new --output-format line are real as of slice-4.5
 * (design slice-4.5-cut.md §2.1). The new --model line is real as of
 * slice-4.6 (design slice-4.6-cut.md §2.2). The new --no-checkpoints line is
 * real as of slice-4.7 (design slice-4.7-cut.md §2.5). The new --image line is
 * real as of slice-6.2 (design slice-6.2-cut.md §2-D1).
 */
export function formatUsage(): string {
  const lines = [
    "anycode — AI coding agent CLI",
    "",
    "Usage: anycode [options]",
    "",
    "Options:",
    "  --mode <plan|build|edit|auto|yolo>  permission mode for the session (default: build)",
    "  --model <id>                         model id override (default: $ANYCODE_MODEL; switch at runtime with /model)",
    "  --yolo                              auto-allow every tool call (no prompts)",
    "  --resume [sessionId]                 resume a session (no id: interactive picker)",
    "  --continue, -c                       resume the most recent session for this directory",
    "  --print [prompt], -p [prompt]        run one prompt non-interactively and exit (no prompt: read it from stdin; place -p last)",
    "  --output-format <fmt>                -p output: text | json | stream-json (default: text)",
    "  --no-color                           disable ANSI colour output",
    "  --no-reasoning                       hide the model's reasoning stream (shown by default in interactive mode)",
    "  --no-checkpoints                     disable automatic workspace checkpoints for this session",
    "  --image <path>                       attach an image to the next prompt; repeatable (print: this run's prompt; interactive: pre-staged, also /image)",
    "  --help, -h                           show this help and exit",
    "  --version                            show the CLI version and exit",
    "",
    "Environment:",
    `  ${ENV_API_KEY}             provider API key (required)`,
    `  ${ENV_MODEL}                   model id to request (required)`,
    `  ${ENV_BASE_URL}             provider base URL (default: native Anthropic)`,
    `  ${ENV_DB_PATH}                 session-history SQLite database path`,
    `  ${ENV_MAX_TURNS}               per-turn budget override`,
    `  ${ENV_MAX_OUTPUT_TOKENS}       max model output tokens`,
    `  ${ENV_REASONING_EFFORT}        reasoning effort: off|low|medium|high|max (gated per model)`,
    `  ${ENV_CONTEXT_WINDOW}          context-window token override`,
    `  ${ENV_MAX_RETRIES}             stream retry-count override`,
    `  ${ENV_TOOL_CONCURRENCY}        parallel read-only tool-batch cap`,
    `  ${ENV_STALL_TIMEOUT_MS}        per-attempt stall-watchdog override (ms)`,
    "",
    "Slash commands (inside a session):",
    renderCommandHelp(COMMAND_HELP).trimEnd(),
    "",
  ];
  return lines.join("\n") + "\n";
}
