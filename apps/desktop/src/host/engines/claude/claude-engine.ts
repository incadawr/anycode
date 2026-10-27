/**
 * The native Claude Code session runtime (cut §1.4). Like the Codex engine it
 * composes none of AnyCode's AgentLoop or tools: the `claude` CLI owns those
 * policies, and this class only drives its turn lifecycle and projects its
 * stream through event-translator.ts.
 *
 * Turn lifecycle — the invariants that make Stop safe here:
 *
 *  1. ONE abort promise is raced into EVERY await of the turn, so a Stop that
 *     lands while the notification iterator is parked is observed immediately
 *     (a `signal.aborted` poll between awaits never fires while idle — the
 *     defect this shape exists to prevent).
 *  2. `interrupt` is latched per turn. The CLI answers it with a receipt
 *     (`{still_queued:[]}` when it lands before dispatch, `w0-03-interrupt-early`)
 *     and then terminates the turn with `result{terminal_reason:"aborted_streaming"}`,
 *     which the translator maps to `loop_end:"cancelled"`.
 *  3. A Stop while an approval is PARKED needs no cancel bookkeeping from us:
 *     the CLI withdraws its own `can_use_tool` via `control_cancel_request`
 *     (`w0-03-interrupt-pending`), and ClaudeClient's pairing rule turns our
 *     late answer into a no-op. We only settle the broker so the modal closes.
 *
 * The context meter is pulled from `get_context_usage` (TASK.157) at TWO
 * points: throttled (>= 30s apart, first immediately eligible) SILENT
 * refreshes at user/tool-result and assistant boundaries during a running
 * turn — never overlapping, never failing the turn — and once more AFTER the
 * terminal `result` ($0), unconditionally — never summed out of
 * `result.usage` (cut §0.3-5). The codex C-bug-1 lesson is that a plausible
 * self-made meter is worse than none: the model's context window is a fact
 * the CLI knows and we do not.
 */

import { randomUUID } from "node:crypto";
import type { AgentEvent, HistoryItem, ImageAttachment, PermissionMode, ReasoningEffort, ToolResultPresentation } from "@anycode/core";
import { CLAUDE_POST_INTERRUPT_SETTLE_MS } from "../../../shared/claude-timeouts.js";
import type { EngineModelChoice, EnginePermissionPreset } from "../../../shared/protocol.js";
import type { EngineBootstrap } from "../bootstrap.js";
import type { EngineCapabilities, RunTurnOptions, SessionEngine } from "../session-engine.js";
import type { EngineBridgeBroker } from "../../permission-broker.js";
import { classifyEngineFailure } from "../../safe-failure.js";
import { ClaudeApprovalBridge } from "./approval-bridge.js";
import { ClaudeClient, ClaudeClientError, type ClaudeClientOptions } from "./claude-client.js";
import { ClaudeTurnTranslator } from "./event-translator.js";
import type { ClaudeMcpBridge } from "./mcp-bridge.js";
import { ClaudeModelCatalog, isClaudeEffortLevel } from "./models.js";
import {
  permissionModeToFlag,
  type ClaudeResultMessage,
  type ClaudeStreamMessage,
  type ClaudeSystemInitMessage,
  type PermissionMode as ClaudeWirePermissionMode,
} from "./protocol.js";
import {
  CLAUDE_PERMISSION_PRESETS,
  DEFAULT_CLAUDE_PRESET,
  claudePresetChoices,
  findClaudePreset,
  findClaudePresetByMode,
  type ClaudePermissionPresetDefinition,
} from "./presets.js";
import { decodeClaudeUsage, quotaNotice, type ClaudeQuotaSnapshot } from "./quota.js";

export const CLAUDE_NOT_SIGNED_IN =
  "Claude Code is not signed in — run `claude auth login` in a terminal, then start a new Claude session.";

// Mirrors `isClaudeSignedIn` in main/claude-doctor.ts (host cannot import across
// the main/** boundary). A signed-in subscription profile's `initialize` response
// omits `tokenSource` entirely (live handshake, binary 2.1.215) — the fallback to
// `subscriptionType` is what distinguishes that case from a genuinely signed-out one.
function isClaudeSignedIn(account: { tokenSource?: string; subscriptionType?: string }): boolean {
  if (typeof account.tokenSource === "string") return account.tokenSource !== "none";
  return account.subscriptionType !== undefined;
}

export const CLAUDE_ENGINE_CAPABILITIES: EngineCapabilities = {
  supportsCorePermissions: false,
  supportsRewind: false,
  supportsWorkflow: false,
  supportsGitMutations: false,
  // Real provider-fed usage from `get_context_usage` (cut §4). The codex
  // C-bug-1 lesson is baked in: flag, gate, and live path are asserted together.
  supportsContextUsage: true,
  // A SCOPE decision, not missing data: `get_context_usage.categories[]` does
  // carry a 7-category breakdown live; mapping it onto core's ContextBreakdown
  // is CC-E work, and the flag flips there with zero wire change.
  supportsContextBreakdown: false,
  supportsInteractiveApprovals: false,
  // `total_cost_usd` rides every `result`. Displayed as an ESTIMATE for a
  // subscription account — real billing is Anthropic's side.
  costAccounting: true,
  supportsModelSelection: true,
  supportsReasoningEffort: true,
  // R-W0-9 was DISPROVEN live on 2026-07-25 (CLI 2.1.220): a user frame built
  // as a content-block array delivers the image, and the model describes it.
  // The original finding (the model answered "no attached image data") dates to
  // v2.1.207 and no longer reproduces. Engine-level and flat by necessity, not
  // by shortcut: unlike codex's `model/list`, the CLI's `initialize.models[]`
  // carries no modality field at all (contract pins only `value` +
  // `resolvedModel`), so there is nothing to gate a per-model verdict on.
  supportsImages: true,
  supportsTasks: false,
  supportsFileSnapshots: false,
  // TASK.92: manual compaction via the allowlisted /compact slash frame
  // (`compactNow` below) — this is what opens the Compact slash-menu row for
  // Claude, NOT `supportsCorePermissions` (that flag gates the ModeMenu).
  supportsManualCompact: true,
};

/**
 * TASK.92: the ONLY slash commands AnyCode ever sends to the CLI. A closed
 * list by construction — anything not here is never built into a user frame
 * by host code. Ambient catalog commands (`initialize.commands[]` /
 * `system/init.slash_commands[]`) are neither surfaced in the UI nor
 * forwarded; for a HUMAN-typed frame they stay reachable only if the user
 * types them verbatim as ordinary text, same as any text they could type
 * anyway. System-origin frames (child reports, agent messages) carry
 * model-authored text and are additionally de-fanged at the send site — see
 * `neutralizeSystemOriginSlashes` (cross-review F2).
 */
const CLAUDE_SLASH_ALLOWLIST = ["/compact"] as const;

const CLAUDE_BRIDGED_CAPABILITIES: EngineCapabilities = {
  ...CLAUDE_ENGINE_CAPABILITIES,
  supportsInteractiveApprovals: true,
};

export interface ClaudeEngineTimeouts {
  postInterruptSettleMs: number;
  /** TASK.157: minimum spacing between mid-turn `get_context_usage` refreshes. */
  midTurnContextUsageIntervalMs: number;
}

export const DEFAULT_CLAUDE_ENGINE_TIMEOUTS: ClaudeEngineTimeouts = {
  postInterruptSettleMs: CLAUDE_POST_INTERRUPT_SETTLE_MS,
  midTurnContextUsageIntervalMs: 30_000,
};

