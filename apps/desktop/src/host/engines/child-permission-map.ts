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
 * | `edit`  | `workspace` | `ask` |
 * | `auto`  | `workspace` (clamped down, RS4-0-2) | `ask` (clamped down, RS4-0-2) |
 * | `yolo`  | `workspace` (clamped down, RS4-0-2) | `ask` (clamped down, RS4-0-2) |
 *
 * `edit`/`auto`/`yolo` all land on Claude's OWN `workspace` preset
 * (`acceptEdits`) rather than a one-shot argv — that preset already asks for
 * anything outside the session cwd, so it is not a widened posture, only
 * Claude's already-frozen "workspace" interactive tier. `build` is AnyCode's
 * ASKING mode — the one the codex `ask`/`approve-for-me` presets map back to
 * (`codexAgentPermissionMode`) and the one Claude's own table sends to `ask` —
 * so a `build`-mode codex child boots on the broker-mediated `child-ask`
 * posture (TASK.179 / Taskana 4078): `untrusted` sends every command approval
 * through CodexApprovalBridge -> IpcPermissionBroker instead of letting codex
 * decide silently under `on-request`. The explicit-autonomy modes
 * (`edit`/`auto`/`yolo`) keep the pre-4078 interactive `ask` posture exactly:
 * the owner chose autonomy for those children, and interposing the broker on
 * their every command would contradict that choice. Neither function can ever
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
 * legacy posture. `build` — AnyCode's asking mode, the one the codex
 * `ask`/`approve-for-me` presets map back to — lands on `child-ask`
 * (TASK.179 / Taskana 4078): a broker-mediated posture where `untrusted`
 * sends EVERY command approval through CodexApprovalBridge ->
 * IpcPermissionBroker instead of letting codex decide silently under
 * `on-request`. The explicit-autonomy modes (`edit`/`auto`/`yolo`) keep the
 * interactive `ask` posture they always had: the owner chose autonomy for
 * those children, and the broker interposing on their every command would
 * contradict it. Like `read-only`, `child-ask` resolves through
 * `findCodexPreset`'s fallback and is absent from
 * `CODEX_PERMISSION_PRESETS`/`codexPresetChoices()`.
 */
export function codexChildPosture(mode: PermissionMode): "read-only" | "child-ask" | "ask" {
  switch (mode) {
    case "plan":
      return "read-only";
    case "build":
      return "child-ask";
    case "edit":
    case "auto":
    case "yolo":
      return "ask";
  }
}

/**
 * Taskana 4265: whether a codex child's boot policy pre-authorises EDITS
 * inside its own workspace — mirroring Claude's `workspace` tier
 * (acceptEdits, `claudeChildPresetId` above) and core edit-mode containment
 * (Write/Edit only). The auto-accept this gates is edit-parity, not a broader
 * licence: a delete-kind patch still asks (cross-review M1 — neither core's
 * Write/Edit-only containment nor acceptEdits silently deletes; the codex
 * child must not become the only posture that does). `build`/`plan`
 * deliberately keep asking for every patch (same posture a core build-mode
 * child gets).
 */
export function codexChildAutoAcceptsWorkspacePatches(mode: PermissionMode): boolean {
  switch (mode) {
    case "plan":
    case "build":
      return false;
    case "edit":
    case "auto":
    case "yolo":
      return true;
  }
}

/**
 * Taskana 4056 cross-review M1: the claude door's port seam. Maps the parent
 * claude session's LIVE preset id (`ClaudeEngine.snapshot().activePresetId`)
 * to the core `PermissionMode` stamped onto every `ChildSpawnRequest` — the
 * value that gates the spawned CORE child's own permission engine, which is
 * why this is a REAL mapping and not the display-only constant
 * `ClaudeEngine.mode()` returns. The codex door's exact analogue is
 * `codexAgentPermissionMode` (dynamic-tool-bridge.ts); same two rules:
 *
 *  - never WIDER than the parent: a `read-only` parent (the preset whose own
 *    label is "Claude plans and reads files, but cannot execute the plan")
 *    spawns children whose Write/Edit/Bash are DENIED outright (`plan`), not
 *    children that merely ask;
 *  - fail-narrow on the unfamiliar, with the codex door's own allowlist
 *    shape: an ALLOWLIST of known-wider presets (`ask`, `workspace` —
 *    `workspace` is still Claude's own ask-outside-the-cwd tier) maps to
 *    `build` (ask-first); every OTHER id — a future preset, a legacy id, a
 *    malformed/empty string — fails narrow to `plan`, exactly like the codex
 *    door's default arm. A preset id this build has never heard of can never
 *    widen a child.
 */
export function claudeAgentPermissionMode(presetId: string): PermissionMode {
  if (presetId === "ask" || presetId === "workspace") return "build";
  return "plan";
}
