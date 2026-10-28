/**
 * Shared scaffolding for the tests that boot the REAL host fork
 * (`await import("./index.js")`) against a throwaway profile.
 *
 * Booting the fork in-process means the test mutates the ONE process
 * environment that the fork reads (`os.homedir()`, `ANYCODE_DB_PATH`, the proxy
 * family). Two rules keep that honest:
 *
 *  - every input the fork honours is stubbed onto a temp dir — through
 *    `vi.stubEnv`, i.e. real `process.env` mutations that `os.homedir()`
 *    follows. That includes the session pair the fork CREATES when it is absent
 *    (an unstubbed absent key would never be recorded, so cleanup could not
 *    remove it again) and the proxy family the fork scans at boot (a
 *    credentialed ambient proxy would make the fork bind a loopback relay).
 *
 *  - nothing is restored while the fork can still read the environment. Its
 *    teardown awaits `ready` — so a boot still sitting in front of the database
 *    open finishes first, against the TEMP environment — and ends with
 *    `process.exit` right after the database is closed: that call is the
 *    "stopped" signal. A scenario that times out is followed by a shutdown
 *    request, and the environment is restored only once the fork stops. A fork
 *    that never stops keeps the temp profile in place instead of handing a late
 *    boot the developer's real profile.
 */

import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";

/** The proxy family the fork scans at boot (`credentialedProxyValuesForRelay`), both cases. */
export const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
] as const;

/** Host boot stamps this pair into its own environment when it is absent (`applySessionToolEnv`). */
export const SESSION_ENV_KEYS = ["ANYCODE_SESSION_ID", "ANYCODE_SESSION_WORKSPACE"] as const;

const DEFAULT_STOP_BUDGET_MS = 10_000;
const DEFAULT_POLL_MS = 25;

export interface TempProfile {
  dir: string;
  dbPath: string;
  settingsPath: string;
  diagnosticsDir: string;
}

export interface HostParent extends EventEmitter {
  postMessage(value: unknown): void;
}

export interface HermeticHostBoot {
  profile: TempProfile;
  parent: HostParent;
  /** Asks the fork to shut down — exactly once, its teardown is not re-entrant. */
  requestShutdown(): void;
  /** True once the fork reached the end of its teardown (`process.exit`). */
  stopped(): boolean;
  /** Waits for the end of that teardown; true when it arrived within the budget. */
  waitForStopped(budgetMs?: number): Promise<boolean>;
}

export interface HermeticHostBootOptions {
  /** `mkdtemp` prefix, so a leaked profile is identifiable in the temp dir. */
  tempPrefix?: string;
  /** Pinned on top of the profile defaults (e.g. model credentials for the boot). */
  extraEnv?: Record<string, string>;
  /** Boot seam for unit tests; defaults to the real host fork. */
  boot?: () => Promise<void>;
  /** How long cleanup waits for a timed-out scenario's fork to stop. */
  stopBudgetMs?: number;
  pollMs?: number;
}

export interface HermeticHostBootResult {
  profile: TempProfile;
  /** What the scenario threw (a timed-out wait included), or null when it completed. */
  error: unknown;
  /** The fork reached the end of its teardown, so cleanup could run. */
  stopped: boolean;
  /** The environment is restored and the temp profile deleted — only ever after a stop. */
  restored: boolean;
  /** HOME as the fork saw it at the end of teardown: proves it never saw the real one. */
  homeAtStop: string | undefined;
}

