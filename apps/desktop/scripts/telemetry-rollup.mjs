/**
 * Telemetry cost-rollup tooling (P7.10, promotion of slice-6.6-cut.md §7 R3):
 * aggregates the local JSONL telemetry sink (packages/core/src/telemetry/
 * records.ts + ports/telemetry.ts, adapters/node/node-telemetry.ts) into a
 * human-readable usage table by session x model/provider x calendar day.
 *
 * Plain node >=22, ZERO npm deps (only node:fs/os/path/url), matching the
 * `scripts/` precedent (env-status-smoke.mjs et al.) — this file is a NEW
 * sibling, does not import or edit anything under packages/core or
 * apps/desktop/src.
 *
 * One JSONL file per session (`<sessionId>.jsonl`), each line a `{v:1, ts,
 * session, t, ...}` envelope. `t:"session_start"` carries {model, provider,
 * mode, appVersion?}; `t:"usage"` carries {inputTokens?, outputTokens?,
 * totalTokens?} and is joined to the model/provider of the SAME session's
 * session_start record (a session pins one model/provider pair for its
 * lifetime — no mid-session model-switch event exists yet, slice-6.6-cut.md
 * §7 R2). Usage records with no matching session_start in the same file fall
 * under model/provider "(unknown)".
 *
 * cache-split: the whitelist usage record (ports/telemetry.ts) does not carry
 * a cachedInputTokens field — that is a separate future slice (see the doc
 * append at the bottom of slice-6.6-cut.md). This tool always prints
 * "cache split: n/a (not recorded)" rather than inventing a number.
 *
 * Usage:
 *   node apps/desktop/scripts/telemetry-rollup.mjs [--dir <path>] [--json] [--selftest]
 *
 *   --dir <path>   Telemetry sink directory to scan (default: same default as
 *                   packages/core/src/telemetry/config.ts, `<home>/.anycode/telemetry`).
 *   --json         Print the aggregate as machine-readable JSON instead of a table.
 *   --selftest     Run the built-in seed-fixture self-test (no fs access) and
 *                   exit 0/1; ignores --dir/--json.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── CLI flags ──

function parseArgs(argv) {
  const flags = { dir: undefined, json: false, selftest: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dir") {
      i += 1;
      flags.dir = argv[i];
    } else if (arg === "--json") {
      flags.json = true;
    } else if (arg === "--selftest") {
      flags.selftest = true;
    } else {
      console.warn(`[telemetry-rollup] ignoring unrecognized argument: ${arg}`);
    }
  }
  return flags;
}

function defaultTelemetryDir() {
  return join(homedir(), ".anycode", "telemetry");
}

// ── aggregation core (pure, fs-free — shared by the real run and --selftest) ──

function dayKeyFromTs(ts) {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return null;
  try {
    return new Date(ts).toISOString().slice(0, 10);
  } catch {
    // finite but out of Date's representable range (e.g. 8640000000000001) —
    // toISOString() throws RangeError on an Invalid Date.
    return null;
  }
}

/** Strips ASCII control characters (including ESC) from untrusted string
 *  fields before they reach the terminal or JSON output. */
function sanitizeForTerminal(s) {
  return typeof s === "string" ? s.replace(/[\x00-\x1F\x7F]/g, "") : s;
}

/** A `t:"usage"` record's token fields are optional but, when present, must
 *  be finite non-negative numbers — otherwise the record is malformed. */
function isValidUsagePayload(rec) {
  for (const field of ["inputTokens", "outputTokens", "totalTokens"]) {
    const value = rec[field];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return false;
  }
  return true;
}

/**
 * Aggregates one session's parsed JSONL lines into rollup rows. Malformed
 * lines are the caller's concern (parseJsonlLines skips them before this is
 * called) — this function only sees already-parsed envelope objects, but
 * still defends against a `.jsonl` file containing valid-looking records
 * that were stamped with a *different* session id (e.g. accidentally
 * concatenated from another file): only records whose `session` field
 * matches this file's session id (`sessionId`, derived from the filename)
 * are joined/aggregated; everything else is counted as skipped.
 */
