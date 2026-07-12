/**
 * CLI interactive permission-broker (design slice-4.1-cut.md §2.3/§3.1). Task
 * 4.1.1 froze the interfaces + factory + the two constants and shipped a
 * fail-closed stub (yolo -> AllowAll, else Deny). Task 4.1.2 (this file) rewrites
 * the bodies with the y/n/a TerminalPermissionBroker: an interactive TTY "ask"
 * downgraded to a terminal prompt, a FIFO of concurrent asks (shown one at a
 * time in arrival order), an abort cascade off the turn signal, a re-prompt cap,
 * and fail-closed denies everywhere else (pre-attach, non-interactive,
 * cancellation, re-prompt exhaustion). No new deps; no module outside cli/
 * imports from here; nothing under permissions/ is modified (only imported).
 *
 * Layering: the desktop IpcPermissionBroker (apps/desktop) is NOT imported — the
 * two share only the core PermissionBroker contract and the FIFO-presentation

 * SessionPermissionRules seam, which the RuleAwarePermissionEngine consults
 * BEFORE the broker on subsequent calls; it only downgrades "ask" -> "allow",
 * never a "deny", so a single keypress cannot weaken the mode table (design §0.1).
 */

import { randomUUID } from "node:crypto";
import type { Interface as ReadlineInterface } from "node:readline";
import { AllowAllPermissionBroker, DenyPermissionBroker } from "../permissions/index.js";
import type { SessionPermissionRules } from "../permissions/index.js";
import type { PermissionDecision, PermissionRequest } from "../types/permissions.js";
import type { PermissionBroker } from "../types/permissions.js";
import type { CliTheme } from "./theme.js";

export interface TerminalPrompter {
  /** Prints `question` and resolves with the answer line; rejects/denies on abort. */
  ask(question: string, opts?: { signal?: AbortSignal }): Promise<string>;
}

/** Node's readline exposes the output stream at runtime but doesn't type it. */
function readlineOutput(rl: ReadlineInterface): NodeJS.WritableStream | undefined {
  return (rl as unknown as { output?: NodeJS.WritableStream }).output;
}

/** An Error whose `name` is "AbortError", so the broker recognises the abort path. */
function abortError(): Error {
  const error = new Error("The permission prompt was aborted");
  error.name = "AbortError";
  return error;
}

/**
 * Thin `rl.question` wrapper (design §3.1). The abort signal is handed to
 * `rl.question(query, { signal }, cb)` — its native overload (Node 22) so Node
 * CANCELS the pending question on abort and stops it from swallowing the next
 * input line (verified: without it the dead question intercepts the following
 * `line`). Node does NOT invoke the callback on abort, so this also arms its own
 * abort listener that rejects with an AbortError (the broker maps it to deny) and
 * writes a `\n` to the output for cursor recovery (Node's own clearLine differs
 * between TTY and non-TTY streams, so the newline is emitted explicitly rather
 * than relied upon). Asks only occur inside `runTurn` while the `for await`
 * iterator is suspended, so `question` intercepts the next line with no double

 */
export function createReadlinePrompter(rl: ReadlineInterface): TerminalPrompter {
  return {
    ask(question: string, opts?: { signal?: AbortSignal }): Promise<string> {
      const signal = opts?.signal;
      return new Promise<string>((resolve, reject) => {
        if (signal?.aborted) {
          readlineOutput(rl)?.write("\n");
          reject(abortError());
          return;
        }
        let settled = false;
        const onAbort = (): void => {
          if (settled) {
            return;
          }
          settled = true;
          readlineOutput(rl)?.write("\n");
          reject(abortError());
        };
        if (signal !== undefined) {
          signal.addEventListener("abort", onAbort, { once: true });
        }
        const onAnswer = (answer: string): void => {
          if (settled) {
            return;
          }
          settled = true;
          if (signal !== undefined) {
            signal.removeEventListener("abort", onAbort);
          }
          resolve(answer);
        };
        if (signal !== undefined) {
          rl.question(question, { signal }, onAnswer);
        } else {
          rl.question(question, onAnswer);
        }
      });
    },
  };
}

