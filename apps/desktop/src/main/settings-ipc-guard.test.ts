import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cloneDefaults } from "../settings/schema.js";
import { saveSettings } from "../settings/files.js";
import type { Vault } from "./vault.js";
import type { SettingsIpcDeps, VaultLike } from "./settings-ipc.js";

const routes = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
vi.mock("electron", () => ({ ipcMain: { handle: (name: string, handler: (...args: unknown[]) => unknown) => routes.set(name, handler) } }));
import { addIpcGuardTrustedWindow, resetIpcGuardForTests, setIpcGuardMainWindow } from "./ipc-guard.js";
import { registerSettingsIpc } from "./settings-ipc.js";

const sender = { mainFrame: {} };
const event = { sender, senderFrame: sender.mainFrame };
const secret = "synthetic-secret-never-echo";
let dir: string;
let deps: SettingsIpcDeps;
let vault: VaultLike;
const names = ["settings-get", "settings-set", "secret-set", "secret-clear", "home-directory", "permission-rule-add", "binary-trust-grant", "binary-trust-revoke", "oauth-start", "oauth-cancel", "connection-create", "connection-update", "connection-set-active", "connection-delete", "connection-check", "proxy-profile-upsert", "proxy-profile-delete", "proxy-ref-set", "recognizer-set"];
function invoke(name: string, raw?: unknown, caller: unknown = event): Promise<unknown> {
  return Promise.resolve().then(() => routes.get(`anycode:${name}`)!(caller, raw));
}
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "settings-ipc-guards-"));
  const settingsPath = join(dir, "settings.json");
  const settings = cloneDefaults();
  settings.provider.connections = [{ id: "conn-existing", providerId: "test-provider" }];
  await saveSettings(settingsPath, settings);
  vault = {
    setSecret: vi.fn(async () => ({ ok: true as const })),
    clearSecret: vi.fn(async () => undefined),
    getSecretValue: vi.fn(async () => secret),
    probeSecret: vi.fn(async () => ({ state: "unset" as const })),
    statuses: vi.fn(async () => []),
  };
  deps = { settingsPath, bootEnv: {}, vault, catalogIds: ["test-provider"] };
  routes.clear();
  resetIpcGuardForTests();
  setIpcGuardMainWindow(() => sender);
  registerSettingsIpc({ ...deps, vault: vault as Vault });
});
afterEach(async () => { resetIpcGuardForTests(); await rm(dir, { recursive: true, force: true }); });

it("registers exactly the audited routes and rejects foreign, subframe, absent and document-only callers", async () => {
  expect([...routes.keys()].sort()).toEqual(names.map(name => `anycode:${name}`).sort());
  const foreign = { mainFrame: {} };
  addIpcGuardTrustedWindow(foreign, ["anycode:md-preview-read"]);
  for (const name of names) {
    for (const caller of [undefined, { sender: { mainFrame: {} }, senderFrame: {} }, { sender, senderFrame: {} }, { sender: foreign, senderFrame: foreign.mainFrame }]) {
      // Explicit undefined must reach the registration, not invoke's default argument.
      await expect(Promise.resolve().then(() => routes.get(`anycode:${name}`)!(caller, { value: secret }))).rejects.toThrow("refused");
    }
  }
  expect(vault.getSecretValue).not.toHaveBeenCalled();
  expect(vault.setSecret).not.toHaveBeenCalled();
});

it("rejects malformed mutation payloads without writing settings or secrets", async () => {
  const before = await readFile(deps.settingsPath, "utf8");
  for (const name of names.filter(name => !["settings-get", "home-directory", "oauth-cancel"].includes(name))) {
    await expect(invoke(name, null)).resolves.toMatchObject({ ok: false });
  }
  await expect(invoke("oauth-cancel", null)).resolves.toBeUndefined();
  expect(await readFile(deps.settingsPath, "utf8")).toBe(before);
  expect(vault.setSecret).not.toHaveBeenCalled();
  expect(vault.clearSecret).not.toHaveBeenCalled();
});