function aggregateSession(sessionId, records, agg) {
  let model = "(unknown)";
  let provider = "(unknown)";
  for (const rec of records) {
    if (rec.t !== "session_start") continue;
    if (rec.session !== sessionId) {
      agg.skipped += 1;
      continue;
    }
    if (typeof rec.model === "string" && rec.model.length > 0) model = sanitizeForTerminal(rec.model);
    if (typeof rec.provider === "string" && rec.provider.length > 0) provider = sanitizeForTerminal(rec.provider);
    break;
  }

  let sessionHasUsage = false;
  for (const rec of records) {
    if (rec.t === "session_start") continue;
    if (rec.t !== "usage") {
      // Known-but-irrelevant (e.g. "tool", "session_end") and unrecognized
      // future record types alike: not usage, but not malformed either.
      agg.ignoredRecords += 1;
      continue;
    }
    if (rec.session !== sessionId) {
      agg.skipped += 1;
      continue;
    }
    if (!isValidUsagePayload(rec)) {
      agg.skipped += 1;
      continue;
    }
    const day = dayKeyFromTs(rec.ts);
    if (day === null) {
      agg.skipped += 1;
      continue;
    }
    const key = JSON.stringify([day, model, provider]);
    let row = agg.rows.get(key);
    if (row === undefined) {
      row = {
        day,
        model,
        provider,
        sessions: new Set(),
        records: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      };
      agg.rows.set(key, row);
    }
    row.sessions.add(sessionId);
    row.records += 1;
    if (typeof rec.inputTokens === "number") row.inputTokens += rec.inputTokens;
    if (typeof rec.outputTokens === "number") row.outputTokens += rec.outputTokens;
    if (typeof rec.totalTokens === "number") row.totalTokens += rec.totalTokens;
    sessionHasUsage = true;
  }

  if (sessionHasUsage) agg.sessionsScanned += 1;
}

function newAggregate() {
  return { rows: new Map(), skipped: 0, ignoredRecords: 0, filesScanned: 0, sessionsScanned: 0 };
}

/** Parses one file's raw text into `{records, skipped}` — malformed JSON
 *  lines and lines missing the required envelope shape (`v`, `ts`, `session`,
 */
function parseJsonlLines(text) {
  const records = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      skipped += 1;
      continue;
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      parsed.v !== 1 ||
      typeof parsed.ts !== "number" ||
      typeof parsed.session !== "string" ||
      typeof parsed.t !== "string"
    ) {
      skipped += 1;
      continue;
    }
    records.push(parsed);
  }
  return { records, skipped };
}

function finalizeAggregate(agg) {
  const rows = [...agg.rows.values()]
    .map((row) => ({
      day: row.day,
      model: row.model,
      provider: row.provider,
      sessions: row.sessions.size,
      records: row.records,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      totalTokens: row.totalTokens,
    }))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.model.localeCompare(b.model) || a.provider.localeCompare(b.provider)));

  const totals = rows.reduce(
    (acc, row) => {
      acc.records += row.records;
      acc.inputTokens += row.inputTokens;
      acc.outputTokens += row.outputTokens;
      acc.totalTokens += row.totalTokens;
      return acc;
    },
    { records: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  );

  return {
    rows,
    totals,
    skipped: agg.skipped,
    ignoredRecords: agg.ignoredRecords,
    filesScanned: agg.filesScanned,
    sessionsScanned: agg.sessionsScanned,
  };
}

// ── fs-touching scan (real telemetry dir) ──

function scanDir(dir) {
  const agg = newAggregate();

  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return { agg: finalizeAggregate(agg), dirExists: false };
  }

  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue;
    const path = join(dir, entry);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      agg.skipped += 1;
      continue;
    }
    if (!stat.isFile()) continue;

    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      agg.skipped += 1;
      continue;
    }

    agg.filesScanned += 1;
    const sessionId = entry.slice(0, -".jsonl".length);
    const { records, skipped } = parseJsonlLines(text);
    agg.skipped += skipped;
    if (records.length > 0) {
      aggregateSession(sessionId, records, agg);
    }
  }

  return { agg: finalizeAggregate(agg), dirExists: true };
}

