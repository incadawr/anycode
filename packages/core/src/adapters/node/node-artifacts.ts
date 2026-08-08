/**
 * Node implementation of ArtifactStorePort (TASK.94).
 *
 * Layout: `<artifactsRoot>/<sessionId>/<toolCallId>`. The root is chosen by the
 * host OUTSIDE the workspace — beside anycode.sqlite and the shadow-git
 * checkpoints — so a spilled artifact can never show up in the user's
 * `git status` and never needs write permission on the working tree.
 *
 * Deliberately built on node:fs/promises rather than FileSystemPort: the store
 * needs directory mtimes, atomic rename semantics and per-entry error isolation
 * during the sweep, none of which FileSystemPort promises, and it is host
 * bookkeeping rather than a tool-visible side effect.
 */

import { mkdir, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ArtifactStorePort,
  ArtifactWriteRequest,
} from "../../ports/artifacts.js";
import { ARTIFACT_MAX_BYTES } from "../../types/config.js";

/**
 * Path segments are accepted only in this alphabet. Session ids are uuids and
 * tool-call ids are provider-issued opaque tokens, so in practice nothing is
 * rejected; the guard exists because both values reach the store from outside
 * this module, and a segment containing `..` or a separator would let a caller
 * pick the write target. Fail-closed: an unmatched id throws, and the
 * dispatcher's catch turns that into ordinary truncation.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

/** Rejects `.` and `..` outright — both match SAFE_SEGMENT but name a directory. */
function assertSafeSegment(kind: string, value: string): void {
  if (!SAFE_SEGMENT.test(value) || value === "." || value === "..") {
    throw new Error(`unsafe ${kind} for an artifact path: ${JSON.stringify(value)}`);
  }
}

export interface NodeArtifactStoreOptions {
  /** Per-write byte cap; defaults to ARTIFACT_MAX_BYTES. Overridable so tests can prove the refusal without generating 50 MB. */
  maxBytes?: number;
}

export class NodeArtifactStore implements ArtifactStorePort {
  private readonly root: string;
  private readonly maxBytes: number;
  /** Disambiguates concurrent temp names within one process. */
  private tmpCounter = 0;

  constructor(artifactsRoot: string, opts?: NodeArtifactStoreOptions) {
    this.root = artifactsRoot;
    this.maxBytes = opts?.maxBytes ?? ARTIFACT_MAX_BYTES;
  }

  async writeToolResultArtifact(
    req: ArtifactWriteRequest,
  ): Promise<{ path: string; bytes: number }> {
    assertSafeSegment("sessionId", req.sessionId);
    assertSafeSegment("toolCallId", req.toolCallId);

    const bytes = Buffer.byteLength(req.content, "utf8");
    if (bytes > this.maxBytes) {
      throw new Error(`artifact of ${bytes} bytes exceeds the per-write cap of ${this.maxBytes}`);
    }

    const dir = join(this.root, req.sessionId);
    await mkdir(dir, { recursive: true });

    // Write-then-rename: a reader that follows the path out of the envelope
    // must never observe a half-written file. rename() within one directory is
    // atomic on every platform we target.
    this.tmpCounter += 1;
    const target = join(dir, req.toolCallId);
    const tmp = `${target}.${process.pid}.${this.tmpCounter}.tmp`;
    try {
      await writeFile(tmp, req.content, "utf-8");
      await rename(tmp, target);
    } catch (error) {
      await unlink(tmp).catch(() => {});
      throw error;
    }

    return { path: target, bytes };
  }

  async removeSession(sessionId: string): Promise<void> {
    try {
      assertSafeSegment("sessionId", sessionId);
      await rm(join(this.root, sessionId), { recursive: true, force: true });
    } catch {
      // Best-effort by contract: this runs on the host's exit path, where a
      // failed unlink must never outrank shutting down cleanly.
    }
  }

  async sweepExpired(maxAgeMs: number, now: number = Date.now()): Promise<{ removed: string[] }> {
    const removed: string[] = [];
    let entries: string[];
    try {
      entries = await readdir(this.root);
    } catch {
      // A root that does not exist yet is the common first-run case, not a
      // failure: there is nothing to collect.
      return { removed };
    }

    for (const name of entries) {
      try {
        const dir = join(this.root, name);
        const info = await stat(dir);
        // A directory's mtime moves whenever an artifact is added to or
        // removed from it, so a live session's directory keeps refreshing
        // itself and only genuinely abandoned ones age out.
        if (!info.isDirectory() || now - info.mtimeMs <= maxAgeMs) continue;
        await rm(dir, { recursive: true, force: true });
        removed.push(name);
      } catch {
        // Per-entry isolation: one unreadable directory must not abort the
        // sweep for every other session.
      }
    }
    return { removed };
  }
}
