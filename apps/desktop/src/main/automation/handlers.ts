/**
 * Transport-agnostic command handlers for the Claude-smoke automation channel
 * (design/phase-2-smoke-channel.md §2.3/§4, task S3). Every dependency is
 * injected (`HandlerDeps`: a facade caller, the window getter, the
 * TabHostManager, and `app`), so the whole command surface is unit-testable
 * with fakes and no Electron — the same DI discipline as tabs.ts /
 * registerTabIpc. `server.ts` (the `node:http` shell) owns auth, body limits,
 * and zod; this module owns only "what a command does".
 *
 * The renderer-plane commands never touch the store directly — they go through
 * `callFacade`, which runs `window.__anycodeAutomation.<method>(...)` in the
 * page via `webContents.executeJavaScript` (design §2.1: pull over the same
 * live zustand instances React renders, no mirror in main). A production
 * renderer has no facade installed (the DEV gate strips it), so the wrapper
 * surfaces that as a structural `FacadeUnavailableError` -> HTTP 503 (design

 *
 * The main-plane commands that are deliberately NOT facade calls are the
 * new-tab open (`manager.createTab` + `deliverTabPort`, the sanctioned
 * dialog bypass, §1), `quit` (`app.quit()`), and the dev-only `killHost`
 * (TASK.33 FIX-A: `manager.killHost`, a smoke lever with no renderer
 * counterpart — killing a host child is main-process territory, not
 * something the page's facade could do); everything else is a thin wrapper
 * over the frozen facade contract (§3.2).
 */

import { randomUUID } from "node:crypto";
import type { CreateTabResult, TabHost, TabSummary } from "../tabs.js";

/** Structural view of `webContents` the channel needs (executeJavaScript for the facade, capturePage for evidence). */
export interface CapturedImage {
  toPNG(): Buffer;
}
export interface AutomationWebContents {
  executeJavaScript(code: string): Promise<unknown>;
  capturePage(): Promise<CapturedImage>;
}
export interface AutomationWindow {
  isDestroyed(): boolean;
  webContents: AutomationWebContents;
}

/** Structural view of Electron's `app` (only the two members the channel uses). */
export interface AppLike {
  quit(): void;
  getVersion(): string;
}

/**
 * Structural view of TabHostManager the channel uses. Kept structural (not the
 * class type) so handler tests can pass a fake with zero Electron; the shapes
 * are the real ones from tabs.ts.
 */
export interface ManagerLike {
  createTab(params: { workspace: string; sessionId: string; resume: boolean; connectionId?: string }): CreateTabResult;
  deliverTabPort(tab: TabHost): void;
  listTabs(): ReadonlyArray<TabSummary>;
  killHost(tabId: string): { ok: true } | { ok: false; reason: "unknown_tab" };
}

/**
 * Calls a method on `window.__anycodeAutomation` in the page and returns its
 * (already JSON-serialized) result. Throws `FacadeUnavailableError` when the

 * and `FacadeThrewError` when the facade method itself throws.
 */
export type FacadeCaller = (method: string, args: readonly unknown[]) => Promise<unknown>;

export interface HandlerDeps {
  callFacade: FacadeCaller;
  getWindow: () => AutomationWindow | null;
  manager: ManagerLike;
  app: AppLike;
  /** Injectable clock/sleep for the wait poller (defaults: Date.now / setTimeout). */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Wait poll interval (design §4.3: 150ms); injectable so tests run instantly. */
  pollMs?: number;
  /**
   * The active provider connection id (TASK.45 W10), same source
   * `registerTabIpc`'s `handleCreate` pins a real "new" tab from
   * (`main/index.ts`'s `() => settings?.provider.activeConnectionId`).
   * Undefined = no default configured (a fresh install, or an env-override
   * boot) — `createTabNew` below then spawns unpinned, byte-identical to the
   * real dialog-driven path in that same situation. Absent entirely in a
   * fixture/test HandlerDeps -> `createTabNew` stays byte-identical to before
   * this field existed.
   */
  activeConnectionId?: () => string | undefined;
}

/* */
export class FacadeUnavailableError extends Error {
  constructor(public readonly detail: string) {
    super(`facade_unavailable: ${detail}`);
    this.name = "FacadeUnavailableError";
  }
}

/** The facade method itself threw -> HTTP 500 (distinct from the facade being unreachable). */
export class FacadeThrewError extends Error {
  constructor(public readonly detail: string) {
    super(`facade_error: ${detail}`);
    this.name = "FacadeThrewError";
  }
}

/**
 * Serializes a value as a JS expression literal safe to embed in
 * `executeJavaScript` source. JSON is a syntactic subset of JS expressions, so
 * `JSON.stringify(args)` is a valid JS array literal; the only gap is
 * U+2028/U+2029 (legal in JSON strings, and legal in JS strings only since
 * ES2019 — escaped here for defense regardless).
 */
function embedJs(value: unknown): string {
  return JSON.stringify(value).replace(/[\u2028\u2029]/g, (c) => (c === "\u2028" ? "\\u2028" : "\\u2029"));
}

