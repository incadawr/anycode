export function isolatedSmokeEnv(source: NodeJS.ProcessEnv, profile: string): NodeJS.ProcessEnv;
export function launchReloadSmoke(spawn: (...args: any[]) => any, source: NodeJS.ProcessEnv, profile: string, workspace: string, port: number, unavailableEngine: string): any;
export function readGroupDom(): Array<{ expanded: boolean; header: string | null; preview: string | null; blockIds: Array<string | null> }>;

export function assertReloadSnapshot(before: { tabs: Array<{ tabId: string; sessionId: string | null; title?: string | null }> }, after: { tabs: Array<{ tabId: string; sessionId: string | null; title?: string | null }>; states: Record<string, { connection: string }> }): void;
