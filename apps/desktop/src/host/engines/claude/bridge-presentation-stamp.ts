/**
 * Taskana 4056 review (N2): the claude MCP door's `tools/call` handler,
 * lifted out of `bootClaudeSession` (host/index.ts) so its after-abort
 * discipline can be pinned by a unit test — index.ts itself is NOT
 * importable in a test (it touches `process.parentPort` at module scope;
 * index.test.ts's own header explains the established "reproduce the shape,
 * don't import index.ts" idiom).
 *
 * One call = one tool_use id = at most one stamped presentation. The map
 * (`bridgePresentations`, closed over here) is the durable-snapshot channel
 * between this handler and the engine's `takePresentation`/
 * `dropPresentations` seams (claude-engine.ts, срез S4 + 4056 P1): the MCP
 * `tools/call` response itself carries only `{text, isError}` (plan §3.1),
 * so the card snapshot rides the map until the paired top-level
 * `tool_result` consumes it — or until the turn-end sweep drops it.
 *
 * Taskana 4101: `listTools` announces the BOOT catalog snapshot (names are
 * fixed for the session, the CLI caches its tools/list handshake), while
 * each `callTool` resolves the catalog per call via `resolveCallCatalog`
 * (fresh bodies/models, boot-declared names only), failing soft to the boot
 * snapshot on a transient re-read failure.
 */

import type {
  AgentBridgeCatalogEntry,
  McpToolCallResult,
  SessionSubagentPort,
  SubagentCardEvent,
  ToolResultPresentation,
} from "@anycode/core";
import { buildAgentBridgeToolDecl, decodeAgentBridgeCallInput, runAgentBridgeCall, agentStatusBridgeDecl, runAgentStatusBridge } from "@anycode/core";
import type { EngineBrowserBridge } from "../browser-bridge.js";

export interface BridgePresentationStampDeps {
  /** The boot catalog snapshot the door announced on `tools/list` (also the fail-soft fallback). */
  catalog: readonly AgentBridgeCatalogEntry[];
  /** Taskana 4101: per-call catalog re-read; may reject, in which case the boot snapshot is used. */
  resolveCallCatalog: () => Promise<readonly AgentBridgeCatalogEntry[]>;
  /**
   * The session-tier child port (`createChildSessionPort`'s result).
   * Taskana 4764: OPTIONAL — with an empty agent-profile catalog there is no
   * child port, but the door still serves the browser tools.
   */
  port?: SessionSubagentPort;
  /** Live bridge-event tap (`pushBridgeEvent`, host/index.ts) — a no-op until the engine binds. */
  onEvent: (event: SubagentCardEvent) => void;
  /**
   * Taskana 4764: the shared browser bridge. When present, `listTools()`
   * appends the ten browser tool declarations and `callTool()` dispatches
   * `browser_*` names to it (the real, input-aware approval gate runs inside
   * the bridge through the same IpcPermissionBroker the native tab uses).
   */
  browser?: EngineBrowserBridge;
}

