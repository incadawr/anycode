/**
 * Shared test harness for the host protocol server. Not a test file itself; it
 * wires the REAL core (AgentLoop + dispatcher + ModePermissionEngine +
 * InMemoryHookRunner + snapshot hook + IpcPermissionBroker) against a scripted
 * ModelPort and an in-memory FileSystemPort, over a real worker_threads

 * agnostic WirePort so no Electron is needed).
 */

import { MessageChannel, type MessagePort as NodeMessagePort } from "node:worker_threads";
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
  TelemetryStatus,
} from "@anycode/core";
import type { HostToUiMessage, UiToHostMessage, WireEnvStatus, WirePort } from "../shared/protocol.js";
import type { GitUiBridge } from "./git-bridge.js";
import { IpcPermissionBroker } from "./permission-broker.js";
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
  mode?: PermissionMode;
  /** Backing store for the tool handlers AND the session "after" snapshot. */
  toolFs?: FileSystemPort;
  /** fs the "before" snapshot hook reads (defaults to toolFs). */
  snapshotFs?: FileSystemPort;
  brokerTimeoutMs?: number;
  /** Boot history snapshot for transcript hydration (design §3.3); empty by default. */
  bootHistory?: readonly HistoryItem[];
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
  /** Multimodal send-path capability gate; defaults to enabled for legacy tests. */
  imageInputEnabled?: boolean;
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
  const hooks = new InMemoryHookRunner();
  hooks.register(createSnapshotHook(snapshotFs, emit));
  const broker = new IpcPermissionBroker(emit, options.brokerTimeoutMs);
  const rules = options.rules ?? new SessionPermissionRules();
  const media: MediaCapabilityPort = {
    imageInputEnabled: () => options.imageInputEnabled ?? true,
  };

  const config: AgentLoopConfig = {
    modelPort: new ScriptedModelPort(options.steps),
    registry,
    hooks,
    permissionEngine: new RuleAwarePermissionEngine(new ModePermissionEngine(), rules),
    permissionBroker: broker,
    mode: options.mode ?? "build",
    ports: {
      fs: toolFs,
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
  };
  const loop = new AgentLoop(config);
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
    model: "scripted-model",
    sessionId: "test-session",
    bootHistory: options.bootHistory,
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
    imageInputEnabled: media.imageInputEnabled,
    ...(options.reasoningSupported !== undefined ? { reasoningSupported: options.reasoningSupported } : {}),
    ...(options.availableEffortLevels !== undefined ? { availableEffortLevels: options.availableEffortLevels } : {}),
    ...(options.selectedEffort !== undefined ? { selectedEffort: options.selectedEffort } : {}),
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
