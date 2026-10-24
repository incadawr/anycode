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
