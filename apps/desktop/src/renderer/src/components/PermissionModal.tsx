/**
 * Permission-request modal (design /working-docs/build/design/phase-mvp.md
 * §4/§5): a native `<dialog>` (no Radix — design §5 keeps the MVP to plain
 * CSS/native elements), shown whenever `request` is non-null. Fully
 * controlled: this component never touches the store itself, it only calls
 * `onAllow`/`onDeny` — the caller (MVP.6's App.tsx, or the `Connected*`
 * wrapper below) decides what those do and owns clearing `request` back to
 * null once the host round-trips a `permission_settled`. Visibility is
 * therefore driven entirely by the `request` prop: the dialog mounts (and
 * calls `showModal()`) when a request appears, and unmounts when it goes
 * back to null — there is no separate "closed but present" state to keep in
 * sync.
 *
 * Fail-closed on the UI side too (design §5): Esc triggers the dialog's
 * native `cancel` event, which is intercepted to call `onDeny()` instead of
 * letting the browser close the dialog on its own — that would desync the
 * native `open` state from the `request` prop that's supposed to be the only
 * source of truth for visibility. The close ("×") button calls the same
 * `onDeny()`.
 *
 * Slice 2.2 (ruling reviews/slice-2.2-forks-ruling.md §2/design
 * /working-docs/build/design/slice-2.2-cut.md §5) adds an "Always allow"
 * checkbox: checking it and clicking Allow carries `remember: {pattern?}` on
 * the outgoing `permission_response` (protocol.ts's frozen additive field —
 * the host adds the rule to the CURRENT session immediately, toolName taken
 * from its own pending-ask, §5) and additionally persists the same rule via
 * `window.anycode.settings.addRule` (control plane — survives a restart and
 * seeds every future host, §5). The two effects are independent/idempotent
 * by design; `ConnectedPermissionModal` below is where both are fired.
 * `onAllow`'s signature grows an optional `remember` parameter — calling it
 * with no argument (checkbox unchecked) is byte-identical to the pre-2.2
 * behavior.
 *
 * TASK.27 adds ONE presentation special case, `describePermissionAsk`: an
 * ExitPlanMode ask renders the plan as markdown with action-shaped buttons
 * (Approve plan / Keep planning) and no "Always allow". Nothing about the
 * transport changes — the tool reaches this modal through the same
 * `permission_request` tract as every other ask (it is `needsApproval:true`, so
 * the permission engine escalates it on its own), and the outgoing
 * allow/deny messages are byte-identical. Esc, the "×" button and the deny
 * button all remain the same fail-closed deny they always were; for a plan that
 * deny simply means "keep planning", which is what its label now says.
 */
import { useEffect, useRef, useState } from "react";
import { useOverlayFlag } from "../preview/overlay-flag.js";
import type { KeyboardEvent } from "react";
import type { RiskLevel } from "@anycode/core";
import type { PermissionUiRequest } from "../store.js";
import type { UiToHostMessage } from "../../../shared/protocol.js";
import type { EnginePresentation } from "../../../shared/protocol.js";
import type { PermissionRuleAddRequest } from "../../../shared/settings.js";
import { useTabSend, useTabStore } from "../tab-context.js";
import { Markdown } from "./Markdown.js";
import { X } from "./icons.js";
import { commandBinary, isCommandLineTool, sanitizeBashPattern } from "../permission-pattern.js";
import { classifyBashCommandLine } from "@anycode/core/permissions/safe-command";
import "../settings.css";

export interface PermissionModalProps {
  /** The active permission request (store.permission), or null when none is pending — controls the dialog's mount/visibility. */
  request: PermissionUiRequest | null;
  /** Called on the Allow button. `remember` is present iff the "Always allow" checkbox was checked (slice 2.2). Does not close the modal itself — that happens when `request` goes back to null (design: permission_settled clears it). */
  onAllow(remember?: { pattern?: string }): void;
  /** Called on Deny, the close ("×") button, and Esc (fail-closed). Same non-closing contract as onAllow. */
  onDeny(): void;
  /** External engines can ask once without ever accepting a core remember rule. */
  allowRemember?: boolean;
}

const RISK_LABELS: Record<RiskLevel, string> = {
  low: "Low risk",
  medium: "Medium risk",
  high: "High risk",
};

interface SummarizedInput {
  label: string;
  value: string;
  /** Bash's command / Write&Edit's path get prominent display (design §5); everything else is a plain JSON dump. */
  emphasize: boolean;
}

