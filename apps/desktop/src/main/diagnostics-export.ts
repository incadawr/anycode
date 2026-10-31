/**
 * Diagnostics bundle builder (GitHub #18).
 *
 * Collects four bounded, local sources into ONE anonymised JSON document
 * describing ONE session TREE — the session the person asked about plus its
 * children (transitively, via each child's `session_start.parentSession`):
 *
 * - telemetry records of that tree's files, projected through a per-type
 *   WHITELIST (prompts, model output, tool arguments and results have no
 *   route into the bundle — an unlisted field or an unknown record type is
 *   dropped, never passed through);
 * - derived tool SHAPES (name -> calls/statuses/duration), no arguments, no
 *   outputs;
 * - the main and host ring logs (control-plane wire shapes only, see
 *   shared/diagnostics-ring.ts);
 * - app/runtime identity (version, platform, arch) — no hostname, no user, no
 *   paths.
 *
 * Scope is a privacy boundary, not a convenience: the telemetry directory is
 * shared by every session of every project, so the builder reads the tree
 * files ONLY. It learns which files are in the tree from each file's first
 * bytes (`session_start.parentSession`); an unrelated session's records are
 * never read, let alone serialised.
 *
 * Everything that survives the whitelist is additionally scrubbed by
 * `diagnostics-anonymize` (secrets, paths, URLs/hosts, e-mails, raw ids hashed
 * with a per-export salt) and the exact serialised size is measured; when it
 * would reach the 5 MB ceiling the builder drops the OLDEST telemetry records,
 * then the oldest sessions, then the oldest wire entries, then the largest
 * tool-shape entries until it is strictly below the ceiling — the session the
 * person is debugging is the last thing to go. The build function is
 * Electron-free and takes its filesystem through a narrow port, so the
 * privacy properties are testable through the production path.
 */

import { createDiagnosticsAnonymizer } from "./diagnostics-anonymize.js";
import {
  DIAGNOSTICS_MAX_BUNDLE_BYTES,
  type DiagnosticsSectionSummary,
  type DiagnosticsSummary,
} from "../shared/diagnostics.js";
import {
  parseDiagnosticsRingEntries,
  type DiagnosticsRingEntry,
} from "../shared/diagnostics-ring.js";

/** Reads only what the export needs; `NodeProfileFs` satisfies this shape. */
export interface DiagnosticsFs {
  readdir(path: string): Promise<string[]>;
  lstat(path: string): Promise<{ size: number; mtimeMs: number; isFile: boolean; isSymbolicLink?: boolean }>;
  readFileNoFollow(path: string): Promise<string>;
  /** At most the FIRST `maxBytes` of a file (tree discovery only — never exported). */
  readFileHeadNoFollow(path: string, maxBytes: number): Promise<string>;
  /** At most the LAST `maxBytes` of a file (a long session's recent records). */
  readFileTailNoFollow(path: string, maxBytes: number): Promise<string>;
  writeFile(path: string, content: string, opts?: { mode?: number }): Promise<void>;
}

/** Tree files examined per export (the root plus up to 49 descendants). */
export const DIAGNOSTICS_TELEMETRY_MAX_TREE_FILES = 50;
/** A tree file up to this size is read whole. */
export const DIAGNOSTICS_TELEMETRY_MAX_FILE_BYTES = 1024 * 1024;
/** A longer tree file contributes only its tail — the recent records. */
export const DIAGNOSTICS_TELEMETRY_TAIL_BYTES = 512 * 1024;
/** Head window used to find `session_start.parentSession` (never exported). */
export const DIAGNOSTICS_TELEMETRY_HEAD_BYTES = 8 * 1024;
/**
 * How many telemetry files may be HEAD-read to discover the tree edges. Heads
 * carry no records, but the directory can hold years of sessions: this bounds
 * the discovery pass independently of the data caps.
 */
export const DIAGNOSTICS_TELEMETRY_MAX_EDGE_FILES = 200;
export const DIAGNOSTICS_TELEMETRY_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
export const DIAGNOSTICS_TELEMETRY_MAX_SESSIONS = 50;
export const DIAGNOSTICS_TELEMETRY_MAX_RECORDS_PER_SESSION = 2_000;
export const DIAGNOSTICS_WIRE_MAX_ENTRIES = 1_024;
export const DIAGNOSTICS_PREVIEW_MAX_CHARS = 8_000;
/** Longest identifier-shaped string carried into the bundle (tool/status/model names). */
export const DIAGNOSTICS_MAX_FIELD_CHARS = 128;

