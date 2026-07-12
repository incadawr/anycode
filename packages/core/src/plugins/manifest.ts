/**
 * Plugin manifest schema (design slice-3.3-cut.md §3.6, own format B1). A
 * plugin is a directory carrying `<dir>/.anycode-plugin/plugin.json`. The
 * manifest embeds `mcpServerEntrySchema` (§2.8) verbatim for its `mcpServers`
 * contribution, so plugin servers inherit the SAME ${env:VAR} fail-closed /
 * minimal-env / ANYCODE_* scrub as explicit config — no separate trust logic.
 *
 * Both the plugin `name` and every `mcpServers` key are validated against the
 * same name alphabet as SkillMeta.name (§2.1): `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`.
 * This guarantees the renamed `plugin_<plugin>_<srv>` composite (§3.6) never
 * needs the mcp bridge's `sanitizeSegment` fallback. Unknown top-level keys are
 * silently ignored (plain `z.object`, no `.strict()`/`.passthrough()` — mirrors
 * `mcpServerEntrySchema`/`mcpConfigFileSchema`), so ecosystem manifests with
 * extra fields do not fail validation. A bad JSON payload or ANY schema
 * violation (including a malformed name) fails the WHOLE manifest — the caller
 * (discovery.ts) turns that into a single skip+problem for the plugin, never a
 * crash.
 */

import { z } from "zod";
import { mcpServerEntrySchema } from "../mcp/config.js";

/** Shared name alphabet for the plugin name and its mcpServers keys (§3.6). */
export const PLUGIN_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const NAME_ERROR = "must match ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$";

export const pluginManifestSchema = z.object({
  name: z.string().regex(PLUGIN_NAME_RE, NAME_ERROR),
  version: z.string().optional(),
  description: z.string().optional(),
  /** Directories (relative to the plugin root) contributing SKILL.md dirs. */
  skills: z.array(z.string()).default(["skills"]),
  /** Directories (relative to the plugin root) contributing *.md agent profiles. */
  agents: z.array(z.string()).default(["agents"]),
  /** Server entries reusing the exact explicit-config shape; keys share the name alphabet. */
  mcpServers: z.record(z.string().regex(PLUGIN_NAME_RE, NAME_ERROR), mcpServerEntrySchema).optional(),
});

export type PluginManifest = z.output<typeof pluginManifestSchema>;
