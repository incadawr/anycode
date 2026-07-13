/**
 * Native Codex login flow (TASK.41 п.3): `account/login/start` -> open the
 * returned `authUrl` in the system browser -> wait (bounded, cancellable) for
 * the `account/login/completed` server notification -> close. Reuses
 * `CodexRpcClient` from main/codex-doctor.ts verbatim — one spawn/teardown
 * implementation for every main-side Codex child, never a second one that can
 * independently drift (see that module's own header for why that matters).
 *
 * NOT live-evidenced (cut §1 point 5: "account/login/start, account/login/
 * cancel, account/logout — schema-only, live НЕ evidenced — интерактивный
 * browser-flow"): built strictly to the pinned JSON-RPC schema
 * (host/engines/codex/contract/pinned-contract.json's `LoginAccountParams`/
 * `LoginAccountResponse`/`AccountLoginCompletedNotification`), with bounded
 * timeouts and a cancel path either way. Real-browser confirmation is owner
 * live-dogfood (cut §5.5), not something this slice can prove in CI.
 *
 * CUSTODY: this module never reads, logs, or returns a token/cookie. The only
 * values it ever touches are `authUrl` (opened, not stored), `loginId` (an
 * opaque correlation id, not a credential), and the login OUTCOME (success/
 * failure) — never the account's own auth material, which stays inside
 * CODEX_HOME, owned by the `codex` CLI itself.
 */
import type { SpawnOptions, ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { CodexRpcClient, buildDoctorChildEnv } from "./codex-doctor.js";
import { CODEX_DOCTOR_RPC_TIMEOUT_MS } from "../shared/codex-timeouts.js";

/**
 * Generous, HUMAN-interaction bound (typing credentials, 2FA, ...) —
 * deliberately NOT `CODEX_DOCTOR_WATCHDOG_MS` (that constant bounds a
 * no-human-in-the-loop diagnostic pass; a login round trip is a different
 * shape of wait entirely). Not part of the doctor's own watchdog arithmetic —
 * this is its own, independently bounded flow with the SAME teardown recipe.
 */
export const CODEX_LOGIN_TIMEOUT_MS = 5 * 60_000;

export type CodexLoginOutcome =
  | { ok: true }
  | { ok: false; reason: "cancelled" | "timeout" | "failed" };

export interface RunCodexLoginOptions {
  /** Opens the browser (main injects `shell.openExternal`; tests inject a spy). */
  openExternal: (url: string) => Promise<void> | void;
  /** Resolves the in-flight wait early with `{ok:false, reason:"cancelled"}` and sends `account/login/cancel`. */
  signal?: AbortSignal;
  timeoutMs?: number;
  rpcTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  spawnImpl?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs one bounded ChatGPT login attempt against `binaryPath`. Always closes
 * its spawned child before returning (the same bounded `CodexRpcClient.
 * close()` used by the doctor), on every path: success, cancel, timeout, or
 * an unexpected protocol/transport failure. The caller is expected to re-run
 * `runCodexDoctor` afterward to build a fresh, authoritative
 * `CodexDoctorReport` — this function reports ONLY the login handshake's own
 * outcome, never account state (that stays the doctor's job, avoiding two
 * independent codepaths that read `account/read`).
 */
export async function runCodexLogin(binaryPath: string, options: RunCodexLoginOptions): Promise<CodexLoginOutcome> {
  const spawnImpl = options.spawnImpl ?? spawn;
  const platform = options.platform ?? process.platform;
  const env = buildDoctorChildEnv(options.env ?? process.env, platform);
  const timeoutMs = options.timeoutMs ?? CODEX_LOGIN_TIMEOUT_MS;
  const rpcTimeoutMs = options.rpcTimeoutMs ?? CODEX_DOCTOR_RPC_TIMEOUT_MS;
  const client = new CodexRpcClient(spawnImpl);

  let resolveCompletion: ((outcome: CodexLoginOutcome) => void) | null = null;
  const completion = new Promise<CodexLoginOutcome>((resolve) => {
    resolveCompletion = resolve;
  });
  let matchedLoginId: string | undefined;
  client.onNotification((notification) => {
    if (notification.method !== "account/login/completed") return;
    const params = notification.params as { success?: unknown; loginId?: unknown } | undefined;
    // Correlate by loginId when the server supplied one on both sides;
    // otherwise (no loginId echoed) accept the single in-flight completion.
    if (matchedLoginId !== undefined && typeof params?.loginId === "string" && params.loginId !== matchedLoginId) {
      return;
    }
    if (params?.success === true) {
      resolveCompletion?.({ ok: true });
    } else {
      resolveCompletion?.({ ok: false, reason: "failed" });
    }
  });

  try {
    client.spawn(binaryPath, env);
    await client.request(
      "initialize",
      { clientInfo: { name: "anycode-codex-login", title: "AnyCode Codex Login", version: "0.0.0" }, capabilities: { experimentalApi: false } },
      { timeoutMs: rpcTimeoutMs },
    );
    client.notify("initialized");
    const loginResponse = await client.request<{ type?: unknown; authUrl?: unknown; loginId?: unknown }>(
      "account/login/start",
      { type: "chatgpt" },
      { timeoutMs: rpcTimeoutMs },
    );
    const authUrl = loginResponse.authUrl;
    const loginId = loginResponse.loginId;
    if (typeof authUrl !== "string" || authUrl === "" || typeof loginId !== "string" || loginId === "") {
      return { ok: false, reason: "failed" };
    }
    matchedLoginId = loginId;
    await options.openExternal(authUrl);

    const aborted = new Promise<CodexLoginOutcome>((resolve) => {
      if (options.signal === undefined) return;
      if (options.signal.aborted) {
        resolve({ ok: false, reason: "cancelled" });
        return;
      }
      options.signal.addEventListener("abort", () => resolve({ ok: false, reason: "cancelled" }), { once: true });
    });
    const timedOut = delay(timeoutMs).then((): CodexLoginOutcome => ({ ok: false, reason: "timeout" }));

    const outcome = await Promise.race([completion, aborted, timedOut]);
    if (!outcome.ok && (outcome.reason === "cancelled" || outcome.reason === "timeout")) {
      try {
        await client.request("account/login/cancel", { loginId }, { timeoutMs: rpcTimeoutMs });
      } catch {
        // best effort — close() below still tears the child down regardless.
      }
    }
    return outcome;
  } catch {
    return { ok: false, reason: "failed" };
  } finally {
    await client.close();
  }
}