const TELEMETRY_FILE_RE = /^[A-Za-z0-9_-]{1,128}\.jsonl$/;

type FieldKind = "number" | "boolean" | "text";

/**
 * The ONLY fields copied out of a telemetry record, per record type. The
 * envelope (`v`/`ts`/`session`/`sub`/`t`) is handled separately. Every type or
 * field absent here is dropped: this table is the privacy boundary, not a
 * convenience list.
 *
 * Two deliberate omissions worth stating: `subagent_start.fallbackReason` is
 * an `error.message` (free text that can carry a path), and `subagent_end`
 * has no free text either. Lifecycle types carry names/ids only; their
 * `parentSession` id is hashed by `projectTelemetryRecord` like any other id.
 */
const TELEMETRY_FIELDS: Record<string, Record<string, FieldKind>> = {
  turn_end: { turn: "number", finishReason: "text" },
  usage: {
    inputTokens: "number",
    outputTokens: "number",
    totalTokens: "number",
    cachedInputTokens: "number",
  },
  tool: { tool: "text", status: "text", durationMs: "number" },
  loop_end: { reason: "text", turns: "number" },
  compaction_start: { trigger: "text" },
  compaction_end: { ok: "boolean", preTokens: "number", postTokens: "number", durationMs: "number" },
  microcompact: { clearedToolResults: "number", savedTokens: "number" },
  context_usage: { estimatedTokens: "number", budgetTokens: "number", source: "text" },
  subagent_start: { agentType: "text", model: "text", engine: "text", route: "text" },
  subagent_end: {
    status: "text",
    turns: "number",
    durationMs: "number",
    model: "text",
    responseModel: "text",
    engine: "text",
  },
  workflow_end: { status: "text", completedSteps: "number", totalSteps: "number", durationMs: "number" },
  workflow_step_end: { status: "text", turns: "number", durationMs: "number", unlaunched: "boolean" },
  stream_retry: { attempt: "number", maxAttempts: "number", delayMs: "number" },
  degeneration: { channel: "text", period: "text", repeats: "number", turn: "number" },
  ceiling_refused: { reason: "text", turn: "number", round: "number" },
  ceiling_grant: { round: "number", granted: "number", totalGranted: "number" },
  permission_auto_decided: { classifier: "text", decision: "text", latencyMs: "number", error: "boolean" },
  // Lifecycle records: the tree's own edges live here (`parentSession`).
  session_start: { model: "text", provider: "text", engine: "text", enginePreset: "text", mode: "text", appVersion: "text" },
  session_end: {},
  error: {},
  checkpoint_created: {},
  checkpoint_failed: {},
};

export interface DiagnosticsAppInfo {
  version: string;
  platform: string;
  arch: string;
  electron?: string;
  node?: string;
}

export interface DiagnosticsExportDeps {
  fs: DiagnosticsFs;
  /** Resolved telemetry directory (the exact one Profile reads). */
  telemetryDir: string;
  /** Root of the exported tree: this session plus its children. */
  sessionId: string;
  /** Main's own ring snapshot. */
  rings?: readonly DiagnosticsRingEntry[];
  /** Ring snapshots collected from live hosts (untrusted IPC data). */
  hostRings?: unknown;
  app: DiagnosticsAppInfo;
  now?: () => number;
  /** Injectable per-export id salt (tests); default is random per export. */
  salt?: string;
  maxBytes?: number;
}

export interface DiagnosticsToolShape {
  calls: number;
  statuses: Record<string, number>;
  durationMs: { min: number; max: number; total: number };
}

export interface DiagnosticsTelemetrySession {
  id: string;
  records: Record<string, unknown>[];
  truncated?: boolean;
}

/** Why a session of the tree contributes less than its whole file. */
export type DiagnosticsSessionSkipReason =
  | "file_too_large"
  | "unreadable"
  | "over_total_cap"
  | "over_session_cap";

export interface DiagnosticsSkippedSession {
  session: string;
  reason: DiagnosticsSessionSkipReason;
}

