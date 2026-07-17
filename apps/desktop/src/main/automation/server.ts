/**
 * HTTP-loopback transport for the Claude-smoke automation channel
 * (design/phase-2-smoke-channel.md §2.3/§4/§5, task S3). The `node:http` shell:
 * bind + the whole auth perimeter (§5) + body limits + zod bodies + routing to
 * the transport-agnostic handlers (handlers.ts) + the discovery file. Started
 * lazily from `main/index.ts` under the double gate (`ANYCODE_AUTOMATION==="1"`
 * AND `!app.isPackaged`), so a normal / packaged launch never even loads this
 * module.
 *
 * Security perimeter (design §5, NON-NEGOTIABLE, fail-closed):
 *  - bind strictly 127.0.0.1; defense-in-depth destroy of any non-loopback peer;
 *  - a fresh 256-bit Bearer token per launch, compared with `timingSafeEqual`
 *    on EVERY route (including /health), 401 with no detail otherwise;
 *  - discovery file `~/.anycode/automation.json` mode 0600 {pid,port,token,
 *    startedAt}, unlinked on quit;
 *  - no CORS headers at all (browser preflight on Authorization dies);
 *  - 256 KB body cap, JSON only;
 *  - the token is never logged / printed to stdout.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { Socket } from "node:net";
import { z } from "zod";
import { gitCommandMessageSchema } from "../../shared/protocol.js";
import {
  createTabNew,
  getSessions,
  getState,
  getStateForTab,
  health,
  makeFacadeCaller,
  quit,
  resumeTab,
  screenshot,
  selectTab,
  sendPrompt,
  tryAgain,
  setMode,
  stop,
  respondPermission,
  waitFor,
  closeTab,
  killHost,
  gitCommand,
  gitStageConfirm,
  gitConfirmAccept,
  gitConfirmCancel,
  gitPanel,
  gitView,
  projectNewSession,
  projectHide,
  transcriptScrollState,
  transcriptScrollTo,
  todoPanelState,
  startScreenState,
  startScreenOpen,
  startScreenSetWorkspace,
  startScreenSetPrompt,
  startScreenSetModel,
  startScreenSetEngine,
  startScreenToggleProjectMenu,
  startScreenSubmit,
  queuePrompt,
  queueEdit,
  queueDelete,
  queueResume,
  queueClear,
  modelPillState,
  modelPillPick,
  ctxPopoverState,
  ctxPopoverOpen,
  agentCardState,
  agentCardExpand,
  tryAgainButtonState,
  tryAgainButtonClick,
  settingsState,
  settingsOpen,
  settingsClose,
  settingsSelectPane,
  settingsPermissionAdd,
  settingsPermissionRemove,
  settingsProviderPaneState,
  settingsProviderAddOpen,
  settingsProviderTileClick,
  settingsProviderMenuAction,
  settingsProviderDrawerSet,
  settingsProviderDrawerSubmit,
  settingsProviderDrawerSaveKey,
  settingsProviderDrawerClearKey,
  settingsProviderDrawerClose,
  focusState,
  codexPaneState,
  codexPaneInstall,
  codexPaneRecheckAll,
  codexPaneRefreshManifest,
  codexProfileChipState,
  codexProfileChipOpen,
  codexProfileChipPick,
  codexImportState,
  codexImportOpen,
  codexImportSetProfile,
  codexImportSelectRollout,
  codexImportSetModel,
  codexImportApply,
  mcpPaneState,
  mcpToggle,
  mcpImportOpen,
  mcpImportApply,
  skillsPaneState,
  skillsToggle,
  skillsDelete,
  skillsImportOpen,
  skillsImportApply,
  subagentsPaneState,
  subagentsOpenEditor,
  subagentsEditorSet,
  subagentsEditorPreview,
  subagentsEditorSave,
  subagentsDelete,
  profilePaneState,
  profileToggleTelemetry,
  slashMenuState,
  composerType,
  composerKey,
  shortcutsPaneState,
  shortcutsStartRecord,
  shortcutsPressChord,
  shortcutsRemoveBinding,
  shortcutsReset,
  lspPanelState,
  lspPanelToggle,
  hooksPanelState,
  hooksPanelToggle,
  checkpointPanelState,
  rewindState,
  checkpointRewind,
  FacadeThrewError,
  FacadeUnavailableError,
  type AppLike,
  type AutomationWindow,
  type HandlerDeps,
  type ManagerLike,
} from "./handlers.js";

/** 256 KB body cap (design §5): larger requests are refused before parsing. */
const MAX_BODY_BYTES = 256 * 1024;

export interface AutomationServerDeps {
  getWindow: () => AutomationWindow | null;
  manager: ManagerLike;
  app: AppLike;
  /** Explicit port (else ANYCODE_AUTOMATION_PORT, else ephemeral 0). Injectable for tests. */
  port?: number;
  /** Explicit token (else a fresh 256-bit one). Injectable for tests. */
  token?: string;
  /** Discovery file path (default ~/.anycode/automation.json). Injectable for tests. */
  infoPath?: string;
  logger?: { log(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void };
  /** Forwarded to `HandlerDeps.activeConnectionId` (TASK.45 W10, `createTabNew`'s pin). */
  activeConnectionId?: () => string | undefined;
}

export interface AutomationServerHandle {
  server: Server;
  port: number;
  token: string;
  infoPath: string;
  close(): Promise<void>;
}

// --- zod body schemas (design §4: bodies validated in server.ts) ---

const promptBody = z.object({ text: z.string() });
const permissionBody = z.object({
  behavior: z.enum(["allow", "deny"]),
  requestId: z.string().min(1).optional(),
});
const modeBody = z.object({ mode: z.string() });
const emptyBody = z.object({}).passthrough();
const createTabBody = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("new"), workspace: z.string().min(1) }),
  z.object({
    kind: z.literal("resume"),
    sessionId: z.string().min(1),
    // TASK.45 W10-FIX F1 (W13 live-dogfood finding): mirrors tab-ipc.ts's own
    // `createTabRequestSchema` bounds-only optional re-pin target.
    replacementConnectionId: z.string().min(1).max(128).optional(),
  }),
]);
const waitBody = z.object({
  tabId: z.string().min(1),
  until: z.object({
    connection: z.enum(["awaiting_port", "awaiting_host_ready", "ready", "host_exited"]).optional(),
    turnStatus: z.enum(["idle", "running"]).optional(),
    permissionPending: z.boolean().optional(),
    transcriptIncludes: z.string().optional(),
    gitStatusKnown: z.boolean().optional(),
    gitPendingEmpty: z.boolean().optional(),
  }),
  timeoutMs: z.number().int().nonnegative().optional(),
});

// ── git bodies (slice-5.8-R8-cut.md §2.3, fail-closed) ──
// `gitCommandBody` reuses the SAME zod instance the host validates
// `git_command` messages with (`gitCommandMessageSchema.shape.command`), so

// parses here is guaranteed to parse there too.
const gitCommandBody = z.object({ command: gitCommandMessageSchema.shape.command });
// `gitIntentBody` mirrors the destructive wire schemas MINUS `confirmed`
// (an intent is a staging request, not a command — `confirmed` only exists on
// the command produced by `buildConfirmedGitCommand` after the real confirm
// dialog). Caps copied verbatim from protocol.ts.
const gitIntentBody = z.object({
  intent: z.discriminatedUnion("op", [
    z.object({ op: z.literal("discard"), paths: z.array(z.string().min(1).max(4096)).min(1).max(1000) }).strict(),
    z
      .object({
        op: z.literal("stash_push"),
        message: z.string().min(1).max(10_000).optional(),
        includeUntracked: z.boolean().optional(),
      })
      .strict(),
    z.object({ op: z.literal("stash_pop") }).strict(),
    z.object({ op: z.literal("reset"), mode: z.enum(["mixed", "hard"]) }).strict(),
  ]),
});
const gitPanelBody = z.object({ open: z.boolean() });
const gitViewBody = z.object({ view: z.enum(["changes", "history", "diff"]) });

