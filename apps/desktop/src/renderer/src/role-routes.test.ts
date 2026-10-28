/**
 * Role route labels: the selects in Settings → Roles and the first-run
 * "Orchestration roles" dialog list every connection by display name. A raw
 * storage id (`conn-<uuid>`) must never reach an option — 0.0.46 claimed every
 * route was labelled by provider, and unlabeled connections regressed to ids.
 */
import { describe, expect, it } from "vitest";
import { connectionRouteLabel, connectionRouteLabels } from "./role-routes.js";
import type { CatalogSummary, CustomProviderRecord, ProviderConnection } from "../../shared/settings.js";

const CATALOG: CatalogSummary = [
  { id: "z-ai", name: "Z.AI (GLM)", authKind: "api_key", models: [] },
];
const CUSTOM: readonly CustomProviderRecord[] = [
  { id: "custom:lab", name: "Lab endpoint", baseUrl: "http://localhost:1234", kind: "openai-compatible", models: [] },
];

describe("role route labels", () => {
  it("names an unlabeled connection by provider instead of its conn- id", () => {
    const connections: ProviderConnection[] = [{ id: "conn-76796d43-742b-4f0e-b08f-0ce36d93ccd9", providerId: "z-ai" }];
    const labels = connectionRouteLabels(connections, CATALOG, CUSTOM);
    expect(labels.get(connections[0]!.id)).toBe("Z.AI (GLM)");
    for (const label of labels.values()) {
      expect(label).not.toContain("conn-");
    }
  });

  it("prefixes a custom label with its provider and disambiguates equal names", () => {
    const connections: ProviderConnection[] = [
      { id: "conn-a", providerId: "z-ai", label: "Work" },
      { id: "conn-b", providerId: "z-ai", label: "Work" },
      { id: "conn-c", providerId: "custom:lab" },
    ];
    expect(connectionRouteLabels(connections, CATALOG, CUSTOM)).toEqual(
      new Map([
        ["conn-a", "Work · Z.AI (GLM)"],
        ["conn-b", "Work · Z.AI (GLM) 2"],
        ["conn-c", "Lab endpoint"],
      ]),
    );
  });

  it("numbers unlabeled same-provider connections and keeps every option readable", () => {
    const connections: ProviderConnection[] = [
      { id: "conn-1", providerId: "z-ai" },
      { id: "conn-2", providerId: "z-ai" },
    ];
    expect(connectionRouteLabels(connections, CATALOG, CUSTOM)).toEqual(
      new Map([
        ["conn-1", "Z.AI (GLM)"],
        ["conn-2", "Z.AI (GLM) 2"],
      ]),
    );
  });

  it("falls back to a readable provider id when neither the catalog nor a custom record names it", () => {
    const connection: ProviderConnection = { id: "conn-x", providerId: "unlisted" };
    expect(connectionRouteLabel(connection, CATALOG, CUSTOM, [connection])).toBe("unlisted");
  });
});
