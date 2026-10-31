/**
 * Anonymiser for the diagnostics export (GitHub #18).
 *
 * Two independent layers protect the bundle:
 *
 * 1. The bundle builder copies fields through a per-record WHITELIST, so
 *    prompts, model output, tool arguments and tool results are never even
 *    considered (a future record type or an unexpected extra key is dropped,
 *    fail-closed).
 * 2. Everything that survives that whitelist — and every ring-log identifier
 *    that crossed a process boundary — still passes through this module, which
 *    removes secrets, file paths, URLs/hosts, e-mail addresses and raw ids.
 *
 * Raw ids (session/tab/message/host ids) are replaced by a deterministic
 * HMAC-SHA-256 prefix keyed with a salt generated ONCE per export. Two
 * consequences: the same session correlates across records inside one bundle,
 * and the same id produces an unrelated value in the next export. The salt is
 * deliberately NOT serialised into the bundle — including it would make the
 * hashes brute-forceable back to the source ids.
 *
 * The module is pure apart from `node:crypto` and never reads a file, an env
 * var or the profile directory.
 */

import { createHmac, randomBytes } from "node:crypto";

/** Longest string the anonymiser will carry through (contents beyond this are dropped). */
export const DIAGNOSTICS_MAX_TEXT_CHARS = 4_096;
/** Deepest object/array nesting accepted by `value()`. */
const MAX_VALUE_DEPTH = 6;
/** Closed key alphabet for objects passed to `value()`. */
const SAFE_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

const HASH_PREFIX = "id_";
const HASH_CHARS = 12;

