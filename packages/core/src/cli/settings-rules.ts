/**
 * CLI-side read+write access to `~/.anycode/settings.json`'s
 * `permissions.alwaysAllow` section (design slice-P7.5-cut.md §3.1, TASK.8).
 *
 * Desktop main (`apps/desktop/src/settings/files.ts`/`settings-ipc.ts`) is
 * the strict-schema, quarantine-on-corrupt writer of the WHOLE settings.json
 * file. Core cannot import that app module (direction constraint: core never
 * depends on apps/desktop), so this module is a minimal, format-COMPATIBLE
 * sibling scoped to the one section the CLI needs. It is NOT a second file
 * format: same path, same v1 shape, same atomic tmp+rename/0644 write idiom —
 * proven byte-compatible by the desktop-side round-trip test (Wave 3).
 *
 * Two asymmetric roles on the same file:
 *  - `loadPersistedAlwaysAllowRules` is a lenient, hands-off READER: unlike
 *    desktop's `loadSettings`, it never quarantines a corrupt file — quarantine
 *    is a privilege of the sole whole-file writer (desktop main), and a
 *    CLI-side reader corrupting/replacing another client's file would be a
 *    regression, not a fix. Fail-soft here can only SHRINK the rule set it
 *    returns (skip malformed entries), never invent rules, so a corrupt file
 *    degrades to "no persisted rules" rather than granting anything.
 *  - `appendAlwaysAllowRule` is a narrow, fail-closed WRITER: it only ever
 *    touches `permissions.alwaysAllow`, refuses to touch a file it does not
 *    understand (wrong version, unparseable), and never throws — the caller
 *    always gets a result describing whether the rule survived a restart.
 */

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { PermissionRule } from "../types/permissions.js";
import { SessionPermissionRules } from "../permissions/rules.js";

/** `~/.anycode` directory permissions (owner-only traversal), byte-mirror of desktop files.ts. */
const ANYCODE_DIR_MODE = 0o700;
/** settings.json is human-editable/diffable — byte-mirror of desktop `SETTINGS_FILE_MODE`. */
const SETTINGS_FILE_MODE = 0o644;
/**
 * The current settings.json version this module CREATES (desktop
 * `CURRENT_SETTINGS_VERSION`, TASK.45 W9: v2). The append writer is
 * structure-preserving (it only ever rewrites `permissions.alwaysAllow`), so it
 * ACCEPTS any already-supported version (1 or 2) and only refuses a
 * newer-than-CURRENT file — see `SUPPORTED_WRITE_VERSIONS`.
 */
const CURRENT_VERSION = 2;
/** Versions the append writer will touch: v1 (legacy, desktop migrates it) or the current v2. A `> CURRENT` file is refused. */
const SUPPORTED_WRITE_VERSIONS = [1, 2];

/** `<home>/.anycode/settings.json` — byte-identical path to desktop `defaultSettingsPath`. */
export function defaultSettingsFilePath(home: string = homedir()): string {
  return join(home, ".anycode", "settings.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A well-shaped `{toolName, pattern?}` entry; anything else is skipped, never coerced. */
function isWellShapedRule(value: unknown): value is PermissionRule {
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value.toolName !== "string" || value.toolName.length === 0) {
    return false;
  }
  if (value.pattern !== undefined && typeof value.pattern !== "string") {
    return false;
  }
  return true;
}

/**
 * Lenient, fail-soft read of the persisted always-allow rules. Never throws,
 * never mutates the file. ENOENT / unparseable JSON / a non-object root / a
 * missing or non-array `permissions.alwaysAllow` all resolve to `[]`;
 * malformed entries within an otherwise-array section are skipped one at a
 * time, valid siblings survive. `version` is not checked on read — a rule
 * written by a newer binary is still a valid rule to seed a session with.
 */
export async function loadPersistedAlwaysAllowRules(path: string): Promise<PermissionRule[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return [];
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return [];
  }

  if (!isRecord(json)) {
    return [];
  }
  const permissions = json.permissions;
  if (!isRecord(permissions) || !Array.isArray(permissions.alwaysAllow)) {
    return [];
  }

  return permissions.alwaysAllow.filter(isWellShapedRule);
}

/** Outcome of `appendAlwaysAllowRule` — always resolves, never throws. */
export type AppendRuleResult =
  | { persisted: true }
  | { persisted: false; reason: "malformed" | "unsupported_version" | "io_error" };

/** Fresh `AnycodeSettings`-shaped default file, mirroring desktop `DEFAULT_SETTINGS` (v2). */
function defaultSettingsFile(rule: PermissionRule): Record<string, unknown> {
  return {
    version: CURRENT_VERSION,
    provider: { connections: [] },
    tools: {},
    permissions: { alwaysAllow: [rule] },
    ui: { theme: "system" },
    security: { allowWeakSecretStorage: false },
  };
}

function sameRule(a: PermissionRule, b: PermissionRule): boolean {
  return a.toolName === b.toolName && a.pattern === b.pattern;
}

/** Monotonic per-process counter folded into the tmp name so two writes in the same millisecond never collide. */
let tmpNameCounter = 0;

