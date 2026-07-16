import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { BUNDLED_CODEX_MANIFEST, CODEX_MIN_FLOOR, type CodexSupportManifest } from "../shared/codex-support.js";
import {
  activeCodexVersionPolicy,
  codexVersionVerdict,
  effectiveCodexManifest,
  manifestSupportedRange,
  refreshCodexManifest,
  resetActiveCodexVersionPolicy,
  setActiveCodexVersionPolicy,
  validateCodexManifest,
} from "./codex-manifest.js";

const scratchDir = mkdtempSync(join(tmpdir(), "anycode-codex-manifest-test-"));
afterAll(() => rmSync(scratchDir, { recursive: true, force: true }));
afterEach(() => resetActiveCodexVersionPolicy());

/** A syntactically valid manifest the tests mutate per-case. */
function validManifest(overrides: Partial<CodexSupportManifest> = {}): CodexSupportManifest {
  return {
    schemaVersion: "anycode.codex-support.v1",
    updatedAt: "2026-07-16T00:00:00Z",
    supported: [{ range: ">=0.144.0 <0.146.0", status: "tested" }],
    recommended: "0.145.1",
    minimum: "0.144.0",
    ...overrides,
  };
}

describe("validateCodexManifest (fail-closed, cut §7.1)", () => {
  it("accepts a well-formed manifest", () => {
    expect(validateCodexManifest(validManifest())).toEqual(validManifest());
  });

  it("rejects non-objects, wrong schemaVersion, and structural garbage", () => {
    for (const garbage of [
      null,
      undefined,
      42,
      "manifest",
      [],
      {},
      validManifest({ schemaVersion: "anycode.codex-support.v2" as never }),
      { ...validManifest(), supported: "yes" },
      { ...validManifest(), supported: [] },
      { ...validManifest(), supported: [{ range: 42, status: "tested" }] },
      { ...validManifest(), recommended: 145 },
      { ...validManifest(), minimum: undefined },
    ]) {
      expect(validateCodexManifest(garbage)).toBeNull();
    }
  });

  it("rejects a manifest whose declared minimum is below the compile-time floor (downgrade attack)", () => {
    expect(validateCodexManifest(validManifest({ minimum: "0.100.0" }))).toBeNull();
  });

  it("rejects a manifest with an unparsable range expression", () => {
    expect(validateCodexManifest(validManifest({ supported: [{ range: "banana", status: "tested" }] }))).toBeNull();
    expect(validateCodexManifest(validManifest({ supported: [{ range: ">=0.144", status: "tested" }] }))).toBeNull();
  });
});

describe("effectiveCodexManifest", () => {
  it("returns the validated manifest when it passes", () => {
    expect(effectiveCodexManifest(validManifest())).toEqual(validManifest());
  });

  it("falls back to BUNDLED on any invalid input — network garbage never widens the range (red-proof)", () => {
    // The forged manifest claims a huge range; if validation were skipped the
    // verdict below would flip to allowed — that flip is the red this test
    // exists to catch.
    const forged = { ...validManifest({ supported: [{ range: ">=0.1.0 <99.0.0", status: "tested" }], minimum: "0.1.0" }) };
    const effective = effectiveCodexManifest(forged);
    expect(effective).toEqual(BUNDLED_CODEX_MANIFEST);
    const verdict = codexVersionVerdict("0.999.0", { manifest: effective, riskAcceptedVersions: [] });
    expect(verdict.allowed).toBe(false);
  });
});

