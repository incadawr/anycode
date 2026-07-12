/**
 * Plugin manifest schema tests (design slice-3.3-cut.md §3.6, test matrix §5.2
 * item 8 "manifest validation fail-soft"). Covers name-regex enforcement
 * (plugin name AND mcpServers keys), defaults, mcpServerEntrySchema reuse
 * (stdio/http shapes), and silent tolerance of unknown top-level keys.
 */

import { describe, expect, it } from "vitest";
import { pluginManifestSchema } from "./manifest.js";

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