export interface DiagnosticsBundle {
  format: "anycode-diagnostics";
  version: 1;
  generatedAt: string;
  app: DiagnosticsAppInfo;
  anonymization: { applied: true; saltIncluded: false; redactions: number };
  telemetry: {
    /** Salted id of the requested tree root. */
    rootSession: string;
    filesRead: number;
    filesSkipped: number;
    /** Unparseable MIDDLE lines (a torn trailing line is counted separately). */
    malformedLines: number;
    /** Well-formed records of an unknown/dropped type, or without a timestamp. */
    droppedRecords: number;
    /** An append in progress: a trailing line without its newline. Expected, not corruption. */
    partialTailLines: number;
    truncated: boolean;
    sessions: DiagnosticsTelemetrySession[];
    /** Tree members that were left out, with a closed reason (never unrelated sessions). */
    notIncluded: DiagnosticsSkippedSession[];
  };
  toolShapes: Record<string, DiagnosticsToolShape>;
  wire: {
    entries: DiagnosticsRingEntry[];
    byChannel: Record<string, number>;
    truncated: boolean;
  };
  notes: string[];
}

export interface DiagnosticsBuild {
  bundle: DiagnosticsBundle;
  /** Compact JSON, strictly fewer than `maxBytes` UTF-8 bytes. */
  json: string;
  summary: DiagnosticsSummary;
}

/** One telemetry file's session id (the file name) and identity on disk. */
interface TelemetryFile {
  name: string;
  session: string;
  size: number;
  mtimeMs: number;
}

