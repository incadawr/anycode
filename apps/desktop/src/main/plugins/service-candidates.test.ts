/**
 * Service candidate source (Taskana 4750a): builds the supervisor's desired set
 * from the Plugins admin scan. Hermetic fake fs; no Electron, no real process.
 */
import { describe, expect, it } from "vitest";
import type { FileSystemPort } from "@anycode/core";
import { servicesHash, type ServiceConsentEntry } from "@anycode/core/plugins-admin";
import { listServiceCandidates } from "./service-candidates.js";

const HOME = "/home/u";
const USER_PLUGINS = `${HOME}/.anycode/plugins`;
const STATE = `${USER_PLUGINS}/state.json`;
const WS = "/work/proj";

function makeFs(files: Record<string, string>, dirs: Record<string, string[]> = {}): FileSystemPort {
  return {
    readFile: async (path: string) => {
      if (!(path in files)) throw new Error(`ENOENT ${path}`);
      return files[path]!;
    },
    writeFile: async () => {},
    stat: async () => ({ size: 0, mtimeMs: 0, isFile: true, isDirectory: false }),
    exists: async (path: string) => path in files || path in dirs,
    mkdir: async () => {},
    readdir: async (path: string) => {
      if (!(path in dirs)) throw new Error(`ENOENT ${path}`);
      return [...dirs[path]!];
    },
  };
}

const SERVICES = [{ name: "relay", command: "node", args: ["./relay.js"], env: { TOKEN_FILE: "/private/value-abc" } }];

function managedBridge(status: "enabled" | "disabled" = "enabled"): Record<string, string> {
  const root = `${USER_PLUGINS}/.store/bridge/1.0.0`;
  return {
    [STATE]: JSON.stringify({
      version: 1,
      plugins: { bridge: { source: { kind: "official" }, trust: "official", active: "1.0.0", enabled: true, pinned: false, capabilities: [] } },
      removedDefaults: [],
      disabled: status === "disabled" ? ["bridge"] : [],
    }),
    [`${root}/.anycode-plugin/plugin.json`]: JSON.stringify({ name: "bridge", version: "1.0.0", services: SERVICES }),
  };
}

const deps = (fs: FileSystemPort, over: Partial<Parameters<typeof listServiceCandidates>[0]> = {}) => ({
  fs,
  home: HOME,
  appVersion: "0.0.36",
  liveWorkspaces: () => [] as string[],
  serviceConsent: async (): Promise<ServiceConsentEntry[]> => [],
  isWorkspaceTrusted: async () => false,
  ...over,
});

