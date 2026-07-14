/**
 * Skills discovery + SkillPort factory (Phase 3 slice 3.3, design §3.3).
 *
 * discoverSkills walks a caller-supplied, PRECEDENCE-ORDERED list of roots
 * (project > user, `.anycode` > `.agents`; plugin roots last — building that
 * concrete list from workspace/home/plugin discovery is the extensions
 * bootstrap's job, §3.7/task 3.3.5; this module only consumes the list). Each
 * root is a directory whose immediate subdirectories may hold a `SKILL.md`
 * (fixed depth 1 — no recursive walk). Discovery is fail-soft throughout: a
 * missing root is a zero-cost no-op (mirrors the mcp/config.ts and
 * hook-config.ts "missing file/dir -> no-op" precedent), while an actual
 * readdir/stat/readFile/frontmatter-parse FAILURE (something existed but
 * could not be processed) is reported via `problems[]` and that entry is
 * skipped — the boot path never throws.
 *
 * Root-level dedup: two roots naming the identical directory (e.g. workspace
 * === home collapses the project/user pair to one path) are read only once —
 * same "load once" precedent as hook-config.loadHookConfigs.
 * Name-level dedup: the first (i.e. highest-precedence, per the given root
 * order) occurrence of a name claims it; later occurrences are silently
 * shadowed — the same claimed-set semantics as mcp/config.ts's
 * resolveMcpServerEntries. MAX_SKILLS is enforced AFTER dedup; overflow drops
 * the lowest-precedence entries and reports one summary problem.
 */

import type { FileSystemPort } from "../ports/file-system.js";
import type { SkillMeta, SkillPort } from "../ports/skills.js";
import { parseFrontmatter } from "./frontmatter.js";
import { capUtf8Bytes } from "../util/bytes.js";
import {
  MAX_SKILLS,
  SKILL_BODY_MAX_BYTES,
  SKILL_DESCRIPTION_MAX_CHARS,
} from "../types/config.js";
import {
  BUILTIN_SKILL_SOURCE,
  builtinSkillMeta,
  builtinSkillPath,
  type BuiltinSkillDefinition,
} from "./builtin.js";

/** One directory scanned for `<dir>/SKILL.md`, tagged with its provenance. */
export interface SkillRoot {
  /** Absolute directory whose immediate subdirectories may hold SKILL.md. */
  dir: string;
  /** "project" | "user" | "plugin:<pluginName>" (precedence label / SkillMeta.source). */
  source: string;
}

export interface SkillDiscoveryResult {
  metas: SkillMeta[];
  problems: string[];
}

/** name = frontmatter `name` else the directory name; must match this to be advertised. */
export const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/** Joins a directory and a single path segment with exactly one separating "/". */
function joinPath(dir: string, segment: string): string {
  return dir.endsWith("/") ? `${dir}${segment}` : `${dir}/${segment}`;
}

/** One SKILL.md that passed validation, still subject to name-dedup and the MAX_SKILLS cap. */
interface Candidate {
  meta: SkillMeta;
}

/**
 * Scans a single root's immediate subdirectories for `<sub>/SKILL.md`.
 * Non-directory entries and directories without a SKILL.md are silently
 * ignored (they are simply not skills, not an error); an unreadable/invalid
 * SKILL.md is a `problems[]` entry (fail-soft, entry skipped). Subdirectory
 * names are processed in sorted order for a deterministic result independent
 * of the underlying filesystem's readdir ordering.
 */
async function scanRoot(
  fs: FileSystemPort,
  root: SkillRoot,
  problems: string[],
): Promise<Candidate[]> {
  if (!(await fs.exists(root.dir))) {
    return [];
  }

  let entries: string[];
  try {
    entries = await fs.readdir(root.dir);
  } catch (error) {
    problems.push(`Skill discovery: could not list ${root.dir}: ${describeError(error)}`);
    return [];
  }

  const candidates: Candidate[] = [];
  for (const entryName of [...entries].sort()) {
    const entryDir = joinPath(root.dir, entryName);

    let entryStat;
    try {
      entryStat = await fs.stat(entryDir);
    } catch (error) {
      problems.push(`Skill discovery: could not stat ${entryDir}: ${describeError(error)}`);
      continue;
    }
    if (!entryStat.isDirectory) {
      continue;
    }

    const skillPath = joinPath(entryDir, "SKILL.md");
    if (!(await fs.exists(skillPath))) {
      continue;
    }

    let raw: string;
    try {
      raw = await fs.readFile(skillPath);
    } catch (error) {
      problems.push(`Skill discovery: could not read ${skillPath}: ${describeError(error)}`);
      continue;
    }

    const parsed = parseFrontmatter(raw);
    if ("error" in parsed) {
      problems.push(`Skill discovery: invalid frontmatter in ${skillPath}: ${parsed.error}`);
      continue;
    }

    const name = parsed.fields.name?.trim() || entryName;
    if (!SKILL_NAME_RE.test(name)) {
      problems.push(
        `Skill discovery: skipping ${skillPath} — name "${name}" does not match ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`,
      );
      continue;
    }

    const description = parsed.fields.description?.trim();
    if (!description) {
      problems.push(`Skill discovery: skipping ${skillPath} — a "description" is required`);
      continue;
    }

    candidates.push({
      meta: {
        name,
        description: description.slice(0, SKILL_DESCRIPTION_MAX_CHARS),
        source: root.source,
        path: skillPath,
      },
    });
  }
  return candidates;
}

