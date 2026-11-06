import { engineSwitchControlSchema, ENGINE_SWITCH_RESPONSE, type EngineSwitchControl, type EngineSwitchIdentity, type EngineSwitchLaunch, type EngineSwitchResponse } from "../shared/engine-switch-control.js";
import type { EngineSwitchTarget } from "../shared/protocol.js";

interface PreparedLaunch { launch: EngineSwitchLaunch; release?: () => void }
interface Lease { requestId: string; target: EngineSwitchTarget; state: "preparing" | "prepared" | "committed"; release?: () => void }
export interface EngineSwitchCoordinatorDeps {
  generation: number;
  current(): boolean;
  admissible(): boolean;
  prepare(target: EngineSwitchTarget): Promise<PreparedLaunch>;
  /** Synchronous durable transaction + mirror: no interleaving with host death. */
  commit(target: EngineSwitchTarget, identity: EngineSwitchIdentity, requestId: string): void;
  abort(requestId: string): void;
  retire(requestId: string): void;
  send(response: EngineSwitchResponse): void;
}

/** One admission lease spans target resolution, native preparation and commit. */
export class EngineSwitchCoordinator {
  private lease?: Lease;
  private readonly seen = new Set<string>();
  constructor(private readonly deps: EngineSwitchCoordinatorDeps) {}
  get pending() { return this.lease !== undefined; }
  acceptsCandidate(id: string) { return this.deps.current() && this.lease?.requestId === id && this.lease.state === "prepared"; }
  close(reap = true): void {
    const lease = this.lease;
    this.lease = undefined;
    lease?.release?.();
    if (reap && lease && lease.state !== "committed") this.deps.abort(lease.requestId);
  }
  async handle(raw: unknown): Promise<void> {
    const parsed = engineSwitchControlSchema.safeParse(raw);
    if (!parsed.success) return;
    const message = parsed.data;
    if (!this.deps.current()) return;
    const reply = (ok: boolean, reason?: string, launch?: EngineSwitchLaunch) => {
      try {
        this.deps.send({ type: ENGINE_SWITCH_RESPONSE, requestId: message.requestId, generation: this.deps.generation,
          phase: message.phase, ok, ...(reason ? { reason } : {}), ...(launch ? { launch } : {}) });
      } catch { /* A transport failure cannot change the durable transaction outcome. */ }
    };
    if (message.generation !== this.deps.generation) return reply(false, "stale host generation");
    if (message.phase === "prepare") {
      if (this.lease?.requestId === message.requestId || this.seen.has(message.requestId)) return reply(false, "duplicate request");
      this.seen.add(message.requestId);
      if (this.seen.size > 1024) {
        const oldest = this.seen.values().next().value;
        if (oldest !== undefined) this.seen.delete(oldest);
      }
      if (this.lease || !this.deps.admissible()) return reply(false, "session is busy or children are running");
      const lease: Lease = { requestId: message.requestId, target: message.target, state: "preparing" };
      this.lease = lease;
      try {
        const prepared = await this.deps.prepare(message.target);
        if (this.lease !== lease || !this.deps.current() || !this.deps.admissible()) {
          prepared.release?.();
          throw new Error("session changed during preparation");
        }
        if (prepared.launch.target.engine !== lease.target.engine || prepared.launch.target.model !== lease.target.model) { prepared.release?.(); throw new Error("Target changed"); }
        lease.target = prepared.launch.target;
        lease.release = prepared.release;
        lease.state = "prepared";
        reply(true, undefined, prepared.launch);
      } catch {
        if (this.lease === lease) this.close();
        if (this.deps.current()) reply(false, "target is unavailable");
      }
      return;
    }
    const lease = this.lease;
    if (!lease || lease.requestId !== message.requestId) return reply(false, "stale switch request");
    if (message.phase === "status") return reply(lease.state === "committed", lease.state);
    if (message.phase === "abort") {
      if (lease.state === "committed") return reply(false, "switch already committed");
      this.close();
      return reply(true);
    }
    if (message.phase === "retire") {
      if (lease.state !== "committed") return reply(false, "switch is not committed");
      this.deps.retire(lease.requestId);
      this.close();
      return reply(true);
    }
    if (lease.state !== "prepared" || !this.deps.admissible()) return reply(false, "switch is not prepared");
    if (message.identity.model !== lease.target.model || (lease.target.engine !== "core" && !message.identity.externalSessionRef)) return reply(false, "invalid target identity");
    if (message.identity.runtime && message.identity.runtime.segment.id !== message.requestId) return reply(false,"invalid runtime transaction");
    try {
      this.deps.commit(lease.target, message.identity, lease.requestId);
      lease.state = "committed";
      reply(true);
    } catch {
      this.close();
      reply(false, "could not commit engine identity");
    }
  }
}
