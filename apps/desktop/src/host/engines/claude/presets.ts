/**
 * Frozen Claude permission-preset table (cut §1.4). A pure, side-effect-free
 * data module with zero contact with core's permission engine
 * (`supportsCorePermissions` stays false for Claude; ModeMenu stays hidden).
 *
 * Each preset maps to ONE `--permission-mode` value. The wire/flag asymmetry is
 * real and load-bearing: the mode the control protocol and `system/init` call
 * `default` is the mode the CLI flag calls `manual` (probe #8) — the mapping
 * lives in protocol.ts and is applied at both the spawn boundary and the
 * mid-session `set_permission_mode` boundary.
 *
 * Three CLI modes are deliberately NOT exposed, and this is now measured
 * behaviour rather than caution (probe #8):
 *   - `dontAsk`         auto-DENIES with no control event at all — the bridge
 *                       would have nothing to show the user.
 *   - `auto`            a classifier approves SILENTLY, bypassing the control
 *                       channel — zero approval visibility.
 *   - `bypassPermissions` unreachable mid-session without a spawn flag.
 * (The codex analogue of this exclusion is its `never` approval policy.)
 */

import type { EnginePermissionPreset } from "../../../shared/protocol.js";
import type { PermissionMode } from "./protocol.js";

export interface ClaudePermissionPresetDefinition {
  id: string;
  label: string;
  description: string;
  /** WIRE value — `permissionModeToFlag()` converts it for the spawn argv. */
  mode: PermissionMode;
}

/**
 * The frozen table (cut §1.4). Semantics of each mode were captured live
 * (`w0-08-permmodes{,2}.jsonl`):
 *
 *  - `plan` is NOT a hard execution block: the CLI writes its plan file into
 *    the profile dir unprompted, and the real gate is the mandatory
 *    `ExitPlanMode` approval — which approval-bridge.ts denies in this preset
 *    rather than letting the model escalate out of read-only.
 *  - `acceptEdits` still ASKS for a Write outside the session cwd
 *    (`workingDir` is an orthogonal axis); in-cwd auto-accept is residual
 *    R-W0-2, to be closed by the live smoke.
 */
export const CLAUDE_PERMISSION_PRESETS: readonly ClaudePermissionPresetDefinition[] = [
  {
    id: "read-only",
    label: "Read-only",
    description: "Claude plans and reads files, but cannot execute the plan without switching preset.",
    mode: "plan",
  },
  {
    id: "ask",
    label: "Ask",
    description: "Claude asks before running commands or changing files (default).",
    mode: "default",
  },
  {
    id: "workspace",
    label: "Workspace",
    description: "Claude can accept file edits inside the workspace with fewer prompts.",
    mode: "acceptEdits",
  },
];

/** Current default posture (cut §1.4: `ask` -> wire `default`, CLI flag `manual`). */
export const DEFAULT_CLAUDE_PRESET = "ask" as const;

export function findClaudePreset(id: string): ClaudePermissionPresetDefinition | undefined {
  return CLAUDE_PERMISSION_PRESETS.find((preset) => preset.id === id);
}

/**
 * Reverse lookup: the wire-level `permissionMode` a resumed session's first
 * `system/init` reports back, to a preset id (CC-D-min resume settle, cut
 * §1.5 hazard (б)). `undefined` for one of the three modes this table
 * deliberately never exposes (`dontAsk`/`auto`/`bypassPermissions`) — the
 * caller degrades by leaving the persisted preset untouched rather than
 * forcing a guess.
 */
export function findClaudePresetByMode(mode: PermissionMode): ClaudePermissionPresetDefinition | undefined {
  return CLAUDE_PERMISSION_PRESETS.find((preset) => preset.mode === mode);
}

/** The wire projection consumed by `EnginePresentation.permissions.presets` — labels only, never the mode values. */
export function claudePresetChoices(): EnginePermissionPreset[] {
  return CLAUDE_PERMISSION_PRESETS.map((preset) => ({
    id: preset.id,
    label: preset.label,
    description: preset.description,
  }));
}
