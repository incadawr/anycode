import { OrchestrationController } from "./orchestration-policy.js";

export type AdmissionResult =
  | { outcome: "applied"; enabled: boolean }
  | { outcome: "rejected"; reason: "unavailable" | "busy" | "stale" | "capacity" | "conflict" }
  | { outcome: "unknown"; reason: "timeout" | "disconnected" | "unconfirmed" | "admission" };

type Entry = { signature: string; promise: Promise<AdmissionResult> };

/** Session-scoped, bounded admission gate. A full ledger fails closed until session teardown. */
export class OrchestrationAdmission {
  private readonly entries = new Map<string, Entry>();
  private transition = false;
  constructor(private readonly options: {
    controller: OrchestrationController;
    connectionId(): string | null;
    busy(): boolean;
    baseAuthority(): unknown;
    timeoutMs: number;
    maxRequests?: number;
  }) {}

  toggle(requestId: string, connectionId: string, enabled: boolean): Promise<AdmissionResult> {
    return this.request(requestId, connectionId, `toggle:${enabled}`, enabled);
  }

  /** admit must synchronously claim the turn; its normal delivery ledger owns the turn afterward. */
  submit(requestId: string, connectionId: string, admit: () => void): Promise<AdmissionResult> {
    return this.request(requestId, connectionId, "submit", true, admit);
  }

  private request(id: string, connectionId: string, signature: string, enabled: boolean, admit?: () => void): Promise<AdmissionResult> {
    const existing = this.entries.get(id);
    if (existing) return existing.signature === signature ? existing.promise : Promise.resolve({ outcome: "rejected", reason: "conflict" });
    if (this.options.connectionId() !== connectionId) return Promise.resolve({ outcome: "rejected", reason: "stale" });
    if (this.entries.size >= (this.options.maxRequests ?? 256)) return Promise.resolve({ outcome: "rejected", reason: "capacity" });
    // Install the ledger entry before executing any callbacks, including synchronous re-entry.
    let resolve!: (result: AdmissionResult) => void;
    const promise = new Promise<AdmissionResult>(r => { resolve = r; });
    this.entries.set(id, { signature, promise });
    void this.execute(connectionId, enabled, admit).then(resolve, () => resolve({ outcome: "unknown", reason: "unconfirmed" }));
    return promise;
  }

  private isQuarantined(): boolean { return this.options.controller.state.status === "quarantined"; }

  private async execute(connectionId: string, enabled: boolean, admit?: () => void): Promise<AdmissionResult> {
    const { controller } = this.options;
    if (this.transition || this.options.busy()) return { outcome: "rejected", reason: "busy" };
    if (controller.state.status === "quarantined" || controller.state.status === "transitioning") return { outcome: "rejected", reason: "unavailable" };
    this.transition = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const applied = await Promise.race([
        controller.apply(enabled, this.options.baseAuthority()),
        new Promise<"timeout">(resolve => { timer = setTimeout(() => resolve("timeout"), this.options.timeoutMs); }),
      ]);
      if (applied === "timeout") {
        controller.invalidate();
        return { outcome: "unknown", reason: "timeout" };
      }
      if (this.options.connectionId() !== connectionId) return { outcome: "unknown", reason: "disconnected" };
      if (!applied) return this.isQuarantined()
        ? { outcome: "unknown", reason: "unconfirmed" }
        : { outcome: "rejected", reason: "unavailable" };
      if (admit) {
        // Busy can change during apply. Never admit a turn in that case.
        if (this.options.busy()) return { outcome: "rejected", reason: "busy" };
        try { admit(); } catch { return { outcome: "unknown", reason: "admission" }; }
        if (this.options.connectionId() !== connectionId) return { outcome: "unknown", reason: "disconnected" };
      }
      return { outcome: "applied", enabled };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      this.transition = false;
    }
  }
}
