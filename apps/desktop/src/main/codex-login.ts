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
import { checkCodexBinaryPathTrust } from "./codex-binary.js";
import {
  applyCodexProfileEnv,
  assertCodexProfileHome,
  type CodexProfileGuardResult,
  type ResolvedCodexProfile,
} from "./codex-profiles.js";
import { CODEX_DOCTOR_RPC_TIMEOUT_MS, CODEX_LOGIN_RPC_TIMEOUT_MS } from "../shared/codex-timeouts.js";

/**
 * Generous, HUMAN-interaction bound (typing credentials, 2FA, ...) —
 * deliberately NOT `CODEX_DOCTOR_WATCHDOG_MS` (that constant bounds a
 * no-human-in-the-loop diagnostic pass; a login round trip is a different
 * shape of wait entirely). Not part of the doctor's own watchdog arithmetic —
 * this is its own, independently bounded flow with the SAME teardown recipe.
 */
export const CODEX_LOGIN_TIMEOUT_MS = 5 * 60_000;

/**
 * Taskana 4884: every failing branch used to collapse into a bare
 * `reason: "failed"`, so the next failure could not say WHAT broke — the UI
 * could only ever show "Sign-in failed. Try again." The failed outcome now also
 * carries a short `detail` (never a credential, never a token; see
 * `loginDetail`) that the controller logs and forwards to the renderer.
 */
export type CodexLoginOutcome =
  | { ok: true }
  | { ok: false; reason: "cancelled" | "timeout" | "failed"; detail?: string };

/** Upper bound on a `detail` string — it is a UI/log line, not a transcript. */
const LOGIN_DETAIL_MAX_CHARS = 200;

/**
 * CUSTODY: `detail` is human-facing text and must stay free of anything a
 * credential could hide in. It is derived ONLY from our own literal labels and
 * from `Error.message` values of our own RPC client (timeouts/transport) or the
 * codex server's error text — never from `auth.json`, an env value, or a
 * response field carrying auth material. Control characters are flattened so a
 * multi-line payload cannot forge extra log lines, and the length is capped.
 */
function loginDetail(text: string): string {
  const flattened = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return flattened.length > LOGIN_DETAIL_MAX_CHARS ? `${flattened.slice(0, LOGIN_DETAIL_MAX_CHARS - 1)}…` : flattened;
}


