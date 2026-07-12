/**
 * Control- and data-plane contract for the per-tab PTY terminal (design
 * slice-2.4-cut.md §3.1), frozen by task 2.4.1. The terminal lives entirely on a
 * SECOND, dedicated MessageChannel per tab (renderer <-> host), disjoint from the
 * frozen agent data plane (shared/protocol.ts is NOT amended). main creates and
 * hands out that channel in `deliverTabPort()` alongside the existing UI channel;
 * the host opens the PTY master lazily inside its own process on the first

 * stays tab-agnostic, so no tabId travels on the data plane.
 *
 * VALUE-ONLY module with ZERO imports, by the exact precedent of shared/tabs.ts,

 * by preload (sandboxed CJS), the renderer web bundle, the host (utilityProcess)
 * AND main, so it must never drag zod or the @anycode/core barrel into a bundle
 * that cannot afford it. The zod schemas that validate incoming `TermToHostMessage`
 * shapes live in host/terminal.ts (a task-2.4.3 file, host-only), NOT here — same
 * reasoning that keeps runtime schemas out of shared/protocol.ts's type surface.
 *
 * Nothing consumes these types yet; they are declared now so the whole 2.4 wave
 * (main delivery = 2.4.2, host TerminalManager = 2.4.3, renderer xterm = 2.4.4)
 * can build against a frozen contract.
 */

// ── control plane ──

/** main->host parentPort message type carrying the term-port (event.ports[0]). */
export const TERMINAL_INIT_MESSAGE_TYPE = "anycode:terminal-init";

/**
 * main->preload->page envelope type for the term-port
 * (webContents.postMessage / window.postMessage). Mirrors the UI PORT_ENVELOPE
 * pattern: contextBridge cannot transfer a MessagePort, so preload forwards it
 * via window.postMessage (§3.4).
 */
export const TERMINAL_PORT_ENVELOPE_TYPE = "anycode:terminal-port";

/**
 * The renderer-facing envelope that delivers a tab's term-port. `tabId` is the
 * routing key; no workspace is needed — the tab is already known to the renderer
 * (its UI port arrived as a pair), so the term-port only has to name the tab.
 */
export interface TerminalPortEnvelope {
  type: typeof TERMINAL_PORT_ENVELOPE_TYPE;
  tabId: string;
}

// ── data plane (over the term-channel; strings are utf-8, structured-clone-safe) ──

/**
 * renderer -> host over the term-port.
 *  - `term_open`  : spawn a shell OR reattach to a live one (idempotent).
 *  - `term_input` : keystrokes / pasted bytes written to the pty.
 *  - `term_resize`: viewport change (xterm fit-addon).
 *  - `term_kill`  : explicit shell teardown requested by the user.
 */
export type TermToHostMessage =
  | { type: "term_open"; cols: number; rows: number }
  | { type: "term_input"; data: string }
  | { type: "term_resize"; cols: number; rows: number }
  | { type: "term_kill" };

/**
 * host -> renderer over the term-port.
 *  - `term_opened`: reply to `term_open`; `reattached` distinguishes a live-shell
 *    reattach (with `replay` = tail of the host ring-buffer) from a fresh spawn
 *    (`reattached:false`, `replay:""`).
 *  - `term_data`  : pty output bytes.
 *  - `term_exited`: pty exited (self-exit, `term_kill`, or shell death); a later
 *    `term_open` spawns a new shell.
 *  - `term_error` : spawn / native-import failure — fail-soft, the host stays up.
 */
export type TermToUiMessage =
  | { type: "term_opened"; reattached: boolean; replay: string }
  | { type: "term_data"; data: string }
  | { type: "term_exited"; exitCode: number; signal?: number }
  | { type: "term_error"; message: string };

// ── constants ──

/** Host-side ring-buffer cap for pty output, replayed on reattach/reload. */
export const TERM_REPLAY_MAX_BYTES = 256 * 1024;

/** Default terminal geometry until the first fit-addon resize arrives. */
export const TERM_DEFAULT_COLS = 80;
export const TERM_DEFAULT_ROWS = 24;

/** pty `name` and the `TERM` env var handed to the shell. */
export const TERM_NAME = "xterm-256color";
