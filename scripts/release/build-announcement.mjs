#!/usr/bin/env node
/**
 * Builds the Telegram channel announcement for a PUBLISHED release — the text
 * payload for `.github/workflows/announce.yml`. Pure string assembly, no
 * network, no Telegram API: the workflow pipes this script's stdout into a
 * temp file and only curl ever talks to Telegram.
 *
 * Input comes exclusively from the environment (RELEASE_TAG, RELEASE_BODY,
 * RELEASE_URL) because the release notes are attacker-shaped text from the
 * release event — they must never travel through shell interpolation, in this
 * script's argv or anywhere else.
 *
 * Output: the message on stdout with NO trailing newline (the workflow `cat`s
 * it into a variable), or exit 1 with a stderr line when RELEASE_TAG or
 * RELEASE_URL is missing/empty. The workflow tolerates that exit — a missing
 * announcement must never stain the release run.
 *
 * Format (plain text, deliberately NO parse_mode so the notes need no
 * escaping — MarkdownV2 would reject every un-escaped `_` in the changelog):
 *
 *   AnyCode <tag> is out
 *
 *   <body, code-point-truncated so the WHOLE message fits Telegram's 4096-char
 *    limit with headroom, `…` appended at the cut>
 *
 *   <release URL — never trimmed, always the last line>
 *
 * Truncation is code-point aware (`Array.from`, never `String.slice` on UTF-16
 * code units): the changelog carries Cyrillic and emoji, and cutting inside a
 * surrogate pair ships a replacement character to the channel.
 */
import { pathToFileURL } from "node:url";

/** Telegram hard limit is 4096; stay under it with room for client quirks. */
export const MAX_MESSAGE_LENGTH = 4000;
export const ELLIPSIS = "…";
const SEPARATOR = "\n\n";

const codePoints = (text) => Array.from(text);

/**
 * Assembles the announcement. `tag` and `url` are required and never trimmed;
 * `body` may be empty/whitespace (→ title + link). Exported for unit tests.
 */
export function buildMessage({ tag, body, url }) {
  const title = `AnyCode ${tag} is out`;
  const notes = (body ?? "").trim();
  if (notes === "") return `${title}${SEPARATOR}${url}`;

  const whole = `${title}${SEPARATOR}${notes}${SEPARATOR}${url}`;
  if (codePoints(whole).length <= MAX_MESSAGE_LENGTH) return whole;

  // Over cap: shrink ONLY the notes. The untouchable overhead is title + both
  // separators + url + the ellipsis that marks the cut.
  const overhead =
    codePoints(`${title}${SEPARATOR}${SEPARATOR}${url}${ELLIPSIS}`).length;
  const budget = Math.max(MAX_MESSAGE_LENGTH - overhead, 0);
  const kept = codePoints(notes).slice(0, budget).join("");
  return `${title}${SEPARATOR}${kept}${ELLIPSIS}${SEPARATOR}${url}`;
}

/**
 * Reads the environment and returns `{ exit, message }` — `message` is the
 * announcement on success, a diagnostic for stderr on failure. Pure apart
 * from `env`, so tests never need to mutate the real environment.
 */
export function run(env = process.env) {
  const tag = (env.RELEASE_TAG ?? "").trim();
  const url = (env.RELEASE_URL ?? "").trim();
  if (tag === "") {
    return { exit: 1, message: "build-announcement: RELEASE_TAG is required and empty — nothing to announce." };
  }
  if (url === "") {
    return { exit: 1, message: "build-announcement: RELEASE_URL is required and empty — the link is never trimmed away." };
  }
  // RELEASE_BODY may be absent (a release with no notes still gets announced).
  return { exit: 0, message: buildMessage({ tag, body: env.RELEASE_BODY, url }) };
}

/** CLI shell: prints the message (no trailing newline) or the diagnostic. */
export function main(env = process.env) {
  const result = run(env);
  if (result.exit === 0) {
    process.stdout.write(result.message);
  } else {
    console.error(result.message);
  }
  return result.exit;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
