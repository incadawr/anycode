/**
 * Taskana 4732 xfix H1(c): the consent writers against a REAL settings.json in
 * a temp dir. The user-facing writer must land every write (the old main
 * closure silently dropped every grant after the first); the grandfathering
 * writer keeps its keep-the-winner guard.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { grandfatherPluginsMcpConsent, setPluginsMcpConsent, upsertPluginServiceConsent } from "./consent-settings.js";

let dir: string;
let settingsPath: string;
const logger = { warn: () => undefined, info: () => undefined } as never;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "anycode-consent-"));
  settingsPath = join(dir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ version: 1 }));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const read = () => JSON.parse(readFileSync(settingsPath, "utf8"));
const grant = (plugin: string, hash: string) => ({ plugin, serversHash: hash, grantedAt: "2026-10-01T00:00:00.000Z" });

describe("setPluginsMcpConsent (user-facing writer)", () => {
  it("every write lands — a second grant is not dropped", async () => {
    await setPluginsMcpConsent(settingsPath, [grant("a", "h1")], logger);
    await setPluginsMcpConsent(settingsPath, [grant("a", "h1"), grant("b", "h2")], logger);
    expect(read().plugins.mcpConsent.map((e: { plugin: string }) => e.plugin)).toEqual(["a", "b"]);
  });

  it("a re-approval after a changed serversHash replaces the old grant", async () => {
    await setPluginsMcpConsent(settingsPath, [grant("a", "old")], logger);
    await setPluginsMcpConsent(settingsPath, [grant("a", "new")], logger);
    expect(read().plugins.mcpConsent).toEqual([grant("a", "new")]);
  });
});

describe("grandfatherPluginsMcpConsent (one-shot migration)", () => {
  it("writes when no consent array exists yet", async () => {
    await grandfatherPluginsMcpConsent(settingsPath, [grant("legacy", "h")], logger);
    expect(read().plugins.mcpConsent).toEqual([grant("legacy", "h")]);
  });

  it("never overwrites an existing array (keep the winner)", async () => {
    await setPluginsMcpConsent(settingsPath, [grant("user", "u")], logger);
    await grandfatherPluginsMcpConsent(settingsPath, [grant("legacy", "h")], logger);
    expect(read().plugins.mcpConsent).toEqual([grant("user", "u")]);
  });
});

describe("upsertPluginServiceConsent (Taskana 4750a, read-modify-write under the lock)", () => {
  const sgrant = (plugin: string, hash: string) => ({ plugin, servicesHash: hash, grantedAt: "2026-10-25T00:00:00.000Z" });

  it("writes the first service grant without touching mcpConsent", async () => {
    await setPluginsMcpConsent(settingsPath, [grant("a", "m")], logger);
    await upsertPluginServiceConsent(settingsPath, sgrant("bridge", "s1"), logger);
    expect(read().plugins.serviceConsent).toEqual([sgrant("bridge", "s1")]);
    expect(read().plugins.mcpConsent).toEqual([grant("a", "m")]);
  });

  it("replaces the grant for the same plugin (re-approval after a changed hash) and keeps other plugins", async () => {
    await upsertPluginServiceConsent(settingsPath, sgrant("bridge", "old"), logger);
    await upsertPluginServiceConsent(settingsPath, sgrant("other", "x"), logger);
    await upsertPluginServiceConsent(settingsPath, sgrant("bridge", "new"), logger);
    expect(read().plugins.serviceConsent).toEqual([sgrant("other", "x"), sgrant("bridge", "new")]);
  });
});
