/**
 * Host boot trust decision (Taskana 4736): the host computes `projectTrusted`
 * once at boot, reports a pending decision to the UI as display-only rows, and
 * honours the main-approved "trust once" hash from the fork env.
 */

import { describe, expect, it } from "vitest";
import type { FileSystemPort } from "@anycode/core";
import { collectProjectSpawnConfig, writeTrustDecision } from "@anycode/core/workspace-trust";
import { establishHostWorkspaceTrust } from "./workspace-trust.js";
import { WORKSPACE_TRUST_ONCE_ENV } from "../shared/workspace-trust.js";

const WS = "/proj";
const HOME = "/home/u";
const STORE = "/home/u/.anycode/workspace-trust.json";
const PROJECT_CONFIG = "/proj/.anycode/config.json";

const CONFIG = JSON.stringify({
  mcpServers: { lint: { command: "node", args: ["lint.js"], env: { TOKEN: "super-secret-value" } } },
  hooks: { PreToolUse: [{ command: "echo guard" }] },
});

function makeFs(files: Record<string, string>): FileSystemPort & { files: Map<string, string> } {
  const map = new Map(Object.entries(files));
  return {
    files: map,
    readFile: async (p) => {
      const c = map.get(p);
      if (c === undefined) throw new Error(`ENOENT ${p}`);
      return c;
    },
    writeFile: async (p, c) => {
      map.set(p, c);
    },
    rename: async (from, to) => {
      map.set(to, map.get(from)!);
      map.delete(from);
    },
    stat: async () => ({ size: 0, mtimeMs: 0, isFile: true, isDirectory: false }),
    exists: async (p) => map.has(p) || [...map.keys()].some((k) => k.startsWith(`${p}/`)),
    mkdir: async () => {},
    readdir: async () => [],
  };
}

describe("establishHostWorkspaceTrust", () => {
  it("an undecided folder boots untrusted and reports the pending declarations", async () => {
    const fs = makeFs({ [PROJECT_CONFIG]: CONFIG });
    const result = await establishHostWorkspaceTrust(fs, { workspace: WS, home: HOME, env: {} });
    expect(result.projectTrusted).toBe(false);
    expect(result.pending?.state).toBe("unknown");
    expect(result.pending?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.pending?.message).toMatchObject({
      type: "workspace_trust_required",
      state: "unknown",
      workspace: WS,
    });
    expect(result.pending?.message.items.map((i) => i.kind).sort()).toEqual(["hook", "mcp"]);
  });

  it("never puts env values (secrets) into the pending message", async () => {
    const fs = makeFs({ [PROJECT_CONFIG]: CONFIG });
    const result = await establishHostWorkspaceTrust(fs, { workspace: WS, home: HOME, env: {} });
    const serialized = JSON.stringify(result.pending?.message);
    expect(serialized).not.toContain("super-secret-value");
    expect(serialized).toContain("TOKEN");
  });

  it("a stored trusted decision for the same hash boots trusted with nothing pending", async () => {
    const fs = makeFs({ [PROJECT_CONFIG]: CONFIG });
    const { hash } = await collectProjectSpawnConfig(fs, WS, HOME);
    await writeTrustDecision(fs, STORE, WS, "trusted", hash);
    const result = await establishHostWorkspaceTrust(fs, { workspace: WS, home: HOME, env: {} });
    expect(result.projectTrusted).toBe(true);
    expect(result.pending).toBeUndefined();
  });

  it("a stored denial boots untrusted but is silent (no pending message)", async () => {
    const fs = makeFs({ [PROJECT_CONFIG]: CONFIG });
    const { hash } = await collectProjectSpawnConfig(fs, WS, HOME);
    await writeTrustDecision(fs, STORE, WS, "denied", hash);
    const result = await establishHostWorkspaceTrust(fs, { workspace: WS, home: HOME, env: {} });
    expect(result.projectTrusted).toBe(false);
    expect(result.pending).toBeUndefined();
  });

  it("a changed config re-prompts with state 'changed'", async () => {
    const fs = makeFs({ [PROJECT_CONFIG]: CONFIG });
    await writeTrustDecision(fs, STORE, WS, "trusted", "old-hash");
    const result = await establishHostWorkspaceTrust(fs, { workspace: WS, home: HOME, env: {} });
    expect(result.projectTrusted).toBe(false);
    expect(result.pending?.state).toBe("changed");
  });

  it("the main-approved trust-once hash trusts this boot and nothing is persisted", async () => {
    const fs = makeFs({ [PROJECT_CONFIG]: CONFIG });
    const first = await establishHostWorkspaceTrust(fs, { workspace: WS, home: HOME, env: {} });
    const hash = first.pending!.hash;
    const second = await establishHostWorkspaceTrust(fs, {
      workspace: WS,
      home: HOME,
      env: { [WORKSPACE_TRUST_ONCE_ENV]: hash },
    });
    expect(second.projectTrusted).toBe(true);
    expect(second.pending).toBeUndefined();
    expect(fs.files.has(STORE)).toBe(false);
  });

  it("a trust-once hash for a different config does not trust", async () => {
    const fs = makeFs({ [PROJECT_CONFIG]: CONFIG });
    const result = await establishHostWorkspaceTrust(fs, {
      workspace: WS,
      home: HOME,
      env: { [WORKSPACE_TRUST_ONCE_ENV]: "f".repeat(64) },
    });
    expect(result.projectTrusted).toBe(false);
  });

  it("no project declarations: trusted, nothing pending", async () => {
    const result = await establishHostWorkspaceTrust(makeFs({}), { workspace: WS, home: HOME, env: {} });
    expect(result.projectTrusted).toBe(true);
    expect(result.pending).toBeUndefined();
  });
});

