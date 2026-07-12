/**
 * Foreign-harness skill import (design slice-P7.20-cut.md §5 W1). Pure
 * FileSystemPort readers/writers that (1) scan a FIXED allowlist of other coding
 * harnesses' skill catalogs (Claude user/project, Codex, zcode, installed CC
 * plugins), classifying each SKILL.md as compatible-verbatim / needs-conversion
 * / incompatible, and (2) copy explicitly selected skills into OUR own catalog
 * with frontmatter conversion, name-conflict suffixing, and a bounded, symlink-
 * refusing recursive directory copy.
 *
 * Security invariants (§4):
 *  - Path safety (enumerate-the-good): scan reads ONLY the fixed §3 allowlist
 *    derived from `home` + `workspace`. No caller-supplied paths, no recursion
 *    outside a discovered skill dir.
 *  - Copy custody: regular files ONLY — symlinks are NEVER followed (a foreign
 *    skill dir symlinking `~/.ssh` must not be exfiltrated), no device/special
 *    files, depth cap, per-file + per-skill size caps; over-cap ⇒ a note, never
 *    a crash.
 *  - Name safety: every written name passes SKILL_NAME_RE + the proto-key guard;
 *    a foreign name failing the regex is sanitized, and if still invalid the
 *    candidate is `incompatible` (never written).
 *  - Fail-soft: a missing catalog is a silent no-op; a bad SKILL.md is a marked
 *    candidate; nothing throws.
 *
 * ⚠ Main-safe: touches only ports + the skills/plugins readers — NO ai-SDK.
 */

import { isAbsolute, relative, resolve } from "node:path";

import { parseFrontmatter } from "./frontmatter.js";
import { SKILL_NAME_RE } from "./discovery.js";
import { buildSkillRoots, isUnderOwnRootsResolved } from "./admin-scan.js";
import { discoverSkills } from "./discovery.js";
import { discoverPlugins } from "../plugins/discovery.js";
import { isDangerousKey } from "../util/config-file.js";
import type { FileSystemPort } from "../ports/file-system.js";

/** Origin harness of a discovered skill candidate. */
export type SkillHarnessKind = "claude" | "claude-project" | "codex" | "zcode" | "claude-plugin";

/** A skill discovered in a foreign harness catalog, classified for the import wizard. */
export interface HarnessSkillCandidate {
  /** Stable id `${harness} ${sourceDir} ${name}` (W5-FIX finding-2 discipline). */
  id: string;
  harness: SkillHarnessKind;
  /** Absolute directory holding the source SKILL.md (+ any support tree). */
  sourceDir: string;
  /** Resolved+sanitized name (frontmatter name else directory name). */
  name: string;
  description: string;
  /** false ⇒ name/description unextractable — rendered disabled, NEVER imported. */
  compatible: boolean;
  /** true ⇒ frontmatter must be rewritten by the D3 normalizer on import. */
  needsConversion: boolean;
  /** Human notes (dropped nested keys, folded description, sanitized name, …). */
  conversionNotes: string[];
  /** true ⇒ the name already exists in our post-dedup catalog (will suffix on import). */
  alreadyPresent: boolean;
  /** Regular files that WOULD be copied (SKILL.md + support tree), preview count. */
  fileCount: number;
  /** Sum of those files' bytes, preview only. */
  totalBytes: number;
}

// --- size / depth caps (§4) --------------------------------------------------
const PER_FILE_MAX_BYTES = 2 * 1024 * 1024; // 2 MB
const PER_SKILL_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const COPY_DEPTH_CAP = 5;
const SKILL_MD = "SKILL.md";

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reads a foreign file with the port's O_NOFOLLOW read (`readFileNoFollow`) —
 * closes the TOCTOU window where a foreign process swaps the lstat-checked
 * regular file for a symlink before the read.
 *
 * P2-5 (W6-FIX, FAIL CLOSED): a port WITHOUT `readFileNoFollow` must NOT fall
 * back to a link-following `readFile` (a race-swapped symlink could dereference
 * an arbitrary file). It THROWS instead — callers skip the candidate / refuse the
 * import. The desktop NodeSkillsFs always provides the method, so the real UI
 * stays fully functional; only a port that cannot read safely is blocked.
 */