describe("listServiceCandidates (Taskana 4750a)", () => {
  it("a managed service carries its command, args and env VALUES to the supervisor only", async () => {
    const fs = makeFs(managedBridge());
    const out = await listServiceCandidates(deps(fs));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      plugin: "bridge",
      tier: "official",
      root: `${USER_PLUGINS}/.store/bridge/1.0.0`,
      enabled: true,
      consented: false,
      trusted: true,
      service: { name: "relay", command: "node", args: ["./relay.js"], env: { TOKEN_FILE: "/private/value-abc" } },
    });
  });

  it("consent counts only for the CURRENT servicesHash", async () => {
    const fs = makeFs(managedBridge());
    const granted = await listServiceCandidates(
      deps(fs, {
        serviceConsent: async () => [{ plugin: "bridge", servicesHash: servicesHash(SERVICES), grantedAt: "x" }],
      }),
    );
    expect(granted[0]!.consented).toBe(true);
    const stale = await listServiceCandidates(
      deps(fs, { serviceConsent: async () => [{ plugin: "bridge", servicesHash: "stale", grantedAt: "x" }] }),
    );
    expect(stale[0]!.consented).toBe(false);
  });

  it("a disabled plugin yields no runnable candidate (discovery skips it, so its services stop)", async () => {
    const fs = makeFs(managedBridge("disabled"));
    const out = await listServiceCandidates(deps(fs));
    expect(out.filter((c) => c.enabled)).toEqual([]);
  });

  it("re-enabling a legacy plugin makes its approved service runnable", async () => {
    const files = {
      [STATE]: JSON.stringify({ version: 1, plugins: {}, removedDefaults: [], disabled: ["legacy"] }),
      [`${USER_PLUGINS}/legacy/.anycode-plugin/plugin.json`]: JSON.stringify({ name: "legacy", services: SERVICES }),
    };
    const fs = makeFs(files, { [USER_PLUGINS]: ["legacy"] });
    const source = deps(fs, {
      serviceConsent: async () => [{ plugin: "legacy", servicesHash: servicesHash(SERVICES), grantedAt: "x" }],
    });
    expect((await listServiceCandidates(source))[0]).toMatchObject({ tier: "legacy-user", enabled: false, consented: true });
    files[STATE] = JSON.stringify({ version: 1, plugins: {}, removedDefaults: [], disabled: [] });
    expect((await listServiceCandidates(source))[0]).toMatchObject({ tier: "legacy-user", enabled: true, consented: true, trusted: true });
  });

  it("project-tier services come only from live workspaces and carry that workspace's trust", async () => {
    const files = {
      [`${WS}/.anycode/plugins/proj-bridge/.anycode-plugin/plugin.json`]: JSON.stringify({
        name: "proj-bridge",
        services: [{ name: "local", command: "./bin/run" }],
      }),
    };
    const dirs = { [`${WS}/.anycode/plugins`]: ["proj-bridge"] };
    const fs = makeFs(files, dirs);
    // Not a live workspace: nothing from the project folder.
    expect(await listServiceCandidates(deps(fs))).toEqual([]);
    // Live but untrusted: listed as untrusted.
    const untrusted = await listServiceCandidates(deps(fs, { liveWorkspaces: () => [WS], isWorkspaceTrusted: async () => false }));
    expect(untrusted).toHaveLength(1);
    expect(untrusted[0]).toMatchObject({ tier: "project", trusted: false, root: `${WS}/.anycode/plugins/proj-bridge` });
    // Live (listed twice) and trusted: one candidate, trusted.
    const trusted = await listServiceCandidates(deps(fs, { liveWorkspaces: () => [WS, WS], isWorkspaceTrusted: async () => true }));
    expect(trusted).toHaveLength(1);
    expect(trusted[0]!.trusted).toBe(true);
  });

  it("a plugin without services contributes no candidates", async () => {
    const fs = makeFs(
      { [`${USER_PLUGINS}/legacy/.anycode-plugin/plugin.json`]: JSON.stringify({ name: "legacy" }) },
      { [USER_PLUGINS]: ["legacy"] },
    );
    expect(await listServiceCandidates(deps(fs))).toEqual([]);
  });
});

describe("listServiceCandidates secret refs (Taskana 4751 part 0)", () => {
  const SECRET_SERVICES = [
    { name: "relay", command: "node", args: ["./relay.js"], env: { TOKEN: "${secret:BRIDGE_TOKEN}", USERS: "${secret:BRIDGE_USERS}" } },
  ];
  const withSecretServices = (): Record<string, string> => {
    const files = managedBridge();
    const manifestPath = `${USER_PLUGINS}/.store/bridge/1.0.0/.anycode-plugin/plugin.json`;
    files[manifestPath] = JSON.stringify({ name: "bridge", version: "1.0.0", services: SECRET_SERVICES });
    return files;
  };
  const granted = [{ plugin: "bridge", servicesHash: servicesHash(SECRET_SERVICES), grantedAt: "x" }];

  it("resolves the referenced names for an eligible service and reports the unset ones as missing", async () => {
    const requested: string[][] = [];
    const out = await listServiceCandidates(
      deps(makeFs(withSecretServices()), {
        serviceConsent: async () => granted,
        isWorkspaceTrusted: async () => true,
        resolveSecrets: async (names): Promise<Record<string, string>> => {
          requested.push([...names]);
          return names.includes("BRIDGE_TOKEN") ? { BRIDGE_TOKEN: "tok-resolved" } : {};
        },
      }),
    );
    expect(requested).toEqual([["BRIDGE_TOKEN", "BRIDGE_USERS"]]);
    expect(out[0]).toMatchObject({ secretValues: { BRIDGE_TOKEN: "tok-resolved" }, missingSecrets: ["BRIDGE_USERS"] });
  });

  it("reads no secret for a service that is not consented (it cannot start anyway)", async () => {
    let calls = 0;
    const out = await listServiceCandidates(
      deps(makeFs(withSecretServices()), {
        resolveSecrets: async () => {
          calls += 1;
          return {};
        },
      }),
    );
    expect(calls).toBe(0);
    expect(out[0]!.missingSecrets).toEqual([]);
  });
});