/**
 * Human-readable summary of the tool's raw input for the modal (design §5:

 * names mirror the Phase 0 tool schemas (packages/core/src/tools/schemas.ts),
 * same convention as ToolCallCard's own summarizer — duplicated rather than
 * imported since ToolCallCard is a read-only file for this task and the two
 * summaries serve different presentations (this one also carries the
 * emphasize flag for the modal's layout).
 */
function summarizeInput(toolName: string, input: unknown): SummarizedInput {
  const record = input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
  if (toolName === "Bash" && typeof record.command === "string") {
    return { label: "Command", value: record.command, emphasize: true };
  }
  if ((toolName === "Write" || toolName === "Edit") && typeof record.file_path === "string") {
    return { label: "File", value: record.file_path, emphasize: true };
  }
  return { label: "Input", value: JSON.stringify(input, null, 2), emphasize: false };
}

export interface PermissionTitle {
  /** Tool name exactly as received (never normalized). */
  tool: string;
  /** Action phrase for the four known tools, null for everything else. */
  action: string | null;
  /** Canonical plain-text form: "Allow Bash to run this command?" / "Allow WebFetch?". Used for the dialog's aria-label. */
  sentence: string;
}

const TITLE_ACTIONS: Record<string, string> = {
  Bash: "run this command",
  Write: "write this file",
  Edit: "modify this file",
  Read: "read this file",
};

/**
 * Verb-first title grammar (R12 §1): "Allow <Tool> to <action>?" for the four
 * known tools, "Allow <Tool>?" for everything else. `hasOwnProperty` guard so a
 * hostile tool name ("constructor"/"toString") can't walk the prototype chain;
 * never lowercase-normalizes or fuzzy-matches — a wrong verb on a security
 * prompt is worse than no verb, so a mis-cased tool degrades to the generic form.
 */
export function formatPermissionTitle(toolName: string): PermissionTitle {
  const action = Object.prototype.hasOwnProperty.call(TITLE_ACTIONS, toolName)
    ? TITLE_ACTIONS[toolName] ?? null
    : null;
  return {
    tool: toolName,
    action,
    sentence: action ? `Allow ${toolName} to ${action}?` : `Allow ${toolName}?`,
  };
}

/**
 * Visible cap for a plan body (TASK.27), mirroring the CLI's own
 * CLI_PLAN_PREVIEW_MAX_CHARS (terminal-broker.ts). The scroll well is CSS; this
 * only stops a pathological multi-MB plan from being handed to the markdown
 * lexer on every render. Counted in UTF-16 code units, exactly like the slice
 * and the elided count derived from it.
 */
export const PLAN_PREVIEW_MAX_CHARS = 10_000;

/** Presentation facts the modal needs, resolved from the ask alone. */
export interface PermissionAskPresentation {
  /** "plan" only for a well-formed ExitPlanMode approval ask. */
  kind: "plan" | "generic";
  /** Capped plan markdown, or null for a generic ask. */
  plan: string | null;
  /** Characters the cap removed; 0 when the plan fit. */
  elidedChars: number;
  /** Dialog aria-label. */
  sentence: string;
  allowLabel: string;
  denyLabel: string;
  /** One-line explanation of what approving actually does; null for generic asks. */
  hint: string | null;
  /** Whether an "Always allow" rule may be offered for this ask at all. */
  canRemember: boolean;
}

/** TASK.35: the honest reason line for a Bash ask caused by unprovable shell
 * syntax, as opposed to a plainly high-risk single command. Exported for the
 * copy-pinning test. */
export const UNKNOWN_SHELL_HINT =
  "Unknown shell expression — AnyCode can't prove this command is read-only, so it's asking. Unproven is not necessarily dangerous; review the command before allowing.";

/** Resolves the TASK.35 hint for a generic ask; null for everything that is
 * not a Bash shell-expression ask (fail-closed presentation: no command
 * string, or a plain single command, or a proven read-only line → no hint). */
function bashUnknownShellHint(toolName: string, input: unknown): string | null {
  if (toolName !== "Bash") {
    return null;
  }
  const command =
    input !== null && typeof input === "object" ? (input as { command?: unknown }).command : undefined;
  if (typeof command !== "string") {
    return null;
  }
  const verdict = classifyBashCommandLine(command);
  return verdict.class === "unknown" && verdict.shellExpression ? UNKNOWN_SHELL_HINT : null;
}