async function readForeignFile(fs: FileSystemPort, path: string): Promise<string> {
  if (typeof fs.readFileNoFollow === "function") {
    return fs.readFileNoFollow(path);
  }
  throw new Error("readFileNoFollow unavailable — refusing a link-following foreign read (P2-5 fail-closed)");
}

/**
 * Copies a foreign file with the port's O_NOFOLLOW copy (`copyFileNoFollow`) —
 * same TOCTOU close as readForeignFile for the exfil (copy) vector.
 *
 * P2-5 (W6-FIX, FAIL CLOSED): a port WITHOUT `copyFileNoFollow` must NOT fall
 * back to a link-following `copyFile` / readFile+writeFile round-trip (either
 * could exfiltrate a race-swapped symlink's target into our catalog). It THROWS
 * instead — support-tree callers skip the file with a note, apply refuses the
 * candidate `io_error`. The desktop NodeSkillsFs always provides the method.
 *
 * P1-4 (ACCEPTED residual): the no-follow guard covers a final-component FILE
 * swap. A foreign process swapping a checked regular DIRECTORY for a symlink
 * between our `lstat` and the subsequent `readdir` is NOT closed here (there is
 * no portable O_NOFOLLOW+O_DIRECTORY openat/readdir in the FileSystemPort); that
 * local->local directory-swap race remains a best-effort residual.
 */
async function copyForeignFile(fs: FileSystemPort, from: string, to: string): Promise<void> {
  if (typeof fs.copyFileNoFollow === "function") {
    await fs.copyFileNoFollow(from, to);
    return;
  }
  throw new Error("copyFileNoFollow unavailable — refusing a link-following foreign copy (P2-5 fail-closed)");
}

function stripTrailingSep(base: string): string {
  return base.replace(/[/\\]+$/, "");
}

function joinPath(dir: string, segment: string): string {
  return dir.endsWith("/") ? `${dir}${segment}` : `${dir}/${segment}`;
}

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

// ---------------------------------------------------------------------------
// D3 frontmatter normalizer: tolerant extraction of top-level FLAT keys, skip
// nested blocks, fold `>`/`|` block-scalar descriptions to one line.

interface FrontmatterSplit {
  inner: string[];
  body: string;
}

/** Splits the raw file into its frontmatter lines + the byte-preserved body; null if unfenced. */
function splitFrontmatter(raw: string): FrontmatterSplit | null {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const openMatch = /^---[ \t]*\r?\n/.exec(text);
  if (!openMatch) {
    return null;
  }
  let offset = openMatch[0].length;
  const inner: string[] = [];
  for (;;) {
    const nl = text.indexOf("\n", offset);
    const rawLine = text.slice(offset, nl === -1 ? text.length : nl);
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const nextOffset = nl === -1 ? text.length : nl + 1;
    if (line.trim() === "---") {
      return { inner, body: text.slice(nextOffset) };
    }
    if (nl === -1) {
      return null; // ran off the end with no closing fence
    }
    inner.push(line);
    offset = nextOffset;
  }
}

interface NormalizedFrontmatter {
  fields: Record<string, string>;
  dropped: string[];
  folded: string[];
}

const BLOCK_SCALAR_INDICATORS = new Set(["|", ">", "|-", ">-", "|+", ">+"]);