/**
 * Builds the page-side expression: resolve the facade, call `method` with the
 * caller's args (promise-lifted so sync and async facade methods look the
 * same), and return a tagged envelope so the main side can tell "no facade"
 * from "facade threw" from "value". `method` is an internal constant, embedded
 * as a string literal for good measure.
 */
export function buildFacadeExpr(method: string, args: readonly unknown[]): string {
  const m = embedJs(method);
  const a = embedJs(args);
  return `(function(){
    var f = window.__anycodeAutomation;
    if (!f || typeof f[${m}] !== "function") { return { __facade: "unavailable" }; }
    try {
      return Promise.resolve(f[${m}].apply(f, ${a})).then(
        function(v){ return { __facade: "ok", value: v }; },
        function(e){ return { __facade: "error", message: String((e && e.message) || e) }; }
      );
    } catch (e) {
      return { __facade: "error", message: String((e && e.message) || e) };
    }
  })()`;
}

interface FacadeEnvelope {
  __facade?: "ok" | "unavailable" | "error";
  value?: unknown;
  message?: string;
}

/** Default `FacadeCaller`: runs the built expression in the current window and unwraps the envelope. */
export function makeFacadeCaller(getWindow: () => AutomationWindow | null): FacadeCaller {
  return async (method, args) => {
    const win = getWindow();
    if (win === null || win.isDestroyed()) {
      throw new FacadeUnavailableError("no_window");
    }
    let raw: unknown;
    try {
      raw = await win.webContents.executeJavaScript(buildFacadeExpr(method, args));
    } catch (error) {
      // Dead / not-yet-loaded page: the eval rejects. Surface as unavailable so
      // the client's `POST /wait {connection:"ready"}` retry pattern applies.
      throw new FacadeUnavailableError(`execute_failed: ${String((error as Error)?.message ?? error)}`);
    }
    const env = (raw ?? {}) as FacadeEnvelope;
    if (env.__facade === "unavailable") {
      throw new FacadeUnavailableError("facade_not_installed");
    }
    if (env.__facade === "error") {
      throw new FacadeThrewError(env.message ?? "unknown");
    }
    if (env.__facade !== "ok") {
      throw new FacadeThrewError("bad_envelope");
    }
    return env.value;
  };
}

// --- Read commands (§4.1) ---

export function health(deps: HandlerDeps): { ok: true; pid: number; version: string; tabs: number } {
  return { ok: true, pid: process.pid, version: deps.app.getVersion(), tabs: deps.manager.listTabs().length };
}

/** `GET /state`: renderer-plane snapshot + main-plane tab list side by side (design §4.1). */
export async function getState(
  deps: HandlerDeps,
  tail: number | undefined,
): Promise<{ snapshot: unknown; tabs: ReadonlyArray<TabSummary> }> {
  const snapshot = await deps.callFacade("snapshot", tail !== undefined ? [tail] : []);
  return { snapshot, tabs: deps.manager.listTabs() };
}

/** `GET /state/:tabId`: same, narrowed to one tab on both planes. */
export async function getStateForTab(
  deps: HandlerDeps,
  tabId: string,
  tail: number | undefined,
): Promise<{ snapshot: unknown; tabs: ReadonlyArray<TabSummary> }> {
  const full = (await deps.callFacade("snapshot", tail !== undefined ? [tail] : [])) as {
    tabs: unknown;
    activeTabId: unknown;
    states: Record<string, unknown>;
  };
  const state = full.states?.[tabId];
  const narrowed = {
    tabs: full.tabs,
    activeTabId: full.activeTabId,
    states: state !== undefined ? { [tabId]: state } : {},
  };
  return { snapshot: narrowed, tabs: deps.manager.listTabs().filter((t) => t.tabId === tabId) };
}

export function getSessions(deps: HandlerDeps): Promise<unknown> {
  return deps.callFacade("listSessions", []);
}

/** `GET /screenshot`: base64 PNG evidence for eyes/report (design §4.1). */
export async function screenshot(deps: HandlerDeps): Promise<{ png: string }> {
  const win = deps.getWindow();
  if (win === null || win.isDestroyed()) {
    throw new FacadeUnavailableError("no_window");
  }
  const image = await win.webContents.capturePage();
  return { png: image.toPNG().toString("base64") };
}

// --- Action commands (§4.2) ---

export function sendPrompt(deps: HandlerDeps, tabId: string, text: string): Promise<unknown> {
  return deps.callFacade("sendPrompt", [tabId, text]);
}

/** TASK.33 W8: thin wrapper over the facade's `tryAgain` — clicks the real Try-again driver (App.tsx's `dispatchTryAgain`), no guard logic of its own. */
export function tryAgain(deps: HandlerDeps, tabId: string): Promise<unknown> {
  return deps.callFacade("tryAgain", [tabId]);
}