/**
 * Resolves how an ask should be presented (TASK.27). The plan branch is a
 * PRESENTATION special case only — the tool reached this modal through the
 * ordinary permission tract, and the outgoing allow/deny messages are
 * unchanged.
 *
 * Fallback discipline mirrors the CLI's `planApprovalText`: an ExitPlanMode ask
 * whose `plan` is missing or not a string is NOT a plan — it degrades to the
 * generic JSON-dump presentation rather than rendering an empty plan well and
 * pretending there was something to read. Exact, case-sensitive tool-name match
 * for the same reason `formatPermissionTitle` refuses to fuzzy-match: guessing
 * wrong on a security prompt is worse than being generic.
 *
 * `canRemember` is false for a plan: a remembered "always allow ExitPlanMode"
 * rule would auto-approve every future plan before anyone read it, which is the
 * one thing a plan gate exists to prevent.
 */
export function describePermissionAsk(toolName: string, input: unknown): PermissionAskPresentation {
  const raw =
    toolName === "ExitPlanMode"
      ? (input !== null && typeof input === "object" ? (input as { plan?: unknown }).plan : undefined)
      : undefined;
  if (typeof raw !== "string") {
    return {
      kind: "generic",
      plan: null,
      elidedChars: 0,
      sentence: formatPermissionTitle(toolName).sentence,
      allowLabel: "Allow",
      denyLabel: "Deny",
      hint: bashUnknownShellHint(toolName, input),
      canRemember: true,
    };
  }
  const elidedChars = Math.max(0, raw.length - PLAN_PREVIEW_MAX_CHARS);
  return {
    kind: "plan",
    plan: elidedChars > 0 ? raw.slice(0, PLAN_PREVIEW_MAX_CHARS) : raw,
    elidedChars,
    sentence: "Review the implementation plan.",
    allowLabel: "Approve plan",
    denyLabel: "Keep planning",
    hint: "Approving leaves plan mode and starts implementation — write actions still ask for approval individually.",
    canRemember: false,
  };
}

// R12 §2 preview pathology guards (private): the visible cap is CSS
// (max-height + scroll), these only stop a multi-MB write/edit from flooding
// the DOM. No trimEnd — a Write's trailing newlines are real bytes being
// permitted, unlike R4's capLines whose trim semantics suit transcript results.
const PREVIEW_MAX_LINES = 200; // Write content
const DIFF_SIDE_MAX_LINES = 100; // Edit, per side
const PREVIEW_LINE_MAX_CHARS = 2000; // any single line (minified-JS guard)

interface CappedPreview {
  lines: string[];
  hiddenLines: number;
}

function capPreviewLines(text: string, maxLines: number): CappedPreview {
  const all = text.split("\n");
  const visible = all.slice(0, maxLines).map((line) =>
    line.length > PREVIEW_LINE_MAX_CHARS ? `${line.slice(0, PREVIEW_LINE_MAX_CHARS)}…` : line,
  );
  return { lines: visible, hiddenLines: all.length - visible.length };
}

/**


 * for a non-command tool, or a command call with no `command` string, means
 * the checkbox produces a bare `{toolName}` rule with no pattern field shown.
 * TASK.144: "command tool" is `isCommandLineTool`, so a Codex session's
 * `CodexExec` ask gets the same suggestion + editable pattern field a `Bash`
 * ask does — without it, checking the box in a Codex session could only ever
 * mint a patternless allow-every-command rule.
 *
 * Slice P7.16 §4.2: the "first token" is `commandBinary`, not a naive
 * `split(/\s+/)[0]` — a leading env-assignment (`OUT="/tmp/o" node x.mjs`)
 * used to be picked as the binary, producing a garbage rule. The suggestion
 * seen by the user is therefore already clean.
 */
export function suggestAlwaysAllowPattern(toolName: string, input: unknown): string | undefined {
  if (!isCommandLineTool(toolName)) {
    return undefined;
  }
  const record = input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
  if (typeof record.command !== "string") {
    return undefined;
  }
  const token = commandBinary(record.command);
  return token ? `${token} *` : undefined;
}

/**
 * Builds the control-plane `addRule` request (design §5) — trims and omits a
 * blank pattern entirely rather than sending it as `""`. Slice P7.16 §4.2:
 * command-line patterns additionally run through `sanitizeBashPattern` — this
 * is a birth point shared by the modal's hand-edited pattern field AND the
 * Settings manual-add form, so both get env-prefix stripping for free.
 * Path/URL tools pass the trimmed pattern through untouched.
 */
