import type { AccountBudget, AccountCatalogView, AccountSourceKey, AccountSourcesSnapshot, AccountSourceView } from "../../shared/account-sources.js";
import { AccountHttpError, fetchAccountDocument } from "./client.js";

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
export type AccountSourceRuntime = { key: AccountSourceKey; displayName: string; apiBaseUrl: string; accountId: string; connectionId: string; fetcher: Fetcher; apiKey?: string; applyCatalog: (catalog: unknown, isCurrent: () => boolean) => Promise<unknown> };
type Source = AccountSourceRuntime;
type State = { source: Source; generation: number; abort?: AbortController; inflight?: Promise<void>; view: AccountSourceView; catalog?: AccountCatalogView; lastCatalog: number; lastBudget: number; nextAttempt: number; failures: number };
const keyOf = (key: AccountSourceKey) => JSON.stringify([key.plugin, key.source]);
const BUDGET_INTERVAL = 60_000;
const CATALOG_INTERVAL = 900_000;

/** One app-level scheduler. Call replace after descriptor, key, or plugin lifecycle changes. */
export class AccountSourcesController {
  private states = new Map<string, State>();
  private timer?: ReturnType<typeof setTimeout>;
  private revision = 0;
  private disposed = false;
  constructor(private readonly changed: (snapshot: AccountSourcesSnapshot) => void, private readonly now = Date.now) {}
  snapshot(): AccountSourcesSnapshot {
    const groups = new Map<string, AccountSourceView>();
    const conflicting = new Set<string>();
    const views: AccountSourceView[] = [];
    for (const state of this.states.values()) {
      const view = structuredClone(state.view);
      if (view.budget && (this.now() - Date.parse(view.budget.observedAt) > 120_000 || view.budget.windows.some((w) => Date.parse(w.resetsAt) <= this.now()))) view.status = "stale";
      if (!view.budget) { views.push(view); continue; }
      const key = JSON.stringify([new URL(state.source.apiBaseUrl).origin, view.budget.accountId, view.budget.budgetId, view.budget.currency]);
      const existing = groups.get(key);
      if (conflicting.has(key)) continue;
      if (!existing || Date.parse(view.budget.observedAt) > Date.parse(existing.budget!.observedAt)) groups.set(key, view);
      else if (existing.budget!.observedAt === view.budget.observedAt && JSON.stringify(existing.budget) !== JSON.stringify(view.budget)) { delete existing.budget; existing.status = "unavailable"; conflicting.add(key); }
    }
    return { revision: this.revision, sources: [...views, ...groups.values()], catalogs: [...this.states.values()].flatMap((s) => s.catalog ? [structuredClone(s.catalog)] : []) };
  }
  private publish(): void { this.revision++; this.changed(this.snapshot()); }
  replace(sources: Source[]): void {
    for (const state of this.states.values()) state.abort?.abort();
    this.states.clear();
    if (this.disposed) return;
    for (const source of sources) this.states.set(keyOf(source.key), { source, generation: 0, view: { key: source.key, displayName: source.displayName, status: "loading" }, lastCatalog: -Infinity, lastBudget: -Infinity, nextAttempt: 0, failures: 0 });
    this.publish(); this.schedule(0);
  }
  async refresh(key: AccountSourceKey, force = true): Promise<void> {
    const state = this.states.get(keyOf(key));
    if (!state || this.disposed) return;
    if (state.inflight) return state.inflight;
    if (state.nextAttempt > this.now()) return;
    const generation = ++state.generation;
    const abort = new AbortController(); state.abort = abort;
    const timeout = setTimeout(() => abort.abort(), 10_000);
    const isLive = () => !this.disposed && this.states.get(keyOf(key)) === state && state.generation === generation;
    const isCurrent = () => isLive() && !abort.signal.aborted;
    const run = async () => {
      const now = this.now();
      let failed = false;
      for (const endpoint of ["catalog", "budget"] as const) {
        if (!force && now - (endpoint === "catalog" ? state.lastCatalog : state.lastBudget) < (endpoint === "catalog" ? CATALOG_INTERVAL : BUDGET_INTERVAL)) continue;
        try {
          const result = await fetchAccountDocument(state.source.fetcher, state.source.apiBaseUrl, endpoint, state.source.apiKey, abort.signal);
          if (!isCurrent()) return;
          if (result.data.accountId !== state.source.accountId) { delete state.view.budget; delete state.catalog; state.view.status = "needs_approval"; this.publish(); return; }
          if (result.kind === "catalog") { await state.source.applyCatalog(result.data, isCurrent); if (!isCurrent()) return; state.catalog = { connectionId: state.source.connectionId, models: result.data.models.map(({ id, displayName, billing, ratesMicrosPerMillionTokens }) => ({ id, ...(displayName ? { displayName } : {}), billing, ...(ratesMicrosPerMillionTokens ? { ratesMicrosPerMillionTokens } : {}) })) }; state.lastCatalog = now; this.publish(); }
          else { state.view.budget = result.data as AccountBudget; state.view.status = "ready"; state.view.fetchedAt = new Date(now).toISOString(); state.lastBudget = now; this.publish(); }
        } catch (error) {
          if (!isLive()) return;
          failed = true;
          if (abort.signal.aborted) { state.view.status = state.view.budget ? "stale" : "unavailable"; this.publish(); break; }
          if (error instanceof AccountHttpError && (error.status === 401 || error.status === 403)) { delete state.view.budget; delete state.catalog; state.view.status = error.status === 401 ? "auth_required" : "access_denied"; this.publish(); return; }
          if (endpoint === "budget") { state.view.status = state.view.budget ? "stale" : "unavailable"; this.publish(); }
          if (error instanceof AccountHttpError && error.status === 429 && error.retryAfter) {
            const seconds = Number(error.retryAfter); const date = Date.parse(error.retryAfter);
            state.nextAttempt = Math.max(state.nextAttempt, Number.isFinite(seconds) ? now + seconds * 1000 : Number.isFinite(date) ? date : 0);
          }
        }
      }
      state.failures = failed ? state.failures + 1 : 0;
      if (failed) state.nextAttempt = Math.max(state.nextAttempt, now + Math.min(300_000, 1000 * 2 ** Math.min(state.failures, 8)));
      else state.nextAttempt = 0;
    };
    state.inflight = run().finally(() => { clearTimeout(timeout); state.inflight = undefined; if (state.abort === abort) state.abort = undefined; this.schedule(BUDGET_INTERVAL); });
    return state.inflight;
  }
  private schedule(delay: number): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.disposed) return;
    this.timer = setTimeout(() => { for (const state of this.states.values()) if (state.nextAttempt <= this.now()) void this.refresh(state.source.key, false); this.schedule(1000); }, delay);
  }
  dispose(): void { this.disposed = true; if (this.timer) clearTimeout(this.timer); for (const state of this.states.values()) state.abort?.abort(); this.states.clear(); }
}
