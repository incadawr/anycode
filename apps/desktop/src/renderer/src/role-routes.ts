/**
 * Route labels for the role editor's connection selects (Settings → Roles and
 * the first-run dialog). One place, pure, so node-env vitest pins it.
 *
 * A route option must never read as a raw storage id (`conn-<uuid>`): a
 * connection is shown as its custom label plus provider name ("Work · Z.AI
 * (GLM)"), or — when it has no label — as the provider's display name
 * ("Z.AI (GLM)"), with an ordinal only where two connections would otherwise
 * read identically ("Z.AI (GLM) 2").
 */
import type { CatalogSummary, CustomProviderRecord, ProviderConnection } from "../../shared/settings.js";
import { connectionDisplayName, disambiguateNames, providerDisplayName } from "./connection-name.js";

/** The label one connection gets, before collision handling. */
export function connectionRouteLabel(
  connection: ProviderConnection,
  catalog: CatalogSummary | undefined,
  custom: readonly CustomProviderRecord[] | undefined,
  allConnections: readonly ProviderConnection[],
): string {
  const providerName = providerDisplayName(connection, catalog, custom);
  return connection.label
    ? `${connection.label} · ${providerName}`
    : connectionDisplayName(connection, providerName, allConnections);
}

/**
 * Every connection's route label, keyed by connection id, in connection order.
 * Later duplicates get an ordinal, so two same-named connections stay
 * distinguishable without exposing an id.
 */
export function connectionRouteLabels(
  connections: readonly ProviderConnection[],
  catalog: CatalogSummary | undefined,
  custom: readonly CustomProviderRecord[] | undefined,
): ReadonlyMap<string, string> {
  const labels = disambiguateNames(
    connections.map((connection) => connectionRouteLabel(connection, catalog, custom, connections)),
  );
  return new Map(connections.map((connection, index) => [connection.id, labels[index]!]));
}