// Taskana 4739: the host canonicalises the workspace with realpath, so a
// symlinked workspace shares one trust record with its target. The fake fs is
// not symlink-aware: the project config is visible under BOTH names (what a
// real symlink does) and the injected realpath maps link -> real.
describe("establishHostWorkspaceTrust with a symlinked workspace (Taskana 4739)", () => {
  const LINK_WS = "/work/link-project";
  const REAL_WS = "/work/real-project";
  const LINK_CONFIG = "/work/link-project/.anycode/config.json";
  const REAL_CONFIG = "/work/real-project/.anycode/config.json";

  const realpathSync = (p: string) => (p === LINK_WS ? REAL_WS : p);

  function linkedFs(files: Record<string, string> = {}) {
    return makeFs({ [LINK_CONFIG]: CONFIG, [REAL_CONFIG]: CONFIG, ...files });
  }

  it("a stored trusted record for the TARGET boots the symlink-opened workspace trusted", async () => {
    const fs = linkedFs();
    const { hash } = await collectProjectSpawnConfig(fs, LINK_WS, HOME);
    // The record sits under the real key, as main writes it since 4739.
    fs.files.set(
      STORE,
      `${JSON.stringify({ version: 1, folders: { [REAL_WS]: { decision: "trusted", hash, decidedAt: "t" } } })}\n`,
    );
    const result = await establishHostWorkspaceTrust(fs, {
      workspace: LINK_WS,
      home: HOME,
      env: {},
      realpathSync,
    });
    expect(result.projectTrusted).toBe(true);
    expect(result.pending).toBeUndefined();
  });

  it("a LEGACY symlink-name record still boots trusted (read fallback for pre-4739 stores)", async () => {
    const fs = linkedFs();
    const { hash } = await collectProjectSpawnConfig(fs, LINK_WS, HOME);
    fs.files.set(
      STORE,
      `${JSON.stringify({ version: 1, folders: { [LINK_WS]: { decision: "trusted", hash, decidedAt: "t" } } })}\n`,
    );
    const result = await establishHostWorkspaceTrust(fs, {
      workspace: LINK_WS,
      home: HOME,
      env: {},
      realpathSync,
    });
    expect(result.projectTrusted).toBe(true);
    expect(result.pending).toBeUndefined();
  });

  it("revoke -> asked again: after the record is removed the pending 'unknown' prompt is produced again", async () => {
    const fs = linkedFs();
    const { hash } = await collectProjectSpawnConfig(fs, LINK_WS, HOME);
    fs.files.set(
      STORE,
      `${JSON.stringify({ version: 1, folders: { [REAL_WS]: { decision: "trusted", hash, decidedAt: "t" } } })}\n`,
    );
    // The user forgets the folder (Settings → Permissions): the record is gone.
    fs.files.delete(STORE);
    const result = await establishHostWorkspaceTrust(fs, {
      workspace: LINK_WS,
      home: HOME,
      env: {},
      realpathSync,
    });
    expect(result.projectTrusted).toBe(false);
    expect(result.pending?.state).toBe("unknown");
    expect(result.pending?.message.workspace).toBe(LINK_WS);
  });
});
