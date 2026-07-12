/**
 * Harness MCP-config readers (design slice-P7.19-cut.md §4 W1). Pure readers over
 * a FileSystemPort that discover MCP server definitions in OTHER coding harnesses'
 * config files (Claude, Codex, zcode) plus our own compat `.mcp.json`, and
 * normalize them into `HarnessImportCandidate`s for the trust-gated import flow.
 *
 * Security invariants (§3):
 *  - Path safety (enumerate-the-good): `scanHarnessConfigs` reads a FIXED
 *    allowlist derived from `home` + `workspace` ONLY. No caller-supplied paths,
 *    no recursive scanning.
 *  - Fail-soft: a missing file is a silent no-op; a bad parse or an invalid entry
 *    becomes a `problems[]` note and is skipped — a scan never throws.
 *  - Custody: `envKeys` carries ONLY the KEY NAMES of env/headers for masked
 *    renderer display. The candidate's `entry` DOES still carry env/header VALUES
 *    because import-apply needs them MAIN-side; the renderer-facing projection
 *    (W2) strips values. Values are never stripped here.
 */

import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import type { FileSystemPort } from "../ports/file-system.js";
import { mcpServerEntrySchema, type McpServerEntry } from "./config.js";

/** Origin harness of a discovered candidate. */
export type HarnessKind = "claude" | "claude-project" | "mcp-json" | "codex" | "zcode";

/** A normalized MCP server discovered in a foreign (or compat) harness config. */
export interface HarnessImportCandidate {
  harness: HarnessKind;
  sourcePath: string;
  name: string;
  /** Validated entry — carries env/header VALUES (import-apply needs them main-side). */
  entry: McpServerEntry;
  /** KEY NAMES of env + headers, for masked renderer display (custody §3). */
  envKeys: string[];
  /** True for `<ws>/.mcp.json` rows — already active via the compat loader. */
  alreadyActiveViaCompat?: boolean;
}

export interface HarnessScanResult {
  candidates: HarnessImportCandidate[];
  problems: string[];
}

interface ScanAccumulator {
  candidates: HarnessImportCandidate[];
  problems: string[];
}

// ---------------------------------------------------------------------------
// Local helpers (deliberately not shared with config.ts — independent readers).

/**
 * Content-free parse-failure note (P7.19/W5-FIX, finding 1 — CRITICAL). A raw
 * parser/exception message (`smol-toml`'s especially, but also `JSON.parse`'s)
 * can quote nearby SOURCE LINES of the malformed config — which may contain a
 * secret env value — and this string crosses to the renderer via `problems[]`.
 * NEVER concatenate the caught error's `.message`: the note names only the
 * harness, the path, and the format.
 */
function parseFailureProblem(harness: string, path: string, format: "JSON" | "TOML"): string {
  return `Failed to parse ${harness} config at ${path} (malformed ${format})`;
}

/** Content-free read-failure note (W5-FIX, finding 1): never echoes the caught error's message. */
function readFailureProblem(harness: string, path: string): string {
  return `Failed to read ${harness} config at ${path}`;
}

/**
 * Reserved object keys that hit `Object.prototype` setters (`__proto__`) or
 * built-in members (`constructor`/`prototype`) rather than defining a plain
 * data property. A foreign config using one as a server name is skipped
 * (W5-FIX, finding 7) — reading it into a `{ name -> entry }` map is prototype
 * pollution, and it can never be a legitimate MCP server name.
 */
const DANGEROUS_SERVER_NAMES = new Set(["__proto__", "constructor", "prototype"]);

