/**
 * LspManager (slice 6.1 B3): the LspPort implementation. Owns the per-server

 * the state machine (not_started → initializing → ready → crashed | disposed),
 * the extension → server match, the stderr ring, and the bounded post-write
 * diagnostics wait. Every server is spawned ONLY through
 * ExecutionPort.spawnPersistent; this module imports nothing from adapters/ and

 *

 * no_server; a still-initializing server that overruns the edit budget →
 * initializing; a crashed/protocol-broken server → server_failed; a ready
 * server that stays silent → timeout. Never throws.
 */

import { extname } from "node:path";
import { LspClient, pathToFileUri } from "./client.js";
import type { ExecutionPort, PersistentChildHandle } from "../ports/execution.js";
import type {
  DiagnosticsOutcome,
  LspPort,
  LspServerSpec,
  LspServerState,
  LspServerStatus,
} from "../ports/lsp.js";
import {
  LSP_DIAGNOSTICS_TIMEOUT_MS,
  LSP_DISPOSE_DEADLINE_MS,
  LSP_INIT_TIMEOUT_MS,
  LSP_MAX_SERVERS,
  LSP_SHUTDOWN_GRACE_MS,
  LSP_STDERR_TAIL_BYTES,
} from "../types/config.js";

/** Extension → LSP languageId. Fallback "plaintext" for anything unmapped. */
const EXT_LANGUAGE_IDS: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascriptreact",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".json": "json",
  ".jsonc": "jsonc",
  ".css": "css",
  ".scss": "scss",
  ".less": "less",
  ".html": "html",
  ".htm": "html",
  ".md": "markdown",
  ".markdown": "markdown",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".vue": "vue",
  ".svelte": "svelte",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".hpp": "cpp",
  ".java": "java",
  ".rb": "ruby",
  ".php": "php",
  ".sh": "shellscript",
};

interface ServerRecord {
  spec: LspServerSpec;
  state: LspServerState;
  handle?: PersistentChildHandle;
  client?: LspClient;
  pid?: number;
  stderrTail: string;
  /** Resolves true once initialize completes (state → ready); false on any failure. Always resolves, never rejects. */
  initPromise?: Promise<boolean>;
}

export class LspManager implements LspPort {
  private readonly records: ServerRecord[];

  /** Set while a coalesced status-change notify is queued for the next microtask. */
  private notifyScheduled = false;

  /**
   * Optional live-status listener (slice P7.25/F3): invoked once per microtask
   * burst after any server STATE transition (initializing/ready/crashed/
   * disposed). Additive + optional so CLI/tests and every other caller stay
   * untouched. stderrTail appends are NOT transitions and do not notify.
   */
  constructor(
    private readonly exec: ExecutionPort,
    specs: LspServerSpec[],
    private readonly workspaceCwd: string,
    private readonly onStatusChange?: () => void,
  ) {
    this.records = specs.slice(0, LSP_MAX_SERVERS).map((spec) => ({
      spec,
      state: "not_started" as LspServerState,
      stderrTail: "",
    }));
  }

  /**
   * Coalesced, fail-soft status-change notify. Many synchronous transitions in
   * one tick (e.g. disposeAll marking N records) collapse into a SINGLE listener
   * call on the next microtask — the listener re-reads the full snapshot via
   * status(), so one fire per burst is sufficient. A throwing listener is

   */
  private notifyStatusChange(): void {
    if (this.onStatusChange === undefined || this.notifyScheduled) return;
    this.notifyScheduled = true;
    queueMicrotask(() => {
      this.notifyScheduled = false;
      try {
        // The listener is typed () => void, but a runtime async listener
        // returns a rejected promise on throw — a bare try/catch only ever
        // sees a SYNCHRONOUS throw, so a rejection would otherwise escape as
        // an unhandled rejection. Swallow it the same way the sync branch is

        const result = this.onStatusChange?.() as unknown;
        if (result && typeof (result as { then?: unknown }).then === "function") {
          (result as Promise<unknown>).then(undefined, () => {
            // Fail-soft: an async listener rejection must never surface.
          });
        }
      } catch {
        // Fail-soft: a listener error must never propagate into manager logic.
      }
    });
  }

  async diagnosticsAfterWrite(filePath: string, content: string): Promise<DiagnosticsOutcome> {
    const overallDeadline = Date.now() + LSP_DIAGNOSTICS_TIMEOUT_MS;

    const record = this.matchServer(filePath);
    if (!record) return { available: false, reason: "no_server" };
    if (!this.exec.spawnPersistent) return { available: false, reason: "no_server" };

    if (record.state === "crashed" || record.state === "disposed") {
      return { available: false, reason: "server_failed" };
    }

    if (record.state === "not_started") {
      this.spawnServer(record);
    }

    if (record.state === "initializing") {
      const ready = await this.awaitInitWithin(record, overallDeadline);
      if (!ready) {
        // Re-read via stateOf: init runs across the await and may have mutated
        // record.state (crash), which the compiler's narrowing cannot see.
        return this.stateOf(record) === "crashed"
          ? { available: false, reason: "server_failed" }
          : { available: false, reason: "initializing" };
      }
    }

    if (this.stateOf(record) !== "ready" || !record.client) {
      return this.stateOf(record) === "crashed"
        ? { available: false, reason: "server_failed" }
        : { available: false, reason: "initializing" };
    }

    const client = record.client;
    const uri = pathToFileUri(filePath);
    const languageId = EXT_LANGUAGE_IDS[extname(filePath).toLowerCase()] ?? "plaintext";
    const sent = client.isOpen(uri)
      ? client.didChange(uri, content)
      : client.didOpen(uri, languageId, content);

    const diagnostics = await client.waitForPublish(uri, {
      afterSeq: sent.seq,
      preferVersion: sent.version,
      deadline: overallDeadline,
    });
    if (diagnostics === null) return { available: false, reason: "timeout" };
    return { available: true, diagnostics };
  }

