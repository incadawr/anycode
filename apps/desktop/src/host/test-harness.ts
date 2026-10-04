/**
 * Shared test harness for the host protocol server. Not a test file itself; it
 * wires the REAL core (AgentLoop + dispatcher + ModePermissionEngine +
 * InMemoryHookRunner + snapshot hook + IpcPermissionBroker) against a scripted
 * ModelPort and an in-memory FileSystemPort, over a real worker_threads

 * agnostic WirePort so no Electron is needed).
 */

import { MessageChannel, type MessagePort as NodeMessagePort } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import {
  AgentLoop,
  InMemoryHookRunner,
  InMemoryTodoStore,
  ModePermissionEngine,
  NodeHttpAdapter,
  RuleAwarePermissionEngine,
  SessionPermissionRules,
  backgroundCapableBashTool,
  bashKillTool,
  bashOutputTool,
  createDefaultToolRegistry,
  diagnosticsEditTool,
  diagnosticsWriteTool,
} from "@anycode/core";
import type {
  AgentLoopConfig,
  BackgroundTaskPort,
  CommandHookDeclaration,
  FileStat,
  FileSystemPort,
  HistoryItem,
  LspPort,
  MediaCapabilityPort,
  ModelPort,
  ModelRequest,
  ModelStreamEvent,
  PermissionMode,
  ReasoningEffort,
  RecognizerEndpoint,
  TelemetryStatus,
} from "@anycode/core";
import type { HostToUiMessage, UiToHostMessage, WireEnvStatus, WirePort } from "../shared/protocol.js";
import type { GitUiBridge } from "./git-bridge.js";
import { IpcPermissionBroker } from "./permission-broker.js";
import { wirePlanExit } from "./plan-exit.js";
import { CoreEngine } from "./engines/core-engine.js";
import type { SessionEngine } from "./engines/session-engine.js";
import { Outbound, Session, type SessionOptions, type SessionPersistence } from "./session.js";
import { createSnapshotHook } from "./snapshot-hook.js";

/** ModelPort that replays one scripted stream (a step) per streamText call. */
export class ScriptedModelPort implements ModelPort {
  private step = 0;

  /**
   * Every ModelRequest received, in order (6.DP-2: lets a test assert the
   * injected <system-reminder> notice block reached the model verbatim — the
   * only honest way to see "what the model actually got"). Existing tests never
   * read it, so it is purely additive.
   */
  readonly requests: ModelRequest[] = [];

  constructor(private readonly steps: ModelStreamEvent[][]) {}

  streamText(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    const events = this.steps[this.step] ?? [];
    this.step += 1;
    const signal = request.abortSignal;
    return (async function* () {
      for (const event of events) {
        if (signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        yield event;
      }
    })();
  }
}

/**
 * TASK.117 acceptance defect 1 fixture port: a ScriptedModelPort whose FIRST
 * step parks after a chosen event index until the test releases a deferred —
 * the model is mid-response (start + text_start + N deltas emitted,
 * text_end/finish NOT yet) for exactly as long as the test holds the gate.
 * That is the unfinished-stream window a renderer reload lands inside: core
 * appends the assistant item only per COMPLETED step, so the reconnect
 * snapshot holds no assistant text and the partial must come from the
 * live-stream checkpoint. The AbortSignal aborts a parked stream exactly
 * like the scripted one. `gate` is one plain deferred the test releases.
 */
export class GatedModelPort implements ModelPort {
  private step = 0;
  readonly requests: ModelRequest[] = [];
  /** Resolved by the test to unpark the parked stream. */
  readonly release: () => void;
  private readonly parked: Promise<void>;

  constructor(private readonly steps: ModelStreamEvent[][], private readonly parkAfterIndex: number) {
    let resolvePark: () => void = () => {};
    this.parked = new Promise<void>((resolve) => {
      resolvePark = resolve;
    });
    this.release = () => resolvePark();
  }

