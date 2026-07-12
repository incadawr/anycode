/**
 * Agent-profile editor writer + validator (P7.21 W1, design §2-D3/D7 + §4-W1).
 * The WRITE half of the subagents admin surface: it validates a draft STRICTER
 * than discovery reads (so a saved file can never become a boot-time problem),
 * serializes it to a `parseAgentProfileMd`-round-trippable `*.md`, and creates /
 * saves (incl. rename) / deletes it atomically inside proven own-catalog custody.
 *
 * Security (design §2-D7): the renderer never sends a path — the caller resolves
 * paths from a fresh admin scan and passes them here; every destructive op proves
 * symlink-resolved containment under the writable own roots before touching disk.
 * A rename is a write-new + delete-old pair inside ONE serialized section, both
 * ends containment-checked. Content validation refuses reserved built-in names,
 * proto-key names, an over-cap body (refuse, never truncate — the loader
 * truncates; the editor refuses so what you save is what spawns), and explicit
 * spawn tools (Agent/Workflow); unknown tool names are non-fatal warnings.
 *
 * ⚠ Main-safe: ports + util + profiles/personas only — NO ai-SDK, no loop.
 */

import { dirname } from "node:path";
import { isDangerousKey, atomicWriteText, serializeConfigWrite } from "../util/config-file.js";
import { isUnderOwnRootsResolved } from "../util/path-containment.js";
import { AGENT_PROFILE_PROMPT_MAX_BYTES } from "../types/config.js";
import { isKnownPersona } from "./personas.js";
import { SPAWN_TOOLS } from "./spawn-tools.js";
import { AGENT_PROFILE_NAME_RE, parseAgentProfileMd } from "./profiles.js";
import { DEFAULT_TOOL_NAMES, type SubagentProfileDraft } from "./preview.js";
import type { FileSystemPort } from "../ports/file-system.js";

// ---------------------------------------------------------------------------
// Validation.

export type ValidateAgentProfileResult =
  | { ok: true; warnings: string[] }
  | { ok: false; reason: "reserved_name"; issues: string[] }
  | { ok: false; reason: "validation_failed"; issues: string[] };

/**
 * Validates a draft against the editor's stricter-than-loader rules. Reserved
 * built-in names short-circuit to a distinct `reserved_name` reason (the loader
 * would fail-soft them; the editor refuses up front). Unknown tool names are
 * WARNINGS (the loader treats them as no-ops), everything else in `issues` is a
 * hard refusal. A trailing strict re-parse of the serialized bytes guarantees the
 * draft round-trips to itself (frontmatter smuggling via a body `---` stays
 * inert; a value that would break the flat frontmatter is caught here).
 */
