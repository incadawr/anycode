/**
 * CLI harness: readline REPL over the agent loop.
 * Wiring (implemented in task 0.2, integrated in 0.6):
 *   loadEnvConfig -> AiSdkModelPort -> createDefaultToolRegistry ->
 *   InMemoryHookRunner + ModePermissionEngine + DenyPermissionBroker
 *   (AllowAllPermissionBroker only behind an explicit --yolo flag) ->
 *   AgentLoop -> render AgentEvents to the terminal (text deltas inline,
 *   tool calls/results as prefixed lines). Ctrl+C aborts the in-flight turn
 *   via AbortController before exiting.
 *
 * Slice 4.1 (design slice-4.1-cut.md §2.1) split this once-monolithic file into
 * cli/{args,render,commands,theme,terminal-broker,print}.ts. main.ts stays the
 * entry point (isDirectRun auto-run guard) + runCli wiring (design §2.6, owned
 * by task 4.1.1 — the wave never touches this file) + a re-export shim of every
 * public symbol that moved out, so existing importers (main.test.ts) need no
 * import changes — the proof that the split is behaviour-neutral.
 */

import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { homedir, release } from "node:os";
import { dirname, join } from "node:path";
import {
  NodeExecutionAdapter,
  NodeFileSystemAdapter,
  NodeGitAdapter,
  NodeHttpAdapter,
  NodeMcpTransportFactory,
} from "../adapters/node/index.js";
// Not re-exported from adapters/node/index.js (barrel is frozen to 1.1); imported
// directly from their owning module per task 1.7's file ownership.
import { SqlitePersistenceAdapter, WriteBehindHistorySink } from "../adapters/node/sqlite-persistence.js";
// Registered only by this CLI wiring (design slice-4.7-cut.md §2.9/L1): the
// shadow-git checkpoint service. Imported directly from its owning module
// (checkpoints/ is not in the ports barrel), same pattern as the sqlite adapter.
import { ShadowGitCheckpoints } from "../checkpoints/shadow-git.js";
// Telemetry sink (design slice-6.6-cut.md §2-C1): imported directly from its
// owning module (not through the adapters/node barrel), same pattern as the
// sqlite adapter and ShadowGitCheckpoints above.
import { JsonlTelemetrySink } from "../adapters/node/node-telemetry.js";
import { ConversationHistory } from "../context/history.js";
import { deriveSessionTitle, generateSessionTitle, sanitizeTitleSource } from "../context/session-title.js";
import { createDefaultTokenizer } from "../context/tokenizer.js";
import {
  InMemoryHookRunner,
  createCommandHook,
  loadHookConfigs,
  type CommandHookDeclaration,
} from "../dispatch/index.js";
import { discoverExtensions, type ExtensionsBootstrap } from "../extensions/bootstrap.js";
import { AgentLoop, type AgentLoopConfig } from "../loop/index.js";
import { LspManager, loadLspServerSpecs } from "../lsp/index.js";
import { McpManager, loadMcpServerSpecs } from "../mcp/index.js";
import {
  ModePermissionEngine,
  RuleAwarePermissionEngine,
  SafeCommandPermissionEngine,
} from "../permissions/index.js";
import type { McpServerSpec } from "../ports/mcp.js";
import type { ImageAttachment, MediaCapabilityPort, ModelPort, TelemetryPort } from "../ports/index.js";
import type { LspServerSpec } from "../ports/lsp.js";
import { buildSystemPrompt, type SystemPromptEnv } from "../prompts/identity.js";
import { buildRepoMapPromptSection, loadRepoMapConfig, type RepoMapConfig } from "../repoMap/index.js";
import { resolveImageInput, resolveContextWindow, resolveMaxOutputTokens, resolveReasoningEffort } from "../provider/capabilities.js";
import { getBuiltinCatalog } from "../provider/catalog-data.js";
import type { ProviderTransport } from "../provider/catalog.js";
import { ENV_API_KEY, ENV_MODEL, loadEnvConfig } from "../provider/env.js";
import { AiSdkModelPort } from "../provider/model-port.js";
import type { RetryPolicy } from "../provider/retry.js";
import { createSkillPort } from "../skills/discovery.js";
import { withSubagents } from "../subagents/index.js";


// backgroundCapableBashTool below is exported from the tools barrel alongside
// the two peek/kill tools — unlike exitPlanModeTool's direct-past-the-barrel
// import, these three ARE in tools/index.ts, B8), and BashOutput/BashKill are
// new tools with no other consumer. Gated on tasksEnabled (below) so print
// mode and the desktop registry (createDefaultToolRegistry, untouched) never
// see them.
import { InProcessTaskManager } from "../tasks/index.js";
import {
  backgroundCapableBashTool,
  bashKillTool,
  bashOutputTool,
  createDefaultToolRegistry,
  createWebSearchTool,
  diagnosticsEditTool,
  diagnosticsWriteTool,
  imageCapableReadTool,
} from "../tools/index.js";

// createDefaultToolRegistry and NOT in the tools barrel, so the desktop prompt
// and every child registry stay byte-identical. Imported directly past the barrel
// (same pattern as the sqlite adapter above).
import { exitPlanModeTool } from "../tools/exit-plan-mode.js";
import { InMemoryTodoStore } from "../tools/todo-store.js";
import {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  IMAGE_MAX_PER_MESSAGE,
  REPO_MAP_MAX_TOKENS,
  REPO_MAP_MIN_TOKENS,
  REPO_MAP_WINDOW_FRACTION,
} from "../types/config.js";
import { type PermissionMode } from "../types/permissions.js";
import { loadImageAttachment } from "../util/images.js";
import { loadWebSearchConfig, type ResolvedWebSearchBackend } from "../websearch/index.js";
import { buildTelemetryTap, loadTelemetryConfig, type ResolvedTelemetryConfig } from "../telemetry/index.js";
import { withWorkflows } from "../workflow/engine.js";
import { formatUsage, parseCliArgs } from "./args.js";
import { renderEvent, toWorkflowMeta, type TranscriptOptions } from "./render.js";
import { handleSlashCommand, isSlashCommand } from "./commands.js";
import { SwitchableModelPort, matchCatalogEntryByBaseUrl } from "./model.js";
import {
  formatRelativeTime,
  promptSessionSelection,
  shortSessionId,
  SESSIONS_PICKER_LIMIT,
} from "./sessions.js";
import { withPlanModeReminder } from "./plan.js";
import { withBackgroundTaskNotices } from "./background-notice.js";
import { applyStatus, createStatusLine, withStatusClear } from "./status.js";
import { createCliTheme, detectColorEnabled } from "./theme.js";
import { createCliPermissionBroker, createReadlinePrompter } from "./terminal-broker.js";
import {
  runPrintMode,
  readPromptFromStdin,
  PRINT_OUTPUT_FORMATS,
  type PrintOutputFormat,
} from "./print.js";
import {
  appendAlwaysAllowRule,
  defaultSettingsFilePath,
  loadPersistedAlwaysAllowRules,
  PersistingSessionPermissionRules,
} from "./settings-rules.js";

// Re-export shim (design slice-4.1-cut.md §2.1): every public symbol moved out
// of main.ts is re-exported here so existing importers (main.test.ts) need no
// import changes. This shim IS the proof of split-neutrality.
export { parseCliArgs } from "./args.js";
export {
  renderEvent,
  renderMcpStatusTable,
  renderSkillsTable,
  renderWorkflowsTable,
  toWorkflowMeta,
} from "./render.js";
export { KNOWN_SLASH_COMMANDS, isSlashCommand, parseAllowCommand, handleSlashCommand } from "./commands.js";
export type { AllowCommandParse, SlashCommandDeps } from "./commands.js";

/** Basename via a bare separator scan (mirrors tools/read-image.ts's private helper — no node:path). */
function basenameOf(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return slash === -1 ? path : path.slice(slash + 1);
}

