/**
 * Unit tests for the safeStorage vault (design slice-2.2-cut.md §1/§4, ruling

 * encrypt/decrypt round-trip per cipher, decrypt-fail -> unset (never throws),
 * and the SecretStatus projection (which never carries a value). A FAKE
 * safeStorage keeps the OS keychain out of the test — the real one only appears
 * in main/index.ts.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSecrets, saveSecrets } from "../settings/files.js";
import { Vault, type SafeStorageLike } from "./vault.js";

/** Fake safeStorage: encrypt = "enc:"+value bytes; decrypt reverses it (or throws). */
class FakeSafeStorage implements SafeStorageLike {
  constructor(
    private readonly opts: {
      available: boolean;
      platformBackend?: string;
      corruptDecrypt?: boolean;
    },
  ) {}
  isEncryptionAvailable(): boolean {
    return this.opts.available;
  }
  encryptString(plainText: string): Buffer {
    return Buffer.from(`enc:${plainText}`, "utf8");
  }
  decryptString(encrypted: Buffer): string {
    if (this.opts.corruptDecrypt) {
      throw new Error("decrypt failed (keychain identity changed)");
    }
    const s = encrypted.toString("utf8");
    if (!s.startsWith("enc:")) {
      throw new Error("not an enc blob");
    }
    return s.slice("enc:".length);
  }
  getSelectedStorageBackend(): string {
    return this.opts.platformBackend ?? "gnome_libsecret";
  }
}

let dir: string;
const secretsPath = () => join(dir, "secrets.json");

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "anycode-vault-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeVault(
  safeStorage: SafeStorageLike,
  platform: NodeJS.Platform = "darwin",
): Vault {
  return new Vault({ safeStorage, secretsPath: secretsPath(), platform });
}

describe("Vault.tier — backend detection (§4)", () => {
  it("os_encrypted on macOS when encryption is available", () => {
    expect(makeVault(new FakeSafeStorage({ available: true }), "darwin").tier()).toBe("os_encrypted");
  });

  it("obfuscated on Linux with the basic_text backend", () => {
    const v = makeVault(new FakeSafeStorage({ available: true, platformBackend: "basic_text" }), "linux");
    expect(v.tier()).toBe("obfuscated");
  });

  it("os_encrypted on Linux with a real keyring backend", () => {
    const v = makeVault(new FakeSafeStorage({ available: true, platformBackend: "gnome_libsecret" }), "linux");
    expect(v.tier()).toBe("os_encrypted");
  });

  it("unavailable when encryption is not available (headless)", () => {
    expect(makeVault(new FakeSafeStorage({ available: false }), "linux").tier()).toBe("unavailable");
  });

  it("does not call the Linux-only backend API off Linux", () => {
    let called = false;
    const ss: SafeStorageLike = {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from(s),
      decryptString: (b) => b.toString(),
      getSelectedStorageBackend: () => {
        called = true;
        return "basic_text";
      },
    };
    expect(makeVault(ss, "darwin").tier()).toBe("os_encrypted");
    expect(called).toBe(false);
  });
});