export function respondPermission(
  deps: HandlerDeps,
  tabId: string,
  behavior: "allow" | "deny",
  requestId: string | undefined,
): Promise<unknown> {
  // Omit requestId entirely when absent so the facade defaults to the current
  // pending ask (design §3.2) rather than receiving a null.
  const args = requestId !== undefined ? [tabId, behavior, requestId] : [tabId, behavior];
  return deps.callFacade("respondPermission", args);
}

export function setMode(deps: HandlerDeps, tabId: string, mode: string): Promise<unknown> {
  return deps.callFacade("setMode", [tabId, mode]);
}

export function stop(deps: HandlerDeps, tabId: string): Promise<unknown> {
  return deps.callFacade("stop", [tabId]);
}

export function selectTab(deps: HandlerDeps, tabId: string): Promise<unknown> {
  return deps.callFacade("selectTab", [tabId]);
}

/**
 * `POST /tabs {kind:"new"}` (design §4.2): the sanctioned dialog bypass (§1) —
 * the same `manager.createTab` + `deliverTabPort` the tab-ipc "new" handler
 * runs AFTER `dialog.showOpenDialog`, with the workspace supplied directly.
 * TASK.45 W10 (W13 live-dogfood finding): a real "new" tab pins to the active
 * connection at creation (`tab-ipc.ts`'s `handleCreate`) — this bypass must
 * mirror that pin, or every automation-created tab silently spawns unpinned
 * regardless of which connection is active, and the whole session-pinning
 * surface (default-switch isolation, resume/replacement) becomes untestable
 * over this channel. `deps.activeConnectionId` absent (fixture/test deps
 * without the field) -> `undefined`, byte-identical to before this fix.
 */
export function createTabNew(
  deps: HandlerDeps,
  workspace: string,
):
  | { ok: true; tabId: string; sessionId: string; workspace: string }
  | { ok: false; reason: string; focusTabId?: string } {
  const connectionId = deps.activeConnectionId?.();
  const result = deps.manager.createTab({
    workspace,
    sessionId: randomUUID(),
    resume: false,
    ...(connectionId !== undefined ? { connectionId } : {}),
  });
  if (!result.ok) {
    return { ok: false, reason: result.reason, ...(result.focusTabId !== undefined ? { focusTabId: result.focusTabId } : {}) };
  }
  deps.manager.deliverTabPort(result.tab);
  return { ok: true, tabId: result.tab.tabId, sessionId: result.tab.sessionId, workspace: result.tab.workspace };
}

/**
 * `POST /tabs {kind:"resume"}` (design §4.2): full picker path through the
 * facade/bridge. `replacementConnectionId` (TASK.45 W10-FIX F1, W13
 * live-dogfood finding) forwards the caller's explicit re-pin target to the
 * SAME `resumeSession` facade method — omitted entirely when undefined so a
 * caller that never supplies it exercises the byte-identical bare-resume path
 * as before this fix.
 */
export function resumeTab(deps: HandlerDeps, sessionId: string, replacementConnectionId?: string): Promise<unknown> {
  return deps.callFacade("resumeSession", replacementConnectionId !== undefined ? [sessionId, replacementConnectionId] : [sessionId]);
}

export function closeTab(deps: HandlerDeps, tabId: string): Promise<unknown> {
  return deps.callFacade("closeTab", [tabId]);
}

/**
 * `POST /tabs/:tabId/host/kill` (TASK.33 FIX-A): forces the tab's live host
 * child to exit so the existing crash-respawn machinery (`tabs.ts`) runs for
 * real — the sole way a cross-respawn smoke can prove the retry UI survives
 * an actual respawn instead of asserting store state alone. Main-plane only,
 * same posture as `createTabNew` above (no facade call — a page has no way to
 * kill its own host process).
 */
export function killHost(deps: HandlerDeps, tabId: string): { ok: true } | { ok: false; reason: "unknown_tab" } {
  return deps.manager.killHost(tabId);
}

export function quit(deps: HandlerDeps): { ok: true } {
  // Routes through the normal before-quit path (design §4.2): parallel
  // shutdownAllTabHosts + the server's own info-file unlink.
  deps.app.quit();
  return { ok: true };
}

// --- Git action commands (slice-5.8-R8-cut.md §2.2): thin wrappers over the
// frozen facade contract (slice-5.8-R8-cut.md §2.1c), same discipline as
// sendPrompt/respondPermission above — the facade owns every guard (unknown
// tab / not ready / destructive-requires-confirm / turn-running / etc.), this
// layer only forwards method + args. ---

export function gitCommand(deps: HandlerDeps, tabId: string, command: unknown): Promise<unknown> {
  return deps.callFacade("gitCommand", [tabId, command]);
}

export function gitStageConfirm(deps: HandlerDeps, tabId: string, intent: unknown): Promise<unknown> {
  return deps.callFacade("gitStageConfirm", [tabId, intent]);
}

export function gitConfirmAccept(deps: HandlerDeps, tabId: string): Promise<unknown> {
  return deps.callFacade("gitConfirm", [tabId]);
}

export function gitConfirmCancel(deps: HandlerDeps, tabId: string): Promise<unknown> {
  return deps.callFacade("gitCancelConfirm", [tabId]);
}

