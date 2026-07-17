/**
 * zod schema + migration skeleton for ~/.anycode/settings.json (design
 * slice-2.2-cut.md §2, frozen by task 2.2.1). node-only (zod runs here); the TS
 * types live in shared/settings.ts (value-only) and this schema is typed
 * `z.ZodType<AnycodeSettings>` so the compiler guarantees the two never drift
 * (precedent: main/tab-ipc.ts, main/settings-ipc.ts to come).
 *
 * This module is a SIBLING of main/ and host/ on purpose: main is the sole
 * writer of settings.json but the host reads it fail-soft on boot (§5), so the
 * schema must be importable by both without a host->main layering violation.
 *
 * SCOPE (2.2.1): the schema, the version/migration skeleton, the deep-partial
 * merge and the corrupt/newer-file parse policy are FINAL and unit-tested here.
 * No secret crypto lives in this module — that is main/vault.ts (2.2.2).
 */

import { z } from "zod";
import type { AnycodeSettings, SettingsPatch } from "../shared/settings.js";

/** The settings schema version this binary writes and understands (TASK.45: bumped to v2 — provider connections). */
export const CURRENT_SETTINGS_VERSION = 2 as const;

/** Canonical empty settings — every field present, secrets absent (they are a separate file). */
export const DEFAULT_SETTINGS: AnycodeSettings = {
  version: 2,
  provider: { connections: [] },
  tools: {},
  permissions: { alwaysAllow: [] },
  ui: { theme: "system" },
  security: { allowWeakSecretStorage: false },
};

/** Fresh deep copy of the defaults — never hand out the shared mutable object. */
export function cloneDefaults(): AnycodeSettings {
  return structuredClone(DEFAULT_SETTINGS);
}

const alwaysAllowRuleSchema = z.object({
  toolName: z.string(),
  pattern: z.string().optional(),
});

/** One persisted keybinding override (F20, slice-P7.24-cut.md §1, additive-optional). */
const keybindingOverrideSchema = z.object({
  action: z.string(),
  bindings: z.array(z.string()),
});

/**
 * The `keybindings` settings section (F20). Exported so main's settings-set trust
 * boundary can validate an incoming patch's `keybindings` before it is merged and
 * persisted — a malformed section (e.g. `bindings: null`, a non-array `overrides`,
 * wrong-typed chords) must never reach settings.json.
 */
export const keybindingsSchema = z.object({
  overrides: z.array(keybindingOverrideSchema),
});

/**
 * Strict-shape validator for a settings object. `.passthrough()` at the top
 * level keeps unknown keys from a future version alive across a read-modify-write
 * (design §2) — a v1 binary must not silently drop fields a v2 binary added.
 */
/** The three wire transports a provider selection can speak (TASK.43). */
const transportSchema = z.enum(["anthropic-messages", "openai-chat-completions", "openai-responses"]);

/** Per-model reasoning-effort tiers. */
const reasoningEffortSchema = z.enum(["off", "low", "medium", "high", "max"]);

/**
 * One `ProviderConnection` (TASK.45 settings v2). `id`/`providerId` are required;
 * every default is optional (a connection may exist with only a credential, or
 * only a remembered model). `lastHealth` is the advisory cache (W11 writes it).
 */
const connectionSchema = z.object({
  id: z.string(),
  providerId: z.string(),
  label: z.string().optional(),
  model: z.string().optional(),
  transport: transportSchema.optional(),
  baseUrl: z.string().optional(),
  reasoningEffort: reasoningEffortSchema.optional(),
  authOptional: z.boolean().optional(),
  lastHealth: z
    .object({
      status: z.enum([
        "needs_credential",
        "unchecked",
        "ready",
        "auth_invalid",
        "forbidden",
        "rate_limited",
        "unreachable",
        "misconfigured",
      ]),
      at: z.string(),
      safeCode: z.string().optional(),
    })
    .optional(),
});

export const settingsSchema: z.ZodType<AnycodeSettings> = z
  .object({
    version: z.literal(2),
    // Provider connections (TASK.45 settings v2 — replacing shape). The v1
    // singleton fields no longer exist here; `settingsMigrations[1]` resets the
    // provider block to empty on a v1 file (no v1-data carry-over — pre-beta,
    // there is no installed base of v1 credentials). `connections` is a required
    // array (empty on a fresh install); `activeConnectionId` is the default for
    // new sessions.
    provider: z.object({
      activeConnectionId: z.string().optional(),
      connections: z.array(connectionSchema),
    }),
    tools: z.object({
      concurrency: z.number().optional(),
      stallTimeoutMs: z.number().optional(),
      maxTurns: z.number().optional(),
    }),
    permissions: z.object({
      alwaysAllow: z.array(alwaysAllowRuleSchema),
    }),
    ui: z.object({
      theme: z.enum(["system", "light", "dark"]),
    }),
    security: z.object({
      allowWeakSecretStorage: z.boolean(),
    }),
    // Per-action keybinding overrides (F20, slice-P7.24-cut.md §1, additive-optional;
    // version NOT bumped, same forward-compat reasoning as `provider.id`/`provider.defaults`).
    // Declared explicitly (not left to .passthrough()) so it validates and survives a
    // read-modify-write cycle; absent on old files, parses to undefined.
    keybindings: z
      .object({
        overrides: z.array(keybindingOverrideSchema),
      })
      .optional(),
    // Codex onboarding metadata (TASK.41, cut §3.5, additive-optional; version
    // NOT bumped, same forward-compat reasoning as `keybindings`/`provider.id`
    // above). Declared explicitly (not left to .passthrough()) so it validates
    // and survives a read-modify-write cycle; absent on old files, parses to
    // undefined — settings.json with no `codex` key round-trips byte-identically.
    // `.catch(undefined)` (post-C0 review MED-2 fix): `codex` is an ADVISORY
    // cache field, not a functional setting — a foreign/wrong-shaped value at
    // this key (e.g. a future/other binary having written something
    // unrecognized here) must never fail the WHOLE document and fall the
    // loader through to `parseSettings`'s "corrupt -> replace with defaults"
    // path, which would silently drop every OTHER section (provider,
    // permissions, ...) the user actually configured. An invalid `codex`
    // value is dropped to `undefined` (same outcome as it being absent) while
    // every sibling field keeps validating normally.
    codex: z
      .object({
        binaryPath: z.string().optional(),
        lastCheck: z
          .object({
            status: z.enum(["ready", "not_installed", "update_required", "signed_out", "error"]),
            version: z.string().optional(),
            at: z.string(),
          })
          .optional(),
      })
      .optional()
      .catch(undefined),
  })
  .passthrough() as unknown as z.ZodType<AnycodeSettings>;