/** Extracts flat top-level keys, skipping nested blocks and folding block-scalar values. */
function normalizeFrontmatter(inner: string[]): NormalizedFrontmatter {
  const fields: Record<string, string> = {};
  const dropped: string[] = [];
  const folded: string[] = [];
  let i = 0;
  while (i < inner.length) {
    const line = inner[i]!;
    if (line.trim() === "" || /^\s/.test(line)) {
      i++;
      continue; // blank or a stray indented line (block already consumed elsewhere)
    }
    const colon = line.indexOf(":");
    if (colon === -1) {
      i++;
      continue; // not a key line — tolerantly skip
    }
    const key = line.slice(0, colon).trim();
    if (key === "" || !/^[A-Za-z0-9_.-]+$/.test(key)) {
      i++;
      continue;
    }
    const value = line.slice(colon + 1).trim();

    if (BLOCK_SCALAR_INDICATORS.has(value)) {
      // Fold the following indented block lines into one space-joined scalar.
      i++;
      const parts: string[] = [];
      while (i < inner.length) {
        const bl = inner[i]!;
        if (bl.trim() === "") {
          i++;
          continue;
        }
        if (/^\s/.test(bl)) {
          parts.push(bl.trim());
          i++;
          continue;
        }
        break;
      }
      fields[key] = parts.join(" ");
      folded.push(key);
      continue;
    }

    if (value === "") {
      // A key with an empty value FOLLOWED by an indented line is a nested block
      // (mapping/sequence) — drop the whole block. Otherwise it is a legit empty
      // flat scalar.
      let j = i + 1;
      let nested = false;
      while (j < inner.length) {
        const peek = inner[j]!;
        if (peek.trim() === "") {
          j++;
          continue;
        }
        nested = /^\s/.test(peek);
        break;
      }
      if (nested) {
        dropped.push(key);
        i++;
        while (i < inner.length) {
          const bl = inner[i]!;
          if (bl.trim() === "") {
            i++;
            continue;
          }
          if (/^\s/.test(bl)) {
            i++;
            continue;
          }
          break;
        }
        continue;
      }
      fields[key] = "";
      i++;
      continue;
    }

    fields[key] = stripQuotes(value);
    i++;
  }
  return { fields, dropped, folded };
}

/** Serializes a flat frontmatter block (name first, then description, then surviving keys) + body. */
function serializeFrontmatter(
  fields: Record<string, string>,
  nameOverride: string,
  body: string,
): string {
  const lines: string[] = ["---", `name: ${nameOverride}`];
  if (fields.description !== undefined) {
    lines.push(`description: ${fields.description}`);
  }
  for (const [key, value] of Object.entries(fields)) {
    if (key === "name" || key === "description") {
      continue;
    }
    lines.push(`${key}: ${value}`);
  }
  lines.push("---");
  return `${lines.join("\n")}\n${body}`;
}

/** Rewrites ONLY the first top-level `name:` line of an already-flat file, body byte-preserved. */
function rewriteFlatName(raw: string, newName: string): string {
  const split = splitFrontmatter(raw);
  if (!split) {
    return raw;
  }
  const inner = split.inner.slice();
  let replaced = false;
  for (let i = 0; i < inner.length; i++) {
    const line = inner[i]!;
    if (/^\s/.test(line)) {
      continue;
    }
    const colon = line.indexOf(":");
    if (colon === -1) {
      continue;
    }
    if (line.slice(0, colon).trim() === "name") {
      inner[i] = `name: ${newName}`;
      replaced = true;
      break;
    }
  }
  if (!replaced) {
    inner.unshift(`name: ${newName}`);
  }
  const bom = raw.charCodeAt(0) === 0xfeff ? "\uFEFF" : "";
  return `${bom}---\n${inner.join("\n")}\n---\n${split.body}`;
}

// ---------------------------------------------------------------------------
// Name sanitize + validate.

/** Sanitizes a foreign name to the skill regex; undefined if unsalvageable. */
function sanitizeName(raw: string): string | undefined {
  let name = raw.trim().replace(/[^A-Za-z0-9_-]/g, "-");
  // First char must be alphanumeric.
  name = name.replace(/^[^A-Za-z0-9]+/, "");
  // Trim trailing separators and cap length.
  name = name.replace(/[-_]+$/, "").slice(0, 64);
  if (name === "" || !SKILL_NAME_RE.test(name) || isDangerousKey(name)) {
    return undefined;
  }
  return name;
}

// ---------------------------------------------------------------------------
// Classification of one SKILL.md.

interface Classification {
  name: string;
  description: string;
  compatible: boolean;
  needsConversion: boolean;
  notes: string[];
}