export interface RunCodexLoginOptions {
  mode?: import("../shared/codex-login.js").CodexLoginMode;
  onDeviceCode?: (code: { userCode: string; verificationUrl: string }) => void;
  /** Opens the browser (main injects `shell.openExternal`; tests inject a spy). */
  openExternal: (url: string) => Promise<void> | void;
  /** Resolves the in-flight wait early with `{ok:false, reason:"cancelled"}` and sends `account/login/cancel`. */
  signal?: AbortSignal;
  timeoutMs?: number;
  /**
   * Bound on the LOCAL RPCs of the handshake (`initialize`,
   * `account/login/cancel`) — the doctor's own per-RPC bound by default.
   */
  rpcTimeoutMs?: number;
  /**
   * Taskana 4884: bound on `account/login/start` alone. That one is a real
   * NETWORK round trip (the server mints the device code / auth URL), so the
   * doctor's `CODEX_DOCTOR_RPC_TIMEOUT_MS` is the wrong distribution to size it
   * against: observed real mints ran 0.4s…4.0s, i.e. a 3s bound rejected a
   * legitimately slow-but-successful login and surfaced as an instant
   * "Sign-in failed". Defaults to `CODEX_LOGIN_RPC_TIMEOUT_MS`.
   */
  loginStartTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  spawnImpl?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  /** DI seam for the spawn-time trust gate; production re-reads the real filesystem (`checkCodexBinaryPathTrust`). */
  trust?: (binaryPath: string) => string | null;
  /**
   * The profile this login signs INTO (TASK.50 п.2): its home OVERWRITES any
   * ambient CODEX_HOME in the child env, so `codex` writes the credential
   * into the profile's own tree — never into `~/.codex`. Absent or system:
   * env inheritance, byte-for-byte the pre-profiles behavior. An authLink
   * profile is REFUSED outright (amended §A1.2: it mirrors an external
   * credential; a broken link is repaired by "Re-link credential", never by
   * re-login).
   */
  profile?: ResolvedCodexProfile;
  /** DI seam for the pre-spawn home guard; production re-asserts the real filesystem (`assertCodexProfileHome`). */
  profileGuard?: (profile: ResolvedCodexProfile) => CodexProfileGuardResult;
  /**
   * Taskana 4685: MAIN's own credential-free relay URL — a credentialed proxy
   * in the source env is swapped for it in the login child's env (fail-closed
   * drop when absent). The OAuth round trip is a real network flight, so the
   * relay keeps it working behind an authenticating proxy WITHOUT the
   * credential ever reaching the codex CLI.
   */
  relayUrl?: string;
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
  // ENTRANCE GATE (W3.5-review Critical): the signal is otherwise first observed
  // far below — after the child is spawned, initialized, the login started and
  // the browser opened. A login entered with an already-aborted signal (quit ran
  // while its caller was parked on a pre-spawn `await`) must therefore produce
  // NO child and NO browser window at all, rather than one that a `finally`
  // reaps a moment later: the child is detached, and on win32 nothing reaps it.
  if (options.signal?.aborted === true) {
    return { ok: false, reason: "cancelled" };
  }
  const profile = options.profile;
  // An authLink profile has no login flow at all (amended §A1.2): logging in
  // would make codex replace the symlink with a fresh credential FILE,
  // silently detaching the profile from the external account it mirrors.
  if (profile?.authLink !== undefined) {
    return {
      ok: false,
      reason: "failed",
      detail: "this profile mirrors an external credential (authLink) — use Re-link credential instead of signing in",
    };
  }
  const spawnImpl = options.spawnImpl ?? spawn;
  const platform = options.platform ?? process.platform;
  const env = applyCodexProfileEnv(buildDoctorChildEnv(options.env ?? process.env, platform, options.relayUrl), profile);
  const timeoutMs = options.timeoutMs ?? CODEX_LOGIN_TIMEOUT_MS;
  const rpcTimeoutMs = options.rpcTimeoutMs ?? CODEX_DOCTOR_RPC_TIMEOUT_MS;
  const loginStartTimeoutMs = options.loginStartTimeoutMs ?? CODEX_LOGIN_RPC_TIMEOUT_MS;
  const client = new CodexRpcClient(spawnImpl);