export function buildAlwaysAllowRule(toolName: string, pattern?: string): PermissionRuleAddRequest {
  const trimmed = pattern?.trim();
  if (!trimmed) {
    return { toolName };
  }
  const finalPattern = isCommandLineTool(toolName) ? sanitizeBashPattern(trimmed) : trimmed;
  return { toolName, pattern: finalPattern };
}

/**
 * Builds the outgoing `permission_response` (data plane, protocol.ts's
 * frozen additive `remember?` field). No `remember` argument reproduces the
 * pre-2.2 message exactly. A `remember` with a blank/whitespace-only pattern
 * still carries `remember: {}` (a bare tool-level rule) rather than dropping
 * the field — the checkbox being checked is what matters, not whether a
 * pattern was typed.
 *
 * **W1-FIX (Codex-terra P2-divergence, §4.2 REVISED):** takes an explicit
 * `toolName` and sanitizes `remember.pattern` ONLY for a command-line tool
 * — mirrors `buildAlwaysAllowRule`'s own gate exactly, so the data-plane rule
 * (this message) and the control-plane rule can never diverge. The previous
 * version sanitized unconditionally, relying on the modal only ever
 * populating `pattern` for Bash requests; that invariant lived in the caller,
 * not the helper, so a non-Bash pattern (e.g. a future caller passing a
 * `Read` pattern of `"env *"`) silently widened to `"*"`. Now `toolName`
 * makes the gate explicit at the helper itself.
 */
export function buildPermissionAllowMessage(
  requestId: string,
  toolName: string,
  remember?: { pattern?: string },
): UiToHostMessage {
  if (!remember) {
    return { type: "permission_response", requestId, behavior: "allow" };
  }
  const trimmed = remember.pattern?.trim();
  const sanitized = trimmed && isCommandLineTool(toolName) ? sanitizeBashPattern(trimmed) : trimmed;
  return {
    type: "permission_response",
    requestId,
    behavior: "allow",
    remember: sanitized ? { pattern: sanitized } : {},
  };
}

