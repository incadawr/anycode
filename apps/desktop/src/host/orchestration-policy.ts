import { PERMISSION_MODES, type PermissionMode, type RuntimeNativeBase } from "@anycode/core";

/** Engine-owned, verified state. Base authority is captured before the overlay. */
export interface OrchestrationSnapshot {
  enabled: boolean;
  /** Opaque captured value; apply must return the same reference unchanged. */
  baseAuthority: unknown;
}

export interface OrchestrationPolicy {
  nativeBase?(): RuntimeNativeBase | undefined;
  availability(): { supported: true } | { supported: false; reason: string };
  apply(enabled: boolean, baseAuthority: unknown): Promise<OrchestrationSnapshot>;
}

/** Host routing attestation, separate from engine-owned policy confirmation.
 * Native adapters supply their own preset-to-authority mapping. */
export interface RuntimeOrchestrationComposition {
  readonly ownerSessionId: string;
  ready(): boolean;
  baseMode(): PermissionMode;
  hasRunningChildren(): boolean;
  capture(mode: PermissionMode): void;
  clear(): void;
  cleanup(): void;
}

/** Raised only before the engine has changed any effective policy. */
export class OrchestrationNotReadyError extends Error {}

export type OrchestrationState =
  | { status: "off"; baseAuthority?: unknown }
  | { status: "on"; baseAuthority: unknown }
  | { status: "transitioning"; previous: OrchestrationSnapshot }
  | { status: "quarantined"; previous: OrchestrationSnapshot; reason: string };

export function orchestrationAvailability(policy?: OrchestrationPolicy): ReturnType<OrchestrationPolicy["availability"]> {
  return policy?.availability() ?? { supported: false, reason: "unavailable" };
}

/** Session owns admission; this helper never publishes an unverified transition. */
export class OrchestrationController {
  private generation = 0;
  state: OrchestrationState = { status: "off" };

  constructor(private readonly policy?: OrchestrationPolicy) {}

  async apply(enabled: boolean, baseAuthority: unknown): Promise<boolean> {
    if (!this.policy || !this.policy.availability().supported || this.state.status === "transitioning" || this.state.status === "quarantined") return false;
    const previous: OrchestrationSnapshot = {
      enabled: this.state.status === "on",
      baseAuthority: this.state.status === "on" ? this.state.baseAuthority : baseAuthority,
    };
    if (previous.enabled === enabled) return true;
    const generation = ++this.generation;
    this.state = { status: "transitioning", previous };
    try {
      const snapshot = await this.policy.apply(enabled, previous.baseAuthority);
      if (generation !== this.generation) return false;
      if (snapshot.enabled !== enabled || !Object.is(snapshot.baseAuthority, previous.baseAuthority)) throw new Error("Unconfirmed orchestration snapshot");
      this.state = enabled ? { status: "on", baseAuthority: snapshot.baseAuthority } : { status: "off", baseAuthority: snapshot.baseAuthority };
      return true;
    } catch (error) {
      if (generation === this.generation) {
        this.state = error instanceof OrchestrationNotReadyError
          ? previous.enabled ? { status: "on", baseAuthority: previous.baseAuthority } : { status: "off", baseAuthority: previous.baseAuthority }
          : { status: "quarantined", previous, reason: error instanceof Error ? error.message : String(error) };
      }
      return false;
    }
  }

  /** Invalidate an in-flight operation when its engine is disposed or replaced. */
  invalidate(): void {
    ++this.generation;
    if (this.state.status === "transitioning") this.state = { status: "quarantined", previous: this.state.previous, reason: "transition invalidated" };
  }

  /** Core can leave plan mode from inside a turn; reconcile that synchronous change. */
  coreModeExited(): void {
    if (this.state.status === "on") this.state = { status: "off", baseAuthority: this.state.baseAuthority };
  }

  quarantine(reason: string): void {
    if (this.state.status === "quarantined") return;
    const previous = this.state.status === "transitioning" ? this.state.previous
      : { enabled: this.state.status === "on", baseAuthority: this.state.baseAuthority };
    ++this.generation;
    this.state = { status: "quarantined", previous, reason };
  }
}

/** Core keeps its existing plan-mode overlay and loop-config callback. */
export function coreOrchestrationPolicy(options: {
  mode(): PermissionMode;
  setMode(mode: PermissionMode): void;
  onChanged(enabled: boolean): void;
}): OrchestrationPolicy {
  return {
    availability: () => ({ supported: true }),
    async apply(enabled, baseAuthority) {
      if (typeof baseAuthority !== "string" || !(PERMISSION_MODES as readonly string[]).includes(baseAuthority)) throw new Error("Invalid core base authority");
      options.setMode(enabled ? "plan" : baseAuthority as PermissionMode);
      if (options.mode() !== (enabled ? "plan" : baseAuthority)) throw new Error("Core mode was not applied");
      options.onChanged(enabled);
      return { enabled, baseAuthority };
    },
  };
}
