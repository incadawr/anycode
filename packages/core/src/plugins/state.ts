/**
 * Managed plugin store state (Taskana 4732 S1-A, design §3): `state.json`
 * under the user plugins root (`~/.anycode/plugins/state.json`). Main is the
 * SOLE writer; host-side discovery is read-only.
 *
 * The reader is FAIL-SOFT (mirrors every sibling discovery subsystem): a
 * missing file is the normal empty state (no problem), while corrupt JSON or
 * a schema violation yields the EMPTY state plus one `problems[]` entry — a
 * damaged state.json must never fail boot or hide the legacy hand-dropped
 * plugins; main rewrites the file on its next mutation anyway.
 *
 * `writePluginState` is atomic (tmp + rename, design §5 "rewrite state.json
 * (tmp+rename)") and deliberately NOT private-mode: unlike config.json, this
 * file holds no secrets (names, versions, hashes), so it lands 0644 like any
 * ordinary metadata file — the design's "written tmp+rename, 0644" ruling.
 */

import { createHash } from "node:crypto";
import type { FileSystemPort } from "../ports/file-system.js";
import { atomicWriteText, describeConfigError, isPlainObject } from "../util/config-file.js";
import { z } from "zod";

/** File name of the state file inside the user plugins root. */
export const PLUGIN_STATE_FILE = "state.json";

/** Design §3: state schema version. */
export const PLUGIN_STATE_VERSION = 1;

/** How a managed plugin was installed (design §3 `source`). */
const pluginSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("official") }),
  z.object({ kind: z.literal("url"), url: z.string() }),
  z.object({ kind: z.literal("file"), fileName: z.string() }),
  z.object({
    kind: z.literal("git"),
    url: z.string(),
    ref: z.string().optional(),
    commit: z.string().optional(),
  }),
  z.object({ kind: z.literal("local"), path: z.string() }),
]);

/** Trust tier recorded at install time by main (design §4: trust lives in state.json). */
export const pluginTrustSchema = z.enum(["official", "third-party", "local"]);
export type PluginTrust = z.output<typeof pluginTrustSchema>;

const pluginStateEntrySchema = z.object({
  source: pluginSourceSchema,
  trust: pluginTrustSchema,
  active: z.string(),
  previous: z.string().optional(),
  enabled: z.boolean().default(true),
  pinned: z.boolean().default(false),
  sha256: z.string().optional(),
  installedAt: z.string().optional(),
  capabilities: z.array(z.string()).default([]),
});

export type PluginStateEntry = z.output<typeof pluginStateEntrySchema>;

export const pluginsStateSchema = z.object({
  version: z.literal(PLUGIN_STATE_VERSION),
  plugins: z.record(z.string(), pluginStateEntrySchema).default({}),
  removedDefaults: z.array(z.string()).default([]),
  disabled: z.array(z.string()).default([]),
  lastIndexSerial: z.number().int().nonnegative().optional(),
});

export type PluginsState = z.output<typeof pluginsStateSchema>;

/** Canonical empty state (fresh boot with no managed plugins). */
export function emptyPluginState(): PluginsState {
  return {
    version: PLUGIN_STATE_VERSION,
    plugins: {},
    removedDefaults: [],
    disabled: [],
  };
}

export interface PluginStateReadResult {
  /** Parsed state; the EMPTY state when absent/corrupt (fail-soft). */
  state: PluginsState;
  problems: string[];
}

/**
 * Reads + validates the state file. Absent ⇒ empty state, no problem (the
 * overwhelmingly common pre-4732 world). Corrupt JSON / wrong shape ⇒ empty
 * state + exactly ONE problem — never throws.
 */
export async function readPluginState(
  fs: FileSystemPort,
  path: string,
): Promise<PluginStateReadResult> {
  if (!(await fs.exists(path))) {
    return { state: emptyPluginState(), problems: [] };
  }
  let raw: string;
  try {
    raw = await fs.readFile(path);
  } catch (error) {
    return {
      state: emptyPluginState(),
      problems: [`Could not read plugin state ${path}: ${describeConfigError(error)}`],
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      state: emptyPluginState(),
      problems: [`Invalid JSON in plugin state ${path}: ${describeConfigError(error)} — using empty state`],
    };
  }
  const result = pluginsStateSchema.safeParse(parsed);
  if (!result.success) {
    return {
      state: emptyPluginState(),
      problems: [
        `Invalid plugin state ${path}: ${result.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ")} — using empty state`,
      ],
    };
  }
  return { state: result.data, problems: [] };
}

/**
 * Atomic state write: 2-space-pretty JSON via tmp+rename. Mode 0644 (best
 * effort through the port's chmod) — no secrets live in this file. Throws on
 * write failure (main is the sole writer and must surface io errors).
 */
export async function writePluginState(
  fs: FileSystemPort,
  path: string,
  state: PluginsState,
): Promise<void> {
  const json = `${JSON.stringify(state, null, 2)}\n`;
  // atomicWriteText defaults a NEW file to 0600 (config.json discipline);
  // state.json is non-secret metadata by design, so pin 0644 after the write.
  await atomicWriteText(fs, path, json);
  if (typeof fs.chmod === "function") {
    try {
      await fs.chmod(path, 0o644);
    } catch {
      // best-effort — Windows ports may not implement chmod.
    }
  }
}

// ---------------------------------------------------------------------------
// MCP consent (design §4): `serversHash` = sha256 of canonical JSON of the
// plugin's mcpServers map, so ANY change to a command/arg/url needs fresh
// consent. Canonical form: RFC 8785-style key sorting, one entry per line —
// deterministic across platforms and JSON.stringify key-insertion orders.

/** Settings shape main reads/writes; discovery only consumes it read-only. */
export interface McpConsentEntry {
  plugin: string;
  serversHash: string;
  grantedAt: string;
}

/**
 * sha256 hex over the canonical JSON of an `mcpServers` map. `undefined`
 * (no servers) hashes the canonical "null" marker so an absent map and an
 * empty map never collide with each other.
 */
export function serversHash(mcpServers: unknown): string {
  return createHash("sha256").update(canonicalJson(mcpServers ?? null)).digest("hex");
}

/** Deterministic serialization: object keys sorted recursively, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value)
      .filter((k) => k !== "__proto__" && k !== "constructor" && k !== "prototype")
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** True when `consent` holds a CURRENT grant for `plugin` at `hash`. */
export function hasMcpConsent(
  consent: readonly McpConsentEntry[] | undefined,
  plugin: string,
  hash: string,
): boolean {
  return (consent ?? []).some((entry) => entry.plugin === plugin && entry.serversHash === hash);
}