describe("Vault.setSecret — weak-storage consent matrix (R1)", () => {
  it("strong tier: writes a safeStorage blob without consent", async () => {
    const v = makeVault(new FakeSafeStorage({ available: true }), "darwin");
    const r = await v.setSecret("provider.apiKey", "sk-123", { allowWeak: false });
    expect(r).toEqual({ ok: true });
    const { file } = await loadSecrets(secretsPath());
    expect(file.entries["provider.apiKey"]?.cipher).toBe("safeStorage");
    expect(await v.getSecretValue("provider.apiKey")).toBe("sk-123");
  });

  it("obfuscated tier WITHOUT consent: refuses and writes nothing", async () => {
    const v = makeVault(new FakeSafeStorage({ available: true, platformBackend: "basic_text" }), "linux");
    const r = await v.setSecret("provider.apiKey", "sk-x", { allowWeak: false });
    expect(r).toEqual({ ok: false, reason: "weak_storage_needs_consent" });
    // No file was created.
    const { file } = await loadSecrets(secretsPath());
    expect(file.entries["provider.apiKey"]).toBeUndefined();
  });

  it("obfuscated tier WITH consent: writes a safeStorage blob (better than nothing)", async () => {
    const v = makeVault(new FakeSafeStorage({ available: true, platformBackend: "basic_text" }), "linux");
    const r = await v.setSecret("provider.apiKey", "sk-y", { allowWeak: true });
    expect(r).toEqual({ ok: true });
    const { file } = await loadSecrets(secretsPath());
    expect(file.entries["provider.apiKey"]?.cipher).toBe("safeStorage");
  });

  it("unavailable tier WITHOUT consent: refuses", async () => {
    const v = makeVault(new FakeSafeStorage({ available: false }), "linux");
    const r = await v.setSecret("provider.apiKey", "sk-z", { allowWeak: false });
    expect(r).toEqual({ ok: false, reason: "weak_storage_needs_consent" });
  });

  it("unavailable tier WITH consent: writes cipher plaintext at rest", async () => {
    const v = makeVault(new FakeSafeStorage({ available: false }), "linux");
    const r = await v.setSecret("provider.apiKey", "sk-plain", { allowWeak: true });
    expect(r).toEqual({ ok: true });
    const { file } = await loadSecrets(secretsPath());
    expect(file.entries["provider.apiKey"]).toEqual({ cipher: "plaintext", value: "sk-plain" });
    expect(await v.getSecretValue("provider.apiKey")).toBe("sk-plain");
  });

  it("the on-disk safeStorage value is base64, not the raw key", async () => {
    const v = makeVault(new FakeSafeStorage({ available: true }), "darwin");
    await v.setSecret("provider.apiKey", "sk-secret-abc", { allowWeak: false });
    const raw = await readFile(secretsPath(), "utf8");
    expect(raw).not.toContain("sk-secret-abc");
  });
});

describe("Vault.getSecretValue — decrypt fail-soft (§1.1, NB 2.6)", () => {
  it("returns undefined (unset) when decrypt throws, never crashes", async () => {
    // Write a blob with a working safeStorage, then read with one that fails.
    const writer = makeVault(new FakeSafeStorage({ available: true }), "darwin");
    await writer.setSecret("provider.apiKey", "sk-abc", { allowWeak: false });

    const reader = makeVault(new FakeSafeStorage({ available: true, corruptDecrypt: true }), "darwin");
    await expect(reader.getSecretValue("provider.apiKey")).resolves.toBeUndefined();
  });

  it("returns undefined for a missing entry", async () => {
    const v = makeVault(new FakeSafeStorage({ available: true }), "darwin");
    await expect(v.getSecretValue("provider.apiKey")).resolves.toBeUndefined();
  });
});

describe("Vault.clearSecret", () => {
  it("removes an entry (idempotent)", async () => {
    const v = makeVault(new FakeSafeStorage({ available: true }), "darwin");
    await v.setSecret("provider.apiKey", "sk-abc", { allowWeak: false });
    await v.clearSecret("provider.apiKey");
    expect(await v.getSecretValue("provider.apiKey")).toBeUndefined();
    // Second clear is a no-op.
    await expect(v.clearSecret("provider.apiKey")).resolves.toBeUndefined();
  });
});

describe("Vault.statuses — SecretStatus projection (custody I1)", () => {
  it("set:true source:vault when a safeStorage entry exists and no env override", async () => {
    const v = makeVault(new FakeSafeStorage({ available: true }), "darwin");
    await v.setSecret("provider.apiKey", "sk-abc", { allowWeak: false });
    const [status] = await v.statuses({});
    expect(status).toEqual({ key: "provider.apiKey", set: true, source: "vault", tier: "os_encrypted" });
    // Custody: never a value field.
    expect(Object.keys(status ?? {})).not.toContain("value");
  });

  it("source:env when the env overrides the vault", async () => {
    const v = makeVault(new FakeSafeStorage({ available: true }), "darwin");
    await v.setSecret("provider.apiKey", "sk-abc", { allowWeak: false });
    const [status] = await v.statuses({ ANYCODE_API_KEY: "sk-env" });
    expect(status?.source).toBe("env");
    expect(status?.set).toBe(true);
  });

  it("source:plaintext for a plaintext entry", async () => {
    const v = makeVault(new FakeSafeStorage({ available: false }), "linux");
    await v.setSecret("provider.apiKey", "sk-plain", { allowWeak: true });
    const [status] = await v.statuses({});
    expect(status?.source).toBe("plaintext");
    expect(status?.tier).toBe("unavailable");
  });

  it("set:false source:none when nothing is stored", async () => {
    const v = makeVault(new FakeSafeStorage({ available: true }), "darwin");
    const [status] = await v.statuses({});
    expect(status).toEqual({ key: "provider.apiKey", set: false, source: "none", tier: "os_encrypted" });
  });

  it("set:true but source:none when an entry exists but cannot decrypt", async () => {
    const writer = makeVault(new FakeSafeStorage({ available: true }), "darwin");
    await writer.setSecret("provider.apiKey", "sk-abc", { allowWeak: false });
    const reader = makeVault(new FakeSafeStorage({ available: true, corruptDecrypt: true }), "darwin");
    const [status] = await reader.statuses({});
    expect(status?.set).toBe(true);
    expect(status?.source).toBe("none");
  });
});

