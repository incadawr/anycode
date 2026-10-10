/**
 * Agent-profile admin scan + roots recipe (P7.21 W1, design §4-W1 + §2-D7/D8).
 *
 * `buildAgentProfileRoots` is the SINGLE source of the roots recipe — both the
 * extensions bootstrap (boot/session discovery) and this admin scan consume it,
 * so the two lists can never drift (exact `buildSkillRoots` precedent).
 * `scanAgentProfilesAdmin` produces the deduped catalog view the Subagents pane
 * renders (source/path/bodyBytes metadata discovery deliberately omits) plus the
 * fail-soft problems the pane's amber strip surfaces — dedupe/order/cap mirror
 * `discoverAgentProfiles` byte-for-byte via the shared `parseAgentProfileMd`.
 *
 * ⚠ Main-safe: this module (and everything it imports) touches only ports + the
 * profiles/plugins readers — NO ai-SDK, no loop. Re-exported through the
 * `@anycode/core/subagents-admin` subpath for the Electron main process.
 */

import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { FileSystemPort } from "../ports/file-system.js";
import { discoverPlugins } from "../plugins/discovery.js";
import { MAX_AGENT_PROFILES, SUBAGENT_MAX_TURNS_CEILING } from "../types/config.js";
import {
  AGENT_PROFILE_MODEL_RE,
  AGENT_PROFILE_NAME_RE,
  parseAgentProfileMd,
  type AgentProfileEngine,
  type AgentProfileRoot,
} from "./profiles.js";
import { isUnderOwnRootsResolved } from "../util/path-containment.js";

/** `<baseDir>/<relative>`, tolerating a trailing separator on baseDir (mirrors bootstrap.subdir). */
function subdir(baseDir: string, rel: string): string {
  return `${baseDir.replace(/[/\\]+$/, "")}/${rel}`;
}

/**
 * TASK.214: resolves the MAIN checkout root of a linked git worktree, purely
 * from on-disk metadata (NO git process). `workspace` must be the worktree
 * root; returns undefined for ordinary checkouts, missing/garbage metadata, or
 * anything that does not match git's canonical linked-worktree layout:
 *
 *   <ws>/.git            — exactly one "gitdir: <path>" line (optional final EOL)
 *   <gitdir>/commondir   — single line, relative resolved against gitdir
 *   <gitdir>/gitdir      — PLAIN path line (git's backlink), resolved against gitdir
 *
 * Layout requirements (canonicalized via realpath to tolerate macOS /tmp
 * aliases): common's basename is ".git", gitdir is a direct child of
 * common/worktrees, common is gitdir's canonical grandparent, and the backlink
 * matches canonical `<ws>/.git`. Metadata components must be regular
 * non-symlink files; `main/.git` must be a real directory resolving to common.
 * Returns undefined whenever `main === workspace`. Fails silently to undefined.
 */
