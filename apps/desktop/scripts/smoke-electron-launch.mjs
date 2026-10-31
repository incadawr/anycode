/**
 * Shared launcher for GUI smoke scripts that drive a DEVELOPMENT Electron app.
 *
 * A dev Electron started from an automation host (agent shell, CI) is not the
 * same as one started by a person at the desktop. macOS main blocks in
 * SecItemAdd until Electron receives `--use-mock-keychain`, and a windowed
 * launch can fail before creating a BrowserWindow unless `--no-sandbox` and
 * `--disable-gpu` are passed. All three switches only affect the disposable
 * profile a smoke owns, so they are the DEFAULT for every automation launch;
 * `mockKeychain: false` is the explicit opt-out for a run that must exercise
 * the real OS keychain.
 *
 * The switches reach the app binary through electron-vite: its dev command
 * stores everything after a literal `--` in `ELECTRON_CLI_ARGS` and appends it
 * to the Electron argv (`electron-vite`'s own `--noSandbox` covers only
 * `--no-sandbox` and has no keychain or GPU equivalent). `pnpm <script> -- ...`
 * forwards that literal `--`, so the argv built here survives pnpm.
 */

const PNPM_DEV = ["--filter", "@anycode/desktop", "dev"];

/**
 * Electron switches for an automation launch.
 *
 * @param {{ mockKeychain?: boolean, noSandbox?: boolean, disableGpu?: boolean, extra?: string[] }} [options]
 * @returns {string[]}
 */
export function smokeElectronSwitches(options = {}) {
  const { mockKeychain = true, noSandbox = true, disableGpu = true, extra = [] } = options;
  return [
    ...(mockKeychain ? ["--use-mock-keychain"] : []),
    ...(noSandbox ? ["--no-sandbox"] : []),
    ...(disableGpu ? ["--disable-gpu"] : []),
    ...extra,
  ];
}

/**
 * `pnpm` argv that starts the dev app with those switches. Spread it where a
 * smoke already owns the spawn options, or use `launchSmokeElectron` for the
 * whole launch.
 *
 * @param {{ mockKeychain?: boolean, noSandbox?: boolean, disableGpu?: boolean, extra?: string[] }} [options]
 * @returns {string[]}
 */
export function smokeElectronArgs(options = {}) {
  const switches = smokeElectronSwitches(options);
  return [...PNPM_DEV, ...(switches.length === 0 ? [] : ["--", ...switches])];
}

/**
 * Child environment for an automation launch.
 *
 * `REMOTE_DEBUGGING_PORT` is electron-vite's own lever: it appends
 * `--remote-debugging-port`. A stale `ELECTRON_CLI_ARGS` inherited from the
 * caller's shell would concatenate switches this helper did not build, and
 * `NO_SANDBOX=1` is the env twin of the switch it already passes. Both are
 * dropped; the caller's object is not mutated.
 *
 * @param {NodeJS.ProcessEnv} source
 * @param {{ remoteDebuggingPort?: string | number }} [options]
 * @returns {NodeJS.ProcessEnv}
 */
export function smokeElectronEnv(source, options = {}) {
  const env = { ...source };
  delete env.ELECTRON_CLI_ARGS;
  delete env.NO_SANDBOX;
  if (options.remoteDebuggingPort !== undefined) {
    env.REMOTE_DEBUGGING_PORT = String(options.remoteDebuggingPort);
  }
  return env;
}

/**
 * Spawn the dev app with the automation switches. Returns the child process
 * unchanged, so existing teardown code (`process.kill(-app.pid)`) keeps
 * working.
 *
 * @param {(...args: any[]) => any} spawn
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   remoteDebuggingPort?: string | number,
 *   electron?: { mockKeychain?: boolean, noSandbox?: boolean, disableGpu?: boolean, extra?: string[] },
 *   cwd?: string,
 *   stdio?: any,
 *   detached?: boolean,
 * }} [options]
 * @returns {any}
 */
export function launchSmokeElectron(spawn, options = {}) {
  const {
    env = process.env,
    remoteDebuggingPort,
    electron = {},
    cwd,
    stdio = ["ignore", "inherit", "inherit"],
    detached = process.platform !== "win32",
  } = options;
  return spawn("pnpm", smokeElectronArgs(electron), {
    ...(cwd === undefined ? {} : { cwd }),
    env: smokeElectronEnv(env, { remoteDebuggingPort }),
    stdio,
    detached,
  });
}
