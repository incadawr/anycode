/**
 * PreToolUse snapshot observer for the diff view (design §5).
 *
 * Registered against matcher /^(Write|Edit)$/, it reads the CURRENT on-disk
 * content of the target file through the FileSystemPort and emits a
 * `file_snapshot{phase:"before"}` message, then returns `undefined` — it never
 * returns a permissionDecision, because it is an OBSERVER, not a gate.
 *
 * CRITICAL (design §5): the core hook runner is fail-closed — a hook that
 * throws or times out is treated as a DENY of the tool call. This observer must
 * therefore swallow EVERY error (whole body wrapped in try/catch) and ALWAYS
 * resolve `undefined`, so a snapshot failure can never block the dispatch. The
 * `file_snapshot{phase:"after"}` counterpart is emitted by the session after a
 * successful tool_result (session.ts) using the same readSnapshot helper.
 */

import type { FileSystemPort, HookRegistration, PreToolUseHookInput } from "@anycode/core";

/** HookRegistration is a union since Phase 1; this hook is always the PreToolUse variant. */
export type PreToolUseHookRegistration = Extract<HookRegistration, { event: "PreToolUse" }>;
import type { HostToUiMessage } from "../shared/protocol.js";

/** Files larger than this are reported as content:null,truncated:true (diff unavailable). */
export const SNAPSHOT_MAX_BYTES = 1_000_000;

const SNAPSHOT_TOOL_MATCHER = /^(Write|Edit)$/;

export function isSnapshotTool(toolName: string): boolean {
  return SNAPSHOT_TOOL_MATCHER.test(toolName);
}

/** Both Write and Edit carry the target file under `file_path` (core tool schemas). */
export function extractSnapshotPath(input: unknown): string | null {
  if (typeof input === "object" && input !== null) {
    const path = (input as Record<string, unknown>).file_path;
    if (typeof path === "string" && path.length > 0) {
      return path;
    }
  }
  return null;
}

export interface FileSnapshotContent {
  /** File text, "" for a not-yet-existing file, or null when too large / unreadable. */
  content: string | null;
  truncated: boolean;
}

/**
 * Reads a file for a snapshot with the size cap applied:
 *   - missing file / non-regular file -> content:"" (a brand new file, empty diff base)
 *   - size > SNAPSHOT_MAX_BYTES        -> content:null, truncated:true
 *   - otherwise                        -> full UTF-8 content
 */
export async function readSnapshot(fs: FileSystemPort, path: string): Promise<FileSnapshotContent> {
  const exists = await fs.exists(path);
  if (!exists) {
    return { content: "", truncated: false };
  }
  const stat = await fs.stat(path);
  if (!stat.isFile) {
    return { content: "", truncated: false };
  }
  if (stat.size > SNAPSHOT_MAX_BYTES) {
    return { content: null, truncated: true };
  }
  const content = await fs.readFile(path);
  return { content, truncated: false };
}

/**
 * Builds the PreToolUse "before" snapshot hook. `fs` reads the pre-mutation
 * content; `emit` posts the file_snapshot message to the renderer. The hook is a
 * pure observer: it returns undefined and swallows all errors (fail-closed
 * invariant of the core hook runner — an observer must not deny a dispatch).
 */
export function createSnapshotHook(
  fs: FileSystemPort,
  emit: (message: HostToUiMessage) => void,
): PreToolUseHookRegistration {
  const hook = async (input: PreToolUseHookInput): Promise<undefined> => {
    try {
      const path = extractSnapshotPath(input.input);
      if (path !== null) {
        const snapshot = await readSnapshot(fs, path);
        emit({
          type: "file_snapshot",
          toolCallId: input.toolCallId,
          path,
          phase: "before",
          content: snapshot.content,
          truncated: snapshot.truncated,
        });
      }
    } catch {
      // Observer must NEVER influence dispatch (design §5). The core hook runner
      // treats a throw as deny, so every error is swallowed here and the hook
      // always resolves undefined with no permissionDecision.
    }
    return undefined;
  };

  return { event: "PreToolUse", matcher: SNAPSHOT_TOOL_MATCHER, hook };
}
