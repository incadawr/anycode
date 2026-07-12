/**
 * In-memory hook runner. PreToolUse: matching hooks run sequentially; each
 * runs under its own timeout (DEFAULT_HOOK_TIMEOUT_MS) with an AbortController
 * linked to the caller's signal. Results merge with deny > ask > allow; the
 * last updatedInput wins. A hook that throws or times out is treated as a
 * deny with a diagnostic reason (fail-closed). An external abort from
 * options.signal propagates (throws) and stops any further hooks.
 * runUserPromptSubmit / runObservers (fail-open matrix, design §2.11) are
 * implemented by task 1.4 reusing the runOneHook mechanics.
 *
 * Dependency note: util/abort.ts (task 0.4) provides linkAbortSignal and a
 * 2-way raceWithTimeout (operation vs timeout, propagating operation rejection
 * as a throw). The per-hook race here is intentionally local, not incidental
 * duplication: the fail-closed pipeline needs a 3-way outcome — value / timeout
 * / external-abort — where (a) a hook rejection must become a deny rather than
 * throw, and (b) an external abort must win promptly and be distinguishable so
 * it propagates and stops further hooks, even if the hook ignores its signal.
 * Composing the util primitives to express that would require a second listener
 * on the parent signal plus a dangling timeout timer, so a single-promise race
 * is kept here.
 */

import type {
  AggregatedPreToolUseResult,
  HookRegistration,
  HookRunOptions,
  HookRunner,
  PostToolUseHookInput,
  PreToolUseHookInput,
  PreToolUseHookResult,
  StopHookInput,
  SubagentStopHookInput,
  UserPromptSubmitHookInput,
} from "../types/hooks.js";
import { DEFAULT_HOOK_TIMEOUT_MS } from "../types/config.js";

type PreToolUseRegistration = Extract<HookRegistration, { event: "PreToolUse" }>;
type UserPromptSubmitRegistration = Extract<HookRegistration, { event: "UserPromptSubmit" }>;

type PermissionDecision = NonNullable<PreToolUseHookResult["permissionDecision"]>;

const DECISION_RANK: Record<PermissionDecision, number> = { allow: 0, ask: 1, deny: 2 };

/** deny > ask > allow. */
function mergeDecision(
  current: PermissionDecision | undefined,
  next: PermissionDecision,
): PermissionDecision {
  if (current === undefined) {
    return next;
  }
  return DECISION_RANK[next] > DECISION_RANK[current] ? next : current;
}

/** Regex match against a string (tool name for tool hooks, prompt text for UserPromptSubmit). */
function matchesText(matcher: RegExp | undefined, text: string): boolean {
  return matcher === undefined || matcher.test(text);
}

function abortReason(reason: unknown): unknown {
  return reason ?? new Error("Aborted");
}

type HookOutcome<V> =
  | { kind: "value"; value: V }
  | { kind: "timeout" }
  | { kind: "error"; error: unknown }
  | { kind: "aborted"; reason: unknown };

/**
 * Runs one hook against a fresh AbortController that is aborted on timeout or
 * when the external signal fires, so the hook is actually cancelled — not just
 * abandoned. Resolves with a discriminated outcome; never rejects. Generic over
 * input and result shape so PreToolUse (fail-closed), the fail-open observers,
 * and UserPromptSubmit all share the one 3-way race (value / timeout /
 * external-abort) instead of reimplementing it per event.
 */
