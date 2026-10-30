export interface SmokeElectronSwitchOptions {
  mockKeychain?: boolean;
  noSandbox?: boolean;
  disableGpu?: boolean;
  extra?: string[];
}

export interface SmokeElectronLaunchOptions {
  env?: NodeJS.ProcessEnv;
  remoteDebuggingPort?: string | number;
  electron?: SmokeElectronSwitchOptions;
  cwd?: string;
  stdio?: unknown;
  detached?: boolean;
}

export function smokeElectronSwitches(options?: SmokeElectronSwitchOptions): string[];
export function smokeElectronArgs(options?: SmokeElectronSwitchOptions): string[];
export function smokeElectronEnv(
  source: NodeJS.ProcessEnv,
  options?: { remoteDebuggingPort?: string | number },
): NodeJS.ProcessEnv;
export function launchSmokeElectron(spawn: (...args: any[]) => any, options?: SmokeElectronLaunchOptions): any;
