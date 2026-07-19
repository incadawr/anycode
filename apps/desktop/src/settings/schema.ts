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
  // Live-fetched model ids (connection-scoped fetch, main/provider-ipc.ts) —
  // advisory display data, same round-trip discipline as `lastHealth`.
  models: z.array(z.string()).optional(),
  modelsFetchedAt: z.string().optional(),
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

// ── codex-profiles (cut §2.3/§2.6, amended §A1.1) ──

/** Strict charset (cut §2.6): never a path — `..`/`/` are excluded by construction. */
const codexProfileIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);

/**
 * A `~/`-relative or absolute path — the ONLY shapes `authLink` AND
 * `linkedHome` accept (amended §A1.1.4, extended to `linkedHome` by the C0
 * review F1 ruling: a relative `linkedHome` would resolve against process
 * cwd on its way into the child's `CODEX_HOME`). Tilde expansion happens in
 * main, in ONE place, for both fields.
 */
function isTildeOrAbsolutePath(value: string): boolean {
  return value.startsWith("~/") || value.startsWith("/");
}

const codexDoctorStatusSchema = z.enum(["ready", "not_installed", "update_required", "signed_out", "error"]);

/**
 * One `CodexProfileRecord` (amended §A1.1). `authLink` ⊕ `linkedHome` are
 * enforced MUTUALLY EXCLUSIVE by a per-element `refine` — a record with both
 * (or a malformed id/path) is a BAD element, dropped whole by
 * `parseElementsTolerantly` below WITHOUT failing the array or the
 * containing `codex` block (cut §2.3 zod-granularity, amended §A1.1 rule 3b).
 */
const codexProfileSchema = z
  .object({
    id: codexProfileIdSchema,
    label: z.string(),
    createdAt: z.string(),
    linkedHome: z.string().refine(isTildeOrAbsolutePath).optional(),
    authLink: z.string().refine(isTildeOrAbsolutePath).optional(),
    lastCheck: z
      .object({
        status: codexDoctorStatusSchema,
        version: z.string().optional(),
        at: z.string(),
      })
      .optional(),
  })
  .refine((profile) => !(profile.linkedHome !== undefined && profile.authLink !== undefined), {
    message: "authLink and linkedHome are mutually exclusive (amended §A1.1 rule 3)",
  });

/**
 * Filters an array-shaped raw value down to only the elements that validate
 * against `schema`, silently dropping the rest — the per-element `.catch`
 * granularity the cut requires (§2.3/§14.3 point 5): a single bad profile
 * (or custom-provider) record must never blank its siblings, and must never
 * cause the CONTAINING object (which also carries `binaryPath`) to fall back
 * to `undefined`. Non-array input parses to an empty array (same "absent ⇒
 * safe default" policy as the rest of this advisory-cache field).
 */
function parseElementsTolerantly<T>(schema: z.ZodType<T>, raw: unknown): T[] {
  if (!Array.isArray(raw)) return [];
  const out: T[] = [];
  for (const element of raw) {
    const result = schema.safeParse(element);
    if (result.success) out.push(result.data);
  }
  return out;
}

const codexProfilesArraySchema = z.preprocess(
  (raw) => parseElementsTolerantly(codexProfileSchema, raw),
  z.array(codexProfileSchema),
);

// ── custom model-provider endpoints (cut §9.2) ──

const customProviderKindSchema = z.enum(["openai-compatible", "anthropic", "openai"]);

/**
 * The ONE loopback host set (localhost/127.0.0.1/[::1]) both URL predicates
 * below key off — never two drifting copies (amendment-1 FX2-1 discipline).
 * Node's `URL.hostname` keeps the brackets on an IPv6 literal, hence `[::1]`.
 */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * `https://` (no embedded userinfo) always allowed; `http://` allowed ONLY
 * for loopback (localhost/127.0.0.1/[::1]), also no embedded userinfo (cut
 * §9.2 threat list, amendment-1 FX2-1: a `user:pass@host` userinfo component
 * is rejected for every scheme — a secret placed there would otherwise
 * round-trip into settings.json and back out to the renderer as plain
 * baseUrl text instead of living only in the vault).
 *
 * The single source of truth for this predicate — main/provider-ipc.ts
 * imports and re-exports it rather than keeping its own copy.
 */
export function isHttpsOrLocalhostUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username !== "" || url.password !== "") return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && LOOPBACK_HOSTNAMES.has(url.hostname);
}