export interface CliPermissionBroker extends PermissionBroker {
  /**
   * Lazily attaches the terminal prompter (the readline interface is created
   * AFTER the broker, design §0.1). Before attach — and for the non-interactive
   * stub brokers that don't implement it — every ask is fail-closed deny.
   */
  attachPrompter?(prompter: TerminalPrompter): void;
}

export interface CliBrokerOptions {
  yolo: boolean;
  /** Computed in runCli (design §2.5): input.isTTY && output.isTTY && not --print. */
  interactive: boolean;
  /** Seam for the "a" (always-allow) answer — `rules.add({ toolName })` (design §3.1). */
  rules: SessionPermissionRules;
  /** Theme roles ask/askHint for prompt presentation. */
  theme: CliTheme;
}

/** Unrecognised answers past this many re-prompts fail closed to deny. */
export const CLI_ASK_MAX_REPROMPTS = 3;
/** One-line cap on the echoed tool-input preview inside an ask prompt. */
export const CLI_ASK_INPUT_PREVIEW_MAX_CHARS = 400;
/**
 * Cap on the plan body echoed verbatim inside an ExitPlanMode approval ask (design

 * IS what the user must read to approve, so it is shown in full up to this length,
 * then followed by an honest "… (+K chars)" tail counting the elided characters.

 */
export const CLI_PLAN_PREVIEW_MAX_CHARS = 10_000;

/** One parked ask, queued or shown — the source of truth for the abort cascade. */
interface PendingAsk {
  resolve: (decision: PermissionDecision) => void;
  request: PermissionRequest;
  /* */
  signal: AbortSignal | undefined;
  /** Removed on settle so a long-lived turn signal doesn't accumulate listeners. */
  onAbort: (() => void) | undefined;
  /** Count of empty/unrecognised answers; at CLI_ASK_MAX_REPROMPTS the ask fails closed. */
  unrecognized: number;
}

/** Builds the one-line, capped preview of the tool input echoed in the ask block. */
function previewInput(input: unknown): string {
  const json = JSON.stringify(input);
  const text = json === undefined ? String(input) : json;
  if (text.length > CLI_ASK_INPUT_PREVIEW_MAX_CHARS) {
    return `${text.slice(0, CLI_ASK_INPUT_PREVIEW_MAX_CHARS)}…`;
  }
  return text;
}

/**
 * Duck-gate for the ExitPlanMode approval special-case (design §3.2). Returns the
 * plan string when `request` is an ExitPlanMode ask carrying a string `plan`, else
 * null. ANY malformity — a different tool, a missing plan, a non-string plan, a
 * non-object input — fails the gate, so the broker falls back to the generic
 * formatAsk block byte-for-byte (fail-open to the established form, mirror of slice

 * answer mapping (handleAnswer) can never diverge.
 */
function planApprovalText(request: PermissionRequest): string | null {
  if (request.toolName !== "ExitPlanMode") {
    return null;
  }
  const plan = (request.input as { plan?: unknown } | null | undefined)?.plan;
  return typeof plan === "string" ? plan : null;
}

/**
 * Builds the plan body shown verbatim inside the ExitPlanMode ask (design §3.2).
 * The whole plan is shown up to CLI_PLAN_PREVIEW_MAX_CHARS; beyond that the visible
 * text is followed by an honest "… (+K chars)" tail where K is the number of elided
 * characters (counted in the same UTF-16 code units as the cap and the slice, so it
 * is exactly plan.length - CLI_PLAN_PREVIEW_MAX_CHARS). The generic 400-char preview
 * cap does NOT apply here.
 */
function formatPlanBody(plan: string): string {
  if (plan.length <= CLI_PLAN_PREVIEW_MAX_CHARS) {
    return plan;
  }
  const shown = plan.slice(0, CLI_PLAN_PREVIEW_MAX_CHARS);
  const elided = plan.length - CLI_PLAN_PREVIEW_MAX_CHARS;
  return `${shown}… (+${elided} chars)`;
}

