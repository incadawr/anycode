/**
 * TASK.237 regression suite: a previously MANAGED Codex install
 * (`settings.codex.binaryPath` inside `~/.anycode/codex/bin/<X.Y.Z>/…`) is
 * upgraded to the manifest's recommended version on app upgrade; an explicit
 * EXTERNAL binary is never migrated; every failure leaves the old install
 * and the persisted path untouched (next boot retries).
 *
 * The fake registry/tarball plumbing mirrors codex-install.test.ts: a
 * well-formed vendor-subtree archive served from the two pinned npm-registry
 * URLs, so the real `installCodexVersion` pipeline (sha512 gate, atomic
 * rename, layout cross-check) runs against real tmp-disk.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import type { CodexDoctorReport } from "../shared/codex-doctor.js";
import { BUNDLED_CODEX_MANIFEST } from "../shared/codex-support.js";
import { resetActiveCodexVersionPolicy, setActiveCodexVersionPolicy } from "./codex-manifest.js";
import { planCodexManagedUpgrade, runCodexManagedUpgrade, type CodexManagedUpgradeDeps } from "./codex-managed-upgrade.js";
import type { RunCodexDoctorOptions } from "./codex-doctor.js";

const TRIPLE = "aarch64-apple-darwin";
const OLD_VERSION = "0.144.3";
const NEW_VERSION = "0.160.0";
const OLD_SUFFIX = `${OLD_VERSION}-darwin-arm64`;
const NEW_SUFFIX = `${NEW_VERSION}-darwin-arm64`;
const OLD_METADATA_URL = `https://registry.npmjs.org/@openai/codex/${OLD_SUFFIX}`;
const OLD_TARBALL_URL = `https://registry.npmjs.org/@openai/codex/-/codex-${OLD_SUFFIX}.tgz`;
const NEW_METADATA_URL = `https://registry.npmjs.org/@openai/codex/${NEW_SUFFIX}`;
const NEW_TARBALL_URL = `https://registry.npmjs.org/@openai/codex/-/codex-${NEW_SUFFIX}.tgz`;

// ── the same minimal ustar builder codex-install.test.ts uses ──

interface TarEntrySpec {
  name: string;
  data?: Buffer;
  typeflag?: string;
  mode?: number;
}

function tarHeader(name: string, size: number, typeflag: string, mode: number): Buffer {
  const buf = Buffer.alloc(512);
  buf.write(name, 0, 100, "utf8");
  buf.write(`${mode.toString(8).padStart(7, "0")}\0`, 100, 8);
  buf.write("0000000\0", 108, 8);
  buf.write("0000000\0", 116, 8);
  buf.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12);
  buf.write("00000000000\0", 136, 12);
  buf.write("        ", 148, 8);
  buf.write(typeflag, 156, 1);
  buf.write("ustar\0", 257, 6);
  buf.write("00", 263, 2);
  let sum = 0;
  for (const byte of buf) sum += byte;
  buf.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return buf;
}

function buildTgz(entries: TarEntrySpec[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const data = entry.data ?? Buffer.alloc(0);
    parts.push(tarHeader(entry.name, data.length, entry.typeflag ?? "0", entry.mode ?? 0o644));
    if (data.length > 0) {
      parts.push(data);
      const pad = 512 - (data.length % 512);
      if (pad < 512) parts.push(Buffer.alloc(pad));
    }
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

function sri(bytes: Buffer): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

function goodArchive(version: string): Buffer {
  const codexPackage = JSON.stringify({
    layoutVersion: 1,
    version,
    target: TRIPLE,
    variant: "codex",
    entrypoint: "bin/codex",
    resourcesDir: "codex-resources",
    pathDir: "codex-path",
  });
  return buildTgz([
    { name: "package/package.json", data: Buffer.from("{}") },
    { name: `package/vendor/${TRIPLE}/codex-package.json`, data: Buffer.from(codexPackage) },
    { name: `package/vendor/${TRIPLE}/bin/`, typeflag: "5", mode: 0o755 },
    { name: `package/vendor/${TRIPLE}/bin/codex`, data: Buffer.from(`#!/bin/sh\necho codex-cli ${version}\n`), mode: 0o755 },
  ]);
}

const OLD_TGZ = goodArchive(OLD_VERSION);
const NEW_TGZ = goodArchive(NEW_VERSION);

/** Serves both versions' metadata+tarball from memory; a route mapped to `null` 404s (network failure simulation). */
function registryFetch(routes: Record<string, Response | null>): { calls: string[]; fetchImpl: typeof fetch } {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const route = routes[url];
    if (route === undefined) return new Response("not found", { status: 404 });
    if (route === null) return new Response("gone", { status: 500 });
    return route;
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function fullRegistry(overrides: Record<string, Response | null> = {}): { calls: string[]; fetchImpl: typeof fetch } {
  return registryFetch({
    [OLD_METADATA_URL]: Response.json({
      name: "@openai/codex",
      version: OLD_SUFFIX,
      os: ["darwin"],
      cpu: ["arm64"],
      dist: { tarball: OLD_TARBALL_URL, integrity: sri(OLD_TGZ) },
    }),
    [OLD_TARBALL_URL]: new Response(new Uint8Array(OLD_TGZ), { status: 200 }),
    [NEW_METADATA_URL]: Response.json({
      name: "@openai/codex",
      version: NEW_SUFFIX,
      os: ["darwin"],
      cpu: ["arm64"],
      dist: { tarball: NEW_TARBALL_URL, integrity: sri(NEW_TGZ) },
    }),
    [NEW_TARBALL_URL]: new Response(new Uint8Array(NEW_TGZ), { status: 200 }),
    ...overrides,
  });
}

// ── fixtures ──

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  resetActiveCodexVersionPolicy();
});

function tmpHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "anycode-codex-managed-upgrade-test-"));
  scratch.push(dir);
  return dir;
}

/** The incident's machine state: a real managed 0.144.3 on disk, pointed at by settings. */
function machineWithOldManagedInstall(): { home: string; oldBinaryPath: string } {
  const home = tmpHome();
  const installDir = join(home, ".anycode", "codex", "bin", OLD_VERSION);
  const oldBinaryPath = join(installDir, "vendor", TRIPLE, "bin", "codex");
  mkdirSync(dirname(oldBinaryPath), { recursive: true });
  writeFileSync(oldBinaryPath, "#!/bin/sh\necho codex-cli 0.144.3\n");
  chmodSync(oldBinaryPath, 0o755);
  return { home, oldBinaryPath };
}

function policyRecommending(version: string) {
  return {
    manifest: { ...BUNDLED_CODEX_MANIFEST, recommended: version },
    riskAcceptedVersions: [],
  };
}

const DARWIN_ARM = { platform: "darwin" as NodeJS.Platform, arch: "arm64" };
const READY_REPORT: CodexDoctorReport = { status: "ready", version: NEW_VERSION };

function upgradeDeps(overrides: Partial<CodexManagedUpgradeDeps> & { home: string; binaryPathSetting: string }): CodexManagedUpgradeDeps {
  const { home, binaryPathSetting, ...rest } = overrides;
  const { fetchImpl } = fullRegistry();
  return {
    ...DARWIN_ARM,
    home,
    fetchImpl,
    trust: () => null,
    runDoctor: async () => READY_REPORT,
    readBinaryPathSetting: async () => binaryPathSetting,
    swapBinaryPath: async () => ({ ok: true }),
    ...rest,
  };
}

// ── the pure plan ──