/** Secret-shaped tokens. Anything that looks like a credential is replaced, not kept. */
const SECRET_PATTERNS: RegExp[] = [
  // Known provider / VCS / chat token prefixes.
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{10,}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\bnpm_[A-Za-z0-9]{20,}\b/g,
  /\bpypi-[A-Za-z0-9_-]{20,}\b/g,
  // JWT: three base64url segments.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  // Authorization header values.
  /\b(?:Basic|Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  // key=value / key: value credential assignments (name kept, value dropped).
  /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|password|passwd|authorization)\b\s*[:=]\s*["']?[^\s"',;}\]]{3,}/gi,
  // Any long hex blob (>= 40) that was not caught above is treated as a key.
  /\b[0-9a-f]{40,}\b/gi,
  // Long base64-ish blobs.
  /\b[A-Za-z0-9+/]{48,}={0,2}\b/g,
  // A long unbroken alphanumeric run mixing letters and digits is a
  // credential or an opaque id, never a readable name.
  /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/g,
];

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

const URL_RE = /\b(https?|wss?|ftp):\/\/[^\s"'`<>\\]+/gi;

/**
 * Absolute POSIX / Windows / home-relative paths.
 *
 * The last two patterns are deliberately ROOT-AGNOSTIC: a workspace, a model
 * file or a log can live under any mount (`/data/models/...`, `/srv2/...`),
 * so an allowlist of well-known roots would let a real path through whenever
 * a user (or a container) keeps their data somewhere else. A slash that
 * STARTS a token is a path; a slash inside a token (`anthropic/claude-x`) is
 * not touched. `//` is left alone because the URL rule has already replaced
 * every scheme+host by the time these run. `:` belongs to the boundary set on
 * purpose: `cwd:/data/x`, `open:../x` and `label:/srv/y` are at least as common
 * in logs as their whitespace-separated forms, and a path is a path whether or
 * not a space precedes it.
 */
const PATH_PATTERNS: RegExp[] = [
  /~\/[^\s"'`<>|]*/g,
  /\/(?:Users|home|root|tmp|private|var|opt|mnt|srv|Volumes|Applications|Library|etc|usr|bin|sbin|lib)\b\/?[^\s"'`<>|]*/g,
  /\b[A-Za-z]:[\\/][^\s"'`<>|]*/g,
  // Any other absolute POSIX path: `/` at the start of a token.
  /(?<=^|[\s"'`=([{,;:])\/(?!\/)[^\s"'`<>|,;)\]]{2,}/g,
  // Explicitly relative paths: `./x`, `../x`.
  /(?<=^|[\s"'`=([{,;:])(?:\.\.?\/)[^\s"'`<>|,;)\]]+/g,
];

const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

const HOST_PATTERNS: RegExp[] = [
  /\blocalhost(?::\d{1,5})?\b/gi,
  /\b(?:[a-z0-9-]+\.)+(?:local|lan|internal|corp|home|arpa|ts\.net)\b(?::\d{1,5})?/gi,
  /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|dev|ai|app|cloud|ru|co|uk|de|fr|me|sh|gg|tv|xyz)\b(?::\d{1,5})?/gi,
  // Any remaining dotted domain shape (unusual TLDs included).
  /\b(?:[a-z0-9](?:[a-z0-9-]{0,62})\.)+[a-z]{2,24}\b/gi,
];

/** Raw ids as they appear in free text. */
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const PREFIXED_ID_RE = /\b(?:sess|session|tab|msg|message|call|tool_call|turn|conn|connection|run|req|request|spawn|host|proc|pid)_[A-Za-z0-9-]{6,}\b/gi;
const LONG_HEX_ID_RE = /\b[0-9a-f]{16,}\b/gi;

export interface DiagnosticsAnonymizer {
  /**
   * Deterministic, salted replacement for one raw id. Deliberately a method
   * (not a serialised map): callers stamp it into the bundle and the salt
   * never leaves this object.
   */
  id(raw: string): string;
  /** Removes paths, URLs/hosts, e-mails, secrets and raw ids from free text. */
  text(raw: string): string;
  /** Recursive, whitelist-shaped projection for values that escaped a record whitelist. */
  value(input: unknown): unknown;
  /** How many replacements `text()`/`value()` have made (diagnostics only). */
  redactionCount(): number;
  /** The per-export salt. NEVER serialise this into a bundle. */
  readonly salt: string;
}

export interface DiagnosticsAnonymizerOptions {
  /** Injectable for deterministic tests; defaults to 16 random bytes (hex). */
  salt?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Builds one anonymiser. Every replacement bumps one counter so the bundle can
 * report how much was scrubbed without revealing what was removed.
 */
export function createDiagnosticsAnonymizer(options?: DiagnosticsAnonymizerOptions): DiagnosticsAnonymizer {
  const salt = options?.salt ?? randomBytes(16).toString("hex");
  let redactions = 0;

  function hash(raw: string): string {
    return createHmac("sha256", salt).update(raw, "utf8").digest("hex").slice(0, HASH_CHARS);
  }

  function id(raw: string): string {
    return `${HASH_PREFIX}${hash(raw)}`;
  }

  function replaceAll(input: string, pattern: RegExp, replacement: string | ((match: string) => string)): string {
    // Patterns are global; using String#replace only counts when something matched.
    return input.replace(pattern, (match: string, ...args: unknown[]) => {
      redactions += 1;
      return typeof replacement === "function" ? replacement(match) : replacement;
    });
  }

  function text(raw: string): string {
    let out = raw.length > DIAGNOSTICS_MAX_TEXT_CHARS ? raw.slice(0, DIAGNOSTICS_MAX_TEXT_CHARS) : raw;
    if (out.length === 0) return out;

    // Credentials and identity tokens first: later rules must not split them.
    for (const pattern of SECRET_PATTERNS) {
      out = replaceAll(out, pattern, "<secret>");
    }
    out = replaceAll(out, EMAIL_RE, "<email>");
    out = replaceAll(out, URL_RE, (match) => `${match.split("://")[0]}://<host>`);
    for (const pattern of PATH_PATTERNS) {
      out = replaceAll(out, pattern, "<path>");
    }
    out = replaceAll(out, IPV4_RE, "<ip>");
    for (const pattern of HOST_PATTERNS) {
      out = replaceAll(out, pattern, "<host>");
    }
    out = replaceAll(out, UUID_RE, (match) => id(match));
    out = replaceAll(out, PREFIXED_ID_RE, (match) => id(match));
    out = replaceAll(out, LONG_HEX_ID_RE, (match) => id(match));

    // Key=value env-style assignments keep the NAME (useful for diagnosis) and
    // lose the value. Runs last so it cannot eat an already-replaced marker.
    out = replaceAll(out, /\b([A-Z][A-Z0-9_]{2,})=([^\s"'<][^\s"']*)/g, (_match) => {
      const name = /^[A-Z][A-Z0-9_]{2,}/.exec(_match)?.[0] ?? "VAR";
      return `${name}=<value>`;
    });

    return out;
  }

  function value(input: unknown, depth = 0): unknown {
    if (input === null || input === undefined) return null;
    if (typeof input === "string") return text(input);
    if (typeof input === "number") return Number.isFinite(input) ? input : null;
    if (typeof input === "boolean") return input;
    if (depth >= MAX_VALUE_DEPTH) return "<nested>";
    if (Array.isArray(input)) {
      return input.slice(0, 256).map((item) => value(item, depth + 1));
    }
    if (isRecord(input)) {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(input)) {
        if (!SAFE_KEY_RE.test(key)) continue;
        const projected = value(item, depth + 1);
        if (projected !== undefined) out[key] = projected;
      }
      return out;
    }
    return undefined;
  }

  return {
    id,
    text,
    value: (input) => value(input),
    redactionCount: () => redactions,
    salt,
  };
}
