/** Wire validation for account sources. Monetary amounts stay exact decimal strings. */
import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "./state.js";
import type { accountSourceSchema } from "./manifest.js";

export type AccountSource = z.output<typeof accountSourceSchema>;

/** The visible label is not an authorization boundary. */
export function accountSourceHash(source: AccountSource): string {
  return createHash("sha256").update(canonicalJson({
    id: source.id,
    protocol: source.protocol,
    gateway: { baseUrl: source.gateway.baseUrl, kind: source.gateway.kind },
    apiBaseUrl: source.apiBaseUrl,
  })).digest("hex");
}

const id = z.string().min(1).max(256);
const amount = z.string().regex(/^(0|[1-9][0-9]{0,29})$/);
const timestamp = z.iso.datetime({ offset: true });
const rates = z.object({ input: amount, cachedInput: amount.optional(), output: amount, cacheWrite: amount.optional() });
const model = z.object({
  id,
  displayName: z.string().min(1).max(256).optional(),
  billing: z.enum(["free", "metered"]),
  ratesMicrosPerMillionTokens: rates.optional(),
  capabilities: z.object({ contextWindowTokens: z.number().int().positive().max(100_000_000).optional(), reasoning: z.boolean().optional(), effortLevels: z.array(z.enum(["off", "low", "medium", "high", "xhigh", "max"])).max(6).optional(), imageInput: z.literal(true).optional() }).optional(),
});

export const accountCatalogSchema = z.object({
  schemaVersion: z.literal("anycode.account-catalog.v1"),
  accountId: id,
  revision: z.string().min(1).max(256),
  complete: z.literal(true),
  models: z.array(model).max(500),
}).superRefine((catalog, ctx) => {
  const seen = new Set<string>();
  for (const entry of catalog.models) {
    if (seen.has(entry.id)) {
      ctx.addIssue({ code: "custom", message: "duplicate model id" });
      return;
    }
    seen.add(entry.id);
  }
});

const windowSchema = z.object({
  kind: z.enum(["day", "month"]),
  limit: amount,
  spent: amount,
  remaining: amount,
  reserved: amount.optional(),
  resetsAt: timestamp,
});
export const accountBudgetSchema = z.object({
  schemaVersion: z.literal("anycode.account-budget.v1"),
  accountId: id,
  budgetId: id,
  currency: z.literal("USD"),
  scale: z.literal(6),
  observedAt: timestamp,
  windows: z.array(windowSchema).max(2),
}).superRefine((budget, ctx) => {
  if (new Set(budget.windows.map((window) => window.kind)).size !== budget.windows.length) {
    ctx.addIssue({ code: "custom", message: "duplicate budget window" });
  }
});