/** `projectTelemetryRecord`'s verdict — the bundle counts each kind separately. */
export type TelemetryProjection =
  | { kind: "record"; session: string; record: Record<string, unknown> }
  | { kind: "unknown_type" }
  | { kind: "invalid" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safeText(value: string, redactor: (input: string) => string): string {
  return redactor(value).slice(0, DIAGNOSTICS_MAX_FIELD_CHARS);
}

/**
 * Projects ONE telemetry line. Returns `unknown_type` for anything that is not
 * a `t` this build knows — including a future or forged record, so its
 * payload cannot reach the bundle — and `invalid` for a known type that is
 * missing the envelope timestamp.
 */
export function projectTelemetryRecord(
  raw: unknown,
  deps: { anon: ReturnType<typeof createDiagnosticsAnonymizer>; sessionId: (raw: string) => string },
): TelemetryProjection {
  if (!isRecord(raw)) return { kind: "invalid" };
  const type = raw.t;
  if (typeof type !== "string" || !Object.prototype.hasOwnProperty.call(TELEMETRY_FIELDS, type)) {
    return { kind: "unknown_type" };
  }
  const fields = TELEMETRY_FIELDS[type];
  if (fields === undefined) return { kind: "unknown_type" };
  const ts = finiteNumber(raw.ts);
  if (ts === undefined) return { kind: "invalid" };
  const sessionRaw = typeof raw.session === "string" && raw.session.length > 0 ? raw.session : "unattributed";
  const session = sessionRaw === "unattributed" ? "id_unattributed" : deps.sessionId(sessionRaw);

  const record: Record<string, unknown> = { t: type, ts };
  const sub = isRecord(raw.sub)
    ? {
        ...(typeof raw.sub.agentType === "string" ? { agentType: safeText(raw.sub.agentType, deps.anon.text) } : {}),
        ...(typeof raw.sub.model === "string" ? { model: safeText(raw.sub.model, deps.anon.text) } : {}),
      }
    : undefined;
  if (sub !== undefined && Object.keys(sub).length > 0) record.sub = sub;

  for (const [field, kind] of Object.entries(fields)) {
    const value = raw[field];
    if (kind === "number") {
      const number = finiteNumber(value);
      if (number !== undefined) record[field] = number;
    } else if (kind === "boolean") {
      if (typeof value === "boolean") record[field] = value;
    } else if (typeof value === "string") {
      record[field] = safeText(value, deps.anon.text);
    }
  }
  // The tree edge is an id like any other: hashed per export, so the bundle
  // still shows the shape (root -> child) without ever naming a session.
  if (type === "session_start" && typeof raw.parentSession === "string" && raw.parentSession.length > 0) {
    record.parentSession = deps.sessionId(raw.parentSession);
  }
  return { kind: "record", session, record };
}

async function listTelemetryFiles(
  fs: DiagnosticsFs,
  dir: string,
): Promise<{ files: TelemetryFile[]; skipped: number }> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return { files: [], skipped: 0 };
  }
  const files: TelemetryFile[] = [];
  let skipped = 0;
  for (const name of names) {
    if (!TELEMETRY_FILE_RE.test(name)) continue;
    try {
      const stat = await fs.lstat(`${dir}/${name}`);
      // Symlinks are skipped outright: a link swapped into the telemetry dir
      // must never let the export read an arbitrary file.
      if (!stat.isFile || stat.isSymbolicLink === true) {
        skipped += 1;
        continue;
      }
      files.push({ name, session: name.slice(0, -".jsonl".length), size: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      // A vanished/permission-denied file is simply not exported.
      skipped += 1;
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
  return { files, skipped };
}

/**
 * Reads the tree edges ONLY: each file's first complete lines, looking for a
 * `session_start.parentSession`. Head reads are bounded, are used to decide
 * membership alone, and never reach the bundle.
 */
async function readParentEdges(
  deps: DiagnosticsExportDeps,
  files: readonly TelemetryFile[],
): Promise<Map<string, string>> {
  const edges = new Map<string, string>();
  // Newest-first (the caller's order), bounded: a child is always created
  // after its parent, so a descendant of the requested session cannot hide
  // behind years of older, unrelated files.
  for (const file of files.slice(0, DIAGNOSTICS_TELEMETRY_MAX_EDGE_FILES)) {
    let head: string;
    try {
      head = await deps.fs.readFileHeadNoFollow(`${deps.telemetryDir}/${file.name}`, DIAGNOSTICS_TELEMETRY_HEAD_BYTES);
    } catch {
      continue;
    }
    const complete = file.size > DIAGNOSTICS_TELEMETRY_HEAD_BYTES ? head.slice(0, Math.max(0, head.lastIndexOf("\n"))) : head;
    for (const line of complete.split("\n")) {
      if (line.trim().length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(parsed) || parsed.t !== "session_start") continue;
      const parent = parsed.parentSession;
      if (typeof parent === "string" && parent.length > 0 && parent !== file.session) {
        edges.set(file.session, parent);
      }
      break;
    }
  }
  return edges;
}

/** Transitive closure: the root plus every session whose ancestor chain reaches it. */
export function sessionTreeOf(root: string, edges: ReadonlyMap<string, string>): Set<string> {
  const tree = new Set<string>([root]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [child, parent] of edges) {
      if (tree.has(child)) continue;
      if (!tree.has(parent)) continue;
      tree.add(child);
      grew = true;
    }
  }
  return tree;
}

interface TelemetryReadResult {
  rootSession: string;
  sessions: Map<string, DiagnosticsTelemetrySession>;
  filesRead: number;
  filesSkipped: number;
  malformedLines: number;
  droppedRecords: number;
  partialTailLines: number;
  notIncluded: DiagnosticsSkippedSession[];
  truncated: boolean;
}

async function readTelemetry(
  deps: DiagnosticsExportDeps,
  anon: ReturnType<typeof createDiagnosticsAnonymizer>,
): Promise<TelemetryReadResult> {
  const listed = await listTelemetryFiles(deps.fs, deps.telemetryDir);
  const sessionIds = new Map<string, string>();
  const sessionIdFor = (raw: string): string => {
    const existing = sessionIds.get(raw);
    if (existing !== undefined) return existing;
    const hashed = anon.id(raw);
    sessionIds.set(raw, hashed);
    return hashed;
  };
  const rootSession = sessionIdFor(deps.sessionId);

  const empty: TelemetryReadResult = {
    rootSession,
    sessions: new Map(),
    filesRead: 0,
    filesSkipped: listed.skipped,
    malformedLines: 0,
    droppedRecords: 0,
    partialTailLines: 0,
    notIncluded: [],
    truncated: false,
  };

  const rootFile = listed.files.find((file) => file.session === deps.sessionId);
  if (rootFile === undefined) {
    // Nothing on disk for the requested session: an empty, valid bundle is
    // still useful (wire rings + app identity), and no other session is read.
    return empty;
  }

  // The root's own head comes first so its edge is always discovered; the rest
  // is newest-first and bounded by the edge cap.
  const edgeCandidates = [rootFile, ...listed.files.filter((file) => file !== rootFile)];
  const edges = await readParentEdges(deps, edgeCandidates);
  const tree = sessionTreeOf(deps.sessionId, edges);
  const treeFiles = listed.files.filter((file) => tree.has(file.session));
  const rootFirst = [rootFile, ...treeFiles.filter((file) => file !== rootFile)];

  const sessions = new Map<string, DiagnosticsTelemetrySession>();
  const notIncluded: DiagnosticsSkippedSession[] = [];
  let filesRead = 0;
  let filesSkipped = listed.skipped + (listed.files.length - treeFiles.length);
  let malformedLines = 0;
  let droppedRecords = 0;
  let partialTailLines = 0;
  let totalBytes = 0;
  let truncated = false;

  for (const [index, file] of rootFirst.entries()) {
    const session = sessionIdFor(file.session);
    if (index >= DIAGNOSTICS_TELEMETRY_MAX_TREE_FILES) {
      filesSkipped += 1;
      notIncluded.push({ session, reason: "over_total_cap" });
      truncated = true;
      continue;
    }
    // A long session is read from its TAIL: recent records are what a
    // diagnosis needs, and dropping the whole file would silently hide the
    // very session the person is debugging.
    const oversized = file.size > DIAGNOSTICS_TELEMETRY_MAX_FILE_BYTES;
    const wantBytes = oversized ? Math.min(DIAGNOSTICS_TELEMETRY_TAIL_BYTES, file.size) : file.size;
    if (filesRead > 0 && totalBytes + wantBytes > DIAGNOSTICS_TELEMETRY_MAX_TOTAL_BYTES) {
      filesSkipped += 1;
      notIncluded.push({ session, reason: "over_total_cap" });
      truncated = true;
      continue;
    }
    let content: string;
    try {
      content = oversized
        ? await deps.fs.readFileTailNoFollow(`${deps.telemetryDir}/${file.name}`, wantBytes)
        : await deps.fs.readFileNoFollow(`${deps.telemetryDir}/${file.name}`);
    } catch {
      filesSkipped += 1;
      notIncluded.push({ session, reason: "unreadable" });
      continue;
    }
    filesRead += 1;
    totalBytes += byteLength(content);
    const headDropped = oversized && file.size > wantBytes;
    if (headDropped) {
      // The tail starts mid-line; that fragment is not a record and is not
      // corruption either.
      const firstBreak = content.indexOf("\n");
      content = firstBreak < 0 ? "" : content.slice(firstBreak + 1);
      truncated = true;
    }

    let group = sessions.get(session);
    if (group === undefined) {
      group = { id: session, records: [] };
      sessions.set(session, group);
    }
    if (headDropped) group.truncated = true;

    const lines = content.split("\n");
    const hasTrailingNewline = content.endsWith("\n");
    for (const [lineIndex, line] of lines.entries()) {
      if (line.trim().length === 0) continue;
      const isLastLine = lineIndex === lines.length - 1;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // An append in flight leaves an unterminated trailing line. That is
        // the normal state of a live sink, not a corrupt file.
        if (isLastLine && !hasTrailingNewline) partialTailLines += 1;
        else malformedLines += 1;
        continue;
      }
      const projected = projectTelemetryRecord(parsed, { anon, sessionId: sessionIdFor });
      if (projected.kind !== "record") {
        droppedRecords += 1;
        continue;
      }
      group.records.push(projected.record);
    }
  }

  // Keep the newest sessions and, per session, the newest records.
  const ordered = [...sessions.values()].sort(
    (a, b) => (finiteNumber(b.records.at(-1)?.ts) ?? 0) - (finiteNumber(a.records.at(-1)?.ts) ?? 0),
  );
  const kept = new Map<string, DiagnosticsTelemetrySession>();
  for (const group of ordered.slice(0, DIAGNOSTICS_TELEMETRY_MAX_SESSIONS)) {
    const over = group.records.length > DIAGNOSTICS_TELEMETRY_MAX_RECORDS_PER_SESSION;
    kept.set(group.id, {
      id: group.id,
      records: over ? group.records.slice(-DIAGNOSTICS_TELEMETRY_MAX_RECORDS_PER_SESSION) : group.records,
      ...(over || group.truncated === true ? { truncated: true as const } : {}),
    });
  }
  for (const group of ordered.slice(DIAGNOSTICS_TELEMETRY_MAX_SESSIONS)) {
    notIncluded.push({ session: group.id, reason: "over_session_cap" });
    truncated = true;
  }

  return {
    rootSession,
    sessions: kept,
    filesRead,
    filesSkipped,
    malformedLines,
    droppedRecords,
    partialTailLines,
    notIncluded,
    truncated,
  };
}

function buildToolShapes(sessions: Iterable<DiagnosticsTelemetrySession>): Record<string, DiagnosticsToolShape> {
  const shapes: Record<string, DiagnosticsToolShape> = Object.create(null) as Record<string, DiagnosticsToolShape>;
  for (const session of sessions) {
    for (const record of session.records) {
      if (record.t !== "tool" || typeof record.tool !== "string") continue;
      const tool = record.tool.slice(0, DIAGNOSTICS_MAX_FIELD_CHARS);
      const shape = (shapes[tool] ??= {
        calls: 0,
        statuses: Object.create(null) as Record<string, number>,
        durationMs: { min: 0, max: 0, total: 0 },
      });
      shape.calls += 1;
      if (typeof record.status === "string") {
        const status = record.status.slice(0, DIAGNOSTICS_MAX_FIELD_CHARS);
        shape.statuses[status] = (shape.statuses[status] ?? 0) + 1;
      }
      const duration = finiteNumber(record.durationMs);
      if (duration !== undefined && duration >= 0) {
        shape.durationMs.total += duration;
        shape.durationMs.max = Math.max(shape.durationMs.max, duration);
        shape.durationMs.min = shape.durationMs.min === 0 ? duration : Math.min(shape.durationMs.min, duration);
      }
    }
  }
  return shapes;
}

function countByChannel(entries: readonly DiagnosticsRingEntry[]): Record<string, number> {
  const byChannel: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const entry of entries) {
    byChannel[entry.channel] = (byChannel[entry.channel] ?? 0) + 1;
  }
  return byChannel;
}

