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
 */
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { RiskLevel } from "@anycode/core";
import type { PermissionUiRequest } from "../store.js";
import type { UiToHostMessage } from "../../../shared/protocol.js";
import type { PermissionRuleAddRequest } from "../../../shared/settings.js";
import { useTabSend, useTabStore } from "../tab-context.js";
import { X } from "./icons.js";
import { commandBinary, sanitizeBashPattern } from "../permission-pattern.js";
import "../settings.css";

export interface PermissionModalProps {
  /** The active permission request (store.permission), or null when none is pending — controls the dialog's mount/visibility. */
  request: PermissionUiRequest | null;
  /** Called on the Allow button. `remember` is present iff the "Always allow" checkbox was checked (slice 2.2). Does not close the modal itself — that happens when `request` goes back to null (design: permission_settled clears it). */
  onAllow(remember?: { pattern?: string }): void;
  /** Called on Deny, the close ("×") button, and Esc (fail-closed). Same non-closing contract as onAllow. */
  onDeny(): void;
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


 * for a non-Bash tool, or a Bash call with no `command` string, means the
 * checkbox produces a bare `{toolName}` rule with no pattern field shown.
 *
 * Slice P7.16 §4.2: the "first token" is `commandBinary`, not a naive
 * `split(/\s+/)[0]` — a leading env-assignment (`OUT="/tmp/o" node x.mjs`)
 * used to be picked as the binary, producing a garbage rule. The suggestion
 * seen by the user is therefore already clean.
 */
export function suggestAlwaysAllowPattern(toolName: string, input: unknown): string | undefined {
  if (toolName !== "Bash") {
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
 * Bash patterns additionally run through `sanitizeBashPattern` — this is a
 * birth point shared by the modal's hand-edited pattern field AND the
 * Settings manual-add form, so both get env-prefix stripping for free.
 * Non-Bash tools pass the trimmed pattern through untouched.
 */
export function buildAlwaysAllowRule(toolName: string, pattern?: string): PermissionRuleAddRequest {
  const trimmed = pattern?.trim();
  if (!trimmed) {
    return { toolName };
  }
  const finalPattern = toolName === "Bash" ? sanitizeBashPattern(trimmed) : trimmed;
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
 * `toolName` and sanitizes `remember.pattern` ONLY when `toolName === "Bash"`
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
  const sanitized = trimmed && toolName === "Bash" ? sanitizeBashPattern(trimmed) : trimmed;
  return {
    type: "permission_response",
    requestId,
    behavior: "allow",
    remember: sanitized ? { pattern: sanitized } : {},
  };
}

export function PermissionModal({ request, onAllow, onDeny }: PermissionModalProps) {
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
    onAllow(alwaysAllow ? { pattern: suggestedPattern !== undefined ? pattern : undefined } : undefined);
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
      className="permission-modal"
      aria-label={title.sentence}
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
          <span className="permission-modal-title">
            Allow <strong className="permission-modal-tool">{title.tool}</strong>
            {title.action !== null ? <> to {title.action}?</> : "?"}
          </span>
          <span className={`permission-risk-badge permission-risk-${request.metadata.riskLevel}`}>
            {RISK_LABELS[request.metadata.riskLevel]}
            {request.metadata.destructive && <span className="permission-destructive-tag">Destructive</span>}
          </span>
        </div>
        <button type="button" className="permission-modal-close" aria-label="Deny and close" onClick={onDeny}>
          <X />
        </button>
      </div>

      <div className="permission-modal-body">
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

        <div className="permission-mode">Mode: {request.mode}</div>

        <div className="permission-remember">
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
        </div>
      </div>

      <div className="permission-modal-actions">
        <button type="button" ref={denyRef} className="permission-deny-button" onClick={onDeny}>
          Deny
        </button>
        <button type="button" className="permission-allow-button" onClick={fireAllow}>
          Allow
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
export function ConnectedPermissionModal() {
  const request = useTabStore((state) => state.permission);
  const sendToHost = useTabSend();

  if (!request) {
    return null;
  }

  function handleAllow(remember?: { pattern?: string }): void {
    if (!request) {
      return;
    }
    sendToHost(buildPermissionAllowMessage(request.requestId, request.toolName, remember));
    if (remember) {
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
    />
  );
}