// ── project body (design/slice-GUI-P1-cut.md §2F.5) ──
const projectBody = z.object({ workspace: z.string().min(1).max(4096) });

// ── transcript-scroll body (design/slice-P7.3-cut.md §3.3): `tabId` rides in
// the body (not the path, unlike the git/project routes) per the frozen cut —
// `GET /transcript/scroll?tabId=` mirrors it as a query param instead. ──
const transcriptScrollToBody = z.object({ tabId: z.string().min(1), to: z.enum(["top", "bottom"]) });

// ── start-screen bodies (slice-P7.12-cut.md §5 W2) — `workspace` reuses the
// same cap as `projectBody`; `open`'s workspace is optional (openDraft() with
// no argument keeps whatever the draft already has, tabs-store.ts §4.1). ──
const startScreenOpenBody = z.object({ workspace: z.string().min(1).max(4096).optional() });
const startScreenWorkspaceBody = z.object({ workspace: z.string().min(1).max(4096) });

// ── task-model + project-popover bodies (slice-F5-1b-cut.md §2-D4): `model`
// mirrors `SessionDraft.model` (tabs-store.ts) — `null` clears back to the
// provider default, same nullable posture as the store setter; `open` is a
// plain binary toggle, same shape as `ctxPopoverOpenBody` above. ──
const startScreenModelBody = z.object({ model: z.string().min(1).max(256).nullable() }).strict();
const startScreenProjectMenuBody = z.object({ open: z.boolean() }).strict();

// ── engine selection body (codex-fixes TASK.42, cut §3.7): `engineId` is a
// bare string here (not the shared `EngineId` enum) — same "server.ts owns
// zod, not the shared vocabulary" posture as `skillsNameBody`/`shortcutsActionBody`
// above; the facade's own `isEngineId` guard is the actual membership check,
// so an unknown value fails closed as `{ok:false, reason:"invalid_engine"}`
// rather than a 400 here. ──
const startScreenEngineBody = z.object({ engineId: z.string().min(1).max(64) }).strict();

// ── prompt-queue bodies (slice-P7.14-cut.md §5 W3): `tabId` rides in the body
// (not the path) — same posture as `transcriptScrollToBody` above, since the
// cut's route list is `/queue/*` with no `:tabId` segment. ──
const queueTabIdBody = z.object({ tabId: z.string().min(1) });
const queuePromptBody = z.object({ tabId: z.string().min(1), text: z.string() });
const queueEditBody = z.object({ tabId: z.string().min(1), id: z.string().min(1), text: z.string() });
const queueDeleteBody = z.object({ tabId: z.string().min(1), id: z.string().min(1) });

// ── model-pill pick body (slice-P7.15-cut.md §2.6 W4): `tabId` rides in the
// path (`/tabs/:tabId/model-pill/pick`), same posture as the git/project
// routes. `value` is required for "model"/"effort", absent for "open" — the
// discriminated union enforces that shape at the boundary (fail-closed). The
// effort enum mirrors `set_reasoning_effort`'s wire schema (protocol.ts). ──
const modelPillPickBody = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("open") }).strict(),
  z.object({ kind: z.literal("model"), value: z.string().min(1).max(256) }).strict(),
  z.object({ kind: z.literal("effort"), value: z.enum(["off", "low", "medium", "high", "max"]) }).strict(),
]);

// ── ctx-popover open/close body (slice-P7.17-cut.md F12 W4): `tabId` rides in
// the path (`/tabs/:tabId/ctx-popover/open`), same posture as the model-pill
// pick body above — a plain `{open: boolean}` body, since the driver is a
// single binary toggle (unlike the model-pill's multi-kind pick union). ──
const ctxPopoverOpenBody = z.object({ open: z.boolean() }).strict();

// ── settings bodies (slice-P7.16-cut.md §5 W4): GLOBAL (app-level) routes, no
// `:tabId` segment — Settings is not per-tab (same posture as the
// prompt-queue/start-screen bodies above, minus their `tabId` field). `pattern`
// mirrors `AlwaysAllowRule`'s optional field (shared/settings.ts) — absent
// means "all uses", never coerced to an empty string at this boundary. ──
const settingsPaneBody = z.object({ paneId: z.string().min(1).max(64) });
const settingsPermissionAddBody = z.object({
  toolName: z.string().min(1).max(128),
  pattern: z.string().max(4096).optional(),
});
const settingsPermissionRemoveBody = z.object({
  toolName: z.string().min(1).max(128),
  pattern: z.string().max(4096).optional(),
});

// ── provider connections grid/drawer bodies (TASK.45 W12): global (app-level)
// routes, no `:tabId` segment — same posture as the settings bodies above,
// the provider pane is not per-tab. `action` mirrors the frozen
// `ProviderMenuAction` union (automation.ts); every drawer-set field is
// optional (a caller sets only the fields it cares about, same convention as
// the facade's own `settingsProviderDrawerSet` signature). ──
const providerTileBody = z.object({ connectionId: z.string().min(1).max(256) }).strict();
const providerMenuActionBody = z
  .object({
    connectionId: z.string().min(1).max(256),
    action: z.enum(["edit", "replace_key", "check", "delete"]),
  })
  .strict();
const providerDrawerSetBody = z
  .object({
    providerId: z.string().max(256).optional(),
    label: z.string().max(256).optional(),
    model: z.string().max(256).optional(),
    transport: z.string().max(64).optional(),
    baseUrl: z.string().max(4096).optional(),
    apiKey: z.string().max(8192).optional(),
  })
  .strict();

// ── MCP Servers pane bodies (slice-P7.19-cut.md §4 W4): global (app-level)
// routes, no `:tabId` segment — same posture as the settings bodies above.
// `names` mirrors `McpImportApplyRequest.names` (shared/mcp-config.ts) — a
// caller-selected subset of the most recently scanned candidates; absent
// means "leave the dialog's own current selection as-is". ──
const mcpToggleBody = z.object({ name: z.string().min(1).max(256) });
const mcpImportApplyBody = z.object({
  consent: z.boolean(),
  names: z.array(z.string().min(1).max(256)).max(256).optional(),
});

// ── Skills pane bodies (slice-P7.20-cut.md §5 W4): global (app-level)
// routes, no `:tabId` segment — same posture as the MCP/settings bodies
// above. `ids` mirrors `SkillsImportApplyRequest.ids` (shared/skills-config.ts)
// — a caller-selected subset of the most recently scanned candidates' stable
// IDENTITIES (never bare names, two harnesses can share one); absent means
// "leave the dialog's own current selection as-is". `scope` mirrors
// `SkillScope` (shared/skills-config.ts) — kept a bare string literal union
// here rather than importing the shared type, same "server.ts owns zod, not
// the shared vocabulary" posture as every other body in this file. ──
const skillsNameBody = z.object({ name: z.string().min(1).max(256) });
const skillsImportApplyBody = z.object({
  scope: z.union([z.literal("project"), z.literal("user")]),
  ids: z.array(z.string().min(1).max(1024)).max(256).optional(),
});

// ── Subagents pane bodies (slice-P7.21-cut.md §4 W4): global (app-level)
// routes, no `:tabId` segment — same posture as the Skills/MCP bodies above.
// `name` in `subagentsEditorOpenBody` mirrors the row identity `subagents-
// config.ts`'s `SubagentsReadRequest` carries (name + sourceKind main-side —
// this HTTP boundary only needs the name, the pane's own edit button already
// disambiguates the row); omitted ⇒ open the CREATE dialog instead of an
// existing row's edit dialog. `subagentsEditorSetBody`'s fields are all
// optional (a partial patch — only the provided keys are driven onto the open
// editor's own form fields), capped the same as the editor's own client-side
// limits (SubagentsPane.tsx `SUBAGENT_BODY_MAX_BYTES`/tool-choice list). ──
const subagentsEditorOpenBody = z.object({ name: z.string().min(1).max(64).optional() });
const subagentsEditorSetBody = z.object({
  name: z.string().max(64).optional(),
  description: z.string().max(4096).optional(),
  tools: z.array(z.string().min(1).max(64)).max(32).optional(),
  body: z.string().max(65_536).optional(),
});
const subagentsNameBody = z.object({ name: z.string().min(1).max(64) });