/**
 * Special presentation for an ExitPlanMode approval ask (design §3.2). The plan is
 * shown in full (capped) as a plain-text body between the header and the hint —
 * never painted, since it is the authoritative display of the plan (the render of
 * the tool-start event does not duplicate it and their order is not guaranteed, so
 * the ask must be self-sufficient, §0.1). Header and hint carry the same ask /
 * askHint theme roles as the generic block and the trailing prompt is plain,
 * mirroring formatAsk. The answer keys are y/n only: the always-allow "a" is
 * deliberately absent — a single keypress must not silently auto-approve every

 *
 *   [permission] ExitPlanMode — plan approval requested
 *   <plan verbatim>
 *     y = approve plan (switch to build mode; writes still ask) · n = reject (keep planning)
 *   answer [y/n]:
 */
function formatPlanApprovalAsk(plan: string, theme: CliTheme): string {
  const header = "[permission] ExitPlanMode — plan approval requested";
  const hint = "  y = approve plan (switch to build mode; writes still ask) · n = reject (keep planning)";
  return `${theme.paint("ask", header)}\n${formatPlanBody(plan)}\n${theme.paint("askHint", hint)}\nanswer [y/n]: `;
}

/**
 * Renders the ask block. ExitPlanMode approvals get the plan-approval special case
 * (design §3.2); every other ask — and any malformed ExitPlanMode ask — gets the
 * generic y/n/a block (design §3.1). Header + hint carry the `ask` / `askHint`
 * theme roles; the trailing answer prompt is plain. Original prose — never copied
 * from another product.
 *
 *   [permission] Write (risk: medium, destructive) — {"file_path":"…"}
 *     y = allow once · n = deny · a = always allow Write this session (/allow Write <glob> for finer scope)
 *   answer [y/n/a]:
 */
function formatAsk(request: PermissionRequest, theme: CliTheme): string {
  const plan = planApprovalText(request);
  if (plan !== null) {
    return formatPlanApprovalAsk(plan, theme);
  }
  const { name } = request.metadata;
  const risk = request.metadata.riskLevel;
  const destructive = request.metadata.destructive ? ", destructive" : "";
  const header = `[permission] ${name} (risk: ${risk}${destructive}) — ${previewInput(request.input)}`;
  const hint = `  y = allow once · n = deny · a = always allow ${name} this session (/allow ${name} <glob> for finer scope)`;
  return `${theme.paint("ask", header)}\n${theme.paint("askHint", hint)}\nanswer [y/n/a]: `;
}

/**
 * Interactive y/n/a permission broker for a live TTY (design §3.1). Implements
 * CliPermissionBroker; exported for its own unit tests (main.ts wires it only via
 * createCliPermissionBroker). Serialises concurrent asks through a FIFO show
 * queue and cascades a turn abort into a deny for every parked ask.
 */
export class TerminalPermissionBroker implements CliPermissionBroker {
  /** Every parked ask, queued or shown — addressed by id for settle / cancel. */
  private readonly pending = new Map<string, PendingAsk>();
  /** Ids awaiting their turn, arrival order; the head is shown once the current settles. */
  private readonly queue: string[] = [];
  /** Id of the single ask currently in front of the user, or null when the slot is free. */
  private current: string | null = null;
  /** Lazily attached (design §0.1); until then every ask is fail-closed deny. */
  private prompter: TerminalPrompter | null = null;

  constructor(
    private readonly rules: SessionPermissionRules,
    private readonly theme: CliTheme,
  ) {}

  attachPrompter(prompter: TerminalPrompter): void {
    this.prompter = prompter;
  }