function buildWire(
  rings: readonly DiagnosticsRingEntry[],
  hostRings: unknown,
  redact: (value: string) => string,
): DiagnosticsBundle["wire"] {
  const merged = [
    ...parseDiagnosticsRingEntries([...rings], "main", DIAGNOSTICS_WIRE_MAX_ENTRIES),
    ...parseDiagnosticsRingEntries(hostRings, "host", DIAGNOSTICS_WIRE_MAX_ENTRIES),
  ].sort((a, b) => a.at - b.at);
  const kept = merged.slice(-DIAGNOSTICS_WIRE_MAX_ENTRIES).map((entry) => ({
    ...entry,
    // Defence in depth: the ring already refuses anything but an identifier,
    // but a compromised host can still choose an identifier-looking string.
    // A hostname/token smuggled into `type` is scrubbed here too.
    channel: redact(entry.channel).slice(0, DIAGNOSTICS_MAX_FIELD_CHARS),
    ...(entry.code !== undefined ? { code: redact(entry.code).slice(0, DIAGNOSTICS_MAX_FIELD_CHARS) } : {}),
  }));
  return { entries: kept, byChannel: countByChannel(kept), truncated: merged.length > kept.length };
}

/** Index of the OLDEST session that still has records (sessions are newest-first). */
function oldestSessionWithRecords(sessions: readonly DiagnosticsTelemetrySession[]): DiagnosticsTelemetrySession | undefined {
  for (let index = sessions.length - 1; index >= 0; index -= 1) {
    const session = sessions[index];
    if (session !== undefined && session.records.length > 0) return session;
  }
  return undefined;
}