  streamText(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    const events = this.steps[this.step] ?? [];
    const parkAfterIndex = this.parkAfterIndex;
    const parked = this.parked;
    this.step += 1;
    const signal = request.abortSignal;
    return (async function* () {
      for (const [index, event] of events.entries()) {
        if (signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        yield event;
        if (index === parkAfterIndex && signal !== undefined) {
          await new Promise<void>((resolve, reject) => {
            const onAbort = (): void => reject(signal.reason ?? new Error("Aborted"));
            if (signal.aborted) {
              onAbort();
              return;
            }
            signal.addEventListener("abort", onAbort, { once: true });
            parked.then(
              () => {
                signal.removeEventListener("abort", onAbort);
                resolve();
              },
              (error) => {
                signal.removeEventListener("abort", onAbort);
                reject(error);
              },
            );
          });
        }
      }
    })();
  }
}

/** Minimal in-memory FileSystemPort (path -> UTF-8 content). */
export class MemFs implements FileSystemPort {
  readonly files = new Map<string, string>();

  async readFile(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) {
      throw new Error(`ENOENT: ${path}`);
    }
    return value;
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  async stat(path: string): Promise<FileStat> {
    const value = this.files.get(path);
    if (value === undefined) {
      throw new Error(`ENOENT: ${path}`);
    }
    return {
      size: Buffer.byteLength(value, "utf-8"),
      mtimeMs: 0,
      isFile: true,
      isDirectory: false,
    };
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async mkdir(): Promise<void> {
    // no-op: writeFile creates entries directly.
  }

  async readdir(): Promise<string[]> {
    return [];
  }
}

/** FileSystemPort whose every method rejects — used to prove the snapshot observer swallows errors. */
export class ThrowingFs implements FileSystemPort {
  async readFile(): Promise<string> {
    throw new Error("fs boom (readFile)");
  }

  async writeFile(): Promise<void> {
    throw new Error("fs boom (writeFile)");
  }

  async stat(): Promise<FileStat> {
    throw new Error("fs boom (stat)");
  }

  async exists(): Promise<boolean> {
    throw new Error("fs boom (exists)");
  }

  async mkdir(): Promise<void> {
    throw new Error("fs boom (mkdir)");
  }