describe("Vault.statuses — multi-key (slice 2.5)", () => {
  const catalogIds = ["z-ai", "anthropic", "custom"];

  it("always reports the legacy key first, then on-disk per-provider keys", async () => {
    const v = makeVault(new FakeSafeStorage({ available: true }), "darwin");
    await v.setSecret("provider.apiKey", "legacy", { allowWeak: false });
    await v.setSecret("provider.z-ai.apiKey", "zk", { allowWeak: false });
    await v.setSecret("provider.anthropic.oauth", "oauth-blob", { allowWeak: false });

    const statuses = await v.statuses({}, catalogIds);
    expect(statuses[0]?.key).toBe("provider.apiKey");
    const keys = statuses.map((s) => s.key).sort();
    expect(keys).toEqual(["provider.anthropic.oauth", "provider.apiKey", "provider.z-ai.apiKey"]);
    for (const s of statuses) {
      expect(Object.keys(s).sort()).toEqual(["key", "set", "source", "tier"]);
    }
  });

  it("skips an on-disk entry whose id is not in the catalog", async () => {
    const v = makeVault(new FakeSafeStorage({ available: true }), "darwin");
    await v.setSecret("provider.z-ai.apiKey", "ok", { allowWeak: false });
    // Hand-write a tampered entry for an unknown provider id.
    const file = await v.load();
    await saveSecrets(secretsPath(), {
      version: 1,
      entries: { ...file.entries, "provider.evil.apiKey": { cipher: "plaintext", value: "x" } },
    });
    const keys = (await v.statuses({}, catalogIds)).map((s) => s.key);
    expect(keys).toContain("provider.z-ai.apiKey");
    expect(keys).not.toContain("provider.evil.apiKey");
  });

  it("with no catalog ids, only the legacy key is reported (byte-for-byte 2.2)", async () => {
    const v = makeVault(new FakeSafeStorage({ available: true }), "darwin");
    await v.setSecret("provider.z-ai.apiKey", "zk", { allowWeak: false });
    const statuses = await v.statuses({});
    expect(statuses.map((s) => s.key)).toEqual(["provider.apiKey"]);
  });

  it("a per-provider entry reads source:env when ANYCODE_API_KEY overrides (I2)", async () => {
    const v = makeVault(new FakeSafeStorage({ available: true }), "darwin");
    await v.setSecret("provider.z-ai.apiKey", "zk", { allowWeak: false });
    const status = (await v.statuses({ ANYCODE_API_KEY: "sk-env" }, catalogIds)).find(
      (s) => s.key === "provider.z-ai.apiKey",
    );
    expect(status?.source).toBe("env");
    expect(status?.set).toBe(true);
  });
});

