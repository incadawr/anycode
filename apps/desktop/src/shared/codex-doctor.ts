/**
 * Result shape of a bounded "codex doctor" run (TASK.41, cut §2(g)/§3.8): a
 * one-shot probe (spawn -> initialize -> account/read -> model/list -> bounded
 * close) that answers "is a working, signed-in, in-range Codex CLI reachable
 * at this binary path". TWO independent call sites produce this report — the
 * host engine (host/engines/codex/*, reusing its own AppServerClient, TASK.39
 * draft catalog) and main's onboarding doctor (main/codex-doctor.ts, its own
 * minimal JSON-RPC client — a host->main import is architecturally forbidden,
 * cut §2(g)) — so the shared RESULT type lives here (shared/**, zero imports
 * except type-only) rather than under host/** or main/**, letting both sides
 * produce/consume the identical shape without duplicating this type.
 *
 * VALUE-ONLY module: `EngineModelChoice`/`CodexRateLimits` are pulled in with
 * `import type` only (erased at compile time under verbatimModuleSyntax — see
 * shared/protocol.ts's header for the same discipline), so this file still
 * carries zero runtime imports and stays safe to import from host/**,
 * main/**, and the renderer.
 */
import type { EngineModelChoice } from "./protocol.js";
import type { CodexRateLimits } from "./codex-quota.js";

/**
 * Status-machine states for the Settings Codex card (cut §2(g)): a working
 * binary that failed a check for a KNOWN reason (`update_required`/
 * `signed_out`) is distinguished from every other failure (`error`, with the
 * diagnostic — never a credential — carried in `CodexDoctorReport.error`).
 * Set unchanged by codex-profiles cut §4.2 (row 7 is a NEW branch reaching an
 * EXISTING status — `ready` — not a new member of this union).
 */
export type CodexDoctorStatus = "not_installed" | "update_required" | "signed_out" | "ready" | "error";

/**
 * Exact shape of the live 0.144.3 wire `Account` union (codex-profiles cut
 * §1.1/§3.1): three known variants plus a forward-compat catch-all so an
 * unrecognized future variant never fails the decoder — it degrades to
 * `{type: string}` (no `plan`), still enough for the status-automat's row 5
 * ("account !== null ⇒ ready", any variant).
 */
export type CodexAccount =
  | { type: "chatgpt"; email: string | null; plan: string }
  | { type: "apiKey" }
  | { type: "amazonBedrock"; credentialSource?: string }
  | { type: string };

/**
 * Result of one bounded doctor run. `account`/`models` are populated only on
 * `status:"ready"`; `error` carries a human-readable, credential-free
 * diagnostic (the doctor never reads or stores a token/cookie — cut §2(g),
 * "AnyCode itself must not copy credentials or read its auth files").
 *
 * Fields below the `──` are additive (codex-profiles cut §3.1) — absent on a
 * report a pre-cut caller built, so every existing construction site still
 * type-checks and every existing consumer's behavior is unchanged.
 */
export interface CodexDoctorReport {
  status: CodexDoctorStatus;
  version?: string;
  account?: CodexAccount | null;
  models?: EngineModelChoice[];
  error?: string;
  // ── additive (codex-profiles cut §3.1) ──
  /**
   * `GetAccountResponse.requiresOpenaiAuth` (cut §1.1) — distinguishes "not
   * signed in, and that's a problem" from "sign-in isn't required for this
   * setup" (api-key/bedrock configured in config.toml). Absent on the wire is
   * treated as `true` by the status-automat (cut §4.2 row 8, fail-closed).
   */
  requiresOpenaiAuth?: boolean;
  /** Rate-limit / quota snapshot from `account/rateLimits/read` (cut §6.1). */
  rateLimits?: CodexRateLimits;
  /** Profile this doctor run was executed against. Absent means `system`. */
  profileId?: string;
  /**
   * Supported-version range this verdict was computed against (cut §7.1) —
   * sourced from the manifest, so the renderer never hardcodes the range
   * string.
   */
  supportedRange?: string;
}
