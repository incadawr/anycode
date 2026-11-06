import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ProviderConnection } from "../../../shared/settings.js";
import { goQuotaRows, OpenCodeGoQuota } from "./OpenCodeGoQuota.js";

const now = Date.parse("2026-01-01T00:00:00Z");
const connection: ProviderConnection = { id: "a", providerId: "opencode", lastGoQuota: { observedAt: new Date(now).toISOString(), windows: { rolling: { usedPercent: 0, resetsAt: now / 1000 + 60 }, weekly: { usedPercent: 80 }, monthly: { usedPercent: 95 } } } };
describe("Go usage display", () => {
  it("renders ordered used percentages, reset title and warnings", () => {
    const html = renderToStaticMarkup(createElement(OpenCodeGoQuota, { connection, now }));
    expect(html.indexOf("5h · 0% used")).toBeLessThan(html.indexOf("Weekly · 80% used"));
    expect(html.indexOf("Weekly · 80% used")).toBeLessThan(html.indexOf("Monthly · 95% used"));
    expect(html).toContain("High usage"); expect(html).toContain("Nearly exhausted"); expect(html).toContain("title=\"Resets ");
  });
  it("hides expired windows and stale or future snapshots", () => {
    expect(goQuotaRows(connection, now + 60_000).map(row => row.label)).toEqual(["Weekly", "Monthly"]);
    expect(goQuotaRows(connection, now + 300_000)).toEqual([]);
    expect(goQuotaRows(connection, now - 1)).toEqual([]);
    expect(goQuotaRows({ ...connection, lastGoQuota: undefined }, now)).toEqual([]);
    expect(goQuotaRows({ ...connection, baseUrl: "https://example.com" }, now)).toEqual([]);
  });
});
