/**
 * The Codex support policy exists in TWO places that must never disagree:
 * `codex-support.json` at the repo root (served raw from `master`, so editing
 * it changes policy without a release) and `BUNDLED_CODEX_MANIFEST` (compiled
 * into the binary as the fail-closed fallback). A release that ships a bundled
 * fallback narrower or wider than the published JSON hands two different
 * verdicts to the same Codex version depending on whether the network is up.
 *
 * Nothing else in the tree reads the JSON, so without this test the two copies
 * drift silently.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { BUNDLED_CODEX_MANIFEST, type CodexSupportManifest } from "./codex-support.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const MANIFEST_PATH = resolve(REPO_ROOT, "codex-support.json");

describe("codex-support.json vs BUNDLED_CODEX_MANIFEST", () => {
  it("the published manifest and the compiled fallback are identical", () => {
    const published = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as CodexSupportManifest;
    expect(published).toEqual(BUNDLED_CODEX_MANIFEST);
  });
});
