import { afterEach, expect, it, vi } from "vitest";
import { AccountSourcesController, type AccountSourceRuntime } from "./controller.js";

const catalog = { schemaVersion: "anycode.account-catalog.v1", accountId: "a", revision: "1", complete: true, models: [] };
const budget = { schemaVersion: "anycode.account-budget.v1", accountId: "a", budgetId: "budget", currency: "USD", scale: 6, observedAt: "2026-10-31T12:00:00Z", windows: [] };
function source(fetcher: AccountSourceRuntime["fetcher"]): AccountSourceRuntime { return { key: { plugin: "p", source: "s" }, displayName: "Company", apiBaseUrl: "https://gateway.example.com/", accountId: "a", connectionId: "conn", fetcher, applyCatalog: vi.fn() }; }
afterEach(() => vi.useRealTimers());
it("coalesces refresh and ignores a late response after replacement", async () => {
  vi.useFakeTimers();
  let resolve!: (response: Response) => void;
  const fetcher = vi.fn(() => new Promise<Response>((r) => { resolve = r; }));
  const controller = new AccountSourcesController(vi.fn());
  controller.replace([source(fetcher)]);
  const first = controller.refresh({ plugin: "p", source: "s" });
  const second = controller.refresh({ plugin: "p", source: "s" });
  expect(fetcher).toHaveBeenCalledTimes(1);
  controller.replace([]);
  resolve(new Response(JSON.stringify(catalog)));
  await Promise.all([first, second]);
  expect(controller.snapshot().sources).toEqual([]);
  controller.dispose();
});
it("clears an earlier budget on authentication failure", async () => {
  vi.useFakeTimers();
  let fail = false;
  const fetcher = vi.fn(async (url: string) => fail ? new Response(null, { status: 401 }) : new Response(JSON.stringify(url.endsWith("catalog") ? catalog : budget)));
  const controller = new AccountSourcesController(vi.fn(), () => Date.parse("2026-10-31T12:00:00Z"));
  controller.replace([source(fetcher)]);
  await controller.refresh({ plugin: "p", source: "s" });
  expect(controller.snapshot().sources[0]?.budget?.budgetId).toBe("budget");
  fail = true;
  await controller.refresh({ plugin: "p", source: "s" });
  expect(controller.snapshot().sources[0]).toMatchObject({ status: "auth_required" });
  expect(controller.snapshot().sources[0]?.budget).toBeUndefined();
  controller.dispose();
});
