import type { CreateSessionOutcome } from "./communication-server.js";

export const CREATE_SESSION_RATE_LIMIT = 5;
export const CREATE_SESSION_RATE_WINDOW_MS = 60_000;
export const MAX_AGENT_OPENED_TABS = 8;

/** One app-run budget shared by all creators using main's ownership set.
 * The critical section outlives any caller RPC deadline or disconnect. */
const admissions = new WeakMap<Set<string>, ReturnType<typeof createCreationAdmission>>();
export function creationAdmissionFor(owned: Set<string>, listTabs: () => ReadonlyArray<{ sessionId: string }>, now = Date.now) {
  let admission = admissions.get(owned);
  if (!admission) {
    admission = createCreationAdmission(owned, listTabs, now);
    admissions.set(owned, admission);
  }
  return admission;
}

function createCreationAdmission(owned: Set<string>, listTabs: () => ReadonlyArray<{ sessionId: string }>, now: () => number) {
  let tail: Promise<unknown> = Promise.resolve();
  const times: number[] = [];
  return {
    run(task: () => Promise<CreateSessionOutcome>): Promise<CreateSessionOutcome> {
      const result = tail.then(async (): Promise<CreateSessionOutcome> => {
        const at = now();
        while (times.length && times[0]! <= at - CREATE_SESSION_RATE_WINDOW_MS) times.shift();
        if (times.length >= CREATE_SESSION_RATE_LIMIT) return { ok: false, reason: "rate_limited" };
        const live = new Set(listTabs().map(t => t.sessionId));
        if ([...owned].filter(id => live.has(id)).length >= MAX_AGENT_OPENED_TABS) return { ok: false, reason: "too_many" };
        const outcome = await task();
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
  authorize(workspace: string, canonicalKey: string, targetAllowsOpen: boolean): boolean;
  /** Uses the shared broker's session principal and message admission. */
  deliverFirstMessage?(sessionId: string, payload: string): Promise<{ state: string; messageId?: string }>;
};