/**
 * Trims the bundle until its compact JSON is strictly below `maxBytes`.
 * Dropping order, oldest data first: the OLDEST session's oldest records, then
 * the oldest empty sessions, then the oldest wire entries, then the largest
 * tool-shape entries. The requested session is therefore the last thing to be
 * touched. Every drop sets `truncated` and adds one note so the reader knows
 * the bundle is partial.
 */
function fitBundle(bundle: DiagnosticsBundle, maxBytes: number): { bundle: DiagnosticsBundle; json: string } {
  const notes = bundle.notes;
  const markTruncated = (why: string): void => {
    if (!notes.includes(why)) notes.push(why);
  };
  const serialise = (): string => JSON.stringify(bundle);

  let json = serialise();
  if (byteLength(json) < maxBytes) return { bundle, json };

  while (byteLength(json) >= maxBytes) {
    const session = oldestSessionWithRecords(bundle.telemetry.sessions);
    if (session !== undefined) {
      const drop = Math.max(1, Math.ceil(session.records.length / 2));
      session.records = session.records.slice(drop);
      session.truncated = true;
      bundle.telemetry.truncated = true;
      markTruncated("telemetry records dropped to fit the size cap");
      json = serialise();
      continue;
    }
    // Only EMPTY sessions remain: drop the oldest of them.
    const lastIndex = bundle.telemetry.sessions.length - 1;
    const last = bundle.telemetry.sessions[lastIndex];
    if (last !== undefined && last.records.length === 0) {
      bundle.telemetry.sessions.splice(lastIndex, 1);
      bundle.telemetry.truncated = true;
      markTruncated("telemetry sessions dropped to fit the size cap");
      json = serialise();
      continue;
    }
    if (bundle.wire.entries.length > 0) {
      const keep = Math.max(1, Math.floor(bundle.wire.entries.length / 2));
      bundle.wire.entries = bundle.wire.entries.slice(-keep);
      bundle.wire.byChannel = countByChannel(bundle.wire.entries);
      bundle.wire.truncated = true;
      markTruncated("wire entries dropped to fit the size cap");
      json = serialise();
      continue;
    }
    const largestTool = Object.keys(bundle.toolShapes).sort(
      (a, b) => JSON.stringify(bundle.toolShapes[b]).length - JSON.stringify(bundle.toolShapes[a]).length,
    )[0];
    if (largestTool !== undefined) {
      delete bundle.toolShapes[largestTool];
      markTruncated("tool shapes dropped to fit the size cap");
      json = serialise();
      continue;
    }
    markTruncated("bundle could not be reduced below the size cap");
    break;
  }
  return { bundle, json };
}