describe("planCodexManagedUpgrade (identity + ordering, pure)", () => {
  const home = "/tmp/plan-home";
  const managed = (version: string) => join(home, ".anycode", "codex", "bin", version, "vendor", TRIPLE, "bin", "codex");

  it("plans an install when the persisted managed path is older than recommended", () => {
    const plan = planCodexManagedUpgrade(managed("0.144.3"), policyRecommending("0.160.0"), home, "darwin", "arm64");
    expect(plan).toEqual({
      action: "install",
      fromVersion: "0.144.3",
      toVersion: "0.160.0",
      fromBinaryPath: managed("0.144.3"),
    });
  });

  it("treats any path outside ~/.anycode/codex/bin as external — never managed", () => {
    for (const external of [
      "/opt/homebrew/bin/codex",
      "/Users/dev/.npm-global/bin/codex",
      join(home, ".codex", "bin", "codex"),
      // wrong identity inside our root: the bin root itself / a stray file
      join(home, ".anycode", "codex", "bin", "codex"),
      // traversal-shaped: escapes the bin root (bin/../../…) — a raw string,
      // since path.join would normalize the .. away
      `${home}/.anycode/codex/bin/0.144.3/../../../outside/codex`,
      // non-version directory
      join(home, ".anycode", "codex", "bin", "latest", "vendor", TRIPLE, "bin", "codex"),
      join(home, ".anycode", "codex", "bin", ".tmp-0.144.3-abc", "vendor", TRIPLE, "bin", "codex"),
      // a version directory holding something that is not the installer's
      // binary: a user's own tool, a deeper path, another triple, another name
      join(home, ".anycode", "codex", "bin", "0.144.3", "custom", "tool", "bin", "external"),
      join(home, ".anycode", "codex", "bin", "0.144.3", "vendor", TRIPLE, "bin", "nested", "codex"),
      join(home, ".anycode", "codex", "bin", "0.144.3", "vendor", "x86_64-unknown-linux-musl", "bin", "codex"),
      join(home, ".anycode", "codex", "bin", "0.144.3", "vendor", TRIPLE, "bin", "codex-helper"),
      join(home, ".anycode", "codex", "bin", "0.144.3", "vendor", TRIPLE, "bin", "codex.exe"),
    ]) {
      expect(planCodexManagedUpgrade(external, policyRecommending("0.160.0"), home, "darwin", "arm64")).toEqual({
        action: "none",
        reason: "not_managed",
      });
    }
  });

  it("an unsupported platform has no managed layout, so nothing is managed there", () => {
    expect(planCodexManagedUpgrade(managed("0.144.3"), policyRecommending("0.160.0"), home, "aix", "ppc64")).toEqual({
      action: "none",
      reason: "not_managed",
    });
  });

  it("no-op cases: no setting, already current, and a HIGHER managed version (never downgrade)", () => {
    expect(planCodexManagedUpgrade(undefined, policyRecommending("0.160.0"), home, "darwin", "arm64")).toEqual({
      action: "none",
      reason: "no_settings_path",
    });
    expect(planCodexManagedUpgrade("", policyRecommending("0.160.0"), home, "darwin", "arm64")).toEqual({
      action: "none",
      reason: "no_settings_path",
    });
    expect(planCodexManagedUpgrade(managed("0.160.0"), policyRecommending("0.160.0"), home, "darwin", "arm64")).toEqual({
      action: "none",
      reason: "already_current",
    });
    expect(planCodexManagedUpgrade(managed("0.161.0"), policyRecommending("0.160.0"), home, "darwin", "arm64")).toEqual({
      action: "none",
      reason: "already_current",
    });
  });
});

// ── the run ──