it("refuses stale connection identities before vault or probe access", async () => {
  for (const name of ["connection-update", "connection-set-active", "connection-check"]) {
    await expect(invoke(name, { id: "conn-deleted" })).resolves.toEqual({ ok: false, reason: "not_found" });
  }
  await expect(invoke("secret-set", { key: "provider.connection.conn-deleted.apiKey", value: secret })).resolves.toEqual({ ok: false, reason: "not_found" });
  await expect(invoke("recognizer-set", { recognizer: { connectionId: "conn-deleted", modelId: "model" } })).resolves.toEqual({ ok: false, reason: "invalid" });
  expect(vault.getSecretValue).not.toHaveBeenCalled();
  expect(vault.setSecret).not.toHaveBeenCalled();
  // Deleting an absent connection is intentionally idempotent.
  await expect(invoke("connection-delete", { id: "conn-deleted" })).resolves.toMatchObject({ ok: true });
});

it("redacts asynchronous dependency exceptions at the renderer boundary", async () => {
  vi.mocked(vault.setSecret).mockRejectedValue(new Error(`vault failed: ${secret}`));
  await expect(invoke("secret-set", { key: "provider.connection.conn-existing.apiKey", value: secret })).rejects.toThrow(/^Settings request failed$/);
});

it("redacts synchronous dependency exceptions at the renderer boundary", async () => {
  deps.statBinaryForTrust = () => { throw new Error(`stat failed: ${secret}`); };
  registerSettingsIpc({ ...deps, vault: vault as Vault });
  await expect(invoke("binary-trust-grant", { path: "/synthetic/binary" })).rejects.toThrow(/^Settings request failed$/);
});

it("never persists an arbitrary probe failure string", async () => {
  deps.probeConnection = async () => ({ ok: false, code: secret });
  registerSettingsIpc({ ...deps, vault: vault as Vault });
  const result = await invoke("connection-check", { id: "conn-existing" });
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(await readFile(deps.settingsPath, "utf8")).not.toContain(secret);
});

it.each(["endpoint", "credential"])("discards a probe result after its %s changes", async (change) => {
  deps.probeConnection = async () => {
    if (change === "credential") vi.mocked(vault.getSecretValue).mockResolvedValue("replacement-secret");
    else {
      const settings = cloneDefaults();
      settings.provider.connections = [{ id: "conn-existing", providerId: "test-provider", baseUrl: "https://changed.invalid" }];
      await saveSettings(deps.settingsPath, settings);
    }
    return { ok: true };
  };
  registerSettingsIpc({ ...deps, vault: vault as Vault });
  await invoke("connection-check", { id: "conn-existing" });
  expect(await readFile(deps.settingsPath, "utf8")).not.toContain('"ready"');
});

it("registers a working Go probe through the production composition", async () => {
  const { registerSettingsIpcWithProbe } = await import("./connection-probe.js");
  const settings = cloneDefaults();
  settings.provider.connections = [{ id: "conn-existing", providerId: "opencode" }];
  await saveSettings(deps.settingsPath, settings);
  const fetcher = vi.fn().mockResolvedValue(new Response('{"usage":{"rolling":{"percent":0}}}'));
  registerSettingsIpcWithProbe({ ...deps, vault: vault as Vault }, {
    settings: async () => settings, vault, fetch: () => fetcher,
  });
  expect(await invoke("connection-check", { id: "conn-existing" })).toMatchObject({ ok: true });
  expect(fetcher).toHaveBeenCalledOnce();
  expect(await readFile(deps.settingsPath, "utf8")).toContain('"ready"');
  fetcher.mockResolvedValue(new Response(null, { status: 404 }));
  await invoke("connection-check", { id: "conn-existing" });
  const { loadSettings } = await import("../settings/files.js");
  expect((await loadSettings(deps.settingsPath)).settings.provider.connections[0]?.lastHealth).toMatchObject({ status: "misconfigured", safeCode: "unexpected_response" });
});

it("logs a safe dependency cause without error messages or payloads", async () => {
  const warn = vi.fn();
  deps.logger = { warn };
  vi.mocked(vault.setSecret).mockRejectedValue(Object.assign(new Error(secret), { code: "ENOSPC" }));
  registerSettingsIpc({ ...deps, vault: vault as Vault });
  await expect(invoke("secret-set", { key: "provider.connection.conn-existing.apiKey", value: secret })).rejects.toThrow(/^Settings request failed$/);
  expect(warn).toHaveBeenCalledWith("settings IPC anycode:secret-set failed (ENOSPC)");
  expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
});
