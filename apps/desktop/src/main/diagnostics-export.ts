/**
 * Diagnostics bundle builder (GitHub #18).
 *
 * Collects four bounded, local sources into ONE anonymised JSON document:
 *
 * - telemetry records from the profile's telemetry directory, projected
 *   through a per-type WHITELIST (prompts, model output, tool arguments and
 *   results have no route into the bundle — an unlisted field or an unknown
 *   record type is dropped, never passed through);
 * - derived tool SHAPES (name -> calls/statuses/duration), no arguments, no
 *   outputs;
 * - the main and host ring logs (control-plane wire shapes only, see
 *   shared/diagnostics-ring.ts);
 * - app/runtime identity (version, platform, arch) — no hostname, no user, no
 *   paths.
 *
 * Everything is additionally scrubbed by `diagnostics-anonymize` (secrets,
 * paths, URLs/hosts, e-mails, raw ids hashed with a per-export salt) and the
 * exact serialised size is measured; when it would reach the 5 MB ceiling the
 * builder drops the oldest telemetry records / wire entries / sessions until
 * it is strictly below it. The build function is Electron-free and takes its
 * filesystem through a narrow port, so the privacy properties are testable
 * through the production path.
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
  writeFile(path: string, content: string, opts?: { mode?: number }): Promise<void>;
}

export const DIAGNOSTICS_TELEMETRY_MAX_FILES = 50;
export const DIAGNOSTICS_TELEMETRY_MAX_FILE_BYTES = 1024 * 1024;
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
  subagent_start: { agentType: "text", model: "text", engine: "text", route: "text", fallbackReason: "text" },
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

export interface DiagnosticsBundle {
  format: "anycode-diagnostics";
  version: 1;
  generatedAt: string;
  app: DiagnosticsAppInfo;
  anonymization: { applied: true; saltIncluded: false; redactions: number };
  telemetry: {
    filesRead: number;
    filesSkipped: number;
    malformedLines: number;
    truncated: boolean;
    sessions: DiagnosticsTelemetrySession[];
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

interface TelemetryFile {
  name: string;
  size: number;
  mtimeMs: number;
}

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
 * Projects ONE telemetry line. Returns null for anything that is not a known
 * record type — including a `t` the current build does not know, so a future
 * or forged record cannot carry an unvetted payload into the bundle.
 */