// ── table rendering ──

function formatNumber(n) {
  return n.toLocaleString("en-US");
}

function renderTable(result) {
  const headers = ["DAY", "MODEL", "PROVIDER", "SESSIONS", "RECORDS", "INPUT", "OUTPUT", "TOTAL"];
  const rows = result.rows.map((r) => [
    r.day,
    sanitizeForTerminal(r.model),
    sanitizeForTerminal(r.provider),
    String(r.sessions),
    String(r.records),
    formatNumber(r.inputTokens),
    formatNumber(r.outputTokens),
    formatNumber(r.totalTokens),
  ]);
  const totalsRow = [
    "TOTAL",
    "",
    "",
    "",
    String(result.totals.records),
    formatNumber(result.totals.inputTokens),
    formatNumber(result.totals.outputTokens),
    formatNumber(result.totals.totalTokens),
  ];

  const allRows = [headers, ...rows, totalsRow];
  const widths = headers.map((_, col) => Math.max(...allRows.map((row) => row[col].length)));

  const lines = [];
  for (const [idx, row] of allRows.entries()) {
    const line = row.map((cell, col) => cell.padEnd(widths[col])).join("  ");
    lines.push(line);
    if (idx === 0) {
      lines.push(widths.map((w) => "-".repeat(w)).join("  "));
    }
    if (idx === allRows.length - 2) {
      lines.push(widths.map((w) => "-".repeat(w)).join("  "));
    }
  }

  lines.push("");
  lines.push("cache split: n/a (not recorded)");
  lines.push(
    `files scanned: ${result.filesScanned}, sessions with usage: ${result.sessionsScanned}, skipped lines: ${result.skipped}, ignored records: ${result.ignoredRecords}`,
  );
  return lines.join("\n");
}

function renderJson(result) {
  return JSON.stringify(
    {
      rows: result.rows,
      totals: result.totals,
      cacheSplit: null,
      filesScanned: result.filesScanned,
      sessionsScanned: result.sessionsScanned,
      skipped: result.skipped,
      ignoredRecords: result.ignoredRecords,
    },
    null,
    2,
  );
}

// ── selftest ──

