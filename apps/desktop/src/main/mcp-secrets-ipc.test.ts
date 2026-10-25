/**
 * MCP secrets IPC (Taskana 4752, part C): write-only handlers. Every return value
 * and every console call is checked so a submitted value can never come back out.
 * The vault is an in-memory fake; no safeStorage, no real files.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SecretKey } from "../shared/settings.js";
import { mcpSecretKey, parseMcpSecretKey } from "../shared/mcp-secrets.js";
import {
  handleMcpSecretDelete,
  handleMcpSecretSet,
  handleMcpSecretsList,
  type McpSecretsIpcDeps,
} from "./mcp-secrets-ipc.js";

const SECRET = "ghp_SUPERSECRET_value_42";

function fakeDeps(opts: { weak?: boolean; allowWeak?: boolean; failSet?: boolean; onMutation?: () => void } = {}) {
  const store = new Map<string, string>();
  const vault = {
    async setSecret(key: SecretKey, value: string, o: { allowWeak: boolean }) {
      if (opts.failSet) throw new Error(`disk full while writing ${value}`);
      if (opts.weak === true && !o.allowWeak) {
        return { ok: false as const, reason: "weak_storage_needs_consent" as const };
      }
      store.set(key, value);
      return { ok: true as const };
    },
    async clearSecret(key: SecretKey) {
      store.delete(key);
    },
    async listMcpSecretNames() {
      return [...store.keys()]
        .map((k) => parseMcpSecretKey(k))
        .filter((n): n is string => n !== undefined)
        .sort();
    },
  };
  const deps: McpSecretsIpcDeps = {
    vault,
    allowWeak: () => opts.allowWeak ?? false,
    onMutation: opts.onMutation ?? (() => {}),
  };
  return { deps, store };
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** Asserts a value is absent from every JSON-serialised return and every console argument. */
function expectNoLeak(value: unknown, spies: Array<ReturnType<typeof vi.spyOn>>, secret: string) {
  expect(JSON.stringify(value)).not.toContain(secret);
  for (const spy of spies) {
    for (const call of spy.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(secret);
    }
  }
}

describe("MCP secrets IPC — write-only contract (Taskana 4752, C-14)", () => {
  it("C-14: set returns names only; the value is absent from the result and from every console call", async () => {
    const logSpies = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error"), vi.spyOn(console, "info")];
    const { deps, store } = fakeDeps();
    const result = await handleMcpSecretSet(deps, { name: "GITHUB_TOKEN", value: SECRET });
    expect(result).toEqual({ ok: true, names: ["GITHUB_TOKEN"] });
    expect(store.get(mcpSecretKey("GITHUB_TOKEN"))).toBe(SECRET); // the vault did receive it
    expectNoLeak(result, logSpies, SECRET);
  });

  it("C-14: the list result carries names only", async () => {
    const { deps } = fakeDeps();
    await handleMcpSecretSet(deps, { name: "B_TOKEN", value: "bbbb-value" });
    await handleMcpSecretSet(deps, { name: "A_TOKEN", value: SECRET });
    const list = await handleMcpSecretsList(deps);
    expect(list).toEqual({ ok: true, names: ["A_TOKEN", "B_TOKEN"] });
    expect(JSON.stringify(list)).not.toContain(SECRET);
  });

  it("C-14: the error path returns a fixed reason and does not echo the value; the console line redacts it", async () => {
    const logSpies = [vi.spyOn(console, "error"), vi.spyOn(console, "warn")];
    const { deps } = fakeDeps({ failSet: true });
    const result = await handleMcpSecretSet(deps, { name: "GITHUB_TOKEN", value: SECRET });
    expect(result).toEqual({ ok: false, reason: "io_error" });
    expectNoLeak(result, logSpies, SECRET);
    // the redacted line still says what failed
    expect(logSpies.some((s) => s.mock.calls.length > 0)).toBe(true);
  });
});

