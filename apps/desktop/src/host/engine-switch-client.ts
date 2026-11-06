import { ENGINE_SWITCH_CONTROL, ENGINE_SWITCH_RESPONSE, type EngineSwitchControl, type EngineSwitchIdentity, type EngineSwitchResponse } from "../shared/engine-switch-control.js";

/** A separate, generation-correlated RPC namespace on the authenticated host channel. */
export function createEngineSwitchClient(generation: number, send: (message: EngineSwitchControl) => void, timeoutMs = 20000) {
  const pending = new Map<string, { resolve(value: EngineSwitchResponse): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const key = (id: string, phase: string) => `${id}:${phase}`;
  return {
    handle(raw: unknown): boolean {
      const message = raw as EngineSwitchResponse | undefined;
      if (message?.type !== ENGINE_SWITCH_RESPONSE) return false;
      if (message.generation !== generation) return true;
      const id = key(message.requestId, message.phase);
      const waiter = pending.get(id);
      if (waiter) { clearTimeout(waiter.timer); pending.delete(id); waiter.resolve(message); }
      return true;
    },
    request(message: Omit<Extract<EngineSwitchControl, { phase: "prepare" }>, "generation" | "type"> | Omit<Extract<EngineSwitchControl, { phase: "commit" }>, "generation" | "type"> | { requestId: string; phase: "abort" | "retire" | "status" }): Promise<EngineSwitchResponse> {
      const id = key(message.requestId, message.phase);
      if (pending.has(id)) return Promise.reject(new Error("duplicate engine switch RPC"));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error("Engine switch response timed out")); }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try { send({ ...message, type: ENGINE_SWITCH_CONTROL, generation } as EngineSwitchControl); }
        catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
      });
    },
    close() { for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error("host is shutting down")); } pending.clear(); },
  };
}

/** Reconcile a lost commit acknowledgement before allowing either runtime to serve. */
export async function commitEngineSwitch(client: ReturnType<typeof createEngineSwitchClient>, requestId: string, identity: EngineSwitchIdentity, onUnknown: () => never): Promise<void> {
  let result: EngineSwitchResponse;
  try { result = await client.request({ phase: "commit", requestId, identity }); }
  catch {
    try { result = await client.request({ phase: "status", requestId }); }
    catch {
      // Main reaps both process groups and resumes the durable identity after host exit.
      return onUnknown();
    }
  }
  if (!result.ok) throw new Error(result.reason ?? "Engine identity commit failed");
}