export function gitPanel(deps: HandlerDeps, tabId: string, open: boolean): Promise<unknown> {
  return deps.callFacade("gitSetPanelOpen", [tabId, open]);
}

export function gitView(deps: HandlerDeps, tabId: string, view: string): Promise<unknown> {
  return deps.callFacade("gitSetView", [tabId, view]);
}

// --- Project action commands (design/slice-GUI-P1-cut.md §2F.5): thin
// wrappers over the frozen facade contract, same discipline as the git thin
// wrappers above — the facade owns every guard (open-tabs refusal, main
// authority for the new-tab path), this layer only forwards method + args. ---

export function projectNewSession(deps: HandlerDeps, workspace: string): Promise<unknown> {
  return deps.callFacade("projectNewSession", [workspace]);
}

export function projectHide(deps: HandlerDeps, workspace: string): Promise<unknown> {
  return deps.callFacade("projectHide", [workspace]);
}

// --- Transcript scroll probe (slice-P7.3-cut.md §3.3): thin wrappers over the
// frozen facade contract, same discipline as the git thin wrappers above — the
// facade owns every guard (tab_not_active / no_transcript), this layer only
// forwards method + args. ---

export function transcriptScrollState(deps: HandlerDeps, tabId: string): Promise<unknown> {
  return deps.callFacade("transcriptScrollState", [tabId]);
}

export function transcriptScrollTo(deps: HandlerDeps, tabId: string, to: "top" | "bottom"): Promise<unknown> {
  return deps.callFacade("transcriptScrollTo", [tabId, to]);
}

// --- Todo panel probe (slice-P7.11-cut.md §3 W2): thin wrapper over the
// frozen facade contract, same discipline as the transcript-scroll probe
// above — the facade owns every guard (tab_not_active / no_transcript), this
// layer only forwards method + args. ---

export function todoPanelState(deps: HandlerDeps, tabId: string): Promise<unknown> {
  return deps.callFacade("todoPanelState", [tabId]);
}

// --- Start screen (slice-P7.12-cut.md §5 W2): thin wrappers over the frozen
// facade contract, same discipline as the transcript-scroll / todo-panel
// probes above — the facade owns every guard (no_draft), this layer only
// forwards method + args. ---

export function startScreenState(deps: HandlerDeps): Promise<unknown> {
  return deps.callFacade("startScreenState", []);
}

export function startScreenOpen(deps: HandlerDeps, workspace: string | undefined): Promise<unknown> {
  return deps.callFacade("startScreenOpen", workspace !== undefined ? [workspace] : []);
}

export function startScreenSetWorkspace(deps: HandlerDeps, workspace: string): Promise<unknown> {
  return deps.callFacade("startScreenSetWorkspace", [workspace]);
}

export function startScreenSetPrompt(deps: HandlerDeps, text: string): Promise<unknown> {
  return deps.callFacade("startScreenSetPrompt", [text]);
}

// --- Task-model + project-popover (slice-F5-1b-cut.md §2-D4): same thin
// wrapper discipline as the start-screen probes above. ---

export function startScreenSetModel(deps: HandlerDeps, model: string | null): Promise<unknown> {
  return deps.callFacade("startScreenSetModel", [model]);
}

// --- Engine selection (codex-fixes TASK.42, cut §3.7/§5.6 B5-auto): thin
// wrapper over the frozen facade contract, same discipline as the probes
// above — the facade owns every guard (no_draft / invalid_engine), this
// layer only forwards the arg. Read-back rides the EXISTING GET
// /start-screen route (startScreenState's additive `engine`/
// `availableEngines` fields) — no dedicated GET route for this. ---

export function startScreenSetEngine(deps: HandlerDeps, engineId: string): Promise<unknown> {
  return deps.callFacade("startScreenSetEngine", [engineId]);
}

export function startScreenToggleProjectMenu(deps: HandlerDeps, open: boolean): Promise<unknown> {
  return deps.callFacade("startScreenToggleProjectMenu", [open]);
}

export function startScreenSubmit(deps: HandlerDeps): Promise<unknown> {
  return deps.callFacade("startScreenSubmit", []);
}

// --- Prompt queue (slice-P7.14-cut.md §5 W3): thin wrappers over the frozen
// facade contract, same discipline as the transcript-scroll / todo-panel /
// start-screen probes above — the facade owns every guard (unknown_tab /
// not_ready / unknown_prompt), this layer only forwards method + args. ---

export function queuePrompt(deps: HandlerDeps, tabId: string, text: string): Promise<unknown> {
  return deps.callFacade("queuePrompt", [tabId, text]);
}

export function queueEdit(deps: HandlerDeps, tabId: string, id: string, text: string): Promise<unknown> {
  return deps.callFacade("queueEdit", [tabId, id, text]);
}

export function queueDelete(deps: HandlerDeps, tabId: string, id: string): Promise<unknown> {
  return deps.callFacade("queueDelete", [tabId, id]);
}