describe("runCodexManagedUpgrade — the old-managed upgrade path (TASK.237 incident)", () => {
  it("upgrades managed 0.144.3 to the recommended 0.160.0, repoints settings, keeps the old tree", async () => {
    setActiveCodexVersionPolicy(policyRecommending(NEW_VERSION));
    const { home, oldBinaryPath } = machineWithOldManagedInstall();
    const written: Array<Record<string, unknown>> = [];
    const result = await runCodexManagedUpgrade(
      upgradeDeps({
        home,
        binaryPathSetting: oldBinaryPath,
        swapBinaryPath: async (expected, next) => {
          written.push({ expected, next });
          return { ok: true };
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok || !result.upgraded) return;
    expect(result.fromVersion).toBe(OLD_VERSION);
    expect(result.toVersion).toBe(NEW_VERSION);
    const newBinaryPath = join(home, ".anycode", "codex", "bin", NEW_VERSION, "vendor", TRIPLE, "bin", "codex");
    expect(result.binaryPath).toBe(newBinaryPath);
    // The new tree landed on real disk through the full §7.2 pipeline...
    expect(existsSync(newBinaryPath)).toBe(true);
    // ...settings was repointed exactly once, binaryPath only...
    expect(written).toEqual([{ expected: oldBinaryPath, next: newBinaryPath }]);
    // ...and the OLD install is still there (rollback target, not deleted).
    expect(existsSync(oldBinaryPath)).toBe(true);
  });

  it("never touches an explicit external binary (homebrew-style path persists, nothing downloaded)", async () => {
    setActiveCodexVersionPolicy(policyRecommending(NEW_VERSION));
    const { home } = machineWithOldManagedInstall();
    const external = "/opt/homebrew/bin/codex";
    const { fetchImpl } = fullRegistry();
    const written: Array<Record<string, unknown>> = [];
    const result = await runCodexManagedUpgrade({
      ...DARWIN_ARM,
      home,
      fetchImpl,
      trust: () => null,
      runDoctor: async () => READY_REPORT,
      readBinaryPathSetting: async () => external,
      swapBinaryPath: async (expected, next) => {
        written.push({ expected, next });
        return { ok: true };
      },
    });
    expect(result).toEqual({ ok: true, upgraded: false, reason: "not_managed" });
    expect(written).toEqual([]);
    expect(existsSync(join(home, ".anycode", "codex", "bin", NEW_VERSION))).toBe(false);
  });

  it("no-op when nothing is persisted — a fresh machine downloads nothing", async () => {
    setActiveCodexVersionPolicy(policyRecommending(NEW_VERSION));
    const { home, fetchImpl } = { ...machineWithOldManagedInstall(), ...fullRegistry() };
    const result = await runCodexManagedUpgrade({
      ...DARWIN_ARM,
      home,
      fetchImpl,
      trust: () => null,
      runDoctor: async () => READY_REPORT,
      readBinaryPathSetting: async () => undefined,
      swapBinaryPath: async () => ({ ok: true }),
    });
    expect(result).toEqual({ ok: true, upgraded: false, reason: "no_settings_path" });
  });
});

describe("runCodexManagedUpgrade — failure handling leaves the old install working", () => {
  it("a failed download (registry 500) persists nothing and keeps the old binary as-is", async () => {
    setActiveCodexVersionPolicy(policyRecommending(NEW_VERSION));
    const { home, oldBinaryPath } = machineWithOldManagedInstall();
    const { fetchImpl } = fullRegistry({ [NEW_TARBALL_URL]: null });
    const written: Array<Record<string, unknown>> = [];
    const result = await runCodexManagedUpgrade({
      ...DARWIN_ARM,
      home,
      fetchImpl,
      trust: () => null,
      runDoctor: async () => READY_REPORT,
      readBinaryPathSetting: async () => oldBinaryPath,
      swapBinaryPath: async (expected, next) => {
        written.push({ expected, next });
        return { ok: true };
      },
    });
    expect(result.ok).toBe(false);
    expect(written).toEqual([]);
    expect(existsSync(oldBinaryPath)).toBe(true);
    // No partial new-version directory, no temp litter.
    expect(existsSync(join(home, ".anycode", "codex", "bin", NEW_VERSION))).toBe(false);
    const litter = readdirSync(join(home, ".anycode", "codex", "bin")).filter((name) => name.startsWith(".") && name !== ".");
    expect(litter).toEqual([]);
  });

  it("a failing post-install doctor removes the fresh tree and persists nothing (recovery = stay on old)", async () => {
    setActiveCodexVersionPolicy(policyRecommending(NEW_VERSION));
    const { home, oldBinaryPath } = machineWithOldManagedInstall();
    const written: Array<Record<string, unknown>> = [];
    const result = await runCodexManagedUpgrade(
      upgradeDeps({
        home,
        binaryPathSetting: oldBinaryPath,
        runDoctor: async () => ({ status: "error", error: "spawn failed" }),
        swapBinaryPath: async (expected, next) => {
          written.push({ expected, next });
          return { ok: true };
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(written).toEqual([]);
    expect(existsSync(join(home, ".anycode", "codex", "bin", NEW_VERSION))).toBe(false);
    expect(existsSync(oldBinaryPath)).toBe(true);
  });

  it("a failing trust gate removes the fresh tree and persists nothing", async () => {
    setActiveCodexVersionPolicy(policyRecommending(NEW_VERSION));
    const { home, oldBinaryPath } = machineWithOldManagedInstall();
    const result = await runCodexManagedUpgrade(
      upgradeDeps({
        home,
        binaryPathSetting: oldBinaryPath,
        trust: () => "codex binary is not trusted",
        swapBinaryPath: async () => ({ ok: true }),
      }),
    );
    expect(result.ok).toBe(false);
    expect(existsSync(join(home, ".anycode", "codex", "bin", NEW_VERSION))).toBe(false);
    expect(existsSync(oldBinaryPath)).toBe(true);
  });

  it("a throwing settings persist keeps the app on the old path this boot (retry next boot)", async () => {
    setActiveCodexVersionPolicy(policyRecommending(NEW_VERSION));
    const { home, oldBinaryPath } = machineWithOldManagedInstall();
    const result = await runCodexManagedUpgrade(
      upgradeDeps({
        home,
        binaryPathSetting: oldBinaryPath,
        swapBinaryPath: async () => {
          throw new Error("disk full");
        },
      }),
    );
    // Honest failure, but the new tree stays installed and healthy — only
    // the pointer moved nowhere, so the next boot re-plans and retries.
    expect(result.ok).toBe(false);
    expect(existsSync(join(home, ".anycode", "codex", "bin", NEW_VERSION))).toBe(true);
    expect(existsSync(oldBinaryPath)).toBe(true);
  });

  it("a STRUCTURED settings refusal (read_only) is a failure, not a success — and nothing is announced", async () => {
    setActiveCodexVersionPolicy(policyRecommending(NEW_VERSION));
    const { home, oldBinaryPath } = machineWithOldManagedInstall();
    let changed = 0;
    const result = await runCodexManagedUpgrade(
      upgradeDeps({
        home,
        binaryPathSetting: oldBinaryPath,
        swapBinaryPath: async () => ({ ok: false, reason: "read_only" }),
        onChanged: () => {
          changed += 1;
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("read_only");
    expect(changed).toBe(0);
  });

  it("a CLI the user selects while the upgrade downloads is kept — the upgrade stands down", async () => {
    setActiveCodexVersionPolicy(policyRecommending(NEW_VERSION));
    const { home, oldBinaryPath } = machineWithOldManagedInstall();
    // `selected` stands in for the persisted setting; the fake swap has the
    // production compare-and-set semantics (handleSwapCodexBinaryPath).
    let selected = oldBinaryPath;
    let changed = 0;
    const result = await runCodexManagedUpgrade(
      upgradeDeps({
        home,
        binaryPathSetting: oldBinaryPath,
        runDoctor: async () => {
          selected = "/opt/custom/codex";
          return READY_REPORT;
        },
        swapBinaryPath: async (expected, next) => {
          if (selected !== expected) return { ok: false, reason: "changed" };
          selected = next;
          return { ok: true };
        },
        onChanged: () => {
          changed += 1;
        },
      }),
    );
    expect(result).toEqual({ ok: true, upgraded: false, reason: "selection_changed" });
    expect(selected).toBe("/opt/custom/codex");
    expect(changed).toBe(0);
  });

  it("a doctor that THROWS instead of reporting still ends as {ok:false}, settings untouched", async () => {
    setActiveCodexVersionPolicy(policyRecommending(NEW_VERSION));
    const { home, oldBinaryPath } = machineWithOldManagedInstall();
    const written: Array<Record<string, unknown>> = [];
    const result = await runCodexManagedUpgrade(
      upgradeDeps({
        home,
        binaryPathSetting: oldBinaryPath,
        runDoctor: async () => {
          throw new Error("spawn EACCES");
        },
        swapBinaryPath: async (expected, next) => {
          written.push({ expected, next });
          return { ok: true };
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(written).toEqual([]);
    expect(existsSync(oldBinaryPath)).toBe(true);
  });

  it("a recommended version outside the policy's own ranges is refused (no forced downgrade/upgrade)", async () => {
    // Supported range narrowed below the recommended value — a malformed
    // policy combination the verdict gate must catch.
    setActiveCodexVersionPolicy({
      manifest: {
        ...BUNDLED_CODEX_MANIFEST,
        supported: [{ range: ">=0.144.0 <0.145.0", status: "tested" }],
        recommended: NEW_VERSION,
      },
      riskAcceptedVersions: [],
    });
    const { home, oldBinaryPath } = machineWithOldManagedInstall();
    const result = await runCodexManagedUpgrade(upgradeDeps({ home, binaryPathSetting: oldBinaryPath }));
    expect(result.ok).toBe(false);
    expect(existsSync(join(home, ".anycode", "codex", "bin", NEW_VERSION))).toBe(false);
    expect(existsSync(oldBinaryPath)).toBe(true);
  });
});

describe("runCodexManagedUpgrade — success details the incident cared about", () => {
  it("the post-upgrade doctor runs behind the supplied engine-proxy source env (TASK.139 parity)", async () => {
    setActiveCodexVersionPolicy(policyRecommending(NEW_VERSION));
    const { home, oldBinaryPath } = machineWithOldManagedInstall();
    const seen: Array<RunCodexDoctorOptions | undefined> = [];
    const carrierEnv = { PATH: "/usr/bin", ANYCODE_CODEX_PROXY_URL: "http://proxy.example.com:3128" };
    await runCodexManagedUpgrade(
      upgradeDeps({
        home,
        binaryPathSetting: oldBinaryPath,
        doctorSourceEnv: () => ({ ...carrierEnv }),
        runDoctor: async (_path: string, options?: RunCodexDoctorOptions) => {
          seen.push(options);
          return READY_REPORT;
        },
      }),
    );
    expect(seen).toEqual([{ env: carrierEnv }]);
  });

  it("fires onChanged exactly once per successful upgrade (readiness/catalog refresh signal)", async () => {
    setActiveCodexVersionPolicy(policyRecommending(NEW_VERSION));
    const { home, oldBinaryPath } = machineWithOldManagedInstall();
    let changed = 0;
    await runCodexManagedUpgrade(
      upgradeDeps({
        home,
        binaryPathSetting: oldBinaryPath,
        onChanged: () => {
          changed += 1;
        },
      }),
    );
    expect(changed).toBe(1);
  });

  it("a throwing onChanged does not turn a persisted upgrade into a reported failure", async () => {
    setActiveCodexVersionPolicy(policyRecommending(NEW_VERSION));
    const { home, oldBinaryPath } = machineWithOldManagedInstall();
    const result = await runCodexManagedUpgrade(
      upgradeDeps({
        home,
        binaryPathSetting: oldBinaryPath,
        onChanged: () => {
          throw new Error("window gone");
        },
      }),
    );
    expect(result.ok && result.upgraded).toBe(true);
  });

  it("is idempotent: a second run after a successful upgrade is a no-op", async () => {
    setActiveCodexVersionPolicy(policyRecommending(NEW_VERSION));
    const { home, oldBinaryPath } = machineWithOldManagedInstall();
    const deps = upgradeDeps({ home, binaryPathSetting: oldBinaryPath });
    const first = await runCodexManagedUpgrade(deps);
    expect(first.ok && first.upgraded).toBe(true);
    const newBinaryPath = join(home, ".anycode", "codex", "bin", NEW_VERSION, "vendor", TRIPLE, "bin", "codex");
    const second = await runCodexManagedUpgrade({ ...deps, readBinaryPathSetting: async () => newBinaryPath });
    expect(second).toEqual({ ok: true, upgraded: false, reason: "already_current" });
  });
});