export function projectTelemetryRecord(
  raw: unknown,
  deps: { anon: ReturnType<typeof createDiagnosticsAnonymizer>; sessionId: (raw: string) => string },
): { session: string; record: Record<string, unknown> } | null {
  if (!isRecord(raw)) return null;
  const type = raw.t;
  if (typeof type !== "string" || !Object.prototype.hasOwnProperty.call(TELEMETRY_FIELDS, type)) return null;
  const fields = TELEMETRY_FIELDS[type];
  if (fields === undefined) return null;
  const ts = finiteNumber(raw.ts);
  if (ts === undefined) return null;
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
  return { session, record };
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
      files.push({ name, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      // A vanished/permission-denied file is simply not exported.
      skipped += 1;
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
  return { files, skipped };
}

interface TelemetryReadResult {
  sessions: Map<string, DiagnosticsTelemetrySession>;
  filesRead: number;
  filesSkipped: number;
  malformedLines: number;
}

async function readTelemetry(
  deps: DiagnosticsExportDeps,
  anon: ReturnType<typeof createDiagnosticsAnonymizer>,
): Promise<TelemetryReadResult> {
  const listed = await listTelemetryFiles(deps.fs, deps.telemetryDir);
  const files = listed.files;
  const sessions = new Map<string, DiagnosticsTelemetrySession>();
  const sessionIds = new Map<string, string>();
  const sessionIdFor = (raw: string): string => {
    const existing = sessionIds.get(raw);
    if (existing !== undefined) return existing;
    const hashed = anon.id(raw);
    sessionIds.set(raw, hashed);
    return hashed;
  };

  let filesRead = 0;
  let filesSkipped = listed.skipped;
  let malformedLines = 0;
  let totalBytes = 0;
  for (const file of files) {
    if (filesRead >= DIAGNOSTICS_TELEMETRY_MAX_FILES) {
      filesSkipped += 1;
      continue;
    }
    if (file.size > DIAGNOSTICS_TELEMETRY_MAX_FILE_BYTES) {
      filesSkipped += 1;
      continue;
    }
    if (filesRead > 0 && totalBytes + file.size > DIAGNOSTICS_TELEMETRY_MAX_TOTAL_BYTES) {
      filesSkipped += 1;
      continue;
    }
    let content: string;
    try {
      content = await deps.fs.readFileNoFollow(`${deps.telemetryDir}/${file.name}`);
    } catch {
      filesSkipped += 1;
      continue;
    }
    filesRead += 1;
    totalBytes += byteLength(content);
    for (const line of content.split("\n")) {
      if (line.trim().length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        malformedLines += 1;
        continue;
      }
      const projected = projectTelemetryRecord(parsed, { anon, sessionId: sessionIdFor });
      if (projected === null) {
        malformedLines += 1;
        continue;
      }
      let group = sessions.get(projected.session);
      if (group === undefined) {
        group = { id: projected.session, records: [] };
        sessions.set(projected.session, group);
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
      ...(over ? { truncated: true as const } : {}),
    });
  }
  return { sessions: kept, filesRead, filesSkipped, malformedLines };
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
  const byChannel: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const entry of kept) {
    byChannel[entry.channel] = (byChannel[entry.channel] ?? 0) + 1;
  }
  return { entries: kept, byChannel, truncated: merged.length > kept.length };
}

/**
 * Trims the bundle until its compact JSON is strictly below `maxBytes`.
 * Dropping order: oldest telemetry records, then oldest sessions, then oldest
 * wire entries, then the largest tool-shape entries. Every drop sets
 * `truncated` and adds one note so the reader knows the bundle is partial.
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
    const session = bundle.telemetry.sessions.find((entry) => entry.records.length > 0);
    if (session !== undefined) {
      const drop = Math.max(1, Math.ceil(session.records.length / 2));
      session.records = session.records.slice(drop);
      session.truncated = true;
      bundle.telemetry.truncated = true;
      markTruncated("telemetry records dropped to fit the size cap");
      json = serialise();
      continue;
    }
    if (bundle.telemetry.sessions.length > 0) {
      bundle.telemetry.sessions.shift();
      bundle.telemetry.truncated = true;
      markTruncated("telemetry sessions dropped to fit the size cap");
      json = serialise();
      continue;
    }
    if (bundle.wire.entries.length > 0) {
      const drop = Math.max(1, Math.ceil(bundle.wire.entries.length / 2));
      bundle.wire.entries = bundle.wire.entries.slice(drop);
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
 * Builds the anonymised bundle. Never throws for a missing/unreadable
 * telemetry directory (the bundle is still useful with only the wire rings).
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
      filesRead: telemetry.filesRead,
      filesSkipped: telemetry.filesSkipped,
      malformedLines: telemetry.malformedLines,
      truncated: false,
      sessions: [...telemetry.sessions.values()],
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
    requestOptions?: { timeoutMs?: number },
  ): Promise<unknown>;
}

export const HOST_RING_REQUEST_TIMEOUT_MS = 750;
export const HOST_RING_MAX_TABS = 16;

/**
 * Asks every live host for its ring snapshot. Best-effort by design: a dead,
 * booting or unresponsive host contributes nothing rather than failing the
 * export, and its answer is re-validated as untrusted data before it can
 * reach the bundle.
 */
export async function collectHostRingEntries(
  source: HostRingSource,
  options?: { timeoutMs?: number; maxTabs?: number },
): Promise<DiagnosticsRingEntry[]> {
  const timeoutMs = options?.timeoutMs ?? HOST_RING_REQUEST_TIMEOUT_MS;
  const maxTabs = options?.maxTabs ?? HOST_RING_MAX_TABS;
  const tabs = source.listTabs().slice(0, maxTabs);
  const results = await Promise.allSettled(
    tabs.map((tab) =>
      source.communicationRequest(tab.sessionId, "get_diagnostics_ring", undefined, tab.workspace, { timeoutMs }),
    ),
  );
  const entries: DiagnosticsRingEntry[] = [];
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    entries.push(...parseDiagnosticsRingEntries(result.value, "host", DIAGNOSTICS_WIRE_MAX_ENTRIES));
  }
  return entries;
}
