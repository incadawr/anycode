/**
 * `anycode:path-roots` — the slash guard's only way to tell an absolute path
 * (`/tmp`, `/Users`) from a mistyped command (`/foo`). The handler takes no
 * renderer input and answers with entry NAMES only; every failure is an empty
 * list so the guard falls back to its conventional names.
 */
import { describe, expect, it, vi } from "vitest";
import { handlePathRoots, PATH_ROOTS_MAX_NAMES, type PathRootsDeps } from "./path-roots-ipc.js";

const deps = (names: string[] | Error, root = "/"): PathRootsDeps => ({
  root: () => root,
  readdir: async (path) => {
    if (names instanceof Error) {
      throw names;
    }
    expect(path).toBe(root);
    return names;
  },
});

describe("handlePathRoots", () => {
  it("returns the entry names under the filesystem root", async () => {
    await expect(handlePathRoots(deps(["tmp", "Users", "etc"]))).resolves.toEqual({ names: ["tmp", "Users", "etc"] });
  });

  it("lists the root main resolves, not one the renderer could name", async () => {
    const readdir = vi.fn(async () => ["tmp"]);
    await handlePathRoots({ root: () => "/somewhere", readdir });
    expect(readdir).toHaveBeenCalledWith("/somewhere");
  });

  it("drops dotfiles and empty names (hidden entries are never a typed path)", async () => {
    await expect(handlePathRoots(deps([".hidden", "tmp", "", "..", "Users"]))).resolves.toEqual({
      names: ["tmp", "Users"],
    });
  });

  it("caps a runaway listing", async () => {
    const many = Array.from({ length: PATH_ROOTS_MAX_NAMES + 50 }, (_value, index) => `d${index}`);
    const result = await handlePathRoots(deps(many));
    expect(result.names).toHaveLength(PATH_ROOTS_MAX_NAMES);
  });

  it("answers an empty list when the root cannot be read (never an error payload)", async () => {
    const error = Object.assign(new Error("denied"), { code: "EACCES" });
    await expect(handlePathRoots(deps(error))).resolves.toEqual({ names: [] });
  });
});