/**
 * Discovers skills across the given roots (high -> low precedence). Roots
 * naming the same directory are read once; names are deduped claimed-set
 * style (first/highest-precedence wins); the result is capped at MAX_SKILLS
 * after dedup. Never throws.
 */
export async function discoverSkills(
  fs: FileSystemPort,
  roots: readonly SkillRoot[],
  opts?: {
    disabled?: ReadonlySet<string>;
    /** Trusted in-memory skills, considered after every filesystem root. */
    builtins?: readonly BuiltinSkillDefinition[];
  },
): Promise<SkillDiscoveryResult> {
  const problems: string[] = [];
  const seenDirs = new Set<string>();
  const claimed = new Map<string, SkillMeta>();
  const disabled = opts?.disabled;

  for (const root of roots) {
    if (seenDirs.has(root.dir)) {
      continue;
    }
    seenDirs.add(root.dir);

    const candidates = await scanRoot(fs, root, problems);
    for (const candidate of candidates) {
      // Disabled names are dropped at CLAIM time, BEFORE the MAX_SKILLS cap, so
      // disabling a skill frees a cap slot for a lower-precedence one. An absent
      // (undefined) disabled set leaves this a no-op — result byte-identical to
      // the pre-slice behavior (boot byte-invariance, §4).
      if (disabled?.has(candidate.meta.name)) {
        continue;
      }
      if (claimed.has(candidate.meta.name)) {
        continue; // shadowed by a higher-precedence source — silent, claimed-set semantics
      }
      claimed.set(candidate.meta.name, candidate.meta);
    }
  }

  // Application-provided built-ins are intentionally last: project, user,
  // and plugin skills can replace product guidance by claiming the same name.
  for (const builtin of opts?.builtins ?? []) {
    if (disabled?.has(builtin.name) || claimed.has(builtin.name)) {
      continue;
    }
    if (!SKILL_NAME_RE.test(builtin.name)) {
      problems.push(
        `Skill discovery: skipping builtin skill — name "${builtin.name}" does not match ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`,
      );
      continue;
    }
    const description = builtin.description.trim();
    if (!description) {
      problems.push(
        `Skill discovery: skipping builtin://${builtin.name}/SKILL.md — a "description" is required`,
      );
      continue;
    }
    claimed.set(
      builtin.name,
      builtinSkillMeta({
        ...builtin,
        description: description.slice(0, SKILL_DESCRIPTION_MAX_CHARS),
      }),
    );
  }

  let metas = [...claimed.values()];
  if (metas.length > MAX_SKILLS) {
    const dropped = metas.length - MAX_SKILLS;
    metas = metas.slice(0, MAX_SKILLS);
    problems.push(
      `Skill discovery: ${dropped} skill(s) exceeded the cap of ${MAX_SKILLS} and were dropped (lowest precedence first).`,
    );
  }

  return { metas, problems };
}

/**

 * is static for the session). load() re-reads filesystem SKILL.md files FRESH
 * on every call (an edit is visible without a restart), while opt-in built-ins
 * load from their immutable in-memory definitions. A vanished file, a name
 * outside the snapshot, or a read failure all resolve to undefined (fail-soft
 * — the handler turns that into invalid_input).
 */
export function createSkillPort(
  fs: FileSystemPort,
  metas: readonly SkillMeta[],
  opts?: { builtins?: readonly BuiltinSkillDefinition[] },
): SkillPort {
  const snapshot = [...metas];
  const byName = new Map(snapshot.map((meta) => [meta.name, meta]));
  const builtinBodies = new Map(
    (opts?.builtins ?? []).map((builtin) => [builtin.name, builtin.body]),
  );

  return {
    list: () => [...snapshot],
    load: async (name) => {
      const meta = byName.get(name);
      if (!meta) {
        return undefined;
      }

      if (
        meta.source === BUILTIN_SKILL_SOURCE &&
        meta.path === builtinSkillPath(meta.name)
      ) {
        const body = builtinBodies.get(meta.name);
        if (body === undefined) {
          return undefined;
        }
        const capped = capUtf8Bytes(body, SKILL_BODY_MAX_BYTES);
        return { meta, body: capped.text, truncated: capped.truncated };
      }

      let raw: string;
      try {
        raw = await fs.readFile(meta.path);
      } catch {
        return undefined; // vanished (or unreadable) since discovery — fail-soft
      }

      const parsed = parseFrontmatter(raw);
      // A file that no longer parses (edited after discovery) still yields its
      // full content best-effort rather than a hard failure — the tool call
      // should not fail just because the frontmatter got broken after boot.
      const body = "error" in parsed ? raw : parsed.body;
      const capped = capUtf8Bytes(body, SKILL_BODY_MAX_BYTES);
      return { meta, body: capped.text, truncated: capped.truncated };
    },
  };
}