// ── Slash-command menu bodies (slice-P7.23-cut.md §7 W4): `tabId` rides in
// the path (`/tabs/:tabId/slash-menu/...`), same posture as the model-pill/
// ctx-popover routes above. `composerTypeBody.text` caps at the same 20 KB a
// real pasted draft could reach (Composer.tsx's own paste-block threshold is
// far smaller than this — this is just a sane outer bound, not a UX limit).
// `composerKeyBody.key` is the closed set of keys the menu's own keydown
// switch (Composer.tsx) actually branches on. ──
const composerTypeBody = z.object({ text: z.string().max(20_000) }).strict();
const composerKeyBody = z.object({ key: z.enum(["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"]) }).strict();

// ── Rewind body (design slice-P7.26-R2-ratification.md §1 W3): the target
// checkpoint is EITHER an explicit `checkpointId` OR an `index` into the
// current newest-first list (facade's `checkpointRewind` resolves whichever
// is given — the shared `RewindScopeWire` enum, not re-typed). `checkpointId`'s
// cap mirrors `rewindRequestSchema`'s wire bound (protocol.ts) — anything that
// parses here must also parse at the host boundary, else an over-length id
// would pass HTTP, get silently dropped by the host, and hang the settle
// deadline. `.superRefine` enforces EXACTLY ONE selector (W3-FIX): both-set is
// ambiguous (the facade would silently prefer `checkpointId`, ignoring
// `index`) and neither-set has no target at all — both fail closed at the
// HTTP boundary rather than reaching the facade's own `checkpoint_not_specified`
// refusal. ──
const rewindBody = z
  .object({
    checkpointId: z.string().min(1).max(128).optional(),
    index: z.number().int().nonnegative().optional(),
    scope: z.enum(["both", "files", "conversation"]),
  })
  .strict()
  .superRefine((body, ctx) => {
    const hasCheckpointId = body.checkpointId !== undefined;
    const hasIndex = body.index !== undefined;
    if (hasCheckpointId === hasIndex) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: hasCheckpointId
          ? "exactly one of checkpointId/index must be given, not both"
          : "exactly one of checkpointId/index must be given",
      });
    }
  });

// ── Keyboard shortcuts pane bodies (slice-P7.24-cut.md §4 W4): global
// (app-level) routes, no `:tabId` segment — same posture as the MCP/Skills/
// Subagents/Profile bodies above. `action` is kept a bare string (not an enum
// of `ActionId`), same "server.ts owns zod, not the shared vocabulary"
// posture as `skillsNameBody`/`subagentsNameBody` — the facade itself is the
// one place that validates it against the real catalog. `slotIndex` omitted
// ⇒ append (mirrors the pane's own "+ Add" button). `shortcutsPressChordBody`
// mirrors the canonical `Chord` shape (keymap.ts) rather than a raw
// serialized string — this is a live keystroke to dispatch, not a value to
// persist. ──
const shortcutsStartRecordBody = z.object({
  action: z.string().min(1).max(64),
  slotIndex: z.number().int().min(0).max(64).optional(),
}).strict();
const shortcutsPressChordBody = z.object({
  key: z.string().min(1).max(32),
  mod: z.boolean(),
  shift: z.boolean().optional(),
}).strict();
const shortcutsSlotBody = z.object({
  action: z.string().min(1).max(64),
  slotIndex: z.number().int().min(0).max(64),
}).strict();
const shortcutsActionBody = z.object({ action: z.string().min(1).max(64) }).strict();

// ── Codex probe bodies (W4-F0, findings S1-1) ──
// Probe (b): ONE route, a union body — `{open}` toggles the chip popover,
// `{pick}` clicks the Nth RENDERED option row (rows carry no stable id in the
// DOM; index mirrors the component's own `.map()` render order, the same
// posture as the model-pill pick's clickItemAt). The cap mirrors the profile
// registry's own MAX_CODEX_PROFILES bound with headroom — never a UX limit.
const codexProfileChipBody = z.union([
  z.object({ open: z.boolean() }).strict(),
  z.object({ pick: z.number().int().nonnegative().max(64) }).strict(),
]);
// Probe (c): sub-routes under /settings/codex/import, same family shape as
// the MCP import routes. `profileId` mirrors codex-profiles' 32-char id cap
// (with headroom); `index` the rollout list's own MAX_ROLLOUTS_LISTED cap.
const codexImportOpenBody = z.object({ open: z.boolean() }).strict();
const codexImportProfileBody = z.object({ profileId: z.string().min(1).max(64) }).strict();
const codexImportRolloutBody = z.object({ index: z.number().int().nonnegative().max(500) }).strict();
const codexImportModelBody = z.object({ model: z.string().min(1).max(256) }).strict();

/** A malformed body/route/etc. carried as a typed rejection the request loop maps to a status. */
class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(typeof body === "object" && body !== null && "error" in body ? String((body as { error: unknown }).error) : "http_error");
  }
}

const loopbackAddrs = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
export function isLoopback(address: string | undefined): boolean {
  return address !== undefined && loopbackAddrs.has(address);
}

/**
 * Constant-time Bearer check (design §5). Length is compared first (a mismatch
 * cannot be timing-safe against a different-length buffer anyway); equal-length
 * tokens go through `timingSafeEqual`.
 */
export function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

function authorize(req: IncomingMessage, token: string): boolean {
  const header = req.headers["authorization"];
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    return false;
  }
  return tokenMatches(header.slice("Bearer ".length), token);
}

/** Reads the request body with a hard 256 KB cap (design §5): a declared Content-Length over the cap is refused up front; a lying/chunked client is cut off mid-stream. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      // Honest clients (fetch sets Content-Length) are rejected before reading a byte.
      req.resume(); // drain so the early response delivers cleanly
      reject(new HttpError(413, { error: "body_too_large" }));
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    req.on("data", (chunk: Buffer) => {
      if (settled) {
        return;
      }
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        settled = true;
        reject(new HttpError(413, { error: "body_too_large" }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!settled) {
        resolve(Buffer.concat(chunks));
      }
    });
    req.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

/** Parses a JSON body against `schema`; a bad JSON or shape is a 400. */
function parseBody<T>(raw: Buffer, schema: z.ZodType<T>): T {
  let json: unknown;
  if (raw.length === 0) {
    json = {};
  } else {
    try {
      json = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new HttpError(400, { error: "invalid_json" });
    }
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new HttpError(400, { error: "invalid_body", detail: parsed.error.issues });
  }
  return parsed.data;
}

function parseTail(searchParams: URLSearchParams): number | undefined {
  const raw = searchParams.get("tail");
  if (raw === null) {
    return undefined;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new HttpError(400, { error: "invalid_tail" });
  }
  return n;
}

/**
 * Routes one authorized request to a handler and returns its JSON result. Path
 * params (`:tabId`) are matched by splitting the pathname. Unknown routes -> 404.
 */
