/**
 * Host boot trust decision (Taskana 4736). Computed ONCE at boot, before any
 * engine, hook, LSP or MCP wiring: `projectTrusted` gates every project-level
 * spawn declaration. An undecided or changed folder boots untrusted and yields
 * a `workspace_trust_required` message for the UI (replayed on every ui_ready
 * while pending) plus the hash main needs to record the user's answer.
 * Fail-closed: any unexpected error boots untrusted.
 */

import type { FileSystemPort } from "@anycode/core";
import {
  defaultTrustStorePath,
  resolveWorkspaceTrust,
  type WorkspaceTrustResult,
} from "@anycode/core/workspace-trust";
import {
  WORKSPACE_TRUST_ONCE_ENV,
  type WorkspaceTrustItemWire,
} from "../shared/workspace-trust.js";

export interface HostWorkspaceTrustPending {
  state: "unknown" | "changed";
  /** Hash of the declarations the user is asked about; sent to main on the control channel. */
  hash: string;
  message: {
    type: "workspace_trust_required";
    state: "unknown" | "changed";
    workspace: string;
    items: WorkspaceTrustItemWire[];
  };
}

export interface HostWorkspaceTrust {
  /** Gate for every project-level loader and forward. */
  projectTrusted: boolean;
  /** Present only while the folder's decision is unknown or changed. */
  pending?: HostWorkspaceTrustPending;
}

export interface EstablishHostWorkspaceTrustOptions {
  workspace: string;
  home: string;
  env: NodeJS.ProcessEnv;
  /**
   * Taskana 4739: injected realpath for key canonicalisation (symlink and
   * target share one trust record). Production callers pass `node:fs`'s
   * realpathSync; absent = legacy resolve-only behaviour.
   */
  realpathSync?: (path: string) => string;
}

export async function establishHostWorkspaceTrust(
  fs: FileSystemPort,
  opts: EstablishHostWorkspaceTrustOptions,
): Promise<HostWorkspaceTrust> {
  try {
    const trust = await resolveWorkspaceTrust(fs, {
      workspace: opts.workspace,
      home: opts.home,
      storePath: defaultTrustStorePath(opts.home),
      onceHash: opts.env[WORKSPACE_TRUST_ONCE_ENV] || undefined,
      realpathSync: opts.realpathSync,
    });
    return toHostTrust(opts.workspace, trust);
  } catch (error) {
    console.error(
      `[host] workspace trust check failed; project declarations stay off: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { projectTrusted: false };
  }
}

function toHostTrust(workspace: string, trust: WorkspaceTrustResult): HostWorkspaceTrust {
  if (trust.state !== "unknown" && trust.state !== "changed") {
    return { projectTrusted: trust.projectTrusted };
  }
  return {
    projectTrusted: false,
    pending: {
      state: trust.state,
      hash: trust.hash,
      message: {
        type: "workspace_trust_required",
        state: trust.state,
        workspace,
        items: trust.items.map((item) => ({
          kind: item.kind,
          name: item.name,
          commandLine: item.commandLine,
          source: item.source,
          envKeys: [...item.envKeys],
        })),
      },
    },
  };
}