describe("Vault OAuth token blob (slice 2.5 §3.3 + TASK.45: keyed by CONNECTION id)", () => {
  it("round-trips a token blob as one encrypted value under the connection oauth key", async () => {
    const v = makeVault(new FakeSafeStorage({ available: true }), "darwin");
    const blob = { accessToken: "at-1", refreshToken: "rt-1", expiresAt: 1234 };
    const r = await v.setOAuthTokens("conn-1", blob, { allowWeak: false });
    expect(r).toEqual({ ok: true });
    expect(await v.getOAuthTokens("conn-1")).toEqual(blob);
    // Stored under the connection oauth key, encrypted (raw token not on disk in clear).
    const { file } = await loadSecrets(secretsPath());
    expect(file.entries["provider.connection.conn-1.oauth"]?.cipher).toBe("safeStorage");
    const raw = await readFile(secretsPath(), "utf8");
    expect(raw).not.toContain("at-1");
    expect(raw).not.toContain("rt-1");
  });

  it("getOAuthTokens is fail-soft on a decrypt failure", async () => {
    const writer = makeVault(new FakeSafeStorage({ available: true }), "darwin");
    await writer.setOAuthTokens("conn-1", { accessToken: "a", refreshToken: "r", expiresAt: 1 }, { allowWeak: false });
    const reader = makeVault(new FakeSafeStorage({ available: true, corruptDecrypt: true }), "darwin");
    expect(await reader.getOAuthTokens("conn-1")).toBeUndefined();
  });

  it("getOAuthTokens returns undefined for a corrupt (non-JSON / wrong-shape) value", async () => {
    // A plaintext non-JSON value under the connection oauth key.
    await saveSecrets(secretsPath(), {
      version: 1,
      entries: { "provider.connection.conn-1.oauth": { cipher: "plaintext", value: "not-json" } },
    });
    const v = makeVault(new FakeSafeStorage({ available: false }), "linux");
    expect(await v.getOAuthTokens("conn-1")).toBeUndefined();
  });

  it("clearOAuthTokens removes the blob", async () => {
    const v = makeVault(new FakeSafeStorage({ available: true }), "darwin");
    await v.setOAuthTokens("conn-1", { accessToken: "a", refreshToken: "r", expiresAt: 1 }, { allowWeak: false });
    await v.clearOAuthTokens("conn-1");
    expect(await v.getOAuthTokens("conn-1")).toBeUndefined();
  });

  it("refuses to store on a weak tier without consent (no write)", async () => {
    const v = makeVault(new FakeSafeStorage({ available: false }), "linux");
    const r = await v.setOAuthTokens("conn-1", { accessToken: "a", refreshToken: "r", expiresAt: 1 }, { allowWeak: false });
    expect(r).toEqual({ ok: false, reason: "weak_storage_needs_consent" });
    expect(await v.getOAuthTokens("conn-1")).toBeUndefined();
  });
});

describe("Vault.scrubLegacyProviderKeys — boot scrub of stale v1 keys (§2, DoD item 9)", () => {
  const catalogIds = ["z-ai", "anthropic", "custom"];

  it("deletes ONLY the bare legacy key + catalog-scoped per-provider keys; leaves connection + unknown keys", async () => {
    const v = makeVault(new FakeSafeStorage({ available: true }), "darwin");
    await saveSecrets(secretsPath(), {
      version: 1,
      entries: {
        "provider.apiKey": { cipher: "plaintext", value: "legacy" },
        "provider.z-ai.apiKey": { cipher: "plaintext", value: "z" },
        "provider.anthropic.oauth": { cipher: "plaintext", value: "a" },
        "provider.connection.conn-1.apiKey": { cipher: "plaintext", value: "keep" },
        "provider.evil.apiKey": { cipher: "plaintext", value: "keep-unknown-id" },
      },
    });
    await v.scrubLegacyProviderKeys(catalogIds);
    const { file } = await loadSecrets(secretsPath());
    expect(Object.keys(file.entries).sort()).toEqual([
      "provider.connection.conn-1.apiKey",
      "provider.evil.apiKey",
    ]);
    // readiness/status no longer see a phantom "provider.apiKey".
    expect(await v.getSecretValue("provider.apiKey")).toBeUndefined();
  });

  it("is idempotent — a second scrub is a no-op", async () => {
    const v = makeVault(new FakeSafeStorage({ available: true }), "darwin");
    await v.setSecret("provider.connection.conn-1.apiKey", "keep", { allowWeak: false });
    await v.scrubLegacyProviderKeys(catalogIds);
    await v.scrubLegacyProviderKeys(catalogIds);
    const { file } = await loadSecrets(secretsPath());
    expect(Object.keys(file.entries)).toEqual(["provider.connection.conn-1.apiKey"]);
  });

  it("no-ops (and never throws) when there is nothing legacy on disk", async () => {
    const v = makeVault(new FakeSafeStorage({ available: true }), "darwin");
    await expect(v.scrubLegacyProviderKeys(catalogIds)).resolves.toBeUndefined();
  });
});

describe("Vault persistence format", () => {
  it("preserves an unrelated pre-existing entry shape on the same file path", async () => {
    // A hand-written valid file survives a round-trip through set/clear of the one key.
    await saveSecrets(secretsPath(), {
      version: 1,
      entries: { "provider.apiKey": { cipher: "plaintext", value: "old" } },
    });
    const v = makeVault(new FakeSafeStorage({ available: true }), "darwin");
    await v.setSecret("provider.apiKey", "new", { allowWeak: false });
    const { file } = await loadSecrets(secretsPath());
    expect(file.version).toBe(1);
    expect(file.entries["provider.apiKey"]?.cipher).toBe("safeStorage");
  });
});