async function route(
  deps: HandlerDeps,
  req: IncomingMessage,
  pathname: string,
  searchParams: URLSearchParams,
  rawBody: Buffer,
): Promise<unknown> {
  const method = req.method ?? "GET";
  const parts = pathname.split("/").filter((p) => p.length > 0);

  // Read plane
  if (method === "GET" && pathname === "/health") {
    return health(deps);
  }
  if (method === "GET" && pathname === "/state") {
    return getState(deps, parseTail(searchParams));
  }
  if (method === "GET" && parts[0] === "state" && parts.length === 2) {
    return getStateForTab(deps, decodeURIComponent(parts[1]!), parseTail(searchParams));
  }
  if (method === "GET" && pathname === "/sessions") {
    return getSessions(deps);
  }
  if (method === "GET" && pathname === "/screenshot") {
    return screenshot(deps);
  }
  if (method === "GET" && pathname === "/transcript/scroll") {
    const tabId = searchParams.get("tabId");
    if (tabId === null || tabId.length === 0) {
      throw new HttpError(400, { error: "missing_tabId" });
    }
    return transcriptScrollState(deps, tabId);
  }
  if (method === "GET" && parts[0] === "tabs" && parts.length === 3 && parts[2] === "todo-panel") {
    return todoPanelState(deps, decodeURIComponent(parts[1]!));
  }
  // Model-pill probe (slice-P7.15-cut.md §2.6 W4): same `/tabs/:tabId/<probe>`
  // shape as the todo-panel GET route above.
  if (method === "GET" && parts[0] === "tabs" && parts.length === 3 && parts[2] === "model-pill") {
    return modelPillState(deps, decodeURIComponent(parts[1]!));
  }
  // Ctx-popover probe (slice-P7.17-cut.md F12 W4): same `/tabs/:tabId/<probe>`
  // shape as the model-pill/todo-panel GET routes above.
  if (method === "GET" && parts[0] === "tabs" && parts.length === 3 && parts[2] === "ctx-popover") {
    return ctxPopoverState(deps, decodeURIComponent(parts[1]!));
  }
  // Slash-command menu probe (slice-P7.23-cut.md §7 W4): same `/tabs/:tabId/<probe>`
  // shape as the model-pill/ctx-popover GET routes above.
  if (method === "GET" && parts[0] === "tabs" && parts.length === 3 && parts[2] === "slash-menu") {
    return slashMenuState(deps, decodeURIComponent(parts[1]!));
  }
  // Checkpoint timeline probe (design slice-P7.26-R2-ratification.md §1 W3):
  // same `/tabs/:tabId/<probe>` shape as the model-pill/ctx-popover/
  // slash-menu GET routes above.
  if (method === "GET" && parts[0] === "tabs" && parts.length === 3 && parts[2] === "checkpoints") {
    return checkpointPanelState(deps, decodeURIComponent(parts[1]!));
  }
  // Read-only counterpart of `POST /tabs/:tabId/rewind` below — same
  // `/tabs/:tabId/<probe>` shape, lets a caller read `lastResult`/
  // `transcriptBlockCount` (e.g. before any rewind, to capture a baseline)
  // without driving one.
  if (method === "GET" && parts[0] === "tabs" && parts.length === 3 && parts[2] === "rewind") {
    return rewindState(deps, decodeURIComponent(parts[1]!));
  }
  // Agent-card probe (slice-P7.18-cut.md §4 W4): `/tabs/:tabId/agent-card/:toolCallId`
  // — one segment deeper than the todo-panel/model-pill/ctx-popover GET
  // routes above (a per-card read, not a per-tab singleton), same
  // decodeURIComponent-both-segments posture.
  if (method === "GET" && parts[0] === "tabs" && parts.length === 4 && parts[2] === "agent-card") {
    return agentCardState(deps, decodeURIComponent(parts[1]!), decodeURIComponent(parts[3]!));
  }
  // Try-again button probe (TASK.33 W8-FIX #2): `/tabs/:tabId/try-again-button/:blockId`
  // — same per-block-scoped GET shape as the agent-card probe above.
  if (method === "GET" && parts[0] === "tabs" && parts.length === 4 && parts[2] === "try-again-button") {
    return tryAgainButtonState(deps, decodeURIComponent(parts[1]!), decodeURIComponent(parts[3]!));
  }
  if (method === "GET" && pathname === "/start-screen") {
    return startScreenState(deps);
  }
  // Settings probe (slice-P7.16-cut.md §5 W4): global (app-level), no
  // `:tabId` segment — same GET-with-no-body shape as GET /start-screen above.
  if (method === "GET" && pathname === "/settings") {
    return settingsState(deps);
  }
  // MCP Servers pane probe (slice-P7.19-cut.md §4 W4): a DEDICATED route —
  // `GET /settings` above (settingsState()) stays byte-untouched (§3
  // byte-lock), same "own probe, no widening" posture as the agent-card /
  // ctx-popover probes.
  if (method === "GET" && pathname === "/settings/mcp") {
    return mcpPaneState(deps);
  }
  // Skills pane probe (slice-P7.20-cut.md §5 W4): a DEDICATED route —
  // `GET /settings` and `GET /settings/mcp` above stay byte-untouched (§4
  // custody), same "own probe, no widening" posture as the MCP pane probe.
  if (method === "GET" && pathname === "/settings/skills") {
    return skillsPaneState(deps);
  }
  // Subagents pane probe (slice-P7.21-cut.md §4 W4): a DEDICATED route —
  // `GET /settings`, `GET /settings/mcp`, and `GET /settings/skills` above
  // stay byte-untouched (§4 custody), same "own probe, no widening" posture
  // as the Skills pane probe.
  if (method === "GET" && pathname === "/settings/subagents") {
    return subagentsPaneState(deps);
  }
  // Profile pane probe (slice-P7.22-cut.md §4 W4): a DEDICATED route —
  // `GET /settings`, `GET /settings/mcp`, `GET /settings/skills`, and `GET
  // /settings/subagents` above all stay byte-untouched (§4 custody), same
  // "own probe, no widening" posture as the Subagents pane probe.
  if (method === "GET" && pathname === "/settings/profile") {
    return profilePaneState(deps);
  }
  // Keyboard shortcuts pane probe (slice-P7.24-cut.md §4 W4): a DEDICATED
  // route — every prior `/settings*` probe above stays byte-untouched (§4
  // custody), same "own probe, no widening" posture as the Profile pane
  // probe.
  if (method === "GET" && pathname === "/settings/shortcuts") {
    return shortcutsPaneState(deps);
  }
  // Provider connections pane probe (TASK.45 W12): a DEDICATED route — every
  // prior `/settings*` probe above stays byte-untouched (§4 custody), same
  // "own probe, no widening" posture as the Profile/Shortcuts pane probes.
  if (method === "GET" && pathname === "/settings/provider") {
    return settingsProviderPaneState(deps);
  }
  // Codex pane probe (W4-F0, findings S1-1 probe (a)): a DEDICATED route —
  // every prior `/settings*` probe above stays byte-untouched (§4 custody),
  // same "own probe, no widening" posture as the Provider pane probe.
  if (method === "GET" && pathname === "/settings/codex") {
    return codexPaneState(deps);
  }
  // Rollout-import dialog probe (W4-F0, findings S1-1 probe (c)): a DEDICATED
  // route under the codex family — distinct exact path from GET
  // /settings/codex above, same nesting shape as /settings/mcp's import
  // sub-routes.
  if (method === "GET" && pathname === "/settings/codex/import") {
    return codexImportState(deps);
  }
  // Codex profile chip probe (W4-F0, findings S1-1 probe (b)): a DEDICATED
  // route — GET /start-screen and its StartScreenState shape stay
  // byte-untouched (hazard §14.1: no snapshot widening).
  if (method === "GET" && pathname === "/start-screen/codex-profile") {
    return codexProfileChipState(deps);
  }
  // Generic focus probe (TASK.45 W12-smoke): a DEDICATED route — no pane
  // above is widened to carry this, `document.activeElement` is shell-level,
  // not owned by any one pane/screen.
  if (method === "GET" && pathname === "/focus") {
    return focusState(deps);
  }
  // LSP / Hooks panel probes (slice-P7.25-cut.md §3 W3): same `?tabId=` query
  // shape as `GET /transcript/scroll` above — the panels aren't per-tab DOM
  // (App.tsx mounts them once for the active tab, not per data-tab-id), so a
  // path segment would be a lie; the query param is the tab this read is FOR.
  if (method === "GET" && pathname === "/panels/lsp") {
    const tabId = searchParams.get("tabId");
    if (tabId === null || tabId.length === 0) {
      throw new HttpError(400, { error: "missing_tabId" });
    }
    return lspPanelState(deps, tabId);
  }
  if (method === "GET" && pathname === "/panels/hooks") {
    const tabId = searchParams.get("tabId");
    if (tabId === null || tabId.length === 0) {
      throw new HttpError(400, { error: "missing_tabId" });
    }
    return hooksPanelState(deps, tabId);
  }

  // Action plane
  if (method === "POST" && pathname === "/tabs") {
    const body = parseBody(rawBody, createTabBody);
    return body.kind === "new" ? createTabNew(deps, body.workspace) : resumeTab(deps, body.sessionId, body.replacementConnectionId);
  }
  if (method === "POST" && pathname === "/wait") {
    const body = parseBody(rawBody, waitBody);
    return waitFor(deps, body.tabId, body.until, body.timeoutMs);
  }
  if (method === "POST" && pathname === "/quit") {
    parseBody(rawBody, emptyBody);
    return quit(deps);
  }
  if (method === "POST" && pathname === "/transcript/scroll") {
    const body = parseBody(rawBody, transcriptScrollToBody);
    return transcriptScrollTo(deps, body.tabId, body.to);
  }
  // Start-screen routes (slice-P7.12-cut.md §5 W2): mirror the SAME store
  // actions / `submitStartDraft` StartScreen.tsx itself calls (§4.5), through
  // the facade's thin wrappers — no second path.
  if (method === "POST" && pathname === "/start-screen/open") {
    const body = parseBody(rawBody, startScreenOpenBody);
    return startScreenOpen(deps, body.workspace);
  }
  if (method === "POST" && pathname === "/start-screen/workspace") {
    const body = parseBody(rawBody, startScreenWorkspaceBody);
    return startScreenSetWorkspace(deps, body.workspace);
  }
  if (method === "POST" && pathname === "/start-screen/prompt") {
    const body = parseBody(rawBody, promptBody);
    return startScreenSetPrompt(deps, body.text);
  }
  if (method === "POST" && pathname === "/start-screen/model") {
    const body = parseBody(rawBody, startScreenModelBody);
    return startScreenSetModel(deps, body.model);
  }
  // Engine selection (codex-fixes TASK.42, cut §3.7): mirrors the SAME
  // tabs-store `setDraftEngine` draft action the (future) start-screen engine
  // picker will call, through the facade's thin wrapper — no second path.
  // Read-back rides GET /start-screen (`engine`/`availableEngines`), same
  // "no dedicated GET route" posture as startScreenSetModel/SetPrompt above.
  if (method === "POST" && pathname === "/start-screen/engine") {
    const body = parseBody(rawBody, startScreenEngineBody);
    return startScreenSetEngine(deps, body.engineId);
  }
  if (method === "POST" && pathname === "/start-screen/project-menu") {
    const body = parseBody(rawBody, startScreenProjectMenuBody);
    return startScreenToggleProjectMenu(deps, body.open);
  }
  // Codex profile chip driver (W4-F0 probe (b)): one route, a union body —
  // `{open}` mirrors a real click on the chip button, `{pick}` a real click
  // on the Nth rendered option row (see codexProfileChipBody's doc comment).
  if (method === "POST" && pathname === "/start-screen/codex-profile") {
    const body = parseBody(rawBody, codexProfileChipBody);
    return "open" in body ? codexProfileChipOpen(deps, body.open) : codexProfileChipPick(deps, body.pick);
  }
  if (method === "POST" && pathname === "/start-screen/submit") {
    parseBody(rawBody, emptyBody);
    return startScreenSubmit(deps);
  }
  // Settings routes (slice-P7.16-cut.md §5 W4): global (app-level), no
  // `:tabId` segment — mirror the SAME DOM paths SettingsScreen/
  // PermissionsEditor themselves use (gear trigger / Back-to-app row / rail
  // tab / manual-add form / row remove button), through the facade's thin
  // wrappers — no second path.
  if (method === "POST" && pathname === "/settings/open") {
    parseBody(rawBody, emptyBody);
    return settingsOpen(deps);
  }
  if (method === "POST" && pathname === "/settings/close") {
    parseBody(rawBody, emptyBody);
    return settingsClose(deps);
  }
  if (method === "POST" && pathname === "/settings/pane") {
    const body = parseBody(rawBody, settingsPaneBody);
    return settingsSelectPane(deps, body.paneId);
  }
  if (method === "POST" && pathname === "/settings/permissions/add") {
    const body = parseBody(rawBody, settingsPermissionAddBody);
    return settingsPermissionAdd(deps, body.toolName, body.pattern);
  }
  if (method === "POST" && pathname === "/settings/permissions/remove") {
    const body = parseBody(rawBody, settingsPermissionRemoveBody);
    return settingsPermissionRemove(deps, body.toolName, body.pattern);
  }
  // Provider connections grid/drawer routes (TASK.45 W12): mirror the SAME DOM
  // paths ConnectionTile/ConnectionDrawer themselves use (the "+ Add
  // connection" tile, a tile's select button, its overflow menu's four
  // actions, the drawer's own fields/buttons), through the facade's thin
  // wrappers — no second path.
  if (method === "POST" && pathname === "/settings/provider/add") {
    parseBody(rawBody, emptyBody);
    return settingsProviderAddOpen(deps);
  }
  if (method === "POST" && pathname === "/settings/provider/tile") {
    const body = parseBody(rawBody, providerTileBody);
    return settingsProviderTileClick(deps, body.connectionId);
  }
  if (method === "POST" && pathname === "/settings/provider/menu") {
    const body = parseBody(rawBody, providerMenuActionBody);
    return settingsProviderMenuAction(deps, body.connectionId, body.action);
  }
  if (method === "POST" && pathname === "/settings/provider/drawer/set") {
    const body = parseBody(rawBody, providerDrawerSetBody);
    return settingsProviderDrawerSet(deps, body);
  }
  if (method === "POST" && pathname === "/settings/provider/drawer/submit") {
    parseBody(rawBody, emptyBody);
    return settingsProviderDrawerSubmit(deps);
  }
  if (method === "POST" && pathname === "/settings/provider/drawer/save-key") {
    parseBody(rawBody, emptyBody);
    return settingsProviderDrawerSaveKey(deps);
  }
  if (method === "POST" && pathname === "/settings/provider/drawer/clear-key") {
    parseBody(rawBody, emptyBody);
    return settingsProviderDrawerClearKey(deps);
  }
  if (method === "POST" && pathname === "/settings/provider/drawer/close") {
    parseBody(rawBody, emptyBody);
    return settingsProviderDrawerClose(deps);
  }
  // Codex pane routes (W4-F0, findings S1-1 probe (a)): mirror the SAME DOM
  // paths CodexEnginePane.tsx itself uses — real clicks on the pane's own
  // "Install …"/"Update to …" primary, "Recheck all", and "Refresh manifest"
  // buttons, so each runs the exact bridge.install/recheck/manifestRefresh
  // controller call the button's onClick makes (one product path, cut §7's
  // install/manifest IPC channels are never re-invoked from here).
  if (method === "POST" && pathname === "/settings/codex/install") {
    parseBody(rawBody, emptyBody);
    return codexPaneInstall(deps);
  }
  if (method === "POST" && pathname === "/settings/codex/recheck") {
    parseBody(rawBody, emptyBody);
    return codexPaneRecheckAll(deps);
  }
  if (method === "POST" && pathname === "/settings/codex/manifest-refresh") {
    parseBody(rawBody, emptyBody);
    return codexPaneRefreshManifest(deps);
  }
  // Rollout-import dialog routes (W4-F0, findings S1-1 probe (c)): mirror the
  // SAME DOM paths CodexRolloutImportDialog.tsx itself uses (the pane's
  // "Import a Codex session…" entry button, the dialog's profile/model
  // selects, a rollout row's radio, the "Import & open" button), through the
  // facade's thin wrappers — no second path.
  if (method === "POST" && pathname === "/settings/codex/import/open") {
    const body = parseBody(rawBody, codexImportOpenBody);
    return codexImportOpen(deps, body.open);
  }
  if (method === "POST" && pathname === "/settings/codex/import/profile") {
    const body = parseBody(rawBody, codexImportProfileBody);
    return codexImportSetProfile(deps, body.profileId);
  }
  if (method === "POST" && pathname === "/settings/codex/import/rollout") {
    const body = parseBody(rawBody, codexImportRolloutBody);
    return codexImportSelectRollout(deps, body.index);
  }
  if (method === "POST" && pathname === "/settings/codex/import/model") {
    const body = parseBody(rawBody, codexImportModelBody);
    return codexImportSetModel(deps, body.model);
  }
  if (method === "POST" && pathname === "/settings/codex/import/apply") {
    parseBody(rawBody, emptyBody);
    return codexImportApply(deps);
  }
  // MCP Servers pane routes (slice-P7.19-cut.md §4 W4): mirror the SAME DOM
  // paths McpServersPane.tsx itself uses (the row's enable switch, the
  // header import button, the dialog's Apply button), through the facade's
  // thin wrappers — no second path.
  if (method === "POST" && pathname === "/settings/mcp/toggle") {
    const body = parseBody(rawBody, mcpToggleBody);
    return mcpToggle(deps, body.name);
  }
  if (method === "POST" && pathname === "/settings/mcp/import/open") {
    parseBody(rawBody, emptyBody);
    return mcpImportOpen(deps);
  }
  if (method === "POST" && pathname === "/settings/mcp/import/apply") {
    const body = parseBody(rawBody, mcpImportApplyBody);
    return mcpImportApply(deps, { consent: body.consent, names: body.names });
  }
  // Skills pane routes (slice-P7.20-cut.md §5 W4): mirror the SAME DOM paths
  // SkillsPane.tsx itself uses (a row's enable switch, the row's
  // delete-then-confirm buttons, the header import button, the dialog's
  // Apply button), through the facade's thin wrappers — no second path.
  if (method === "POST" && pathname === "/settings/skills/toggle") {
    const body = parseBody(rawBody, skillsNameBody);
    return skillsToggle(deps, body.name);
  }
  if (method === "POST" && pathname === "/settings/skills/delete") {
    const body = parseBody(rawBody, skillsNameBody);
    return skillsDelete(deps, body.name);
  }
  if (method === "POST" && pathname === "/settings/skills/import/open") {
    parseBody(rawBody, emptyBody);
    return skillsImportOpen(deps);
  }
  if (method === "POST" && pathname === "/settings/skills/import/apply") {
    const body = parseBody(rawBody, skillsImportApplyBody);
    return skillsImportApply(deps, { scope: body.scope, ids: body.ids });
  }
  // Subagents pane routes (slice-P7.21-cut.md §4 W4): mirror the SAME DOM
  // paths SubagentsPane.tsx itself uses (the header's create button, a row's
  // edit/delete buttons, the editor dialog's fields/tabs/Save button),
  // through the facade's thin wrappers — no second path.
  if (method === "POST" && pathname === "/settings/subagents/editor/open") {
    const body = parseBody(rawBody, subagentsEditorOpenBody);
    return subagentsOpenEditor(deps, body.name);
  }
  if (method === "POST" && pathname === "/settings/subagents/editor/set") {
    const body = parseBody(rawBody, subagentsEditorSetBody);
    return subagentsEditorSet(deps, body);
  }
  if (method === "POST" && pathname === "/settings/subagents/editor/preview") {
    parseBody(rawBody, emptyBody);
    return subagentsEditorPreview(deps);
  }
  if (method === "POST" && pathname === "/settings/subagents/editor/save") {
    parseBody(rawBody, emptyBody);
    return subagentsEditorSave(deps);
  }
  if (method === "POST" && pathname === "/settings/subagents/delete") {
    const body = parseBody(rawBody, subagentsNameBody);
    return subagentsDelete(deps, body.name);
  }
  // Profile pane route (slice-P7.22-cut.md §4 W4): mirrors the SAME DOM path
  // ProfilePane.tsx itself uses (the telemetry toggle switch), through the
  // facade's thin wrapper — no second path. Unary (mirrors a real click on
  // the switch — always flips the CURRENT state), so no request body beyond
  // the shared empty-body shape.
  if (method === "POST" && pathname === "/settings/profile/telemetry") {
    parseBody(rawBody, emptyBody);
    return profileToggleTelemetry(deps);
  }
  // Keyboard shortcuts pane routes (slice-P7.24-cut.md §4 W4): mirror the
  // SAME DOM paths KeyboardShortcutsPane.tsx itself uses (a slot's pencil /
  // the "+ Add" button, the Reset button, a badge's "×"), through the
  // facade's thin wrappers — no second path. `shortcutsPressChord` is the one
  // exception: it dispatches a bare global `keydown`, valid with or without
  // the pane mounted (design §4 W4's real end-to-end shortcut-effect path).
  if (method === "POST" && pathname === "/settings/shortcuts/record") {
    const body = parseBody(rawBody, shortcutsStartRecordBody);
    return shortcutsStartRecord(deps, body.action, body.slotIndex);
  }
  if (method === "POST" && pathname === "/settings/shortcuts/press") {
    const body = parseBody(rawBody, shortcutsPressChordBody);
    return shortcutsPressChord(deps, body);
  }
  if (method === "POST" && pathname === "/settings/shortcuts/remove") {
    const body = parseBody(rawBody, shortcutsSlotBody);
    return shortcutsRemoveBinding(deps, body.action, body.slotIndex);
  }
  if (method === "POST" && pathname === "/settings/shortcuts/reset") {
    const body = parseBody(rawBody, shortcutsActionBody);
    return shortcutsReset(deps, body.action);
  }
  // Prompt-queue routes (slice-P7.14-cut.md §5 W3): mirror the SAME store
  // actions Composer/PromptQueue.tsx call, through the facade's thin wrappers
  // — no second path. Queue state itself is read via the existing GET /state.
  if (method === "POST" && pathname === "/queue/prompt") {
    const body = parseBody(rawBody, queuePromptBody);
    return queuePrompt(deps, body.tabId, body.text);
  }
  if (method === "POST" && pathname === "/queue/edit") {
    const body = parseBody(rawBody, queueEditBody);
    return queueEdit(deps, body.tabId, body.id, body.text);
  }
  if (method === "POST" && pathname === "/queue/delete") {
    const body = parseBody(rawBody, queueDeleteBody);
    return queueDelete(deps, body.tabId, body.id);
  }
  if (method === "POST" && pathname === "/queue/resume") {
    const body = parseBody(rawBody, queueTabIdBody);
    return queueResume(deps, body.tabId);
  }
  if (method === "POST" && pathname === "/queue/clear") {
    const body = parseBody(rawBody, queueTabIdBody);
    return queueClear(deps, body.tabId);
  }
  // LSP / Hooks panel toggles (slice-P7.25-cut.md §3 W3): mirror a real click
  // on the SessionHeader's own toggle button, through the facade's thin
  // wrapper — no second path. Same `{tabId}`-only body shape as
  // `queueTabIdBody` above.
  if (method === "POST" && pathname === "/panels/lsp/toggle") {
    const body = parseBody(rawBody, queueTabIdBody);
    return lspPanelToggle(deps, body.tabId);
  }
  if (method === "POST" && pathname === "/panels/hooks/toggle") {
    const body = parseBody(rawBody, queueTabIdBody);
    return hooksPanelToggle(deps, body.tabId);
  }
  if (method === "POST" && parts[0] === "tabs" && parts.length === 3) {
    const tabId = decodeURIComponent(parts[1]!);
    const action = parts[2]!;
    switch (action) {
      case "prompt":
        return sendPrompt(deps, tabId, parseBody(rawBody, promptBody).text);
      case "permission": {
        const body = parseBody(rawBody, permissionBody);
        return respondPermission(deps, tabId, body.behavior, body.requestId);
      }
      case "mode":
        return setMode(deps, tabId, parseBody(rawBody, modeBody).mode);
      case "stop":
        parseBody(rawBody, emptyBody);
        return stop(deps, tabId);
      case "retry":
        parseBody(rawBody, emptyBody);
        return tryAgain(deps, tabId);
      case "select":
        parseBody(rawBody, emptyBody);
        return selectTab(deps, tabId);
      case "close":
        parseBody(rawBody, emptyBody);
        return closeTab(deps, tabId);
      case "git": {
        const body = parseBody(rawBody, gitCommandBody);
        return gitCommand(deps, tabId, body.command);
      }
      case "rewind": {
        const body = parseBody(rawBody, rewindBody);
        return checkpointRewind(deps, tabId, { checkpointId: body.checkpointId, index: body.index, scope: body.scope });
      }
      default:
        throw new HttpError(404, { error: "not_found" });
    }
  }
  // Project routes (design/slice-GUI-P1-cut.md §2F.5): mirror the sidebar's
  // two project-menu actions through the SAME facade methods the automated

  // above applies to these routes for free.
  if (method === "POST" && parts[0] === "projects" && parts.length === 2) {
    const body = parseBody(rawBody, projectBody);
    switch (parts[1]) {
      case "new":
        return projectNewSession(deps, body.workspace);
      case "hide":
        return projectHide(deps, body.workspace);
      default:
        throw new HttpError(404, { error: "not_found" });
    }
  }
  // Git sub-routes (slice-5.8-R8-cut.md §2.3): `/tabs/:tabId/git/:action`
  // (length 4) and the two-step confirm accept/cancel (`/tabs/:tabId/git/confirm/:step`,
  // length 5). Read-plane is unchanged — git rides the existing GET /state[/:tabId]
  // and POST /wait (§2.1a).
  if (method === "POST" && parts[0] === "tabs" && parts.length === 4 && parts[2] === "git") {
    const tabId = decodeURIComponent(parts[1]!);
    const action = parts[3]!;
    switch (action) {
      case "confirm": {
        const body = parseBody(rawBody, gitIntentBody);
        return gitStageConfirm(deps, tabId, body.intent);
      }
      case "panel": {
        const body = parseBody(rawBody, gitPanelBody);
        return gitPanel(deps, tabId, body.open);
      }
      case "view": {
        const body = parseBody(rawBody, gitViewBody);
        return gitView(deps, tabId, body.view);
      }
      default:
        throw new HttpError(404, { error: "not_found" });
    }
  }
  if (method === "POST" && parts[0] === "tabs" && parts.length === 5 && parts[2] === "git" && parts[3] === "confirm") {
    const tabId = decodeURIComponent(parts[1]!);
    const step = parts[4]!;
    if (step === "accept") {
      parseBody(rawBody, emptyBody);
      return gitConfirmAccept(deps, tabId);
    }
    if (step === "cancel") {
      parseBody(rawBody, emptyBody);
      return gitConfirmCancel(deps, tabId);
    }
    throw new HttpError(404, { error: "not_found" });
  }
  // Model-pill pick (slice-P7.15-cut.md §2.6 W4): `/tabs/:tabId/model-pill/pick`
  // — same `parts.length === 4` shape as the git sub-routes above, just with
  // `model-pill` in the `parts[2]` slot instead of `git`.
  if (method === "POST" && parts[0] === "tabs" && parts.length === 4 && parts[2] === "model-pill" && parts[3] === "pick") {
    const tabId = decodeURIComponent(parts[1]!);
    const body = parseBody(rawBody, modelPillPickBody);
    return modelPillPick(deps, tabId, body);
  }
  // Ctx-popover open/close (slice-P7.17-cut.md F12 W4): `/tabs/:tabId/ctx-popover/open`
  // — same `parts.length === 4` shape as the model-pill pick route above, just
  // with `ctx-popover`/`open` in the `parts[2]`/`parts[3]` slots.
  if (method === "POST" && parts[0] === "tabs" && parts.length === 4 && parts[2] === "ctx-popover" && parts[3] === "open") {
    const tabId = decodeURIComponent(parts[1]!);
    const body = parseBody(rawBody, ctxPopoverOpenBody);
    return ctxPopoverOpen(deps, tabId, body.open);
  }
  // Slash-command menu drivers (slice-P7.23-cut.md §7 W4): `/tabs/:tabId/slash-menu/type`
  // and `/tabs/:tabId/slash-menu/key` — same `parts.length === 4` shape as the
  // model-pill pick / ctx-popover open routes above.
  if (method === "POST" && parts[0] === "tabs" && parts.length === 4 && parts[2] === "slash-menu" && parts[3] === "type") {
    const tabId = decodeURIComponent(parts[1]!);
    const body = parseBody(rawBody, composerTypeBody);
    return composerType(deps, tabId, body.text);
  }
  if (method === "POST" && parts[0] === "tabs" && parts.length === 4 && parts[2] === "slash-menu" && parts[3] === "key") {
    const tabId = decodeURIComponent(parts[1]!);
    const body = parseBody(rawBody, composerKeyBody);
    return composerKey(deps, tabId, body.key);
  }
  // Dev-only host-kill lever (TASK.33 FIX-A): `/tabs/:tabId/host/kill` — same
  // `parts.length === 4` shape as the model-pill pick / ctx-popover open /
  // slash-menu routes above, forces the tab's real host child to exit so the
  // existing crash-respawn machinery (tabs.ts) runs for a discriminating
  // cross-respawn smoke.
  if (method === "POST" && parts[0] === "tabs" && parts.length === 4 && parts[2] === "host" && parts[3] === "kill") {
    parseBody(rawBody, emptyBody);
    return killHost(deps, decodeURIComponent(parts[1]!));
  }
  // Agent-card expand driver (slice-P7.18-cut.md §4 W4):
  // `/tabs/:tabId/agent-card/:toolCallId/expand` — one segment deeper than
  // the agent-card GET probe above, mirroring the ctx-popover open route's
  // `parts.length === 5` shape with an extra `:toolCallId` path segment. No
  // body (an idempotent "ensure expanded" action, unlike ctx-popover's
  // binary open/close toggle).
  if (
    method === "POST" &&
    parts[0] === "tabs" &&
    parts.length === 5 &&
    parts[2] === "agent-card" &&
    parts[4] === "expand"
  ) {
    parseBody(rawBody, emptyBody);
    return agentCardExpand(deps, decodeURIComponent(parts[1]!), decodeURIComponent(parts[3]!));
  }
  // Try-again button click driver (TASK.33 W8-FIX #2):
  // `/tabs/:tabId/try-again-button/:blockId/click` — one segment deeper than
  // the try-again-button GET probe above, same `parts.length === 5` shape as
  // the agent-card expand route. Fires a REAL DOM click on the button, not
  // the pre-existing `POST /tabs/:tabId/retry` facade shortcut (`tryAgain`,
  // which calls `dispatchTryAgain` directly).
  if (
    method === "POST" &&
    parts[0] === "tabs" &&
    parts.length === 5 &&
    parts[2] === "try-again-button" &&
    parts[4] === "click"
  ) {
    parseBody(rawBody, emptyBody);
    return tryAgainButtonClick(deps, decodeURIComponent(parts[1]!), decodeURIComponent(parts[3]!));
  }

  throw new HttpError(404, { error: "not_found" });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body ?? null), "utf8");
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": payload.length });
  res.end(payload);
}