function sectionBytes(value: unknown): number {
  return byteLength(JSON.stringify(value));
}

/**
 * Builds the anonymised bundle for ONE session tree. Never throws for a
 * missing/unreadable telemetry directory, nor for a root session with no file
 * (the bundle is still useful with only the wire rings).
 */
export async function buildDiagnosticsBundle(deps: DiagnosticsExportDeps): Promise<DiagnosticsBuild> {
  // A floor keeps the "strictly below maxBytes" guarantee meaningful for a
  // tiny injected cap (tests): the fixed envelope alone is a few hundred bytes.
  const maxBytes = Math.max(2_048, deps.maxBytes ?? DIAGNOSTICS_MAX_BUNDLE_BYTES);
  const now = deps.now ?? Date.now;
  const generatedAtMs = now();
  const anon = createDiagnosticsAnonymizer({ ...(deps.salt !== undefined ? { salt: deps.salt } : {}) });

  const telemetry = await readTelemetry(deps, anon);
  const wire = buildWire(deps.rings ?? [], deps.hostRings, anon.text);
  const bundle: DiagnosticsBundle = {
    format: "anycode-diagnostics",
    version: 1,
    generatedAt: new Date(generatedAtMs).toISOString(),
    app: {
      version: deps.app.version,
      platform: deps.app.platform,
      arch: deps.app.arch,
      ...(deps.app.electron !== undefined ? { electron: deps.app.electron } : {}),
      ...(deps.app.node !== undefined ? { node: deps.app.node } : {}),
    },
    // The salt is deliberately absent: it would make the id hashes reversible.
    anonymization: { applied: true, saltIncluded: false, redactions: anon.redactionCount() },
    telemetry: {
      rootSession: telemetry.rootSession,
      filesRead: telemetry.filesRead,
      filesSkipped: telemetry.filesSkipped,
      malformedLines: telemetry.malformedLines,
      droppedRecords: telemetry.droppedRecords,
      partialTailLines: telemetry.partialTailLines,
      truncated: telemetry.truncated,
      sessions: [...telemetry.sessions.values()],
      notIncluded: telemetry.notIncluded,
    },
    toolShapes: buildToolShapes(telemetry.sessions.values()),
    wire,
    notes: [],
  };

  const fitted = fitBundle(bundle, maxBytes);

  const summary: DiagnosticsSummary = {
    generatedAt: fitted.bundle.generatedAt,
    bytes: byteLength(fitted.json),
    sections: [
      {
        name: "telemetry",
        records: fitted.bundle.telemetry.sessions.reduce((sum, session) => sum + session.records.length, 0),
        bytes: sectionBytes(fitted.bundle.telemetry),
      },
      {
        name: "toolShapes",
        records: Object.keys(fitted.bundle.toolShapes).length,
        bytes: sectionBytes(fitted.bundle.toolShapes),
      },
      {
        name: "wire",
        records: fitted.bundle.wire.entries.length,
        bytes: sectionBytes(fitted.bundle.wire),
      },
    ] satisfies DiagnosticsSectionSummary[],
    truncated:
      fitted.bundle.telemetry.truncated ||
      fitted.bundle.wire.truncated ||
      fitted.bundle.notes.length > 0,
    redactions: fitted.bundle.anonymization.redactions,
  };

  return { bundle: fitted.bundle, json: fitted.json, summary };
}