/**
 * True when `value` parses as a URL whose host is a loopback literal
 * (localhost/127.0.0.1/[::1]), any scheme. Shares `LOOPBACK_HOSTNAMES` with
 * `isHttpsOrLocalhostUrl` so the two predicates can never disagree on what
 * "loopback" means (FX3-L1 G-A: the origin-rebind custody guard in
 * main/provider-ipc.ts waives its re-key requirement only for a
 * loopback→loopback baseUrl change — e.g. a corrected local port — because
 * the stored key never leaves this machine on either origin).
 */
export function isLoopbackUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return LOOPBACK_HOSTNAMES.has(url.hostname);
}

/**
 * One `CustomProviderRecord` (cut §9.2) — same per-element-catch discipline as
 * `codexProfileSchema`.
 *
 * W4-R1-M1 (namespace custody): `id` is pinned to the `custom:` vault namespace
 * — the same prefix main/host-env.ts's `CUSTOM_PROVIDER_PREFIX` /
 * `isCustomProviderRecordId` and provider-ipc.ts's `customProviderSecretKey`
 * key off (kept as a literal here so this shared, electron-free module never
 * imports main). Without it a hand-edited (or corrupt/migrated) record could
 * carry a foreign id — a `connection.<victim>` connection key or a bare catalog
 * id like `anthropic` — and a `custom-provider-fetch-models {id}` would then
 * decrypt that OTHER namespace's vault key and POST it to the record's
 * attacker-chosen baseUrl (cross-namespace credential exfil). A mis-namespaced
 * record is dropped whole by `parseElementsTolerantly` (never throws, never
 * blanks its siblings) so it never reaches the catalog and fetch-models can
 * never resolve it.
 */
const customProviderSchema = z.object({
  id: z.string().refine((value) => value.startsWith("custom:"), {
    message: "custom-provider id must live in the custom: vault namespace (W4-R1-M1)",
  }),
  name: z.string(),
  baseUrl: z.string().refine(isHttpsOrLocalhostUrl, {
    message: "baseUrl must be https: or http: scoped to localhost/127.0.0.1/[::1], with no embedded userinfo",
  }),
  kind: customProviderKindSchema,
  models: z.array(z.string()),
  modelsFetchedAt: z.string().optional(),
  // TASK.58: only-truthy-on-disk keyless declaration (see CustomProviderRecord).
  authOptional: z.boolean().optional(),
});

const customProvidersArraySchema = z.preprocess(
  (raw) => parseElementsTolerantly(customProviderSchema, raw),
  z.array(customProviderSchema),
);

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
      // Custom model-provider endpoints (owner-decision #6, cut §9.2,
      // additive-optional). Per-element `.catch` granularity, same
      // discipline as `codex.profiles` below — one malformed custom-provider
      // record never disturbs its siblings or `connections`.
      custom: customProvidersArraySchema.optional(),
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
    //
    // codex-profiles cut §2.3 "zod-granularity" fix (this block used to sit
    // under ONE `.catch(undefined)` for the whole object, so a single bad
    // `profiles[i]` element would previously have wiped `binaryPath` too):
    // `profiles`/`custom` (provider.custom above) now validate PER ELEMENT
    // via `parseElementsTolerantly`, so a malformed profile record is
    // dropped alone — `binaryPath` and every valid sibling profile survive.
    // The outer `.catch(undefined)` remains as the fallback for a
    // genuinely wrong-shaped `codex` value as a whole (e.g. `codex` itself
    // is a string, not an object).
    codex: z
      .object({
        binaryPath: z.string().optional(),
        lastCheck: z
          .object({
            status: codexDoctorStatusSchema,
            version: z.string().optional(),
            at: z.string(),
          })
          .optional(),
        // Codex account profiles (cut §2.3, amended §A1.1). Per-element
        // catch: see codexProfilesArraySchema above.
        profiles: codexProfilesArraySchema.optional(),
        activeProfileId: z.string().optional(),
        // Risk-accepted out-of-range versions (cut §7.4) — a plain string
        // array; a malformed (non-string) entry is dropped via the same
        // tolerant-array helper rather than failing the whole list.
        riskAcceptedVersions: z
          .preprocess(
            (raw) => (Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === "string") : []),
            z.array(z.string()),
          )
          .optional(),
      })
      .optional()
      .catch(undefined),
    // Claude engine onboarding metadata (SLICE-CC A1, cut §1.2, additive-optional;
    // version NOT bumped, same forward-compat reasoning as `codex` above).
    // `.catch(undefined)`: `claude` is an ADVISORY cache field, not a functional
    // setting — a foreign/wrong-shaped value here must never fail the whole
    // document (same reasoning as `codex`'s own outer catch). No per-element
    // array validation needed yet (CC-A has no `profiles` array).
    claude: z
      .object({
        binaryPath: z.string().optional(),
        lastCheck: z
          .object({
            status: codexDoctorStatusSchema,
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
