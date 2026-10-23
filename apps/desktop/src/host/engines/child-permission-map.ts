/**
 * Frozen mapping from a parent's snapshotted core `PermissionMode` (cut §0.8:
 * a snapshot taken at the moment `Agent` was invoked, never the parent's live
 * mode) to the interactive posture an engine child boots with (TASK.102
 * CUT-S4 §4.2). Pure, side-effect-free, total over every `PermissionMode` —
 * this is the ONE place this mapping happens; each engine boot in
 * `host/index.ts` has exactly one call-site into the matching function here.
 *
 * The table is the cut's own law, reproduced verbatim:
 *
 * | core mode | Claude child preset id | Codex child posture |
 * |---|---|---|
 * | `plan`  | `read-only` | `read-only` |
 * | `build` | `ask`       | `child-ask` |
 * | `edit`  | `workspace` | `child-ask` |
 * | `auto`  | `workspace` (clamped down, RS4-0-2) | `child-ask` (clamped down, RS4-0-2) |
 * | `yolo`  | `workspace` (clamped down, RS4-0-2) | `child-ask` (clamped down, RS4-0-2) |
 *
 * `edit`/`auto`/`yolo` all land on Claude's OWN `workspace` preset
 * (`acceptEdits`) rather than a one-shot argv — that preset already asks for
 * anything outside the session cwd, so it is not a widened posture, only
 * Claude's already-frozen "workspace" interactive tier. Codex children land
 * on the broker-mediated `child-ask` posture (TASK.179 / Taskana 4078):
 * `untrusted` sends every command approval through
 * CodexApprovalBridge -> IpcPermissionBroker instead of letting codex decide
 * silently under `on-request`. The interactive `ask` tier stays menu-only
 * for human-facing tabs. Neither function can ever produce a
 * print-mode invocation (`claude -p` / `codex exec`) or a bypass/auto-review
 * posture: their return type is a strict subset of the ids the frozen
 * `presets.ts` tables (read-only imports below) expose, and those tables
 * simply do not contain the forbidden postures (child-permission-map.test.ts
 * pins this over the whole `PERMISSION_MODES` domain, not per call-site).
 */

import type { PermissionMode } from "@anycode/core";

/** Claude preset id (`presets.ts`'s `ClaudePermissionPresetDefinition.id`) an engine child boots with. */
export function claudeChildPresetId(mode: PermissionMode): "read-only" | "ask" | "workspace" {
  switch (mode) {
    case "plan":
      return "read-only";
    case "build":
      return "ask";
    case "edit":
    case "auto":
    case "yolo":
      return "workspace";
  }
}

/**
 * Codex preset id an engine child boots with. `plan` keeps the `read-only`
 * legacy posture. Every other mode lands on `child-ask` (TASK.179 /
 * Taskana 4078): a broker-mediated posture — `untrusted` sends EVERY command
 * approval through CodexApprovalBridge -> IpcPermissionBroker instead of
 * letting codex decide silently under `on-request`. The interactive `ask`
 * tier stays menu-only for human-facing tabs. Like `read-only`, `child-ask`
 * resolves through `findCodexPreset`'s fallback and is absent from
 * `CODEX_PERMISSION_PRESETS`/`codexPresetChoices()`.
 */
export function codexChildPosture(mode: PermissionMode): "read-only" | "child-ask" {
  switch (mode) {
    case "plan":
      return "read-only";
    case "build":
    case "edit":
    case "auto":
    case "yolo":
      return "child-ask";
  }
}