export function resolveWorktreeMainRootSync(workspace: string): string | undefined {
  try {
    const dotGitPath = resolve(workspace, ".git");

    // <ws>/.git must be a regular non-symlink FILE with a strict single
    // "gitdir: <path>" line. An ordinary checkout's .git DIRECTORY yields
    // undefined here (lstatSync follows nothing on the final component).
    let dotGitStat: { isFile(): boolean; isSymbolicLink(): boolean };
    try {
      dotGitStat = lstatSync(dotGitPath);
    } catch {
      return undefined;
    }
    if (dotGitStat.isSymbolicLink() || !dotGitStat.isFile()) {
      return undefined;
    }
    let raw: string;
    try {
      raw = readFileSync(dotGitPath, "utf-8");
    } catch {
      return undefined;
    }
    // Exactly one "gitdir: ..." line: a nonempty path allowing INTERNAL spaces
    // (valid repo/worktree paths may contain them) but no CR/LF/NUL, with an
    // optional final EOL; any second line or trailing content fails the match.
    const m = /^gitdir: ([^\r\n\0]+)\r?\n?$/.exec(raw);
    if (!m) {
      return undefined;
    }
    const gitdirRaw = m[1]!;
    const gitdir = isAbsolute(gitdirRaw) ? resolve(gitdirRaw) : resolve(workspace, gitdirRaw);

    // gitdir/commondir — strict single line (internal spaces allowed, no
    // CR/LF/NUL, optional final EOL), relative resolved against gitdir.
    const commondirPath = join(gitdir, "commondir");
    let commonStat: { isFile(): boolean; isSymbolicLink(): boolean };
    let commonRaw: string;
    try {
      commonStat = lstatSync(commondirPath);
      if (commonStat.isSymbolicLink() || !commonStat.isFile()) return undefined;
      commonRaw = readFileSync(commondirPath, "utf-8");
    } catch {
      return undefined;
    }
    const cm = /^([^\r\n\0]+)\r?\n?$/.exec(commonRaw);
    if (!cm) return undefined;
    const commonRawVal = cm[1]!;
    const common = isAbsolute(commonRawVal) ? resolve(commonRawVal) : resolve(gitdir, commonRawVal);

    // gitdir/gitdir — a PLAIN path line (git's backlink; internal spaces
    // allowed, no CR/LF/NUL, optional final EOL), resolved against gitdir.
    const backlinkPath = join(gitdir, "gitdir");
    let backStat: { isFile(): boolean; isSymbolicLink(): boolean };
    let backRaw: string;
    try {
      backStat = lstatSync(backlinkPath);
      if (backStat.isSymbolicLink() || !backStat.isFile()) return undefined;
      backRaw = readFileSync(backlinkPath, "utf-8");
    } catch {
      return undefined;
    }
    const bm = /^([^\r\n\0]+)\r?\n?$/.exec(backRaw);
    if (!bm) return undefined;
    const backRawVal = bm[1]!;
    const backlink = isAbsolute(backRawVal) ? resolve(backRawVal) : resolve(gitdir, backRawVal);

    // Canonicalize for comparisons (tolerates macOS /tmp -> /private/var aliases).
    const real = (p: string): string | undefined => {
      try {
        return realpathSync(p);
      } catch {
        return undefined;
      }
    };
    const realWorkspace = real(workspace);
    const realGitdir = real(gitdir);
    const realCommon = real(common);
    const realBacklink = real(backlink);
    const realDotGit = real(dotGitPath);
    if (
      realWorkspace === undefined ||
      realGitdir === undefined ||
      realCommon === undefined ||
      realBacklink === undefined ||
      realDotGit === undefined
    ) {
      return undefined;
    }

    // Canonical layout: common basename ".git"; gitdir is a direct child of
    // common/worktrees; common is gitdir's canonical grandparent; backlink
    // matches canonical <ws>/.git.
    if (basename(realCommon) !== ".git") return undefined;
    const worktreesDir = join(realCommon, "worktrees");
    if (dirname(realGitdir) !== worktreesDir) return undefined;
    if (dirname(dirname(realGitdir)) !== realCommon) return undefined;
    if (realBacklink !== realDotGit) return undefined;

    // Main checkout root is common's parent; main/.git must be a real directory
    // resolving to common.
    const main = dirname(realCommon);
    const mainDotGit = join(main, ".git");
    let mainStat: { isDirectory(): boolean; isSymbolicLink(): boolean };
    try {
      mainStat = lstatSync(mainDotGit);
    } catch {
      return undefined;
    }
    if (mainStat.isSymbolicLink() || !mainStat.isDirectory()) return undefined;
    if (real(mainDotGit) !== realCommon) return undefined;

    if (main === realWorkspace) return undefined;

    // Validate main/.anycode and main/.anycode/agents against the canonical main
    // root: reject a final agents symlink and any parent symlink escaping main.
    // Missing components (ENOENT) are normal; other errors / dangling symlinks
    // fail closed to undefined.
    const checkComponent = (p: string): void => {
      let st: { isSymbolicLink(): boolean; isDirectory(): boolean };
      try {
        st = lstatSync(p);
      } catch (err) {
        if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return;
        throw err;
      }
      if (st.isSymbolicLink()) throw new Error("symlink component");
      if (!st.isDirectory()) throw new Error("not a directory");
    };
    try {
      checkComponent(join(main, ".anycode"));
      checkComponent(join(main, ".anycode", "agents"));
    } catch {
      return undefined;
    }
    // Containment: any EXISTING component path must not resolve outside main.
    const under = (base: string, cand: string): boolean => {
      const rel = relative(base, cand);
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    };
    for (const p of [join(main, ".anycode"), join(main, ".anycode", "agents")]) {
      let exists = true;
      try {
        lstatSync(p);
      } catch {
        exists = false;
      }
      if (exists) {
        const rp = real(p);
        if (rp === undefined || !under(main, rp)) return undefined;
      }
    }

    return main;
  } catch {
    return undefined;
  }
}