/** The narrow transport seam, so lifecycle tests need no real child process. */
export interface ClaudeTransport {
  initialize(): Promise<{ commands: unknown[]; models: unknown[]; account: { tokenSource?: string; subscriptionType?: string } }>;
  controlRequest<T>(subtype: string, request?: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<T>;
  getContextUsage(): Promise<Record<string, unknown>>;
  interrupt(): Promise<{ stillQueued: string[] }>;
  sendUserMessage(content: string | unknown[]): void;
  notifications(): AsyncIterable<ClaudeStreamMessage>;
  close(): Promise<void>;
}

/** Draft (new session) or persisted (resume) selection; both are UNVALIDATED opaque strings at this point. */
export interface ClaudeSessionSelection {
  model?: string;
  presetId?: string;
  /**
   * Initial effort (TASK.75). Unlike `model`/`presetId`, this has no
   * "persisted, trust the origin distinction" branch: the model catalog that
   * would validate it against a specific model is not known pre-spawn either
   * way, so both a draft pick and a resumed row are validated the same way,
   * against the fixed `CLAUDE_EFFORT_LEVELS` vocabulary (`resolveEffort`).
   */
  effort?: string;
  origin?: "draft" | "persisted";
}

export interface ConnectedClaudeEngine {
  engine: ClaudeEngine;
  /** The native session id we assigned at spawn (`--session-id`) — persisted as `externalSessionRef`. */
  sessionRef: string;
  model: string;
  presetId: string;
}

interface ClaudeEngineSettings {
  catalog: ClaudeModelCatalog;
  /** The catalog `value` currently selected; "" when the catalog was unreadable. */
  model: string;
  preset: ClaudePermissionPresetDefinition;
  effort?: string;
  /**
   * Remembered effort per model id (TASK.60 shape, mirrors
   * `CodexEngineSettings.effortsByModel`), restored on `selectModel`. In-RAM
   * only, scoped to this one live engine instance — same as Codex's own
   * memory, which likewise never reaches a durable store.
   */
  effortsByModel: Map<string, string>;
  /** Boot-time warnings (unusable draft model, quota pressure) flushed into the first turn's stream. */
  notices: AgentEvent[];
  /**
   * TASK.92: true only when this engine's CLI was spawned WITHOUT
   * `--disable-slash-commands` (`ClaudeEngineCreateOptions.enableSlashPassthrough`).
   * Absent/false: `compactNow` refuses and the Compact capability is off — a
   * `/compact` frame to a flagged CLI would reach the model as plain text.
   */
  slashPassthrough?: boolean;
}

function warning(message: string): AgentEvent {
  return { type: "engine_notice", level: "warning", message };
}

/**
 * TASK.182: defensively parses a `system/init.mcp_servers[]` array into plain
 * names. Each entry may be `{name, status, source, …}` or a bare string
 * (both shapes have been observed across CLI versions); anything else is
 * skipped, never thrown — the init must never fail a turn over a field we
 * only use for reconciliation warnings.
 */
export function parseClaudeInitMcpServerNames(mcpServers: unknown[] | undefined): string[] {
  if (!Array.isArray(mcpServers)) return [];
  const names: string[] = [];
  for (const entry of mcpServers) {
    if (typeof entry === "string") {
      if (entry.length > 0) names.push(entry);
      continue;
    }
    if (entry !== null && typeof entry === "object") {
      const name = (entry as { name?: unknown }).name;
      if (typeof name === "string" && name.length > 0) names.push(name);
    }
  }
  return names;
}

/** Taskana 4238: a `system/init` mcp_servers entry WITH its connection status (a bare string entry carries none). */
export interface ClaudeInitMcpServerStatus {
  name: string;
  /** `connected`/`failed`/`needs-auth`/`pending`/… as the CLI reports it; `null` for a bare-string entry. */
  status: string | null;
}

/**
 * Taskana 4238: names WITH status (`connected`/`failed`/`needs-auth`/
 * `pending`/…); bare strings => status null. Same tolerance rules as
 * `parseClaudeInitMcpServerNames` — junk entries are skipped, never thrown.
 */
export function parseClaudeInitMcpServerStatuses(mcpServers: unknown[] | undefined): ClaudeInitMcpServerStatus[] {
  if (!Array.isArray(mcpServers)) return [];
  const statuses: ClaudeInitMcpServerStatus[] = [];
  for (const entry of mcpServers) {
    if (typeof entry === "string") {
      if (entry.length > 0) statuses.push({ name: entry, status: null });
      continue;
    }
    if (entry !== null && typeof entry === "object") {
      const name = (entry as { name?: unknown }).name;
      const status = (entry as { status?: unknown }).status;
      if (typeof name === "string" && name.length > 0) {
        statuses.push({ name, status: typeof status === "string" ? status : null });
      }
    }
  }
  return statuses;
}

/**
 * Taskana 4238: one warning per server whose init status is `failed` or
 * `needs-auth`. Names only, never values/paths (TASK.182 rule).
 */
export function mcpServerFailureNotices(statuses: readonly ClaudeInitMcpServerStatus[]): AgentEvent[] {
  const notices: AgentEvent[] = [];
  for (const { name, status } of statuses) {
    if (status === "failed") {
      notices.push(
        name === "anycode"
          ? warning(`AnyCode's MCP server "anycode" failed to connect in this Claude session, so AnyCode tools (mcp__anycode__*) are unavailable.`)
          : warning(`MCP server "${name}" failed to connect in this Claude session; its tools are unavailable.`),
      );
    } else if (status === "needs-auth") {
      notices.push(warning(`MCP server "${name}" needs authentication; its tools are unavailable in this Claude session.`));
    }
  }
  return notices;
}

/**
 * Resolves the preset a session boots with. An unknown id can only come from a
 * stale renderer or an older session row — neither is a user-visible error, so
 * both quietly become the default. A DRAFT id the user actually picked is
 * different: if it does not exist, they are told.
 */
function resolvePreset(selection: ClaudeSessionSelection | undefined, notices: AgentEvent[]): ClaudePermissionPresetDefinition {
  const fallback = findClaudePreset(DEFAULT_CLAUDE_PRESET)!;
  const requested = selection?.presetId;
  if (requested === undefined) return fallback;
  const preset = findClaudePreset(requested);
  if (preset !== undefined) return preset;
  if (selection?.origin === "draft") {
    notices.push(warning(`Claude permission preset "${requested}" is unknown; using "${fallback.label}" instead.`));
  }
  return fallback;
}

/**
 * Resolves the model id to spawn with. Returns undefined whenever the choice
 * cannot be POSITIVELY validated against the live catalog — the CLI's own
 * default is then used. Fail-closed: an unverifiable id would be accepted at
 * spawn and fail the turn late.
 */
function resolveModel(
  catalog: ClaudeModelCatalog,
  selection: ClaudeSessionSelection | undefined,
  notices: AgentEvent[],
): string | undefined {
  const requested = selection?.model;
  if (requested === undefined) return undefined;
  if (!catalog.available) {
    notices.push(warning(`Claude could not read its model list, so "${requested}" could not be verified; the default model is used.`));
    return undefined;
  }
  if (!catalog.has(requested)) {
    notices.push(warning(`Claude model "${requested}" is not available for this account; the default model is used.`));
    return undefined;
  }
  return requested;
}

/**
 * Resolves the effort to spawn with. Validated against the fixed
 * `CLAUDE_EFFORT_LEVELS` vocabulary only — the model catalog that would
 * validate a level against a SPECIFIC model is not readable until after
 * `initialize`, exactly the constraint `resolveModel` documents for model
 * ids, except here the closed 5-value CLI vocabulary makes a useful
 * pre-spawn check possible where the open-ended model catalog offers none.
 * A model that ends up not supporting this level is the server's own
 * rejection to make (TASK.75 open question #4); `connectClaudeEngine`
 * re-validates against the confirmed model once the catalog is known and
 * only then records a local `settings.effort`.
 */
function resolveEffort(selection: ClaudeSessionSelection | undefined, notices: AgentEvent[]): string | undefined {
  const requested = selection?.effort;
  if (requested === undefined) return undefined;
  if (!isClaudeEffortLevel(requested)) {
    if (selection?.origin === "draft") {
      notices.push(warning(`Claude effort "${requested}" is not a recognized level; the default effort is used.`));
    }
    return undefined;
  }
  return requested;
}

/**
 * Builds the anthropic-shaped content-block array so an attachment physically
 * rides the user frame. `sendUserMessage` has always accepted `string |
 * unknown[]`; what was missing was a producer for the array form, which is why
 * R-W0-9's "no attached image data" verdict could never have been about the
 * CLI — a text-only frame cannot deliver an image no matter what the engine
 * claims to support.
 *
 * A turn with no attachments keeps sending a bare string — the exact byte-shape
 * the CLI has received on every turn to date.
 */
function userMessageContent(text: string, attachments?: ImageAttachment[]): string | unknown[] {
  if (attachments === undefined || attachments.length === 0) return text;
  return [
    ...attachments.map((attachment) => ({
      type: "image",
      source: { type: "base64", media_type: attachment.mediaType, data: attachment.data },
    })),
    { type: "text", text },
  ];
}

/**
 * TASK.92 cross-review F2: the slash-injection guard for NON-HUMAN user
 * frames. Root engine sessions interpret slash commands in stream-json user
 * frames (w0-17 evidence, the same mechanism `compactNow` rides), and host
 * paths DO convert model output into user frames with `origin:"system"` — a
 * detached child's final report (`formatChildTaskNotification` ->
 * `child_report` -> renderer prompt queue -> `user_message`) or an
 * agent-to-agent message (`drainAgentInbox` -> `acceptUserMessage(...,
 * "system")`). A child model that ends its report with a `\n/doctor` line
 * (or `/update-config`, `/run`, …) must not get it executed in the parent
 * root session where slash interpretation is now ON.
 *
 * Defense: for `origin === "system"` turns ONLY, every LINE-START `/` of the
 * payload is de-fanged by prefixing one space. Position 0 interpretation is
 * proven by fixture; a line-start `/` at position >0 is unproven either way —
 * the guard deliberately does not bet on that answer. The slash character and
 * everything after it stay intact (the model still reads its own command
 * text); only its command position is broken. Human-typed text is NEVER
 * touched: the user typing `/doctor` verbatim as ordinary text stays exactly
 * as reachable as the allowlist's own comment promises, and a human frame
 * with no slash is byte-identical to before.
 */
function neutralizeSystemOriginSlashes(text: string): string {
  // Multiline-safe: a `/` at the very start or right after any newline. The
  // single leading space breaks both the position-0 and the line-start
  // interpretation while changing nothing else about the text.
  return text.replace(/(^|\n)(\/)/g, "$1 $2");
}

/**
 * TASK.116: the trusted, host-authored death descriptor attached to EVERY
 * terminal claude `error` event. Raw engine text is used only to select a
 * constant (or to re-emit a narrowly validated host format), never disclosed:
 * `ClaudeClientError` alone is NOT a trust boundary, because
 * `onControlResponse` wraps CLI-supplied `response.error`, `bindStdioErrors` /
 * `bindChild` wrap arbitrary error messages, and `onStdout` can embed
 * `message.type` — so anything that is not one of the fixed host shapes below
 * falls through to the classified constant. Keeping this redaction-proof is
 * what lets Session latch "the engine is dead" without ever seeing (or
 * leaking) provider text.
 *
 * `code:"engine_dead"` is the ONE value Session keys its liveness latch on;
 * it is emitted for every terminal claude error path, including a redacted
 * one, so a hostile failure can never disable the drain guard.
 */
function engineDeathSafe(error: Error): { code: "engine_dead"; message: string } {
  // Two fixed host strings survive verbatim — they carry no provider text.
  if (error.message === "Claude exited during a turn" || error.message === "Claude engine is closed") {
    return { code: "engine_dead", message: error.message };
  }
  // The ONE ClaudeClientError shape that is a host-authored exit report:
  // `claude exited unexpectedly (code=<int|null>, signal=<SIG…|null>)`. Anchored
  // and full-matched — no substrings, no suffixes — so a provider message that
  // merely starts with this prefix cannot smuggle text through.
  if (error instanceof ClaudeClientError) {
    const exit = /^claude exited unexpectedly \(code=(\d+|null), signal=(SIG[A-Z0-9]+|null)\)$/.exec(error.message);
    if (exit !== null) {
      return { code: "engine_dead", message: `claude exited unexpectedly (code=${exit[1]}, signal=${exit[2]})` };
    }
  }
  // The two fixed host timeout templates from runTurn, reconstructed around the
  // validated numeric bound and the fixed suffix only.
  const timeout = /^Claude did not settle the interrupted turn within (\d+)ms(; the session was closed\. Start a new session to continue\.)?$/.exec(error.message);
  if (timeout !== null) {
    return {
      code: "engine_dead",
      message: `Claude did not settle the interrupted turn within ${timeout[1]}ms${timeout[2] ?? ""}`,
    };
  }
  // Everything else — plain Error, a ClaudeClientError carrying provider text /
  // an unknown frame name / stream or spawn details — is redacted to the
  // classified constant. Raw text stays private.
  return { code: "engine_dead", message: classifyEngineFailure(error).message };
}

/** Resolves once on abort and never rejects; the listener is always removed. */
function watchAbort(signal: AbortSignal): { promise: Promise<void>; dispose(): void } {
  if (signal.aborted) return { promise: Promise.resolve(), dispose: () => {} };
  let listener: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    listener = () => resolve();
    signal.addEventListener("abort", listener, { once: true });
  });
  return { promise, dispose: () => signal.removeEventListener("abort", listener) };
}

interface SettleDeadline {
  promise: Promise<{ kind: "settle-timeout" }>;
  cancel(): void;
}

