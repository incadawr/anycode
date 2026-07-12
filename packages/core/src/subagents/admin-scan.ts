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

import { join } from "node:path";
import type { FileSystemPort } from "../ports/file-system.js";
import { discoverPlugins } from "../plugins/discovery.js";
import { MAX_AGENT_PROFILES } from "../types/config.js";
import { AGENT_PROFILE_NAME_RE, parseAgentProfileMd, type AgentProfileRoot } from "./profiles.js";
import { isUnderOwnRootsResolved } from "../util/path-containment.js";

/** `<baseDir>/<relative>`, tolerating a trailing separator on baseDir (mirrors bootstrap.subdir). */
function subdir(baseDir: string, rel: string): string {
  return `${baseDir.replace(/[/\\]+$/, "")}/${rel}`;
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
  return [
    { dir: subdir(workspace, ".anycode/agents"), source: "project" },
    ...(sameWorkspaceHome ? [] : [{ dir: subdir(home, ".anycode/agents"), source: "user" }]),
    ...pluginAgentRoots,
  ];
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
  // The writable own-catalog roots (project/user). An OWN root that is itself a
  // symlink escaping this area must never be enumerated (see the guard below);
  // plugin roots are a separate read-only trust domain (plugin discovery already
  // contains them) so the guard is scoped to project/user roots.
  const ownRoots = ownAgentRoots(workspace, home);

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
      !(await isUnderOwnRootsResolved(fs, root.dir, ownRoots, { allowEqual: true }))
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
        }
        continue;
      }

      const { name, description, tools, toolsExplicit, body } = result.ok;
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
      });
    }
  }

  return { rows, problems };
}