  status(): LspServerStatus[] {
    return this.records.map((record) => ({
      name: record.spec.name,
      state: record.state,
      ...(record.pid !== undefined ? { pid: record.pid } : {}),
      extensions: record.spec.extensions,
      stderrTail: record.stderrTail,
    }));
  }

  async disposeAll(): Promise<void> {
    const live = this.records.filter(
      (record) =>
        (record.state === "initializing" || record.state === "ready") &&
        record.client &&
        record.handle &&
        !record.handle.exited,
    );
    // Mark disposed up front so the ensuing exit events do not flip to crashed.
    // The per-record notify calls collapse into ONE microtask fire (coalesced),
    // so a many-server dispose never fans out N listener calls.
    for (const record of this.records) {
      if (record.state === "initializing" || record.state === "ready" || record.state === "not_started") {
        record.state = "disposed";
        this.notifyStatusChange();
      }
    }
    if (live.length === 0) return;

    const graceDeadline = Date.now() + LSP_SHUTDOWN_GRACE_MS;
    const shutdowns = live.map((record) => record.client!.shutdownAndExit(graceDeadline));

    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, LSP_DISPOSE_DEADLINE_MS);
    });
    await Promise.race([Promise.allSettled(shutdowns).then(() => undefined), deadline]);
    if (timer) clearTimeout(timer);
  }

  // -------------------------------------------------------------------------

  /** Reads record.state through a method boundary so callers after an await are not held to a stale narrowing of the mutable field. */
  private stateOf(record: ServerRecord): LspServerState {
    return record.state;
  }

  private matchServer(filePath: string): ServerRecord | undefined {
    const ext = extname(filePath).toLowerCase();
    if (!ext) return undefined;
    return this.records.find((record) => record.spec.extensions.includes(ext));
  }

  private spawnServer(record: ServerRecord): void {
    const spawnPersistent = this.exec.spawnPersistent;
    if (!spawnPersistent) return;
    record.state = "initializing";
    this.notifyStatusChange();

    let client: LspClient | undefined;
    const handle = spawnPersistent({
      file: record.spec.command,
      args: record.spec.args,
      cwd: this.workspaceCwd,
      onStdout: (chunk) => client?.receive(chunk),
      onStderr: (text) => this.appendStderr(record, text),
      onExit: () => this.handleServerExit(record),
    });
    record.handle = handle;
    record.pid = handle.pid;

    client = new LspClient(handle, {
      rootPath: this.workspaceCwd,
      processId: process.pid,
      ...(record.spec.initializationOptions !== undefined
        ? { initializationOptions: record.spec.initializationOptions }
        : {}),
      onProtocolError: (error) => this.handleProtocolError(record, error),
    });
    record.client = client;

    const initDeadline = Date.now() + LSP_INIT_TIMEOUT_MS;
    record.initPromise = client.initialize(initDeadline).then(
      (ok) => {
        if (record.state === "disposed" || record.state === "crashed") return false;
        if (ok) {
          record.state = "ready";
          this.notifyStatusChange();
          return true;
        }
        this.markCrashed(record);
        return false;
      },
      () => {
        this.markCrashed(record);
        return false;
      },
    );
  }

  /** Awaits init but no longer than the edit's overall budget; resolves false on budget expiry (still initializing) or failure. */
  private awaitInitWithin(record: ServerRecord, overallDeadline: number): Promise<boolean> {
    const initPromise = record.initPromise;
    if (!initPromise) return Promise.resolve(record.state === "ready");
    const remaining = Math.max(0, overallDeadline - Date.now());
    return new Promise<boolean>((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        resolve(false);
      }, remaining);
      initPromise.then(
        (ready) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(ready);
        },
        () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(false);
        },
      );
    });
  }

  private handleServerExit(record: ServerRecord): void {
    if (record.state === "disposed") {
      record.client?.fail();
      return;
    }
    this.markCrashed(record);
  }

  private handleProtocolError(record: ServerRecord, error: Error): void {
    this.appendStderr(record, `\n[protocol-error] ${error.message}\n`);
    if (record.state === "disposed") return;
    this.markCrashed(record);
  }

  /* */
  private markCrashed(record: ServerRecord): void {
    if (record.state === "crashed" || record.state === "disposed") {
      record.client?.fail();
      return;
    }
    record.state = "crashed";
    this.notifyStatusChange();
    record.client?.fail();
    void record.handle?.kill();
  }

  private appendStderr(record: ServerRecord, text: string): void {
    const combined = Buffer.from(record.stderrTail + text, "utf-8");
    record.stderrTail =
      combined.length > LSP_STDERR_TAIL_BYTES
        ? combined.subarray(combined.length - LSP_STDERR_TAIL_BYTES).toString("utf-8")
        : combined.toString("utf-8");
  }
}
