/**
 * LspClient (slice 6.1 B2): the JSON-RPC state machine over one
 * PersistentChildHandle. Owns request/response correlation, the initialize /
 * initialized handshake, full-text document sync (didOpen / didChange), the
 * bounded wait for a diagnostics publish, and the polite shutdown → exit → kill
 * teardown.
 *

 * PersistentChildHandle. It imports nothing from adapters/ and never touches
 * child_process. `node:url` is used purely for file-URI encoding (no spawn).
 *

 * exit rejects in-flight requests and settles pending publish waiters as
 * "no result" rather than throwing into the caller.
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import { encodeMessage, FrameDecoder } from "./jsonrpc.js";
import type { PersistentChildHandle } from "../ports/execution.js";
import type { FileDiagnostic } from "../ports/lsp.js";

/** Canonical file URI for a local path (percent-encodes spaces/non-ASCII, normalizes Windows drives) via the Node URL round-trip that vscode-uri servers also use. */
export function pathToFileUri(filePath: string): string {
  return pathToFileURL(filePath).href;
}

/** Canonicalizes a file URI so our sent URI and a server's echoed URI compare equal regardless of encoding differences; non-file URIs pass through. */
export function normalizeUri(uri: string): string {
  if (uri.startsWith("file://")) {
    try {
      return pathToFileURL(fileURLToPath(uri)).href;
    } catch {
      return uri;
    }
  }
  return uri;
}

const SEVERITY_BY_CODE: Record<number, FileDiagnostic["severity"]> = {
  1: "error",
  2: "warning",
  3: "info",
  4: "hint",
};

/** Converts one raw LSP Diagnostic (0-based range) into a FileDiagnostic (1-based line/column). Defensive against missing fields. */
function toFileDiagnostic(raw: unknown): FileDiagnostic {
  const d = (raw ?? {}) as Record<string, unknown>;
  const range = (d.range ?? {}) as Record<string, unknown>;
  const start = (range.start ?? {}) as Record<string, unknown>;
  const severity =
    typeof d.severity === "number" ? SEVERITY_BY_CODE[d.severity] ?? "error" : "error";
  const result: FileDiagnostic = {
    severity,
    line: (typeof start.line === "number" ? start.line : 0) + 1,
    column: (typeof start.character === "number" ? start.character : 0) + 1,
    message: typeof d.message === "string" ? d.message : "",
  };
  if (d.code !== undefined && d.code !== null) result.code = String(d.code);
  if (typeof d.source === "string") result.source = d.source;
  return result;
}

/** A recorded publishDiagnostics for one URI, tagged with its arrival order (monotonic across all URIs) and the server-declared document version if present. */
interface PublishRecord {
  arrivalIndex: number;
  version: number | undefined;
  diagnostics: FileDiagnostic[];
}

/** Per-URI cap on retained publishes (small — only the tail matters for correlation). */
const PUBLISH_BUFFER_PER_URI = 8;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface LspClientConfig {
  /** Workspace root path; becomes rootUri / rootPath / the workspaceFolder in initialize. */
  rootPath: string;
  /* */
  processId: number;
  /** Optional initializationOptions passthrough from the server spec. */
  initializationOptions?: Record<string, unknown>;
  /** Fired once when a fatal framing/protocol error is detected (the owner marks the server crashed). */
  onProtocolError: (error: Error) => void;
}

/** Result of a document-sync notification: the arrival-clock snapshot and the version we announced (used to correlate the ensuing publish). */
export interface SyncSent {
  seq: number;
  version: number;
}

export interface WaitForPublishOptions {
  /** Only a publish with arrivalIndex > afterSeq counts (i.e. arrived after our send). */
  afterSeq: number;
  /* */
  preferVersion: number;
  /** Absolute wall-clock deadline (Date.now()-based). */
  deadline: number;
}

export class LspClient {
  private readonly decoder: FrameDecoder;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly openDocs = new Map<string, number>();
  private readonly publishBuffer = new Map<string, PublishRecord[]>();
  private readonly publishListeners = new Map<string, Set<(record: PublishRecord) => void>>();
  private readonly deathListeners = new Set<() => void>();
  private requestCounter = 0;
  private publishArrivalCounter = 0;
  private dead = false;

  constructor(
    private readonly handle: PersistentChildHandle,
    private readonly config: LspClientConfig,
  ) {
    this.decoder = new FrameDecoder(
      (message) => this.dispatch(message),
      (error) => {
        this.config.onProtocolError(error);
        this.fail(error);
      },
    );
  }

  /** Feeds raw stdout bytes into the frame decoder (wired to the handle's onStdout). */
  receive(chunk: Buffer): void {
    this.decoder.feed(chunk);
  }

  /** Wired to the handle's onExit: the server is gone, so reject in-flight work. */
  handleExit(): void {
    this.fail(new Error("LSP server process exited"));
  }

  /** True once the client is torn down (protocol error, exit, or explicit fail). */
  get isDead(): boolean {
    return this.dead;
  }

