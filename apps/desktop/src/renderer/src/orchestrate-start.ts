/**
 * Orchestrate on the New Session start screen — pure helpers shared by the
 * start composer (StartScreen.tsx, via start-session.ts) and the in-tab
 * composer (Composer.tsx's `/orchestrate` submit). No React, no store reads:
 * every decision here is a function of its arguments so node-env vitest can
 * pin it directly.
 *
 * Orchestrate is core-only (`supportsCorePermissions`): a Codex/Claude draft
 * never gets the Orchestrate row, and `/orchestrate` is not recognized for
 * them (the text is sent literally, as the in-tab composer also does for an
 * engine that has no such command).
 */
import type { EngineId } from "../../shared/engines.js";

/** The slash token the start composer recognizes at the very beginning of the draft. */
export const ORCHESTRATE_SLASH_TOKEN = "/orchestrate";

/**
 * A leading `/orchestrate` token followed by whitespace or end-of-draft.
 * Returns the text after the token (trimmed) as `task`; `task === ""` for a
 * bare `/orchestrate`. `null` when the draft does not start with the token.
 */
export function parseOrchestrateSlash(prompt: string): { task: string } | null {
  const match = /^\/orchestrate(?=\s|$)/.exec(prompt);
  if (match === null) {
    return null;
  }
  return { task: prompt.slice(match[0].length).trim() };
}

/** What a start-composer send means for orchestrate: the flag to apply and the text to send as the first message. */
export interface StartOrchestratePlan {
  orchestrate: boolean;
  /** The first-message text. For a `/orchestrate <task>` send this is `<task>`, never the token. */
  text: string;
  /** True when the draft was a bare `/orchestrate` with no task after it. */
  bareSlash: boolean;
}

/**
 * Resolves one start-composer send. `flag` is the draft's own Orchestrate
 * toggle; a leading `/orchestrate ` token turns orchestrate on for this send
 * regardless of the toggle. Non-core drafts never orchestrate.
 */
export function resolveStartOrchestrate(
  engine: EngineId,
  flag: boolean | undefined,
  prompt: string,
): StartOrchestratePlan {
  if (engine !== "core") {
    return { orchestrate: false, text: prompt, bareSlash: false };
  }
  const slash = parseOrchestrateSlash(prompt);
  if (slash !== null) {
    return { orchestrate: true, text: slash.task, bareSlash: slash.task === "" };
  }
  return { orchestrate: flag === true, text: prompt, bareSlash: false };
}

/**
 * The first-run gate both composers share: orchestrate needs orchestration
 * roles, and the RolePickerDialog is what writes them. `roles === undefined`
 * means "never configured" (the same test Composer's `beginOrchestrateSubmit`
 * always used).
 */
export function needsRolePicker(roles: unknown): boolean {
  return roles === undefined;
}

/**
 * True when a start-composer send must open the RolePickerDialog before it
 * can create the tab: the send orchestrates, has a task to send, and no roles
 * exist yet. A bare `/orchestrate` never opens the picker (it is refused).
 */
export function startSendNeedsRolePicker(plan: StartOrchestratePlan, roles: unknown): boolean {
  return plan.orchestrate && !plan.bareSlash && plan.text.trim() !== "" && needsRolePicker(roles);
}

/**
 * Turning orchestrate ON from a mode menu asks for roles first, on both
 * surfaces: the first run has no role routes, and a silent enable left the
 * user with no way to choose who does the work (the owner-reported "clicking
 * Orchestrate does nothing"). Turning it OFF never asks. The mode itself is
 * applied immediately by the caller, so the request cannot be mistaken for a
 * no-op while the dialog is up.
 */
export function orchestrateToggleNeedsRolePicker(next: boolean, roles: unknown): boolean {
  return next && needsRolePicker(roles);
}

/**
 * The minimal slash hint: shown while the draft starts like the command but
 * has not yet become a complete `/orchestrate <task>` (core drafts only).
 */
export function startOrchestrateHint(engine: EngineId, prompt: string): boolean {
  if (engine !== "core" || !prompt.startsWith("/orch")) {
    return false;
  }
  const slash = parseOrchestrateSlash(prompt);
  return slash === null || slash.task === "";
}

/**
 * The Orchestrate row's wiring for a start-screen ModeMenu. Core drafts get
 * the row (state + handler); Codex/Claude get `undefined`, which hides it —
 * the same way the in-tab ModeMenu's props are simply absent for them.
 */
export function startDraftOrchestrateRowProps(
  engine: EngineId,
  orchestrate: boolean | undefined,
  setOrchestrate: (next: boolean) => void,
): { orchestrateActive: boolean; onToggleOrchestrate: (next: boolean) => void } | undefined {
  if (engine !== "core") {
    return undefined;
  }
  return { orchestrateActive: orchestrate === true, onToggleOrchestrate: setOrchestrate };
}
