export function verifyCdpOwner(options: { listenerPids: string; browserPid: number; launcherPid: number; parentOf: (pid: number) => number | undefined }): void;
export function verifyCdpPeer(options: { records: string; browserPid: number; port: number; localPort: number }): void;
export function readCdpEndpoint(content: string): { port: number; browserPath: string };
export function connectIsolatedCdp(options: {
  profile: string;
  env: NodeJS.ProcessEnv;
  launcher: { pid?: number };
  wait: (fn: () => any) => Promise<any>;
  openSocket?: any;
  run?: any;
}): Promise<{ pid: number; ws: any; call: (method: string, params?: Record<string, unknown>) => Promise<any>; automation: (info: any, path: string, method?: string, body?: any) => Promise<any> }>;
