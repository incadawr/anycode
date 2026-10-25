/**
 * Plugin manifest schema v1 (Taskana 4732, design §2). A plugin is a
 * directory carrying `<dir>/.anycode-plugin/plugin.json`.
 *
 * v1 is ADDITIVE over the legacy (pre-4732) shape: every field the legacy
 * scanner knew (`name`, `version?`, `description?`, `skills`, `agents`,
 * `mcpServers?`) parses byte-identically, unknown top-level keys stay
 * silently ignored, and `manifestVersion` is optional — absent means legacy,
 * treated as the v1 subset. `manifestVersion > 1` is NOT a schema failure:
 * the schema accepts the integer and `discovery.ts` skips the plugin with a
 * "requires newer AnyCode" problem, so a future manifest never crashes an
 * older app (design §2 "Additive v1 fields never bump it").
 *
 * New v1 fields: `displayName`, `publisher` (informational only — the
 * `official` tier comes from signature/install path, never self-declared),
 * `author`, `homepage`, `license`, `engines.anycode` (compat range on the app
 * version via util/semver-range), `workflows` (default `["workflows"]`,
 * `*.json` definitions with the same schema as `.anycode/workflows`), plus
 * stage-2/3 placeholders `commands`, `hooks`, `docs`, `engineSupport`,
 * `promptOverlays` and a reserved `permissions` object — all parsed so a
 * v1-today app can reason about a plugin's declared shape, none of them
 * CONTRIBUTED by stage-1 discovery.
 *
 * The manifest embeds `mcpServerEntrySchema` verbatim for `mcpServers`, so
 * plugin servers inherit the SAME ${env:VAR} fail-closed / minimal-env /
 * ANYCODE_* scrub as explicit config — no separate trust logic. Both the
 * plugin `name` and every `mcpServers` key are validated against the shared
 * name alphabet (`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`), so the renamed
 * `plugin_<plugin>_<srv>` composite never needs re-sanitization.
 *
 * A bad JSON payload or ANY schema violation fails the WHOLE manifest — the
 * caller (discovery.ts) turns that into a single skip+problem for the
 * plugin, never a crash.
 */

import { z } from "zod";
import { mcpServerEntrySchema } from "../mcp/config.js";

/** Shared name alphabet for the plugin name and its mcpServers keys. */
export const PLUGIN_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const NAME_ERROR = "must match ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$";

/**
 * The manifest version this app understands. A manifest declaring a HIGHER
 * integer is skipped with "requires newer AnyCode" (design §2); additive v1
 * fields never bump this.
 */
export const MANIFEST_VERSION = 1;

/**
 * Directory-list schema shared by `skills`/`agents` (legacy fields: an
 * explicit `.default([...])` keeps their parsed output byte-identical to the
 * pre-4732 schema).
 */
const legacyDirList = (label: string) =>
  z
    .array(z.string().min(1, `${label} entry must be a non-empty string`))
    .default([label]);

/**
 * v1 `workflows` list: NO `.default()` at the schema level — a legacy
 * manifest's parsed output stays byte-identical (the regression suite freezes
 * it with exact toEqual). The v1 DEFAULT `["workflows"]` is applied by
 * `pluginWorkflowsDirs()` below, so consumers see one uniform rule while the
 * schema output for legacy manifests is unchanged.
 */
const workflowsList = z.array(z.string().min(1, "workflows entry must be a non-empty string")).optional();

