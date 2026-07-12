/**
 * LspPort: the diagnostics-after-edit surface. A configured language server
 * (spawned lazily via ExecutionPort.spawnPersistent) is asked, after a matching
 * Edit/Write, for the file's current diagnostics within a bounded wait. Fail-soft
 * by construction: no config / server crashed / timeout all yield an unavailable
 * outcome, never an exception, so the wrapped Edit/Write stays byte-identical to
 * today when anything goes wrong.
 */

export interface LspServerSpec {
  /** Unique key, e.g. "typescript". */
  name: string;
  /** Executable path or PATH-resolvable name; argv-spawned, never shell-interpreted. */
  command: string;
  args: string[];
  /** Dot-prefixed lowercase extensions this server owns (".ts", ".tsx"). First matching spec wins. */
  extensions: string[];
  /** LSP initializationOptions passthrough. */
  initializationOptions?: Record<string, unknown>;
}

export type LspServerState = "not_started" | "initializing" | "ready" | "crashed" | "disposed";

export interface LspServerStatus {
  name: string;
  state: LspServerState;
  pid?: number;
  extensions: string[];
  /** Capped tail of the server's stderr, for /lsp troubleshooting. */
  stderrTail: string;
}

export interface FileDiagnostic {
  severity: "error" | "warning" | "info" | "hint";
  /** 1-based. */
  line: number;
  /** 1-based. */
  column: number;
  message: string;
  code?: string;
  source?: string;
}

export type DiagnosticsOutcome =
  | { available: true; diagnostics: FileDiagnostic[] }
  | { available: false; reason: "no_server" | "initializing" | "timeout" | "server_failed" };

export interface LspPort {
  /**
   * Post-write hook: syncs `content` as the new full text of `filePath` to the
   * matching server (lazy-starting it on first touch) and awaits the server's
   * next diagnostics publish for that file, bounded by LSP_DIAGNOSTICS_TIMEOUT_MS.
   * Never throws; never blocks beyond the bound; fail-soft by construction.
   */
  diagnosticsAfterWrite(filePath: string, content: string): Promise<DiagnosticsOutcome>;
  status(): LspServerStatus[];
  /** Polite shutdown (shutdown/exit, LSP_SHUTDOWN_GRACE_MS) then the kill path, every server; bounded by LSP_DISPOSE_DEADLINE_MS overall. */
  disposeAll(): Promise<void>;
}