function isDangerousServerName(name: string): boolean {
  return DANGEROUS_SERVER_NAMES.has(name);
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length ? issue.path.join(".") : "(root)"}: ${issue.message}`)
    .join("; ");
}

/** Strips a trailing path separator so `${base}/x` never doubles up. */
function stripTrailingSep(base: string): string {
  return base.replace(/[/\\]+$/, "");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads + JSON-parses a file. Missing = silent no-op (undefined); bad = content-free problem + undefined. */
async function readJsonFile(
  fs: FileSystemPort,
  path: string,
  harness: string,
  problems: string[],
): Promise<unknown | undefined> {
  if (!(await fs.exists(path))) {
    return undefined;
  }
  let raw: string;
  try {
    raw = await fs.readFile(path);
  } catch {
    problems.push(readFailureProblem(harness, path));
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    // W5-FIX (finding 1): the raw JSON.parse message can quote the offending
    // source line (which may carry a secret) — never concatenate it.
    problems.push(parseFailureProblem(harness, path, "JSON"));
    return undefined;
  }
}

type EntryValidation = { ok: true; entry: McpServerEntry } | { ok: false; message: string };

/** Validates a raw entry against the shared schema + the exactly-one-of-command/url rule. */
function validateRawEntry(rawEntry: unknown): EntryValidation {
  const parsed = mcpServerEntrySchema.safeParse(rawEntry);
  if (!parsed.success) {
    return { ok: false, message: formatZodError(parsed.error) };
  }
  const entry = parsed.data;
  const hasCommand = entry.command !== undefined;
  const hasUrl = entry.url !== undefined;
  if (hasCommand === hasUrl) {
    return { ok: false, message: 'must have exactly one of "command" (stdio) or "url" (http)' };
  }
  return { ok: true, entry };
}

function pushCandidate(
  out: ScanAccumulator,
  harness: HarnessKind,
  sourcePath: string,
  name: string,
  entry: McpServerEntry,
  opts?: { alreadyActiveViaCompat?: boolean },
): void {
  const envKeys = [...Object.keys(entry.env ?? {}), ...Object.keys(entry.headers ?? {})];
  const candidate: HarnessImportCandidate = { harness, sourcePath, name, entry, envKeys };
  if (opts?.alreadyActiveViaCompat) {
    candidate.alreadyActiveViaCompat = true;
  }
  out.candidates.push(candidate);
}

/** Validates + collects every entry of a `{ name -> entry }` record shaped like ours. */
function collectServers(
  rawServers: unknown,
  harness: HarnessKind,
  sourcePath: string,
  out: ScanAccumulator,
  opts?: { alreadyActiveViaCompat?: boolean },
): void {
  if (rawServers === undefined) {
    return;
  }
  if (!isPlainObject(rawServers)) {
    out.problems.push(`${sourcePath}: "mcpServers" is not an object — skipped`);
    return;
  }
  for (const [name, raw] of Object.entries(rawServers)) {
    if (isDangerousServerName(name)) {
      out.problems.push(`${sourcePath}: skipped server with a reserved unsafe name`);
      continue;
    }
    const validation = validateRawEntry(raw);
    if (!validation.ok) {
      out.problems.push(`${sourcePath}: server '${name}' skipped — ${validation.message}`);
      continue;
    }
    pushCandidate(out, harness, sourcePath, name, validation.entry, opts);
  }
}

// ---------------------------------------------------------------------------
// Per-harness readers

/**
 * `~/.claude.json`: merges top-level `mcpServers` (badged "claude") with
 * `projects["<workspace abs path>"].mcpServers` (badged "claude-project"). The
 * file can be multi-MB (§6.4) — a single JSON.parse is fine, this runs on dialog
 * open, not on boot.
 */
async function readClaudeJson(
  fs: FileSystemPort,
  path: string,
  workspace: string,
  out: ScanAccumulator,
): Promise<void> {
  const json = await readJsonFile(fs, path, "Claude", out.problems);
  if (json === undefined) {
    return;
  }
  if (!isPlainObject(json)) {
    out.problems.push(`${path}: expected a JSON object — skipped`);
    return;
  }
  collectServers(json.mcpServers, "claude", path, out);

  const projects = json.projects;
  if (projects !== undefined && isPlainObject(projects)) {
    const projectEntry = projects[workspace] ?? projects[stripTrailingSep(workspace)];
    if (isPlainObject(projectEntry)) {
      collectServers(projectEntry.mcpServers, "claude-project", path, out);
    }
  }
}

/**
 * `.claude/settings.json` / `.claude/settings.local.json`: scanned fail-soft for
 * an `mcpServers` key. Claude Code usually keeps project servers in `.mcp.json`,
 * so this source is often absent/empty — that is expected, not an error (§6.2).
 */
async function readClaudeSettings(
  fs: FileSystemPort,
  path: string,
  out: ScanAccumulator,
): Promise<void> {
  const json = await readJsonFile(fs, path, "Claude settings", out.problems);
  if (json === undefined) {
    return;
  }
  if (!isPlainObject(json)) {
    out.problems.push(`${path}: expected a JSON object — skipped`);
    return;
  }
  collectServers(json.mcpServers, "claude-project", path, out);
}

/** `<ws>/.mcp.json`: compat source — candidates badged `alreadyActiveViaCompat`. */
async function readMcpJson(
  fs: FileSystemPort,
  path: string,
  out: ScanAccumulator,
): Promise<void> {
  const json = await readJsonFile(fs, path, ".mcp.json", out.problems);
  if (json === undefined) {
    return;
  }
  if (!isPlainObject(json)) {
    out.problems.push(`${path}: expected a JSON object — skipped`);
    return;
  }
  collectServers(json.mcpServers, "mcp-json", path, out, { alreadyActiveViaCompat: true });
}

/** Keys of a `[mcp_servers.<name>]` table that map onto our entry schema. */
const CODEX_KNOWN_KEYS = new Set(["command", "args", "env", "cwd", "enabled", "url", "headers"]);

/**
 * `~/.codex/config.toml`: parses `[mcp_servers.<name>]` tables via smol-toml,
 * maps command/args/env/cwd/enabled (+ url/headers for http), and DROPS unknown
 * keys (`startup_timeout_sec`, …) with a problems note.
 */
async function readCodexToml(
  fs: FileSystemPort,
  path: string,
  out: ScanAccumulator,
): Promise<void> {
  if (!(await fs.exists(path))) {
    return;
  }
  let raw: string;
  try {
    raw = await fs.readFile(path);
  } catch {
    out.problems.push(readFailureProblem("Codex", path));
    return;
  }
  let parsed: unknown;
  try {
    parsed = parseToml(raw);
  } catch {
    // W5-FIX (finding 1 — CRITICAL): smol-toml's error message embeds the
    // offending source line(s), which may carry a secret env value. Never
    // concatenate `.message` into a renderer-bound problem.
    out.problems.push(parseFailureProblem("Codex", path, "TOML"));
    return;
  }
  if (!isPlainObject(parsed)) {
    out.problems.push(`${path}: expected a TOML table — skipped`);
    return;
  }
  const tables = parsed.mcp_servers;
  if (tables === undefined) {
    return;
  }
  if (!isPlainObject(tables)) {
    out.problems.push(`${path}: "mcp_servers" is not a table — skipped`);
    return;
  }
  for (const [name, tableRaw] of Object.entries(tables)) {
    if (isDangerousServerName(name)) {
      out.problems.push(`${path}: skipped server with a reserved unsafe name`);
      continue;
    }
    if (!isPlainObject(tableRaw)) {
      out.problems.push(`${path}: server '${name}' is not a table — skipped`);
      continue;
    }
    const dropped = Object.keys(tableRaw).filter((key) => !CODEX_KNOWN_KEYS.has(key));
    if (dropped.length > 0) {
      out.problems.push(`${path}: server '${name}' — dropped unsupported keys: ${dropped.join(", ")}`);
    }
    const mapped: Record<string, unknown> = {};
    for (const key of CODEX_KNOWN_KEYS) {
      if (tableRaw[key] !== undefined) {
        mapped[key] = tableRaw[key];
      }
    }
    const validation = validateRawEntry(mapped);
    if (!validation.ok) {
      out.problems.push(`${path}: server '${name}' skipped — ${validation.message}`);
      continue;
    }
    pushCandidate(out, "codex", path, name, validation.entry);
  }
}

/** `~/.zcode/cli/config.json` → `mcp.servers.<name>` → our entry shape. */
async function readZcodeConfig(
  fs: FileSystemPort,
  path: string,
  out: ScanAccumulator,
): Promise<void> {
  const json = await readJsonFile(fs, path, "zcode", out.problems);
  if (json === undefined) {
    return;
  }
  if (!isPlainObject(json)) {
    out.problems.push(`${path}: expected a JSON object — skipped`);
    return;
  }
  const mcp = json.mcp;
  if (mcp === undefined) {
    return;
  }
  if (!isPlainObject(mcp)) {
    out.problems.push(`${path}: "mcp" is not an object — skipped`);
    return;
  }
  collectServers(mcp.servers, "zcode", path, out);
}

// ---------------------------------------------------------------------------
// Fan-out over the fixed §3 allowlist ONLY (path safety — enumerate-the-good).

/**
 * Scans the FIXED allowlist of harness config files derived from `home` +
 * `workspace` and returns normalized candidates + problems. Accepts NO
 * caller-supplied paths and never scans recursively. Every read is fail-soft.
 *
 * Allowlist: `~/.claude.json`, `<ws>/.claude/settings.json`,
 * `<ws>/.claude/settings.local.json`, `<ws>/.mcp.json`, `~/.codex/config.toml`,
 * `~/.zcode/cli/config.json`.
 *
 * W5-FIX (finding 9): when `workspace` is empty/blank (no tab resolved a
 * project path), the workspace-scoped sources are SKIPPED entirely — probing
 * `${ws}/.claude/settings.json` with `ws === ""` would read filesystem-root
 * paths (`/.claude/settings.json`, `/.mcp.json`). Only the home-anchored
 * sources are scanned in that case.
 */
export async function scanHarnessConfigs(
  fs: FileSystemPort,
  home: string,
  workspace: string,
): Promise<HarnessScanResult> {
  const out: ScanAccumulator = { candidates: [], problems: [] };
  const h = stripTrailingSep(home);
  const ws = stripTrailingSep(workspace);

  // Home-anchored sources — always safe to scan.
  await readClaudeJson(fs, `${h}/.claude.json`, ws, out);
  await readCodexToml(fs, `${h}/.codex/config.toml`, out);
  await readZcodeConfig(fs, `${h}/.zcode/cli/config.json`, out);

  // Workspace-scoped sources — only when a real (non-empty) workspace resolved,
  // else these would resolve to filesystem-root paths.
  if (ws !== "") {
    await readClaudeSettings(fs, `${ws}/.claude/settings.json`, out);
    await readClaudeSettings(fs, `${ws}/.claude/settings.local.json`, out);
    await readMcpJson(fs, `${ws}/.mcp.json`, out);
  }

  return out;
}