describe("codexVersionVerdict", () => {
  const policy = (manifest: CodexSupportManifest, riskAcceptedVersions: string[] = []) => ({ manifest, riskAcceptedVersions });

  it("allows a version inside a supported range, without risk", () => {
    const verdict = codexVersionVerdict("0.144.3", policy(validManifest()));
    expect(verdict).toEqual({ allowed: true, risk: false, supportedRange: ">=0.144.0 <0.146.0" });
  });

  it("evaluates multiple ranges as a union and joins them for display", () => {
    const manifest = validManifest({
      supported: [
        { range: ">=0.144.0 <0.145.0", status: "tested" },
        { range: ">=0.146.0 <0.147.0", status: "tested" },
      ],
    });
    expect(codexVersionVerdict("0.146.2", policy(manifest)).allowed).toBe(true);
    expect(codexVersionVerdict("0.145.1", policy(manifest)).allowed).toBe(false);
    expect(codexVersionVerdict("0.144.1", policy(manifest)).supportedRange).toBe(">=0.144.0 <0.145.0 || >=0.146.0 <0.147.0");
  });

  it("rejects a version outside every range when it is not risk-accepted", () => {
    const verdict = codexVersionVerdict("0.150.0", policy(validManifest()));
    expect(verdict.allowed).toBe(false);
    expect(verdict.risk).toBe(false);
  });

  it("allows an out-of-range version the user explicitly risk-accepted (§7.4), flagged as risk", () => {
    const verdict = codexVersionVerdict("0.150.0", policy(validManifest(), ["0.150.0"]));
    expect(verdict).toEqual({ allowed: true, risk: true, supportedRange: ">=0.144.0 <0.146.0" });
  });

  it("risk acceptance is PER-VERSION, not blanket", () => {
    expect(codexVersionVerdict("0.150.1", policy(validManifest(), ["0.150.0"])).allowed).toBe(false);
  });

  it(`rejects a version below the compile-time floor ${CODEX_MIN_FLOOR} ALWAYS — even when a manifest range admits it AND it is risk-accepted (red-proof)`, () => {
    // Bypasses validateCodexManifest on purpose: the floor must hold at the
    // VERDICT layer on its own, so removing either layer alone stays red.
    const belowFloorManifest = validManifest({ supported: [{ range: ">=0.100.0 <99.0.0", status: "forged" }], minimum: "0.100.0" });
    const verdict = codexVersionVerdict("0.100.5", { manifest: belowFloorManifest, riskAcceptedVersions: ["0.100.5"] });
    expect(verdict.allowed).toBe(false);
  });

  it("rejects an unparsable version string", () => {
    expect(codexVersionVerdict("banana", policy(validManifest())).allowed).toBe(false);
    expect(codexVersionVerdict("", policy(validManifest())).allowed).toBe(false);
  });
});

describe("manifestSupportedRange", () => {
  it("renders a single range verbatim and multiple ranges joined with ||", () => {
    expect(manifestSupportedRange(BUNDLED_CODEX_MANIFEST)).toBe(">=0.144.0 <0.145.0");
  });
});

describe("active version policy (module seam the doctor defaults from)", () => {
  it("defaults to BUNDLED manifest with no risk acceptances", () => {
    expect(activeCodexVersionPolicy()).toEqual({ manifest: BUNDLED_CODEX_MANIFEST, riskAcceptedVersions: [] });
  });

  it("patches partially and resets fully", () => {
    setActiveCodexVersionPolicy({ riskAcceptedVersions: ["0.150.0"] });
    expect(activeCodexVersionPolicy().riskAcceptedVersions).toEqual(["0.150.0"]);
    expect(activeCodexVersionPolicy().manifest).toEqual(BUNDLED_CODEX_MANIFEST);
    resetActiveCodexVersionPolicy();
    expect(activeCodexVersionPolicy()).toEqual({ manifest: BUNDLED_CODEX_MANIFEST, riskAcceptedVersions: [] });
  });
});