function buildSelftestFixture() {
  const sessionA = "sess-a";
  const sessionB = "sess-b";
  const sessionC = "sess-c";
  const sessionD = "sess-d";
  const sessionE = "sess-e";
  const sessionF = "sess-f";
  const files = new Map();

  files.set(
    `${sessionA}.jsonl`,
    [
      JSON.stringify({ v: 1, ts: Date.parse("2026-07-01T10:00:00Z"), session: sessionA, t: "session_start", model: "claude-sonnet-5", provider: "anthropic", mode: "auto" }),
      JSON.stringify({ v: 1, ts: Date.parse("2026-07-01T10:01:00Z"), session: sessionA, t: "usage", inputTokens: 100, outputTokens: 50, totalTokens: 150 }),
      JSON.stringify({ v: 1, ts: Date.parse("2026-07-01T10:02:00Z"), session: sessionA, t: "usage", inputTokens: 200, outputTokens: 75, totalTokens: 275 }),
      "not json at all {{{",
      JSON.stringify({ v: 1, ts: Date.parse("2026-07-01T10:03:00Z"), session: sessionA, t: "tool", tool: "Read", status: "ok", durationMs: 12 }),
      "",
    ].join("\n"),
  );

  files.set(
    `${sessionB}.jsonl`,
    [
      JSON.stringify({ v: 1, ts: Date.parse("2026-07-02T09:00:00Z"), session: sessionB, t: "session_start", model: "claude-opus-4-8", provider: "anthropic", mode: "acceptEdits" }),
      JSON.stringify({ v: 1, ts: Date.parse("2026-07-02T09:05:00Z"), session: sessionB, t: "usage", inputTokens: 1000, outputTokens: 300, totalTokens: 1300 }),
      JSON.stringify({ v: 1, ts: Date.parse("2026-07-02T09:10:00Z"), session: sessionB, t: "session_end" }),
    ].join("\n"),
  );

  // sess-c: a usage record stamped with a FOREIGN session id (as if a line
  // from sess-a's file were accidentally appended here) must be skipped, not
  // joined to sess-c's session_start.
  files.set(
    `${sessionC}.jsonl`,
    [
      JSON.stringify({ v: 1, ts: Date.parse("2026-07-03T08:00:00Z"), session: sessionC, t: "session_start", model: "claude-haiku-4-5-20251001", provider: "anthropic", mode: "auto" }),
      JSON.stringify({ v: 1, ts: Date.parse("2026-07-03T08:01:00Z"), session: sessionA, t: "usage", inputTokens: 999, outputTokens: 999, totalTokens: 1998 }),
      JSON.stringify({ v: 1, ts: Date.parse("2026-07-03T08:02:00Z"), session: sessionC, t: "usage", inputTokens: 10, outputTokens: 5, totalTokens: 15 }),
    ].join("\n"),
  );

  // sess-d: a finite but out-of-range timestamp (beyond Date's representable
  // range) must be skipped rather than throwing RangeError out of the tool.
  files.set(
    `${sessionD}.jsonl`,
    [
      JSON.stringify({ v: 1, ts: Date.parse("2026-07-04T08:00:00Z"), session: sessionD, t: "session_start", model: "claude-sonnet-5", provider: "anthropic", mode: "auto" }),
      JSON.stringify({ v: 1, ts: 8640000000000001, session: sessionD, t: "usage", inputTokens: 5, outputTokens: 5, totalTokens: 10 }),
    ].join("\n"),
  );

  // sess-e: usage payloads with non-numeric / negative token fields must be
  // skipped as malformed rather than silently coerced or NaN-polluting sums.
  files.set(
    `${sessionE}.jsonl`,
    [
      JSON.stringify({ v: 1, ts: Date.parse("2026-07-05T08:00:00Z"), session: sessionE, t: "session_start", model: "claude-sonnet-5", provider: "anthropic", mode: "auto" }),
      JSON.stringify({ v: 1, ts: Date.parse("2026-07-05T08:01:00Z"), session: sessionE, t: "usage", inputTokens: "100", outputTokens: 50, totalTokens: 150 }),
      JSON.stringify({ v: 1, ts: Date.parse("2026-07-05T08:02:00Z"), session: sessionE, t: "usage", inputTokens: 10, outputTokens: -5, totalTokens: 5 }),
    ].join("\n"),
  );

  // sess-f: a session with a session_start but no usage records at all must
  // not count toward "sessions with usage".
  files.set(
    `${sessionF}.jsonl`,
    [
      JSON.stringify({ v: 1, ts: Date.parse("2026-07-06T08:00:00Z"), session: sessionF, t: "session_start", model: "claude-sonnet-5", provider: "anthropic", mode: "auto" }),
    ].join("\n"),
  );

  return files;
}