/**
 * Builds the precedence-ordered agent-profile roots (project `.anycode/agents` >
 * user `.anycode/agents` > plugin roots). EXTRACTED from the extensions bootstrap
 * so both boot discovery and the admin scan share one recipe. workspace === home
 * drops the user root (byte-identical path — the shared "load once" dedup).
 */
export function buildAgentProfileRoots(
  workspace: string,
  home: string,
  pluginAgentRoots: readonly AgentProfileRoot[],
): AgentProfileRoot[] {
  const sameWorkspaceHome = workspace === home;
  const roots: AgentProfileRoot[] = [
    { dir: subdir(workspace, ".anycode/agents"), source: "project" },
  ];
  // TASK.214: a linked-worktree workspace inherits the MAIN checkout's agent
  // profiles — validated main/.anycode/agents slots SECOND with source
  // "project" (precedence worktree > main > user > plugins). Admitted
  // REGARDLESS of home equality: even when main === home the inherited catalog
  // keeps the project tier (the later user root is deduped against it, with
  // canonical alias comparison). main === workspace is the only exclusion.
  const main = resolveWorktreeMainRootSync(workspace);
  if (main !== undefined && main !== workspace) {
    const mainRoot = { dir: subdir(main, ".anycode/agents"), source: "project" };
    if (!roots.some((r) => r.dir === mainRoot.dir)) {
      roots.push(mainRoot);
    }
  }
  if (!sameWorkspaceHome) {
    // Dedupe the user root when its directory already appears as the inherited
    // project root (main === home) — canonicalizing the HOME BASE (the agents
    // dir may not exist yet, so realpath the base and rebuild the path) so a
    // macOS-style /var vs /private/var alias does not duplicate the entry.
    const userRoot = { dir: subdir(home, ".anycode/agents"), source: "user" };
    let canonicalHome: string | undefined;
    try {
      canonicalHome = realpathSync(home);
    } catch {
      canonicalHome = undefined;
    }
    const canonicalUserDir = canonicalHome !== undefined ? subdir(canonicalHome, ".anycode/agents") : undefined;
    const duplicate =
      roots.some((r) => r.dir === userRoot.dir) ||
      (canonicalUserDir !== undefined && roots.some((r) => r.dir === canonicalUserDir));
    if (!duplicate) {
      roots.push(userRoot);
    }
  }
  roots.push(...pluginAgentRoots);
  return roots;
}

/**
 * The TWO own-catalog roots (project `<ws>/.anycode/agents`, user
 * `~/.anycode/agents`). workspace === home collapses them to one. These are the
 * ONLY directories the editor's create/save/delete ever writes into — plugin
 * roots are explicitly excluded (read-only, §2 Scope OUT).
 */
export function ownAgentRoots(workspace: string, home: string): string[] {
  const projectRoot = subdir(workspace, ".anycode/agents");
  if (workspace === home) {
    return [projectRoot];
  }
  return [projectRoot, subdir(home, ".anycode/agents")];
}

/** Coarse provenance of an admin row (the writable pair vs read-only plugins). */
export type AgentProfileSourceKind = "project" | "user" | "plugin";

/** One admin-scan row: a successfully-parsed profile plus its provenance/path. */
export interface AgentProfileAdminRow {
  name: string;
  description: string;
  /** Tool names as written (baseline when the frontmatter omitted `tools`). */
  tools: readonly string[];
  /** True when the frontmatter carried an explicit `tools:` line. */
  toolsExplicit: boolean;
  /** Full precedence label: "project" | "user" | "plugin:<name>". */
  source: string;
  sourceKind: AgentProfileSourceKind;
  /** Absolute path to the profile `*.md` (main re-resolves this; renderer never sends it). */
  path: string;
  /** UTF-8 byte length of the (capped) child systemPrompt body. */
  bodyBytes: number;
  /** Frontmatter `model:` — absent means children inherit the parent's model. */
  model?: string;
  /** Frontmatter `engine:` — absent means the child runs in-process, not on a foreign CLI. */
  engine?: AgentProfileEngine;
}

export interface AgentProfileAdminScanResult {
  rows: AgentProfileAdminRow[];
  problems: string[];
}