describe("MCP secrets IPC — boundary validation (Taskana 4752, C-15)", () => {
  it("C-15: an invalid name is rejected before anything is written", async () => {
    const { deps, store } = fakeDeps();
    for (const name of ["a-b", "1x", "", "x".repeat(65)]) {
      expect(await handleMcpSecretSet(deps, { name, value: "v" })).toEqual({ ok: false, reason: "invalid" });
    }
    expect(store.size).toBe(0);
  });

  it("C-15: an empty or over-long value is rejected", async () => {
    const { deps, store } = fakeDeps();
    expect(await handleMcpSecretSet(deps, { name: "OK_NAME", value: "" })).toEqual({ ok: false, reason: "invalid" });
    expect(await handleMcpSecretSet(deps, { name: "OK_NAME", value: "v".repeat(8193) })).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(store.size).toBe(0);
  });

  it("C-15: an extra key (e.g. path) is rejected by .strict()", async () => {
    const { deps, store } = fakeDeps();
    expect(await handleMcpSecretSet(deps, { name: "OK_NAME", value: "v", path: "/etc/passwd" })).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(await handleMcpSecretDelete(deps, { name: "OK_NAME", path: "/x" })).toEqual({ ok: false, reason: "invalid" });
    expect(store.size).toBe(0);
  });

  it("C-15: a non-object payload is rejected", async () => {
    const { deps } = fakeDeps();
    expect(await handleMcpSecretSet(deps, "a string")).toEqual({ ok: false, reason: "invalid" });
    expect(await handleMcpSecretSet(deps, null)).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("MCP secrets IPC — weak storage consent (Taskana 4752, C-16)", () => {
  it("C-16: weak storage without consent => weak_storage_needs_consent and nothing written", async () => {
    const { deps, store } = fakeDeps({ weak: true, allowWeak: false });
    const result = await handleMcpSecretSet(deps, { name: "GITHUB_TOKEN", value: SECRET });
    expect(result).toEqual({ ok: false, reason: "weak_storage_needs_consent" });
    expect(store.size).toBe(0);
  });

  it("C-16: weak storage WITH the existing consent setting writes the secret", async () => {
    const { deps, store } = fakeDeps({ weak: true, allowWeak: true });
    expect(await handleMcpSecretSet(deps, { name: "GITHUB_TOKEN", value: SECRET })).toEqual({
      ok: true,
      names: ["GITHUB_TOKEN"],
    });
    expect(store.size).toBe(1);
  });
});

describe("MCP secrets IPC — delete and refresh (Taskana 4752, C-17)", () => {
  it("C-17: delete is idempotent and returns the remaining names", async () => {
    const { deps } = fakeDeps();
    await handleMcpSecretSet(deps, { name: "A_TOKEN", value: "aaaa-value" });
    expect(await handleMcpSecretDelete(deps, { name: "A_TOKEN" })).toEqual({ ok: true, names: [] });
    expect(await handleMcpSecretDelete(deps, { name: "A_TOKEN" })).toEqual({ ok: true, names: [] });
    expect(await handleMcpSecretDelete(deps, { name: "NEVER_SET" })).toEqual({ ok: true, names: [] });
  });

  it("set and delete call onMutation after a successful write (refreshes the main-side fork cache)", async () => {
    const onMutation = vi.fn();
    const { deps } = fakeDeps({ onMutation });
    await handleMcpSecretSet(deps, { name: "A_TOKEN", value: "aaaa-value" });
    await handleMcpSecretDelete(deps, { name: "A_TOKEN" });
    expect(onMutation).toHaveBeenCalledTimes(2);
  });

  it("a rejected write does not trigger onMutation", async () => {
    const onMutation = vi.fn();
    const { deps } = fakeDeps({ weak: true, allowWeak: false, onMutation });
    await handleMcpSecretSet(deps, { name: "A_TOKEN", value: "aaaa-value" });
    expect(onMutation).not.toHaveBeenCalled();
  });

  it("the write-result names cover the whole store, not only the key just touched", async () => {
    const { deps } = fakeDeps();
    await handleMcpSecretSet(deps, { name: "FIRST_ONE", value: "one-value" });
    expect(await handleMcpSecretSet(deps, { name: "SECOND", value: "two-value" })).toEqual({
      ok: true,
      names: ["FIRST_ONE", "SECOND"],
    });
  });
});