function runSelftest() {
  const files = buildSelftestFixture();
  const agg = newAggregate();

  for (const [fileName, text] of files) {
    agg.filesScanned += 1;
    const sessionId = fileName.slice(0, -".jsonl".length);
    const { records, skipped } = parseJsonlLines(text);
    agg.skipped += skipped;
    if (records.length > 0) {
      aggregateSession(sessionId, records, agg);
    }
  }

  const result = finalizeAggregate(agg);
  const failures = [];

  const assertEqual = (label, actual, expected) => {
    if (actual !== expected) {
      failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  };

  assertEqual("filesScanned", result.filesScanned, 6);
  assertEqual(
    "sessionsScanned (sessions with >=1 accepted usage record: a, b, c)",
    result.sessionsScanned,
    3,
  );
  assertEqual(
    "skipped lines (1 malformed JSON in sess-a, 1 foreign-session usage in sess-c, " +
      "1 out-of-range ts in sess-d, 2 malformed token payloads in sess-e)",
    result.skipped,
    5,
  );
  assertEqual("ignored records (1 tool in sess-a, 1 session_end in sess-b)", result.ignoredRecords, 2);
  assertEqual("row count", result.rows.length, 3);

  const rowA = result.rows.find((r) => r.model === "claude-sonnet-5" && r.day === "2026-07-01");
  const rowB = result.rows.find((r) => r.model === "claude-opus-4-8");
  const rowC = result.rows.find((r) => r.model === "claude-haiku-4-5-20251001");

  assertEqual("sess-a row present", rowA !== undefined, true);
  assertEqual("sess-b row present", rowB !== undefined, true);
  assertEqual("sess-c row present", rowC !== undefined, true);

  if (rowA !== undefined) {
    assertEqual("sess-a day", rowA.day, "2026-07-01");
    assertEqual("sess-a provider", rowA.provider, "anthropic");
    assertEqual("sess-a sessions", rowA.sessions, 1);
    assertEqual("sess-a records (usage lines)", rowA.records, 2);
    assertEqual("sess-a inputTokens", rowA.inputTokens, 300);
    assertEqual("sess-a outputTokens", rowA.outputTokens, 125);
    assertEqual("sess-a totalTokens", rowA.totalTokens, 425);
  }

  if (rowB !== undefined) {
    assertEqual("sess-b day", rowB.day, "2026-07-02");
    assertEqual("sess-b provider", rowB.provider, "anthropic");
    assertEqual("sess-b sessions", rowB.sessions, 1);
    assertEqual("sess-b records (usage lines)", rowB.records, 1);
    assertEqual("sess-b inputTokens", rowB.inputTokens, 1000);
    assertEqual("sess-b outputTokens", rowB.outputTokens, 300);
    assertEqual("sess-b totalTokens", rowB.totalTokens, 1300);
  }

  if (rowC !== undefined) {
    assertEqual("sess-c day", rowC.day, "2026-07-03");
    assertEqual("sess-c provider", rowC.provider, "anthropic");
    assertEqual("sess-c sessions", rowC.sessions, 1);
    assertEqual("sess-c records (only the same-session usage line)", rowC.records, 1);
    assertEqual("sess-c inputTokens (foreign-session line excluded)", rowC.inputTokens, 10);
    assertEqual("sess-c outputTokens", rowC.outputTokens, 5);
    assertEqual("sess-c totalTokens", rowC.totalTokens, 15);
  }

  assertEqual("sess-d produced no row (its only usage line has an unrepresentable ts)", result.rows.some((r) => r.day === "2026-07-04"), false);
  assertEqual("sess-e produced no row (both its usage lines are malformed)", result.rows.some((r) => r.day === "2026-07-05"), false);
  assertEqual("sess-f produced no row (session_start only, no usage)", result.rows.some((r) => r.day === "2026-07-06"), false);

  assertEqual("grand total records", result.totals.records, 4);
  assertEqual("grand total totalTokens", result.totals.totalTokens, 425 + 1300 + 15);

  console.log(renderTable(result));
  console.log("");

  if (failures.length > 0) {
    console.error(`[telemetry-rollup] SELFTEST FAILED (${failures.length} assertion(s)):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log(`[telemetry-rollup] SELFTEST OK (${result.rows.length} rows, ${result.totals.records} usage records, ${result.skipped} skipped)`);
  process.exit(0);
}

// ── entrypoint ──

function main() {
  const flags = parseArgs(process.argv.slice(2));

  if (flags.selftest) {
    runSelftest();
    return;
  }

  const dir = flags.dir ?? defaultTelemetryDir();
  const { agg: result, dirExists } = scanDir(dir);

  if (!dirExists) {
    if (flags.json) {
      console.log(renderJson(result));
    } else {
      console.log(`[telemetry-rollup] telemetry directory not found: ${dir}`);
      console.log("No data to roll up (telemetry disabled or never enabled).");
    }
    process.exit(0);
    return;
  }

  console.log(flags.json ? renderJson(result) : renderTable(result));
  process.exit(0);
}

main();
