export function openVerifiedWebSocket(options: { port: number; path: string; verifyPeer: (localPort: number) => void; requestImpl?: any; timeoutMs?: number }): Promise<any>;
