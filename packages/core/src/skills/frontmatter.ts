/**
 * Minimal YAML-frontmatter parser (Phase 3 slice 3.3, design §3.2). NOT a new
 * dependency: a strict subset sufficient for ecosystem SKILL.md / agent-profile
 * files. Supports exactly:
 *   - an optional leading BOM, then an opening `---` fence line, a closing `---`
 *     line (CRLF tolerant);
 *   - between the fences ONLY flat `key: value` lines: scalar values (optional
 *     surrounding single/double quotes, stripped) OR an inline list `[a, b]`;
 *   - blank lines are allowed; unknown keys are returned verbatim (the consumer
 *     ignores the ones it does not know — reading ecosystem files never breaks).
 * Anything else (nesting, block lists, anchors, a line with no `key:`, an
 * indented line, a missing fence) makes the whole file non-conforming and the
 * parser returns an { error } — the caller drops that file fail-soft.
 *
 * `tools`-style values are turned into a string[] by splitList, which accepts
 * BOTH an inline list `[a, b]` and a comma-separated scalar `a, b`.
 */

export interface FrontmatterParsed {
  /** Flat key -> raw value map (quotes already stripped for scalars). */
  fields: Record<string, string>;
  /** Everything after the closing fence, byte-for-byte (frontmatter removed). */
  body: string;
}

export interface FrontmatterError {
  error: string;
}

export type FrontmatterResult = FrontmatterParsed | FrontmatterError;

/** Parses the frontmatter block or returns an { error } for any non-conforming input. */
export function parseFrontmatter(raw: string): FrontmatterResult {
  // Strip an optional UTF-8 BOM.
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;

  // The opening `---` fence must be the very first line (trailing spaces/CR ok).
  const openMatch = /^---[ \t]*\r?\n/.exec(text);
  if (!openMatch) {
    return { error: "missing opening '---' frontmatter fence" };
  }

  const fields: Record<string, string> = {};
  let offset = openMatch[0].length;

  for (;;) {
    const nlIndex = text.indexOf("\n", offset);
    const rawLine = text.slice(offset, nlIndex === -1 ? text.length : nlIndex);
    // CRLF tolerance: drop a trailing carriage return.
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const nextOffset = nlIndex === -1 ? text.length : nlIndex + 1;
    const trimmed = line.trim();

    if (trimmed === "---") {
      // Closing fence — the body is everything after this line, untouched.
      return { fields, body: text.slice(nextOffset) };
    }

    if (nlIndex === -1) {
      // Ran off the end with no closing fence.
      return { error: "missing closing '---' frontmatter fence" };
    }

    if (trimmed === "") {
      offset = nextOffset;
      continue;
    }

    const parsed = parseFlatLine(line);
    if (!parsed) {
      return { error: `unsupported frontmatter line: "${trimmed}"` };
    }
    fields[parsed.key] = parsed.value;
    offset = nextOffset;
  }
}

/**
 * Splits a `tools`-style value into a trimmed, quote-stripped, non-empty list.
 * Accepts an inline list (`[a, b]`) or a comma-separated scalar (`a, b`).
 */
export function splitList(value: string): string[] {
  let inner = value.trim();
  if (inner.startsWith("[") && inner.endsWith("]")) {
    inner = inner.slice(1, -1);
  }
  return inner
    .split(",")
    .map((item) => stripQuotes(item.trim()))
    .filter((item) => item.length > 0);
}

/**
 * Parses one flat `key: value` line, or returns undefined for a non-conforming
 * line (indented — i.e. nested; missing colon; empty or non-scalar key). Scalar
 * values have surrounding matching quotes stripped; inline-list values are kept
 * raw for splitList.
 */
function parseFlatLine(line: string): { key: string; value: string } | undefined {
  // An indented line is nesting / a block-list item — not a flat scalar.
  if (/^\s/.test(line)) {
    return undefined;
  }
  const colonIndex = line.indexOf(":");
  if (colonIndex === -1) {
    return undefined;
  }
  const key = line.slice(0, colonIndex).trim();
  if (key === "" || !/^[A-Za-z0-9_.-]+$/.test(key)) {
    return undefined;
  }
  const value = stripQuotes(line.slice(colonIndex + 1).trim());
  return { key, value };
}

/** Strips one layer of matching leading/trailing single or double quotes. */
function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}
