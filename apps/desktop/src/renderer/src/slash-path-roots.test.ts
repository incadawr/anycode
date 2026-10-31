/**
 * The slash guard's root-name oracle: conventional names answer synchronously
 * (a submit-time guard cannot await), and the live listing from main is merged
 * in once so a real root-level directory the conventional list does not know
 * (`/projects`) is still treated as a path.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

/** Fresh module state per test: the cache is one-read-per-session by design. */
async function load(): Promise<typeof import("./slash-path-roots.js")> {
  vi.resetModules();
  return import("./slash-path-roots.js");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("slashPathRootNames", () => {
  it("answers the conventional root names synchronously, with no bridge present", async () => {
    const { slashPathRootNames } = await load();
    const names = slashPathRootNames();
    for (const name of ["tmp", "etc", "Users", "usr", "private"]) {
      expect(names.has(name)).toBe(true);
    }
    expect(names.has("foo")).toBe(false);
  });

  it("merges the live listing once, so an unusual top-level directory is a path too", async () => {
    const roots = vi.fn(async () => ({ names: ["projects"] }));
    vi.stubGlobal("window", { anycode: { paths: { roots } } });
    const { slashPathRootNames } = await load();

    expect(slashPathRootNames().has("projects")).toBe(false);
    await vi.waitFor(() => expect(slashPathRootNames().has("projects")).toBe(true));

    slashPathRootNames();
    slashPathRootNames();
    expect(roots).toHaveBeenCalledTimes(1);
  });

  it("keeps the conventional names when the live read fails or is empty", async () => {
    const roots = vi.fn(async () => {
      throw new Error("ipc unavailable");
    });
    vi.stubGlobal("window", { anycode: { paths: { roots } } });
    const { slashPathRootNames } = await load();

    slashPathRootNames();
    await vi.waitFor(() => expect(roots).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(slashPathRootNames().has("tmp")).toBe(true);
  });
});