  isOpen(uri: string): boolean {
    return this.openDocs.has(normalizeUri(uri));
  }

  /**
   * initialize → initialized handshake, bounded by `deadline`. Returns true when
   * the server replied and we sent `initialized`; false on timeout, error, or a
   * dead connection. Never throws.
   */
  async initialize(deadline: number): Promise<boolean> {
    if (this.dead || this.handle.exited) return false;
    const rootUri = pathToFileUri(this.config.rootPath);
    const params: Record<string, unknown> = {
      processId: this.config.processId,
      rootPath: this.config.rootPath,
      rootUri,
      capabilities: {
        textDocument: {
          synchronization: { dynamicRegistration: false, didSave: false, willSave: false },
          publishDiagnostics: { relatedInformation: true, versionSupport: true },
        },
        workspace: { configuration: true, workspaceFolders: false },
      },
      workspaceFolders: [{ uri: rootUri, name: "workspace" }],
    };
    if (this.config.initializationOptions !== undefined) {
      params.initializationOptions = this.config.initializationOptions;
    }
    try {
      await this.sendRequest("initialize", params, deadline);
    } catch {
      return false;
    }
    if (this.dead) return false;
    this.sendNotification("initialized", {});
    return true;
  }

  /** Opens `uri` at version 1 with full text; returns the correlation seq/version. */
  didOpen(uri: string, languageId: string, text: string): SyncSent {
    const normUri = normalizeUri(uri);
    const version = 1;
    this.openDocs.set(normUri, version);
    const seq = this.publishArrivalCounter;
    this.sendNotification("textDocument/didOpen", {
      textDocument: { uri: normUri, languageId, version, text },
    });
    return { seq, version };
  }

  /* */
  didChange(uri: string, text: string): SyncSent {
    const normUri = normalizeUri(uri);
    const version = (this.openDocs.get(normUri) ?? 0) + 1;
    this.openDocs.set(normUri, version);
    const seq = this.publishArrivalCounter;
    this.sendNotification("textDocument/didChange", {
      textDocument: { uri: normUri, version },
      contentChanges: [{ text }],
    });
    return { seq, version };
  }