  async readdir(): Promise<string[]> {
    throw new Error("fs boom (readdir)");
  }
}

/** Adapts a worker_threads MessagePort to WirePort (its .on('message') passes the value directly). */
export function nodeWirePort(port: NodeMessagePort): WirePort {
  return {
    post(message: unknown): void {
      port.postMessage(message);
    },
    onMessage(cb: (message: unknown) => void): void {
      port.on("message", (value: unknown) => {
        cb(value);
      });
      port.start();
    },
    onClose(cb: () => void): void {
      port.on("close", () => {
        cb();
      });
    },
  };
}

export interface HarnessOptions {
  steps: ModelStreamEvent[][];
  /**
   * TASK.117 acceptance defect 1 fixture: replaces the built-in
   * ScriptedModelPort with a GatedModelPort that parks the FIRST step after
   * `gatedParkAfterIndex` events until `gated.release()` — the unfinished
   * mid-response window a reconnect must survive. Returns the port so the
   * test can release it. Omitted -> the ordinary ScriptedModelPort
   * (byte-identical for every existing test).
   */
  gated?: { parkAfterIndex: number };
  mode?: PermissionMode;
  /** Backing store for the tool handlers AND the session "after" snapshot. */
  toolFs?: FileSystemPort;
  /** fs the "before" snapshot hook reads (defaults to toolFs). */
  snapshotFs?: FileSystemPort;
  brokerTimeoutMs?: number;
  /**
   * TASK.117 product-defect fix: forwarded to SessionOptions.reconnectGraceMs
   * (the close→denyAll grace window's test seam). Omitted -> Session's
   * production default; ONLY tests inject a value to pin the grace-expiry
   * path without real-time waits.
   */
  reconnectGraceMs?: number;
  /** Boot history snapshot for transcript hydration (design §3.3); empty by default. */
  bootHistory?: readonly HistoryItem[];
  /**
   * Dev/automation-ONLY override for `SESSION_HISTORY_MAX_ITEMS` (TASK.188
   * S4), forwarded straight to `Session` — the harness never resolves it from
   * the environment itself. Defaults to `SESSION_HISTORY_MAX_ITEMS` when absent.
   */
  historyMaxItems?: number;
  /** Whether the boot session already had a title (skips title derivation). */
  hasTitle?: boolean;
  /**
   * Tier-2 title refinement callback (Phase 4 slice 4.4-T, design §3,

   * pre-existing test (no DI callback) has no refinement behavior at all.
   */
  refineTitle?: (text: string) => Promise<string | null>;
  /**
   * Pre-seeded always-allow rules store (slice 2.2.3, design §5) — pass a
   * store already populated (mirroring host/boot.ts's seedAlwaysAllowRules) to
   * exercise "a persisted rule auto-allows from the first turn"; defaults to a
   * fresh empty store, wrapping `ModePermissionEngine` in
   * `RuleAwarePermissionEngine` either way (an empty store is behaviorally
   * identical to the bare engine, so every pre-existing test is unaffected).
   */
  rules?: SessionPermissionRules;
  /**
   * Slice 5.7: build a GitUiBridge over the harness's OWN `outbound` (constructed
   * internally, before session construction — a pre-built bridge from the caller
   * could not share it), so an e2e `git_status`/`git_result` reaches `received`.
   * Omitted by default -> `git_command` no-ops (every pre-existing test is
   * unaffected).
   */
  git?: (outbound: Outbound) => GitUiBridge;
  /** 6.DP-1: LspPort for the diagnostics-parity e2e. When present the harness
   *  mirrors host boot EXACTLY: registers diagnosticsEditTool/diagnosticsWriteTool
   *  (silentDuplicateWarning) into its registry AND threads `lsp` into
   *  AgentLoopConfig. Omitted by default -> registry and config byte-identical
   *  to pre-6.DP-1 (every existing test unaffected). */
  lsp?: LspPort;
  /**
   * Slice P7.25/F3: an explicit Session `lsp` seam (status + optional
   * onStatusChange live-push subscription) surfaced DIRECTLY to Session,
   * overriding the status-only wrap of `lsp` above. For live-push tests that
   * must drive transitions and observe the ui_ready-gated push. Omitted ->
   * Session seam byte-identical (the `lsp` wrap or nothing).
   */
  lspSeam?: SessionOptions["lsp"];
  /** Renderer Panels sub-slice B: optional static hook list surfaced by Session. */
  hooksList?: { declarations: readonly CommandHookDeclaration[]; configError?: string };
  /**
   * Slice P7.8: optional telemetry + repo-map status seam surfaced by Session.
   * Omitted by default -> `pushEnvStatus` no-ops (every pre-existing test

   */
  envStatus?: {
    telemetry(): TelemetryStatus | null;
    repoMap(): WireEnvStatus["repoMap"];
    flushTelemetry?(): Promise<void>;
  };
  /**
   * Multimodal send-path capability gate; defaults to enabled for legacy tests.
   * TASK.56 W2: a function form mirrors the host's live closure over the
   * current model (re-read per emit); `null` omits the Session seam entirely
   * (legacy-host shape — no `imageInput` on the wire) while the loop's media
   * port stays default-enabled.
   */
  imageInputEnabled?: boolean | (() => boolean) | null;
  /**
   * TASK.198 срез C: live verdict for the vision fallback, mirroring
   * `imageInputEnabled`'s own boolean/function/omitted shapes. Omitted ->
   * `SessionOptions.imageFallbackAvailable` is absent (byte-identical to
   * pre-TASK.198 for every existing test — the turn-accept gate falls back
   * to `imageInputEnabled` alone).
   */
  imageFallbackAvailable?: boolean | (() => boolean);
  /**
   * TASK.198 срез C: the host-owned commit callback a test can inspect
   * (e.g. `vi.fn()`) to assert what Session's deferred-apply mechanics
   * actually invoked and when. Omitted -> `SessionOptions.
   * applyRecognizerConfig` is absent (every existing test unaffected).
   */
  applyRecognizerConfig?: (endpoint: RecognizerEndpoint | null) => void;
  /** 6.DP-2: BackgroundTaskPort for the bg-tasks-parity e2e. When present the
   *  harness mirrors host boot EXACTLY: registers backgroundCapableBashTool
   *  (silentDuplicateWarning, over the default Bash) + bashOutputTool +
   *  bashKillTool into its registry, threads `tasks` into AgentLoopConfig, AND
   *  hands Session the same object as its narrow drainNotices seam. Omitted by
   *  default -> registry, config and Session byte-identical to pre-6.DP-2
   *  (every existing test unaffected). */
  tasks?: BackgroundTaskPort;
  /**
   * Slice P7.26/R1: per-turn checkpoint capturer threaded into AgentLoopConfig
   * EXACTLY as host boot does (`...(checkpointService ? { checkpoints } : {})`).
   * Omitted by default -> config has no `checkpoints`, so the loop's checkpoint
   * arc stays dormant and every pre-existing test is byte-identical (mirror of
   * the tasks/lsp optional-port precedent above).
   */
  checkpoints?: AgentLoopConfig["checkpoints"];
  /**
   * Slice P7.26/R2: the Session-level rewind/list seam (checkpoint_list /
   * rewind_request), threaded DIRECTLY into Session (distinct from the loop's
   * `checkpoints` capturer above). Host boot passes the SAME ShadowGitCheckpoints
   * to both; a rewind-unit test can pass the real service as both, or a hand-built
   * fake `{list, rewind}` here (with no loop capturer) to exercise the wire guards
   * without real git. Omitted -> Session seam absent (checkpoints fail-closed).
   */
  checkpointsSeam?: SessionOptions["checkpoints"];
  /** Provider-aware reasoning-effort support exposed to Session. */
  reasoningSupported?: boolean;
  /** Provider-declared levels exposed to the UI and enforced by Session. */
  availableEffortLevels?: ReasoningEffort[];
  /** Slice P7.15 (F14): user-selected effort tier tracked across a model switch. */
  selectedEffort?: ReasoningEffort;
  /**
   * Slice P7.15 (F14): mid-session model-switch callback threaded to Session.
   * Omitted -> `set_model` is a silent no-op (byte-identical to pre-P7.15 for
   * every existing test). A test supplies a scripted switcher to exercise the
   * route/guard/model_changed/effort-re-resolution without a real provider.
   */
  switchModel?: (
    id: string,
    selectedEffort: ReasoningEffort,
  ) => { model: string; reasoningEffort: ReasoningEffort; availableEffortLevels?: ReasoningEffort[] };
  /**
   * TASK.117 phase-1 (test-only, causal fault injection): a FileSystemPort
   * wrapper whose Read is hooked. The hook receives the tool's REAL
   * AbortSignal (dispatcher handlerCtx.abortSignal, linked to the turn's
   * controller) — a test can park one call on a gate and later release it,
   * so the OLD turn's engine stream stays mid-dispatch across cancel and
   * the newer turn's admission (the exact stale-finalizer interleave).
   * Omitted -> the harness fs is forwarded untouched (byte-identical for
   * every existing test).
   */
  fsHook?: (readFile: (path: string) => Promise<string>, path: string, signal: AbortSignal | undefined) => Promise<string>;
  /** Replaces the built-in CoreEngine for neutral Session seam tests. */
  engine?: SessionEngine;
  /**
   * 6.DP-2: overrides the config `cwd` (default "/workspace"). Needed ONLY by
   * the bg-tasks e2e: a background task is a REAL child spawned by the manager's
   * own NodeExecutionAdapter with `cwd` = config.cwd, and spawn(2) fails ENOENT
   * on a non-existent directory, so those tests point cwd at a real temp dir.
   * Omitted -> "/workspace" exactly as before (every existing test unaffected —
   * their tools never spawn a real child, `ports.exec` is a stub).
   */
  cwd?: string;
  /** Durable ephemeral system context queued by a direct UI exit from a worktree. */
  worktreeExitNoticePending?: boolean;
  /** Clears the durable marker only after a core model stream accepts the augmented turn. */
  consumeWorktreeExitNotice?: () => Promise<void>;
  continuationPending?: boolean;
  continuationMode?: "model" | "none";
  onContinuationReady?: () => Promise<void>;
  onContinuationComplete?: () => Promise<void>;
  /** TASK.45 W11: surfaced directly to Session; omitted -> no-op (every pre-existing test unaffected). */
  reportProviderHealth?: SessionOptions["reportProviderHealth"];
  /**
   * TASK.27: opts this harness into the plan-exit contract EXACTLY as host boot
   * does — through the one `wirePlanExit` call, which both registers
   * `ExitPlanMode` into the registry and produces the `planExitMode`/
   * `onModeChange` pair spread into AgentLoopConfig. Omitted by default ->
   * registry and config byte-identical to pre-TASK.27 (every pre-existing test
   * unaffected, and the tool stays invisible to the model).
   */
  planExit?: boolean;
  /**
   * TASK.145 срез 2: the host's pending-detached-child-report queue seam,
   * threaded DIRECTLY to Session (mirror of the checkpointsSeam/
   * reportProviderHealth precedent above). Omitted -> `ui_ready`'s
   * `resendAll()` call and `child_report_ack`'s `ack()` call are both no-ops
   * (every pre-existing test unaffected).
   */
  pendingChildReports?: SessionOptions["pendingChildReports"];
}

export interface Harness {
  session: Session;
  engine: SessionEngine;
  broker: IpcPermissionBroker;
  outbound: Outbound;
  config: AgentLoopConfig;
  toolFs: FileSystemPort;
  /** The SessionPermissionRules instance backing config.permissionEngine (design §5). */
  rules: SessionPermissionRules;
  /** Every HostToUiMessage received on the UI side, in arrival order. */
  received: HostToUiMessage[];
  /** Every persistence `touch` patch the Session emitted, in order (title/mode). */
  touches: { title?: string; mode?: PermissionMode }[];
  /**
   * TASK.117 acceptance defect 1 fixture: the GatedModelPort constructed for
   * this harness (undefined unless `options.gated` was set). `release()`
   * un-parks the parked first step so the turn can finish.
   */
  gated: GatedModelPort | undefined;
  /**
   * TASK.117 continuation fixture seam (test-only): installs a REAL host-side
   * pending-prompt record through the Session's own production helpers —
   * `pendingPrompt` (the exact slot shape `acceptUserMessage` captures at
   * admission: owner = minted outer turnId + requestId pair) and the REAL
   * `pushPendingPrompt` wire push (core-gated, sendDirect) — WITHOUT running
   * a turn. That is the genuine host state a crash-to-rehost window leaves
   * behind when the pre-rehost terminal never ran its own clear and a fresh
   * host picks the session up `continuationPending`. Called BEFORE a renderer
   * handshake the seed push is lost with no recovery (sendDirect, no port) —
   * exactly like a genuine admission accepted while no renderer is attached,
   * and every later ui_ready re-pushes the occupied slot as a payload-bearing
   * pending_prompt over the real wire. Called AFTER a handshake the seed's
   * own REAL push is delivered on the wire immediately (the port is
   * attached) — the TASK.117 continuation fixture uses this window so a real
   * store can render the stale state BEFORE any continuation entry runs.
   * No-op on foreign engines or when a turn is live (mirrors the production
   * capture gates).
   */
  seedPendingPrompt(requestId: string, text: string): void;
  /**
   * TASK.117 continuation fixture seam (test-only): read-only SNAPSHOT of
   * the REAL host pending slot (`Session.pendingPrompt`) — the exact record
   * the production admission path captured. Copy only; cannot mutate.
   */
  pendingPromptSlot(): { turnId: string; requestId: string; text: string } | null;
  /**
   * TASK.117 deferred-continuation seam (test-only): arms the DURABLE
   * continuation claim AFTER construction — the state a host boot derives
   * from the persisted terminal marker and passes as `continuationPending`.
   * Because the Session was built WITHOUT the claim, the FIRST ui_ready
   * (physical attach / metadata delivery) cannot start a continuation;
   * once armed, the NEXT ui_ready consumes the claim through the REAL
   * production branch (route()'s continuationPending tail →
   * startContinuation → stale-pending clear → REAL core loop). Honest
   * nonpublic access confined to this seam; the entry is never simulated.
   */
  armContinuation(): void;
  /** Posts a UiToHostMessage from the UI side to the host. */
  send(message: UiToHostMessage): void;
  /** Resolves with the first received message matching the predicate (rejects on timeout). */
  waitFor<T extends HostToUiMessage>(
    predicate: (message: HostToUiMessage) => message is T,
    timeoutMs?: number,
  ): Promise<T>;
  /** Resolves once the predicate over the received log holds (rejects on timeout). */
  waitUntil(predicate: () => boolean, timeoutMs?: number): Promise<void>;
  /** Yields to the macrotask queue once (lets transport + async settle). */
  flush(): Promise<void>;
  close(): void;
}

export function createHarness(options: HarnessOptions): Harness {
  const toolFs = options.toolFs ?? new MemFs();
  const snapshotFs = options.snapshotFs ?? toolFs;

  const channel = new MessageChannel();
  const uiPort = channel.port1;
  const hostPort = channel.port2;

  const received: HostToUiMessage[] = [];
  uiPort.on("message", (value: unknown) => {
    received.push(value as HostToUiMessage);
  });
  uiPort.start();

  const outbound = new Outbound();
  const emit = (message: HostToUiMessage): void => {
    outbound.emit(message);
  };

  const registry = createDefaultToolRegistry();
  // Mirror host boot EXACTLY (slice 6.DP-1): with an LspPort present, re-register
  // the diagnostics Edit/Write wrappers over the defaults (same names, same
  // metadata objects) so the model-facing surface is byte-identical while
  // post-write diagnostics ride the tool result. Omitted -> no re-registration.
  if (options.lsp) {
    registry.register(diagnosticsEditTool, { silentDuplicateWarning: true });
    registry.register(diagnosticsWriteTool, { silentDuplicateWarning: true });
  }
  // Mirror host boot EXACTLY (slice 6.DP-2): with a BackgroundTaskPort present,
  // re-register the background-capable Bash OVER the default (same name "Bash",
  // the SAME metadata object by reference -> byte-identical permission path) and
  // register BashOutput/BashKill — all BEFORE the toolNames snapshot the loop
  // reads, so the model-facing surface is exactly the CLI's +2 tool names.
  // silentDuplicateWarning is required or the registry boot-warns on the Bash
  // overwrite. Omitted -> no re-registration (registry byte-identical).
  if (options.tasks) {
    registry.register(backgroundCapableBashTool, { silentDuplicateWarning: true });
    registry.register(bashOutputTool);
    registry.register(bashKillTool);
  }
  // Mirror host boot EXACTLY (TASK.27): ONE call both registers ExitPlanMode
  // and yields the loop control, so the harness can never reproduce the unsafe
  // half-wiring. `session` below is captured lazily — onModeChange only ever
  // fires from inside a running turn, long after construction.
  const planExit = options.planExit
    ? wirePlanExit(registry, (mode) => {
        session.notifyModeChanged(mode);
      })
    : null;
  const hooks = new InMemoryHookRunner();
  hooks.register(createSnapshotHook(snapshotFs, emit));
  const broker = new IpcPermissionBroker(emit, options.brokerTimeoutMs);
  const rules = options.rules ?? new SessionPermissionRules();
  const media: MediaCapabilityPort = {
    imageInputEnabled:
      typeof options.imageInputEnabled === "function"
        ? options.imageInputEnabled
        : () => (typeof options.imageInputEnabled === "boolean" ? options.imageInputEnabled : true),
  };

  const gatedPort = options.gated ? new GatedModelPort(options.steps, options.gated.parkAfterIndex) : undefined;
  const config: AgentLoopConfig = {
    modelPort: gatedPort ?? new ScriptedModelPort(options.steps),
    registry,
    hooks,
    permissionEngine: new RuleAwarePermissionEngine(new ModePermissionEngine(), rules),
    permissionBroker: broker,
    mode: options.mode ?? "build",
    ports: {
      fs: options.fsHook
        ? wrapFsWithHook(toolFs, options.fsHook)
        : toolFs,
      exec: {} as AgentLoopConfig["ports"]["exec"],
      http: new NodeHttpAdapter(),
      todos: new InMemoryTodoStore(),
    },
    cwd: options.cwd ?? "/workspace",
    media,
    ...(options.lsp ? { lsp: options.lsp } : {}),
    ...(options.tasks ? { tasks: options.tasks } : {}),
    // Mirror host boot (slice P7.26/R1): a supplied capturer is spread into
    // config.checkpoints; absent -> the arc stays dormant (byte-identical).
    ...(options.checkpoints ? { checkpoints: options.checkpoints } : {}),
    // Mirror host boot (TASK.27): planExitMode + onModeChange, or nothing at
    // all -> ctx.planMode is never built and ExitPlanMode fails closed.
    ...(planExit ?? {}),
  };
  const loop = new AgentLoop(config);
  // TASK.117: mirror the REAL host boot seam (host/index.ts's
  // `ConversationHistory({ initial })`) — a resumed session's persisted rows
  // seed the loop's history, so `engine.historyItems()` and the Session's
  // `bootHistory` option are THE SAME items by construction. The harness
  // used to leave the loop empty and hand `bootHistory` to Session alone,
  // which TASK.117's rebuild-on-ui_ready exposed as an impossible state (a
  // fresh snapshot read from an engine whose history never grew). Seeding
  // here keeps every existing boot-history test meaningful with ZERO
  // per-test edits — the same invariant production maintains.
  if (options.bootHistory !== undefined && options.engine === undefined) {
    loop.history.replaceAll([...options.bootHistory]);
  }
  const engine = options.engine ?? new CoreEngine({
    loop,
    config,
    ...(options.switchModel !== undefined ? { switchModelImpl: options.switchModel } : {}),
  });

  const touches: { title?: string; mode?: PermissionMode }[] = [];
  const persistence: SessionPersistence = {
    touch(patch) {
      touches.push(patch);
    },
  };

  const session = new Session({
    outbound,
    engine,
    broker,
    fs: toolFs,
    workspace: "/workspace",
    projectRoot: "/workspace",
    model: "scripted-model",
    sessionId: "test-session",
    bootHistory: options.bootHistory,
    ...(options.historyMaxItems !== undefined ? { historyMaxItems: options.historyMaxItems } : {}),
    hasTitle: options.hasTitle,
    rules,
    persistence,
    refineTitle: options.refineTitle,
    git: options.git?.(outbound),
    ...(options.tasks ? { tasks: options.tasks } : {}),
    ...(options.lspSeam
      ? { lsp: options.lspSeam }
      : options.lsp
        ? { lsp: { status: () => options.lsp!.status() } }
        : {}),
    ...(options.hooksList
      ? {
          hooksList: {
            list: () => options.hooksList!.declarations,
            ...(options.hooksList.configError !== undefined ? { configError: options.hooksList.configError } : {}),
          },
        }
      : {}),
    ...(options.envStatus ? { envStatus: options.envStatus } : {}),
    ...(options.checkpointsSeam ? { checkpoints: options.checkpointsSeam } : {}),
    ...(options.reconnectGraceMs !== undefined ? { reconnectGraceMs: options.reconnectGraceMs } : {}),
    ...(options.imageInputEnabled !== null ? { imageInputEnabled: media.imageInputEnabled } : {}),
    ...(options.imageFallbackAvailable !== undefined
      ? {
          imageFallbackAvailable:
            typeof options.imageFallbackAvailable === "function"
              ? options.imageFallbackAvailable
              : () => options.imageFallbackAvailable === true,
        }
      : {}),
    ...(options.applyRecognizerConfig !== undefined ? { applyRecognizerConfig: options.applyRecognizerConfig } : {}),
    ...(options.reasoningSupported !== undefined ? { reasoningSupported: options.reasoningSupported } : {}),
    ...(options.availableEffortLevels !== undefined ? { availableEffortLevels: options.availableEffortLevels } : {}),
    ...(options.selectedEffort !== undefined ? { selectedEffort: options.selectedEffort } : {}),
    ...(options.worktreeExitNoticePending !== undefined
      ? { worktreeExitNoticePending: options.worktreeExitNoticePending }
      : {}),
    ...(options.consumeWorktreeExitNotice !== undefined
      ? { consumeWorktreeExitNotice: options.consumeWorktreeExitNotice }
      : {}),
    ...(options.continuationPending !== undefined ? { continuationPending: options.continuationPending } : {}),
    ...(options.continuationMode !== undefined ? { continuationMode: options.continuationMode } : {}),
    ...(options.onContinuationReady !== undefined ? { onContinuationReady: options.onContinuationReady } : {}),
    ...(options.onContinuationComplete !== undefined ? { onContinuationComplete: options.onContinuationComplete } : {}),
    ...(options.reportProviderHealth !== undefined ? { reportProviderHealth: options.reportProviderHealth } : {}),
    ...(options.pendingChildReports !== undefined ? { pendingChildReports: options.pendingChildReports } : {}),
  });
  session.bindPort(nodeWirePort(hostPort));

  const waitFor = <T extends HostToUiMessage>(
    predicate: (message: HostToUiMessage) => message is T,
    timeoutMs = 1_000,
  ): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const existing = received.find(predicate);
      if (existing) {
        resolve(existing);
        return;
      }
      const onMessage = (value: unknown): void => {
        const message = value as HostToUiMessage;
        if (predicate(message)) {
          cleanup();
          resolve(message);
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("waitFor timed out"));
      }, timeoutMs);
      const cleanup = (): void => {
        uiPort.off("message", onMessage);
        clearTimeout(timer);
      };
      uiPort.on("message", onMessage);
    });

