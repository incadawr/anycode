/**
 * Result shape of a bounded "claude doctor" run (SLICE-CC A3, cut §1.2 mirror
 * of shared/codex-doctor.ts): a one-shot probe (spawn -> control-protocol
 * `initialize` handshake -> EOF, no user turn ever sent) that answers "is a
 * working, signed-in, version-compatible Claude Code CLI reachable at this
 * binary path". Produced by main/claude-doctor.ts, consumed by main/claude-ipc.ts
 * and renderer/src/components/ClaudeEnginePane.tsx — VALUE-ONLY module, zero
 * runtime imports, so it is safe to import from main/**, host/** (from CC-B
 * onward), and the renderer bundle.
 *
 * CUSTODY (cut §0.2 invariant 2, tighter than Codex's own report): the
 * `initialize` control-response carries `account.email`/`account.organization`/
 * `account.subscriptionType` live, un-gated by `--setting-sources` (W0 probe
 * #2, `w0-13-authprobe-signedin.jsonl`) — NONE of that may ever reach this
 * type. `ClaudeDoctorReport` carries only `status`/`version`/`error`; the
 * doctor reads the account object in memory only long enough to decide
 * signed-in vs signed-out and then discards it.
 */

/**
 * Status-machine states for the Settings Claude card. `not_installed`/
 * `update_required` are binary-level (profile-independent); `signed_out`/
 * `ready` are the AnyCode default-profile's auth-probe verdict (cut §0.3-7:
 * multi-profile UI is CC-E, so CC-A only ever diagnoses one profile).
 */
export type ClaudeDoctorStatus = "not_installed" | "update_required" | "signed_out" | "ready" | "error";

/**
 * Result of one bounded doctor run. `error` carries a human-readable,
 * credential-free diagnostic — the doctor never persists or logs a token,
 * email, or subscription tier (sentinel-leak PoC, cut §1.2 DoD-4).
 */
export interface ClaudeDoctorReport {
  status: ClaudeDoctorStatus;
  version?: string;
  error?: string;
}