export interface CliOptions {
  cwd: string;
  mode: PermissionMode;
  /** Behind an explicit --yolo flag: swaps DenyPermissionBroker for AllowAllPermissionBroker. */
  yolo: boolean;
  /** Defaults to process.argv.slice(2); override for tests. */
  argv: string[];
  env: NodeJS.ProcessEnv;
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  /**

   * stdout=text_delta, stderr=banners/usage/tool lines as SEPARATE streams).
   * Defaults to process.stderr; overridable so the print e2e can inject a
   * distinct PassThrough without the wave having to touch main.ts. Ignored in
   * REPL mode (everything goes to `output`, byte-identical to today).
   */
  errorOutput?: NodeJS.WritableStream;
  /** Session id to resume (task 1.7); loads its persisted history instead of starting fresh. */
  resumeSessionId?: string;
  /** Test-only override: bypasses AiSdkModelPort/envConfig wiring entirely when set. */
  modelPort?: ModelPort;
  /* */
  modelPortFactory?: (modelId: string) => ModelPort;
  /** Test-only override of interactivity (design slice-4.1-cut.md §2.5); default: input.isTTY && output.isTTY. */
  interactive?: boolean;
  /**

   * mirroring `interactive`. Production leaves this undefined so the gate falls
   * back to the REAL output isTTY ∧ interactive ∧ TERM≠dumb — the invariant that
   * keeps PassThrough tests with interactive:true spinner-free by construction.
   */
  statusLine?: boolean;
  /**
   * Test-only override for the tier-2 LLM title refinement one-shot (Phase 4

   * `statusLine`'s test-only-override shape. Defaults to `modelPort ===
   * undefined` — i.e. refinement runs in production (the CLI built a real
   * AiSdkModelPort) but stays off for the scripted-ModelPort test suites
   * (CountingModelPort/SequencedModelPort), whose call-count assertions would
   * otherwise be thrown off by an extra fire-and-forget streamText call.
   */
  sessionTitleRefinement?: boolean;
  /**
   * Test-only override for the per-turn workspace checkpoint mechanic (Phase 4

   * `sessionTitleRefinement`'s test-only-override shape: an explicit option wins
   * outright (the `??` short-circuit); absent, checkpoints run in the production
   * interactive REPL but stay off for `--print`, `--no-checkpoints`, and the
   * scripted-ModelPort test suites (modelPort injected) — whose per-turn
   * call-count assertions and byte snapshots must never see a new git spawn or a
   * new checkpoint event (L2). Slice tests opt in explicitly via `checkpoints: true`.
   */
  checkpoints?: boolean;
  /**
   * Test-only override of the always-allow rules persistence path (design
   * slice-P7.5-cut.md §3.2), mirroring `sessionTitleRefinement`'s test-only-
   * override shape. Defaults to `env.ANYCODE_SETTINGS_PATH` if set, else
   * `defaultSettingsFilePath()` (`~/.anycode/settings.json`, the same file
   * desktop main reads/writes) — production never sets either. Scripted-env
   * test suites that exercise `/allow`/broker "a" (or merely boot-seed through
   * a `runCli()` drive) set one of the two so a test run never reads or
   * writes the owner's real settings.json.
   */
  settingsFilePath?: string;
  /** Test/embedding override for user-scope config discovery; production uses os.homedir(). */
  home?: string;
}

