import { AsyncLocalStorage } from "node:async_hooks";
import type { CreateSessionOutcome } from "./communication-server.js";
import { readSessionLimits, SESSION_LIMIT_RANGES } from "../shared/session-limits.js";

export const CREATE_SESSION_RATE_LIMIT = 5;
export const CREATE_SESSION_RATE_WINDOW_MS = 60_000;

export const MAX_AGENT_OPENED_TABS = SESSION_LIMIT_RANGES.agentActiveTabsMax.default;
type AdmissionTab = { sessionId: string; tabId?: string; workspace?: string; activityState?: string };
type AdmissionOptions = { limits?: unknown; describe?: (tabs: AdmissionTab[], limit: number) => Promise<string> };

/** One app-run budget shared by all creators using main's ownership set.
 * The critical section outlives any caller RPC deadline or disconnect. */
const admissions = new WeakMap<Set<string>, ReturnType<typeof createCreationAdmission>>();
export function creationAdmissionFor(owned: Set<string>, listTabs: () => ReadonlyArray<AdmissionTab>, now = Date.now) {
  let admission = admissions.get(owned);
  if (!admission) {
    admission = createCreationAdmission(owned, listTabs, now);
    admissions.set(owned, admission);
  }
  return admission;
}

function createCreationAdmission(owned: Set<string>, listTabs: () => ReadonlyArray<AdmissionTab>, now: () => number) {
  const context = new AsyncLocalStorage<{ active: boolean }>();
  let tail: Promise<unknown> = Promise.resolve();
  const times: number[] = [];
  return {
    run(task: () => Promise<CreateSessionOutcome>, options: AdmissionOptions = {}): Promise<CreateSessionOutcome> {
      if (context.getStore()?.active) return Promise.reject(new Error("Nested creation admission"));
      const result = tail.then(async (): Promise<CreateSessionOutcome> => {
        const at = now();
        while (times.length && times[0]! <= at - CREATE_SESSION_RATE_WINDOW_MS) times.shift();
        if (times.length >= CREATE_SESSION_RATE_LIMIT) return { ok: false, reason: "rate_limited" };
        const busy = listTabs().filter(t => owned.has(t.sessionId) && t.activityState !== "idle");
        const limit = readSessionLimits(typeof options.limits === "function" ? options.limits() : options.limits).agentActiveTabsMax ?? MAX_AGENT_OPENED_TABS;
        if (busy.length >= limit) {
          const detail = options.describe ? await options.describe(busy, limit) : `Active agent-opened tab limit reached (${limit}); wait for a turn to finish.`;
          return { ok: false, reason: "too_many", detail };
        }
        const scope = { active: true };
        let outcome: CreateSessionOutcome;
        try { outcome = await context.run(scope, task); }
        finally { scope.active = false; }
        if (outcome.ok) {
          times.push(now());
          owned.add(outcome.sessionId);
        }
        return outcome;
      });
      tail = result.catch(() => undefined);
      return result;
    },
  };
}

/** Trusted main-only policy, never accepted from a tool input or renderer.
 * authorize must re-read live caller facts and use session-peer-access for open. */
export type CreatorAdmissionPolicy = { kind: "external" } | {
  kind: "native";
  openerSessionId: string;
  authorize(workspace: string, canonicalKey: string, targetAllowsOpen: boolean): boolean | Promise<boolean>;
  /** Uses the shared broker's session principal and message admission. */
  deliverFirstMessage?(sessionId: string, payload: string): Promise<{ state: string; messageId?: string }>;
};

/** Called on real tab close; opener identity lasts only as long as its tab. */
export function forgetClosedAgentOpeners(openers: Map<string, string>, live: Set<string>): void {
  for (const id of openers.keys()) if (!live.has(id)) openers.delete(id);
}