export function queueResume(deps: HandlerDeps, tabId: string): Promise<unknown> {
  return deps.callFacade("queueResume", [tabId]);
}

export function queueClear(deps: HandlerDeps, tabId: string): Promise<unknown> {
  return deps.callFacade("queueClear", [tabId]);
}

// --- Model pill probe/driver (slice-P7.15-cut.md §2.6 W4): thin wrappers over
// the frozen facade contract, same discipline as the transcript-scroll /
// todo-panel / start-screen / prompt-queue probes above — the facade owns
// every guard (tab_not_active / pick_disabled / effort_row_hidden / etc.),
// this layer only forwards method + args. ---

export function modelPillState(deps: HandlerDeps, tabId: string): Promise<unknown> {
  return deps.callFacade("modelPillState", [tabId]);
}

export function modelPillPick(
  deps: HandlerDeps,
  tabId: string,
  pick: { kind: "open" } | { kind: "model"; value: string } | { kind: "effort"; value: string },
): Promise<unknown> {
  return deps.callFacade("modelPillPick", [tabId, pick]);
}

// --- Ctx-meter popover probe/driver (slice-P7.17-cut.md F12 W4): thin
// wrappers over the frozen facade contract, same discipline as the
// model-pill probe/driver above — the facade owns every guard
// (tab_not_active / not_present / did_not_open / did_not_close), this layer
// only forwards method + args. ---

export function ctxPopoverState(deps: HandlerDeps, tabId: string): Promise<unknown> {
  return deps.callFacade("ctxPopoverState", [tabId]);
}

export function ctxPopoverOpen(deps: HandlerDeps, tabId: string, open: boolean): Promise<unknown> {
  return deps.callFacade("ctxPopoverOpen", [tabId, open]);
}

// --- Agent-card probe (slice-P7.18-cut.md §4 W4): thin wrapper over the
// frozen facade contract, same discipline as the probes above — the facade
// owns every guard (tab_not_active / unknown_tab / valid-empty-when-absent),
// this layer only forwards method + args. ---

export function agentCardState(deps: HandlerDeps, tabId: string, toolCallId: string): Promise<unknown> {
  return deps.callFacade("agentCardState", [tabId, toolCallId]);
}

export function agentCardExpand(deps: HandlerDeps, tabId: string, toolCallId: string): Promise<unknown> {
  return deps.callFacade("agentCardExpand", [tabId, toolCallId]);
}

// --- Try-again button probe/driver (TASK.33 W8-FIX #2): same thin-wrapper
// discipline as the agent-card probe/driver above — the facade owns every
// guard, this layer only forwards method + args. ---

export function tryAgainButtonState(deps: HandlerDeps, tabId: string, blockId: string): Promise<unknown> {
  return deps.callFacade("tryAgainButtonState", [tabId, blockId]);
}

export function tryAgainButtonClick(deps: HandlerDeps, tabId: string, blockId: string): Promise<unknown> {
  return deps.callFacade("tryAgainButtonClick", [tabId, blockId]);
}

// --- Settings probe/driver (slice-P7.16-cut.md §5 W4): thin wrappers over the
// frozen facade contract, same discipline as the transcript-scroll /
// todo-panel / start-screen / prompt-queue / model-pill probes above — the
// facade owns every guard (not_open / pane_not_visible / form_not_present /
// add_disabled / rule_not_found / etc.), this layer only forwards method +
// args. Global (app-level) commands: no `:tabId` — Settings is not per-tab. ---

export function settingsState(deps: HandlerDeps): Promise<unknown> {
  return deps.callFacade("settingsState", []);
}

export function settingsOpen(deps: HandlerDeps): Promise<unknown> {
  return deps.callFacade("settingsOpen", []);
}

export function settingsClose(deps: HandlerDeps): Promise<unknown> {
  return deps.callFacade("settingsClose", []);
}

export function settingsSelectPane(deps: HandlerDeps, paneId: string): Promise<unknown> {
  return deps.callFacade("settingsSelectPane", [paneId]);
}

export function settingsPermissionAdd(deps: HandlerDeps, toolName: string, pattern: string | undefined): Promise<unknown> {
  return deps.callFacade("settingsPermissionAdd", [{ toolName, pattern }]);
}

export function settingsPermissionRemove(deps: HandlerDeps, toolName: string, pattern: string | undefined): Promise<unknown> {
  return deps.callFacade("settingsPermissionRemove", [{ toolName, pattern }]);
}

// --- Provider connections grid/drawer probe/driver (TASK.45 W12): thin
// wrappers over the frozen facade contract, same discipline as the settings
// probe/driver above — the facade owns every guard (grid_not_mounted /
// connection_not_found / drawer_not_open / submit_disabled / did_not_settle /
// no_close_affordance / etc.), this layer only forwards method + args.
// Global (app-level) commands: no `:tabId` — the provider pane lives inside
// the global Settings dialog (or WelcomeScreen's first-run embed), same
// posture as the settings/MCP/skills probe/drivers above. ---