function statusForError(error: unknown): { status: number; body: unknown } {
  if (error instanceof HttpError) {
    return { status: error.status, body: error.body };
  }
  if (error instanceof FacadeUnavailableError) {
    return { status: 503, body: { error: "facade_unavailable", detail: error.detail } };
  }
  if (error instanceof FacadeThrewError) {
    return { status: 500, body: { error: "facade_error", detail: error.detail } };
  }
  return { status: 500, body: { error: "internal", detail: String((error as Error)?.message ?? error) } };
}

/** Fallback discovery-file path when nothing more specific is configured. */
const DEFAULT_INFO_PATH = (): string => join(homedir(), ".anycode", "automation.json");

/**
 * Discovery-file path (design/slice-P7.H-cut.md §4.3): `explicit` (test
 * injection) wins over `ANYCODE_AUTOMATION_INFO` (per-run smoke isolation)
 * wins over the default `~/.anycode/automation.json`. No extra gate needed
 * here — this whole module only loads under the existing double gate
 * (`ANYCODE_AUTOMATION==="1" && !app.isPackaged`, main/index.ts).
 *
 * The env value is trimmed before use and MUST resolve to an absolute path:
 * an untrimmed/relative value (e.g. a leading space, or `./x.json`) would
 * otherwise be silently resolved against `process.cwd()` at write time,
 * landing the discovery file somewhere the caller never intended. A
 * non-absolute value is ignored (single `logger.warn`, fall back to the
 * default path) rather than used as-is (fail-closed on a malformed override).
 */