function runOneHook<I, V>(
  hook: (input: I, signal: AbortSignal) => Promise<V>,
  input: I,
  timeoutMs: number,
  externalSignal: AbortSignal | undefined,
): Promise<HookOutcome<V>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onExternalAbort: (() => void) | undefined;

  return new Promise<HookOutcome<V>>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new Error("hook timeout"));
      resolve({ kind: "timeout" });
    }, timeoutMs);

    if (externalSignal) {
      onExternalAbort = () => {
        controller.abort(abortReason(externalSignal.reason));
        resolve({ kind: "aborted", reason: externalSignal.reason });
      };
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }

    hook(input, controller.signal).then(
      (value) => resolve({ kind: "value", value }),
      (error: unknown) => resolve({ kind: "error", error }),
    );
  }).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (externalSignal && onExternalAbort) {
      externalSignal.removeEventListener("abort", onExternalAbort);
    }
  });
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export class InMemoryHookRunner implements HookRunner {
  private readonly registrations: HookRegistration[] = [];

  register(registration: HookRegistration): void {
    this.registrations.push(registration);
  }

  async runPreToolUse(
    input: PreToolUseHookInput,
    options?: HookRunOptions,
  ): Promise<AggregatedPreToolUseResult> {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
    const externalSignal = options?.signal;

    const matching = this.registrations.filter(
      (registration): registration is PreToolUseRegistration =>
        registration.event === "PreToolUse" && matchesText(registration.matcher, input.toolName),
    );

    let decision: PermissionDecision | undefined;
    let updatedInput: unknown;
    let hasUpdatedInput = false;
    const reasons: string[] = [];

    for (const registration of matching) {
      if (externalSignal?.aborted) {
        throw abortReason(externalSignal.reason);
      }

      const outcome = await runOneHook(registration.hook, input, timeoutMs, externalSignal);

      switch (outcome.kind) {
        case "aborted":
          throw abortReason(outcome.reason);

        case "timeout":
          decision = mergeDecision(decision, "deny");
          reasons.push(
            `${input.toolName}: PreToolUse hook timed out after ${timeoutMs}ms — denied (fail-closed)`,
          );
          break;

        case "error":
          decision = mergeDecision(decision, "deny");
          reasons.push(
            `${input.toolName}: PreToolUse hook threw (${describeError(
              outcome.error,
            )}) — denied (fail-closed)`,
          );
          break;

        case "value": {
          const result = outcome.value;
          if (result) {
            if (result.permissionDecision) {
              decision = mergeDecision(decision, result.permissionDecision);
            }
            if (result.updatedInput !== undefined) {
              updatedInput = result.updatedInput;
              hasUpdatedInput = true;
            }
            if (result.reason) {
              reasons.push(result.reason);
            }
          }
          break;
        }
      }
    }

    const aggregated: AggregatedPreToolUseResult = {};
    if (decision !== undefined) {
      aggregated.permissionDecision = decision;
    }
    if (hasUpdatedInput) {
      aggregated.updatedInput = updatedInput;
    }
    if (reasons.length > 0) {
      aggregated.reason = reasons.join("; ");
    }
    return aggregated;
  }

  /**
   * Fail-open aggregation of matching UserPromptSubmit hooks (design §2.11).
   * The matcher is tested against the prompt text. A throwing or timed-out hook
   * is logged and skipped (never kills the turn); additionalContext strings from
   * the surviving hooks are concatenated. An external abort still propagates.
   */
  async runUserPromptSubmit(
    input: UserPromptSubmitHookInput,
    options?: HookRunOptions,
  ): Promise<{ additionalContext?: string }> {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
    const externalSignal = options?.signal;

    const matching = this.registrations.filter(
      (registration): registration is UserPromptSubmitRegistration =>
        registration.event === "UserPromptSubmit" &&
        matchesText(registration.matcher, input.prompt),
    );

    const contexts: string[] = [];

    for (const registration of matching) {
      if (externalSignal?.aborted) {
        throw abortReason(externalSignal.reason);
      }

      const outcome = await runOneHook(registration.hook, input, timeoutMs, externalSignal);

      switch (outcome.kind) {
        case "aborted":
          throw abortReason(outcome.reason);

        case "timeout":
          console.warn(
            `UserPromptSubmit hook timed out after ${timeoutMs}ms — skipped (fail-open)`,
          );
          break;

        case "error":
          console.warn(
            `UserPromptSubmit hook threw (${describeError(outcome.error)}) — skipped (fail-open)`,
          );
          break;

        case "value":
          if (outcome.value?.additionalContext) {
            contexts.push(outcome.value.additionalContext);
          }
          break;
      }
    }

    return contexts.length > 0 ? { additionalContext: contexts.join("\n") } : {};
  }

  /**
   * Fail-open observers (PostToolUse / PostToolUseFailure / Stop, design §2.11).
   * A throwing or timed-out hook is logged and skipped — observers never affect
   * control flow. An external abort still propagates and stops further hooks.
   */
  runObservers(
    event: "PostToolUse" | "PostToolUseFailure",
    input: PostToolUseHookInput,
    options?: HookRunOptions,
  ): Promise<void>;
  runObservers(event: "Stop", input: StopHookInput, options?: HookRunOptions): Promise<void>;
  runObservers(
    event: "SubagentStop",
    input: SubagentStopHookInput,
    options?: HookRunOptions,
  ): Promise<void>;
  async runObservers(
    event: "PostToolUse" | "PostToolUseFailure" | "Stop" | "SubagentStop",
    input: PostToolUseHookInput | StopHookInput | SubagentStopHookInput,
    options?: HookRunOptions,
  ): Promise<void> {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
    const externalSignal = options?.signal;

    // Each entry runs one matching hook under the shared 3-way race, bound to
    // its own input type so PostToolUse and Stop share this loop.
    const runs: Array<() => Promise<HookOutcome<void>>> = [];

    if (event === "Stop") {
      const stopInput = input as StopHookInput;
      for (const registration of this.registrations) {
        if (registration.event === "Stop") {
          const { hook } = registration;
          runs.push(() => runOneHook(hook, stopInput, timeoutMs, externalSignal));
        }
      }
    } else if (event === "SubagentStop") {
      // Matcher (if any) is tested against the subagent's agentType, mirroring
      // the way PostToolUse matches on toolName.
      const subagentInput = input as SubagentStopHookInput;
      for (const registration of this.registrations) {
        if (
          registration.event === "SubagentStop" &&
          matchesText(registration.matcher, subagentInput.agentType)
        ) {
          const { hook } = registration;
          runs.push(() => runOneHook(hook, subagentInput, timeoutMs, externalSignal));
        }
      }
    } else {
      const postInput = input as PostToolUseHookInput;
      for (const registration of this.registrations) {
        if (
          (registration.event === "PostToolUse" ||
            registration.event === "PostToolUseFailure") &&
          registration.event === event &&
          matchesText(registration.matcher, postInput.toolName)
        ) {
          const { hook } = registration;
          runs.push(() => runOneHook(hook, postInput, timeoutMs, externalSignal));
        }
      }
    }

    for (const run of runs) {
      if (externalSignal?.aborted) {
        throw abortReason(externalSignal.reason);
      }

      const outcome = await run();

      switch (outcome.kind) {
        case "aborted":
          throw abortReason(outcome.reason);

        case "timeout":
          console.warn(`${event} hook timed out after ${timeoutMs}ms — skipped (fail-open)`);
          break;

        case "error":
          console.warn(
            `${event} hook threw (${describeError(outcome.error)}) — skipped (fail-open)`,
          );
          break;

        case "value":
          break;
      }
    }
  }
}