export function settingsProviderPaneState(deps: HandlerDeps): Promise<unknown> {
  return deps.callFacade("settingsProviderPaneState", []);
}

export function settingsProviderAddOpen(deps: HandlerDeps): Promise<unknown> {
  return deps.callFacade("settingsProviderAddOpen", []);
}

export function settingsProviderTileClick(deps: HandlerDeps, connectionId: string): Promise<unknown> {
  return deps.callFacade("settingsProviderTileClick", [{ connectionId }]);
}

export function settingsProviderMenuAction(deps: HandlerDeps, connectionId: string, action: string): Promise<unknown> {
  return deps.callFacade("settingsProviderMenuAction", [{ connectionId, action }]);
}

export function settingsProviderDrawerSet(
  deps: HandlerDeps,
  args: { providerId?: string; label?: string; model?: string; transport?: string; baseUrl?: string; apiKey?: string },
): Promise<unknown> {
  return deps.callFacade("settingsProviderDrawerSet", [args]);
}

export function settingsProviderDrawerSubmit(deps: HandlerDeps): Promise<unknown> {
  return deps.callFacade("settingsProviderDrawerSubmit", []);
}

export function settingsProviderDrawerSaveKey(deps: HandlerDeps): Promise<unknown> {
  return deps.callFacade("settingsProviderDrawerSaveKey", []);
}

export function settingsProviderDrawerClearKey(deps: HandlerDeps): Promise<unknown> {
  return deps.callFacade("settingsProviderDrawerClearKey", []);
}

export function settingsProviderDrawerClose(deps: HandlerDeps): Promise<unknown> {
  return deps.callFacade("settingsProviderDrawerClose", []);
}

// --- Generic focus probe (TASK.45 W12-smoke): thin wrapper, same discipline
// as every other probe above — no pane owns this, it reads
// `document.activeElement` directly (see FocusState's doc comment in
// renderer/src/automation.ts). ---

export function focusState(deps: HandlerDeps): Promise<unknown> {
  return deps.callFacade("focusState", []);
}

// --- MCP Servers pane probe/driver (slice-P7.19-cut.md §4 W4): thin wrappers
// over the frozen facade contract, same discipline as the settings
// probe/driver above — the facade owns every guard (pane_not_mounted /
// row_not_found / not_toggleable / dialog_not_open / apply_disabled / etc.),
// this layer only forwards method + args. Global (app-level) commands: no
// `:tabId` — the MCP Servers pane lives inside the global Settings dialog,
// same posture as the settings probe/driver. ---

export function mcpPaneState(deps: HandlerDeps): Promise<unknown> {
  return deps.callFacade("mcpPaneState", []);
}

export function mcpToggle(deps: HandlerDeps, name: string): Promise<unknown> {
  return deps.callFacade("mcpToggle", [name]);
}

export function mcpImportOpen(deps: HandlerDeps): Promise<unknown> {
  return deps.callFacade("mcpImportOpen", []);
}

export function mcpImportApply(deps: HandlerDeps, args: { consent: boolean; names?: string[] }): Promise<unknown> {
  return deps.callFacade("mcpImportApply", [args]);
}

// --- Skills pane probe/driver (design/slice-P7.20-cut.md §5 W4): thin
// wrappers over the frozen facade contract, same discipline as the MCP pane
// probe/driver above — the facade owns every guard (pane_not_mounted /
// row_not_found / not_toggleable / not_deletable / confirm_not_shown /
// dialog_not_open / apply_disabled / etc.), this layer only forwards method
// + args. Global (app-level) commands: no `:tabId` — the Skills pane lives
// inside the global Settings dialog, same posture as the MCP/settings
// probe/driver. ---

export function skillsPaneState(deps: HandlerDeps): Promise<unknown> {
  return deps.callFacade("skillsPaneState", []);
}

export function skillsToggle(deps: HandlerDeps, name: string): Promise<unknown> {
  return deps.callFacade("skillsToggle", [name]);
}

export function skillsDelete(deps: HandlerDeps, name: string): Promise<unknown> {
  return deps.callFacade("skillsDelete", [name]);
}

export function skillsImportOpen(deps: HandlerDeps): Promise<unknown> {
  return deps.callFacade("skillsImportOpen", []);
}

export function skillsImportApply(deps: HandlerDeps, args: { scope: string; ids?: string[] }): Promise<unknown> {
  return deps.callFacade("skillsImportApply", [args]);
}

// --- Subagents pane probe/driver (design/slice-P7.21-cut.md §4 W4): thin
// wrappers over the frozen facade contract, same discipline as the Skills
// pane probe/driver above — the facade owns every guard (pane_not_mounted /
// row_not_found / not_editable / editor_not_open / field_not_found /
// preview_timeout / cannot_save / not_deletable / etc.), this layer only
// forwards method + args. Global (app-level) commands: no `:tabId` — the
// Subagents pane lives inside the global Settings dialog, same posture as the
// MCP/Skills pane probe/driver. ---