/** Creates the throwaway profile and stubs the environment onto it. */
function stubHermeticProfile(options: HermeticHostBootOptions): TempProfile {
  const dir = mkdtempSync(join(tmpdir(), options.tempPrefix ?? "anycode-boot-test-"));
  const profile: TempProfile = {
    dir,
    dbPath: join(dir, "anycode.sqlite"),
    settingsPath: join(dir, "settings.json"),
    diagnosticsDir: join(dir, "diagnostics"),
  };
  // Ambient ANYCODE_* from the developer's shell must not shape this boot.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("ANYCODE_")) vi.stubEnv(key, undefined);
  }
  for (const key of SESSION_ENV_KEYS) vi.stubEnv(key, undefined);
  for (const key of PROXY_ENV_KEYS) vi.stubEnv(key, undefined);
  // `vi.stubEnv` is the real mutation `os.homedir()` follows; `process.env = {}`
  // would only swap the JS object and leave the fork on the real home.
  vi.stubEnv("HOME", dir);
  vi.stubEnv("USERPROFILE", dir);
  vi.stubEnv("XDG_CONFIG_HOME", join(dir, "config"));
  vi.stubEnv("XDG_CACHE_HOME", join(dir, "cache"));
  vi.stubEnv("ANYCODE_SETTINGS_PATH", profile.settingsPath);
  vi.stubEnv("ANYCODE_DB_PATH", profile.dbPath);
  vi.stubEnv("ANYCODE_DIAGNOSTICS_DIR", profile.diagnosticsDir);
  for (const [key, value] of Object.entries(options.extraEnv ?? {})) vi.stubEnv(key, value);
  return profile;
}

/**
 * Boots the fork against a throwaway profile, runs `scenario`, then stops the
 * fork and only afterwards restores the environment. Whatever `scenario` throws
 * is returned rather than raised, so a failing wait can still be inspected
 * against what the fork saw.
 */
export async function bootHostInTempProfile(
  scenario: (boot: HermeticHostBoot) => Promise<void>,
  options: HermeticHostBootOptions = {},
): Promise<HermeticHostBootResult> {
  const stopBudgetMs = options.stopBudgetMs ?? DEFAULT_STOP_BUDGET_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const profile = stubHermeticProfile(options);
  const oldCwd = process.cwd();
  const oldPort = Object.getOwnPropertyDescriptor(process, "parentPort");
  const parent = new EventEmitter() as HostParent;
  parent.postMessage = () => {};
  let shutdownRequested = false;
  let exits = 0;
  let homeAtStop: string | undefined;
  const exit = vi.spyOn(process, "exit").mockImplementation((() => {
    exits += 1;
    homeAtStop = process.env.HOME;
    return undefined;
  }) as typeof process.exit);
  const stopped = (): boolean => exits > 0;
  const requestShutdown = (): void => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    parent.emit("message", { ports: [], data: { type: "shutdown" } });
  };
  const waitForStopped = async (budgetMs: number = stopBudgetMs): Promise<boolean> => {
    const deadline = Date.now() + budgetMs;
    while (!stopped() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, pollMs));
    return stopped();
  };
  let error: unknown = null;
  let couldStop = false;
  try {
    process.chdir(profile.dir);
    (process as any).parentPort = parent;
    await (options.boot ?? (() => import("./index.js")))();
    await scenario({ profile, parent, requestShutdown, stopped, waitForStopped });
  } catch (caught) {
    error = caught;
  } finally {
    // The shutdown handler is registered during module evaluation. If it is
    // absent, no boot can have passed its first await, so there is nothing to
    // stop — and nothing that could read a restored environment.
    if (!stopped() && parent.listenerCount("message") > 0) {
      requestShutdown();
      await waitForStopped();
    }
    couldStop = stopped();
    if (couldStop) {
      process.chdir(oldCwd);
      if (oldPort) Object.defineProperty(process, "parentPort", oldPort);
      else Reflect.deleteProperty(process, "parentPort");
      exit.mockRestore();
      vi.unstubAllEnvs();
      rmSync(profile.dir, { recursive: true, force: true });
    }
  }
  if (!couldStop && error === null) {
    throw new Error(
      `host did not stop within ${stopBudgetMs}ms; the temp profile stays in place (${profile.dir}) ` +
        "so a late boot cannot open the real database",
    );
  }
  return { profile, error, stopped: couldStop, restored: couldStop, homeAtStop };
}