export function validateAgentProfileDraft(draft: SubagentProfileDraft): ValidateAgentProfileResult {
  const name = draft.name.trim();

  // Reserved built-in — distinct typed refusal.
  if (isKnownPersona(name)) {
    return {
      ok: false,
      reason: "reserved_name",
      issues: [`name "${name}" is reserved by a built-in persona`],
    };
  }

  const issues: string[] = [];
  const warnings: string[] = [];

  if (!AGENT_PROFILE_NAME_RE.test(name)) {
    issues.push(`name "${name}" must match ${AGENT_PROFILE_NAME_RE.source}`);
  }
  // Proto-key names (constructor/prototype pass the regex) — reject outright.
  if (isDangerousKey(name)) {
    issues.push(`name "${name}" is a reserved object key and cannot be used`);
  }

  const description = draft.description.trim();
  if (description === "") {
    issues.push('a non-empty "description" is required');
  }
  if (/[\r\n]/.test(draft.description)) {
    issues.push("description must be a single line (no line breaks)");
  }

  if (draft.tools !== undefined) {
    for (const tool of draft.tools) {
      if (/[,\r\n]/.test(tool) || tool.trim() === "") {
        issues.push(`invalid tool entry "${tool}"`);
        continue;
      }
      if (SPAWN_TOOLS.has(tool)) {
        issues.push(`tool "${tool}" cannot be granted to a subagent (non-recursion lock)`);
        continue;
      }
      if (!DEFAULT_TOOL_NAMES.includes(tool)) {
        warnings.push(`tool "${tool}" is not a known built-in tool and will be ignored at spawn`);
      }
    }
  }

  // P7.21 W1-FIX #5: a whitespace-only (or empty) body would round-trip to the
  // loader's `[agent profile "…" — empty body]` placeholder, so the saved bytes
  // would NOT be the model-governing prompt. The editor refuses it up front (the
  // loader is lenient; the editor is stricter — what you save is what spawns).
  if (draft.body.trim() === "") {
    issues.push("body must not be empty or whitespace-only");
  }

  // Byte cap: REFUSE over-cap (the loader truncates; the editor never writes a
  // file that would spawn differently than it reads).
  if (Buffer.byteLength(draft.body, "utf8") > AGENT_PROFILE_PROMPT_MAX_BYTES) {
    issues.push(`body exceeds the ${AGENT_PROFILE_PROMPT_MAX_BYTES}-byte cap`);
  }

  if (issues.length > 0) {
    return { ok: false, reason: "validation_failed", issues };
  }

  // Strict re-parse of the exact bytes we would write: the shared oracle must
  // accept them AND reconstruct the same name/description/tools/body.
  const serialized = serializeAgentProfile(draft);
  const reparsed = parseAgentProfileMd(serialized, name);
  if ("error" in reparsed) {
    const detail = reparsed.error.kind === "frontmatter" ? reparsed.error.detail : reparsed.error.kind;
    return { ok: false, reason: "validation_failed", issues: [`serialized profile did not re-parse: ${detail}`] };
  }

  // P7.21 W1-FIX #3: a spawn tool can evade the raw per-entry SPAWN_TOOLS check
  // above via parser normalization (` Agent `, `"Agent"`, `[Agent]` all normalize
  // to `Agent`). Re-check the NORMALIZED (serialized→reparsed) tool list — the
  // exact names discovery/runner see — and refuse any spawn-capable member, so a
  // spawn tool can never be persisted through a save.
  for (const tool of reparsed.ok.tools) {
    if (SPAWN_TOOLS.has(tool)) {
      return {
        ok: false,
        reason: "validation_failed",
        issues: [`tool "${tool}" cannot be granted to a subagent (non-recursion lock)`],
      };
    }
  }

  // Round-trip integrity: the exact bytes we will write must reconstruct the same
  // model-governing profile (name/description/body). A mismatch means the
  // serialize→parse normalization silently changed the saved semantics — refuse
  // rather than persist a file that spawns differently than it was authored.
  if (
    reparsed.ok.name !== name ||
    reparsed.ok.description !== description ||
    reparsed.ok.body !== draft.body
  ) {
    return {
      ok: false,
      reason: "validation_failed",
      issues: ["serialized profile does not round-trip to itself"],
    };
  }

  return { ok: true, warnings };
}

// ---------------------------------------------------------------------------
// Serialization.

/**
 * Serializes a draft to a profile `*.md` that `parseAgentProfileMd` round-trips
 * byte-stably: a flat frontmatter block (`name`, `description`, optional `tools`)
 * then the body verbatim after the closing fence. An absent/empty tools list
 * omits the `tools:` line (baseline inherit); body `---` lines land after the
 * fence and stay inert.
 */
export function serializeAgentProfile(draft: SubagentProfileDraft): string {
  const lines = ["---", `name: ${draft.name.trim()}`, `description: ${draft.description.trim()}`];
  if (draft.tools !== undefined && draft.tools.length > 0) {
    lines.push(`tools: ${draft.tools.join(", ")}`);
  }
  lines.push("---");
  return `${lines.join("\n")}\n${draft.body}`;
}

// ---------------------------------------------------------------------------
// Create / save / delete.

export type WriteRefusal =
  | "reserved_name"
  | "validation_failed"
  | "name_conflict"
  | "outside_own_roots"
  | "io_error";

export type WriteAgentProfileResult =
  | { ok: true; name: string; path: string; warnings: string[] }
  | { ok: false; reason: WriteRefusal; issues?: string[] };

export type DeleteAgentProfileResult =
  | { ok: true }
  | { ok: false; reason: "outside_own_roots" | "io_error" };

/** Joins a writable root and `<name>.md` (name already regex-validated — no separators). */
function profilePath(targetRoot: string, name: string): string {
  return `${targetRoot.replace(/[/\\]+$/, "")}/${name}.md`;
}

async function writeProfileAtomic(fs: FileSystemPort, targetRoot: string, path: string, content: string): Promise<void> {
  await fs.mkdir(targetRoot);
  await atomicWriteText(fs, path, content);
}

/**
 * Creates a NEW profile at `<targetRoot>/<name>.md`. Refuses a forged/escaping
 * target (symlink-resolved containment), an existing name (`name_conflict`), and
 * any validation failure. `targetRoot` MUST be one of `ownRoots` (project/user).
 */