  /**
   * Resolves with the diagnostics of the first eligible publish for `uri` — one
   * arriving after our send (arrivalIndex > afterSeq) and, when the server
   * declares versions, matching (or exceeding) preferVersion. A stale-versioned
   * publish is held back for a better one until the deadline, then returned as a
   * best-effort fallback. Resolves null on silence (timeout) or a dead client.
   */
  waitForPublish(uri: string, opts: WaitForPublishOptions): Promise<FileDiagnostic[] | null> {
    const normUri = normalizeUri(uri);
    return new Promise<FileDiagnostic[] | null>((resolve) => {
      let settled = false;
      let bestStale: FileDiagnostic[] | null = null;
      let timer: NodeJS.Timeout | undefined;
      let listener: ((record: PublishRecord) => void) | undefined;
      let onDeath: (() => void) | undefined;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (listener) {
          const set = this.publishListeners.get(normUri);
          set?.delete(listener);
          if (set && set.size === 0) this.publishListeners.delete(normUri);
        }
        if (onDeath) this.deathListeners.delete(onDeath);
      };

      const finish = (value: FileDiagnostic[] | null) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };

      // Returns true when the record definitively resolves the wait.
      const consider = (record: PublishRecord): boolean => {
        if (record.arrivalIndex <= opts.afterSeq) return false;
        if (record.version === undefined || record.version >= opts.preferVersion) {
          finish(record.diagnostics);
          return true;
        }
        bestStale = record.diagnostics;
        return false;
      };

      if (this.dead) {
        finish(null);
        return;
      }

      for (const record of this.publishBuffer.get(normUri) ?? []) {
        if (consider(record)) return;
      }

      listener = (record) => {
        consider(record);
      };
      const set = this.publishListeners.get(normUri) ?? new Set();
      set.add(listener);
      this.publishListeners.set(normUri, set);

      onDeath = () => finish(bestStale);
      this.deathListeners.add(onDeath);

      const remaining = Math.max(0, opts.deadline - Date.now());
      timer = setTimeout(() => finish(bestStale), remaining);
    });
  }

  /**
   * Polite teardown: shutdown request (bounded by `graceDeadline`), then the
   * exit notification, then the handle kill path. Always resolves; the kill is
   * hard-bounded by the adapter so an unresponsive server never hangs the caller.
   */
  async shutdownAndExit(graceDeadline: number): Promise<void> {
    if (!this.dead && !this.handle.exited) {
      try {
        await this.sendRequest("shutdown", null, graceDeadline);
      } catch {
        // No shutdown reply within the grace window; fall through to exit + kill.
      }
      if (!this.handle.exited) this.sendNotification("exit", undefined);
    }
    await this.handle.kill();
    this.fail(new Error("LSP client shut down"));
  }

  /** Idempotently tears the client down: rejects in-flight requests and settles pending publish waiters. */
  fail(error?: Error): void {
    if (this.dead) return;
    this.dead = true;
    const err = error ?? new Error("LSP client disposed");
    for (const [, request] of this.pending) {
      clearTimeout(request.timer);
      request.reject(err);
    }
    this.pending.clear();
    for (const onDeath of [...this.deathListeners]) {
      onDeath();
    }
    this.deathListeners.clear();
  }

  // -------------------------------------------------------------------------

  private sendRequest(method: string, params: unknown, deadline: number): Promise<unknown> {
    if (this.dead || this.handle.exited) {
      return Promise.reject(new Error(`LSP client not live for request ${method}`));
    }
    const id = ++this.requestCounter;
    return new Promise<unknown>((resolve, reject) => {
      const remaining = Math.max(0, deadline - Date.now());
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request ${method} timed out`));
      }, remaining);
      this.pending.set(id, { resolve, reject, timer });
      const message: Record<string, unknown> = { jsonrpc: "2.0", id, method };
      if (params !== undefined) message.params = params;
      this.write(message);
    });
  }

  private sendNotification(method: string, params: unknown): void {
    const message: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (params !== undefined) message.params = params;
    this.write(message);
  }

  private write(message: unknown): void {
    if (this.dead) return;
    this.handle.write(encodeMessage(message));
  }

  private dispatch(message: unknown): void {
    if (!message || typeof message !== "object") return;
    const msg = message as Record<string, unknown>;
    const hasId = "id" in msg && msg.id !== null && msg.id !== undefined;
    const hasMethod = typeof msg.method === "string";
    if (hasId && hasMethod) {
      this.handleServerRequest(msg);
      return;
    }
    if (hasId) {
      this.handleResponse(msg);
      return;
    }
    if (hasMethod) {
      this.handleNotification(msg);
    }
  }

  /** Answers a server → client request: honest empty replies for window/* and workspace/configuration, MethodNotFound for everything else. */
  private handleServerRequest(msg: Record<string, unknown>): void {
    const id = msg.id as number | string;
    const method = msg.method as string;
    if (method === "workspace/configuration") {
      const params = msg.params as { items?: unknown[] } | undefined;
      const items = Array.isArray(params?.items) ? params!.items : [];
      this.write({ jsonrpc: "2.0", id, result: items.map(() => ({})) });
      return;
    }
    if (method.startsWith("window/")) {
      this.write({ jsonrpc: "2.0", id, result: null });
      return;
    }
    this.write({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `method not found: ${method}` },
    });
  }

  private handleResponse(msg: Record<string, unknown>): void {
    const id = msg.id as number;
    const request = this.pending.get(id);
    if (!request) return;
    this.pending.delete(id);
    clearTimeout(request.timer);
    if ("error" in msg && msg.error) {
      const error = msg.error as { message?: string };
      request.reject(new Error(error.message ?? "LSP error response"));
    } else {
      request.resolve(msg.result);
    }
  }

  private handleNotification(msg: Record<string, unknown>): void {
    if (msg.method !== "textDocument/publishDiagnostics") return;
    const params = (msg.params ?? {}) as Record<string, unknown>;
    if (typeof params.uri !== "string") return;
    const uri = normalizeUri(params.uri);
    const arrivalIndex = ++this.publishArrivalCounter;
    const version = typeof params.version === "number" ? params.version : undefined;
    const rawDiagnostics = Array.isArray(params.diagnostics) ? params.diagnostics : [];
    const record: PublishRecord = {
      arrivalIndex,
      version,
      diagnostics: rawDiagnostics.map(toFileDiagnostic),
    };
    this.recordPublish(uri, record);
  }

  private recordPublish(uri: string, record: PublishRecord): void {
    const listeners = this.publishListeners.get(uri);

    // transient buffer ONLY when the URI is currently open or actively awaited —
    // the sole reason to buffer is to catch a publish that races ahead of the
    // waitForPublish for a document we just edited (didOpen/didChange has already
    // set openDocs by the time that publish arrives). Diagnostics a server
    // volunteers for URIs we never opened and are not waiting on (project-wide
    // analysis, churn) are still delivered live to any listener but never
    // accumulate a buffer key. Thus the number of distinct publishBuffer keys is
    // bounded by the open/awaited docs, not by the count of URIs the server has
    // ever published. (Empty listener keys are already evicted in waitForPublish's
    // cleanup — the same eviction discipline, applied to the buffer.)
    if (this.openDocs.has(uri) || listeners) {
      let list = this.publishBuffer.get(uri);
      if (!list) {
        list = [];
        this.publishBuffer.set(uri, list);
      }
      list.push(record);
      if (list.length > PUBLISH_BUFFER_PER_URI) list.shift();
    }
    if (listeners) {
      for (const listener of [...listeners]) listener(record);
    }
  }

  /**
   * @internal Test-only view of how many distinct URIs currently hold a

   * open/awaited docs, not with the total URIs a server has ever published).
   */
  get publishBufferKeyCount(): number {
    return this.publishBuffer.size;
  }
}
