/**
 * The draft (pre-session) Claude model/preset choice, carried from main into
 * the forked host as argv (cut §1.4). A deliberate duplicate of
 * host/engines/codex/draft-args.ts: one host process runs exactly one engine,
 * so the two readers of `--engine-model`/`--engine-preset` can never collide,
 * and sharing them would couple two engine directories the seam keeps apart.
 *
 * argv is UNTRUSTED input here — it originates in the renderer's draft picker.
 * Nothing in this module interprets, resolves, or applies a value: it extracts
 * two bounded opaque strings. Both are validated host-authoritatively later —
 * the model against the live `initialize` `models[]` catalog (models.ts), the
 * preset against the frozen table (presets.ts) — and an unrecognized value
 * degrades to the default rather than reaching the wire.
 */

/** Bounds a hostile/garbled argv value; mirrors the zod bounds on the equivalent UI messages. */
const MAX_VALUE_LENGTH = 128;

export interface ClaudeEngineArgs {
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

export function parseClaudeEngineArgs(argv: readonly string[]): ClaudeEngineArgs {
  const model = readFlag(argv, "--engine-model");
  const preset = readFlag(argv, "--engine-preset");
  return {
    ...(model !== undefined ? { model } : {}),
    ...(preset !== undefined ? { preset } : {}),
  };
}