/** The anonymised text a person can review before saving. */
export function renderDiagnosticsPreview(json: string, maxChars = DIAGNOSTICS_PREVIEW_MAX_CHARS): string {
  if (json.length <= maxChars) return json;
  return `${json.slice(0, maxChars)}\n… preview truncated (${byteLength(json)} bytes total)`;
}

/** One live tab's host, as far as ring collection needs it. */
export interface HostRingSource {
  listTabs(): readonly { sessionId: string; workspace?: string }[];
  communicationRequest(
    sessionId: string,
    operation: string,
    payload?: unknown,
    expectedWorkspace?: string,
    requestOptions?: { timeoutMs?: number; allowNonRunning?: boolean },
  ): Promise<unknown>;
}

export const HOST_RING_REQUEST_TIMEOUT_MS = 750;
export const HOST_RING_MAX_TABS = 16;
/** Wall-clock budget for the whole sweep; a dead host must not freeze the dialog. */
export const HOST_RING_TOTAL_BUDGET_MS = 3_000;

/**
 * Asks the live hosts for their ring snapshots, ONE AT A TIME. Sequential on
 * purpose: every request attaches a `message` listener to the SAME host port,
 * so a fan-out of 16 would trip Node's max-listeners warning on every export
 * and would also interleave 16 in-flight RPCs on a control plane that is
 * processing a turn. A dead, booting or degraded host contributes nothing
 * rather than failing the export, its answer is re-validated as untrusted
 * data, and the sweep stops asking once the total budget is spent.
 */
export async function collectHostRingEntries(
  source: HostRingSource,
  options?: { timeoutMs?: number; maxTabs?: number; budgetMs?: number; now?: () => number },
): Promise<DiagnosticsRingEntry[]> {
  const timeoutMs = options?.timeoutMs ?? HOST_RING_REQUEST_TIMEOUT_MS;
  const maxTabs = options?.maxTabs ?? HOST_RING_MAX_TABS;
  const budgetMs = options?.budgetMs ?? HOST_RING_TOTAL_BUDGET_MS;
  const now = options?.now ?? Date.now;
  const deadline = now() + budgetMs;
  const tabs = source.listTabs().slice(0, maxTabs);
  const entries: DiagnosticsRingEntry[] = [];
  for (const tab of tabs) {
    const remaining = deadline - now();
    if (remaining <= 0) break;
    try {
      const result = await source.communicationRequest(
        tab.sessionId,
        "get_diagnostics_ring",
        undefined,
        tab.workspace,
        { timeoutMs: Math.max(1, Math.min(timeoutMs, remaining)), allowNonRunning: true },
      );
      entries.push(...parseDiagnosticsRingEntries(result, "host", DIAGNOSTICS_WIRE_MAX_ENTRIES));
    } catch {
      // Best effort: one unresponsive host never fails the export.
    }
  }
  return entries;
}