export async function createAgentProfile(
  fs: FileSystemPort,
  targetRoot: string,
  draft: SubagentProfileDraft,
  ownRoots: readonly string[],
): Promise<WriteAgentProfileResult> {
  const validation = validateAgentProfileDraft(draft);
  if (!validation.ok) {
    return { ok: false, reason: validation.reason, issues: validation.issues };
  }
  const name = draft.name.trim();
  const path = profilePath(targetRoot, name);

  if (!(await isUnderOwnRootsResolved(fs, path, ownRoots))) {
    return { ok: false, reason: "outside_own_roots" };
  }
  const content = serializeAgentProfile(draft);
  // Serialize on the ROOT (not the file path) so create/save/delete for one
  // catalog run strictly sequentially (P7.21 W1-FIX #4).
  return serializeConfigWrite(targetRoot, async () => {
    try {
      if (await fs.exists(path)) {
        return { ok: false, reason: "name_conflict" } as WriteAgentProfileResult;
      }
      await writeProfileAtomic(fs, targetRoot, path, content);
      return { ok: true, name, path, warnings: validation.warnings };
    } catch {
      return { ok: false, reason: "io_error" };
    }
  });
}

/**
 * Saves an EXISTING profile (`oldPath`, resolved by the caller from a fresh admin
 * scan). A name change is a rename: write the new file + delete the old inside ONE
 * serialized section, BOTH ends containment-checked. An in-place edit overwrites
 * atomically. A rename onto an existing different file refuses `name_conflict`.
 */
export async function saveAgentProfile(
  fs: FileSystemPort,
  oldPath: string,
  targetRoot: string,
  draft: SubagentProfileDraft,
  ownRoots: readonly string[],
): Promise<WriteAgentProfileResult> {
  const validation = validateAgentProfileDraft(draft);
  if (!validation.ok) {
    return { ok: false, reason: validation.reason, issues: validation.issues };
  }
  const name = draft.name.trim();
  const newPath = profilePath(targetRoot, name);
  const content = serializeAgentProfile(draft);

  // Both the source and the destination must live under the writable own roots.
  if (!(await isUnderOwnRootsResolved(fs, oldPath, ownRoots))) {
    return { ok: false, reason: "outside_own_roots" };
  }
  if (!(await isUnderOwnRootsResolved(fs, newPath, ownRoots))) {
    return { ok: false, reason: "outside_own_roots" };
  }

  // Serialize on the ROOT so BOTH ends of a rename (old + new path) and any
  // concurrent create/delete for the same catalog run strictly sequentially
  // (P7.21 W1-FIX #4): the key covers old+new because both live under targetRoot.
  return serializeConfigWrite(targetRoot, async () => {
    try {
      const renaming = newPath !== oldPath;
      // A rename must hold the OLD path too. Re-checking that the source still
      // exists INSIDE the serialized section defeats two concurrent renames of the
      // same file (`a->b` and `a->c`) that would otherwise each write their target
      // and both delete `a`, turning one profile into two. A vanished source means
      // the profile was concurrently renamed/deleted — refuse, do not resurrect.
      if (renaming && !(await fs.exists(oldPath))) {
        return { ok: false, reason: "io_error" } as WriteAgentProfileResult;
      }
      if (renaming && (await fs.exists(newPath))) {
        return { ok: false, reason: "name_conflict" } as WriteAgentProfileResult;
      }
      await writeProfileAtomic(fs, targetRoot, newPath, content);
      if (renaming && typeof fs.rm === "function") {
        try {
          await fs.rm(oldPath);
        } catch {
          // The new file is written; a failed old-file removal leaves a stale
          // duplicate but never loses the user's content. Surfaced as success —
          // the next scan shows both and the user can delete the stale one.
        }
      }
      return { ok: true, name, path: newPath, warnings: validation.warnings };
    } catch {
      return { ok: false, reason: "io_error" };
    }
  });
}

/**
 * Deletes a profile `*.md` AFTER proving it lives under one of the writable own
 * roots (symlink-resolved). Refuses a plugin/foreign path or a root itself. Never
 * throws.
 */
export async function deleteAgentProfile(
  fs: FileSystemPort,
  filePath: string,
  ownRoots: readonly string[],
): Promise<DeleteAgentProfileResult> {
  if (!(await isUnderOwnRootsResolved(fs, filePath, ownRoots))) {
    return { ok: false, reason: "outside_own_roots" };
  }
  const rm = fs.rm;
  if (typeof rm !== "function") {
    return { ok: false, reason: "io_error" };
  }
  // Serialize on the profile's ROOT so a delete cannot interleave with a
  // concurrent save/rename/create targeting the same catalog (P7.21 W1-FIX #4).
  return serializeConfigWrite(dirname(filePath), async () => {
    try {
      await rm(filePath);
      return { ok: true };
    } catch {
      return { ok: false, reason: "io_error" };
    }
  });
}