  return {
    session,
    engine,
    broker,
    outbound,
    config,
    toolFs,
    rules,
    received,
    touches,
    gated: gatedPort,
    seedPendingPrompt(requestId: string, text: string): void {
      // Test-only nonpublic access (narrow cast): the harness drives the REAL
      // production capture/push path — never a fabricated wire message.
      const internal = session as unknown as {
        engine: { id: string };
        pendingPrompt: { turnId: string; requestId: string; text: string } | null;
        busy: boolean;
        pushPendingPrompt(): void;
      };
      if (internal.engine.id !== "core" || internal.pendingPrompt !== null || internal.busy) {
        return;
      }
      internal.pendingPrompt = { turnId: randomUUID(), requestId, text };
      internal.pushPendingPrompt();
    },
    pendingPromptSlot(): { turnId: string; requestId: string; text: string } | null {
      const internal = session as unknown as { pendingPrompt: { turnId: string; requestId: string; text: string } | null };
      return internal.pendingPrompt === null ? null : { ...internal.pendingPrompt };
    },
    armContinuation(): void {
      const internal = session as unknown as { continuationPending: boolean };
      internal.continuationPending = true;
    },
    send(message: UiToHostMessage): void {
      uiPort.postMessage(message);
    },
    waitFor,
    waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        if (predicate()) {
          resolve();
          return;
        }
        const onMessage = (): void => {
          if (predicate()) {
            cleanup();
            resolve();
          }
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error("waitUntil timed out"));
        }, timeoutMs);
        const cleanup = (): void => {
          uiPort.off("message", onMessage);
          clearTimeout(timer);
        };
        uiPort.on("message", onMessage);
      });
    },
    async flush(): Promise<void> {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    },
    close(): void {
      uiPort.close();
      hostPort.close();
    },
  };
}

