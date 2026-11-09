import type { AgentEvent } from "@anycode/core";
import type { SessionNetworkWait } from "../shared/communication.js";

const safeCodes = new Set(["proxy_unreachable", "proxy_auth", "tls", "connect_timeout", "network", "rate_limited", "auth", "forbidden", "server", "quota", "input_limit", "unknown"]);

export class NetworkWaitState {
  private readonly waits = new Map<string, SessionNetworkWait>();
  private readonly ended = new Set<string>();

  observe(event: AgentEvent): boolean {
    if (event.type === "waiting_for_network") {
      const id = event.waitId ?? "";
      if (this.waits.has(id) || this.ended.has(id)) return false;
      this.waits.set(id, {
        source: event.waitSource ?? "parent",
        ...(event.startedAt !== undefined ? { startedAt: event.startedAt } : {}),
        ...(event.deadlineAt !== undefined ? { deadlineAt: event.deadlineAt } : {}),
        ...(event.failureCode && safeCodes.has(event.failureCode) ? { failureCode: event.failureCode } : {}),
      });
      return true;
    }
    if (event.type === "network_wait_end") {
      if (!this.waits.delete(event.waitId)) return false;
      this.ended.add(event.waitId);
      return true;
    }
    if (event.type === "loop_end" && this.waits.size > 0) { this.clear(); return true; }
    return false;
  }

  clear(): void { this.waits.clear(); this.ended.clear(); }
  get summary(): SessionNetworkWait | undefined {
    return [...this.waits.values()].sort((a, b) => (a.startedAt ?? Infinity) - (b.startedAt ?? Infinity))[0];
  }
}