/** Classifies a SKILL.md: compatible-verbatim, needs-conversion, or incompatible. */
function classifySkillFile(raw: string, dirName: string): Classification {
  const notes: string[] = [];
  const strict = parseFrontmatter(raw);
  if (!("error" in strict)) {
    const rawName = strict.fields.name?.trim() || dirName;
    const description = strict.fields.description?.trim();
    const safeName = sanitizeName(rawName);
    if (safeName === undefined) {
      return { name: rawName, description: description ?? "", compatible: false, needsConversion: false, notes: [`name "${rawName}" cannot be sanitized to a valid skill name`] };
    }
    if (safeName !== rawName) {
      notes.push(`name sanitized to "${safeName}"`);
    }
    if (!description) {
      return { name: safeName, description: "", compatible: false, needsConversion: false, notes: ["missing required description"] };
    }
    return { name: safeName, description, compatible: true, needsConversion: false, notes };
  }

  // Strict parse failed — run the tolerant normalizer.
  const split = splitFrontmatter(raw);
  if (!split) {
    return { name: dirName, description: "", compatible: false, needsConversion: false, notes: ["no frontmatter block"] };
  }
  const normalized = normalizeFrontmatter(split.inner);
  if (normalized.dropped.length > 0) {
    notes.push(`dropped: ${normalized.dropped.join(", ")}`);
  }
  if (normalized.folded.length > 0) {
    notes.push(`folded block scalar: ${normalized.folded.join(", ")}`);
  }
  const rawName = normalized.fields.name?.trim() || dirName;
  const description = normalized.fields.description?.trim();
  const safeName = sanitizeName(rawName);
  if (safeName === undefined) {
    return { name: rawName, description: description ?? "", compatible: false, needsConversion: true, notes: [...notes, `name "${rawName}" cannot be sanitized`] };
  }
  if (safeName !== rawName) {
    notes.push(`name sanitized to "${safeName}"`);
  }
  if (!description) {
    return { name: safeName, description: "", compatible: false, needsConversion: true, notes: [...notes, "missing required description"] };
  }
  return { name: safeName, description, compatible: true, needsConversion: true, notes };
}

// ---------------------------------------------------------------------------
// Directory preview walk (count regular files + bytes, symlink/depth aware).

async function previewSkillDir(fs: FileSystemPort, dir: string): Promise<{ fileCount: number; totalBytes: number }> {
  let fileCount = 0;
  let totalBytes = 0;
  if (typeof fs.lstat !== "function") {
    return { fileCount: 0, totalBytes: 0 };
  }
  const lstat = fs.lstat.bind(fs);

  async function walk(current: string, depth: number): Promise<void> {
    if (depth > COPY_DEPTH_CAP) {
      return;
    }
    let entries: string[];
    try {
      entries = [...(await fs.readdir(current))].sort();
    } catch {
      return;
    }
    for (const name of entries) {
      const path = joinPath(current, name);
      let st;
      try {
        st = await lstat(path);
      } catch {
        continue;
      }
      if (st.isSymbolicLink) {
        continue;
      }
      if (st.isDirectory) {
        await walk(path, depth + 1);
        continue;
      }
      if (!st.isFile) {
        continue;
      }
      fileCount++;
      totalBytes += st.size;
    }
  }

  await walk(dir, 0);
  return { fileCount, totalBytes };
}

// ---------------------------------------------------------------------------
// Catalog scanners over the fixed allowlist.

interface ScanContext {
  fs: FileSystemPort;
  ourNames: Set<string>;
  out: HarnessSkillCandidate[];
}

