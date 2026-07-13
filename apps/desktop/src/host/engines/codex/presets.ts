/**
 * Frozen Codex permission-preset table (TASK.39, cut §2(d)/§3.8). A pure,
 * side-effect-free data module — zero contact with core's permission engine
 * (`supportsCorePermissions` stays `false` for Codex; ModeMenu stays hidden).
 * Every preset carries BOTH wire forms the protocol requires (cut §1.3):
 * `ThreadStartParams.sandbox: SandboxMode` (a plain string) for the initial
 * `thread/start`, and `TurnStartParams.sandboxPolicy: SandboxPolicy` (a full
 * object) for a between-turns override. `turnOverride` is a pure function of
 * the session's workspace (its `writableRoots` root) rather than a baked-in
 * path — the table itself carries no per-session state.
 *
 * `never`/`danger-full-access`/granular `AskForApproval` are deliberately NOT
 * represented here (cut §2(d) residual) — renderer/host can only ever pick a
 * `presetId` from this table (host-authoritative membership check), never a
 * raw sandbox/policy object.
 */

import type { EnginePermissionPreset } from "../../../shared/protocol.js";

export type CodexApprovalPolicy = "untrusted" | "on-request";

/** `ThreadStartParams.sandbox` (cut §1.3) — the coarse posture sent on `thread/start`. */
export type CodexThreadSandboxMode = "read-only" | "workspace-write";

export interface CodexSandboxPolicyReadOnly {
  type: "readOnly";
  networkAccess: false;
}

export interface CodexSandboxPolicyWorkspaceWrite {
  type: "workspaceWrite";
  writableRoots: string[];
  networkAccess: false;
  excludeTmpdirEnvVar: false;
  excludeSlashTmp: false;
}

/** `TurnStartParams.sandboxPolicy` (cut §1.3) — the full object form sent on a between-turns override. */
export type CodexTurnSandboxPolicy = CodexSandboxPolicyReadOnly | CodexSandboxPolicyWorkspaceWrite;

export interface CodexTurnOverride {
  approvalPolicy: CodexApprovalPolicy;
  sandboxPolicy: CodexTurnSandboxPolicy;
}

export interface CodexPermissionPresetDefinition {
  id: string;
  label: string;
  description: string;
  /** Sent verbatim on `thread/start` (initial policy, cut §2(d) "Применение"). */
  threadParams: { approvalPolicy: CodexApprovalPolicy; sandbox: CodexThreadSandboxMode };
  /** Pure function of the session workspace — never baked into this frozen table. */
  turnOverride: (workspace: string) => CodexTurnOverride;
}

function workspaceWritePolicy(workspace: string): CodexSandboxPolicyWorkspaceWrite {
  return {
    type: "workspaceWrite",
    writableRoots: [workspace],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

/** The frozen table (cut §2(d)) — order matches the cut's own table for readability; lookups use `id`, never index. */
export const CODEX_PERMISSION_PRESETS: readonly CodexPermissionPresetDefinition[] = [
  {
    id: "read-only",
    label: "Read-only",
    description: "Codex can read files but cannot run commands, write files, or reach the network.",
    threadParams: { approvalPolicy: "on-request", sandbox: "read-only" },
    turnOverride: () => ({ approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly", networkAccess: false } }),
  },
  {
    id: "ask",
    label: "Ask",
    description: "Codex asks before running commands or changing files (default).",
    threadParams: { approvalPolicy: "untrusted", sandbox: "workspace-write" },
    turnOverride: (workspace) => ({ approvalPolicy: "untrusted", sandboxPolicy: workspaceWritePolicy(workspace) }),
  },
  {
    id: "workspace",
    label: "Workspace",
    description: "Codex can write inside the workspace and run commands with fewer prompts.",
    threadParams: { approvalPolicy: "on-request", sandbox: "workspace-write" },
    turnOverride: (workspace) => ({ approvalPolicy: "on-request", sandboxPolicy: workspaceWritePolicy(workspace) }),
  },
];

/** Current default posture (cut §2(d): "ask (default = текущее поведение)") — matches the pre-existing `createNativeCodexSession` thread/start literals verbatim. */
export const DEFAULT_CODEX_PRESET = "ask" as const;

export function findCodexPreset(id: string): CodexPermissionPresetDefinition | undefined {
  return CODEX_PERMISSION_PRESETS.find((preset) => preset.id === id);
}

/** The wire projection consumed by `EnginePresentation.permissions.presets` — labels/descriptions only, never the policy objects. */
export function codexPresetChoices(): EnginePermissionPreset[] {
  return CODEX_PERMISSION_PRESETS.map((preset) => ({
    id: preset.id,
    label: preset.label,
    description: preset.description,
  }));
}

/**
 * The settings a `thread/start` / `thread/resume` response echoes back. Only the
 * two axes worth comparing are modelled; unknown/extra keys are ignored (L9).
 */
export interface CodexEffectiveSettings {
  approvalPolicy?: unknown;
  /** `{type:"workspaceWrite"|"readOnly"|"dangerFullAccess", …}` on the wire. */
  sandbox?: unknown;
}

/** Sandbox confinement, strongest first. An unrecognized tier is `undefined` -> not comparable -> silent. */
function sandboxTier(sandbox: unknown): number | undefined {
  const type = sandbox !== null && typeof sandbox === "object" ? (sandbox as { type?: unknown }).type : sandbox;
  if (type === "readOnly" || type === "read-only") return 2;
  if (type === "workspaceWrite" || type === "workspace-write") return 1;
  if (type === "dangerFullAccess" || type === "danger-full-access") return 0;
  return undefined;
}

/**
 * Drift check (cut §2(k).2), NOT a reverse mapping. Reverse-mapping the server's
 * effective settings back to a preset id is FORBIDDEN — L8 proves it is
 * impossible: a thread started `untrusted` resumes reporting `on-request`, and
 * `writableRoots` echoes back `[]`. The persisted `presetId` is the single
 * source of display truth; the echo is only ever consulted to answer one
 * question: "is what the server actually has WEAKER than what the user picked?"
 *
 * Consequences of L8, both deliberate:
 *  - The `untrusted` <-> `on-request` pair is treated as EQUIVALENT. It is the
 *    one asymmetry the server is known not to round-trip, so comparing it would
 *    fire a warning on literally every resume of the default preset — a warning
 *    that cries wolf is worse than no warning. `never` (approvals disabled
 *    outright) is still genuinely weaker than both and IS reported.
 *  - `writableRoots` is never compared (the echo is `[]` even when a root was
 *    sent and honoured).
 *
 * The sandbox tier, by contrast, does round-trip and is compared in full.
 */
export function isEffectivePostureWeaker(
  preset: CodexPermissionPresetDefinition,
  effective: CodexEffectiveSettings,
): boolean {
  if (effective.approvalPolicy === "never") return true;
  const expected = sandboxTier(preset.threadParams.sandbox);
  const actual = sandboxTier(effective.sandbox);
  if (expected === undefined || actual === undefined) return false;
  return actual < expected;
}