export function subagentsPaneState(deps: HandlerDeps): Promise<unknown> {
  return deps.callFacade("subagentsPaneState", []);
}

export function subagentsOpenEditor(deps: HandlerDeps, name: string | undefined): Promise<unknown> {
  return deps.callFacade("subagentsOpenEditor", name !== undefined ? [name] : []);
}

export function subagentsEditorSet(
  deps: HandlerDeps,
  args: { name?: string; description?: string; tools?: string[]; body?: string },
): Promise<unknown> {
  return deps.callFacade("subagentsEditorSet", [args]);
}

export function subagentsEditorPreview(deps: HandlerDeps): Promise<unknown> {
  return deps.callFacade("subagentsEditorPreview", []);
}

export function subagentsEditorSave(deps: HandlerDeps): Promise<unknown> {
  return deps.callFacade("subagentsEditorSave", []);
}

export function subagentsDelete(deps: HandlerDeps, name: string): Promise<unknown> {
  return deps.callFacade("subagentsDelete", [name]);
}

// --- Profile pane probe/driver (design/slice-P7.22-cut.md §4 W4): thin
// wrappers over the frozen facade contract, same discipline as the Subagents
// pane probe/driver above — the facade owns every guard (pane_not_mounted /
// toggle_not_present / toggle_disabled / did_not_toggle), this layer only
// forwards method + args. Global (app-level) command: no `:tabId` — the
// Profile pane lives inside the global Settings dialog, same posture as the
// MCP/Skills/Subagents pane probe/driver. ---

export function profilePaneState(deps: HandlerDeps): Promise<unknown> {
  return deps.callFacade("profilePaneState", []);
}

export function profileToggleTelemetry(deps: HandlerDeps): Promise<unknown> {
  return deps.callFacade("profileToggleTelemetry", []);
}

// --- Slash-command menu probe/driver (design/slice-P7.23-cut.md §7 W4): thin
// wrappers over the frozen facade contract, same discipline as the probes
// above — the facade owns every guard (tab_not_active / unknown_tab /
// not_present), this layer only forwards method + args. ---

export function slashMenuState(deps: HandlerDeps, tabId: string): Promise<unknown> {
  return deps.callFacade("slashMenuState", [tabId]);
}

export function composerType(deps: HandlerDeps, tabId: string, text: string): Promise<unknown> {
  return deps.callFacade("composerType", [tabId, text]);
}

export function composerKey(
  deps: HandlerDeps,
  tabId: string,
  key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab" | "Escape",
): Promise<unknown> {
  return deps.callFacade("composerKey", [tabId, key]);
}

// --- Keyboard shortcuts pane probe/driver (design/slice-P7.24-cut.md §4 W4):
// thin wrappers over the frozen facade contract, same discipline as the
// Profile pane probe/driver above — the facade owns every guard
// (pane_not_mounted / row_not_found / not_editable / control_not_present /
// did_not_start / not_overridden / did_not_remove / did_not_reset), this
// layer only forwards method + args. Global (app-level) commands: no
// `:tabId` — the Keyboard shortcuts pane lives inside the global Settings
// dialog, same posture as the MCP/Skills/Subagents/Profile pane
// probe/driver. `shortcutsPressChord` is the one exception carrying no pane
// guard at all — it's a bare global `keydown` dispatch (design §4 W4), valid
// both while the pane is recording AND with Settings closed entirely (the
// real end-to-end shortcut-effect path). ---

export function shortcutsPaneState(deps: HandlerDeps): Promise<unknown> {
  return deps.callFacade("shortcutsPaneState", []);
}

export function shortcutsStartRecord(deps: HandlerDeps, action: string, slotIndex: number | undefined): Promise<unknown> {
  return deps.callFacade("shortcutsStartRecord", slotIndex !== undefined ? [action, slotIndex] : [action]);
}

export function shortcutsPressChord(deps: HandlerDeps, chord: { key: string; mod: boolean; shift?: boolean }): Promise<unknown> {
  return deps.callFacade("shortcutsPressChord", [chord]);
}

export function shortcutsRemoveBinding(deps: HandlerDeps, action: string, slotIndex: number): Promise<unknown> {
  return deps.callFacade("shortcutsRemoveBinding", [action, slotIndex]);
}

export function shortcutsReset(deps: HandlerDeps, action: string): Promise<unknown> {
  return deps.callFacade("shortcutsReset", [action]);
}

// --- LSP / Hooks panel probes/drivers (slice-P7.25-cut.md §3 W3): thin
// wrappers over the frozen facade contract, same discipline as the shortcuts
// pane probe/driver above — the facade owns every guard (tab_not_active),
// this layer only forwards method + args. ---

export function lspPanelState(deps: HandlerDeps, tabId: string): Promise<unknown> {
  return deps.callFacade("lspPanelState", [tabId]);
}

export function lspPanelToggle(deps: HandlerDeps, tabId: string): Promise<unknown> {
  return deps.callFacade("lspPanelToggle", [tabId]);
}