/** Reads + classifies one skill directory (a dir containing SKILL.md) into a candidate. */
async function readSkillDir(
  ctx: ScanContext,
  harness: SkillHarnessKind,
  sourceDir: string,
  dirName: string,
): Promise<void> {
  // P1-c/P1-a (W5-FIX): fail closed when the port cannot lstat — never fall back
  // to a link-following stat/read on foreign content.
  if (typeof ctx.fs.lstat !== "function") {
    return;
  }
  const lstat = ctx.fs.lstat.bind(ctx.fs);
  // The candidate directory itself must be a REAL directory, never a symlink
  // (a symlinked skill dir could point at ~/.ssh and be walked/exfiltrated).
  try {
    const dirSt = await lstat(sourceDir);
    if (dirSt.isSymbolicLink || !dirSt.isDirectory) {
      return;
    }
  } catch {
    return;
  }
  const skillMdPath = joinPath(sourceDir, SKILL_MD);
  // The top-level SKILL.md must be a REAL regular file, never a symlink — a
  // symlinked SKILL.md could dereference an arbitrary file on read/copy.
  try {
    const mdSt = await lstat(skillMdPath);
    if (mdSt.isSymbolicLink || !mdSt.isFile) {
      return; // not a (real) skill file — silent, same as our discovery
    }
  } catch {
    return; // absent/unstatable — fail-soft skip
  }
  let raw: string;
  try {
    raw = await readForeignFile(ctx.fs, skillMdPath);
  } catch {
    return; // unreadable — fail-soft skip
  }
  const cls = classifySkillFile(raw, dirName);
  const preview = await previewSkillDir(ctx.fs, sourceDir);
  ctx.out.push({
    id: `${harness} ${sourceDir} ${cls.name}`,
    harness,
    sourceDir,
    name: cls.name,
    description: cls.description,
    compatible: cls.compatible,
    needsConversion: cls.needsConversion,
    conversionNotes: cls.notes,
    alreadyPresent: ctx.ourNames.has(cls.name),
    fileCount: preview.fileCount,
    totalBytes: preview.totalBytes,
  });
}

/** Scans a `<catalog>/<name>/SKILL.md` catalog directory fail-soft. */
async function scanCatalog(
  ctx: ScanContext,
  harness: SkillHarnessKind,
  catalogDir: string,
): Promise<void> {
  if (!(await ctx.fs.exists(catalogDir))) {
    return;
  }
  let entries: string[];
  try {
    entries = [...(await ctx.fs.readdir(catalogDir))].sort();
  } catch {
    return;
  }
  // lstat (not stat) so a catalog entry that is a symlink to a directory is
  // skipped rather than followed; readSkillDir re-verifies fail-closed.
  if (typeof ctx.fs.lstat !== "function") {
    return;
  }
  for (const name of entries) {
    const skillDir = joinPath(catalogDir, name);
    let st;
    try {
      st = await ctx.fs.lstat(skillDir);
    } catch {
      continue;
    }
    if (st.isSymbolicLink || !st.isDirectory) {
      continue;
    }
    await readSkillDir(ctx, harness, skillDir, name);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Scans installed CC plugins' skill catalogs (installPath contained under the plugins cache). */
async function scanClaudePlugins(ctx: ScanContext, home: string): Promise<void> {
  const registryPath = joinPath(joinPath(home, ".claude/plugins"), "installed_plugins.json");
  if (!(await ctx.fs.exists(registryPath))) {
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await ctx.fs.readFile(registryPath));
  } catch {
    return;
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.plugins)) {
    return;
  }
  const cacheRoot = resolve(joinPath(home, ".claude/plugins/cache"));
  const installPaths: string[] = [];
  for (const value of Object.values(parsed.plugins)) {
    const list = Array.isArray(value) ? value : [value];
    for (const entry of list) {
      if (isPlainObject(entry) && typeof entry.installPath === "string") {
        installPaths.push(entry.installPath);
      }
    }
  }
  for (const installPath of installPaths) {
    // enumerate-the-good: normalize `.`/`..` FIRST, then require the resolved
    // path to sit strictly inside the cache root (a string-prefix test on the
    // raw value let `.../cache/../secrets` pass — P2-d). Use the resolved path
    // for all downstream reads so the traversal cannot re-enter.
    const resolvedInstall = resolve(installPath);
    const rel = relative(cacheRoot, resolvedInstall);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      continue;
    }
    const skillsDir = joinPath(resolvedInstall, "skills");
    // Layout A: a single skill at `skills/SKILL.md`.
    if (await ctx.fs.exists(joinPath(skillsDir, SKILL_MD))) {
      await readSkillDir(ctx, "claude-plugin", skillsDir, "skills");
    }
    // Layout B: `skills/<sub>/SKILL.md`.
    await scanCatalog(ctx, "claude-plugin", skillsDir);
  }
}

