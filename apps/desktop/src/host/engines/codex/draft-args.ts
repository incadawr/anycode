/**
 * The draft (pre-session) Codex model/preset choice, carried from main into the
 * forked host as argv (cut §3.8: "Драфт-выбор передаётся в host аддитивными
 * argv-флагами `--engine-model` / `--engine-preset`").
 *
 * argv is UNTRUSTED input as far as this module is concerned — it originates in
 * the renderer's draft picker. Nothing here interprets, resolves or applies a
 * value: it only extracts two bounded, opaque strings. Both are validated
 * host-authoritatively later — the model against the live `model/list` catalog
 * (catalog.ts), the preset against the frozen table (presets.ts) — and an
 * unrecognized value degrades to the default rather than reaching the wire.
 * There is deliberately no argv path for a raw sandbox/approval/config payload
 * (TASK.39 DoD: "the renderer can never send an invalid model, sandbox, or raw
 * config JSON").
 *
 * Kept out of host/boot.ts's `parseHostArgs` on purpose: these flags are
 * engine-scoped and only the Codex boot branch ever reads them, so the core
 * host's argv contract stays byte-identical.
 */

/** Bounds a hostile/garbled argv value; mirrors the zod bounds on the equivalent UI messages. */
const MAX_VALUE_LENGTH = 128;

export interface CodexEngineArgs {
  /** Draft model id, unvalidated. Absent when not passed or not usable as an id. */
  model?: string;
  /** Draft permission-preset id, unvalidated. */
  preset?: string;
}

/** An id-shaped token: non-empty, bounded, no whitespace (an id never contains any). */
function idValue(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (value.length === 0 || value.length > MAX_VALUE_LENGTH || /\s/.test(value)) return undefined;
  return value;
}

/** Supports both `--flag value` and `--flag=value`, matching parseHostArgs' existing shape. */
function readFlag(argv: readonly string[], flag: string): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === flag) return idValue(argv[i + 1]);
    if (arg.startsWith(`${flag}=`)) return idValue(arg.slice(flag.length + 1));
  }
  return undefined;
}

export function parseCodexEngineArgs(argv: readonly string[]): CodexEngineArgs {
  const model = readFlag(argv, "--engine-model");
  const preset = readFlag(argv, "--engine-preset");
  return {
    ...(model !== undefined ? { model } : {}),
    ...(preset !== undefined ? { preset } : {}),
  };
}
