/**
 * Human names for provider connections — pure, no React, so node-env vitest
 * pins the rule directly (`connection-name.test.ts`).
 *
 * Rule: a connection's custom `label` always wins; otherwise the provider's
 * display name (catalog, then a custom endpoint's own name, then the readable
 * provider id). A raw `conn-<uuid>` storage id is NEVER a user-facing name.
 */
import type { CatalogSummary, CustomProviderRecord, ProviderConnection } from "../../shared/settings.js";

/** `custom:<uuid>` provider ids belong to user-defined endpoints (not the catalog). */
export function isCustomProviderId(providerId: string): boolean {
  return providerId.startsWith("custom:");
}

/**
 * The provider's display name: the catalog entry's name, else the custom
 * endpoint record's name, else the readable provider id (`custom:` stripped —
 * it is a provider key, not a connection id). Never empty.
 */
export function providerDisplayName(
  connection: Pick<ProviderConnection, "providerId">,
  catalog: CatalogSummary | undefined,
  custom: readonly CustomProviderRecord[] | undefined,
): string {
  const catalogName = catalog?.find((provider) => provider.id === connection.providerId)?.name;
  if (catalogName !== undefined && catalogName.trim() !== "") {
    return catalogName;
  }
  const customName = custom?.find((provider) => provider.id === connection.providerId)?.name;
  if (customName !== undefined && customName.trim() !== "") {
    return customName;
  }
  const readable = isCustomProviderId(connection.providerId)
    ? connection.providerId.slice("custom:".length).trim()
    : connection.providerId.trim();
  return readable === "" ? "Custom provider" : readable;
}

/**
 * Auto-naming: a custom `label` always wins; otherwise the catalog/template
 * name, disambiguated with a trailing ordinal ("OpenAI", "OpenAI 2", …) among
 * UNLABELED connections of the SAME `providerId`, in their array order.
 */
export function connectionDisplayName(
  connection: ProviderConnection,
  catalogName: string,
  allConnections: readonly ProviderConnection[],
): string {
  if (connection.label) {
    return connection.label;
  }
  const sameProviderUnlabeled = allConnections.filter((c) => c.providerId === connection.providerId && !c.label);
  const index = sameProviderUnlabeled.findIndex((c) => c.id === connection.id);
  return index <= 0 ? catalogName : `${catalogName} ${index + 1}`;
}

/** Give every input its base name, appending an ordinal only where two bases collide. */
export function disambiguateNames(bases: readonly string[]): string[] {
  const assigned = new Set<string>();
  return bases.map((base) => {
    let candidate = base;
    for (let ordinal = 2; assigned.has(candidate); ordinal += 1) {
      candidate = `${base} ${ordinal}`;
    }
    assigned.add(candidate);
    return candidate;
  });
}