describe("refreshCodexManifest (network + ETag cache, cut §7.1)", () => {
  const T0 = Date.parse("2026-07-16T12:00:00Z");

  function fetchReturning(status: number, body?: string, headers: Record<string, string> = {}) {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), headers: (init?.headers as Record<string, string> | undefined) ?? {} });
      return new Response(status === 304 ? null : (body ?? ""), { status, headers });
    }) as typeof fetch;
    return { calls, fetchImpl };
  }

  it("caches a valid network manifest with its ETag and returns it as source network", async () => {
    const cacheFile = join(scratchDir, "manifest-ok.json");
    const { calls, fetchImpl } = fetchReturning(200, JSON.stringify(validManifest()), { etag: '"abc123"' });
    const result = await refreshCodexManifest({ cacheFile, fetchImpl, now: () => T0 });
    expect(result.source).toBe("network");
    expect(result.manifest).toEqual(validManifest());
    expect(calls).toHaveLength(1);
    const cached = JSON.parse(readFileSync(cacheFile, "utf8")) as { etag?: string; manifest: unknown };
    expect(cached.etag).toBe('"abc123"');
    expect(cached.manifest).toEqual(validManifest());
  });

  it("throttles to the 6h window: a fresh cache short-circuits without any network call", async () => {
    const cacheFile = join(scratchDir, "manifest-fresh.json");
    writeFileSync(cacheFile, JSON.stringify({ fetchedAt: new Date(T0).toISOString(), etag: '"e"', manifest: validManifest() }));
    const { calls, fetchImpl } = fetchReturning(200, JSON.stringify(validManifest({ recommended: "0.145.9" })));
    const result = await refreshCodexManifest({ cacheFile, fetchImpl, now: () => T0 + 60_000 });
    expect(result.source).toBe("cache");
    expect(result.manifest).toEqual(validManifest());
    expect(calls).toHaveLength(0);
  });

  it("bypasses the throttle with force and sends If-None-Match; a 304 keeps the cached manifest", async () => {
    const cacheFile = join(scratchDir, "manifest-304.json");
    writeFileSync(cacheFile, JSON.stringify({ fetchedAt: new Date(T0 - 7 * 3600_000).toISOString(), etag: '"e304"', manifest: validManifest() }));
    const { calls, fetchImpl } = fetchReturning(304);
    const result = await refreshCodexManifest({ cacheFile, fetchImpl, now: () => T0, force: true });
    expect(result.source).toBe("cache");
    expect(result.manifest).toEqual(validManifest());
    expect(calls[0]?.headers["if-none-match"]).toBe('"e304"');
  });

  it("falls back to BUNDLED on non-200, on unparsable JSON, and on a validation failure — never throws", async () => {
    for (const { status, body } of [
      { status: 500, body: "oops" },
      { status: 200, body: "{not json" },
      { status: 200, body: JSON.stringify(validManifest({ minimum: "0.1.0" })) },
    ]) {
      const cacheFile = join(scratchDir, `manifest-bad-${status}-${body.length}.json`);
      const { fetchImpl } = fetchReturning(status, body);
      const result = await refreshCodexManifest({ cacheFile, fetchImpl, now: () => T0 });
      expect(result.source).toBe("bundled");
      expect(result.manifest).toEqual(BUNDLED_CODEX_MANIFEST);
      // A failing refresh never poisons the cache with garbage.
      expect(existsSync(cacheFile) && (JSON.parse(readFileSync(cacheFile, "utf8")) as { manifest?: unknown }).manifest !== undefined).toBe(false);
    }
  });

  it("keeps a previously cached VALID manifest when a later refresh fails (fail-closed keeps the best known truth)", async () => {
    const cacheFile = join(scratchDir, "manifest-keep.json");
    writeFileSync(cacheFile, JSON.stringify({ fetchedAt: new Date(T0 - 7 * 3600_000).toISOString(), manifest: validManifest() }));
    const { fetchImpl } = fetchReturning(500, "down");
    const result = await refreshCodexManifest({ cacheFile, fetchImpl, now: () => T0 });
    expect(result.source).toBe("cache");
    expect(result.manifest).toEqual(validManifest());
  });

  it("a tampered cache file degrades to BUNDLED, not a crash and not a widened range", async () => {
    const cacheFile = join(scratchDir, "manifest-tampered.json");
    writeFileSync(cacheFile, JSON.stringify({ fetchedAt: new Date(T0).toISOString(), manifest: validManifest({ minimum: "0.1.0" }) }));
    const { calls, fetchImpl } = fetchReturning(500, "down");
    const result = await refreshCodexManifest({ cacheFile, fetchImpl, now: () => T0 });
    // Tampered cache is not "fresh valid cache": it must neither short-circuit
    // as cache nor surface its widened range.
    expect(result.source).toBe("bundled");
    expect(result.manifest).toEqual(BUNDLED_CODEX_MANIFEST);
    expect(calls.length).toBeGreaterThan(0);
  });

  it("a fetch that rejects (network down) resolves to the bundled manifest", async () => {
    const cacheFile = join(scratchDir, "manifest-offline.json");
    const fetchImpl = (async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as typeof fetch;
    const result = await refreshCodexManifest({ cacheFile, fetchImpl, now: () => T0 });
    expect(result.source).toBe("bundled");
    expect(result.manifest).toEqual(BUNDLED_CODEX_MANIFEST);
  });

  it("caps the response body — an oversized manifest is refused, bundled wins", async () => {
    const cacheFile = join(scratchDir, "manifest-huge.json");
    const huge = JSON.stringify(validManifest({ updatedAt: "x".repeat(512 * 1024) }));
    const { fetchImpl } = fetchReturning(200, huge);
    const result = await refreshCodexManifest({ cacheFile, fetchImpl, now: () => T0 });
    expect(result.source).toBe("bundled");
  });
});
