/**
 * Taskana 4758: the scope workspace list handler accepts only an empty strict
 * payload and returns an allow-listed projection (no raw path field).
 */
import { describe, expect, it } from "vitest";
import { handleScopeWorkspacesList, handleScopeWorkspaceResolve } from "./scope-workspaces-ipc.js";

const entry = {
  id: "ws_0123456789abcdef",
  name: "app",
  displayPath: "~/work/app",
  exists: true,
  tabIds: ["tab-1"],
  path: "/Users/x/work/app",
};

const deps = { registry: { list: async () => [entry] } };

describe("handleScopeWorkspacesList (Taskana 4758)", () => {
  it("accepts an empty object and undefined payloads", async () => {
    expect((await handleScopeWorkspacesList(deps, {})).ok).toBe(true);
    expect((await handleScopeWorkspacesList(deps, undefined)).ok).toBe(true);
  });

  it("rejects extra keys with ok:false", async () => {
    expect(await handleScopeWorkspacesList(deps, { path: "/etc" })).toEqual({ ok: false, reason: "failed" });
    expect(await handleScopeWorkspacesList(deps, "x")).toEqual({ ok: false, reason: "failed" });
  });

  it("returns only id, name, displayPath, exists and tabIds per entry", async () => {
    const result = await handleScopeWorkspacesList(deps, {});
    expect(result).toEqual({
      ok: true,
      workspaces: [{ id: entry.id, name: "app", displayPath: "~/work/app", exists: true, tabIds: ["tab-1"] }],
    });
    expect(Object.keys((result as { workspaces: object[] }).workspaces[0]!).sort()).toEqual(
      ["displayPath", "exists", "id", "name", "tabIds"],
    );
  });

  it("returns ok:false when the registry throws", async () => {
    const failing = {
      registry: {
        list: async (): Promise<never> => {
          throw new Error("boom");
        },
      },
    };
    expect(await handleScopeWorkspacesList(failing, {})).toEqual({ ok: false, reason: "failed" });
  });
});


describe("project scope resolution", () => {
  it("accepts only a reference and returns only a registry-resolved path", () => {
    const scoped = { ...deps, resolve: (ref: string) => ref === "ws_known" ? "/project" : undefined };
    expect(handleScopeWorkspaceResolve(scoped, { ref: "ws_known" })).toBe("/project");
    expect(handleScopeWorkspaceResolve(scoped, { ref: "ws_unknown" })).toBeNull();
    expect(handleScopeWorkspaceResolve(scoped, { ref: "ws_known", path: "/other" })).toBeNull();
    expect(handleScopeWorkspaceResolve(scoped, { ref: "" })).toBeNull();
  });
});
