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
 * VALUE-ONLY module: `EngineModelChoice` is pulled in with `import type` only
 * (erased at compile time under verbatimModuleSyntax — see shared/protocol.ts's
 * header for the same discipline), so this file still carries zero runtime
 * imports and stays safe to import from host/**, main/**, and the renderer.
 */
import type { EngineModelChoice } from "./protocol.js";

/**
 * Status-machine states for the Settings Codex card (cut §2(g)): a working
 * binary that failed a check for a KNOWN reason (`update_required`/
 * `signed_out`) is distinguished from every other failure (`error`, with the
 * diagnostic — never a credential — carried in `CodexDoctorReport.error`).
 */
export type CodexDoctorStatus = "not_installed" | "update_required" | "signed_out" | "ready" | "error";

/**
 * Result of one bounded doctor run. `account`/`models` are populated only on
 * `status:"ready"`; `error` carries a human-readable, credential-free
 * diagnostic (the doctor never reads or stores a token/cookie — cut §2(g),
 * "AnyCode itself must not copy credentials or read its auth files").
 */
export interface CodexDoctorReport {
  status: CodexDoctorStatus;
  version?: string;
  account?: { type: string; plan: string } | null;
  models?: EngineModelChoice[];
  error?: string;
}