function resolveInfoPath(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv,
  logger: { warn(...a: unknown[]): void },
): string {
  if (explicit !== undefined) {
    return explicit;
  }
  const raw = env["ANYCODE_AUTOMATION_INFO"];
  if (raw === undefined) {
    return DEFAULT_INFO_PATH();
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    return DEFAULT_INFO_PATH();
  }
  if (!isAbsolute(trimmed)) {
    logger.warn(`[automation] ANYCODE_AUTOMATION_INFO must be an absolute path; ignoring: ${JSON.stringify(raw)}`);
    return DEFAULT_INFO_PATH();
  }
  return trimmed;
}

/** Writes the discovery file mode 0600, overwriting any stale one (design §5). */
function writeInfoFile(infoPath: string, info: { pid: number; port: number; token: string; startedAt: number }): void {
  mkdirSync(dirname(infoPath), { recursive: true });
  // writeFileSync's mode only applies when CREATING the file, so an existing
  // (stale) file could keep looser perms — chmod after to guarantee 0600.
  writeFileSync(infoPath, JSON.stringify(info, null, 2), { mode: 0o600 });
  chmodSync(infoPath, 0o600);
}

/**
 * True iff the discovery file at `infoPath` currently belongs to THIS server
 * instance (its port + token match). Guards `close()`'s unlink (design
 * codex-finding P7.H-1): two servers sharing one discovery path (e.g. a stale
 * env-var pointing two dev launches at the same file) means the second one to
 * start overwrites the first one's file; the first one's `close()` must not
 * then unlink the SECOND server's live file. Any read/parse failure (file
 * missing, foreign shape, garbage) is treated as "not ours" — a close never
 * deletes a file it cannot positively identify as its own.
 */
