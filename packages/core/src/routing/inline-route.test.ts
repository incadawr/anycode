import { expect, it } from "vitest";
import { resolveInlineRoute } from "./inline-route.js";
import type { ConnectionTargets } from "../tools/list-connections.js";

const targets: ConnectionTargets = {
  current: { connectionId: "a", model: "one" },
  connections: [
    { id: "a", label: "Alpha", providerId: "shared", readiness: "ready", models: [{ id: "one", default: true }, { id: "two", default: false }] },
    { id: "b", label: "Beta", providerId: "shared", readiness: "ready", models: [{ id: "three", default: true }] },
  ],
};
it("returns shared resolver candidates and preserves the inline connection boundary", () => {
  expect(resolveInlineRoute(targets, "shared")).toMatchObject({ ok: false, detail: expect.stringMatching(/a.*b/) });
  expect(resolveInlineRoute(targets, "missing")).toMatchObject({ ok: false, detail: expect.stringMatching(/a.*b/) });
  expect(resolveInlineRoute(targets, undefined, "missing")).toMatchObject({ ok: false, detail: expect.stringMatching(/one.*two/) });
  expect(resolveInlineRoute(targets, "Beta")).toMatchObject({ ok: false, detail: expect.stringContaining("requires session tier") });
  expect(resolveInlineRoute(targets, "Alpha", "two")).toEqual({ ok: true, model: "two" });
  expect(resolveInlineRoute(targets, "one")).toEqual({ ok: true, model: "one" });
  expect(resolveInlineRoute(targets, "shared/one")).toMatchObject({ ok: false, detail: expect.stringContaining("more than one") });
  expect(resolveInlineRoute(targets, "Alpha", "shared/one")).toEqual({ ok: true, model: "one" });
  expect(resolveInlineRoute(targets, "Alpha", "shared/unlisted")).toMatchObject({ ok: false, detail: expect.stringContaining("one, two") });
});