// ── stream-event builders (keep scripted steps terse and readable) ──────────

/**
 * TASK.117 phase-1 (test-only): wraps a FileSystemPort so Read's file fetch
 * funnels through the injected hook (with the tool call's real AbortSignal).
 * Every other method forwards verbatim.
 */
function wrapFsWithHook(
  fs: FileSystemPort,
  hook: NonNullable<HarnessOptions["fsHook"]>,
): FileSystemPort {
  const readFile = (path: string): Promise<string> => fs.readFile(path);
  return {
    // The extra `signal` arg is ignored by the underlying port (the
    // dispatcher hands ctx.abortSignal positionally; FileSystemPort
    // implementations take (path) and simply ignore extras).
    readFile: ((path: string, signal?: AbortSignal) => hook(readFile, path, signal)) as FileSystemPort["readFile"],
    writeFile: (path: string, content: string) => fs.writeFile(path, content),
    stat: (path: string) => fs.stat(path),
    exists: (path: string) => fs.exists(path),
    mkdir: (path: string) => fs.mkdir(path),
    readdir: (path: string) => fs.readdir(path),
  };
}

export function textStep(text: string): ModelStreamEvent[] {
  return [
    { type: "start" },
    { type: "text_delta", id: "t1", text },
    { type: "finish", finishReason: "stop", usage: {} },
  ];
}

export function toolStep(id: string, name: string, input: unknown): ModelStreamEvent[] {
  return [
    { type: "start" },
    { type: "tool_call", toolCall: { id, name, input } },
    { type: "finish", finishReason: "tool_calls", usage: {} },
  ];
}

export function finishStep(): ModelStreamEvent[] {
  return [{ type: "finish", finishReason: "stop", usage: {} }];
}
