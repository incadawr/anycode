/** Value-only account source IPC contract. Amounts are decimal micro-USD strings. */
export const ACCOUNT_SOURCES_GET_CHANNEL = "anycode:account-sources-get";
export const ACCOUNT_SOURCES_REFRESH_CHANNEL = "anycode:account-sources-refresh";
export const ACCOUNT_SOURCES_BIND_CHANNEL = "anycode:account-sources-bind";
export const ACCOUNT_SOURCES_UNBIND_CHANNEL = "anycode:account-sources-unbind";
export const ACCOUNT_SOURCES_CHANGED_CHANNEL = "anycode:account-sources-changed";
export const ACCOUNT_SOURCES_CATALOG_CHANGED_CHANNEL = "anycode:account-sources-catalog-changed";
export const ACCOUNT_SOURCES_PREVIEW_CHANNEL = "anycode:account-sources-preview";
export const ACCOUNT_SOURCES_RESET_CHANNEL = "anycode:account-sources-reset";

export interface AccountSourceKey { plugin: string; source: string }
export interface AccountBudgetWindow {
  kind: "day" | "month";
  limit: string;
  spent: string;
  remaining: string;
  reserved?: string;
  resetsAt: string;
}
export interface AccountBudget {
  accountId: string;
  budgetId: string;
  currency: "USD";
  scale: 6;
  observedAt: string;
  windows: AccountBudgetWindow[];
}
export type AccountSourceStatus = "needs_connection" | "needs_approval" | "loading" | "ready" | "stale" | "auth_required" | "access_denied" | "unavailable";
export interface AccountSourceView {
  key: AccountSourceKey;
  displayName: string;
  status: AccountSourceStatus;
  budget?: AccountBudget;
  fetchedAt?: string;
}
export interface AccountCatalogView { connectionId: string; models: { id: string; displayName?: string; billing: "free" | "metered"; ratesMicrosPerMillionTokens?: { input: string; output: string; cachedInput?: string; cacheWrite?: string } }[] }
export interface AccountSourcesSnapshot { revision: number; sources: AccountSourceView[]; catalogs?: AccountCatalogView[] }
export interface AccountSourceCandidateView {
  key: AccountSourceKey;
  displayName: string;
  gatewayName: string;
  gatewayBaseUrl: string;
  gatewayKind: "openai-compatible" | "openai" | "anthropic";
  apiBaseUrl: string;
}
export type AccountSourcePreviewResult = { ok: true; token: string; models: { id: string; displayName?: string; billing: "free" | "metered"; ratesMicrosPerMillionTokens?: { input: string; output: string; cachedInput?: string; cacheWrite?: string } }[] } | { ok: false; reason: string };