/**
 * Scans the FIXED §3 allowlist of foreign skill catalogs and returns classified
 * candidates. `alreadyPresent` is computed against OUR current post-dedup
 * catalog (project+user+plugin). Never throws; a missing catalog is a no-op.
 */
export async function scanHarnessSkills(
  fs: FileSystemPort,
  home: string,
  workspace: string,
): Promise<HarnessSkillCandidate[]> {
  const h = stripTrailingSep(home);
  const ws = stripTrailingSep(workspace);

  // Our own catalog names (for the alreadyPresent flag).
  const ourNames = new Set<string>();
  try {
    const plugins = await discoverPlugins(fs, { workspace: ws, home: h, claimedMcpNames: new Set() });
    const roots = buildSkillRoots(ws, h, plugins.skillRoots);
    const discovery = await discoverSkills(fs, roots);
    for (const meta of discovery.metas) {
      ourNames.add(meta.name);
    }
  } catch {
    // fail-soft: alreadyPresent falls back to false; apply-time re-checks anyway.
  }

  const ctx: ScanContext = { fs, ourNames, out: [] };

  // Home-anchored catalogs — always safe.
  await scanCatalog(ctx, "claude", joinPath(h, ".claude/skills"));
  await scanCatalog(ctx, "codex", joinPath(h, ".codex/skills"));
  await scanCatalog(ctx, "zcode", joinPath(h, ".zcode/skills"));
  await scanClaudePlugins(ctx, h);

  // Workspace-scoped catalog — only when a real workspace resolved.
  if (ws !== "") {
    await scanCatalog(ctx, "claude-project", joinPath(ws, ".claude/skills"));
  }

  return ctx.out;
}

// ---------------------------------------------------------------------------
// Apply: convert + suffix + bounded recursive copy into our catalog.

export interface ApplySkillImportResult {
  id: string;
  /** Final name written (may carry a `-N` suffix). */
  name: string;
  applied: boolean;
  suffixed: boolean;
  converted: boolean;
  /** Set when NOT applied. */
  skipped?: "incompatible" | "unsafe_name" | "io_error";
  notes: string[];
}

/** Copies the support tree (everything but the top-level SKILL.md) with symlink/size/depth guards. */
async function copySupportTree(
  fs: FileSystemPort,
  srcDir: string,
  destDir: string,
  notes: string[],
): Promise<void> {
  // P2-5: require the no-follow copy (not plain copyFile) — the support-tree
  // copier must never fall back to a link-following copy.
  if (typeof fs.lstat !== "function" || typeof fs.copyFileNoFollow !== "function") {
    notes.push("support files skipped (port lacks lstat/no-follow copy)");
    return;
  }
  const lstat = fs.lstat.bind(fs);
  const copyForeign = (from: string, to: string): Promise<void> => copyForeignFile(fs, from, to);
  let total = 0;
  let capped = false;

  async function walk(relDir: string, depth: number): Promise<void> {
    if (capped) {
      return;
    }
    if (depth > COPY_DEPTH_CAP) {
      notes.push(`skipped files below depth ${COPY_DEPTH_CAP}`);
      return;
    }
    const src = relDir === "" ? srcDir : joinPath(srcDir, relDir);
    let entries: string[];
    try {
      entries = [...(await fs.readdir(src))].sort();
    } catch {
      return;
    }
    for (const name of entries) {
      if (capped) {
        return;
      }
      if (depth === 0 && name === SKILL_MD) {
        continue; // the SKILL.md is written separately (converted/renamed/verbatim)
      }
      const rel = relDir === "" ? name : `${relDir}/${name}`;
      const srcPath = joinPath(srcDir, rel);
      let st;
      try {
        st = await lstat(srcPath);
      } catch {
        continue;
      }
      if (st.isSymbolicLink) {
        notes.push(`skipped symlink: ${rel}`);
        continue;
      }
      if (st.isDirectory) {
        // P1-4 (ACCEPTED residual): lstat says this is a real dir, but a local
        // attacker could swap it for a symlink before `readdir` descends (no
        // dir-fd/openat in FileSystemPort). Local->local race only; regular final
        // files are still no-follow-copied. See copyForeignFile's residual note.
        await walk(rel, depth + 1);
        continue;
      }
      if (!st.isFile) {
        notes.push(`skipped special file: ${rel}`);
        continue;
      }
      if (st.size > PER_FILE_MAX_BYTES) {
        notes.push(`skipped oversize file (> 2 MB): ${rel}`);
        continue;
      }
      if (total + st.size > PER_SKILL_MAX_BYTES) {
        notes.push("skill size cap (10 MB) reached — remaining files skipped");
        capped = true;
        return;
      }
      total += st.size;
      try {
        // No-follow copy (P1-b): even after the lstat above says "regular file",
        // open the source O_NOFOLLOW so a race-swapped symlink cannot exfiltrate.
        await copyForeign(srcPath, joinPath(destDir, rel));
      } catch {
        notes.push(`failed to copy: ${rel}`);
      }
    }
  }

  await walk("", 0);
}

