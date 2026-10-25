/**
 * Plugin manifest schema tests (design slice-3.3-cut.md §3.6, test matrix §5.2
 * item 8 "manifest validation fail-soft"). Covers name-regex enforcement
 * (plugin name AND mcpServers keys), defaults, mcpServerEntrySchema reuse
 * (stdio/http shapes), and silent tolerance of unknown top-level keys.
 */

import { describe, expect, it } from "vitest";
import { expandServiceSecrets, pluginManifestSchema, serviceSecretRefs } from "./manifest.js";

describe("pluginManifestSchema — name validation", () => {
  it("accepts a minimal manifest (only name) and applies defaults", () => {
    const result = pluginManifestSchema.safeParse({ name: "my-plugin" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        name: "my-plugin",
        skills: ["skills"],
        agents: ["agents"],
      });
    }
  });

  it("accepts version/description and passes them through unchanged", () => {
    const result = pluginManifestSchema.safeParse({
      name: "p",
      version: "1.2.3",
      description: "does a thing",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.version).toBe("1.2.3");
      expect(result.data.description).toBe("does a thing");
    }
  });

  it.each(["", "-leading-dash", "has space", "has/slash", "a".repeat(65)])(
    "rejects an invalid plugin name %p",
    (name) => {
      const result = pluginManifestSchema.safeParse({ name });
      expect(result.success).toBe(false);
    },
  );

  it.each(["a", "A1", "under_score", "with-dash", "a".repeat(64)])(
    "accepts a valid plugin name %p",
    (name) => {
      const result = pluginManifestSchema.safeParse({ name });
      expect(result.success).toBe(true);
    },
  );
});

describe("pluginManifestSchema — skills/agents contribution lists", () => {
  it("defaults to [\"skills\"] / [\"agents\"] when omitted", () => {
    const result = pluginManifestSchema.safeParse({ name: "p" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.skills).toEqual(["skills"]);
      expect(result.data.agents).toEqual(["agents"]);
    }
  });

  it("an explicit empty array opts out (does not fall back to the default)", () => {
    const result = pluginManifestSchema.safeParse({ name: "p", skills: [], agents: [] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.skills).toEqual([]);
      expect(result.data.agents).toEqual([]);
    }
  });

  it("an explicit custom list is used as-is", () => {
    const result = pluginManifestSchema.safeParse({ name: "p", skills: ["a", "b"], agents: ["c"] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.skills).toEqual(["a", "b"]);
      expect(result.data.agents).toEqual(["c"]);
    }
  });
});