  let resolveCompletion: ((outcome: CodexLoginOutcome) => void) | null = null;
  const completion = new Promise<CodexLoginOutcome>((resolve) => {
    resolveCompletion = resolve;
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  let matchedLoginId: string | undefined;
  client.onNotification((notification) => {
    if (notification.method !== "account/login/completed") return;
    const params = notification.params as { success?: unknown; loginId?: unknown; error?: unknown } | undefined;
    // Correlate by loginId when the server supplied one on both sides;
    // otherwise (no loginId echoed) accept the single in-flight completion.
    if (matchedLoginId !== undefined && typeof params?.loginId === "string" && params.loginId !== matchedLoginId) {
      return;
    }
    if (params?.success === true) {
      resolveCompletion?.({ ok: true });
    } else {
      // The server's own `error` string (contract: string|null) is the only
      // explanation a failed sign-in ever gets — surface it instead of the old
      // bare "failed" (Taskana 4884). Absent ⇒ say so, so the reader can tell a
      // silent refusal from an unexplained one.
      const serverError = typeof params?.error === "string" && params.error.trim() !== "" ? loginDetail(params.error) : undefined;
      resolveCompletion?.({
        ok: false,
        reason: "failed",
        detail: serverError !== undefined ? `the sign-in was rejected: ${serverError}` : "the sign-in was rejected without an error message",
      });
    }
  });

  try {
    // Re-validated at SPAWN time, not merely at discovery (W2-review Medium) —
    // login executes the same binary the doctor approved, at a later moment.
    const trust = options.trust ?? ((path: string) => checkCodexBinaryPathTrust(path, undefined, platform));
    const trustRefusal = trust(binaryPath);
    if (trustRefusal !== null) {
      return { ok: false, reason: "failed", detail: loginDetail(`the Codex binary failed the trust check: ${trustRefusal}`) };
    }
    // Home guard for the profile being signed into (cut §2.5 + amended §A2):
    // re-asserted immediately before the spawn, same discipline as the binary
    // trust line above. Fail-closed: no spawn, no browser window.
    if (profile !== undefined) {
      const profileGuard = options.profileGuard ?? ((target: ResolvedCodexProfile) => assertCodexProfileHome(target, { platform }));
      const guard = profileGuard(profile);
      if (!guard.ok) {
        return { ok: false, reason: "failed", detail: loginDetail(`the profile home was refused: ${guard.reason}`) };
      }
    }
    client.spawn(binaryPath, env);
    await client.request(
      "initialize",
      { clientInfo: { name: "anycode-codex-login", title: "AnyCode Codex Login", version: "0.0.0" }, capabilities: { experimentalApi: false } },
      { timeoutMs: rpcTimeoutMs },
    );
    client.notify("initialized");
    const loginResponse = await client.request<{ type?: unknown; authUrl?: unknown; loginId?: unknown; userCode?: unknown; verificationUrl?: unknown }>(
      "account/login/start",
      { type: options.mode === "device" ? "chatgptDeviceCode" : "chatgpt" },
      { timeoutMs: loginStartTimeoutMs },
    );
    const authUrl = options.mode === "device" ? loginResponse.verificationUrl : loginResponse.authUrl;
    const loginId = loginResponse.loginId;
    if (typeof authUrl !== "string" || authUrl === "" || typeof loginId !== "string" || loginId === "") {
      return {
        ok: false,
        reason: "failed",
        detail: `the login response carried no usable ${options.mode === "device" ? "verification URL" : "auth URL"} and login id`,
      };
    }
    matchedLoginId = loginId;
    if (options.signal?.aborted) return { ok: false, reason: "cancelled" };
    const url = new URL(authUrl);
    if (url.protocol !== "https:" || url.username || url.password) {
      return { ok: false, reason: "failed", detail: "the login response carried an unsafe login URL (not a plain https URL)" };
    }
    if (options.mode === "device") {
      const userCode = loginResponse.userCode;
      if (loginResponse.type !== "chatgptDeviceCode" || typeof userCode !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(userCode)) {
        return {
          ok: false,
          reason: "failed",
          detail: `the device-code response was malformed (type=${typeof loginResponse.type === "string" ? loginResponse.type : "missing"}, code=${typeof userCode === "string" ? "present but invalid" : "missing"})`,
        };
      }
      // Device-code flow never auto-opens the browser: the user sees the code
      // and the link and opens the page (or copies the link) on purpose.
      options.onDeviceCode?.({ userCode, verificationUrl: authUrl });
    } else {
      await options.openExternal(authUrl);
    }

    const aborted = new Promise<CodexLoginOutcome>((resolve) => {
      if (options.signal === undefined) return;
      if (options.signal.aborted) {
        resolve({ ok: false, reason: "cancelled" });
        return;
      }
      onAbort = () => resolve({ ok: false, reason: "cancelled" });
      options.signal.addEventListener("abort", onAbort, { once: true });
    });
    const timedOut = new Promise<CodexLoginOutcome>((resolve) => {
      timeout = setTimeout(() => resolve({ ok: false, reason: "timeout", detail: `the login did not complete within ${Math.round(timeoutMs / 1000)}s` }), timeoutMs);
    });

    const outcome = await Promise.race([completion, aborted, timedOut]);
    if (!outcome.ok && (outcome.reason === "cancelled" || outcome.reason === "timeout")) {
      try {
        await client.request("account/login/cancel", { loginId }, { timeoutMs: rpcTimeoutMs });
      } catch {
        // best effort — close() below still tears the child down regardless.
      }
    }
    return outcome;
  } catch (error) {
    // Taskana 4884: the RPC/transport message is the ONLY useful breadcrumb the
    // old silent catch threw away (a timed-out network mint, a spawn failure, a
    // server-side rejection). It is our own client's/error's text — never
    // credential material — and it is what tells the user WHAT broke.
    return { ok: false, reason: "failed", detail: loginDetail(`the login request failed: ${error instanceof Error ? error.message : String(error)}`) };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (onAbort !== undefined) options.signal?.removeEventListener("abort", onAbort);
    await client.close();
  }
}