export function hooksPanelState(deps: HandlerDeps, tabId: string): Promise<unknown> {
  return deps.callFacade("hooksPanelState", [tabId]);
}

export function hooksPanelToggle(deps: HandlerDeps, tabId: string): Promise<unknown> {
  return deps.callFacade("hooksPanelToggle", [tabId]);
}

// --- Checkpoint timeline / rewind probe+driver (design
// slice-P7.26-R2-ratification.md §1 W3): thin wrappers over the frozen
// facade contract, same discipline as the LSP/Hooks panel probes above — the
// facade owns every guard (tab_not_active, checkpoint resolution), this
// layer only forwards method + args. ---

export function checkpointPanelState(deps: HandlerDeps, tabId: string): Promise<unknown> {
  return deps.callFacade("checkpointPanelState", [tabId]);
}

/** Read-only counterpart of `checkpointRewind` below — lets a caller read the current `lastResult`/`transcriptBlockCount` (e.g. before any rewind) without driving one. */
export function rewindState(deps: HandlerDeps, tabId: string): Promise<unknown> {
  return deps.callFacade("rewindState", [tabId]);
}

export function checkpointRewind(
  deps: HandlerDeps,
  tabId: string,
  args: { checkpointId?: string; index?: number; scope: string },
): Promise<unknown> {
  return deps.callFacade("checkpointRewind", [tabId, args]);
}

// --- Wait (§4.3) ---

export interface WaitUntil {
  connection?: string;
  turnStatus?: string;
  permissionPending?: boolean;
  transcriptIncludes?: string;
  /** True once the git slice's `statusKnown` flag is set (slice-5.8-R8-cut.md §2.2 — mirrors GitPill's render gate). Absence of `git` in the snapshot (pre-R8 tab state) reads as `false`. */
  gitStatusKnown?: boolean;
  /** True once the git pending map is empty (no in-flight git request). Absence of `git` reads as `true`. */
  gitPendingEmpty?: boolean;
}

interface WaitTranscriptBlock {
  kind: string;
  text?: string;
  modelText?: string | null;
}
interface WaitTabState {
  connection: string;
  turn: { status: string };
  permission: unknown | null;
  transcript: WaitTranscriptBlock[];
  /** Optional so a pre-R8 snapshot (no git slice) still satisfies this type — the poller degrades to gitStatusKnown=false/gitPendingEmpty=true rather than throwing. */
  git?: { statusKnown: boolean; pending: Record<string, unknown> };
}

const DEFAULT_WAIT_TIMEOUT_MS = 60_000;
const MAX_WAIT_TIMEOUT_MS = 300_000;
const DEFAULT_POLL_MS = 150;

function transcriptIncludes(transcript: WaitTranscriptBlock[], needle: string): boolean {
  for (const block of transcript) {
    if (typeof block.text === "string" && block.text.includes(needle)) {
      return true;
    }
    if (typeof block.modelText === "string" && block.modelText.includes(needle)) {
      return true;
    }
  }
  return false;
}

/** True iff EVERY provided key in `until` is currently satisfied by `state` (design §4.3). */
export function matchesUntil(state: WaitTabState | undefined, until: WaitUntil): boolean {
  if (state === undefined) {
    return false;
  }
  if (until.connection !== undefined && state.connection !== until.connection) {
    return false;
  }
  if (until.turnStatus !== undefined && state.turn.status !== until.turnStatus) {
    return false;
  }
  if (until.permissionPending !== undefined && (state.permission !== null) !== until.permissionPending) {
    return false;
  }
  if (until.transcriptIncludes !== undefined && !transcriptIncludes(state.transcript, until.transcriptIncludes)) {
    return false;
  }
  if (until.gitStatusKnown !== undefined && (state.git?.statusKnown === true) !== until.gitStatusKnown) {
    return false;
  }
  if (
    until.gitPendingEmpty !== undefined &&
    (Object.keys(state.git?.pending ?? {}).length === 0) !== until.gitPendingEmpty
  ) {
    return false;
  }
  return true;
}

/**
 * `POST /wait` (design §4.3): long-poll `facade.snapshot()` every `pollMs` until
 * the predicate holds or the (capped) timeout elapses. Returns the final tab
 * snapshot in BOTH outcomes — at timeout that snapshot is the diagnosis.
 */
export async function waitFor(
  deps: HandlerDeps,
  tabId: string,
  until: WaitUntil,
  timeoutMs: number | undefined,
): Promise<{ matched: boolean; elapsedMs: number; state: unknown }> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  const timeout = Math.min(timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS, MAX_WAIT_TIMEOUT_MS);
  const start = now();

  for (;;) {
    const snapshot = (await deps.callFacade("snapshot", [])) as { states: Record<string, WaitTabState> };
    const state = snapshot.states?.[tabId];
    if (matchesUntil(state, until)) {
      return { matched: true, elapsedMs: now() - start, state: state ?? null };
    }
    if (now() - start >= timeout) {
      return { matched: false, elapsedMs: now() - start, state: state ?? null };
    }
    await sleep(pollMs);
  }
}
