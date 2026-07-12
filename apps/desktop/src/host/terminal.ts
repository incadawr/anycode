/**
 * Host-side per-tab PTY terminal manager (design slice-2.4-cut.md §1/§3.3, task
 * 2.4.3). Owns ONE shell subprocess for the tab and bridges it to the renderer
 * over the dedicated term-channel (the second MessageChannel per tab, disjoint
 * from the frozen agent data plane — shared/protocol.ts is untouched). The
 * channel is the routing key; no tabId ever crosses this boundary, so the host
 * stays tab-agnostic (§1).
 *
 * Lifecycle & invariants:
 *  - LAZY native backend: node-pty is `await import`-ed on the FIRST `term_open`,
 *    never at module scope (§2.7). A broken native module (wrong platform, lost
 *    chmod on spawn-helper) degrades this ONE terminal to a `term_error` — the
 *    host process, and every agent function of the tab, stay alive.
 *  - SECRET-scrub invariant (§1 test-criterion 2.4.3): the shell spawns with the
 *    host's live post-scrub `process.env`. `boot()`'s `finally` already deleted
 *    SECRET_ENV_KEYS (ANYCODE_API_KEY) before `ready` resolved, and the
 *    term-port is only bound after `ready` (index.ts), so by the time any
 *    `term_open` can arrive the key is gone — the shell can never see it. The
 *    env is read at spawn time (not snapshotted at construction) precisely so it
 *    always reflects the post-scrub state.
 *  - Ring buffer: pty output is retained up to TERM_REPLAY_MAX_BYTES (256 KiB),
 *    trimmed from the HEAD by bytes, and replayed on a reattach so a renderer

 *    accepted, xterm tolerates a truncated ESC head).
 *  - `dispose()` is SYNCHRONOUS (SIGHUP via pty.kill): it is called from the
 *    host shutdown path BEFORE session teardown and must not grow the 2 s
 *    graceful-stop deadline (§3.3), so it awaits nothing.
 *  - Incoming `TermToHostMessage` is zod-validated HERE (host-only; shared/

 *    with a warn — never crashes the manager.
 *  - The agent (LLM) has NO access to this manager: it is a pure user surface,

 */

import { z } from "zod";
import type { WirePort } from "../shared/protocol.js";
import { TERM_NAME, TERM_REPLAY_MAX_BYTES, type TermToUiMessage } from "../shared/terminal.js";
import { describeError } from "./serialize.js";

// ── injectable pty seam (real node-pty in prod; a fake in unit tests) ──

/** Structural subset of node-pty's IDisposable returned by onData/onExit. */
interface PtyDisposable {
  dispose(): void;
}

/**
 * Structural subset of node-pty's `IPty` the manager depends on. A local
 * interface (not a node-pty type import) keeps the fake trivial and the manager
 * decoupled from the native module's exact surface; the real `IPty` returned by
 * `pty.spawn` is structurally assignable to it (see `defaultLoadPty`).
 */
export interface PtyLike {
  readonly pid: number;
  onData(listener: (data: string) => void): PtyDisposable;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): PtyDisposable;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

/** Everything a spawn needs; `env` is read at spawn time so it is always post-scrub. */
export interface PtySpawnConfig {
  file: string;
  args: string[];
  cols: number;
  rows: number;
  cwd: string;
  env: NodeJS.ProcessEnv;
  name: string;
}

/** Spawns one pty. Injected in tests; the default wraps `node-pty`'s `spawn`. */
export type PtySpawner = (config: PtySpawnConfig) => PtyLike;

/**
 * Lazily resolves a `PtySpawner`. The default performs the dynamic
 * `import("node-pty")` so a native-load failure surfaces as a rejected promise
 * (→ `term_error`) instead of a top-level import crash. Injected in unit tests
 * to avoid a real shell; a rejecting loader models the broken-native-module path.
 */
export type LoadPty = () => Promise<PtySpawner>;

const defaultLoadPty: LoadPty = async () => {
  const pty = await import("node-pty");
  return (config: PtySpawnConfig): PtyLike =>
    pty.spawn(config.file, config.args, {
      name: config.name,
      cols: config.cols,
      rows: config.rows,
      cwd: config.cwd,
      env: config.env,
    });
};

/** Resolved shell command + args (v1 default per §7-U1). */
export interface ShellSpec {
  file: string;
  args: string[];
}

/**
 * Default interactive shell (design §7-U1): `$SHELL` when set, else `/bin/zsh`
 * on darwin / `/bin/bash` elsewhere / `%COMSPEC%`||`cmd.exe` on win32. `-l`
 * (login) is passed on darwin only — a GUI-launched app otherwise inherits a
 * bare PATH. Injectable env/platform for tests.
 */
