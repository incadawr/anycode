/**
 * Unit tests for the refactored release gate `scripts/check-codex-manifest.mjs`.
 *
 * The whole point of the §2.1 refactor is that the comparator and the
 * exit-code mapping became testable WITHOUT network: `run()` accepts an
 * injected versions list, so the npm registry is never touched here (the live
 * `--dry-run` verification is done by hand, outside `pnpm test`).
 *
 * The real repo-root `codex-support.json` is used for `readManifest` and the
 * `run()` mapping — same resolution as the drift test, so the tests follow the
 * shipped policy instead of a fixture that could silently disagree with it.
 */
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const { satisfies, newestStableFromVersions, readManifest, run, parseVersion } = await import(
  "../scripts/check-codex-manifest.mjs"
);

describe("satisfies", () => {
  it("0.162.0 is inside the declared range >=0.144.0 <0.163.0", () => {
    expect(satisfies([0, 162, 0], ">=0.144.0 <0.163.0")).toBe(true);
  });

  it("0.163.0 and 0.164.0 fall outside the upper bound", () => {
    expect(satisfies([0, 163, 0], ">=0.144.0 <0.163.0")).toBe(false);
    expect(satisfies([0, 164, 0], ">=0.144.0 <0.163.0")).toBe(false);
  });

  it("an exact = bound matches only that version", () => {
    expect(satisfies([0, 162, 0], "=0.162.0")).toBe(true);
    expect(satisfies([0, 162, 1], "=0.162.0")).toBe(false);
  });

  it("a malformed range is never satisfied", () => {
    expect(satisfies([0, 162, 0], ">=x.y.z")).toBe(false);
  });
});

describe("newestStableFromVersions", () => {
  it("picks the newest stable entry, dropping prerelease-suffixed ones", () => {
    const result = newestStableFromVersions([
      "0.144.3",
      "0.162.0",
      "0.163.0",
      "0.164.0",
      "0.164.0-darwin-arm64",
    ]);
    expect(result).toEqual({ ok: true, latest: [0, 164, 0] });
  });

  it("an empty list is exit 2, not exit 0", () => {
    expect(newestStableFromVersions([])).toMatchObject({ ok: false, exit: 2 });
  });

  it("a list with no stable entry at all is exit 2", () => {
    const result = newestStableFromVersions(["0.164.0-darwin-arm64", "1.0.0-beta.1"]);
    expect(result).toMatchObject({ ok: false, exit: 2 });
  });
});

describe("readManifest", () => {
  it("reads the real repo-root codex-support.json", () => {
    const result = readManifest(REPO_ROOT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Array.isArray(result.manifest.supported)).toBe(true);
    expect(result.manifest.supported.length).toBeGreaterThan(0);
  });
});

describe("run() exit-code mapping (no network)", () => {
  it("a covered newest stable exits 0 with the OK line", () => {
    const result = run({ versions: ["0.162.0"] });
    expect(result.exit).toBe(0);
    expect(result.stdout.join("\n")).toContain("OK — the newest stable Codex is inside the declared range.");
  });

  it("a stale newest stable exits 1 and names both copies to update", () => {
    // Must sit above the REAL repo-root manifest's ceiling (currently <0.165.0).
    const result = run({ versions: ["9.0.0"] });
    expect(result.exit).toBe(1);
    const stderr = result.stderr.join("\n");
    expect(stderr).toContain("codex-support.json");
    expect(stderr).toContain("BUNDLED_CODEX_MANIFEST");
  });

  it("a failed collection (null versions) exits 2 without a verdict", () => {
    const result = run({ versions: null });
    expect(result.exit).toBe(2);
    expect(result.stderr.join("\n")).not.toContain("STALE");
  });
});

describe("parseVersion (kept as is)", () => {
  it("accepts x.y.z and rejects anything else", () => {
    expect(parseVersion("0.162.0")).toEqual([0, 162, 0]);
    expect(parseVersion("0.164.0-darwin-arm64")).toBeNull();
    expect(parseVersion("beta")).toBeNull();
  });
});