/** A migration lifts a settings object from schema version N to N+1. */
export type SettingsMigration = (input: Record<string, unknown>) => Record<string, unknown>;

/**
 * v1 -> v2 (TASK.45, owner-decision 2026-07-15): RESET, not carry-over. A v1
 * `provider.{id,model,baseUrl,transport,defaults}` block is replaced by an empty
 * v2 `provider: {connections: []}` — the user re-adds a connection. AnyCode is
 * pre-beta (`0.0.x`) with no installed base of v1 credentials, so there is
 * nothing to migrate; carrying v1 fields forward would be dead code. Every OTHER
 * top-level section (tools/permissions/ui/security/keybindings/codex + unknown
 * keys) passes through untouched and validates as usual — the reset touches ONLY
 * `provider`, so a v1 file loads to `ok` (never corrupt, never quarantined).
 * Legacy vault credentials are scrubbed separately on boot (main/index.ts).
 */
function resetV1Provider(input: Record<string, unknown>): Record<string, unknown> {
  return { ...input, version: 2, provider: { connections: [] } };
}

/**
 * Forward migration chain, keyed by source version: the loader walks
 * `settingsMigrations[v]` for v in [fileVersion, CURRENT) before validating. A
 * gap in the chain aborts the walk (falls through to schema parse, which fails
 * -> corrupt) rather than guessing.
 */
export const settingsMigrations: Record<number, SettingsMigration> = { 1: resetV1Provider };

/** Outcome of parsing a raw JSON value read from settings.json. */
export type SettingsParseResult =
  | { status: "ok"; settings: AnycodeSettings; readOnly: false }
  /** file version > CURRENT — read what validates, refuse all writes (§2). */
  | { status: "read_only"; settings: AnycodeSettings; readOnly: true }
  /** not an object / migration gap / schema-invalid — fall back to defaults; caller quarantines the file. */
  | { status: "corrupt"; settings: AnycodeSettings; readOnly: false };

/**
 * Parse a raw JSON value (already `JSON.parse`d) into settings, applying the
 * version policy of design §2:
 *  - non-object            -> corrupt (defaults)
 *  - version > CURRENT      -> read_only (salvage what validates, else defaults)
 *  - version in [.., CURRENT] -> run migrations, then schema-validate (fail -> corrupt)
 */
export function parseSettings(raw: unknown): SettingsParseResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { status: "corrupt", settings: cloneDefaults(), readOnly: false };
  }
  const obj = raw as Record<string, unknown>;
  const fileVersion = typeof obj.version === "number" ? obj.version : CURRENT_SETTINGS_VERSION;

  if (fileVersion > CURRENT_SETTINGS_VERSION) {
    // Newer file than this binary understands: salvage the fields that still
    // validate against the current shape, but surface readOnly so no write ever
    // clobbers the newer file with a downgraded copy.
    const salvaged = settingsSchema.safeParse({ ...obj, version: CURRENT_SETTINGS_VERSION });
    return {
      status: "read_only",
      settings: salvaged.success ? salvaged.data : cloneDefaults(),
      readOnly: true,
    };
  }

  let migrated: Record<string, unknown> = obj;
  for (let v = fileVersion; v < CURRENT_SETTINGS_VERSION; v++) {
    const migrate = settingsMigrations[v];
    if (!migrate) break; // chain gap -> let schema parse decide (will be corrupt)
    migrated = migrate(migrated);
  }

  const parsed = settingsSchema.safeParse(migrated);
  if (!parsed.success) {
    return { status: "corrupt", settings: cloneDefaults(), readOnly: false };
  }
  return { status: "ok", settings: parsed.data, readOnly: false };
}

/**
 * Deep-partial merge of a `settings-set` patch onto a base (design §3): plain
 * objects merge key-by-key, arrays and primitives replace wholesale, `undefined`
 * patch values are ignored (they never delete a base key). Returns a new object;
 * never mutates `base`.
 */
export function mergeSettings(base: AnycodeSettings, patch: SettingsPatch): AnycodeSettings {
  return deepMerge(base, patch) as AnycodeSettings;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge(base: unknown, patch: unknown): unknown {
  if (patch === undefined) return base;
  // Arrays and primitives on the patch replace the base wholesale.
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    out[key] = key in base ? deepMerge(base[key], value) : value;
  }
  return out;
}