export function resolveDefaultShell(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): ShellSpec {
  if (platform === "win32") {
    return { file: env.COMSPEC ?? "cmd.exe", args: [] };
  }
  const shell = env.SHELL;
  const file = shell !== undefined && shell.trim() !== "" ? shell : platform === "darwin" ? "/bin/zsh" : "/bin/bash";
  const args = platform === "darwin" ? ["-l"] : [];
  return { file, args };
}



const termOpenSchema = z
  .object({ type: z.literal("term_open"), cols: z.number().int().positive(), rows: z.number().int().positive() })
  .strict();
const termInputSchema = z.object({ type: z.literal("term_input"), data: z.string() }).strict();
const termResizeSchema = z
  .object({ type: z.literal("term_resize"), cols: z.number().int().positive(), rows: z.number().int().positive() })
  .strict();
const termKillSchema = z.object({ type: z.literal("term_kill") }).strict();

/** Discriminated union validating any inbound TermToHostMessage; junk fails closed. */
export const termToHostMessageSchema = z.discriminatedUnion("type", [
  termOpenSchema,
  termInputSchema,
  termResizeSchema,
  termKillSchema,
]);

export interface TerminalManagerOptions {
  /** Shell cwd — the tab's workspace (host `process.cwd()`). */
  workspace: string;
  /**
   * Env handed to the shell. Omit in production so the LIVE post-scrub
   * `process.env` is read at spawn time (secret-scrub invariant); tests inject a
   * fixed env.
   */
  env?: NodeJS.ProcessEnv;
  /** pty-backend loader; defaults to the lazy `import("node-pty")`. */
  loadPty?: LoadPty;
  /** Shell resolver; defaults to `resolveDefaultShell()`. */
  resolveShell?: () => ShellSpec;
}

/**

 * lazily-spawned pty: open/reattach/input/resize/kill in, data/opened/exited/
 * error out.
 */
export class TerminalManager {
  private readonly workspace: string;
  private readonly injectedEnv: NodeJS.ProcessEnv | undefined;
  private readonly loadPty: LoadPty;
  private readonly resolveShell: () => ShellSpec;

  private port: WirePort | null = null;
  private pty: PtyLike | null = null;
  private dataSub: PtyDisposable | null = null;
  private exitSub: PtyDisposable | null = null;
  /** True while a spawn is in flight (an async import) — dedupes concurrent opens. */
  private opening = false;
  private disposed = false;

  /** Output ring buffer (utf-8 bytes) capped at TERM_REPLAY_MAX_BYTES, head-trimmed. */
  private ringChunks: Buffer[] = [];
  private ringBytes = 0;

  constructor(options: TerminalManagerOptions) {
    this.workspace = options.workspace;
    this.injectedEnv = options.env;
    this.loadPty = options.loadPty ?? defaultLoadPty;
    this.resolveShell = options.resolveShell ?? (() => resolveDefaultShell());
  }

  /**
   * Binds (or re-binds on renderer reload / respawn redelivery) the term-channel.
   * The pty is NOT touched — a reattach after reload replays the ring tail, which
   * is the whole reason the shell lives in the host. `onClose` only clears the
   * port when it is still the current one (a redelivery may install a new port
   * before the old one's close fires).
   */
  bindPort(port: WirePort): void {
    this.port = port;
    port.onMessage((raw) => {
      this.handleMessage(raw);
    });
    port.onClose(() => {
      if (this.port === port) {
        this.port = null;
      }
    });
  }

  /**
   * SYNCHRONOUS teardown for the host shutdown path (§3.3): dispose the pty
   * listeners first (so no late `term_data`/`term_exited` is posted), then SIGHUP
   * the shell. Awaits nothing — must not extend the 2 s graceful-stop deadline.
   */
  dispose(): void {
    this.disposed = true;
    this.teardownPty();
  }

  private handleMessage(raw: unknown): void {
    const parsed = termToHostMessageSchema.safeParse(raw);
    if (!parsed.success) {
      console.warn("[host] dropped invalid terminal message:", parsed.error.issues);
      return;
    }
    const message = parsed.data;
    switch (message.type) {
      case "term_open":
        void this.open(message.cols, message.rows);
        break;
      case "term_input":
        this.input(message.data);
        break;
      case "term_resize":
        this.resize(message.cols, message.rows);
        break;
      case "term_kill":
        this.killShell();
        break;
    }
  }