export function PermissionModal({ request, onAllow, onDeny, allowRemember = true }: PermissionModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const denyRef = useRef<HTMLButtonElement>(null);
  const [alwaysAllow, setAlwaysAllow] = useState(false);
  const [pattern, setPattern] = useState("");

  // R17 a11y: capture the pre-modal focus on mount and restore it on unmount.
  // This native <dialog> hides by React-unmount (the `if (!request) return null`
  // below + ConnectedPermissionModal unmounting on settle), which bypasses the
  // browser's own dialog return-focus and drops focus to <body>. Mirror of
  // CommandPalette's previouslyFocused capture/restore. Declared BEFORE the
  // showModal effect so this reads document.activeElement (the trigger) before
  // showModal() steals it — effects run in declaration order within a commit.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    return () => {
      if (previouslyFocused && previouslyFocused.isConnected) {
        previouslyFocused.focus();
      }
    };
  }, []);

  useEffect(() => {
    // Runs after the <dialog> for a fresh `request` has mounted (the early
    // `return null` below unmounts it entirely when request is null, so
    // there is no "present but closed" state to reconcile on the way out —
    // only the way in needs `showModal()`).
    const dialog = dialogRef.current;
    if (dialog && request && !dialog.open) {
      dialog.showModal();
    }
  }, [request]);

  // Fail-closed focus (R12 §3 I-1): every new request arms Deny. Runs after the
  // showModal effect above — effect order within a commit is declaration order.
  useEffect(() => {
    if (request) {
      denyRef.current?.focus();
    }
  }, [request?.requestId]);

  // Slice 2.2: reset the checkbox/pattern for every NEW request (keyed on
  // requestId, not object identity — a re-render with the same pending
  // request must not wipe mid-edit typing). Seeds the pattern field with the
  // Bash-command suggestion (design §5); undefined for other tools, which
  // hides the pattern input entirely below.
  useEffect(() => {
    setAlwaysAllow(false);
    setPattern(request ? (suggestAlwaysAllowPattern(request.toolName, request.input) ?? "") : "");
    // Keyed on requestId, not `request` itself or `suggestAlwaysAllowPattern`'s
    // inputs — intentionally re-runs only when the pending request actually
    // changes, not on every render of the same one.
  }, [request?.requestId]);

  if (!request) {
    return null;
  }

  const input = summarizeInput(request.toolName, request.input);
  const suggestedPattern = suggestAlwaysAllowPattern(request.toolName, request.input);
  const title = formatPermissionTitle(request.toolName);
  const platform = window.anycode?.platform ?? "darwin";
  // TASK.27: an ExitPlanMode ask is presented as a plan review — markdown body,
  // action-shaped buttons, no Always-allow. `showRemember` folds the engine
  // capability and the per-ask verdict into ONE flag used by both the checkbox
  // and fireAllow, so a plan can never carry a `remember` even if the checkbox
  // state somehow survived a request change.
  const presentation = describePermissionAsk(request.toolName, request.input);
  const isPlan = presentation.kind === "plan";
  const showRemember = allowRemember && presentation.canRemember;

  // R12 §2 preview field narrowing (defensive, mirrors summarizeInput's style):
  // a missing/non-string field simply doesn't render its preview — never throws,
  // never coerces garbage. Bash and unknown tools produce no preview at all.
  const record =
    request.input !== null && typeof request.input === "object"
      ? (request.input as Record<string, unknown>)
      : {};
  const writeContent = request.toolName === "Write" && typeof record.content === "string" ? record.content : null;
  const editOld = request.toolName === "Edit" && typeof record.old_string === "string" ? record.old_string : null;
  const editNew = request.toolName === "Edit" && typeof record.new_string === "string" ? record.new_string : null;
  const editReplaceAll = request.toolName === "Edit" && record.replace_all === true;

  const writeCapped = writeContent !== null ? capPreviewLines(writeContent, PREVIEW_MAX_LINES) : null;
  const editOldCapped = editOld !== null ? capPreviewLines(editOld, DIFF_SIDE_MAX_LINES) : null;
  const editNewCapped = editNew !== null ? capPreviewLines(editNew, DIFF_SIDE_MAX_LINES) : null;

  function fireAllow(): void {
    onAllow(showRemember && alwaysAllow ? { pattern: suggestedPattern !== undefined ? pattern : undefined } : undefined);
  }

  function handleDialogKeyDown(event: KeyboardEvent<HTMLDialogElement>): void {
    if (event.key !== "Enter") {
      return; // Esc stays with native onCancel (I-5); all other keys untouched.
    }
    if (event.nativeEvent.isComposing) {
      return; // IME guard: Enter during composition commits text, never a decision.
    }
    const platform = window.anycode?.platform ?? "darwin";
    const primary = platform === "darwin" ? event.metaKey : event.ctrlKey;
    const secondary = platform === "darwin" ? event.ctrlKey : event.metaKey;
    if (primary && !secondary && !event.shiftKey && !event.altKey) {
      // Exact mod+Enter, no extra modifiers (mirrors keymap.ts's primary/secondary
      // exclusivity): the one keyboard gesture that allows.
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) {
        return; // Key-repeat must not machine-gun permission_response sends.
      }
      fireAllow();
      return;
    }
    // Any other Enter is never a dialog-level submit. Focused buttons keep
    // native activation (I-4); everything else is suppressed outright.
    if (!(event.target instanceof HTMLButtonElement)) {
      event.preventDefault();
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className={isPlan ? "permission-modal permission-modal-plan" : "permission-modal"}
      aria-label={presentation.sentence}
      onKeyDown={handleDialogKeyDown}
      onCancel={(event) => {
        // Esc fires the dialog's native "cancel" event; prevent the browser's
        // own close so `request` (not the DOM) stays the single source of
        // truth for visibility, then treat it as an explicit deny.
        event.preventDefault();
        onDeny();
      }}
    >
      {/* Risk-tinted header strip (design §1.1): the header itself carries the
          risk-level wash, echoing the composer's escalation-graded mode chip,
          with the risk badge as a slightly deeper soft-pill sitting on top. */}
      <div className={`permission-modal-header permission-modal-header-${request.metadata.riskLevel}`}>
        <div className="permission-modal-header-text">
          {/* TASK.27: a plan review is not an "Allow <Tool>?" question — the
              risk badge is dropped too (a read-only mode switch has no risk
              worth grading; the consequence is stated in words below). */}
          <span className="permission-modal-title">
            {isPlan ? (
              "Plan ready — review before implementation"
            ) : (
              <>
                Allow <strong className="permission-modal-tool">{title.tool}</strong>
                {title.action !== null ? <> to {title.action}?</> : "?"}
              </>
            )}
          </span>
          {!isPlan && (
            <span className={`permission-risk-badge permission-risk-${request.metadata.riskLevel}`}>
              {RISK_LABELS[request.metadata.riskLevel]}
              {request.metadata.destructive && <span className="permission-destructive-tag">Destructive</span>}
            </span>
          )}
        </div>
        <button
          type="button"
          className="permission-modal-close"
          aria-label={isPlan ? "Keep planning and close" : "Deny and close"}
          onClick={onDeny}
        >
          <X />
        </button>
      </div>

      <div className="permission-modal-body">
        {/* TASK.27: the plan IS the payload — rendered as markdown through the
            same lexer-only renderer the transcript uses (no innerHTML), instead
            of the generic JSON `Input` dump, which is unreadable for prose. */}
        {isPlan && presentation.plan !== null ? (
          <div className="permission-plan">
            {presentation.plan.length === 0 ? (
              <div className="permission-preview-more">The model submitted an empty plan.</div>
            ) : (
              <Markdown text={presentation.plan} />
            )}
            {presentation.elidedChars > 0 && (
              <div className="permission-preview-more">
                Plan truncated — {presentation.elidedChars} more character
                {presentation.elidedChars === 1 ? "" : "s"} not shown
              </div>
            )}
          </div>
        ) : (
          <div className="permission-input">
            <div className="permission-input-label">{input.label}</div>
            <pre
              className={
                input.emphasize
                  ? "permission-input-value permission-input-value-emphasized"
                  : "permission-input-value"
              }
            >
              {input.value}
            </pre>
          </div>
        )}

        {/* R12 §2: Write content preview — naive verbatim display of the bytes
            being permitted. Empty-content branch says so in words (an empty
            well reads as a rendering bug, not a truncate-to-zero write). */}
        {writeContent !== null && writeCapped !== null && (
          <div className="permission-input">
            <div className="permission-input-label">Content</div>
            {writeContent.length === 0 ? (
              <div className="permission-preview-more">Empty file — no content.</div>
            ) : (
              <pre className="permission-input-value">{writeCapped.lines.join("\n")}</pre>
            )}
            {writeCapped.hiddenLines > 0 && (
              <div className="permission-preview-more">
                Preview truncated — {writeCapped.hiddenLines} more line
                {writeCapped.hiddenLines === 1 ? "" : "s"} not shown
              </div>
            )}
          </div>
        )}

        {/* R12 §2: Edit mini-diff — grouped old-then-new (unified-diff reading
            order) inside one scroll well. Empty side omitted (pure insert /
            pure delete); both empty → no diff block. Not real diffing (R13). */}
        {editOld !== null &&
          editNew !== null &&
          editOldCapped !== null &&
          editNewCapped !== null &&
          !(editOld.length === 0 && editNew.length === 0) && (
            <div className="permission-input">
              <div className="permission-input-label">
                Change
                {editReplaceAll && <span className="permission-preview-note">— all occurrences</span>}
              </div>
              <div className="permission-diff">
                {editOld.length > 0 && (
                  <div className="permission-diff-old">
                    {editOldCapped.lines.map((line, i) => (
                      <div key={i} className="permission-diff-line permission-diff-removed">
                        {line}
                      </div>
                    ))}
                  </div>
                )}
                {editNew.length > 0 && (
                  <div className="permission-diff-new">
                    {editNewCapped.lines.map((line, i) => (
                      <div key={i} className="permission-diff-line permission-diff-added">
                        {line}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {editOldCapped.hiddenLines + editNewCapped.hiddenLines > 0 && (
                <div className="permission-preview-more">
                  Preview truncated — {editOldCapped.hiddenLines + editNewCapped.hiddenLines} more line
                  {editOldCapped.hiddenLines + editNewCapped.hiddenLines === 1 ? "" : "s"} not shown
                </div>
              )}
            </div>
          )}

        {/* TASK.27: for a plan, the consequence of approving is the actual
            information the user needs; "Mode: plan" is the state they can
            already see on the composer chip. */}
        {isPlan ? (
          <div className="permission-plan-hint">{presentation.hint}</div>
        ) : (
          <>
            {presentation.hint !== null && (
              <div className="permission-ask-hint">{presentation.hint}</div>
            )}
            <div className="permission-mode">Mode: {request.mode}</div>
          </>
        )}

        {showRemember && <div className="permission-remember">
          <label className="permission-remember-label">
            <input
              type="checkbox"
              checked={alwaysAllow}
              onChange={(event) => setAlwaysAllow(event.target.checked)}
            />
            Always allow {request.toolName}
            {suggestedPattern !== undefined && " matching"}
          </label>
          {alwaysAllow && suggestedPattern !== undefined && (
            <input
              type="text"
              className="permission-remember-pattern"
              aria-label="Always-allow pattern"
              value={pattern}
              onChange={(event) => setPattern(event.target.value)}
            />
          )}
          {alwaysAllow && (
            <div className="permission-remember-scope">
              Saves a rule to Settings → Always-allow rules. Applies now and in future tasks.
            </div>
          )}
        </div>}
      </div>

      <div className="permission-modal-actions">
        <button type="button" ref={denyRef} className="permission-deny-button" onClick={onDeny}>
          {presentation.denyLabel}
        </button>
        <button type="button" className="permission-allow-button" onClick={fireAllow}>
          {presentation.allowLabel}
          <span className="permission-allow-kbd" aria-hidden="true">
            {platform === "darwin" ? "⌘⏎" : "Ctrl+Enter"}
          </span>
        </button>
      </div>
    </dialog>
  );
}

/**
 * Ready-to-mount wrapper reading the ACTIVE tab's `permission` state directly
 * and sending `permission_response` through that tab's connection (design
 * §3/§4; Phase-2 §4.3: `useTabStore`/`useTabSend`, the migrated equivalents of
 * the old singleton `useDesktopStore`/`sendToHost`) — for App.tsx to drop in
 * with no extra wiring. Not exercised by this task's own tests (component/DOM
 * rendering is out of scope per the test plan); the plain `PermissionModal`
 * above (and its exported pure helpers) is the tested/testable contract.
 *
 * Slice 2.2 (design §5): `handleAllow` fires BOTH always-allow effects when
 * `remember` is present — the data-plane `permission_response` (via
 * `sendToHost`, same call as always) AND the control-plane
 * `window.anycode.settings.addRule` (fire-and-forget: a failure there only


 */
/**
 * Core's absent presentation retains remember; an engine needs approvals it can
 * actually answer.
 *
 * TASK.144 dropped the second conjunct, `supportsCorePermissions`. That flag
 * means "core's permission engine drives this session" — it gates the ModeMenu
 * and `/mode`, and it was ALSO gating remember on the reasoning that a rule
 * stored by a session with no RuleAwarePermissionEngine would never be read
 * back. That reasoning no longer holds: an engine session's rule store is now
 * consulted by the IpcPermissionBroker itself (host/permission-broker.ts), so
 * the rule is honoured on the very next ask and after every restart. Hiding the
 * checkbox left the owner of a Claude/Codex session with no in-app way to stop
 * being asked the same question — the wall TASK.144 was filed for.
 *
 * `supportsInteractiveApprovals` stays, and is the correct gate on its own: it
 * is false exactly when the engine has no approval bridge, and Session drops a
 * `permission_response` from such a session outright (session.ts's `route`).
 */
export function canRememberPermission(engine: EnginePresentation | null): boolean {
  return engine === null || engine.capabilities.supportsInteractiveApprovals;
}

export function ConnectedPermissionModal() {
  const request = useTabStore((state) => state.permission);
  const engine = useTabStore((state) => state.engine);
  const sendToHost = useTabSend();
  // D8 overlay wiring: the preview WebContentsView must hide while a
  // permission ask is up.
  useOverlayFlag(request !== null);

  if (!request) {
    return null;
  }

  const allowRemember = canRememberPermission(engine);

  function handleAllow(remember?: { pattern?: string }): void {
    if (!request) {
      return;
    }
    sendToHost(buildPermissionAllowMessage(request.requestId, request.toolName, remember));
    if (allowRemember && remember) {
      const rule = buildAlwaysAllowRule(request.toolName, remember.pattern);
      window.anycode.settings.addRule(rule).catch((error: unknown) => {
        console.warn("[PermissionModal] addRule failed — rule remains session-only", error);
      });
    }
  }

  return (
    <PermissionModal
      request={request}
      onAllow={handleAllow}
      onDeny={() => sendToHost({ type: "permission_response", requestId: request.requestId, behavior: "deny" })}
      allowRemember={allowRemember}
    />
  );
}