describe("pluginManifestSchema — mcpServers reuses mcpServerEntrySchema verbatim", () => {
  it("accepts a stdio entry", () => {
    const result = pluginManifestSchema.safeParse({
      name: "p",
      mcpServers: { srv: { command: "node", args: ["server.js"], env: { A: "1" } } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mcpServers).toEqual({
        srv: { command: "node", args: ["server.js"], env: { A: "1" } },
      });
    }
  });

  it("accepts an http entry", () => {
    const result = pluginManifestSchema.safeParse({
      name: "p",
      mcpServers: { srv: { url: "https://example.com/mcp", headers: { X: "1" } } },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an mcpServers key that fails the name regex, failing the WHOLE manifest", () => {
    const result = pluginManifestSchema.safeParse({
      name: "p",
      mcpServers: { "bad key!": { command: "node" } },
    });
    expect(result.success).toBe(false);
  });

  it("mcpServers is optional (a manifest with none is still valid)", () => {
    const result = pluginManifestSchema.safeParse({ name: "p" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mcpServers).toBeUndefined();
    }
  });
});

describe("pluginManifestSchema — unknown top-level keys are silently ignored", () => {
  it("does not fail on an ecosystem-style extra key, and drops it from the output", () => {
    const result = pluginManifestSchema.safeParse({
      name: "p",
      color: "blue",
      model: "opus",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty("color");
      expect(result.data).not.toHaveProperty("model");
    }
  });
});

describe("pluginManifestSchema — fail-soft shape (missing/invalid required field)", () => {
  it("rejects a manifest with no name at all", () => {
    const result = pluginManifestSchema.safeParse({ version: "1.0" });
    expect(result.success).toBe(false);
  });

  it("rejects a non-object payload", () => {
    const result = pluginManifestSchema.safeParse("not an object");
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Taskana 4732 S1-A — manifest v1 (design §2). Legacy suites above are the
// byte-identical regression: their exact toEqual assertions still pass with
// the v1 schema, proving an ecosystem manifest parses EXACTLY as today.

import {
  MANIFEST_VERSION,
  OFFICIAL_ONLY_CONTRIBUTIONS,
  capabilities,
  declaresOfficialOnly,
  pluginWorkflowsDirs,
} from "./manifest.js";

describe("pluginManifestSchema — v1 additive fields", () => {
  it("manifestVersion is optional; absent parses as legacy (the v1 subset)", () => {
    const result = pluginManifestSchema.safeParse({ name: "legacy" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.manifestVersion).toBeUndefined();
    }
  });

  it("manifestVersion: 1 parses and passes through; MANIFEST_VERSION is 1", () => {
    const result = pluginManifestSchema.safeParse({ name: "p", manifestVersion: 1 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.manifestVersion).toBe(1);
    }
    expect(MANIFEST_VERSION).toBe(1);
  });

  it("a legacy manifest parses byte-identically (no new defaults leak into it)", () => {
    const result = pluginManifestSchema.safeParse({
      name: "my-plugin",
      version: "1.2.3",
      description: "does a thing",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // EXACTLY the legacy parsed shape — the v1 `workflows` default is
      // applied outside the schema (pluginWorkflowsDirs), so a legacy
      // manifest's schema output is unchanged.
      expect(result.data).toEqual({
        name: "my-plugin",
        version: "1.2.3",
        description: "does a thing",
        skills: ["skills"],
        agents: ["agents"],
      });
    }
  });

  it("accepts the full v1 metadata set and passes values through unchanged", () => {
    const raw = {
      manifestVersion: 1,
      name: "anycode-essentials",
      version: "1.4.2",
      displayName: "AnyCode Essentials",
      description: "official essentials",
      publisher: "anycode",
      author: { name: "AnyCode", url: "https://example.com" },
      homepage: "https://example.com/home",
      license: "MIT",
      engines: { anycode: ">=0.0.35 <0.2.0" },
      skills: ["skills"],
      agents: ["agents"],
      workflows: ["workflows"],
    };
    const result = pluginManifestSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.displayName).toBe("AnyCode Essentials");
      expect(result.data.publisher).toBe("anycode");
      expect(result.data.author).toEqual({ name: "AnyCode", url: "https://example.com" });
      expect(result.data.license).toBe("MIT");
      expect(result.data.engines).toEqual({ anycode: ">=0.0.35 <0.2.0" });
    }
  });

  it("workflows defaults to [\"workflows\"] via pluginWorkflowsDirs; explicit values pass through", () => {
    const minimal = pluginManifestSchema.parse({ name: "p" });
    expect(minimal.workflows).toBeUndefined(); // schema output stays legacy-identical
    expect(pluginWorkflowsDirs(minimal)).toEqual(["workflows"]);
    expect(pluginWorkflowsDirs(pluginManifestSchema.parse({ name: "p", workflows: [] }))).toEqual([]);
    expect(pluginWorkflowsDirs(pluginManifestSchema.parse({ name: "p", workflows: ["w"] }))).toEqual(["w"]);
  });

  it("engines is optional and engines.anycode itself is optional (absent = any)", () => {
    expect(pluginManifestSchema.safeParse({ name: "p" }).data?.engines).toBeUndefined();
    expect(pluginManifestSchema.safeParse({ name: "p", engines: {} }).data?.engines).toEqual({});
  });

  it("rejects a non-integer or non-positive manifestVersion (schema-level, not a skip)", () => {
    expect(pluginManifestSchema.safeParse({ name: "p", manifestVersion: 1.5 }).success).toBe(false);
    expect(pluginManifestSchema.safeParse({ name: "p", manifestVersion: 0 }).success).toBe(false);
    expect(pluginManifestSchema.safeParse({ name: "p", manifestVersion: "1" }).success).toBe(false);
  });

  it("accepts stage-2/3 placeholders without contributing them (shape-known, value-kept)", () => {
    const result = pluginManifestSchema.safeParse({
      name: "p",
      commands: ["commands"],
      hooks: "hooks/hooks.json",
      docs: "docs",
      engineSupport: { codex: "engine/codex-support.json" },
      promptOverlays: ["overlays"],
      permissions: { mcp: { allow: ["*"] } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.commands).toEqual(["commands"]);
      expect(result.data.hooks).toBe("hooks/hooks.json");
      expect(result.data.docs).toBe("docs");
      expect(result.data.engineSupport).toEqual({ codex: "engine/codex-support.json" });
      expect(result.data.promptOverlays).toEqual(["overlays"]);
      expect(result.data.permissions).toEqual({ mcp: { allow: ["*"] } });
    }
  });

  it("rejects an empty-string directory entry in skills/agents/workflows", () => {
    expect(pluginManifestSchema.safeParse({ name: "p", skills: [""] }).success).toBe(false);
    expect(pluginManifestSchema.safeParse({ name: "p", workflows: [""] }).success).toBe(false);
  });
});

describe("capabilities() — derived, never self-declared (design §2)", () => {
  it("derives the summary from content, including sorted mcp names", () => {
    const parsed = pluginManifestSchema.safeParse({
      name: "p",
      skills: ["a", "b"],
      agents: [],
      workflows: ["w"],
      mcpServers: { zeta: { command: "node" }, alpha: { command: "node" } },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(capabilities(parsed.data)).toEqual({
        skills: 2,
        agents: 0,
        workflows: 1,
        mcp: ["alpha", "zeta"],
        commands: 0,
        hooks: false,
        docs: false,
        engineSupport: [],
        promptOverlays: 0,
        services: [],
      });
    }
  });

  it("a minimal manifest derives the default capability set", () => {
    const parsed = pluginManifestSchema.safeParse({ name: "p", skills: [], agents: [], workflows: [] });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(capabilities(parsed.data).mcp).toEqual([]);
      expect(capabilities(parsed.data).skills).toBe(0);
    }
  });
});

describe("declaresOfficialOnly — official-only contributions (design §2/§4)", () => {
  it("false for a plain manifest; true for docs / engineSupport / promptOverlays", () => {
    expect(declaresOfficialOnly(pluginManifestSchema.parse({ name: "p" }))).toBe(false);
    expect(declaresOfficialOnly(pluginManifestSchema.parse({ name: "p", docs: "docs" }))).toBe(true);
    expect(
      declaresOfficialOnly(pluginManifestSchema.parse({ name: "p", engineSupport: { codex: "e.json" } })),
    ).toBe(true);
    expect(declaresOfficialOnly(pluginManifestSchema.parse({ name: "p", promptOverlays: ["o"] }))).toBe(true);
    // An EMPTY engineSupport record declares nothing.
    expect(declaresOfficialOnly(pluginManifestSchema.parse({ name: "p", engineSupport: {} }))).toBe(false);
    // An EMPTY promptOverlays list declares nothing.
    expect(declaresOfficialOnly(pluginManifestSchema.parse({ name: "p", promptOverlays: [] }))).toBe(false);
  });

  it("OFFICIAL_ONLY_CONTRIBUTIONS is the design's fixed set", () => {
    expect([...OFFICIAL_ONLY_CONTRIBUTIONS]).toEqual(["docs", "engineSupport", "promptOverlays"]);
  });
});

describe("pluginManifestSchema — services (Taskana 4750a)", () => {
  const base = { name: "bridge" };

  it("services absent keeps legacy output identical", () => {
    const parsed = pluginManifestSchema.safeParse(base);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).not.toHaveProperty("services");
      expect(capabilities(parsed.data).services).toEqual([]);
    }
  });

  it("services parses name command args env", () => {
    const parsed = pluginManifestSchema.safeParse({
      ...base,
      services: [
        { name: "relay", command: "node", args: ["./dist/relay.js", "--x"], env: { LOG_LEVEL: "debug" } },
        { name: "helper", command: "./bin/helper" },
      ],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.services).toEqual([
        { name: "relay", command: "node", args: ["./dist/relay.js", "--x"], env: { LOG_LEVEL: "debug" } },
        { name: "helper", command: "./bin/helper" },
      ]);
      expect(capabilities(parsed.data).services).toEqual(["helper", "relay"]);
    }
  });

  it("accepts an absolute command path", () => {
    expect(pluginManifestSchema.safeParse({ ...base, services: [{ name: "s", command: "/usr/bin/env" }] }).success).toBe(true);
  });

  it("duplicate service name fails the manifest", () => {
    const parsed = pluginManifestSchema.safeParse({
      ...base,
      services: [
        { name: "s", command: "node" },
        { name: "s", command: "deno" },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it("invalid service name fails the manifest", () => {
    expect(pluginManifestSchema.safeParse({ ...base, services: [{ name: "bad name", command: "node" }] }).success).toBe(false);
  });

  it("empty command fails the manifest", () => {
    expect(pluginManifestSchema.safeParse({ ...base, services: [{ name: "s", command: "" }] }).success).toBe(false);
  });

  it("a relative command without ./ and with a separator fails, and ../ escapes fail", () => {
    expect(pluginManifestSchema.safeParse({ ...base, services: [{ name: "s", command: "bin/x" }] }).success).toBe(false);
    expect(pluginManifestSchema.safeParse({ ...base, services: [{ name: "s", command: "../x" }] }).success).toBe(false);
  });

  it("reserved ANYCODE_ env key fails", () => {
    expect(
      pluginManifestSchema.safeParse({ ...base, services: [{ name: "s", command: "node", env: { ANYCODE_SESSIONS_DISCOVERY: "/x" } } ] }).success,
    ).toBe(false);
  });

  it("invalid env key fails", () => {
    expect(pluginManifestSchema.safeParse({ ...base, services: [{ name: "s", command: "node", env: { "1BAD": "x" } }] }).success).toBe(false);
    expect(pluginManifestSchema.safeParse({ ...base, services: [{ name: "s", command: "node", env: { "A-B": "x" } }] }).success).toBe(false);
  });
});

// Taskana 4751 part 0: `${secret:NAME}` in service env values.
describe("service env secret references (Taskana 4751 part 0)", () => {
  it("serviceSecretRefs returns the referenced names, sorted and unique", async () => {
    expect(
      serviceSecretRefs({
        env: { B: "${secret:BRIDGE_USERS}", A: "x-${secret:BRIDGE_TOKEN}-${secret:BRIDGE_TOKEN}", C: "plain" },
      }),
    ).toEqual(["BRIDGE_TOKEN", "BRIDGE_USERS"]);
    expect(serviceSecretRefs({})).toEqual([]);
  });

  it("env var ${env:X} is not interpolated", async () => {
    const service = { env: { HOME_DIR: "${env:HOME}", BAD: "${secret:bad-name}" } };
    expect(serviceSecretRefs(service)).toEqual([]);
    expect(expandServiceSecrets("${env:HOME}", { HOME: "/x" })).toBe("${env:HOME}");
    expect(expandServiceSecrets("${secret:bad-name}", { "bad-name": "v" })).toBe("${secret:bad-name}");
    expect(expandServiceSecrets("a${secret:T}b${secret:MISSING}", { T: "1" })).toBe("a1b${secret:MISSING}");
    // A substituted value is never re-scanned.
    expect(expandServiceSecrets("${secret:T}", { T: "${secret:U}", U: "boom" })).toBe("${secret:U}");
  });

  it("a manifest with secret refs in service env parses and keeps the literal reference", () => {
    const parsed = pluginManifestSchema.safeParse({
      name: "bridge",
      services: [{ name: "relay", command: "node", args: ["./r.mjs"], env: { TOKEN: "${secret:TOKEN}" } }],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.services?.[0]?.env).toEqual({ TOKEN: "${secret:TOKEN}" });
  });
});