function deadline(ms: number): SettleDeadline {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<{ kind: "settle-timeout" }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "settle-timeout" }), ms);
  });
  return {
    promise,
    cancel: () => {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

export interface ClaudeEngineCreateOptions extends Omit<ClaudeClientOptions, "bootstrap" | "onControlRequest" | "permissionModeFlag" | "model" | "effort" | "sessionId" | "resume"> {
  bootstrap: EngineBootstrap;
  broker: EngineBridgeBroker;
  selection?: ClaudeSessionSelection;
  timeouts?: Partial<ClaudeEngineTimeouts>;
  /**
   * TASK.226 срез S4: the MCP agent-bridge door for this tab, built and
   * routed BEFORE `initialize()` is ever sent (probes.md P0 — the CLI drives
   * its OWN mcp handshake INSIDE our outbound `initialize`, before it answers
   * ours). Absent for a claude CHILD boot and for a tab whose profile catalog
   * came back empty (the door is never announced at all — plan §5 S4 p.7's
   * switch); `connectClaudeEngine` below reproduces the pre-TASK.226
   * `initialize()` body byte-for-byte in both cases.
   */
  mcpBridge?: ClaudeMcpBridge;
  /**
   * Taskana 4764: the full CLI names (`mcp__anycode__browser_*`) of the
   * browser tools the door announced. Supplied exactly when `mcpBridge`
   * exists; `ClaudeApprovalBridge` auto-allows `can_use_tool` for these
   * names (the real, input-aware approval gate runs inside the door's
   * `callTool` through the same broker — one prompt, canonical title).
   */
  browserToolNames?: ReadonlySet<string>;
  /**
   * Taskana 4056 cross-review M2: `CLAUDE_AGENT_BRIDGE_PROMPT`, re-declared
   * here only to carry the engine-level contract — the host supplies it
   * EXACTLY when it supplies `mcpBridge` (the same non-empty-catalog,
   * non-child-boot switch), and `connectClaudeEngine` below additionally
   * enforces the pairing (a caller who names the tool without announcing the
   * door gets the plain always-on block), so the spawn argv can name
   * `mcp__anycode__agent` only in sessions where the tool actually exists.
   * Absent → the argv's `--append-system-prompt` value is byte-identical to
   * the pre-4056 spawn.
   */
  agentBridgePrompt?: string;
  /**
   * TASK.226 срез S4: looks up (and consumes) the durable subagent-card
   * snapshot for one `mcp__anycode__agent` tool_use id — stamped by the
   * bridge's `callTool` handler (host/index.ts) onto its own
   * `AgentBridgeCallResult.presentation` once the child session settles. The
   * MCP `tools/call` response itself carries only `{text, isError}` (no room
   * for a card payload — §3.1), so this is the ONLY channel the durable
   * snapshot can ride to the renderer; `event-translator.ts`'s `onUser`
   * reads it when it builds the paired top-level `tool_result`'s outcome.
   */
  takePresentation?(toolUseId: string): ToolResultPresentation | undefined;
  /**
   * Taskana 4056 cross-review P1: called once at the END of every turn with
   * the ids of THIS turn's `tool_use` blocks whose paired top-level
   * `tool_result` never arrived (a cancelled/dying turn's still-open tool
   * calls). The host drops any bridge presentation stamped for those ids —
   * without this, a snapshot whose consuming frame never came would survive
   * in the host's map for the process's lifetime, one entry per aborted
   * bridge call. Absent → the engine has nothing to sweep and skips the call
   * (the pre-P1 behaviour, bounded and harmless for a host that never
   * stamps).
   */
  dropPresentations?(toolUseIds: readonly string[]): void;
  /**
   * TASK.182: controlled MCP-forwarding warnings (mcp-forward-diagnostic.ts
   * templates only — no loader strings, no values) collected by the host boot
   * from prepareEngineMcpForward. Appended into connect's notices for
   * first-turn drain on BOTH fresh and resume boots.
   */
  bootNotices?: AgentEvent[];
}

/**
 * Shared boot path for a fresh spawn (`--session-id <uuid>`) and a resume
 * spawn (`--resume <ref>`, CC-D) — the two differ ONLY in which of
 * `ClaudeClient`'s two mutually-exclusive spawn fields is set
 * (`buildClaudeSpawnArgs` prefers `sessionId`, cut §1.3). Everything else —
 * handshake ordering, model/preset resolution, quota seed, bounded release on
 * a failed boot step — is identical: the handshake proves the CLI answers AND
 * that the profile is signed in, and the model catalog is read from that same
 * `initialize` response, so a draft/persisted model that no longer exists is
 * caught here, before any turn is burned.
 */
async function connectClaudeEngine(
  options: ClaudeEngineCreateOptions,
  spawn: { sessionId: string } | { resume: string },
): Promise<ConnectedClaudeEngine> {
  const notices: AgentEvent[] = [];
  // TASK.182: controlled MCP-forward warnings drain with the first turn.
  if (options.bootNotices !== undefined) notices.push(...options.bootNotices);
  const resuming = !("sessionId" in spawn);
  const preset = resolvePreset(options.selection, notices);
  const requestedEffort = resolveEffort(options.selection, notices);
  const sessionRef = "sessionId" in spawn ? spawn.sessionId : spawn.resume;
  let engine: ClaudeEngine | null = null;
  // TASK.226 срез S4 (probes.md P0's ordering correction): the bridge is
  // handed to `ClaudeApprovalBridge` HERE, before `ClaudeClient` is even
  // constructed — the CLI's own MCP handshake (`initialize` ->
  // `notifications/initialized` -> `tools/list`, each wrapped as a
  // `mcp_message` control_request) arrives INSIDE the outbound `initialize`
  // call below, before it answers ours, so a bridge attached any later would
  // silently miss it (approval-bridge.ts's `route` would fail-close every
  // `mcp_message` with "AnyCode does not handle" instead of routing it).
  const approvals = new ClaudeApprovalBridge({
    broker: options.broker,
    activePresetId: () => engine?.activePresetId ?? preset.id,
    // Taskana 4294 (cross-review F1): the CLI is spawned at `options.cwd`
    // (host/index.ts passes the boot workspace), so that same directory is
    // the workspace root the approval bridge's fact minting anchors against.
    workspace: options.cwd,
    ...(options.mcpBridge !== undefined ? { bridge: options.mcpBridge } : {}),
    ...(options.browserToolNames !== undefined ? { browserToolNames: options.browserToolNames } : {}),
  });
  // The catalog is not known until after the handshake, so a draft model cannot
  // ride the spawn argv. It is applied right after `initialize` via `set_model`
  // — live-proven to apply immediately, with a rejection being a clean no-op.
  //
  // On RESUME neither posture is applied here (cut §1.5 hazard (б)): the native
  // session kept its OWN model and permissionMode across process death (probe
  // #4), and our persisted row may have drifted from them. Sending
  // `--permission-mode`/`set_model` before the first `system/init` would
  // overwrite the surviving truth with a stale row — the exact failure where a
  // row saying `workspace` silently re-widens a session the CLI left at `ask`.
  // The persisted values stay a PROVISIONAL display until that init arrives and
  // `reconcileFromInit` replaces them with the native fact.
  //
  // Effort is deliberately NOT held back the way model/permissionMode are:
  // `system/init` carries no effort field at all (contract §1), so there is
  // no native state a resend could clobber on resume — unlike model, where a
  // stale row could overwrite a session's own surviving choice, an omitted
  // `--effort` here would simply forget ours for no benefit.
  const client = new ClaudeClient({
    ...options,
    ...(resuming ? {} : { permissionModeFlag: permissionModeToFlag(preset.mode) }),
    ...(requestedEffort !== undefined ? { effort: requestedEffort } : {}),
    ...spawn,
    bootstrap: options.bootstrap,
    onControlRequest: approvals.handle,
    // TASK.92: only a ROOT engine session drops the flag, so the CLI
    // interprets host-built allowlisted /compact user frames. Fail-closed:
    // the host opts in explicitly (host/index.ts, root sessions only). Doctor,
    // login, engine-children.ts AND session-tier claude children (whose
    // prompt is model-authored — a leading "/" there would be slash
    // injection) keep the flag.
    enableSlashPassthrough: options.enableSlashPassthrough === true,
    // Taskana 4056 M2: the delegation sentence rides the argv only on the
    // SAME switch that announces the bridge (`mcpBridge !== undefined`) —
    // spread AFTER `...options` so an explicit undefined still overrides,
    // and a bridge-less boot can never name the tool.
    ...(options.mcpBridge !== undefined && options.agentBridgePrompt !== undefined
      ? { agentBridgePrompt: options.agentBridgePrompt }
      : { agentBridgePrompt: undefined }),
  });
  try {
    await client.start();
    // `announceOn` (TASK.226 S4) is the ONLY source of `sdkMcpServers` on the
    // wire; a tab with no bridge (child boot, or an empty profile catalog —
    // see `mcpBridge`'s own doc above) calls `initialize(undefined)`, the
    // exact pre-TASK.226 empty body (claude-client.ts's own `initialize`
    // doc: "an omitted `extra` reproduces the pre-TASK.226 empty body
    // byte-for-byte").
    const initialized = await client.initialize(options.mcpBridge?.announceOn());
    if (!isClaudeSignedIn(initialized.account)) {
      throw new Error(CLAUDE_NOT_SIGNED_IN);
    }
    const catalog = ClaudeModelCatalog.fromInitialize(initialized.models);
    let model: string;
    if (resuming) {
      // Provisional only — never sent. The resumed session's own model is
      // reported by its first `system/init` and adopted there
      // (`reconcileFromInit`). A persisted id the catalog no longer knows
      // degrades silently, exactly as `resolvePreset` does for a stale preset:
      // it is not a choice the user just made, so it is not a user-visible error.
      const persisted = options.selection?.model;
      model = persisted !== undefined && catalog.has(persisted) ? persisted : catalog.defaultValue() ?? "";
    } else {
      const requested = resolveModel(catalog, options.selection, notices);
      model = requested ?? catalog.defaultValue() ?? "";
      if (requested !== undefined) {
        try {
          await client.controlRequest("set_model", { model: requested });
        } catch {
          // A rejected set_model is a clean no-op live (`w0-16-setmodel.jsonl`) —
          // the prior model survives, so the session boots on the CLI default.
          notices.push(warning(`Claude refused the model "${requested}"; the default model is used.`));
          model = catalog.defaultValue() ?? "";
        }
      }
    }
    // The value actually sent at spawn is only known-good against the fixed
    // vocabulary (`resolveEffort` above), not against THIS model — the
    // catalog didn't exist yet. Re-validate now that both are known, so the
    // local record never claims an effort the confirmed model doesn't
    // support (same fail-closed discipline `resolveModel` applies to ids).
    const effort = catalog.resolveEffort(model, requestedEffort);
    const effortsByModel = new Map<string, string>();
    if (effort !== undefined) effortsByModel.set(model, effort);
    const settings: ClaudeEngineSettings = {
      catalog,
      model,
      preset,
      effortsByModel,
      notices,
      ...(effort !== undefined ? { effort } : {}),
      slashPassthrough: options.enableSlashPassthrough === true,
    };
    engine = new ClaudeEngine(
      client,
      sessionRef,
      approvals,
      settings,
      options.timeouts,
      options.takePresentation,
      options.dropPresentations,
    );
    // $0 quota snapshot, seeded before the first turn so a user already at
    // their limit learns it from the first reply rather than a failed turn.
    await engine.refreshQuota();
    return { engine, sessionRef, model, presetId: preset.id };
  } catch (error) {
    // Any bounded boot step that fails releases the child — a failed boot must
    // never leave a live `claude` process behind.
    await client.close();
    throw error;
  }
}

/**
 * Boots a fresh native Claude session. The native session id is OURS:
 * `--session-id <uuid>` is passed at spawn, so the resumable ref exists at
 * boot time. `system/init` (turn-scoped, probe #1) later confirms it, but
 * nothing waits for it.
 */
export async function startClaudeEngine(options: ClaudeEngineCreateOptions): Promise<ConnectedClaudeEngine> {
  return connectClaudeEngine(options, { sessionId: randomUUID() });
}

/**
 * Resumes one exact persisted native session via `--resume <ref>` (CC-D-min,
 * cut §1.5, probe #4: `session_id`/model/`permissionMode` all survive process
 * death). It deliberately never falls back to a fresh session — a resume
 * whose native side has expired (retention, test-hazard в) surfaces as a
 * boot failure, not a silent new session under the old id. The engine's own
 * `model`/`presetId` here are the DRAFT/persisted request only — the ACTUAL
 * settled posture is confirmed later, from the resumed session's first
 * observed `system/init` (`resolvedModel()`/`resolvedPermissionMode()`), NOT
 * from this connect step, because `--resume` never re-emits `system/init` at
 * handshake time (probe #1/#4).
 */
export async function resumeClaudeEngine(
  options: ClaudeEngineCreateOptions & { externalSessionRef: string },
): Promise<ConnectedClaudeEngine> {
  return connectClaudeEngine(options, { resume: options.externalSessionRef });
}

export class ClaudeEngine implements SessionEngine {
  readonly id = "claude" as const;
  readonly capabilities: EngineCapabilities;
  private readonly bounds: ClaudeEngineTimeouts;
  private turnNumber = 0;
  /** Per-turn latch: exactly one `interrupt` control request may be sent for one turn. */
  private interruptSent = false;
  private turnActive = false;
  private terminalError: Error | null = null;
  // ── TASK.189: single-owner notification stream ──────────────────────────
  /** The engine's ONE cached pending read of the notification stream. Shared
   *  by the idle reader and every owner turn; see takeFrame/frameConsumed. */
  private pendingNext: Promise<IteratorResult<ClaudeStreamMessage>> | null = null;
  /** TASK.189: the cached read's fulfillment, once it has landed. Draining
   *  code inspects this after a microtask checkpoint instead of racing
   *  promises (a `.then` wrapper adds a microtask and loses every race
   *  against an already-resolved sentinel). */
  private readyFrame: IteratorResult<ClaudeStreamMessage> | null = null;
  /** The idle reader is running (at most one, engine lifetime). */
  private idleReading = false;
  /** A CLI self-started turn observed between owner turns, if one is open. */
  private foreignTurn: { done: { promise: Promise<void>; resolve: () => void } } | null = null;
  /** The idle reader's current race token — bump to stop it. */
  private idleEpoch = 0;
  /** Wakes the idle reader's abort race (runTurn entry / dispose). */
  private idleWake: (() => void) | null = null;
  /** TASK.189: resolved once when dispose() runs while an owner turn is parked
   *  in the foreign-wait loop. Created lazily and never rejects; the resolver
   *  is idempotent. */
  private disposalWait: Promise<void> | null = null;
  private resolveDisposalWait: () => void = () => {};
  private disposed = false;
  /** Live engine state from the most recent `system/init` (re-emitted every turn). */
  private sessionId: string | null = null;
  private liveModel: string | null = null;
  /** The wire-level permission mode the CLI is ACTUALLY running (CC-D resume settle, cut §1.5 hazard (б)) — distinct from `activePresetId`, which is our own requested posture. */
  private livePermissionMode: ClaudeWirePermissionMode | null = null;
  /** Latch + one-shot observers for the FIRST turn-scoped `system/init` (`onFirstSystemInit`). */
  private firstInitSeen = false;
  private readonly firstInitListeners = new Set<
    (init: { sessionId: string; model: string; permissionMode: ClaudeWirePermissionMode; mcpServerNames: string[]; mcpServerStatuses: ClaudeInitMcpServerStatus[] }) => void
  >();
  /** TASK.182: names from the first observed `system/init`'s mcp_servers[]. */
  private liveMcpServerNames: string[] | null = null;
  /** Taskana 4238: statuses from the most recent `system/init`'s mcp_servers[] (latched for `onFirstSystemInit`). */
  private liveMcpServerStatuses: ClaudeInitMcpServerStatus[] | null = null;
  /**
   * Taskana 4238: server names whose MCP failure notice has already been
   * surfaced. `system/init` repeats every turn, so without this latch one
   * failed server would warn on every single turn of the session.
   */
  private readonly reportedMcpFailures = new Set<string>();
  /**
   * Taskana 4238: MCP status notices queued by the CURRENT turn's init and
   * yielded inside that same turn (runTurn drains them right after the
   * translator's events). An init absorbed while idle routes through
   * `settings.notices` instead (absorbIdleFrame) — see the comment there.
   */
  private readonly mcpStatusNotices: AgentEvent[] = [];
  private quota: ClaudeQuotaSnapshot | null = null;
  /** Cumulative `result.total_cost_usd` for this session (capability `costAccounting`). */
  private totalCostUsd = 0;
  /**
   * TASK.159: session-cumulative token counters fed by `onResult` below, the
   * source `engine_session_tokens` (host/index.ts's engine-boot telemetry tap,
   * `records.ts`'s `buildEngineTelemetryTap`) converts to additive delta
   * records. Per-process, like `totalCostUsd` — never persisted, never
   * summed with a prior boot's value (a resume starts both at 0; codex's own
   * resume-baseline problem does not apply here, cut §2.3 comment).
   */
  private cumulativeInputTokens = 0;
  private cumulativeOutputTokens = 0;
  /**
   * Set by `onResult` ONLY when the just-finished turn's `result.usage`
   * decoded to two finite numbers; reset to `null` at the top of every
   * `runTurn` call so a turn whose `result` never arrived (or carried no
   * usable `usage`) cannot silently replay the previous turn's numbers. Read
   * once, right after the post-terminal `readContextUsage` read below —
   * `null` there means this turn emits no `engine_session_tokens` event at
   * all (fail-soft: an undercount, never an invented one, per TASK.159 §DoD).
   */
  private lastTurnTokenUsage: { input: number; output: number } | null = null;
  /**
   * TASK.157: timestamp (ms) of the LAST STARTED mid-turn context refresh, or
   * `null` when none has started yet. `null` (not 0) is the sentinel so a
   * mocked clock sitting at zero still permits the FIRST refresh of a turn.
   */
  private lastMidTurnUsageReadAt: number | null = null;
  /**
   * TASK.157: the PHYSICAL in-flight guard for `get_context_usage`. Engine
   * level, not turn level: an iterator closed before its outstanding read
   * settles must still block a later turn from overlapping that request. Held
   * until the actual transport request settles, then cleared by promise
   * identity check (a stale callback from an earlier request can't clear a
   * newer one). A request that outlives its turn settles silently and emits
   * nothing.
   */
  private contextUsageInFlight: Promise<unknown> | null = null;
  /**
   * Taskana 4056: subagent_* events from the MCP agent bridge
   * (`runAgentBridgeCall`'s `onEvent`), waiting for the live turn's race. The
   * host's `callTool` pushes them from OUTSIDE the engine's turn generator —
   * an `AgentEvent` only travels inside a turn — so the queue is the seam the
   * owner-loop race drains (same discipline `queueNotice` uses for the
   * between-turns case, but live: events surface DURING the quiet stretches of
   * a running bridge call, with no stream frame to carry them).
   *
   * Delivery follows the `pendingUsage` discipline, NOT a plain waiter list: a
   * losing race arm is never cancelled, so parked waiters from EARLIER loop
   * iterations would accumulate and the next push would hand the event to a
   * dead arm (lost). Instead `nextBridgeEvent()` caches ONE slot
   * (`bridgePending`) until the winning iteration's loop body consumes it
   * exactly once — a losing arm re-arms the SAME promise the next iteration,
   * so an event is never stranded in an orphaned promise and never
   * double-delivered. The turn's `finally` sweeps the slot (a still-parked
   * waiter is woken with the harmless spurious `null`; an already-resolved
   * event nobody consumed is re-queued for the next turn's send barrier), so
   * nothing leaks across turns.
   */
  private bridgeEvents: AgentEvent[] = [];
  /** Taskana 4056: the cached bridge-event slot (see `bridgeEvents`'s own header). */
  private bridgePending: { promise: Promise<AgentEvent | null>; settled: boolean; event: AgentEvent | null } | null = null;
  /** Taskana 4056: the parked slot's waiter — at most one; woken by `pushBridgeEvent`/`dispose`. */
  private bridgeWaiters: { resolve: (event: AgentEvent | null) => void }[] = [];

  constructor(
    private readonly client: ClaudeTransport,
    /** The native session ref we assigned at spawn — CC-D resumes with it. */
    readonly sessionRef: string,
    private readonly approvals?: ClaudeApprovalBridge,
    private readonly settings?: ClaudeEngineSettings,
    overrides?: Partial<ClaudeEngineTimeouts>,
    /** TASK.226 срез S4 — see `ClaudeEngineCreateOptions.takePresentation`'s own doc. */
    private readonly takePresentation?: (toolUseId: string) => ToolResultPresentation | undefined,
    /** Taskana 4056 cross-review P1 — see `ClaudeEngineCreateOptions.dropPresentations`'s own doc. */
    private readonly dropPresentations?: (toolUseIds: readonly string[]) => void,
  ) {
    // Interactive approval is advertised only once the real bridge is installed
    // (the codex CODEX_BRIDGED_CAPABILITIES precedent); a bare test engine keeps
    // the fail-closed capability.
    const base = approvals === undefined ? CLAUDE_ENGINE_CAPABILITIES : CLAUDE_BRIDGED_CAPABILITIES;
    // TASK.92: no slash passthrough (child session, flagged spawn) => no Compact row.
    this.capabilities = settings?.slashPassthrough === true ? base : { ...base, supportsManualCompact: false };
    this.bounds = { ...DEFAULT_CLAUDE_ENGINE_TIMEOUTS, ...overrides };
    // TASK.189: the idle reader owns the notification stream from boot, so an
    // unsolicited CLI turn BEFORE the first owner turn is absorbed too. If the
    // constructor throws earlier (invalid water marks), no reader was started
    // and no client was spawned — fine.
    this.runIdleReader();
  }

  get activePresetId(): string {
    return this.settings?.preset.id ?? DEFAULT_CLAUDE_PRESET;
  }

  /** Display-only. A Claude session never consults core's permission engine — posture lives in presets.ts. */
  mode(): PermissionMode {
    return "build";
  }

  /**
   * Claude's effort vocabulary is per-model and free-form
   * (`supportedEffortLevels`), not core's fixed ReasoningEffort union, so no
   * core effort value is reported. The engine's own effort lives in `settings`.
   */
  reasoningEffort(): ReasoningEffort | undefined {
    return undefined;
  }

  setReasoningEffort(_effort: ReasoningEffort | undefined): void {
    // Core's effort vocabulary is not Claude's; `selectEffort` is the real path.
  }

  /** CC-C has no resume source; the shadow transcript that populates this is CC-D. */
  historyItems(): readonly HistoryItem[] {
    return [];
  }

  models(): EngineModelChoice[] {
    return this.settings?.catalog.choices() ?? [];
  }

  presets(): EnginePermissionPreset[] {
    return this.settings === undefined ? [] : claudePresetChoices();
  }

  snapshot(): { model: string; activePresetId: string; effort?: string } {
    return {
      model: this.settings?.model ?? "",
      activePresetId: this.activePresetId,
      ...(this.settings?.effort !== undefined ? { effort: this.settings.effort } : {}),
    };
  }

  /** Cumulative estimated cost of this session, in USD (never logged or persisted — custody §0.2-2). */
  sessionCostUsd(): number {
    return this.totalCostUsd;
  }

  quotaSnapshot(): ClaudeQuotaSnapshot | null {
    return this.quota;
  }

  /**
   * Pulls a fresh `get_usage` snapshot ($0, ~770ms). Deliberately NOT in the
   * turn hot path: called at boot and on demand. A `warning`/`critical`
   * severity queues an `engine_notice` for the next turn's stream.
   */
  async refreshQuota(): Promise<ClaudeQuotaSnapshot | null> {
    try {
      const snapshot = decodeClaudeUsage(await this.client.controlRequest<unknown>("get_usage", {}));
      if (snapshot === null) return this.quota;
      this.quota = snapshot;
      const notice = quotaNotice(snapshot);
      if (notice !== null && this.settings !== undefined) {
        this.settings.notices.push({ type: "engine_notice", level: notice.level, message: notice.message });
      }
      return snapshot;
    } catch {
      // Quota is additive presentation data: a failed pull never fails a boot
      // or a turn, it just leaves the snapshot as it was.
      return this.quota;
    }
  }

  /**
   * Host-side model validation before the wire (models.ts is why it exists):
   * an id the catalog does not contain is refused without any control request.
   * A refusal that DOES reach the CLI is a clean no-op live — the prior model
   * survives — so the local record is only advanced after a successful ack.
   */
  async selectModel(id: string): Promise<{ ok: true; model: string } | { ok: false; reason: string }> {
    const settings = this.settings;
    if (settings === undefined) return { ok: false, reason: "Claude model selection is unavailable for this session." };
    if (!settings.catalog.available) {
      return { ok: false, reason: "Claude could not read its model list; start a new session to retry." };
    }
    if (!settings.catalog.has(id)) {
      return { ok: false, reason: `Claude model "${id}" is not available for this account.` };
    }
    try {
      await this.client.controlRequest("set_model", { model: id });
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : "Claude refused the model change." };
    }
    // Each model keeps its own remembered effort (TASK.60 shape, mirrors
    // `CodexEngine.selectModel`): the outgoing model's current effort is
    // stashed before switching, and the incoming model's own remembered (or
    // no longer supported) effort is restored.
    this.rememberCurrentModelEffort();
    settings.model = id;
    const effort = this.resolveEffortForModel(id);
    if (effort === undefined) {
      delete settings.effort;
    } else {
      settings.effort = effort;
      try {
        await this.client.controlRequest("apply_flag_settings", { effortLevel: effort });
      } catch {
        // Best-effort re-assertion of the remembered effort on the now-live
        // model. The memory itself is unaffected by this failing — it stays
        // available to restore on a later switch back — but the user is told
        // the live process may not actually be running it.
        settings.notices.push(warning(`Claude could not re-apply the remembered effort "${effort}" for model "${id}".`));
      }
    }
    return { ok: true, model: id };
  }

  /** Remembers the current model's effective effort before switching away. */
  private rememberCurrentModelEffort(): void {
    const settings = this.settings;
    if (settings === undefined) return;
    if (settings.effort === undefined) settings.effortsByModel.delete(settings.model);
    else settings.effortsByModel.set(settings.model, settings.effort);
  }

  /** Restores the target model's remembered effort, normalizing it through the catalog. */
  private resolveEffortForModel(modelId: string): string | undefined {
    const settings = this.settings;
    if (settings === undefined) return undefined;
    const effort = settings.catalog.resolveEffort(modelId, settings.effortsByModel.get(modelId));
    if (effort === undefined) settings.effortsByModel.delete(modelId);
    else settings.effortsByModel.set(modelId, effort);
    return effort;
  }

  /** Mid-session posture change: `set_permission_mode` (its success ack echoes `{"mode":…}`). */
  async selectPreset(id: string): Promise<{ ok: true; presetId: string } | { ok: false; reason: string }> {
    const settings = this.settings;
    if (settings === undefined) return { ok: false, reason: "Claude permission presets are unavailable for this session." };
    const preset = findClaudePreset(id);
    if (preset === undefined) return { ok: false, reason: `Unknown Claude permission preset "${id}".` };
    try {
      await this.client.controlRequest("set_permission_mode", { mode: preset.mode });
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : "Claude refused the permission-mode change." };
    }
    settings.preset = preset;
    return { ok: true, presetId: preset.id };
  }

  /** Mid-session effort change via `apply_flag_settings{effortLevel}` (live-accepted, $0 — probe #14). */
  async selectEffort(effort: string): Promise<{ ok: true; effort: string } | { ok: false; reason: string }> {
    const settings = this.settings;
    if (settings === undefined) return { ok: false, reason: "Claude reasoning effort is unavailable for this session." };
    if (!settings.catalog.supportsEffort(settings.model, effort)) {
      return { ok: false, reason: `Claude effort "${effort}" is not available for model "${settings.model}".` };
    }
    try {
      await this.client.controlRequest("apply_flag_settings", { effortLevel: effort });
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : "Claude refused the effort change." };
    }
    settings.effort = effort;
    settings.effortsByModel.set(settings.model, effort);
    return { ok: true, effort };
  }

  async *runTurn(input: string, options: RunTurnOptions): AsyncIterable<AgentEvent> {
    const turn = ++this.turnNumber;
    if (this.terminalError !== null || this.disposed) {
      yield* this.terminalEvents(turn, this.terminalError ?? new Error("Claude engine is closed"));
      return;
    }
    yield { type: "turn_start", turn };
    // TASK.189 (order fix): the notice drain moves to AFTER the pre-send frame
    // drain below — a foreign-started notice is queued DURING that drain
    // (absorbIdleFrame -> queueNotice), so draining here would defer it to the
    // NEXT turn. `turn_start` stays the first event.

    const abort = watchAbort(options.signal);
    const translator = new ClaudeTurnTranslator({
      turn,
      onInit: (init) => this.onSystemInit(init),
      onResult: (result) => this.onResult(result),
      ...(this.takePresentation !== undefined ? { takePresentation: this.takePresentation } : {}),
    });
    this.interruptSent = false;
    // TASK.189: take stream ownership BEFORE the first await. `turnActive`
    // being set here (not after) is what keeps runIdleReader from re-entering
    // once an await boundary appears; stopIdleReader's epoch bump makes any
    // in-flight idle callback a no-op.
    this.stopIdleReader();
    this.turnActive = true;
    // TASK.159: turn-scoped reset — see lastTurnTokenUsage's own doc comment.
    this.resetTurnTokenUsage();
    let abortObserved = false;
    let settle: SettleDeadline | null = null;
    let terminal = false;
    // TASK.157: the run-turn-local PENDING COMPLETION slot for a mid-turn
    // context refresh. Distinct from the engine-level physical in-flight guard
    // (`contextUsageInFlight`): this one is consumed by the loop below and
    // dropped with the turn, so a read that settles after the turn ended can
    // never deliver a stale event into a LATER turn. Resolves
    // `{kind:"usage", event}` — never rejects; a settled completion stays
    // parked here until the loop's next race consumes it (never cleared from a
    // promise callback).
    let pendingUsage: Promise<{ kind: "usage"; event: AgentEvent | null }> | null = null;
    let usageDeliveryActive = true;

    /** Latched Stop: settle any parked approval, then interrupt exactly once. */
    const beginInterrupt = (): void => {
      settle ??= deadline(this.bounds.postInterruptSettleMs);
      // The CLI withdraws its own pending `can_use_tool` via
      // `control_cancel_request` (hazard (д)); this only closes OUR modal.
      this.approvals?.denyAll("Claude turn was cancelled", "turn_cancelled");
      void this.sendInterruptOnce();
    };
    const settleRacers = (): Promise<{ kind: "settle-timeout" }>[] => (settle === null ? [] : [settle.promise]);
    // Read through a closure: `settle` is only ever assigned inside
    // `beginInterrupt`, which control-flow analysis cannot see, so a direct
    // `settle?.cancel()` in `finally` narrows to `never`.
    const cancelSettle = (): void => settle?.cancel();

    try {
      // ── TASK.189: the SEND BARRIER. The owner input is sent only from a
      // synchronous segment whose START was re-verified: every await or yield
      // (frame drain, notice delivery, foreign-turn wait) restarts the whole
      // barrier so nothing that arrived while the generator was suspended can
      // slip past classification into the owner turn, and a dispose or Stop
      // that landed in any such gap cancels BEFORE the send — the owner input
      // is never injected after either.
      let sendCancelled = false;
      barrier: for (;;) {
        if (this.disposed) { sendCancelled = true; break barrier; }
        if (!abortObserved && options.signal.aborted) {
          // Stop before anything was sent: no owner input is injected. The
          // interrupt still fires (the CLI may be running something we did
          // not detect); the owner loop below consumes the CLI's terminal
          // result, with the TASK.156 settle deadline as backstop.
          abortObserved = true;
          usageDeliveryActive = false;
          beginInterrupt();
          break barrier; // fall into the owner loop WITHOUT sending
        }
        // (a) Pre-send classification of ALREADY-ARRIVED frames. The cached
        // read's fulfillment lands in `readyFrame` in a microtask; the
        // checkpoint below lets an already-resolved (or buffered-and-
        // immediately-resolved) read land there, while a not-yet-resolved one
        // leaves it null — nothing parks. Every ready frame is classified
        // (absorbIdleFrame — including init, which reconciles state), NEVER
        // handed to the owner translator.
        let drained: "ok" | "stream-end" | "disposed" = "ok";
        for (;;) {
          this.takeFrame();
          await Promise.resolve(); // microtask checkpoint only — never parks
          if (this.disposed) { drained = "disposed"; break; }
          const ready = this.readyFrame;
          if (ready === null) break; // nothing has arrived — stop draining
          this.frameConsumed();
          if (ready.done) { drained = "stream-end"; break; }
          this.absorbIdleFrame(ready.value);
        }
        if (drained === "disposed") { sendCancelled = true; break barrier; }
        if (drained === "stream-end") {
          throw this.terminalError ?? new Error("Claude exited during a turn");
        }
        // Notices — yielding one suspends this generator for an unbounded
        // time, so the whole barrier re-runs on resume (drain again, dispose
        // and Stop checks again) before any send.
        const notices = this.drainNotices();
        // Taskana 4056: bridge events queued BEFORE the turn (a bridge call
        // from a prior CLI turn, or a detach whose report events raced the
        // next owner turn) flush here — before the owner input is sent, same
        // re-run discipline notices use.
        // Both batches are yielded before re-running the barrier: a batch
        // drained here and not yielded would be lost.
        const queued = this.drainBridgeEvents();
        if (notices.length > 0 || queued.length > 0) {
          for (const notice of notices) yield notice;
          for (const ev of queued) yield ev;
          continue barrier;
        }
        // (b) Wait out a STILL-RUNNING foreign turn. NO TIMER, NO
        //     AUTO-INTERRUPT: normal unsolicited work may run arbitrarily
        //     long. While waiting, the OWNER is the single reader: every
        //     arriving frame is classified by absorbIdleFrame (a foreign
        //     `result` closes foreignTurn and ends the wait). Adjacent
        //     foreign turns loop back through the barrier before any send.
        if (this.foreignTurn !== null) {
          // The disposal wait is created BEFORE the notice yield: a dispose
          // that lands while the generator is suspended at that yield resolves
          // THIS promise (dispose's resolver is a no-op if nobody parked yet,
          // so creating it lazily after the yield would miss the disposal
          // entirely), and the race below wakes cancelled instead of falling
          // through to the closed stream's error path.
          const disposal = this.ensureDisposalWait();
          yield { type: "engine_notice", level: "info",
            message: "Claude is finishing a turn it started on its own; your message will be sent when it finishes." };
          const foreignDone = this.foreignTurn.done.promise;
          let waitWhy: "abort" | "dispose" | "done" | "stream-end" | null = null;
          while (waitWhy === null) {
            // Disposal and abort are registered BEFORE the frame arm: when
            // the generator resumes after a dispose that already closed the
            // stream, several arms are settled at once and Promise.race
            // settles in registration order — the frame arm (done:true from
            // close()) must not outrank the disposal wake.
            const raced = await Promise.race([
              disposal.then(() => ({ kind: "dispose" as const })),
              abort.promise.then(() => ({ kind: "abort" as const })),
              foreignDone.then(() => ({ kind: "foreign-done" as const })),
              this.takeFrame().then(
                (value) => ({ kind: "notification" as const, value }),
                (error: unknown) => ({ kind: "rejected" as const, error }),
              ),
            ]);
            if (raced.kind === "abort") { waitWhy = "abort"; break; }
            if (raced.kind === "dispose") { waitWhy = "dispose"; break; }
            if (raced.kind === "foreign-done") { waitWhy = "done"; break; }
            if (raced.kind === "rejected") {
              if (this.disposed) { waitWhy = "dispose"; break; } // the closed stream, not a turn failure
              throw this.terminalError ?? (raced.error instanceof Error ? raced.error : new Error(String(raced.error)));
            }
            if (raced.value.done) {
              // A stream end observed under dispose is the disposal itself
              // (dispose closes the transport), not a mid-turn transport death.
              if (this.disposed) { waitWhy = "dispose"; break; }
              waitWhy = "stream-end"; break;
            }
            this.frameConsumed();
            this.absorbIdleFrame(raced.value.value); // a result here resolves foreignTurn
          }
          if (waitWhy === "dispose") {
            for (const event of translator.finishTerminal("cancelled")) yield event;
            return;                                    // finally still runs: turnActive=false, etc.
          }
          if (waitWhy === "stream-end") {
            throw this.terminalError ?? new Error("Claude exited during a turn");
          }
          if (waitWhy === "abort") {
            // Owner Stop during the foreign wait. The turn being interrupted
            // is the CLI's own: interrupt immediately (mid-turn Stop
            // semantics), NEVER send the owner input (the user stopped —
            // nothing to inject). The interrupted foreign turn's terminal
            // result{terminal_reason:"aborted_streaming"} is consumed HERE
            // (the owner translator never sees foreign frames); if it does
            // not settle in time, the EXISTING TASK.156 settle deadline
            // terminalizes cancelled. The foreign-turn state is cleared so a
            // later owner turn cannot wait forever for a result already
            // consumed.
            abortObserved = true;
            usageDeliveryActive = false;
            beginInterrupt();
            const open = this.foreignTurn!;
            const settleDeadline = settle!; // beginInterrupt just installed it
            // Keep READING while the interrupted foreign turn settles — its
            // terminal result is consumed by absorbIdleFrame (which resolves
            // `open.done`); the settle deadline is the backstop.
            let stopped: "done" | "settle-timeout" | "stream-end" | "failed" = "done";
            while (open === this.foreignTurn) {
              const why = await Promise.race([
                this.takeFrame().then(
                  (value) => ({ kind: "frame" as const, value }),
                  (error: unknown) => ({ kind: "failed" as const, error }),
                ),
                open.done.promise.then(() => ({ kind: "done" as const })),
                settleDeadline.promise,
              ]);
              if (why.kind === "done") break;
              if (why.kind === "settle-timeout") { stopped = "settle-timeout"; break; }
              if (why.kind === "failed") { stopped = "failed"; this.terminalError ??= why.error instanceof Error ? why.error : new Error(String(why.error)); break; }
              if (why.value.done) { stopped = "stream-end"; break; }
              this.frameConsumed();
              this.absorbIdleFrame(why.value.value);
            }
            this.foreignTurn = null;
            if (stopped === "settle-timeout") {
              const settledError = new Error(
                `Claude did not settle the interrupted turn within ${this.bounds.postInterruptSettleMs}ms; the session was closed. Start a new session to continue.`,
              );
              this.terminalError = settledError;
              void this.client.close().catch(() => {});
              yield {
                type: "engine_notice",
                level: "info",
                message: "Stopped; the engine was still finishing a running command, so this session was closed. Start a new session to continue.",
              };
              // TASK.116: the transport is closed and no live engine remains —
              // signal actual death to Session (the cancelled loop status
              // below is unchanged; this is additive, never an error terminal).
              yield { type: "error", error: settledError, safe: engineDeathSafe(settledError) };
            }
            for (const event of translator.finishTerminal("cancelled")) yield event;
            return; // finally still runs: turnActive=false, reader restart guard, etc.
          }
          // waitWhy === "done": foreign settled normally — the barrier
          // re-runs (drain any backlog buffered behind its result; adjacent
          // foreign turns re-enter the wait above) before any send.
          continue barrier;
        }
        // FINAL SEGMENT — no await or yield from here to the send: readiness,
        // disposal and Stop are re-inspected synchronously. A frame that
        // landed during the last checkpoint's microtask gap is classified
        // before a re-run instead of leaking into the owner turn; a dispose or
        // Stop that landed there cancels instead of injecting owner input.
        if (this.readyFrame !== null) continue barrier;
        if (this.disposed) { sendCancelled = true; break barrier; }
        if (!abortObserved && options.signal.aborted) {
          abortObserved = true;
          usageDeliveryActive = false;
          beginInterrupt();
          break barrier; // fall into the owner loop WITHOUT sending
        }
        // A turn IS a user message on the shared stdin — one process, one
        // session, many turns (probe #1). There is no per-turn request/response.
        // F2: a system-origin frame is HOST/MODEL-authored text, never human
        // input — its line-start slashes are de-fanged so the root session's
        // slash interpretation (w0-17) cannot execute a model-authored
        // command. Human input goes out byte-identical.
        this.client.sendUserMessage(
          userMessageContent(
            options.origin === "system" ? neutralizeSystemOriginSlashes(input) : input,
            options.attachments,
          ),
        );
        break barrier;
      }
      if (sendCancelled) {
        for (const event of translator.finishTerminal("cancelled")) yield event;
        return; // finally still runs: turnActive=false, reader restart guard, etc.
      }

      while (!terminal) {
        const raced = await Promise.race([
          this.takeFrame().then(
            (value) => ({ kind: "notification" as const, value }),
            (error: unknown) => ({ kind: "rejected" as const, error }),
          ),
          ...(abortObserved ? [] : [abort.promise.then(() => ({ kind: "abort" as const }))]),
          // A settled mid-turn context read wakes the race on its own — that
          // is the whole point: the event must surface during a quiet period,
          // with no further stream frame to carry it.
          ...(usageDeliveryActive && !abortObserved && pendingUsage !== null
            ? [pendingUsage.then((completion) => ({ kind: "usage" as const, completion }))]
            : []),
          // Taskana 4056: a live bridge subagent_* event wakes the race on
          // its own — same quiet-period discipline as the usage arm. The
          // promise is cached in the `bridgePending` slot until the loop body
          // consumes it (a losing arm re-arms the same promise), so an event
          // that resolved a losing arm is never stranded; a `null` resolution
          // (dispose, or a swept turn) is harmlessly skipped below.
          this.nextBridgeEvent().then((event) => ({ kind: "bridge-event" as const, event })),
          ...settleRacers(),
        ]);
        if (raced.kind === "bridge-event") {
          // Consume the cached slot EXACTLY once, before touching raced.value
          // — same discipline as the `usage` arm above. A `null` here is a
          // wake with nothing to deliver (dispose, or an event consumed by an
          // earlier arm of this same race): skip and re-arm.
          this.consumeBridgeSlot();
          if (raced.event !== null) yield raced.event;
          continue;
        }
        if (raced.kind === "usage") {
          // Consume the local slot EXACTLY once, before touching raced.value.
          pendingUsage = null;
          if (raced.completion.event !== null) yield raced.completion.event;
          continue;
        }
        if (raced.kind === "abort") {
          abortObserved = true;
          // TASK.157: an observed Stop disables mid-turn usage delivery — a
          // measurement settling after the abort must never surface as a
          // context_usage of the dying turn.
          usageDeliveryActive = false;
          beginInterrupt();
          continue;
        }
        if (raced.kind === "settle-timeout") {
          // TASK.156: a Stop that cannot settle in time is cancellation.
          // Close the unsettled transport so a late result cannot end a
          // subsequent turn; the terminal latch requires a new session.
          if (abortObserved) {
            const settledError = new Error(
              `Claude did not settle the interrupted turn within ${this.bounds.postInterruptSettleMs}ms; the session was closed. Start a new session to continue.`,
            );
            this.terminalError = settledError;
            void this.client.close().catch(() => {});
            yield {
              type: "engine_notice",
              level: "info",
              message: "Stopped; the engine was still finishing a running command, so this session was closed. Start a new session to continue.",
            };
            // TASK.116: additive death signal — see the foreign-turn branch above.
            yield { type: "error", error: settledError, safe: engineDeathSafe(settledError) };
            for (const event of translator.finishTerminal("cancelled")) yield event;
            return;
          }
          throw new Error(`Claude did not settle the interrupted turn within ${this.bounds.postInterruptSettleMs}ms`);
        }
        if (raced.kind === "rejected") {
          // TASK.189: the cached read rejected — same terminal path the old
          // `await next` rejection took (the catch below owns it).
          throw raced.error;
        }
        if (raced.value.done) {
          // Transport closed under a pending Stop (e.g. Stop then tab close):
          // that is the cancellation the user asked for, not an engine error.
          if (abortObserved) {
            for (const event of translator.finishTerminal("cancelled")) yield event;
            return;
          }
          throw this.terminalError ?? new Error("Claude exited during a turn");
        }
        // TASK.189: the slot's frame is consumed by THIS loop iteration; the
        // next iteration's takeFrame() re-parks. Exactly one read in flight.
        this.frameConsumed();
        // TASK.157: at user/tool-result and assistant boundaries, kick off a
        // throttled, non-overlapping mid-turn context refresh. Never awaited
        // here — the completion rides the race above.
        if (!abortObserved && (raced.value.value.type === "user" || raced.value.value.type === "assistant")) {
          if (pendingUsage === null && this.contextUsageInFlight === null) {
            const now = Date.now();
            if (this.lastMidTurnUsageReadAt === null || now - this.lastMidTurnUsageReadAt >= this.bounds.midTurnContextUsageIntervalMs) {
              this.lastMidTurnUsageReadAt = now;
              pendingUsage = this.readMidTurnContextUsage();
            }
          }
        }
        for (const event of translator.onMessage(raced.value.value)) {
          if (event.type === "loop_end") terminal = true;
          yield event;
        }
        // Taskana 4238: MCP failure notices from THIS turn's own init are
        // yielded inside the same turn (a notice only travels inside a turn;
        // queueing them into settings.notices would defer them to the next
        // turn's pre-send drain).
        if (this.mcpStatusNotices.length > 0) {
          for (const notice of this.mcpStatusNotices.splice(0)) yield notice;
        }
      }

      // The ctx meter, AFTER the terminal result and only for a turn that
      // actually ran (cut §1.4 table: "result -> turn_end + loop_end; следом
      // ctx-метр"). Session drains the full iterable, so an event yielded
      // after loop_end still reaches the UI. TASK.157: the final read is
      // UNCONDITIONAL — never throttled by, and never merged with, a mid-turn
      // refresh. Any physical request still in flight is awaited first (it
      // never rejects) so the two can never overlap; the turn-local pending
      // event is discarded here so it cannot fire after this point.
      pendingUsage = null;
      usageDeliveryActive = false;
      await this.awaitContextUsageInFlight();
      const usage = await this.readContextUsage();
      if (usage !== null) yield usage;
      // TASK.159: session-cumulative token accounting, next to the context
      // meter read above. `lastTurnTokenUsage` is null when this turn's
      // `result.usage` was absent/malformed — no event this turn (fail-soft,
      // never invents a number). CUMULATIVE by contract (events.ts's own
      // `engine_session_tokens` doc): the telemetry tap (records.ts,
      // `buildEngineTelemetryTap`) is the ONLY code allowed to diff this
      // against a previous snapshot.
      const turnTokens = this.consumeLastTurnTokenUsage();
      if (turnTokens !== null) {
        this.cumulativeInputTokens += turnTokens.input;
        this.cumulativeOutputTokens += turnTokens.output;
        yield {
          type: "engine_session_tokens",
          input: this.cumulativeInputTokens,
          output: this.cumulativeOutputTokens,
          total: this.cumulativeInputTokens + this.cumulativeOutputTokens,
        };
      }
    } catch (error) {
      const terminalError = this.terminalError ?? (error instanceof Error ? error : new Error(String(error)));
      this.terminalError = terminalError;
      this.approvals?.denyAll("Claude transport failed", "turn_cancelled");
      // A turn that lost its transport releases the child.
      void this.client.close().catch(() => {});
      yield { type: "error", error: terminalError, safe: engineDeathSafe(terminalError) };
      yield* this.terminalEvents(turn, terminalError, false);
    } finally {
      this.turnActive = false;
      cancelSettle();
      abort.dispose();
      // Taskana 4056 cross-review P1: a turn that terminalized without the
      // paired top-level tool_result (cancelled/dying) must not leave the
      // bridge's stamped presentation behind in the host's map for the
      // process's lifetime — drop what the translator's single terminal path
      // recorded as abandoned. MCP tool_use ids are per-call, so a later turn
      // can never legitimately consume them.
      if (this.dropPresentations !== undefined && translator.abandonedToolUseIds().length > 0) {
        try {
          this.dropPresentations(translator.abandonedToolUseIds());
        } catch {
          // A host-side sweep failure must never fail the turn's cleanup.
        }
      }
      // Taskana 4056: settle the bridge-event seam with the turn — wake a
      // still-parked waiter with the spurious `null` and re-queue any
      // resolved-but-unconsumed event, so the next turn's send barrier (not a
      // dead arm of THIS turn) delivers anything that lands after this point.
      this.sweepBridgeSlot();
      // TASK.157: drop the turn-local mid-turn refresh state. The local
      // completion slot dies with the turn; a still-running PHYSICAL guard
      // (`contextUsageInFlight`) is deliberately NOT cleared — it settles
      // silently on its own and emits nothing into later turns.
      pendingUsage = null;
      usageDeliveryActive = false;
      // TASK.189: restart the idle reader for the between-turns window. Safe
      // even if the turn threw: takeFrame() re-parks on the (possibly closed)
      // stream and the done path parks the reader.
      if (!this.disposed && this.terminalError === null) this.runIdleReader();
    }
  }

  /**
   * TASK.92: manual compaction over the allowlisted slash passthrough. The
   * engine spawn omits `--disable-slash-commands` (see `connectClaudeEngine`),
   * and the CLI interprets a leading `/command` in a stream-json user frame
   * (w0-17 evidence, committed fixture) — so the whole native compaction
   * cycle is driven by ONE host-built frame: `CLAUDE_SLASH_ALLOWLIST[0]`,
   * never a free-form string. The ambient catalog that the missing flag also
   * exposes is NEVER surfaced or proxied: AnyCode shows its own SLASH_COMMANDS
   * registry, and this method is the only slash frame host code ever builds.
   *
   * Mirrors `runTurn`'s proven skeleton: single-owner stream takeover
   * (TASK.189), one abort race per await, a settle-deadline backstop after an
   * interrupt, idle-reader restore in `finally`. Like `AgentLoop.compactNow`
   * it never throws — every failure surfaces as `compaction_end { ok:false }`.
   */
  async *compactNow(options: { signal: AbortSignal }): AsyncIterable<AgentEvent> {
    if (this.terminalError !== null || this.disposed) {
      yield { type: "compaction_end", ok: false, preTokens: 0, durationMs: 0, error: "engine closed" };
      return;
    }
    if (this.settings?.slashPassthrough !== true) {
      // The CLI was spawned with --disable-slash-commands: /compact would
      // reach the model as ordinary text, not run a compaction.
      yield { type: "compaction_end", ok: false, preTokens: 0, durationMs: 0, error: "manual compaction unavailable in this session" };
      return;
    }
    this.stopIdleReader();
    this.turnActive = true;
    yield { type: "compaction_start", trigger: "manual" };
    const startedAt = Date.now();
    const abort = watchAbort(options.signal);
    this.interruptSent = false;
    let ok = false;
    let error: string | undefined;
    let preTokens = 0;
    let terminal = false;
    let abortObserved = false;
    let cancelledBeforeSend = false;
    let settle: SettleDeadline | null = null;
    const cancelSettle = (): void => settle?.cancel();

    // The pre-compaction meter reading, taken BEFORE the frame is sent (the
    // swap invalidates any later reading as a "pre" number). Fail-soft: an
    // unusable reading yields preTokens 0, never blocks the compaction.
    try {
      await this.awaitContextUsageInFlight();
      const reading = await this.client.getContextUsage();
      const event = this.mapContextUsageReading(reading, false);
      if (event !== null && event.type === "context_usage") preTokens = event.estimatedTokens;
    } catch {
      // preTokens stays 0 — same fail-soft posture as mapContextUsageReading.
    }

    try {
      // ── cross-review F4: the SEND BARRIER, `runTurn`'s own discipline. The
      // /compact frame is sent only once no CLI-self-started (foreign) turn
      // is still running: without the wait, the compaction's loop treats the
      // FIRST `result` it sees as its terminal verdict — the FOREIGN turn's,
      // whose subtype says nothing about compaction (a wrong ok either way,
      // while two turns' frames interleave on one stream). While waiting,
      // THIS loop is the single reader and every arriving frame is classified
      // by absorbIdleFrame (a foreign `result` closes foreignTurn and ends
      // the wait). NO TIMER, NO AUTO-INTERRUPT — an unsolicited turn may run
      // arbitrarily long; the user's abort below and the settle deadline
      // remain the only bounds.
      while (this.foreignTurn !== null) {
        yield { type: "engine_notice", level: "info",
          message: "Claude is finishing a turn it started on its own; the compaction will run when it finishes." };
        const foreignDone = this.foreignTurn.done.promise;
        const raced = await Promise.race([
          abort.promise.then(() => ({ kind: "abort" as const })),
          foreignDone.then(() => ({ kind: "foreign-done" as const })),
          this.takeFrame().then(
            (value) => ({ kind: "notification" as const, value }),
            (error_: unknown) => ({ kind: "rejected" as const, error: error_ }),
          ),
        ]);
        if (raced.kind === "abort") {
          // The user's Stop outranks the wait — and, exactly like runTurn's
          // barrier, it means NEVER send: the compaction never started, so
          // nothing is interrupted (the foreign turn is the CLI's own and
          // keeps running; the idle reader restarted below absorbs it). A
          // /compact sent after Stop would queue behind the foreign turn and
          // run a compaction the user cancelled, unobserved (Taskana 4098
          // review).
          cancelledBeforeSend = true;
          break;
        }
        if (raced.kind === "foreign-done") continue; // re-check: an adjacent foreign turn may have opened
        if (raced.kind === "rejected") throw raced.error;
        this.frameConsumed();
        if (raced.value.done) throw this.terminalError ?? new Error("Claude exited during compaction");
        this.absorbIdleFrame(raced.value.value); // a result here resolves foreignTurn
      }

      // A compaction turn reuses the ordinary frame vocabulary: `--replay-user-messages`
      // echoes the /compact frame (discarded like any user echo), `system` init /
      // `status:"compacting"` pings are ignored, and the terminal `result` decides.
      // (F3: INSIDE the try — the client's write guard can throw when stdin is
      // already gone or the client latched a terminal error in the window
      // between the engine's idle checks and this send; the catch below turns
      // that into an honest compaction_end{ok:false} instead of a throw out
      // of the generator after compaction_start was already yielded.)
      if (cancelledBeforeSend) {
        terminal = true; // ok stays false
        error = "cancelled";
      } else {
        this.client.sendUserMessage(CLAUDE_SLASH_ALLOWLIST[0]);
      }

      while (!terminal) {
        const raced = await Promise.race([
          this.takeFrame().then(
            (value) => ({ kind: "notification" as const, value }),
            (error_: unknown) => ({ kind: "rejected" as const, error: error_ }),
          ),
          ...(abortObserved ? [] : [abort.promise.then(() => ({ kind: "abort" as const }))]),
          ...(settle === null ? [] : [settle.promise]),
        ]);
        if (raced.kind === "abort") {
          abortObserved = true;
          // NOT sendInterruptOnce — that helper is turn-latched via
          // interruptSent/turnActive and was reset above; call the client
          // directly so exactly one interrupt goes out for this cycle.
          try {
            await this.client.interrupt();
          } catch {
            // Best-effort: the settle deadline below is the backstop.
          }
          settle = deadline(this.bounds.postInterruptSettleMs);
          continue;
        }
        if (raced.kind === "settle-timeout") {
          // The interrupted compaction never settled — close with an honest
          // failure. The transport stays open (unlike runTurn's settle path):
          // a wedged compaction is not proof the SESSION is dead.
          terminal = true;
          ok = false;
          error = "interrupt settle timeout";
          break;
        }
        if (raced.kind === "rejected") {
          throw raced.error;
        }
        if (raced.value.done) {
          throw this.terminalError ?? new Error("Claude exited during compaction");
        }
        this.frameConsumed();
        const frame = raced.value.value;
        if (frame.type === "system") {
          continue; // init re-emit or status ping — state, not compaction outcome
        }
        if (frame.type === "result") {
          terminal = true;
          // cross-review F7: cost IS session state — a manual compaction runs
          // a REAL summarization model call, and its `total_cost_usd`/`usage`
          // feed the session-cumulative counters exactly like any foreign
          // turn's result (absorbIdleFrame's own result branch routes through
          // onResult too). NO engine_session_tokens is emitted for a
          // compaction (deliberate: REPLACE-semantics consumer — see the
          // comment at the compaction_end yield); the counters are simply
          // kept honest so the next owner turn's cumulative report includes
          // the summarization call's tokens.
          this.onResult(frame as unknown as ClaudeResultMessage);
          this.consumeCompactionTokenUsage();
          // Tolerant subtype read: the pinned union names "success" today, but
          // a compaction result may carry a success variant we have not pinned
          // (e.g. "success_clears") — anything success-prefixed is a pass,
          // never an invented subtype on the wire out.
          const subtype = (frame as ClaudeResultMessage).subtype;
          const subtypeText = typeof subtype === "string" ? subtype : "unknown";
          ok = subtypeText === "success" || subtypeText.startsWith("success_");
          if (!ok) error = subtypeText;
          continue;
        }
        // Everything else (the replayed /compact user echo, assistant frames
        // of the summarization turn, stream_events) is discarded silently.
      }
    } catch (error_) {
      // A rejected takeFrame is terminal engine state — copy runTurn's catch.
      const terminalError = this.terminalError ?? (error_ instanceof Error ? error_ : new Error(String(error_)));
      this.terminalError = terminalError;
      this.approvals?.denyAll("Claude transport failed", "turn_cancelled");
      void this.client.close().catch(() => {});
      ok = false;
      error = terminalError.message;
    } finally {
      this.turnActive = false;
      this.interruptSent = false;
      cancelSettle();
      abort.dispose();
    }

    yield { type: "compaction_end", ok, preTokens, durationMs: Date.now() - startedAt, ...(error !== undefined ? { error } : {}) };
    // Post-swap meter refresh, mirroring the turn-end read: the compacted
    // window's own accounting is only readable AFTER the CLI swapped it in.
    if (!this.disposed && this.terminalError === null) {
      const usage = await this.readContextUsage();
      if (usage !== null) yield usage;
    }
    if (!this.disposed && this.terminalError === null) this.runIdleReader();
  }

  dispose(_reason: "session-close" | "host-shutdown"): Promise<void> {
    this.disposed = true;
    this.approvals?.denyAll("Claude engine is shutting down", "shutdown");
    // TASK.189: epoch bump + wake stops the idle reader; the disposal wait
    // settles a waiting owner turn, which terminalizes cancelled.
    this.stopIdleReader();
    this.resolveDisposalWait();
    // Taskana 4056: wake the parked bridge-event race arm (it resolves `null`
    // against the now-emptied queue, so its turn loop just continues into the
    // disposal/terminal path) and drop the queue itself — no parked promise
    // leaks and a detached child's late progress cannot surface into a future
    // turn.
    this.bridgeEvents = [];
    const bridgeWaiters = this.bridgeWaiters;
    this.bridgeWaiters = [];
    for (const w of bridgeWaiters) w.resolve(null);
    void this.sendInterruptOnce();
    return this.client.close();
  }

  /**
   * TASK.157: the shared mapping/validation half of `readContextUsage`. When
   * `applyModel` is set (the FINAL read only — a mid-turn refresh must never
   * patch `liveModel` from a reading whose turn may already be closed), a
   * string `usage.model` is applied to `liveModel` BEFORE the numeric gate,
   * exactly the pre-TASK.157 final-read ordering. Invalid numbers return
   * `null`; the caller decides whether that is silent (mid-turn) or logged
   * (final, fail-soft).
   */
  private mapContextUsageReading(usage: Record<string, unknown>, applyModel: boolean): AgentEvent | null {
    const totalTokens = usage.totalTokens;
    const maxTokens = usage.maxTokens;
    if (applyModel && typeof usage.model === "string") this.liveModel = usage.model;
    if (
      typeof totalTokens !== "number" || !Number.isFinite(totalTokens) || totalTokens < 0 ||
      typeof maxTokens !== "number" || !Number.isFinite(maxTokens) || maxTokens <= 0
    ) {
      return null;
    }
    return { type: "context_usage", estimatedTokens: totalTokens, budgetTokens: maxTokens, source: "provider" };
  }

  /**
   * TASK.157: a mid-turn context refresh. Fully SILENT — a failed or malformed
   * reading emits nothing, logs nothing, and never disrupts the turn. The
   * returned promise never rejects. It also installs/holds the engine-level
   * physical in-flight guard until the underlying request actually settles.
   */
  private readMidTurnContextUsage(): Promise<{ kind: "usage"; event: AgentEvent | null }> {
    const request = this.client.getContextUsage().then(
      (usage) => this.mapContextUsageReading(usage, false),
      () => null,
    );
    this.contextUsageInFlight = request;
    void request.then(() => {
      // Promise identity check: only the request that installed the guard
      // clears it — a late callback from an earlier request cannot lift the
      // guard for a newer one.
      if (this.contextUsageInFlight === request) this.contextUsageInFlight = null;
    });
    return request.then((event) => ({ kind: "usage" as const, event }));
  }

  /** TASK.157: waits out any physically in-flight context read (never rejects). */
  private async awaitContextUsageInFlight(): Promise<void> {
    while (this.contextUsageInFlight !== null) {
      try {
        await this.contextUsageInFlight;
      } catch {
        // The mid-turn path never rejects; this is belt-and-braces so the
        // final unconditional read can never be skipped by a throw.
      }
      // Loop: the await may have observed a request that was already replaced.
    }
  }

  /**
   * The $0 context read (`get_context_usage`) that feeds the meter. Its
   * `totalTokens`/`maxTokens` are the CLI's OWN accounting of the model's
   * window — the one thing a host-side sum of `result.usage` can never get
   * right (the window size is not on the result frame at all).
   */
  private async readContextUsage(): Promise<AgentEvent | null> {
    try {
      const usage = await this.client.getContextUsage();
      const event = this.mapContextUsageReading(usage, true);
      if (event === null) {
        // Shape drift is the other way this read dies silently: the request
        // succeeded, so the catch below never fires, yet the meter stays blank.
        // Only the two numbers are logged — the rest of the payload carries
        // custody-sensitive metadata (memoryFiles[] paths, C2).
        const totalTokens = usage.totalTokens;
        const maxTokens = usage.maxTokens;
        console.error(
          `[claude] get_context_usage returned an unusable reading: totalTokens=${JSON.stringify(totalTokens)} maxTokens=${JSON.stringify(maxTokens)}`,
        );
        return null;
      }
      return event;
    } catch (error) {
      // A failed read leaves the meter at its last value rather than painting a
      // wrong one; it is never a turn failure. Logged rather than swallowed
      // silently: a meter that never appears is otherwise indistinguishable
      // from one the engine never tried to read, and this catch is the only
      // place the difference is observable.
      console.error(`[claude] get_context_usage failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /** `system/init` arrives on EVERY turn (probe #1) — repeated inits refresh state silently. */
  private onSystemInit(init: ClaudeSystemInitMessage): void {
    this.sessionId = init.session_id;
    this.liveModel = init.model;
    this.livePermissionMode = init.permissionMode;
    this.liveMcpServerNames = parseClaudeInitMcpServerNames(init.mcp_servers);
    // Taskana 4238: a failed/needs-auth MCP server must be VISIBLE, not just
    // present in the name list (the old parsing dropped `status`, so a failed
    // "anycode" counted as healthy). One notice per server name per session —
    // init repeats every turn, the warning must not.
    this.liveMcpServerStatuses = parseClaudeInitMcpServerStatuses(init.mcp_servers);
    for (const entry of this.liveMcpServerStatuses) {
      if (entry.status !== "failed" && entry.status !== "needs-auth") continue;
      if (this.reportedMcpFailures.has(entry.name)) continue;
      this.reportedMcpFailures.add(entry.name);
      console.warn(`[claude] mcp server "${entry.name}" status ${entry.status}`);
      // Single-entry call: the notice is guaranteed to be this server's own.
      this.mcpStatusNotices.push(...mcpServerFailureNotices([entry]));
    }
    this.reconcileFromInit(init);
    if (!this.firstInitSeen) {
      this.firstInitSeen = true;
      for (const listener of this.firstInitListeners) {
        try {
          listener({
            sessionId: init.session_id,
            model: init.model,
            permissionMode: init.permissionMode,
            mcpServerNames: this.liveMcpServerNames,
            mcpServerStatuses: this.liveMcpServerStatuses,
          });
        } catch {
          // A first-init observer is a side-channel (row materialization,
          // resume settle); it can never fail a turn.
        }
      }
      this.firstInitListeners.clear();
    }
  }

  /**
   * Adopts the CLI's OWN posture into the engine's settings (cut §1.5 hazard
   * (б): the first `system/init` of a resumed session is the truth, not our
   * persisted row). Runs on every init, which is a no-op for a fresh session
   * that already spawned under exactly this posture.
   *
   * The model comparison is deliberately RESOLVED-vs-RESOLVED. `init.model` is
   * a resolved id (`claude-opus-4-8[1m]`) while the catalog value we hold is
   * the selectable alias (`opus[1m]`), and several aliases DO share one
   * resolved id live (`default` and `opus[1m]` both resolve to
   * `claude-opus-4-8[1m]`) — so adopting on every init would flip a perfectly
   * correct `opus[1m]` selection to whichever alias is listed first. The
   * current selection is therefore kept whenever it already resolves to what
   * the CLI reports; only a genuine divergence adopts a new entry, and
   * `selectableForResolved` then picks a concrete alias over `default`.
   */
  private reconcileFromInit(init: ClaudeSystemInitMessage): void {
    const settings = this.settings;
    if (settings === undefined) return;
    if (!settings.catalog.readBackMatches(settings.model, init.model)) {
      const entry = settings.catalog.selectableForResolved(init.model);
      if (entry !== undefined) settings.model = entry.value;
    }
    const preset = findClaudePresetByMode(init.permissionMode);
    if (preset !== undefined) settings.preset = preset;
  }

  /**
   * Fires ONCE, on the first turn-scoped `system/init` this engine observes —
   * the moment the native session provably materialized (probe #1: init is
   * emitted per TURN, never at handshake, so nothing before this proves a
   * resumable native session exists). The host uses it for native-first row
   * creation and the resume settle-patch (cut §1.5 hazard (а)/(б)). A listener
   * registered after the first init has already been seen is invoked
   * immediately with the latched values.
   */
  onFirstSystemInit(listener: (init: { sessionId: string; model: string; permissionMode: ClaudeWirePermissionMode; mcpServerNames: string[]; mcpServerStatuses: ClaudeInitMcpServerStatus[] }) => void): void {
    if (this.firstInitSeen) {
      if (this.sessionId !== null && this.liveModel !== null && this.livePermissionMode !== null) {
        listener({
          sessionId: this.sessionId,
          model: this.liveModel,
          permissionMode: this.livePermissionMode,
          mcpServerNames: this.liveMcpServerNames ?? [],
          mcpServerStatuses: this.liveMcpServerStatuses ?? [],
        });
      }
      return;
    }
    this.firstInitListeners.add(listener);
  }

  /**
   * TASK.159: turn-scoped reset for `lastTurnTokenUsage`, called at the top
   * of `runTurn`. Factored into its own method rather than a direct
   * `this.lastTurnTokenUsage = null` inline in `runTurn` — with the direct
   * form, this TypeScript toolchain's flow analysis anchors the field's
   * narrowed type on that literal reset and never widens it back across the
   * turn's later `await`s/`yield`s (even though `onResult` below reassigns
   * it in between), so the later read sees a bogus `never`. Routing the
   * write and the read (`consumeLastTurnTokenUsage` below) through their own
   * methods keeps `runTurn`'s own body free of any direct assignment to this
   * field, which sidesteps the false narrowing (verified: the same
   * class-shape repro type-checks with this split, not with the inline form).
   */
  private resetTurnTokenUsage(): void {
    this.lastTurnTokenUsage = null;
  }

  /** TASK.159: reads AND clears `lastTurnTokenUsage` — see resetTurnTokenUsage's doc comment for why this is a method, not an inline `this.lastTurnTokenUsage` read. */
  private consumeLastTurnTokenUsage(): { input: number; output: number } | null {
    const value = this.lastTurnTokenUsage;
    this.lastTurnTokenUsage = null;
    return value;
  }

  /**
   * cross-review F7: a manual compaction's own `result.usage` (set by the
   * `onResult` call on the compaction's result branch) folds into the
   * SESSION-CUMULATIVE counters immediately — the summarization call's tokens
   * must not silently vanish from the session's accounting — but emits NO
   * `engine_session_tokens` event: that event's consumer (the renderer's
   * sessionTokens chip, store.ts) REPLACES its snapshot, and a compaction is
   * not a turn — the next owner turn's cumulative report carries the sum.
   * Same method-split discipline as consumeLastTurnTokenUsage above.
   */
  private consumeCompactionTokenUsage(): void {
    const value = this.lastTurnTokenUsage;
    this.lastTurnTokenUsage = null;
    if (value !== null) {
      this.cumulativeInputTokens += value.input;
      this.cumulativeOutputTokens += value.output;
    }
  }

  private costObserver?: (result: ClaudeResultMessage) => void;
  onCostResult(observer: (result: ClaudeResultMessage) => void): void { this.costObserver = observer; }
  private onResult(result: ClaudeResultMessage): void {
    this.costObserver?.(result);
    if (typeof result.total_cost_usd === "number" && Number.isFinite(result.total_cost_usd)) {
      this.totalCostUsd += result.total_cost_usd;
    }
    // TASK.159: `result.usage` is untyped wire data (protocol.ts's own
    // `Record<string, unknown>`), never guaranteed present — a tolerant read
    // of exactly the two fields this session's lifetime-token accounting
    // needs. Cached/creation token fields on this object are deliberately
    // NOT read (TASK.111 stays out of scope, both engines and core equally).
    const usage = result.usage;
    const inputTokens = usage !== undefined ? usage.input_tokens : undefined;
    const outputTokens = usage !== undefined ? usage.output_tokens : undefined;
    if (
      typeof inputTokens === "number" && Number.isFinite(inputTokens) &&
      typeof outputTokens === "number" && Number.isFinite(outputTokens)
    ) {
      this.lastTurnTokenUsage = { input: inputTokens, output: outputTokens };
    }
  }

  /** The CLI's own session id, once a turn has produced a `system/init`. */
  nativeSessionId(): string | null {
    return this.sessionId;
  }

  /** The model the CLI reports it is actually running (a RESOLVED id — compare via the catalog, never by string equality with the request). */
  resolvedModel(): string | null {
    return this.liveModel;
  }

  /** The wire-level permission mode the CLI reports it is actually running (CC-D resume settle). */
  resolvedPermissionMode(): ClaudeWirePermissionMode | null {
    return this.livePermissionMode;
  }

  /**
   * Queues a notice for the NEXT turn's stream (same drain path boot notices
   * use — an `AgentEvent` only travels inside a turn). Used by the
   * Claude-settings-seam glue (CC-D-min, cut §1.5) to surface an async
   * set_model/set_permission_mode ack-failure that happens BETWEEN turns,
   * when there is no live stream to emit it on directly.
   */
  queueNotice(notice: AgentEvent): void {
    this.settings?.notices.push(notice);
  }

  /**
   * Taskana 4056: the host's bridge `callTool` pushes live subagent_* events
   * here mid-turn (core's `runAgentBridgeCall` stamps every progress event
   * through `deps.onEvent`). A live turn's race drains them between stream
   * frames; events pushed with NO live turn (a detached child's post-turn
   * progress, or between turns) simply wait in `bridgeEvents` — flushed by the
   * NEXT turn's send barrier. Waking all waiters (not one) is deliberate: each
   * parked arm re-checks the queue itself, so arms woken after their event was
   * taken by an earlier arm resolve `null` and are skipped — never a
   * double-delivery.
   */
  pushBridgeEvent(event: AgentEvent): void {
    // Direct hand to the parked waiter when one exists (the slot's promise
    // stays cached until the winning loop body consumes it); otherwise buffer
    // for the next `nextBridgeEvent()` call or the next turn's send-barrier
    // flush. Queue and parked waiter are mutually exclusive at rest, so the
    // barrier's splice can never race a handoff.
    const waiter = this.bridgeWaiters.shift();
    if (waiter !== undefined) {
      waiter.resolve(event);
      return;
    }
    this.bridgeEvents.push(event);
  }

  /**
   * Taskana 4056: take one buffered bridge event, or `null` when none is
   * queued. A waiter woken after its event was consumed (drained by the send
   * barrier) must resolve `null`, never resurrect a drained event.
   */
  private takeBridgeEvent(): AgentEvent | null {
    return this.bridgeEvents.shift() ?? null;
  }

  /**
   * Taskana 4056: the owner loop's bridge race arm — resolves one event, or
   * `null` on a wake with nothing to deliver (dispose, or a swept turn). The
   * promise is cached in the `bridgePending` slot until the loop body consumes
   * the slot: a losing arm of one iteration re-arms the SAME promise the next
   * iteration, so an event resolved into an arm that lost its race is never
   * stranded, and exactly one loop body ever yields it. Resolving (not
   * rejecting) is what lets `dispose`/the turn's sweep wake a parked arm
   * without failing the turn.
   */
  private nextBridgeEvent(): Promise<AgentEvent | null> {
    if (this.bridgePending === null) {
      const now = this.takeBridgeEvent();
      if (now !== null) {
        const promise = Promise.resolve(now);
        this.bridgePending = { promise, settled: true, event: now };
      } else {
        let parkedResolve!: (event: AgentEvent | null) => void;
        const promise = new Promise<AgentEvent | null>((resolve) => {
          parkedResolve = resolve;
        });
        const slot = { promise, settled: false as boolean, event: null as AgentEvent | null };
        this.bridgePending = slot;
        this.bridgeWaiters.push({
          resolve: (event) => {
            slot.settled = true;
            slot.event = event;
            parkedResolve(event);
          },
        });
      }
    }
    return this.bridgePending.promise;
  }

  /**
   * Taskana 4056: the loop body's slot consumption — called ONLY after a
   * `bridge-event` raced result, for `null` and event alike. Clearing on
   * `null` matters as much as on an event: a resolved-`null` promise left in
   * the slot would win every later race immediately and spin the loop.
   */
  private consumeBridgeSlot(): void {
    this.bridgePending = null;
  }

  /**
   * Taskana 4056: settle the turn's bridge state — called from `runTurn`'s
   * `finally`. A waiter parked by the final race iteration is woken with the
   * harmless spurious `null` (its dead arm resolves and is never awaited
   * again), so an event pushed after the turn ended cannot be captured by a
   * waiter of a finished turn — it stays queued for the next turn's send
   * barrier. An event-resolved slot the loop never consumed (the turn
   * terminalized on another arm in the same race tick) is re-queued AHEAD of
   * the buffer (it is the oldest), so nothing is lost either way.
   */
  private sweepBridgeSlot(): void {
    const slot = this.bridgePending;
    this.bridgePending = null;
    for (const waiter of this.bridgeWaiters.splice(0)) waiter.resolve(null);
    if (slot !== null && slot.settled && slot.event !== null) {
      this.bridgeEvents.unshift(slot.event);
    }
  }

  /** Taskana 4056: splice ALL queued bridge events (the send-barrier flush). */
  private drainBridgeEvents(): AgentEvent[] {
    return this.bridgeEvents.splice(0);
  }

  /**
   * Exactly one `interrupt` per turn. A second one could only add an
   * unanswerable pending request while the turn settles; the bounded settle
   * deadline in `runTurn` remains the terminal backstop.
   */
  private async sendInterruptOnce(): Promise<void> {
    if (this.interruptSent || !this.turnActive) return;
    this.interruptSent = true;
    try {
      await this.client.interrupt();
    } catch {
      // The receipt is best-effort: the turn's own terminal `result` (or the
      // settle deadline) still closes the turn.
    }
  }

  // ── TASK.189: single-owner notification stream ─────────────────────────────

  /** Exactly ONE pending read of the stream exists at any moment. The read is
   *  created once and cached; its fulfillment lands in `readyFrame` (the only
   *  `.then` handler runs in a microtask, which is what `readyFrame`'s
   *  checkpoint relies on), while a REJECTION stays
   *  parked in `pendingNext` for the next owner turn's catch to observe — it
   *  is never silently cleared by idle code. */
  private takeFrame(): Promise<IteratorResult<ClaudeStreamMessage>> {
    if (this.pendingNext === null) {
      const read = this.client.notifications()[Symbol.asyncIterator]().next();
      this.pendingNext = read;
      read.then(
        (value) => {
          if (this.pendingNext === read) this.readyFrame = value;
        },
        () => {
          // Rejection stays parked in the slot; only the OWNER loop awaits it
          // (the idle reader treats a rejected read as "drop and park" without
          // clearing it — clearing would assume the next read also fails).
        },
      );
    }
    return this.pendingNext;
  }

  /** Called only after a frame (or done) has been fully consumed by its reader. */
  private frameConsumed(): void {
    this.pendingNext = null;
    this.readyFrame = null;
  }

  /** TASK.189: does this frame PROVE the CLI is running a turn we did not ask
   *  for? Deliberately narrow: assistant and genuine (non-replay) user and
   *  stream_event only. Idle noise (system status, rate_limit_event) is not a
   *  turn; a replay/local-command user echo is OUR OWN input coming back, not
   *  evidence of a new CLI turn (TASK.189; see event-translator's onUser). */
  private isForeignTurnFrame(frame: ClaudeStreamMessage): boolean {
    if (frame.type === "assistant" || frame.type === "stream_event") return true;
    if (frame.type === "user") {
      const user = frame as { isReplay?: boolean; message?: { content?: unknown } };
      if (user.isReplay === true) return false;
      // A bare-string user frame is our own input echo (or a local-command
      // stdout acknowledgement without the replay marker) — idle noise here.
      return Array.isArray(user.message?.content);
    }
    return false;
  }

  /** TASK.189: classification applied by BOTH idle and pre-send drains. Returns
   *  nothing; mutates engine state only. Foreign frames NEVER reach an owner
   *  turn's translator. */
  private absorbIdleFrame(frame: ClaudeStreamMessage): void {
    try {
      if (frame.type === "system" && (frame as { subtype?: string }).subtype === "init") {
        // Live posture is state, not transcript: reconcile even mid-foreign-turn.
        this.onSystemInit(frame as unknown as ClaudeSystemInitMessage);
        // Taskana 4238: an init absorbed OUTSIDE an owner turn has no live
        // stream to yield MCP failure notices on, so they take the boot-notice
        // path (queueNotice -> next turn's pre-send barrier drain). The
        // owner-turn case does NOT route through settings.notices — that path
        // only drains pre-send, which would defer the warning to the SECOND
        // turn; runTurn's own drain yields them in the current turn instead.
        if (this.mcpStatusNotices.length > 0) {
          for (const notice of this.mcpStatusNotices.splice(0)) this.queueNotice(notice);
        }
        return;
      }
      if (frame.type === "result") {
        // A result belonging to no owner turn: closes the open foreign turn
        // (if any). Cost IS session state (onResult); the turn-local usage it
        // set is NOT — an absorbed turn owns no meter/token accounting, so the
        // owner turn's own top-of-turn reset is re-asserted here (onResult
        // sets lastTurnTokenUsage; the owner's numbers must stay its own).
        this.onResult(frame as unknown as ClaudeResultMessage);
        this.resetTurnTokenUsage();
        const open = this.foreignTurn;
        this.foreignTurn = null;
        open?.done.resolve();
        return;
      }
      if (this.foreignTurn === null && this.isForeignTurnFrame(frame)) {
        let settle: () => void = () => {};
        const promise = new Promise<void>((resolve) => { settle = resolve; });
        this.foreignTurn = { done: { promise, resolve: settle } };
        this.queueNotice({
          type: "engine_notice", level: "info",
          message: "Claude started a turn on its own (likely a cross-session notice); its output is kept out of this transcript.",
        });
      }
      // Everything else — including frames while a foreign turn is already
      // open — is absorbed silently. rate_limit_event quota state is NOT
      // merged (the quota tap is turn-scoped in this cut; a documented
      // limitation, not silently pretended).
    } catch {
      // An absorption bug must never surface as an unhandled rejection from
      // an idle callback; the next owner turn still owns the stream.
    }
  }

  /** TASK.189: the between-turns (and pre-first-turn) reader. Catches its own
   *  rejection; NEVER lets a transport error become an unhandled rejection —
   *  idle errors are DROPPED and the slot is cleared; the next owner turn hits
   *  the real terminal path on the closed stream. */
  private runIdleReader(): void {
    if (this.idleReading || this.disposed || this.terminalError !== null || this.turnActive) return;
    this.idleReading = true;
    const step = (): void => {
      if (this.disposed || this.terminalError !== null || this.turnActive) { this.idleReading = false; return; }
      const epoch = ++this.idleEpoch;
      const wake = new Promise<null>((resolve) => { this.idleWake = () => resolve(null); });
      void Promise.race([this.takeFrame().then((value) => value, () => null), wake])
        .then((value) => {
          // An old epoch's callback returns BEFORE touching shared state: a
          // newer reader (owner turn or a restarted idle reader) owns it now.
          if (epoch !== this.idleEpoch) return;
          this.idleWake = null;
          if (value === null) {
            // Rejected read: drop it here, but DO NOT clear the slot — the
            // rejection stays observable by the next owner runTurn. Park.
            this.idleReading = false;
            return;
          }
          if (value.done) { this.idleReading = false; return; } // stream closed; next turn sees terminal path
          this.frameConsumed();
          this.absorbIdleFrame(value.value);
          step();
        })
        .catch(() => { this.idleReading = false; });
    };
    step();
  }

  /** TASK.189: bump the epoch (handoff took over), wake the parked race, and
   *  mark the reader stopped so `runIdleReader` can restart from a turn's
   *  finally. */
  private stopIdleReader(): void {
    this.idleEpoch += 1;
    this.idleReading = false;
    this.idleWake?.();
    this.idleWake = null;
  }

  /** TASK.189: lazily-created, never-rejecting disposal wait (E7). */
  private ensureDisposalWait(): Promise<void> {
    this.disposalWait ??= new Promise<void>((resolve) => { this.resolveDisposalWait = resolve; });
    return this.disposalWait;
  }

  /** Boot-time notices have no wire of their own — an AgentEvent only travels inside a turn, so they are flushed here, once. */
  private drainNotices(): AgentEvent[] {
    const settings = this.settings;
    if (settings === undefined || settings.notices.length === 0) return [];
    return settings.notices.splice(0, settings.notices.length);
  }

  private *terminalEvents(turn: number, error: Error, includeError = true): Generator<AgentEvent> {
    if (includeError) yield { type: "error", error, safe: engineDeathSafe(error) };
    yield { type: "turn_end", turn, finishReason: "error" };
    yield { type: "loop_end", reason: "error", turns: turn };
  }
}

/** Every preset id the frozen table exposes — used by the renderer's draft mirror and by host-side validation. */
export const CLAUDE_PRESET_IDS = CLAUDE_PERMISSION_PRESETS.map((preset) => preset.id);