/** Maps a precedence label to the coarse kind the pane groups by. */
function sourceKindOf(source: string): AgentProfileSourceKind {
  if (source === "project") {
    return "project";
  }
  if (source === "user") {
    return "user";
  }
  return "plugin";
}

/**
 * Reads a profile `*.md` WITHOUT following a final symbolic link
 * (`readFileNoFollow` / O_NOFOLLOW). Closes the TOCTOU window between the `lstat`
 * regular-file classification and this read: a foreign process swapping the
 * checked file for a symlink would otherwise dereference an out-of-catalog target
 * (out-of-root read). FAIL CLOSED (P7.21 W2-FIX #2): a port WITHOUT
 * `readFileNoFollow` must NOT fall back to the link-following `readFile`; it
 * throws so the caller skips the file with a content-free problem. The desktop
 * SubagentsFs always provides the method, so the real UI stays fully functional.
 */
async function readProfileNoFollow(fs: FileSystemPort, path: string): Promise<string> {
  if (typeof fs.readFileNoFollow === "function") {
    return fs.readFileNoFollow(path);
  }
  throw new Error("readFileNoFollow unavailable — refusing a link-following profile read (fail-closed)");
}

/**
 * Scans the full agent-profile catalog for the admin pane: discovers plugins
 * (for their read-only roots), builds the roots recipe, then runs the SAME
 * per-file parse + cross-file dedupe/cap that `discoverAgentProfiles` runs — but
 * emits rows with source/path/bodyBytes instead of runtime personas, and mirrors
 * discovery's fail-soft problem strings verbatim. Never throws.
 */