/**
 * Applies selected candidates into `targetRoot` (`<scope>/.anycode/skills`). For
 * each candidate: incompatible ⇒ skipped (never written); otherwise a
 * conflict-free final name is chosen (suffix `-2`,`-3`,… on BOTH the directory
 * and the frontmatter `name:`), the SKILL.md is written (converted when needed,
 * else copied verbatim, else name-rewritten), and the support tree is copied
 * with the §4 guards. Never throws; each candidate yields a result row.
 *
 * `ownRoots` (optional, P1-c W5-FIX): when supplied, `targetRoot` is proven to
 * be a REAL own-catalog root (symlink-resolved) before ANY write — a forged or
 * symlinked `targetRoot` (`.anycode/skills -> /tmp/outside`) is refused wholesale
 * and every candidate is skipped `io_error`, so an import can never write outside
 * the real catalog. Omitted ⇒ no target guard (in-core/legacy callers that
 * already control the target); the desktop IPC always passes it.
 */
export async function applySkillImport(
  fs: FileSystemPort,
  targetRoot: string,
  candidates: readonly HarnessSkillCandidate[],
  ownRoots?: readonly string[],
): Promise<ApplySkillImportResult[]> {
  const results: ApplySkillImportResult[] = [];
  const usedNames = new Set<string>();

  // P1-c: prove the write target is a real own-catalog root (or under one).
  // A symlinked/forged target => refuse the whole batch (fail closed).
  if (ownRoots !== undefined) {
    const safe = await isUnderOwnRootsResolved(fs, targetRoot, ownRoots, { allowEqual: true });
    if (!safe) {
      for (const candidate of candidates) {
        results.push({ id: candidate.id, name: candidate.name, applied: false, suffixed: false, converted: false, skipped: "io_error", notes: [...candidate.conversionNotes, "import target is not a real own-catalog root — refused"] });
      }
      return results;
    }
  }

  const isTaken = async (name: string): Promise<boolean> => {
    if (usedNames.has(name)) {
      return true;
    }
    return fs.exists(joinPath(targetRoot, name));
  };

  for (const candidate of candidates) {
    const notes = [...candidate.conversionNotes];

    if (!candidate.compatible) {
      results.push({ id: candidate.id, name: candidate.name, applied: false, suffixed: false, converted: false, skipped: "incompatible", notes });
      continue;
    }
    if (!SKILL_NAME_RE.test(candidate.name) || isDangerousKey(candidate.name)) {
      results.push({ id: candidate.id, name: candidate.name, applied: false, suffixed: false, converted: false, skipped: "unsafe_name", notes });
      continue;
    }

    const skillMdSrc = joinPath(candidate.sourceDir, SKILL_MD);

    // P1-a (apply side): re-verify the source dir + SKILL.md are REAL (not
    // symlinks) at apply time — the scan-time candidate is untrusted; a symlink
    // could have been swapped in since. Fail closed when lstat is unavailable.
    if (typeof fs.lstat !== "function") {
      results.push({ id: candidate.id, name: candidate.name, applied: false, suffixed: false, converted: false, skipped: "io_error", notes: [...notes, "cannot verify source is not a symlink (port lacks lstat) — refused"] });
      continue;
    }
    try {
      const dirSt = await fs.lstat(candidate.sourceDir);
      if (dirSt.isSymbolicLink || !dirSt.isDirectory) {
        results.push({ id: candidate.id, name: candidate.name, applied: false, suffixed: false, converted: false, skipped: "io_error", notes: [...notes, "source directory is a symlink or not a directory — refused"] });
        continue;
      }
      const mdSt = await fs.lstat(skillMdSrc);
      if (mdSt.isSymbolicLink || !mdSt.isFile) {
        results.push({ id: candidate.id, name: candidate.name, applied: false, suffixed: false, converted: false, skipped: "io_error", notes: [...notes, "source SKILL.md is a symlink or not a file — refused"] });
        continue;
      }
    } catch {
      results.push({ id: candidate.id, name: candidate.name, applied: false, suffixed: false, converted: false, skipped: "io_error", notes });
      continue;
    }

    // Resolve a conflict-free final name.
    const base = candidate.name;
    let finalName = base;
    if (candidate.alreadyPresent || (await isTaken(base))) {
      let k = 2;
      while (await isTaken(`${base}-${k}`)) {
        k++;
      }
      finalName = `${base}-${k}`;
    }
    usedNames.add(finalName);
    const suffixed = finalName !== base;

    let raw: string;
    try {
      // P1-b: no-follow read closes the TOCTOU window after the lstat above.
      raw = await readForeignFile(fs, skillMdSrc);
    } catch {
      results.push({ id: candidate.id, name: finalName, applied: false, suffixed, converted: false, skipped: "io_error", notes });
      continue;
    }

    const destDir = joinPath(targetRoot, finalName);
    const destSkillMd = joinPath(destDir, SKILL_MD);

    try {
      let converted = false;
      if (candidate.needsConversion) {
        const split = splitFrontmatter(raw);
        if (!split) {
          results.push({ id: candidate.id, name: finalName, applied: false, suffixed, converted: false, skipped: "incompatible", notes });
          continue;
        }
        const normalized = normalizeFrontmatter(split.inner);
        const written = serializeFrontmatter(normalized.fields, finalName, split.body);
        await fs.writeFile(destSkillMd, written);
        converted = true;
      } else if (suffixed) {
        // Flat/compatible but renamed: rewrite ONLY the name line, body preserved.
        await fs.writeFile(destSkillMd, rewriteFlatName(raw, finalName));
      } else {
        // Flat/compatible, no rename: byte-identical copy (no-follow source).
        await copyForeignFile(fs, skillMdSrc, destSkillMd);
      }

      // P2-e postcondition: strict-parse the file we ACTUALLY wrote. A foreign
      // SKILL.md valid at scan can be swapped to malformed frontmatter before
      // this copy; never leave un-parseable frontmatter in our catalog. On
      // failure, remove the written skill dir and mark the candidate failed.
      const back = parseFrontmatter(await fs.readFile(destSkillMd));
      if ("error" in back) {
        if (typeof fs.rm === "function") {
          try {
            await fs.rm(destDir);
          } catch {
            notes.push("could not remove partially-written skill dir");
          }
        }
        results.push({ id: candidate.id, name: finalName, applied: false, suffixed, converted, skipped: "incompatible", notes: [...notes, `written SKILL.md failed strict re-parse: ${back.error}`] });
        continue;
      }

      await copySupportTree(fs, candidate.sourceDir, destDir, notes);

      results.push({ id: candidate.id, name: finalName, applied: true, suffixed, converted, notes });
    } catch {
      results.push({ id: candidate.id, name: finalName, applied: false, suffixed, converted: false, skipped: "io_error", notes });
    }
  }

  return results;
}