/** Durable write: sibling `*.tmp-*` then atomic `rename`, byte-mirror of desktop `atomicWrite`. */
async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: ANYCODE_DIR_MODE });
  tmpNameCounter += 1;
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${tmpNameCounter}`;
  const data = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(tmp, data, { mode: SETTINGS_FILE_MODE });
  await chmod(tmp, SETTINGS_FILE_MODE);
  await rename(tmp, path);
}

function errno(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * Per-path promise chain so concurrent `appendAlwaysAllowRule` calls against
 * the same file (same process, e.g. two `/allow` answers in flight together)
 * run their read-modify-write as a serialized queue instead of racing —
 * otherwise the second writer's read predates the first writer's rename and
 * its rewrite clobbers the first rule on last-rename-wins.
 */
const appendQueues = new Map<string, Promise<unknown>>();

function serializedByPath<T>(path: string, run: () => Promise<T>): Promise<T> {
  const previous = appendQueues.get(path) ?? Promise.resolve();
  const result = previous.then(run, run);
  appendQueues.set(
    path,
    result.then(
      () => undefined,
      () => undefined,
    ),
  );
  return result;
}

/**
 * Dedup-append `rule` into `permissions.alwaysAllow` at `path`, creating the
 * file (full desktop-`DEFAULT_SETTINGS` shape) when absent. Fail-closed on
 * anything it does not fully understand: a `version !== 1` file or an
 * unparseable/non-object file is left byte-untouched and reported back, NEVER
 * quarantined or overwritten — that would risk destroying another client's
 * (desktop's) settings. Never throws; IO failures resolve to `io_error`.
 */
export async function appendAlwaysAllowRule(path: string, rule: PermissionRule): Promise<AppendRuleResult> {
  return serializedByPath(path, () => appendAlwaysAllowRuleUnserialized(path, rule));
}

async function appendAlwaysAllowRuleUnserialized(path: string, rule: PermissionRule): Promise<AppendRuleResult> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if (errno(err) !== "ENOENT") {
      return { persisted: false, reason: "io_error" };
    }
    try {
      await atomicWriteJson(path, defaultSettingsFile(rule));
      return { persisted: true };
    } catch {
      return { persisted: false, reason: "io_error" };
    }
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { persisted: false, reason: "malformed" };
  }
  if (!isRecord(json)) {
    return { persisted: false, reason: "malformed" };
  }
  if (typeof json.version !== "number" || !SUPPORTED_WRITE_VERSIONS.includes(json.version)) {
    return { persisted: false, reason: "unsupported_version" };
  }
  // Targeted schema check, NOT a full desktop-zod re-implementation (passthrough
  // for every other section stays intact): a `permissions` that isn't a plain
  // object, or an `alwaysAllow` that isn't an array, means this v1 file is
  // schema-invalid and must be left untouched rather than silently coerced to
  // `{}`/`[]` and overwritten.
  if (json.permissions !== undefined && !isRecord(json.permissions)) {
    return { persisted: false, reason: "malformed" };
  }
  const permissions = isRecord(json.permissions) ? json.permissions : {};
  if (permissions.alwaysAllow !== undefined && !Array.isArray(permissions.alwaysAllow)) {
    return { persisted: false, reason: "malformed" };
  }

  const existing = Array.isArray(permissions.alwaysAllow) ? permissions.alwaysAllow.filter(isWellShapedRule) : [];
  const isDup = existing.some((existingRule) => sameRule(existingRule, rule));
  if (isDup) {
    return { persisted: true };
  }

  const updated = {
    ...json,
    permissions: { ...permissions, alwaysAllow: [...existing, rule] },
  };

  try {
    await atomicWriteJson(path, updated);
    return { persisted: true };
  } catch {
    return { persisted: false, reason: "io_error" };
  }
}

/**
 * A `SessionPermissionRules` whose `add` fire-and-forget persists every rule
 * to `~/.anycode/settings.json` via `persist`, reporting failures through
 * `onPersistFailure` while the rule still lives in the in-memory store
 * (session-only degrade, never lost mid-session). `seedPersisted` bulk-loads
 * boot-time rules through the base `add` WITHOUT persisting — otherwise a
 * boot-seed would immediately re-append every rule it just read, a no-op
 * write on every single boot. One class intercepts both CLI add paths
 * (`TerminalPermissionBroker`'s "a" answer and `/allow <Tool>`), since both
 * ultimately call `rules.add`.
 */
export class PersistingSessionPermissionRules extends SessionPermissionRules {
  constructor(
    private readonly persist: (rule: PermissionRule) => Promise<AppendRuleResult>,
    private readonly onPersistFailure: (rule: PermissionRule, reason: string) => void,
  ) {
    super();
  }

  override add(rule: PermissionRule): void {
    super.add(rule);
    void this.persist(rule)
      .then((result) => {
        if (!result.persisted) {
          this.onPersistFailure(rule, result.reason);
        }
      })
      .catch((err) => {
        // `persist` rejecting (it should only ever resolve, but is caller-supplied)
        // or `onPersistFailure` itself throwing above must never surface as an
        // unhandledRejection — this fire-and-forget has no promise for a caller
        // to await, so nothing else could ever observe or handle it.
        try {
          this.onPersistFailure(rule, err instanceof Error ? err.message : String(err));
        } catch {
          // Swallow: the failure callback's own throw must not escape either.
        }
      });
  }

  /** Seed rules read on boot into the store without re-persisting them. */
  seedPersisted(rules: readonly PermissionRule[]): void {
    for (const rule of rules) {
      super.add(rule);
    }
  }
}