export async function scanAgentProfilesAdmin(
  fs: FileSystemPort,
  opts: { workspace: string; home: string },
): Promise<AgentProfileAdminScanResult> {
  const { workspace, home } = opts;
  const problems: string[] = [];

  let pluginAgentRoots: AgentProfileRoot[] = [];
  try {
    const plugins = await discoverPlugins(fs, { workspace, home, claimedMcpNames: new Set() });
    pluginAgentRoots = plugins.agentRoots;
    problems.push(...plugins.problems);
  } catch (error) {
    problems.push(`plugin discovery failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const roots = buildAgentProfileRoots(workspace, home, pluginAgentRoots);
  // The writable own-catalog roots (project/user) — UNCHANGED (TASK.214): admin
  // WRITES stay confined to the worktree/user roots; an inherited main root is
  // read-catalog only.
  const ownRoots = ownAgentRoots(workspace, home);
  // Read-catalog roots for the containment guard below: the own roots PLUS the
  // validated inherited project root(s) built by the shared recipe (full
  // catalog paths — the helper assumes catalog roots, not checkout roots).
  // This grants the scan reading access only; it is NEVER passed to writes.
  const main = resolveWorktreeMainRootSync(workspace);
  const readCatalogRoots = [...ownRoots];
  if (main !== undefined && main !== workspace) {
    const mainAgents = subdir(main, ".anycode/agents");
    if (!readCatalogRoots.includes(mainAgents)) {
      readCatalogRoots.push(mainAgents);
    }
  }

  const rows: AgentProfileAdminRow[] = [];
  const claimed = new Set<string>();

  for (const root of roots) {
    if (!(await fs.exists(root.dir))) {
      continue;
    }
    // P7.21 W2-FIX #1 (root symlink escape): an own catalog root
    // (`<ws>/.anycode/agents`) that is a SYMLINK pointing outside the catalog
    // would make `readdir` enumerate — and the pane list — an external tree's
    // `.md` metadata/paths (out-of-root read). The per-FILE symlink is already
    // refused below, but the ROOT dir being a link is not. Prove symlink-RESOLVED
    // containment (rejecting a symlinked root, matching the skills deleter's
    // `isUnderOwnRootsResolved` custody discipline) before reading it. Fail-soft +
    // content-free: never interpolate the (attacker-controlled) link target.
    if (
      (root.source === "project" || root.source === "user") &&
      !(await isUnderOwnRootsResolved(fs, root.dir, readCatalogRoots, { allowEqual: true }))
    ) {
      problems.push(`Agent-profile root ${root.dir}: is a symbolic link escaping the catalog — ignored`);
      continue;
    }
    let entries: string[];
    try {
      entries = await fs.readdir(root.dir);
    } catch (error) {
      problems.push(
        `Could not read agent-profile dir ${root.dir}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    const files = entries.filter((entry) => entry.endsWith(".md")).sort();
    for (const file of files) {
      const path = join(root.dir, file);
      let stats;
      try {
        // lstat (never follows the final component) so a symlinked profile file
        // is classified as the LINK, not its target.
        stats = typeof fs.lstat === "function" ? await fs.lstat(path) : await fs.stat(path);
      } catch (error) {
        problems.push(
          `Could not stat agent profile ${path}: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      // P7.21 W1-FIX #2: a symlinked profile file is refused. Following it would
      // surface out-of-catalog content in the pane AND let subagents-read stream
      // the symlink target's raw markdown — an out-of-root read. Discovery (the
      // loader) is intentionally left byte-identical; only this admin/renderer
      // surface, which exposes file content and metadata to the editor, is
      // hardened. A symlink has isFile=false under lstat, but the explicit flag is
      // clearer and emits a transparent problem.
      if (stats.isSymbolicLink) {
        problems.push(`Agent profile ${path}: is a symbolic link — ignored`);
        continue;
      }
      if (!stats.isFile) {
        continue;
      }
      let raw: string;
      try {
        raw = await readProfileNoFollow(fs, path);
      } catch (error) {
        problems.push(
          `Could not read agent profile ${path}: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }

      const result = parseAgentProfileMd(raw, file.slice(0, -3));
      if ("error" in result) {
        const err = result.error;
        switch (err.kind) {
          case "frontmatter":
            problems.push(`Invalid agent profile ${path}: ${err.detail}`);
            break;
          case "bad_name":
            problems.push(
              `Agent profile ${path}: name "${err.name}" must match ${AGENT_PROFILE_NAME_RE.source} — ignored`,
            );
            break;
          case "reserved_name":
            problems.push(
              `Agent profile ${path}: name "${err.name}" is reserved by a built-in persona — ignored`,
            );
            break;
          case "missing_description":
            if (claimed.has(err.name)) {
              break;
            }
            claimed.add(err.name);
            problems.push(`Agent profile ${path}: missing "description" — ignored`);
            break;
          case "bad_model":
            if (claimed.has(err.name)) {
              break;
            }
            claimed.add(err.name);
            problems.push(
              `Agent profile ${path}: model "${err.model}" must match ${AGENT_PROFILE_MODEL_RE.source} — ignored`,
            );
            break;
          case "bad_engine":
            if (claimed.has(err.name)) {
              break;
            }
            claimed.add(err.name);
            problems.push(
              `Agent profile ${path}: engine "${err.engine}" must be "codex" or "claude" — ignored`,
            );
            break;
          case "bad_max_turns":
            // Same claim semantics as bad_model/bad_engine (mirrors discovery's
            // switch verbatim — parseAgentProfileMd is the single oracle).
            if (claimed.has(err.name)) {
              break;
            }
            claimed.add(err.name);
            problems.push(
              `Agent profile ${path}: maxTurns "${err.maxTurns}" must be an integer between 1 and ${SUBAGENT_MAX_TURNS_CEILING} — ignored`,
            );
            break;
          case "engine_tools_conflict":
            // Same claim semantics as bad_model/bad_engine (TASK.97 R4, mirrors
            // discovery's switch verbatim — parseAgentProfileMd is the single oracle).
            if (claimed.has(err.name)) {
              break;
            }
            claimed.add(err.name);
            problems.push(
              `Agent profile ${path}: "tools" cannot be combined with "engine: ${err.engine}" — an engine child's toolset belongs to that CLI; remove one of the two — ignored`,
            );
            break;
        }
        continue;
      }

      const { name, description, tools, toolsExplicit, body, model, engine } = result.ok;
      if (claimed.has(name)) {
        continue;
      }
      claimed.add(name);
      if (rows.length >= MAX_AGENT_PROFILES) {
        problems.push(
          `Agent profile ${path}: exceeds MAX_AGENT_PROFILES (${MAX_AGENT_PROFILES}) — ignored`,
        );
        continue;
      }
      for (const suffix of result.ok.problems) {
        problems.push(`Agent profile ${path}: ${suffix}`);
      }
      rows.push({
        name,
        description,
        tools,
        toolsExplicit,
        source: root.source,
        sourceKind: sourceKindOf(root.source),
        path,
        bodyBytes: Buffer.byteLength(body, "utf8"),
        ...(model !== undefined ? { model } : {}),
        ...(engine !== undefined ? { engine } : {}),
      });
    }
  }

  return { rows, problems };
}