export const pluginManifestSchema = z.object({
  /** Optional; absent = legacy manifest, treated as the v1 subset. */
  manifestVersion: z.number().int().min(1).optional(),
  name: z.string().regex(PLUGIN_NAME_RE, NAME_ERROR),
  /** Semver REQUIRED for managed/store installs (the installer rejects otherwise); optional for legacy/local. */
  version: z.string().optional(),
  displayName: z.string().optional(),
  description: z.string().optional(),
  /** Informational only — the `official` tier comes ONLY from signature/install path, never this field. */
  publisher: z.string().optional(),
  author: z
    .object({
      name: z.string().optional(),
      url: z.string().optional(),
    })
    .optional(),
  homepage: z.string().optional(),
  license: z.string().optional(),
  /** Compat range on the app version (util/semver-range grammar); absent = any. */
  engines: z.object({ anycode: z.string().optional() }).optional(),
  /** Directories (relative to the plugin root) contributing SKILL.md dirs. */
  skills: legacyDirList("skills"),
  /** Directories (relative to the plugin root) contributing *.md agent profiles. */
  agents: legacyDirList("agents"),
  /**
   * NEW s1: directories contributing flat `*.json` workflow definitions (same
   * schema as .anycode/workflows). Optional at the schema level (legacy
   * byte-compatibility); `pluginWorkflowsDirs()` applies the v1 default.
   */
  workflows: workflowsList,
  /** Server entries reusing the exact explicit-config shape; keys share the name alphabet. */
  mcpServers: z.record(z.string().regex(PLUGIN_NAME_RE, NAME_ERROR), mcpServerEntrySchema).optional(),
  // ── Stage 2/3 placeholders: PARSED (shape-known) but NOT contributed by s1 discovery. ──
  commands: z.array(z.string()).optional(),
  hooks: z.string().optional(),
  /** Official-only contribution (s2) — ignored with a problem on non-official plugins. */
  docs: z.string().optional(),
  engineSupport: z.record(z.string(), z.string()).optional(),
  /** Official-only contribution (s3). */
  promptOverlays: z.array(z.string()).optional(),
  /** Reserved for a future capability/consent grammar; not read in v1. */
  permissions: z.record(z.string(), z.unknown()).optional(),
});

export type PluginManifest = z.output<typeof pluginManifestSchema>;

/**
 * The v1 default applied OUTSIDE the schema: `workflows` defaults to
 * `["workflows"]` unless the manifest explicitly opts out with `[]`. Consumed
 * by discovery/bootstrap/admin so the rule lives in exactly one place.
 */
export function pluginWorkflowsDirs(manifest: PluginManifest): string[] {
  return manifest.workflows ?? ["workflows"];
}

/**
 * Derived (never self-declared) capability summary, design §2: what the
 * plugin's CONTENT actually contributes. `officialOnly` lists the
 * contributions that only an `official`-tier plugin may make (`docs`,
 * `engineSupport`, `promptOverlays`).
 */
export interface PluginCapabilities {
  skills: number;
  agents: number;
  workflows: number;
  mcp: string[];
  commands: number;
  hooks: boolean;
  docs: boolean;
  engineSupport: string[];
  promptOverlays: number;
}

/** The design's official-only contribution set (non-official → ignored with a problem). */
export const OFFICIAL_ONLY_CONTRIBUTIONS = ["docs", "engineSupport", "promptOverlays"] as const;

/** True when the manifest declares any official-only contribution. */
export function declaresOfficialOnly(manifest: PluginManifest): boolean {
  return (
    manifest.docs !== undefined ||
    (manifest.engineSupport !== undefined && Object.keys(manifest.engineSupport).length > 0) ||
    (manifest.promptOverlays !== undefined && manifest.promptOverlays.length > 0)
  );
}

/** Derives the capability summary from a parsed manifest (counts are of declared directories/entries). */
export function capabilities(manifest: PluginManifest): PluginCapabilities {
  return {
    skills: manifest.skills.length,
    agents: manifest.agents.length,
    workflows: pluginWorkflowsDirs(manifest).length,
    mcp: manifest.mcpServers ? Object.keys(manifest.mcpServers).sort() : [],
    commands: manifest.commands?.length ?? 0,
    hooks: manifest.hooks !== undefined,
    docs: manifest.docs !== undefined,
    engineSupport: manifest.engineSupport ? Object.keys(manifest.engineSupport).sort() : [],
    promptOverlays: manifest.promptOverlays?.length ?? 0,
  };
}
