import type { AgentEvent } from "@anycode/core";

/** Queues a native turn while the session is admitting it. */
export class NativeTurn implements AsyncIterable<AgentEvent> {
  private readonly queue: AgentEvent[] = [];
  private waiter: (() => void) | undefined;
  private done = false;
  constructor(readonly cancel: () => void) {}
  push(event: AgentEvent): void { if (!this.done) { this.queue.push(event); this.waiter?.(); this.waiter = undefined; } }
  close(): void { this.done = true; this.waiter?.(); this.waiter = undefined; }
  async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    for (;;) {
      const event = this.queue.shift();
      if (event) { yield event; continue; }
      if (this.done) return;
      await new Promise<void>(resolve => { this.waiter = resolve; });
    }
  }
}
