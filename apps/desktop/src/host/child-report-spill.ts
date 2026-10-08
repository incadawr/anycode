/**
 * Saves a detached child's whole final report when it is too long for the
 * `<task-notification>` summary, so the notification can name the file
 * instead of silently dropping the tail (core's `childNotificationSummaryOverflows`).
 *
 * The file goes under the system temp dir, not the workspace: the parent only
 * needs to read it once, and a report file must never show up in the user's
 * `git status`. Best effort — a failed write returns `undefined` and the
 * notification falls back to the plain `…[truncated]` marker.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function defaultChildReportDir(): string {
  return join(tmpdir(), "anycode-child-reports");
}

export function saveFullChildReport(dir: string, childSessionId: string, text: string): string | undefined {
  // The id comes from our own session store, but it becomes a file name: keep it to a safe charset.
  const name = childSessionId.replace(/[^A-Za-z0-9._-]/g, "_");
  if (name.length === 0) return undefined;
  try {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${name}.md`);
    writeFileSync(path, text, "utf8");
    return path;
  } catch {
    return undefined;
  }
}