  requestPermission(
    request: PermissionRequest,
    options?: { signal?: AbortSignal },
  ): Promise<PermissionDecision> {
    // Fail-closed rails (design §3.1): no prompter attached (print-mode / a
    // defect) or the turn already cancelled -> immediate deny, never parked.
    if (this.prompter === null) {
      return Promise.resolve({
        behavior: "deny",
        reason: `${request.toolName}: no interactive prompt available`,
      });
    }
    const signal = options?.signal;
    if (signal?.aborted) {
      return Promise.resolve({ behavior: "deny", reason: "turn cancelled" });
    }
    return new Promise<PermissionDecision>((resolve) => {
      const id = randomUUID();
      const entry: PendingAsk = { resolve, request, signal, onAbort: undefined, unrecognized: 0 };
      if (signal !== undefined) {
        const onAbort = (): void => this.cancelAll("turn cancelled");
        entry.onAbort = onAbort;
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.pending.set(id, entry);
      if (this.current === null) {
        this.present(id, entry);
      } else {
        this.queue.push(id);
      }
    });
  }

  /** Sends `entry`'s ask to the prompter and marks it as the shown request. */
  private present(id: string, entry: PendingAsk): void {
    this.current = id;
    this.prompt(id, entry);
  }

  /** Pops the next queued ask (if any) and shows it, freeing the shown slot for it. */
  private presentNext(): void {
    const nextId = this.queue.shift();
    if (nextId === undefined) {
      this.current = null;
      return;
    }
    const entry = this.pending.get(nextId);
    if (entry === undefined) {
      // Defensive: settled-but-still-queued should never happen (settle removes
      // from the queue too); don't stall the slot if it somehow does.
      this.presentNext();
      return;
    }
    this.present(nextId, entry);
  }

  /** Issues one prompter round-trip for the shown ask; used for the first ask and re-prompts. */
  private prompt(id: string, entry: PendingAsk): void {
    const prompter = this.prompter;
    if (prompter === null) {
      // Detached mid-session (should not happen): fail closed.
      this.settle(id, {
        behavior: "deny",
        reason: `${entry.request.toolName}: no interactive prompt available`,
      });
      return;
    }
    prompter.ask(formatAsk(entry.request, this.theme), { signal: entry.signal }).then(
      (answer) => this.handleAnswer(id, entry, answer),
      (error) => this.handlePromptError(id, entry, error),
    );
  }

  /** Interprets a settled answer (trim, case-insensitive); design §3.1/§3.2. */
  private handleAnswer(id: string, entry: PendingAsk, answer: string): void {
    if (!this.pending.has(id)) {
      // Already settled by the abort cascade before the answer arrived.
      return;
    }
    const normalized = answer.trim().toLowerCase();
    if (planApprovalText(entry.request) !== null) {
      // ExitPlanMode approval: y/n only, no always-allow seam (design §3.2).
      this.handlePlanApprovalAnswer(id, entry, normalized);
      return;
    }
    if (normalized === "y" || normalized === "yes") {
      this.settle(id, { behavior: "allow" });
      return;
    }
    if (normalized === "n" || normalized === "no") {
      this.settle(id, { behavior: "deny", reason: "denied by user" });
      return;
    }
    if (normalized === "a" || normalized === "always") {
      // Session-scoped always-allow for this tool (RuleAware engine consults it
      // before the broker on later calls; downgrades "ask" only, design §0.1).
      this.rules.add({ toolName: entry.request.toolName });
      this.settle(id, { behavior: "allow" });
      return;
    }
    // Empty / unrecognised: re-prompt up to the cap, then fail closed so a
    // garbage pipe cannot loop forever (design §3.1).
    entry.unrecognized += 1;
    if (entry.unrecognized >= CLI_ASK_MAX_REPROMPTS) {
      this.settle(id, { behavior: "deny", reason: "unrecognized answers" });
      return;
    }
    this.prompt(id, entry);
  }

  /**
   * Answer mapping for an ExitPlanMode approval ask (design §3.2/§3.1). Only y/n are
   * accepted: y|yes approves (allow -> the tool handler performs the sanctioned
   * plan -> build transition), n|no rejects with an instructive reason that tells the
   * model to keep planning. The always-allow "a" is treated exactly like any other
   * unrecognised answer — it is NOT routed through rules.add, so it can never

   * fails closed to deny so a garbage pipe cannot loop forever.
   */
  private handlePlanApprovalAnswer(id: string, entry: PendingAsk, normalized: string): void {
    if (normalized === "y" || normalized === "yes") {
      this.settle(id, { behavior: "allow" });
      return;
    }
    if (normalized === "n" || normalized === "no") {
      this.settle(id, {
        behavior: "deny",
        reason: "plan rejected by user — stay in plan mode and refine the plan",
      });
      return;
    }
    entry.unrecognized += 1;
    if (entry.unrecognized >= CLI_ASK_MAX_REPROMPTS) {
      this.settle(id, { behavior: "deny", reason: "unrecognized answers" });
      return;
    }
    this.prompt(id, entry);
  }

  /**
   * Prompter rejection. The abort cascade (via the signal listener) normally
   * settles the shown ask first, so this is usually a no-op; the fallback keeps
   * the fail-closed posture if the prompter ever rejects for another reason.
   */
  private handlePromptError(id: string, entry: PendingAsk, _error: unknown): void {
    if (!this.pending.has(id)) {
      return;
    }
    const reason = entry.signal?.aborted ? "turn cancelled" : "permission prompt failed";
    this.settle(id, { behavior: "deny", reason });
  }

  /**
   * Normal settle: removes `id` from {shown, queued}, resolves it, and — only
   * when it was the shown ask — advances the FIFO to the next parked ask. A
   * second settle is impossible (the Map no longer has the id): first answer wins.
   */
  private settle(id: string, decision: PermissionDecision): void {
    const entry = this.pending.get(id);
    if (entry === undefined) {
      return;
    }
    const wasCurrent = this.current === id;
    if (wasCurrent) {
      this.current = null;
    } else {
      const idx = this.queue.indexOf(id);
      if (idx !== -1) {
        this.queue.splice(idx, 1);
      }
    }
    this.settleEntry(id, entry, decision);
    if (wasCurrent) {
      this.presentNext();
    }
  }

  /**
   * Force-denies every parked ask (turn cancel): drains the queue (never shown,
   * so nothing to advance to), then denies whatever is currently shown, without
   * presenting a replacement. Idempotent — a second call finds nothing pending.
   */
  private cancelAll(reason: string): void {
    const queued = this.queue.splice(0, this.queue.length);
    for (const id of queued) {
      const entry = this.pending.get(id);
      if (entry !== undefined) {
        this.settleEntry(id, entry, { behavior: "deny", reason });
      }
    }
    if (this.current !== null) {
      const id = this.current;
      this.current = null;
      const entry = this.pending.get(id);
      if (entry !== undefined) {
        this.settleEntry(id, entry, { behavior: "deny", reason });
      }
    }
  }

  /** Bare resolution: drops the abort listener, removes from `pending`, resolves. No queue/current bookkeeping. */
  private settleEntry(id: string, entry: PendingAsk, decision: PermissionDecision): void {
    if (entry.signal !== undefined && entry.onAbort !== undefined) {
      entry.signal.removeEventListener("abort", entry.onAbort);
    }
    this.pending.delete(id);
    entry.resolve(decision);
  }
}

/**
 * Broker selection (design §2.3/§3.1): yolo -> AllowAll (unchanged); interactive
 * -> TerminalPermissionBroker; else -> Deny (unchanged, byte-identical to the
 * pre-4.1 non-interactive / --print path). The constants above live in this file

 */
export function createCliPermissionBroker(opts: CliBrokerOptions): CliPermissionBroker {
  if (opts.yolo) {
    return new AllowAllPermissionBroker();
  }
  if (opts.interactive) {
    return new TerminalPermissionBroker(opts.rules, opts.theme);
  }
  return new DenyPermissionBroker();
}
