/**
 * Workspace trust (Taskana 4736). Decides whether a project folder's own
 * declarations (MCP servers, hooks, LSP servers, project-tier plugin MCP) may
 * start processes. Main-safe subpath `@anycode/core/workspace-trust`: no ai-SDK
 * imports, so the Electron main process can persist decisions through it.
 *
 * States:
 *   none      no project spawn declarations — nothing to gate
 *   trusted   stored trusted hash matches, or the in-memory "trust once" hash matches
 *   denied    stored denial matches the current hash — silent, no re-prompt
 *   changed   a decision exists for this folder but for a different hash — re-consent
 *   unknown   never decided — prompt
 * Only `none` and `trusted` allow project spawning (`projectTrusted`).
 */

import type { FileSystemPort } from "../ports/file-system.js";
import { collectProjectSpawnConfig, type ProjectSpawnItem } from "./project-spawn-config.js";
import {
  canonicalWorkspacePath,
  defaultTrustStorePath,
  readTrustStore,
} from "./workspace-trust-store.js";

export {
  collectProjectSpawnConfig,
  canonicalJson,
  type ProjectSpawnItem,
  type ProjectSpawnKind,
  type ProjectSpawnConfig,
} from "./project-spawn-config.js";
export {
  canonicalWorkspacePath,
  defaultTrustStorePath,
  readTrustStore,
  writeTrustDecision,
  emptyTrustStore,
  type WorkspaceTrustDecision,
  type WorkspaceTrustRecord,
  type WorkspaceTrustStore,
} from "./workspace-trust-store.js";

export type WorkspaceTrustState = "none" | "trusted" | "denied" | "changed" | "unknown";

export interface WorkspaceTrustOptions {
  workspace: string;
  home: string;
  /** Absolute path of the trust store (`defaultTrustStorePath(home)` in production). */
  storePath: string;
  /** Hash approved for this process only ("Trust once"); never persisted. */
  onceHash?: string;
}

export interface WorkspaceTrustResult {
  state: WorkspaceTrustState;
  /** Hash of the current project spawn set ("" when there is none). */
  hash: string;
  /** Displayable items the decision applies to (no env/header values). */
  items: ProjectSpawnItem[];
  /** True when project declarations may spawn: state is `none` or `trusted`. */
  projectTrusted: boolean;
  folder: string;
}

export async function resolveWorkspaceTrust(
  fs: FileSystemPort,
  opts: WorkspaceTrustOptions,
): Promise<WorkspaceTrustResult> {
  const folder = canonicalWorkspacePath(opts.workspace);
  const { items, hash } = await collectProjectSpawnConfig(fs, opts.workspace, opts.home);
  const finish = (state: WorkspaceTrustState): WorkspaceTrustResult => ({
    state,
    hash,
    items,
    projectTrusted: state === "none" || state === "trusted",
    folder,
  });

  if (items.length === 0) {
    return finish("none");
  }
  if (opts.onceHash !== undefined && opts.onceHash === hash) {
    return finish("trusted");
  }

  const store = await readTrustStore(fs, opts.storePath);
  const record = store.folders[folder];
  if (!record) {
    return finish("unknown");
  }
  if (record.hash !== hash) {
    return finish("changed");
  }
  return finish(record.decision === "trusted" ? "trusted" : "denied");
}

export { parseTrustAnswer, promptWorkspaceTrust, describeTrustItem, type TrustPromptAnswer } from "./cli-prompt.js";