  private async open(cols: number, rows: number): Promise<void> {
    // Live shell → idempotent reattach: resize to the new geometry and replay
    // the ring tail. No respawn, buffer preserved (contract §3.1).
    if (this.pty) {
      this.safeResize(this.pty, cols, rows);
      this.post({ type: "term_opened", reattached: true, replay: this.ringReplay() });
      return;
    }
    if (this.opening) {
      // A spawn is already awaiting its native import; drop the duplicate open.
      return;
    }
    this.opening = true;

    let spawner: PtySpawner;
    try {
      spawner = await this.loadPty();
    } catch (error) {
      this.opening = false;
      // Fail-soft (§2.7): a broken native module degrades THIS terminal only.
      this.post({ type: "term_error", message: `failed to load terminal backend: ${describeError(error)}` });
      return;
    }
    if (this.disposed) {
      // Shutdown raced the import; abandon the spawn.
      this.opening = false;
      return;
    }

    let pty: PtyLike;
    try {
      const shell = this.resolveShell();
      pty = spawner({
        file: shell.file,
        args: shell.args,
        cols,
        rows,
        cwd: this.workspace,
        // Read at spawn time so it is the LIVE post-scrub process.env in prod.
        env: this.injectedEnv ?? process.env,
        name: TERM_NAME,
      });
    } catch (error) {
      this.opening = false;
      this.post({ type: "term_error", message: `failed to spawn shell: ${describeError(error)}` });
      return;
    }

    // Fresh shell → fresh ring (a prior dead shell's tail is not replayed).
    this.ringChunks = [];
    this.ringBytes = 0;
    this.pty = pty;
    this.dataSub = pty.onData((data) => {
      this.appendRing(data);
      this.post({ type: "term_data", data });
    });
    this.exitSub = pty.onExit((event) => {
      this.onPtyExit(event.exitCode, event.signal);
    });
    this.opening = false;
    this.post({ type: "term_opened", reattached: false, replay: "" });
  }

  private input(data: string): void {
    if (!this.pty) {
      console.warn("[host] term_input dropped: no live shell");
      return;
    }
    try {
      this.pty.write(data);
    } catch (error) {
      console.warn("[host] term_input write failed:", describeError(error));
    }
  }

  private resize(cols: number, rows: number): void {
    if (!this.pty) {
      console.warn("[host] term_resize dropped: no live shell");
      return;
    }
    this.safeResize(this.pty, cols, rows);
  }

  /** Explicit user teardown (`term_kill`): SIGHUP; `onExit` emits `term_exited`. */
  private killShell(): void {
    if (!this.pty) {
      console.warn("[host] term_kill dropped: no live shell");
      return;
    }
    try {
      this.pty.kill();
    } catch (error) {
      console.warn("[host] term_kill failed:", describeError(error));
    }
  }

  private onPtyExit(exitCode: number, signal?: number): void {
    this.teardownPty();
    this.post(
      signal !== undefined
        ? { type: "term_exited", exitCode, signal }
        : { type: "term_exited", exitCode },
    );
  }

  /** Disposes pty listeners and SIGHUPs the shell; leaves the ring for inspection. */
  private teardownPty(): void {
    if (this.dataSub) {
      this.dataSub.dispose();
      this.dataSub = null;
    }
    if (this.exitSub) {
      this.exitSub.dispose();
      this.exitSub = null;
    }
    const pty = this.pty;
    this.pty = null;
    if (pty) {
      try {
        pty.kill();
      } catch {
        // Best-effort: the shell may already be dead (e.g. onExit path).
      }
    }
  }

  private safeResize(pty: PtyLike, cols: number, rows: number): void {
    try {
      pty.resize(cols, rows);
    } catch (error) {
      console.warn("[host] term_resize failed:", describeError(error));
    }
  }

  private appendRing(data: string): void {
    const buf = Buffer.from(data, "utf8");
    this.ringChunks.push(buf);
    this.ringBytes += buf.length;
    // Trim from the HEAD until within the byte cap; the oldest chunk may be
    // partially sliced so the retained window is exactly TERM_REPLAY_MAX_BYTES.
    while (this.ringBytes > TERM_REPLAY_MAX_BYTES && this.ringChunks.length > 0) {
      const oldest = this.ringChunks[0]!;
      const overBy = this.ringBytes - TERM_REPLAY_MAX_BYTES;
      if (oldest.length <= overBy) {
        this.ringChunks.shift();
        this.ringBytes -= oldest.length;
      } else {
        this.ringChunks[0] = oldest.subarray(overBy);
        this.ringBytes -= overBy;
      }
    }
  }

  private ringReplay(): string {
    return Buffer.concat(this.ringChunks, this.ringBytes).toString("utf8");
  }

  private post(message: TermToUiMessage): void {
    this.port?.post(message);
  }
}