function ownsInfoFile(infoPath: string, self: { port: number; token: string }): boolean {
  let raw: string;
  try {
    raw = readFileSync(infoPath, "utf8");
  } catch {
    return false;
  }
  try {
    const parsed = JSON.parse(raw) as { port?: unknown; token?: unknown };
    return parsed.port === self.port && parsed.token === self.token;
  } catch {
    return false;
  }
}

/**
 * Starts the automation HTTP server (design §2.3). Returns a handle whose
 * `close()` shuts the listener and unlinks the discovery file — also wired to

 * once the socket is actually listening (so the caller/tests know the port).
 */
export function startAutomationServer(deps: AutomationServerDeps): Promise<AutomationServerHandle> {
  const logger = deps.logger ?? console;
  const token = deps.token ?? randomBytes(32).toString("hex");
  const infoPath = resolveInfoPath(deps.infoPath, process.env, logger);
  const requestedPort = deps.port ?? (Number(process.env["ANYCODE_AUTOMATION_PORT"]) || 0);
  // Set once the socket is actually bound (listen callback below); `close()`
  // needs the REAL port (not `requestedPort`, which may be 0/ephemeral) to
  // decide whether the on-disk discovery file is still this server's own.
  let boundPort: number | undefined;

  const handlerDeps: HandlerDeps = {
    callFacade: makeFacadeCaller(deps.getWindow),
    getWindow: deps.getWindow,
    manager: deps.manager,
    app: deps.app,
    activeConnectionId: deps.activeConnectionId,
  };

  const server = createServer((req, res) => {
    // Defense-in-depth (§5.2): we only ever bind 127.0.0.1, but destroy any
    // non-loopback peer that somehow reaches us before doing anything else.
    if (!isLoopback(req.socket.remoteAddress)) {
      req.socket.destroy();
      return;
    }
    // Auth on EVERY route (§5.3), before body read or routing.
    if (!authorize(req, token)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const rawBody = req.method === "GET" || req.method === "HEAD" ? Buffer.alloc(0) : await readBody(req);
        const result = await route(handlerDeps, req, url.pathname, url.searchParams, rawBody);
        sendJson(res, 200, result);
      } catch (error) {
        const { status, body } = statusForError(error);
        if (status >= 500) {
          logger.error(`[automation] ${req.method} ${req.url} -> ${status}`, error);
        }
        sendJson(res, status, body);
      }
    })();
  });

  // Reject any non-loopback socket at connection time too (§5.2).
  server.on("connection", (socket: Socket) => {
    if (!isLoopback(socket.remoteAddress)) {
      socket.destroy();
    }
  });

  let closed = false;
  const close = (): Promise<void> => {
    if (closed) {
      return Promise.resolve();
    }
    closed = true;
    try {
      // Only unlink if the file on disk still describes THIS server (P7.H-1):
      // a shared discovery path where a second server started and overwrote
      // the file must leave that second server's file alone.
      if (boundPort !== undefined && ownsInfoFile(infoPath, { port: boundPort, token })) {
        unlinkSync(infoPath);
      }
    } catch {
      // Already gone, never written, or a transient fs error — fine, best-effort.
    }
    return new Promise((resolve) => server.close(() => resolve()));
  };


  // alongside main's own before-quit host-shutdown handler; server.close() is
  // fast and independent.
  addBeforeQuit(deps.app, () => void close());

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : requestedPort;
      boundPort = port;
      // A discovery-file write failure (e.g. an unwritable ~/.anycode) must not
      // crash the process post-bind — the listener is already accepting
      // connections; log and keep serving without discovery (design codex
      // finding P7.H-4).
      try {
        writeInfoFile(infoPath, { pid: process.pid, port, token, startedAt: Date.now() });
      } catch (error) {
        logger.warn(`[automation] failed to write discovery file ${infoPath}; continuing without it`, error);
      }
      // NEVER log the token (§5).
      logger.log(`[automation] listening on 127.0.0.1:${port} (discovery: ${infoPath})`);
      resolve({ server, port, token, infoPath, close });
    });
  });
}

/** `app` may be Electron's real App (has `.on`) or a test fake (may not); register the before-quit hook only when possible. */
function addBeforeQuit(app: AppLike, fn: () => void): void {
  const withOn = app as AppLike & { on?: (event: string, listener: () => void) => void };
  if (typeof withOn.on === "function") {
    withOn.on("before-quit", fn);
  }
}