/** Builds the door's `listTools`/`callTool` pair over one shared presentation map. */
export function createBridgePresentationStamp(deps: BridgePresentationStampDeps) {
  const bridgePresentations = new Map<string, ToolResultPresentation>();
  return {
    listTools: () => {
      // Taskana 4764: the agent decl rides first (only when a catalog AND a
      // child port exist, exactly as before), then the browser decls.
      const decl = deps.port === undefined ? null : buildAgentBridgeToolDecl(deps.catalog, { detach: true, continueSession: true });
      const agentDecls = decl === null ? [] : [decl, agentStatusBridgeDecl];
      const browserDecls = (deps.browser?.specs ?? []).map((spec) => ({
        name: spec.claudeName,
        description: spec.description,
        inputSchema: spec.inputSchema,
      }));
      return [...agentDecls, ...browserDecls];
    },
    callTool: async (
      name: string,
      callArgs: Record<string, unknown>,
      signal: AbortSignal,
      meta: { toolUseId?: string },
    ): Promise<McpToolCallResult> => {
      // Taskana 4764: browser tools route to the shared engine browser bridge.
      // The REAL approval gate lives there (input-aware, through the same
      // IpcPermissionBroker the native tab uses); the CLI's `can_use_tool`
      // name-only gate is auto-allowed in approval-bridge.ts, so the user
      // sees exactly ONE prompt, titled with the canonical tool name.
      const browserSpec = deps.browser?.byClaudeName(name);
      if (browserSpec !== undefined) {
        if (meta.toolUseId === undefined) {
          return { text: "AnyCode could not correlate this call to a tool_use id", isError: true };
        }
        const result = await deps.browser!.call(browserSpec, callArgs, signal, meta.toolUseId);
        // An aborted call returns normally (the SDK server drops the late
        // answer, same discipline as `agent`); browser tools stamp no
        // presentation — the text line is the whole card.
        return {
          text: result.text,
          isError: result.isError,
          ...(result.images !== undefined ? { images: result.images } : {}),
        };
      }
      if (name === "agent_status" && deps.port !== undefined) return runAgentStatusBridge(callArgs, deps.port);
      if (name !== "agent") {
        return { text: `AnyCode's MCP bridge has no tool named "${name}"`, isError: true };
      }
      if (deps.port === undefined) {
        return { text: "AnyCode agent delegation is unavailable in this session", isError: true };
      }
      if (meta.toolUseId === undefined) {
        return { text: "AnyCode could not correlate this call to a tool_use id", isError: true };
      }
      const input = decodeAgentBridgeCallInput(callArgs);
      if (input === null) {
        return {
          text: "Malformed agent call: description/prompt/agent_type must be non-empty strings",
          isError: true,
        };
      }
      // TASK.226 план §2.3/Ruling 1: no `wallMs` override — the sync v1
      // wall is `runAgentBridgeCall`'s own default (SUBAGENT_TIME_BUDGET_MS,
      // 6h), the SAME stance every other bridge caller takes.
      // Taskana 4101: per-call catalog; fail-soft to the boot snapshot on a
      // disk race (a transient re-read failure must not kill the call).
      let callCatalog: readonly AgentBridgeCatalogEntry[];
      try {
        callCatalog = await deps.resolveCallCatalog();
      } catch {
        callCatalog = deps.catalog;
      }
      const result = await runAgentBridgeCall(input, {
        catalog: callCatalog,
        port: deps.port,
        spawnToolCallId: meta.toolUseId,
        signal,
        // Taskana 4056: live subagent_* events patch the SAME tool_call
        // card the turn's translator created (the renderer patches by
        // toolCallId), surfacing mid-turn through the engine's
        // bridge-event race. Detached children never reach here after
        // admit — the port does not bridge their post-admit progress —
        // and a push with no live turn waits in the engine's queue for
        // the next turn's send barrier (stall notices ride child_report
        // instead, via onDetachedStall).
        // Codex-door parity (dynamic-tool-bridge.ts): once the call is
        // aborted (Stop / CLI cancel) its late progress is dropped, not
        // queued into the next turn's send barrier as a stale card patch.
        onEvent: (event) => {
          if (signal?.aborted !== true) deps.onEvent(event);
        },
      });
      // The MCP `tools/call` response itself has no room for a card
      // payload (`{text, isError}` only — plan §3.1); the durable
      // snapshot rides `takePresentation` below instead, consumed
      // exactly once by the paired top-level `tool_result` for this
      // SAME tool_use id (event-translator.ts's own doc).
      //
      // Taskana 4056 review N2: an aborted call's tool_result never
      // arrives — the SDK server answers nothing for a request whose
      // signal fired (mcp-bridge.ts module doc P3), and the engine's
      // turn-end `dropPresentations` sweep has typically already run by
      // the time this late resolve lands (the run stays parked on the
      // child's real terminal; abort never resolves it by itself). A
      // stamp here would leak past the sweep for the process's lifetime,
      // so an aborted call must not stamp at all — the SAME dropped-
      // late-state discipline the codex door applies to its aborted
      // calls (dynamic-tool-bridge.ts).
      if (signal?.aborted !== true && result.presentation !== undefined) {
        bridgePresentations.set(meta.toolUseId, result.presentation);
      }
      return { text: result.text, isError: result.isError };
    },
    /** The engine's `takePresentation` seam (срез S4): consume exactly once. */
    takePresentation: (toolUseId: string) => {
      const presentation = bridgePresentations.get(toolUseId);
      bridgePresentations.delete(toolUseId);
      return presentation;
    },
    /** The engine's turn-end sweep seam (4056 cross-review P1). */
    dropPresentations: (toolUseIds: readonly string[]) => {
      for (const id of toolUseIds) bridgePresentations.delete(id);
    },
    /** Test seam: the shared map this factory owns. */
    entries: () => bridgePresentations,
  };
}