export async function runCli(options?: Partial<CliOptions>): Promise<number> {
  const argv = options?.argv ?? process.argv.slice(2);
  const parsedArgs = parseCliArgs(argv);

  const cwd = options?.cwd ?? process.cwd();
  const home = options?.home ?? homedir();

  // (test override) OR an explicit valid --mode. The final `mode` is resolved
  // LATER, under session resolution, so a resume can restore the persisted mode
  // when neither is present (4.4-R1). An invalid --mode value is silently ignored
  // by the parser (byte-frozen) ⇒ modeExplicit stays false ⇒ counts as NOT explicit.
  const modeOverride = options?.mode ?? (parsedArgs.modeExplicit ? parsedArgs.mode : undefined);
  const yolo = options?.yolo ?? parsedArgs.yolo;
  const env = options?.env ?? process.env;
  const input = options?.input ?? process.stdin;
  const output = options?.output ?? process.stdout;

  const write = (text: string): void => {
    output.write(text);
  };


  if (parsedArgs.help) {
    write(formatUsage());
    return 0;
  }
  if (parsedArgs.version) {

    // valid while the CLI is not bundled (barrel-guard, §0.1). Resolves to
    // packages/core/package.json at runtime.
    const requirePkg = createRequire(import.meta.url);
    const pkg = requirePkg("../../package.json") as { version: string };
    write(`anycode ${pkg.version}\n`);
    return 0;
  }


  // from the print branch (was resolved inline at the runPrintMode call). Behavior-
  // neutral — help/version above never touch it. `errWrite` is the fail-fast usage/
  // guard channel below (always stderr, on every path).
  const errorOutput = options?.errorOutput ?? process.stderr;
  const errWrite = (t: string): void => {
    errorOutput.write(t);
  };


  // byte-exception): in --print mode ALL boot notices/banners/warns go to stderr,
  // keeping stdout an answer-only (json/stream-json machine-clean) channel. When
  // NOT print, `bootWrite === write` ⇒ every existing non-print byte is identical
  // by construction. help/version stay on `write` (their stdout output is POSIX-
  // correct product output, not a diagnostic).
  const bootWrite = parsedArgs.print ? errWrite : write;



  // loadEnvConfig — nothing is opened yet, so a bad flag fails fast with no cleanup.
  const rawFormat = parsedArgs.outputFormat;
  if (rawFormat !== undefined && !PRINT_OUTPUT_FORMATS.includes(rawFormat as PrintOutputFormat)) {
    errWrite(
      `--output-format must be one of: text, json, stream-json (got: ${rawFormat === "" ? "(empty)" : rawFormat})\n`,
    );
    return 2;
  }
  if (rawFormat !== undefined && !parsedArgs.print) {
    errWrite("--output-format requires --print/-p\n");
    return 2;
  }

  // `--model` (parsed as "") fails closed rather than silently defaulting —
  // mirror of the --output-format fail-closed doctrine. Stands here, before
  // loadEnvConfig, so nothing is opened yet.
  if (parsedArgs.model !== undefined && parsedArgs.model.trim() === "") {
    errWrite("--model needs a model id\n");
    return 2;
  }


  // non-interactive) and the color theme — computed once up front so the broker
  // factory below can consume them.
  const inputIsTTY = (input as NodeJS.ReadStream).isTTY === true;
  const outputIsTTY = (output as NodeJS.WriteStream).isTTY === true;
  const interactive =
    (options?.interactive ?? (inputIsTTY && outputIsTTY)) && !parsedArgs.print;
  const theme = createCliTheme({
    color: detectColorEnabled({ env, outputIsTTY, noColorFlag: parsedArgs.noColor }),
  });


  // bare `--resume` (no session id anywhere) needs an interactive terminal to
  // prompt for a choice — fail closed for scripts/pipes rather than silently

  // `-p` + bare `--resume` is rejected here too. Runs BEFORE any resource is
  // opened (no DB, no MCP, no readline), so there is nothing to clean up.
  if (
    parsedArgs.resumePicker &&
    parsedArgs.resumeSessionId === undefined &&
    options?.resumeSessionId === undefined &&
    !interactive
  ) {
    bootWrite(
      "--resume without a session id needs an interactive terminal; use --resume <sessionId> or --continue\n",
    );
    return 1;
  }


  // `-p`/`--print` (print set, no inline prompt) reads its prompt from stdin —
  // VERBATIM, no trim mutation (emptiness is checked via trim only). A TTY stdin
  // has no prompt to pipe, so that fails fast (exit 2) rather than blocking on a
  // read that never ends. An empty/whitespace prompt (inline `--print=` or piped)

  // keeps precedence) and BEFORE loadEnvConfig — no resource is open yet.
  let printPrompt = parsedArgs.printPrompt;
  if (parsedArgs.print && printPrompt === undefined) {
    if (inputIsTTY) {
      errWrite("--print needs a prompt: pass it as an argument or pipe it via stdin\n");
      return 2;
    }
    printPrompt = await readPromptFromStdin(input);
  }
  if (parsedArgs.print && (printPrompt === undefined || printPrompt.trim() === "")) {
    errWrite("--print got an empty prompt\n");
    return 2;
  }



  // bytes. The object is mutable — /reasoning flips transcript.reasoning at
  // runtime (main owns it). When non-interactive it is undefined ⇒ renderEvent's
  // 4th param is absent ⇒ every branch is byte-identical to today.
  const transcript: TranscriptOptions | undefined = interactive
    ? { diffs: true, collapse: true, reasoning: !parsedArgs.noReasoning }
    : undefined;
  // Standalone reasoning state for the non-interactive path (transcript===undefined):
  // /reasoning still reports an honest on/off even though nothing renders it.
  let reasoningEnabled = !parsedArgs.noReasoning;


  // physical terminal, not just interactive intent), so `outputIsTTY` here is the
  // stream's own isTTY (line above), never the `interactive` test-override. The
  // `statusLine` option is the test-only mirror of that override.
  const statusEnabled = options?.statusLine ?? (interactive && outputIsTTY && env.TERM !== "dumb");


  // overrides ANYCODE_MODEL by writing it into this env BEFORE loadEnvConfig
  // reads it — the same "mutate the passed env" precedent the API-key scrub
  // below already relies on (A9). One dividend: envConfig.model then carries the
  // override for createSession, print-structured, systemPromptEnv and the base
  // port, with no further wiring. A bare `--model` (== "") is rejected above.
  if (parsedArgs.model !== undefined) {
    env[ENV_MODEL] = parsedArgs.model;
  }

  const envConfig = loadEnvConfig(env);

  // Catalog entry resolved early so the model port can branch reasoning-effort
  // mapping by provider (GLM enum vs Claude budgetTokens) and the boot budget
  // resolutions below share the same lookup.
  const catalogEntry = matchCatalogEntryByBaseUrl(getBuiltinCatalog(), envConfig.baseUrl);

  // Single back-compat resolution point for the wire transport (TASK.43 §0.4):
  // the mandatory discriminant is applied here, once, instead of being defaulted
  // inside EndpointConfig. Env always wins; the catalog's declared default is
  // next; anthropic-messages is the final legacy fallback. Every built-in
  // catalog entry currently declares anthropic-messages, so this ladder is
  // byte-identical to the prior constant unless ANYCODE_PROVIDER_TRANSPORT is set.
  const providerTransport: ProviderTransport =
    envConfig.providerTransport ?? catalogEntry?.defaultTransport ?? "anthropic-messages";

  // (ANYCODE_MAX_RETRIES) and the per-attempt stall watchdog (ANYCODE_STALL_TIMEOUT_MS).
  const retryOverride: Partial<RetryPolicy> = {
    ...(envConfig.maxRetries !== undefined ? { maxRetries: envConfig.maxRetries } : {}),
    ...(envConfig.stallTimeoutMs !== undefined ? { stallTimeoutMs: envConfig.stallTimeoutMs } : {}),
  };
  const baseModelPort =
    options?.modelPort ??
    new AiSdkModelPort({
      transport: providerTransport,
      baseUrl: envConfig.baseUrl,
      apiKey: envConfig.apiKey,
      model: envConfig.model,
      ...(catalogEntry !== undefined ? { providerName: catalogEntry.name } : {}),
      ...(Object.keys(retryOverride).length > 0 ? { retry: retryOverride } : {}),
    });
  // Port factory for /model and Agent-tool model overrides (design

  // this closure (A9 — the scrub only clears the live env, not the captured
  // value); a model switch is just a new cheap AiSdkModelPort (the LanguageModel
  // is built per-attempt anyway, A3). When a test injects a modelPort WITHOUT an
  // explicit factory, switching is unavailable and /model refuses honestly.
  const modelPortFactory =
    options?.modelPortFactory ??
    (options?.modelPort === undefined
      ? (m: string) =>
          new AiSdkModelPort({
            transport: providerTransport,
            baseUrl: envConfig.baseUrl,
            apiKey: envConfig.apiKey,
            model: m,
            ...(catalogEntry !== undefined ? { providerName: catalogEntry.name } : {}),
            ...(Object.keys(retryOverride).length > 0 ? { retry: retryOverride } : {}),
          })
      : undefined);

  // ContextManager, subagents and titling — a /model setPort re-routes them all
  // between turns. Name kept `modelPort` so loopConfig/titling need no changes.
  const modelPort = new SwitchableModelPort(baseModelPort);
  const bootContextWindow = resolveContextWindow(envConfig.model, catalogEntry, envConfig.contextWindowTokens);
  const bootMaxOutputTokens = resolveMaxOutputTokens(envConfig.model, catalogEntry, envConfig.maxOutputTokens);
  let selectedReasoningEffort = envConfig.reasoningEffort ?? "off";
  const bootReasoningEffort = resolveReasoningEffort(envConfig.model, catalogEntry, selectedReasoningEffort);
  let liveContextWindow = bootContextWindow ?? DEFAULT_CONTEXT_WINDOW_TOKENS;


  // injected modelPort) or when a test explicitly opts in via
  // sessionTitleRefinement. Computed from the RAW options.modelPort (not the
  // `modelPort` constant above, which is always defined by this point) so a
  // scripted test port never enables it unless it asks to.
  const titleRefinementEnabled = options?.sessionTitleRefinement ?? options?.modelPort === undefined;


  // `options.checkpoints` wins outright (`??` short-circuit — the priority the
  // e2e fixes: option beats the flag). Absent, checkpoints are ON only in the
  // production interactive REPL — OFF for `--print` (headless /rewind is
  // unreachable and stream-json stays byte-clean, A19), OFF under
  // `--no-checkpoints` (the kill-switch), and OFF for an injected test model
  // port (scripted suites default OFF, mirror of A20/titleRefinement) so every
  // existing byte snapshot stands unchanged (L2).
  const checkpointsEnabled =
    options?.checkpoints ??
    (!parsedArgs.print && !parsedArgs.noCheckpoints && options?.modelPort === undefined);


  // captured the key by value (AiSdkModelPort holds config.apiKey; the SDK adapter
  // never re-reads the env), so ANYCODE_API_KEY is scrubbed from this CLI's live
  // env BEFORE any turn can spawn a Bash child. NodeExecutionAdapter builds a
  // child's env as {...process.env, ...request.env}, so a scrubbed key can no
  // longer be inherited by a tool subprocess — closing the prompt-injection
  // "print env" exfil vector for the CLI the same way host/boot.ts does for the
  // desktop host. Only the single secret env is removed; non-secret ANYCODE_*
  // (MODEL/BASE_URL/DB_PATH/...) are untouched. Applies on the injected-modelPort
  // path too (defense-in-depth). Local one-liner: no desktop code imported.
  delete env[ENV_API_KEY];

  const fs = new NodeFileSystemAdapter();
  const exec = new NodeExecutionAdapter();
  const tokenizer = await createDefaultTokenizer();


  // the port is never constructed and the three tools below are never
  // registered, so a headless run's tool declarations/system prompt are
  // untouched (L6/L2) and a one-shot run has nothing worth backgrounding
  // anyway. Unlike checkpointsEnabled below, this does NOT also gate off an
  // injected test modelPort: the hermetic e2e (main.test.ts §6#4/#5) needs a
  // real port to drive scripted bg-Bash/BashOutput/BashKill calls.
  const tasksEnabled = !parsedArgs.print;


  // same print-mode gate as tasksEnabled above — a one-shot --print run never
  // loads specs or spawns a language server, so headless byte-identity (L7)
  // holds regardless of what a workspace's .anycode/config.json contains.
  const lspEnabled = !parsedArgs.print;

  const registry = createDefaultToolRegistry();

  // mcpManager.start()/toolNames snapshot below, so the tool name reaches the

  // desktop host never registers it, keeping its prompt byte-identical.
  registry.register(exitPlanModeTool);

  // wraps `exec` with zero new spawn path — a background task is just a
  // non-awaited exec.run() with its own AbortController (Wave A). The
  // registered Bash OVERWRITES the default under the same tool name

  // is REQUIRED here or the registry boot-warns "duplicate registration".
  // `tasks` stays `null` when the gate is off, so every consumer below
  // (loopConfig, the /tasks deps grain, the exit-path dispose, the turn-input
  // notice drain) degrades to its pre-5.5 behavior with no port at all.
  const tasks = tasksEnabled ? new InProcessTaskManager(exec) : null;
  if (tasksEnabled) {
    registry.register(backgroundCapableBashTool, { silentDuplicateWarning: true });
    registry.register(bashOutputTool);
    registry.register(bashKillTool);
  }

  // is read from the SAME .anycode/config.json section MCP already reads

  // no such section yields specs=[] at zero cost, so `lsp` stays null and
  // every consumer below (loopConfig, the /lsp deps grain, the exit-path
  // dispose, the diagnostics-tool registration) degrades to its pre-6.1
  // behavior with no port at all (L8). The loader never throws by contract;
  // this try/catch is defense-in-depth kept symmetric with its neighbors
  // (mcp/extensions blocks above). Construction below never spawns anything

  // on the first matching Edit/Write.
  let lspServerSpecs: LspServerSpec[] = [];
  let lspIssues: string[] = [];
  try {
    const loaded = await loadLspServerSpecs(fs, cwd, home);
    lspServerSpecs = loaded.specs;
    lspIssues = loaded.issues;
  } catch (error) {
    bootWrite(`[warn] lsp config failed to load; continuing with zero language servers: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  for (const issue of lspIssues) {
    bootWrite(`[warn] lsp config: ${issue}\n`);
  }
  const lsp = lspEnabled && lspServerSpecs.length > 0 ? new LspManager(exec, lspServerSpecs, cwd) : null;
  if (lsp) {
    // Re-registers Edit/Write under the SAME tool names + metadata OBJECTS

    // is byte-identical, and no new tool NAME reaches the toolNames snapshot
    // below. silentDuplicateWarning mirrors backgroundCapableBashTool above —
    // otherwise the registry boot-warns "duplicate registration".
    registry.register(diagnosticsEditTool, { silentDuplicateWarning: true });
    registry.register(diagnosticsWriteTool, { silentDuplicateWarning: true });
  }


  // registered here, BEFORE mcpManager.start()/the toolNames snapshot below, so
  // the system prompt's tool-discipline section is computed with this Read
  // already in place (no new tool NAME reaches it). Unlike lsp/tasks above,

  // to clean up, so this registers unconditionally, including headlessly.
  registry.register(imageCapableReadTool, { silentDuplicateWarning: true });

  // section of the SAME .anycode/config.json already read for mcp/lsp (project

  // resolvable backend the tool is NOT registered, so the default tool set, the
  // prompt's toolNames snapshot and every byte-snapshot stay identical to
  // pre-6.3. No lifecycle (no children, no dispose) — no exit-path entry, no
  // print gate.
  let webSearchBackend: ResolvedWebSearchBackend | null = null;
  try {
    const loadedWebSearch = await loadWebSearchConfig(fs, cwd, home, env);
    webSearchBackend = loadedWebSearch.backend;
    for (const issue of loadedWebSearch.issues) bootWrite(`[warn] websearch config: ${issue}\n`);
  } catch (error) {
    bootWrite(`[warn] websearch config failed to load; continuing without WebSearch: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  if (webSearchBackend !== null) {
    registry.register(createWebSearchTool(webSearchBackend));
  }
  // Telemetry config (slice 6.6, design slice-6.6-cut.md §2-C1): the SAME
  // .anycode/config.json section MCP/LSP/WebSearch already read (project wins

  // enabled:false, or the ANYCODE_TELEMETRY kill-switch) leaves telemetryConfig
  // null, so the sink below is never built and loopConfig.eventTap stays
  // absent (default byte-identical to pre-6.6, L4).
  let telemetryConfig: ResolvedTelemetryConfig | null = null;
  try {
    const loadedTelemetry = await loadTelemetryConfig(fs, cwd, home, env);
    telemetryConfig = loadedTelemetry.telemetry;
    for (const issue of loadedTelemetry.issues) bootWrite(`[warn] telemetry config: ${issue}\n`);
  } catch (error) {
    bootWrite(`[warn] telemetry config failed to load; continuing without telemetry: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  let repoMapConfig: RepoMapConfig | null = null;
  try {
    const loadedRepoMap = await loadRepoMapConfig(fs, cwd, home, env);
    repoMapConfig = loadedRepoMap.repoMap;
    for (const issue of loadedRepoMap.issues) bootWrite(`[warn] repo-map config: ${issue}\n`);
  } catch (error) {
    bootWrite(`[warn] repo-map config failed to load; continuing without repo-map: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  const hooks = new InMemoryHookRunner();

  // safe-command narrowing (design slice-5.1-cut.md §2.4). Two narrowing layers
  // wrap the mode table (ModePermissionEngine), which is never modified — only
  // composed over: the SafeCommandPermissionEngine auto-approves a Bash command
  // proven read-only by the conservative classifier, and the RuleAware layer
  // applies session /allow rules. Both layers narrow ONLY an "ask" verdict to
  // "allow"; a base "allow"/"deny" (e.g. a plan-mode Bash deny) passes through
  // untouched. Rules now persist across restarts (design slice-P7.5-cut.md
  // §3.1/§3.2): every `add` (broker "a" answer or `/allow <Tool>`) fire-and-forget
  // appends to `~/.anycode/settings.json`'s `permissions.alwaysAllow` — the same
  // file/section desktop main reads/writes — and boot seeds the store from
  // whatever is already there before the first request is handled.
  const settingsFilePath = options?.settingsFilePath ?? env.ANYCODE_SETTINGS_PATH ?? defaultSettingsFilePath();
  const permissionRules = new PersistingSessionPermissionRules(
    (rule) => appendAlwaysAllowRule(settingsFilePath, rule),
    (rule, reason) => bootWrite(`[allow] warning: rule not persisted (${reason}) — session-only\n`),
  );
  permissionRules.seedPersisted(await loadPersistedAlwaysAllowRules(settingsFilePath));
  const permissionEngine = new RuleAwarePermissionEngine(
    new SafeCommandPermissionEngine(new ModePermissionEngine()),
    permissionRules,
  );

  // owns it now. The 4.1.1 stub is today's fail-closed default verbatim (yolo ->
  // AllowAll, else Deny; `interactive`/`theme` ignored); 4.1.2 rewrites the
  // factory to add the interactive TerminalPermissionBroker for interactive TTYs.
  const permissionBroker = createCliPermissionBroker({
    yolo,
    interactive,
    rules: permissionRules,
    theme,
  });

  // Config-driven command hooks (design §2.11): user (~/.anycode) < project
  // (<cwd>/.anycode), both sets registered. A malformed config file is reported
  // and skipped rather than crashing the CLI. Slice 5.6 wave C: the resolved
  // declaration list is ALSO captured (outer-scope, so it survives the try) for
  // `/hooks` to render read-only — a boot-time snapshot, not re-read live, same
  // as `/skills`/`/workflows` above. Each declaration is captured only AFTER it
  // successfully registers, so `/hooks` reflects exactly what is active: a
  // malformed config (schema/JSON) leaves this [] (nothing registered), and a
  // schema-valid entry whose matcher fails to compile drops itself and the rest
  // of the list — `/hooks` never over-reports an un-registered hook.
  const capturedHookDeclarations: CommandHookDeclaration[] = [];
  try {
    const hookDeclarations = await loadHookConfigs(fs, cwd, home);
    for (const declaration of hookDeclarations) {
      hooks.register(createCommandHook(exec, declaration, cwd));
      capturedHookDeclarations.push(declaration);
    }
  } catch (error) {
    bootWrite(`[warn] hook config ignored: ${error instanceof Error ? error.message : String(error)}\n`);
  }

  // Explicit MCP config is read FIRST (design slice-3.3-cut.md §6): its
  // resolved server names become the claimed-set extensions discovery (below)
  // must respect, so an explicitly configured server name always wins over a
  // plugin declaring the same name. The actual mcpManager.start() call happens
  // ONCE, after extensions discovery, combining explicit + plugin specs
  // (3.2's start-once ruling stays intact — never two start() calls).
  let mcpSpecs: McpServerSpec[] = [];
  let mcpProblems: string[] = [];
  try {
    const loaded = await loadMcpServerSpecs(fs, cwd, home);
    mcpSpecs = loaded.specs;
    mcpProblems = loaded.problems;
  } catch (error) {
    bootWrite(`[warn] mcp config failed to load; continuing with zero explicit MCP servers: ${error instanceof Error ? error.message : String(error)}\n`);
  }

  // Extensions bootstrap (design slice-3.3-cut.md §3.7/§6): skills discovery,
  // agent profiles, and plugins-lite, aggregated by the SAME discoverExtensions
  // the desktop host wiring calls, so the two paths never drift. Fail-soft
  // (mirrors the MCP block below): a thrown discovery leaves the CLI with an
  // empty bootstrap — byte-identical to today's boot with no extensions.
  // discoverExtensions itself never throws by contract; this try/catch is
  // defense-in-depth kept symmetric with its neighbors.
  let ext: ExtensionsBootstrap = {
    skills: createSkillPort(fs, []),
    skillsPromptSection: "",
    profiles: [],
    profilesPromptSection: "",
    pluginMcpServerSpecs: [],
    workflows: [],
    workflowsPromptSection: "",
    memorySection: "",
    repoMapFiles: [],
    problems: [],
  };
  try {
    ext = await discoverExtensions(fs, {
      workspace: cwd,
      home,
      claimedMcpNames: new Set(mcpSpecs.map((spec) => spec.name)),
      repoMapConfig,
    });
  } catch (error) {
    bootWrite(`[warn] extensions discovery failed; continuing with zero skills/agent profiles/plugins: ${error instanceof Error ? error.message : String(error)}\n`);
  }

  // MCP client wiring (design slice-3.2-cut.md §4.4/§6): fail-closed by default
  // (no config -> zero specs -> zero children). The registry passed here is the
  // SAME object handed to AgentLoopConfig below, so bridged tools land in the
  // live registry before the first turn. Startup banner is silent when no
  // server is configured; problems (bad config, missing ${env:VAR}, ...) are
  // always surfaced. `manager` is disposed in the exit path alongside
  // persistence flush.
  const mcpManager = new McpManager({ registry, transports: new NodeMcpTransportFactory() });
  // Fail-soft (mirrors the desktop host's MCP block): a loader/connect failure
  // must never abort the CLI — continue with zero MCP servers. start() cannot
  // throw today; this try/catch is defense-in-depth kept symmetric with the host.
  try {
    await mcpManager.start([...mcpSpecs, ...ext.pluginMcpServerSpecs]);
    const mcpStatuses = mcpManager.status();
    if (mcpStatuses.length > 0) {
      const toolCount = mcpStatuses.reduce((sum, status) => sum + status.toolCount, 0);
      bootWrite(`MCP: ${mcpStatuses.length} servers, ${toolCount} tools\n`);
    }
    for (const problem of mcpProblems) {
      bootWrite(`[warn] mcp config: ${problem}\n`);
    }
  } catch (error) {
    bootWrite(`[warn] mcp startup failed; continuing with zero MCP servers: ${error instanceof Error ? error.message : String(error)}\n`);
  }

  // Boot snapshot of tool names for the system prompt's tool-discipline
  // section (design slice-3.6-cut.md §6/§0.2): taken AFTER mcpManager.start()
  // above, so this already includes any mcp__*-bridged tools registered into
  // this SAME registry object — the ordering the anti-confabulation section
  // depends on (a snapshot taken before start() would omit MCP tools and the
  // model would then have no declared way to name them).
  const toolNames = registry.list();

  // Session-static env facts (design §2.1/§6), computed ONCE here so the
  // system prompt's <env> section — and every subagent's, via
  // withSubagents({ env }) below — stays static for the whole session (a
  // fresh Date/os read per turn would make the prompt non-deterministic).

  // /model switch mutates `modelId` here and rebuilds loopConfig.systemPrompt
  // (loop reads it per-call), so the <env> block never lies about the model.
  const systemPromptEnv: SystemPromptEnv = {
    workingDirectory: cwd,
    platform: process.platform,
    osVersion: release(),
    date: new Date().toISOString().slice(0, 10),
    modelId: envConfig.model,
    isGitRepo: await fs.exists(`${cwd}/.git`),
  };


  // closure over systemPromptEnv.modelId (mutable, /model writes it at :1062)
  // and the boot-fixed catalogEntry (same endpoint for the life of the
  // session) — a /model switch is honored on the very next call, with no
  // further wiring. Unlike checkpoints/tasks/lsp above, this is never gated

  // are never conditionally present here.
  const media: MediaCapabilityPort = {
    imageInputEnabled: () =>
      resolveImageInput(systemPromptEnv.modelId ?? "", catalogEntry, envConfig.imageInput),
  };

  /**
   * Loads + validates one local path as an attachable image (design


   * mirrors tools/read-image.ts's error text verbatim), then the actual
   * read/sniff/size gate (util/images.ts). `currentCount` is passed in
   * rather than closed over, so this same function serves BOTH the
   * one-shot --print attachment list and the interactive session's
   * stagedImages array without caring which one is counting. Never mutates
   * anything — callers push the returned attachment on success.
   */
  const validateImageAttach = async (
    path: string,
    currentCount: number,
  ): Promise<
    | { ok: true; attachment: ImageAttachment; basename: string; kb: number }
    | { ok: false; reason: string }
  > => {
    if (currentCount >= IMAGE_MAX_PER_MESSAGE) {
      return {
        ok: false,
        reason: `already ${IMAGE_MAX_PER_MESSAGE} images staged (the per-message cap); /image clear first`,
      };
    }
    if (!media.imageInputEnabled()) {
      return {
        ok: false,
        reason: `${path} is an image, and the current model is not marked image-capable (switch /model, or set ANYCODE_IMAGE_INPUT=on to override)`,
      };
    }
    const result = await loadImageAttachment(fs, path);
    if (!result.ok) {
      return { ok: false, reason: result.reason };
    }
    return {
      ok: true,
      attachment: result.attachment,
      basename: basenameOf(path),
      kb: Math.round(result.rawBytes / 1024),
    };
  };

  // Extensions banner + problems (design slice-3.3-cut.md §6, extended
  // slice-3.4-cut.md §6): silent when skills/agent-profiles/plugin-servers/
  // workflows are all zero — a workspace with no extensions prints nothing
  // new. "Plugins" counts plugin-contributed MCP servers about to be started
  // (pluginMcpServerSpecs.length) — the only plugin-attributable count
  // ExtensionsBootstrap exposes without inferring plugin identity from
  // skill/profile data (profiles carry no `source`).
  const skillCount = ext.skills.list().length;
  const profileCount = ext.profiles.length;
  const pluginServerCount = ext.pluginMcpServerSpecs.length;
  const workflowCount = ext.workflows.length;
  if (skillCount > 0 || profileCount > 0 || pluginServerCount > 0 || workflowCount > 0) {
    bootWrite(
      `Skills: ${skillCount} · Agent profiles: ${profileCount} · Plugins: ${pluginServerCount} · Workflows: ${workflowCount}\n`,
    );
  }
  for (const problem of ext.problems) {
    bootWrite(`[warn] extensions: ${problem}\n`);
  }

  // ===========================================================================
  // Persistence wiring (task 1.7). SqlitePersistenceAdapter opens/migrates the
  // ANYCODE_DB_PATH database (default ~/.anycode/anycode.sqlite). --resume
  // <sessionId> loads that session's prior meta+history instead of starting a
  // fresh one; ConversationHistory is seeded with it and given a
  // WriteBehindHistorySink so every subsequent append/compaction swap is
  // queued to disk without ever blocking a turn (design §2.1/§2.4, R8). Task
  // 1.8 sews the rest of AgentLoop's persistence-facing behavior on top.
  const dbPath = envConfig.dbPath ?? join(home, ".anycode", "anycode.sqlite");
  const persistence = new SqlitePersistenceAdapter(dbPath);


  // explicit `--resume <id>` wins over the picker, which wins over `--continue`;
  // a `--continue` given alongside ANY `--resume` (explicit id OR bare-picker)
  // is ignored with a warn (deterministic — continue never sneaks in on a bad
  // `--resume <id>`). An explicit `--resume <id>` that resolves stays SILENT on
  // success (L1 byte-invariant), and its "no session found" warn text is the
  // verbatim pre-4.4 line; only the new continue/picker paths print a notice.
  const requestedResumeId = options?.resumeSessionId ?? parsedArgs.resumeSessionId;
  const wantPicker = parsedArgs.resumePicker && requestedResumeId === undefined;
  if (parsedArgs.continueSession && (requestedResumeId !== undefined || wantPicker)) {
    bootWrite("[warn] --continue ignored: --resume was given\n");
  }
  const wantContinue = parsedArgs.continueSession && requestedResumeId === undefined && !wantPicker;

  let resumedSession = requestedResumeId ? await persistence.getSession(requestedResumeId) : null;
  if (requestedResumeId && !resumedSession) {
    bootWrite(`[warn] no session found for --resume ${requestedResumeId}; starting a new session instead\n`);
  }
  if (!resumedSession && wantContinue) {

    const [last] = await persistence.listSessions({ workspace: cwd, limit: 1 });
    if (last) {
      resumedSession = last;
      bootWrite(
        `Continuing ${shortSessionId(last.id)} — ${last.title ?? "(untitled)"} (${formatRelativeTime(last.updatedAt, Date.now())})\n`,
      );
    } else {
      bootWrite("[warn] no previous session for this workspace; starting a new session\n");
    }
  }
  if (!resumedSession && wantPicker) {

    // --resume in an interactive terminal (the early-guard above rejected the
    // non-interactive case). MCP is already started (§2.6) but the write-behind
    // history sink is not created yet (below), so an abort only has to dispose
    // MCP + close the DB — there is nothing queued to flush — before exiting 130.
    const metas = await persistence.listSessions({ workspace: cwd, limit: SESSIONS_PICKER_LIMIT });
    if (metas.length === 0) {
      bootWrite("[sessions] no sessions for this workspace; starting a new session\n");
    } else {
      const pick = await promptSessionSelection({ sessions: metas, input, output, theme });
      if (pick.kind === "abort") {
        await mcpManager.dispose();
        await persistence.close();
        return 130;
      }
      if (pick.kind === "resume") {
        resumedSession = pick.session;
        bootWrite(`Resuming ${shortSessionId(pick.session.id)} — ${pick.session.title ?? "(untitled)"}\n`);
      }
    }
  }


  // resume restores the persisted mode when it is not explicitly overridden
  // (options.mode / an explicit valid --mode). yolo is NEVER restored — that
  // escalation happens only by an explicit action (/mode yolo, --yolo), so a
  // resumed-yolo session warns and starts in build. Placed UNDER session
  // resolution (L8: the resolution above is not reordered — only this
  // finalization point moved down) and BEFORE createSession, so a fresh
  // session persists the final mode and a resumed one flows it downstream
  // (createSession :581 / loopConfig / banner) with no textual change there.
  let mode: PermissionMode = modeOverride ?? parsedArgs.mode;
  if (modeOverride === undefined && resumedSession) {
    if (resumedSession.mode === "yolo") {
      bootWrite("[warn] resumed session was in yolo mode; starting in build (re-enable with /mode yolo)\n");
    } else {
      mode = resumedSession.mode;
    }
  }

  const session =
    resumedSession ??
    (await persistence.createSession({
      id: globalThis.crypto.randomUUID(),
      workspace: cwd,
      model: envConfig.model,
      mode,
    }));

  // Title state (Phase 4 slice 4.4-T, design §3): mirrors host/session.ts's
  // hasTitle/titleSet — a resumed session that already has a title (boot meta)
  // is never re-derived. pendingTitleText/titleWork carry the tier-2
  // refinement across the for-await loop below to the exit path, which MUST

  let sessionTitleSet = typeof session.title === "string" && session.title.length > 0;
  let pendingTitleText: string | null = null;
  let titleWork: Promise<void> | null = null;

  const initialHistoryItems = resumedSession ? await persistence.loadHistory(session.id) : [];
  const historySink = new WriteBehindHistorySink(persistence, session.id);
  const history = new ConversationHistory({
    initial: initialHistoryItems,
    sink: historySink,
    tokenizer,
  });
  // ===========================================================================


  // systemPrompt expression, BYTE-identical, hoisted so /model can rebuild it
  // after mutating systemPromptEnv.modelId (the loop reads config.systemPrompt
  // per-call, A16:271). Called once below for the boot value.
  const repoMapMaxTokens = (): number =>
    repoMapConfig?.maxTokens ??
    Math.max(
      REPO_MAP_MIN_TOKENS,
      Math.min(REPO_MAP_MAX_TOKENS, Math.floor(REPO_MAP_WINDOW_FRACTION * liveContextWindow)),
    );
  const renderRepoMap = (): string => {
    try {
      return buildRepoMapPromptSection(ext.repoMapFiles, {
        maxTokens: repoMapMaxTokens(),
        tokenizer,
        workspace: cwd,
      }).section;
    } catch {
      return "";
    }
  };
  const composeSystemPrompt = (): string =>
    buildSystemPrompt({ toolNames, env: systemPromptEnv }) +
    ext.memorySection +
    ext.skillsPromptSection +
    ext.workflowsPromptSection +
    ext.profilesPromptSection +
    renderRepoMap();
  // Section boundaries for AgentLoop.contextBreakdown() (design
  // slice-P7.17-cut.md §2.1, CLI-parity): the SAME strings composeSystemPrompt
  // concatenates onto the base, tagged by kind. Never used to build the
  // prompt itself (systemPrompt above stays the single source of truth) —
  // pure accounting metadata so /context can split the base out by
  // subtraction. Empty sections are included (contextBreakdown tokenizes ""
  // to 0, a harmless no-op) rather than filtered, keeping this list a literal
  // mirror of composeSystemPrompt's concatenation order.
  const composeSystemPromptComponents = (): AgentLoopConfig["systemPromptComponents"] => [
    { kind: "memory", text: ext.memorySection },
    { kind: "skills", text: ext.skillsPromptSection },
    { kind: "workflows", text: ext.workflowsPromptSection },
    { kind: "profiles", text: ext.profilesPromptSection },
    { kind: "repoMap", text: renderRepoMap() },
  ];

  // truth /model reads (get) and writes (set) between turns.
  let currentModel = envConfig.model;

  // Boot context-window resolution (slice 6.4, design slice-6.4-cut.md §2-C3):
  // env ANYCODE_CONTEXT_WINDOW > catalog window of the boot model > absent.
  // Absent keeps loopConfig.context omitted, so an unknown model/endpoint boots
  // byte-identical to pre-6.4 (DEFAULT_CONTEXT_WINDOW_TOKENS via the defaults).
  // Telemetry sink (slice 6.6, design slice-6.6-cut.md §2-C1): opt-in — a
  // resolved config builds the per-session JSONL sink and the eventTap
  // closure; null keeps loopConfig.eventTap absent, so the default boot stays
  // byte-identical to pre-6.6. appVersion mirrors the --version createRequire
  // idiom (:225-227 above); best-effort (undefined on failure).
  let telemetry: TelemetryPort | null = null;
  if (telemetryConfig !== null) {
    let appVersion: string | undefined;
    try {
      const requireTelemetryPkg = createRequire(import.meta.url);
      appVersion = (requireTelemetryPkg("../../package.json") as { version: string }).version;
    } catch {
      appVersion = undefined;
    }
    telemetry = new JsonlTelemetrySink({ dir: telemetryConfig.dir, fileName: `${session.id}.jsonl` });
    telemetry.record({
      v: 1,
      ts: Date.now(),
      session: session.id,
      t: "session_start",
      model: currentModel,
      provider: catalogEntry?.name ?? "custom",
      mode,
      ...(appVersion !== undefined ? { appVersion } : {}),
    });
  }
  const telemetryTap = telemetry === null ? undefined : buildTelemetryTap(telemetry, session.id);


  // per-workspace shadow GIT_DIR rooted OUTSIDE the workspace, beside the sqlite
  // DB (hermetic — tests already sit in a tmp ANYCODE_DB_PATH; L6: never a `.git`
  // in the user tree). A ":memory:" DB has no directory, so the root falls back to

  // loop's checkpoint arc stays dormant and /rewind refuses — no git spawn, no
  // new event, no disk touch, byte-identical to today (L2). Needs session.id
  // (resolved just above) and runs before loopConfig.
  const checkpointsRoot =
    dbPath === ":memory:"
      ? join(home, ".anycode", "checkpoints")
      : join(dirname(dbPath), "checkpoints");
  const checkpointService = checkpointsEnabled
    ? new ShadowGitCheckpoints({
        exec,
        fs,
        store: persistence,
        workspace: cwd,
        checkpointsRoot,
        sessionId: session.id,
      })
    : null;

  // GitPort over the workspace's REAL `.git` (design slice-5.4-cut.md §2.6):
  // powers /status, /diff, /commit. Deliberately the env-opposite of the
  // shadow-git checkpoint service above — NodeGitAdapter never sets the GIT_DIR
  // family and never pins identity, so it resolves the user's own repo from cwd

  // already-computed isGitRepo env fact (:519 — not a second fs.exists) AND
  // requires a runBinary-capable execution port; false ⇒ every git command
  // refuses with a not-a-repo line. Constructed unconditionally (zero I/O in the
  // constructor); the enabled gate — not construction — is what makes it dormant.
  const gitService = new NodeGitAdapter({ exec, cwd });
  // `=== true` narrows the optional isGitRepo (SystemPromptEnv.isGitRepo?: boolean)
  // to a strict boolean so gitEnabled is never `undefined`.
  const gitEnabled = systemPromptEnv.isGitRepo === true && typeof exec.runBinary === "function";

  // withSubagents (design §3.2/§4.2) attaches a SubagentPort derived from this
  // same config BEFORE construction, giving the CLI's Agent tool a working
  // child-loop runner; called only here — never when the runner derives a
  // child's own config, which is the non-recursion lock (design §4.1).
  // withWorkflows (design slice-3.4-cut.md §2.10/§6) attaches a WorkflowPort
  // AFTER withSubagents — it reads config.subagents (set just above) and
  // attaches nothing if absent, so the order here is load-bearing: swapping it
  // would leave the Workflow tool fail-closed "unavailable" even with
  // definitions discovered.
  const loopConfig = withWorkflows(
    withSubagents(
      {
        modelPort,
        registry,
        hooks,
        permissionEngine,
        permissionBroker,
        history,
        tokenizer,

        // — unlike checkpoints/tasks/lsp below, images carry no lifecycle to

        media,
        // Context window (design §2.5 + slice 6.4): resolved above (env > catalog > absent).
        ...(bootContextWindow !== undefined
          ? { context: { contextWindowTokens: bootContextWindow } }
          : {}),
        mode,
        ports: {
          fs,
          exec,
          http: new NodeHttpAdapter(),
          todos: new InMemoryTodoStore(),
        },
        cwd,
        // Parallel cap override for read-only tool batches (§2.7); env ANYCODE_TOOL_CONCURRENCY.
        toolConcurrency: envConfig.toolConcurrency,
        maxTurns: envConfig.maxTurns,
        maxOutputTokens: bootMaxOutputTokens,
        reasoningEffort: bootReasoningEffort,
        // Base prompt (identity/conventions/safety/tool-discipline/env, design
        // §2.1) enriched with the boot toolNames snapshot + session env, then
        // memory + skills + workflows + agent profiles concatenated (design
        // slice-3.6-cut.md §6, slice-3.3-cut.md §6, slice-3.4-cut.md §3.6,
        // slice-3.7-cut.md §2.6): all four sections are "" when there is
        // nothing discovered, so systemPrompt degrades to the enriched base
        // with no empty gaps. profilesPromptSection is appended LAST — an
        // additive tail that keeps the stable prompt-cache prefix
        // (memory -> skills -> workflows) untouched (slice-3.7-cut.md §2.6,


        // rebuild it between turns; this boot call is byte-identical to today.
        systemPrompt: composeSystemPrompt(),
        // CLI-parity accounting metadata for /context's breakdown (design
        // slice-P7.17-cut.md §2.1 W1) — same components composeSystemPrompt
        // concatenates, tagged by kind; rebuilt alongside systemPrompt on
        // every /model switch below (repoMap/env can change with the window).
        systemPromptComponents: composeSystemPromptComponents(),
        skills: ext.skills,

        // ExitPlanMode advances the CLI session to build (writes then ask
        // individually — the honest minimum trust after a plan). onModeChange
        // persists the switch best-effort (mirror of the desktop host,
        // session.ts) — the source of truth for the live mode is loopConfig.mode.
        planExitMode: "build",
        onModeChange: (m) => {
          void persistence.touchSession(session.id, { mode: m }).catch(() => {});
        },


        // turn byte-identical (L2; runTurn never touches the arc). Children never
        // inherit it (buildChildConfig is an explicit object): a child's writes are
        // already covered by the parent checkpoint taken BEFORE the Agent/Workflow

        ...(checkpointService !== null ? { checkpoints: checkpointService } : {}),


        // ctx.tasks undefined, so BashOutput/BashKill's fail-closed idiom
        // fires honestly. buildChildConfig is an explicit object (like
        // checkpoints above) that never copies `tasks`, so a subagent never

        // have the tools, and ctx.tasks would be absent even if it did.
        ...(tasks !== null ? { tasks } : {}),
        // LspPort (design slice-6.1-cut.md §2-C1/§2-D1): present ONLY when the

        // diagnostics-wrapped Edit/Write's fail-soft short-circuit fires
        // honestly (they are not even registered in that case). buildChildConfig

        // writes never get diagnostics, and its own registry has no wrapped
        // Edit/Write to begin with.
        ...(lsp !== null ? { lsp } : {}),

        // ONLY when the sink above was built — its absence keeps runTurn's
        // yield* delegation byte-identical to pre-6.6 (L4). buildChildConfig

        // loop never reports directly — its activity reaches the tap as the
        // parent's subagent_* events.
        ...(telemetryTap !== undefined ? { eventTap: telemetryTap } : {}),
      },
      // Md-profile personas (design §2.5/§6): extra agent_type values the
      // Agent tool can spawn, additive to the built-in general-purpose/explore.
      // env/memorySection (design slice-3.6-cut.md §2.4/§6) thread the same
      // session-static facts + AGENTS.md memory into every child's harness
      // prelude, so a subagent confabulates tools no more than the parent does.

      // the port factory so an Agent-tool `model` override resolves to a fixed
      // child-only port; absent (injected test port, no factory) ⇒ the runner
      // returns an honest error-outcome for a model override instead of a silent
      // fallback to the parent's model.
      {
        profiles: ext.profiles,
        env: systemPromptEnv,
        memorySection: ext.memorySection,
        ...(modelPortFactory !== undefined ? { resolveChildModelPort: modelPortFactory } : {}),
      },
    ),
    ext.workflows,
  );
  const loop = new AgentLoop(loopConfig);


  // (so stdin is never consumed) — this branch stands BEFORE createInterface and
  // owns its own dispose/flush/close exit path (design §3.3). All of loop /
  // mcpManager / historySink / persistence are already assembled above.
  if (parsedArgs.print) {
    // Headless session title (Phase 4 slice 4.4-T-R1, design slice-4.5-cut.md

    // headlessly (it would cost an extra model call per scripted run). A resumed
    // titled session is never re-derived (sessionTitleSet gate). Awaited BEFORE
    // runPrintMode, which closes persistence inside its own exit path.
    if (!sessionTitleSet) {
      const title = deriveSessionTitle(sanitizeTitleSource(printPrompt!));
      if (title.length > 0) {
        await persistence.touchSession(session.id, { title }).catch(() => {});
      }
    }
    const fmt = (rawFormat ?? "text") as PrintOutputFormat;

    // never stages — every `--image` path is loaded/validated immediately and
    // attached straight to this one-shot prompt. A rejected path (capability
    // off, over cap, unreadable, not an image) never aborts the whole run —
    // it warns to stderr and the turn proceeds without that one image
    // (fail-soft, mirroring the lsp/mcp config-load warnings above).
    const printAttachments: ImageAttachment[] = [];
    for (const path of parsedArgs.images) {
      const validated = await validateImageAttach(path, printAttachments.length);
      if (validated.ok) {
        printAttachments.push(validated.attachment);
      } else {
        errWrite(`[warn] --image ${path}: ${validated.reason}\n`);
      }
    }

    // const+return reframe is the ONLY non-additive change of Wave C — it lets
    // session_end + dispose run AFTER runPrintMode's own exit path (which
    // never touches telemetry) without editing cli/print.ts at all (L6).
    const printExit = await runPrintMode({
      prompt: printPrompt!,
      loop,
      mcpManager,
      historySink,
      persistence,
      stdout: output,
      stderr: errorOutput,
      theme,
      ...(printAttachments.length ? { attachments: printAttachments } : {}),
      ...(fmt !== "text"
        ? { structured: { format: fmt, sessionId: session.id, model: envConfig.model, mode, cwd } }
        : {}),
    });
    if (telemetry !== null) {
      telemetry.record({ v: 1, ts: Date.now(), session: session.id, t: "session_end" });
      await telemetry.dispose();
    }
    return printExit;
  }


  // REPL closure so it survives across turns until it drains. `--image` paths
  // are pre-staged here at boot (a boot line per success, a warn per
  // failure — same fail-soft doctrine as print's attachment loop above);
  // `/image <path>` mid-session (the `stage` grain below) uses the exact
  // same validate-then-push path, so the two entry points can never drift.
  const stagedImages: ImageAttachment[] = [];
  for (const path of parsedArgs.images) {
    const validated = await validateImageAttach(path, stagedImages.length);
    if (validated.ok) {
      stagedImages.push(validated.attachment);
      bootWrite(
        `[image] staged ${validated.basename} (${validated.attachment.mediaType}, ${validated.kb} KB) — ${stagedImages.length} staged\n`,
      );
    } else {
      bootWrite(`[warn] --image ${path}: ${validated.reason}\n`);
    }
  }
  const stageImage = async (
    path: string,
  ): Promise<
    | { ok: true; basename: string; mediaType: ImageAttachment["mediaType"]; kb: number; staged: number }
    | { ok: false; reason: string }
  > => {
    const validated = await validateImageAttach(path, stagedImages.length);
    if (!validated.ok) {
      return validated;
    }
    stagedImages.push(validated.attachment);
    return {
      ok: true,
      basename: validated.basename,
      mediaType: validated.attachment.mediaType,
      kb: validated.kb,
      staged: stagedImages.length,
    };
  };
  const listStagedImages = (): Array<{ basename: string; mediaType: ImageAttachment["mediaType"]; kb: number }> =>
    stagedImages.map((img) => ({
      basename: img.sourcePath !== undefined ? basenameOf(img.sourcePath) : "(unknown)",
      mediaType: img.mediaType,
      // Approximate display size from the base64 payload — staged images have
      // no separate rawBytes field (ImageAttachment is the frozen A1 shape).
      kb: Math.round((img.data.length * 3) / 4 / 1024),
    }));
  const clearStagedImages = (): number => {
    const count = stagedImages.length;
    stagedImages.length = 0;
    return count;
  };

  const rl = createInterface({ input, output, prompt: "> " });


  // gate, so a non-TTY session gets a full no-op instance (zero status bytes).
  const status = createStatusLine({ output, enabled: statusEnabled, theme });

  // prompter lazily now. The 4.1.1 stub brokers don't implement attachPrompter,
  // so this is a no-op today; 4.1.2's TerminalPermissionBroker consumes it. The
  // prompter is wrapped so the status line is erased before the broker writes its

  permissionBroker.attachPrompter?.(withStatusClear(createReadlinePrompter(rl), status));
  // Dedicated readline prompter for the /rewind y/N confirmation (design

  // prompter uses — slash commands dispatch strictly between turns (the status
  // line is already cleared), so this confirmation never races an in-flight ask.
  const rewindPrompter = createReadlinePrompter(rl);

  let currentAbort: AbortController | null = null;
  let interruptCount = 0;
  let exitRequested = false;
  let exitCode = 0;

  const handleSigint = (): void => {
    if (currentAbort) {
      // First Ctrl+C while a turn is in flight: abort just that turn.
      currentAbort.abort();
      interruptCount = 0;
      return;
    }
    interruptCount++;
    if (interruptCount >= 2) {
      exitRequested = true;
      rl.close();
      return;
    }
    write("\n(Ctrl+C again to exit)\n");
    rl.prompt();
  };

  rl.on("SIGINT", handleSigint);

  write(
    theme.paint(
      "banner",
      `AnyCode CLI — mode=${mode}${yolo ? " (yolo)" : ""}. Ctrl+C to abort a turn, twice to exit.\n`,
    ),
  );
  rl.prompt();

  for await (const line of rl) {
    if (exitRequested) {
      break;
    }
    const trimmed = line.trim();
    if (trimmed === "") {
      rl.prompt();
      continue;
    }

    interruptCount = 0;
    const controller = new AbortController();
    currentAbort = controller;

    try {
      if (isSlashCommand(trimmed)) {
        await handleSlashCommand(trimmed, {
          loop,
          rules: permissionRules,
          write,
          signal: controller.signal,
          mcp: mcpManager,
          skills: ext.skills,
          workflows: ext.workflows.map(toWorkflowMeta),

          // so the loop breaks and shuts down through the normal dispose/flush
          // exit path below (design §2.4/§0.1 — never by killing rl mid-turn).
          requestExit: () => {
            exitRequested = true;
          },

          // state. Interactive: mutate transcript.reasoning in place (renderEvent
          // reads it live from the next event). Non-interactive: flip the
          // standalone state so the command still reports an honest on/off.
          toggleReasoning: () => {
            if (transcript !== undefined) {
              const next = !transcript.reasoning;
              transcript.reasoning = next;
              return next;
            }
            reasoningEnabled = !reasoningEnabled;
            return reasoningEnabled;
          },
          getReasoningEffort: () => loopConfig.reasoningEffort ?? "off",
          setReasoningEffort: (effort) => {
            const resolved = resolveReasoningEffort(currentModel, catalogEntry, effort);
            if (effort !== "off" && resolved === undefined) {
              return `model ${currentModel} is not marked as reasoning-capable`;
            }
            selectedReasoningEffort = effort;
            loopConfig.reasoningEffort = resolved;
            return null;
          },

          // the single source of truth for the live mode — the loop reads it at
          // each runTurn entry and the plan-exit arc writes it. getMode reads it;
          // setMode mutates it between turns and persists best-effort.
          getMode: () => loopConfig.mode,
          setMode: (m) => {

            // switching the mode table without swapping the broker would silently
            // auto-approve every ask — refuse rather than deceive.
            if (yolo) {
              return "--yolo pins the permission broker for this session; restart without --yolo to switch modes";
            }
            loopConfig.mode = m;
            void persistence.touchSession(session.id, { mode: m }).catch(() => {});
            return null;
          },

          // live model id + catalog hints, or switches it between turns.
          // currentModel is the single source of truth (mirror of loopConfig.mode).
          model: {
            get: () => currentModel,
            set: (id) => {
              // No factory (an injected test port with no switch factory) ⇒
              // switching is unavailable; refuse honestly (mirror of yolo-refuse).
              if (modelPortFactory === undefined) {
                return "model switching is unavailable: this session runs on an injected model port";
              }
              modelPort.setPort(modelPortFactory(id));
              currentModel = id;

              // reference, A12) and the rebuilt parent prompt see the new modelId.
              systemPromptEnv.modelId = id;

              // window takes effect on the very next turn — the manager's compaction
              // threshold and the context_usage denominator follow (loop.setContextWindow),
              // and loopConfig.context flows to children spawned after the switch
              // (buildChildConfig copies parent.context by reference at spawn). The env
              // override still wins inside resolveContextWindow; an unknown id falls back
              // to the DEFAULT window (never a stale previous model's window).
              const contextWindow =
                resolveContextWindow(id, catalogEntry, envConfig.contextWindowTokens) ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
              loopConfig.maxOutputTokens = resolveMaxOutputTokens(id, catalogEntry, envConfig.maxOutputTokens);
              loopConfig.reasoningEffort = resolveReasoningEffort(id, catalogEntry, selectedReasoningEffort);
              liveContextWindow = contextWindow;
              loopConfig.systemPrompt = composeSystemPrompt();
              // Kept in lockstep with systemPrompt above (design slice-P7.17-cut.md
              // §2.1): repoMap re-renders with the new window, so a stale
              // components array would desync contextBreakdown()'s base-by-
              // subtraction from the freshly rebuilt systemPrompt.
              loopConfig.systemPromptComponents = composeSystemPromptComponents();
              loop.setContextWindow(contextWindow);
              loopConfig.context = { ...loopConfig.context, contextWindowTokens: contextWindow };
              void persistence.touchSession(session.id, { model: id }).catch(() => {});
              return null;
            },
            hints: catalogEntry?.models ?? [],
            ...(catalogEntry !== undefined ? { providerName: catalogEntry.name } : {}),
          },
          ...(repoMapConfig !== null ? { repoMap: { render: renderRepoMap } } : {}),

          // sessions through a narrow list callback — this workspace by default,
          // all workspaces on `/sessions all` (the handler drops the filter).
          sessions: {
            list: (o) => persistence.listSessions(o),
            currentId: session.id,
            workspace: cwd,
          },

          // session's checkpoints and restores files and/or the conversation.

          // reuses the SAME readline prompter the broker uses for permissions
          // (A24). The conversation restore is the SAME transactional swap path
          // as compaction — loop.history.replaceAll feeds the write-behind sink →

          // The enabled=false list/restore stubs are unreachable (handleRewindCommand
          // gates on enabled first) — present only to satisfy the deps type.
          rewind: {
            enabled: checkpointService !== null,
            list: (o) => (checkpointService !== null ? checkpointService.list(o) : Promise.resolve([])),
            confirm: async (q) => /^y(es)?$/i.test((await rewindPrompter.ask(q)).trim()),
            restore: async (id, scope) => {
              const res = await checkpointService!.rewind(id, {
                scope,
                currentHistory: [...loop.history.items],
              });
              if (!res.ok) {
                return res;
              }
              if (res.historyItems !== null) {
                loop.history.replaceAll(res.historyItems);
              }
              return {
                ok: true,
                restoredPaths: res.restoredPaths,
                conversationRestored: res.historyItems !== null,
                safetyCheckpointId: res.safetyCheckpointId,
              };
            },
          },
          // Wiring §2.6 (design slice-5.4-cut.md): /status, /diff, /commit over
          // NodeGitAdapter. `enabled` is the boot-time gitEnabled gate; status/diff

          // has the agent changed since the last commit" projection). `confirm`
          // reuses the SAME readline prompter /rewind uses for its y/N ask. `commit`
          // is a pure stageAll+commit composition resolving to just the new sha:
          // the committed file count is derived by handleCommitCommand from its own
          // pre-commit status snapshot (ratified §2.5/§2.6 divergence — deps.commit
          // never returns a `files` count, so it never double-counts). No git spawn
          // happens on the --print/headless path (slash commands are interactive-
          // only), so this arc lives entirely in the REPL branch.
          git: {
            enabled: gitEnabled,
            status: () => gitService.status(),
            diff: (spec) => gitService.diff({ target: "head", ...(spec?.path !== undefined ? { path: spec.path } : {}) }),
            confirm: async (q) => /^y(es)?$/i.test((await rewindPrompter.ask(q)).trim()),
            commit: async (message) => {
              const staged = await gitService.stageAll();
              if (!staged.ok) {
                return staged;
              }
              return gitService.commit(message);
            },
          },
          // Wiring (design slice-5.6-cut.md wave C): /hooks is a read-only
          // projection of the boot-time hook-config resolution above — the SAME
          // list that was registered onto `hooks` (InMemoryHookRunner), captured
          // outer-scope so it survives the try/catch that built it.
          hooks: { list: () => capturedHookDeclarations },
          // Wiring (design slice-5.5-cut.md wave C): /tasks lists/kills
          // through the SAME InProcessTaskManager the bg-Bash tool spawns

          // reaches the REPL branch at all, so this is unreachable there in
          // practice) — the `??` fallbacks make the grain honest regardless.
          tasks: { list: () => tasks?.list() ?? [], kill: (id) => tasks?.kill(id) ?? false },
          // Wiring (design slice-6.1-cut.md §2-D1): /lsp is a read-only status
          // projection over the SAME LspManager the diagnostics-wrapped

          // servers were configured — the `??` fallback makes the grain honest.
          lsp: { status: () => lsp?.status() ?? [] },
          // Wiring (design slice-6.6-cut.md §2-C1): /telemetry is a read-only
          // status projection over the SAME sink session_start/session_end
          // write into. `telemetry` is `null` when the config gate was off —
          // the grain reports that honestly as a null status.
          telemetry: { status: () => (telemetry === null ? null : telemetry.status()) },

          // lists, or clears the SAME stagedImages array the submit path

          // touching the model or the stage on a rejected attach.
          images: { stage: stageImage, list: listStagedImages, clear: clearStagedImages },
        });
      } else {
        // Title derivation (Phase 4 slice 4.4-T, design feature-session-titles.md
        // §3): the first accepted (non-slash) line in a title-less session names
        // it, from the RAW trimmed text — BEFORE the plan-mode reminder tag is
        // appended below, so a reminder never leaks into the title (mirrors the
        // desktop host's raw-text derivation point). Slash commands never reach
        // this branch, so they never trigger it. Fire-and-forget; exactly once
        // per session (sessionTitleSet flip, mirroring host/session.ts's titleSet).
        if (!sessionTitleSet) {
          sessionTitleSet = true;
          const title = deriveSessionTitle(sanitizeTitleSource(trimmed));
          if (title.length > 0) {
            void persistence.touchSession(session.id, { title }).catch(() => {});
            // Arms the tier-2 refinement below, over the SAME raw text.
            pendingTitleText = trimmed;
          }
        }

        // each transcript write; applyStatus maps every event to a status label;
        // theme + transcript thread through to renderEvent (theme = SGR since
        // 4.1.3, transcript = no-op until 4.2.2 rewrites its branches).
        const turnWrite = status.wrapWrite(write);

        // plan mode, append the plan-discipline reminder to the prompt — the
        // model does not remember the mode between turns and the system prompt is
        // static. loopConfig.mode is the single source of truth (after a plan
        // exit the loop already advanced it, so the next turn drops the reminder).
        let turnInput =
          loopConfig.mode === "plan" ? withPlanModeReminder(trimmed) : trimmed;

        // injected AFTER the plan-mode reminder (both tags coexist, order
        // plan -> notices) and strictly AFTER title derivation above (from RAW
        // `trimmed`), so a notice never leaks into the session title. Drained
        // (not peeked) every turn so a notice is delivered exactly once; a
        // turn with nothing to report never calls withBackgroundTaskNotices,
        // keeping turnInput byte-identical to pre-5.5 (design §1 DoD).
        if (tasks !== null) {
          const notices = tasks.drainNotices();
          if (notices.length > 0) {
            turnInput = withBackgroundTaskNotices(turnInput, notices);
          }
        }

        // once, on this very non-slash accepted line (slash lines never reach
        // this branch, so /image staging is untouched by them) — AFTER title
        // derivation above (from the RAW trimmed text), so a staged image
        // never affects the title. `splice` empties the stage so a later turn
        // never repeats it (drain, not peek).
        const attachments = stagedImages.splice(0, stagedImages.length);
        for await (const event of loop.runTurn(turnInput, {
          signal: controller.signal,
          ...(attachments.length ? { attachments } : {}),
        })) {
          applyStatus(status, event);
          renderEvent(event, turnWrite, theme, transcript);
        }
      }
    } catch (error) {
      write(`\n[fatal] ${error instanceof Error ? error.message : String(error)}\n`);
      exitCode = 1;
    } finally {
      currentAbort = null;

      // every exit path (normal completion, Ctrl+C abort, or a thrown turn)
      // before rl.prompt() draws the next prompt.
      status.clear();

      // turn's teardown only — pendingTitleText is consumed unconditionally
      // (never re-armed by a later turn) so this can only ever fire once per
      // session, regardless of whether that turn succeeded or threw. The
      // resulting promise is held in titleWork and MUST be awaited in the

      if (pendingTitleText !== null) {
        const text = pendingTitleText;
        pendingTitleText = null;
        if (titleRefinementEnabled) {
          titleWork = generateSessionTitle({ modelPort, text })
            .then((t) => {
              if (t) {
                return persistence.touchSession(session.id, { title: t });
              }
            })
            .then(() => {})
            .catch(() => {
              // Fail-soft: a refinement error/timeout never surfaces; the
              // heuristic title written above stands.
            });
        }
      }
    }

    if (exitRequested) {
      break;
    }
    rl.prompt();
  }


  // timer outlives the REPL (design §3.3 unref + explicit dispose).
  status.dispose();
  rl.close();


  // every live task and awaits reaping, bounded by BACKGROUND_DISPOSE_DEADLINE_MS
  // — STRICTLY before mcpManager.dispose() below, so orphans die before the
  // rest of shutdown proceeds. Bounded by construction (InProcessTaskManager's
  // own Promise.race), so this can never hang the CLI's exit; `tasks` is `null`

  await tasks?.disposeAll();
  // Language-server reap (design slice-6.1-cut.md §2-D1/§6#5): polite
  // shutdown-then-kill for every live server, bounded by LSP_DISPOSE_DEADLINE_MS
  // (LspManager's own Promise.race) — STRICTLY before mcpManager.dispose()
  // below, mirroring tasks.disposeAll() immediately above. `lsp` is `null`

  // this is a no-op.
  await lsp?.disposeAll();


  // race, B5) and idempotent, so this can never hang the CLI's shutdown.
  // `telemetry` is `null` when the config gate was off, in which case this is
  // a no-op.
  if (telemetry !== null) {
    telemetry.record({ v: 1, ts: Date.now(), session: session.id, t: "session_end" });
    await telemetry.dispose();
  }
  // Exit path: dispose every MCP transport (bounded by MCP_DISPOSE_DEADLINE_MS,
  // so this never hangs the CLI's shutdown) alongside the persistence flush
  // (task 1.7) — drain the write-behind queue and close the database so no
  // queued write is lost beyond the accepted write-behind tail-loss window on a
  // hard kill (R8).
  await mcpManager.dispose();
  await historySink.flush();

  // closing persistence, or a still-in-flight touchSession would write to a
  // closed database.
  if (titleWork) {
    await titleWork;
  }
  await persistence.close();

  return exitCode;
}

const isDirectRun =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  runCli()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
}
