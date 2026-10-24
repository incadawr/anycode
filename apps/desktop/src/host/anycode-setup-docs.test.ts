/**
 * Taskana 4707 review: the anycode-setup docs resolver order. Pure: the probe
 * stands in for the filesystem, so each rung is exercised without a real tree.
 */
import { describe, expect, it } from "vitest";
import { resolveAnycodeSetupDocs } from "./anycode-setup-docs.js";

const REPO = "/Users/dev/anycode";
const REPO_README = `${REPO}/docs/user/README.md`;
const REPO_CORE = `${REPO}/packages/core/package.json`;
const PACKAGED = "/Applications/AnyCode.app/Contents/Resources";

function probe(present: readonly string[]): (path: string) => boolean {
  const set = new Set(present);
  return (path) => set.has(path);
}

describe("resolveAnycodeSetupDocs", () => {
  it("prefers the packaged app's bundled docs over everything else", () => {
    const result = resolveAnycodeSetupDocs({
      resourcesPath: PACKAGED,
      moduleDir: `${REPO}/apps/desktop/out/main`,
      appVersion: "0.0.35",
      exists: probe([`${PACKAGED}/docs/user/README.md`, REPO_README, REPO_CORE]),
    });
    expect(result).toEqual({ kind: "local", dir: `${PACKAGED}/docs/user` });
  });

  it("finds the packaged tree from the asar bundle location when process.resourcesPath is absent", () => {
    const result = resolveAnycodeSetupDocs({
      moduleDir: `${PACKAGED}/app.asar/out/main`,
      appVersion: "0.0.35",
      exists: probe([`${PACKAGED}/docs/user/README.md`]),
    });
    expect(result).toEqual({ kind: "local", dir: `${PACKAGED}/docs/user` });
  });

  it("falls to a dev checkout's own docs/user when no packaged tree exists", () => {
    const result = resolveAnycodeSetupDocs({
      resourcesPath: "/electron/dist/resources",
      moduleDir: `${REPO}/apps/desktop/out/main`,
      appVersion: "0.0.35",
      exists: probe([REPO_README, REPO_CORE]),
    });
    expect(result).toEqual({ kind: "local", dir: `${REPO}/docs/user` });
  });

  it("requires packages/core to confirm a dev checkout (a stray docs/user is not the repo)", () => {
    const result = resolveAnycodeSetupDocs({
      moduleDir: `${REPO}/apps/desktop/out/main`,
      appVersion: "0.0.35",
      exists: probe([REPO_README]),
    });
    expect(result).toEqual({ kind: "remote", ref: "v0.0.35" });
  });

  it("pins the GitHub fallback to the v-prefixed release tag", () => {
    const result = resolveAnycodeSetupDocs({
      moduleDir: "/Applications/AnyCode.app/Contents/Resources/app.asar/out/main",
      appVersion: "0.0.35",
      exists: probe([]),
    });
    expect(result).toEqual({ kind: "remote", ref: "v0.0.35" });
  });

  it("uses master when the app version is unknown or not a release number", () => {
    const base = { moduleDir: "/x/out/main", exists: probe([]) };
    expect(resolveAnycodeSetupDocs({ ...base, appVersion: undefined })).toEqual({ kind: "remote", ref: "master" });
    expect(resolveAnycodeSetupDocs({ ...base, appVersion: "" })).toEqual({ kind: "remote", ref: "master" });
    expect(resolveAnycodeSetupDocs({ ...base, appVersion: "dev" })).toEqual({ kind: "remote", ref: "master" });
  });
});
