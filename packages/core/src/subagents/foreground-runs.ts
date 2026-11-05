import { randomUUID } from "node:crypto";
import type { SubagentOutcome } from "../ports/subagent.js";
import { sanitizeStatusText, type ChildStatus } from "./status.js";

export const FOREGROUND_QUANTUM_MS = 15_000;

export type ForegroundJoin =
  | { kind: "pending_foreground"; handle: string; progress: ChildStatus | undefined }
  | { kind: "terminal"; handle: string; outcome: SubagentOutcome };

export function formatForegroundJoin(result: ForegroundJoin): string {
  if (result.kind === "terminal") return JSON.stringify(result);
  return `Foreground run is pending. Inspect progress and use Agent wait_for with this handle; do not treat it as complete. ${JSON.stringify(result)}`;
}

type Lease = {
  controller: AbortController;
  terminal: Promise<SubagentOutcome>;
  outcome?: SubagentOutcome;
  progress: () => ChildStatus | undefined;
};

/** One instance belongs to one outer turn, never to a tool invocation. */
export class ForegroundRuns {
  private readonly leases = new Map<string, Lease>();
  private closed = false;

  constructor(private readonly quantumMs = FOREGROUND_QUANTUM_MS) {
    if (!Number.isFinite(quantumMs) || quantumMs < 0) throw new RangeError("Invalid foreground quantum");
  }

  start(run: (signal: AbortSignal) => Promise<SubagentOutcome>, progress: () => ChildStatus | undefined): string {
    if (this.closed) throw new Error("Foreground turn is closed");
    const handle = randomUUID();
    const controller = new AbortController();
    const lease: Lease = { controller, progress, terminal: undefined as unknown as Promise<SubagentOutcome> };
    this.leases.set(handle, lease);
    lease.terminal = Promise.resolve().then(() => run(controller.signal)).catch((): SubagentOutcome => ({
      status: controller.signal.aborted ? "cancelled" : "error", finalText: "Child run failed.", truncated: false,
      turns: 0, toolCalls: 0, durationMs: 0,
    })).then((outcome) => { lease.outcome = outcome; return outcome; });
    return handle;
  }

  get hasLive(): boolean { return [...this.leases.values()].some((lease) => !lease.outcome); }

  /** Wait once for runs live at the seam; joins do not restart their work. */
  async checkpoint(): Promise<ForegroundJoin[]> {
    const handles = [...this.leases].filter(([, lease]) => !lease.outcome).map(([handle]) => handle);
    return Promise.all(handles.map((handle) => this.join(handle)));
  }

  async join(handle: string): Promise<ForegroundJoin> {
    const lease = this.leases.get(handle);
    if (!lease || this.closed) throw new Error("Unknown foreground run");
    if (!lease.outcome) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      try {
        await Promise.race([lease.terminal, new Promise<void>((resolve) => { timer = setTimeout(resolve, this.quantumMs); }),
          new Promise<void>((resolve) => { onAbort = () => resolve(); lease.controller.signal.addEventListener("abort", onAbort, { once: true }); })]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (onAbort) lease.controller.signal.removeEventListener("abort", onAbort);
      }
    }
    if (this.closed) throw new Error("Foreground turn is closed");
    if (lease.outcome) return { kind: "terminal", handle, outcome: lease.outcome };
    const snapshot = lease.progress();
    const progress = snapshot && {
      ...snapshot,
      description: sanitizeStatusText(snapshot.description),
      currentTool: snapshot.currentTool === undefined ? undefined : sanitizeStatusText(snapshot.currentTool, 80),
      tail: snapshot.tail.slice(-8).map((item) => ({ ...item, text: sanitizeStatusText(item.text, 160, item.kind === "assistant") })),
    };
    return { kind: "pending_foreground", handle, progress };
  }

  close(reason: unknown = "parent turn ended"): void {
    if (this.closed) return;
    this.closed = true;
    for (const lease of this.leases.values()) if (!lease.outcome) lease.controller.abort(reason);
    this.leases.clear();
  }
}
