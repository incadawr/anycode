/**
 * Workspace trust wire contract (Taskana 4736). A project folder's own spawn
 * declarations (project MCP servers, hooks, LSP servers, project-tier plugin
 * MCP) start only after the user trusts the folder. The host reports what is
 * pending to the UI as display-only items; the UI answers with a decision and
 * a tab id ONLY — never a filesystem path or a hash. Main resolves the folder
 * and the hash from its own per-tab record.
 */

import { z } from "zod";

/** Renderer -> main invoke channel for the trust answer. */
export const WORKSPACE_TRUST_DECIDE_CHANNEL = "anycode:workspace-trust-decide";

/** Env var the host reads for an in-process "trust once" approval (set by main at fork). */
export const WORKSPACE_TRUST_ONCE_ENV = "ANYCODE_WORKSPACE_TRUST_ONCE";

/** Host -> main control message carrying the pending config hash for the tab. */
export const WORKSPACE_TRUST_PENDING_MESSAGE_TYPE = "workspace_trust_pending";

export type WorkspaceTrustKind = "mcp" | "hook" | "lsp" | "plugin-mcp";

/** Display-only declaration row: command line and env KEY names, never values. */
export interface WorkspaceTrustItemWire {
  kind: WorkspaceTrustKind;
  name: string;
  commandLine: string;
  source: string;
  envKeys: string[];
}

export const workspaceTrustDecideSchema = z
  .object({
    tabId: z.string().min(1).max(200),
    decision: z.enum(["trust", "once", "deny"]),
  })
  .strict();

export type WorkspaceTrustDecideRequest = z.infer<typeof workspaceTrustDecideSchema>;
export type WorkspaceTrustDecision = WorkspaceTrustDecideRequest["decision"];

export type WorkspaceTrustDecideResult =
  | { ok: true }
  | { ok: false; reason: "invalid" | "unknown_tab" | "no_pending" | "write_failed" };

// Taskana 4739: Settings → Permissions lists the remembered trusted/denied
// folders and can forget ONE record. The renderer is untrusted: list carries
// NO payload, forget carries ONLY a `key` string it previously received from
// main's list — never a decision, hash, tab id, or arbitrary path. The key is
// an opaque lookup handle for main; it is never resolved or used as a path.

/** Renderer -> main invoke channel for listing remembered trust decisions. */
export const WORKSPACE_TRUST_LIST_CHANNEL = "anycode:workspace-trust-list";

/** Renderer -> main invoke channel for forgetting ONE remembered decision. */
export const WORKSPACE_TRUST_FORGET_CHANNEL = "anycode:workspace-trust-forget";

export const workspaceTrustForgetSchema = z
  .object({
    key: z.string().min(1).max(4096),
  })
  .strict();

export type WorkspaceTrustForgetRequest = z.infer<typeof workspaceTrustForgetSchema>;

/** Display-only row: the folder key, its decision, and when it was decided. No hash. */
export interface WorkspaceTrustListedFolder {
  key: string;
  /** The STORED decision ("trusted"/"denied"), not the decide-request verb. */
  decision: "trusted" | "denied";
  decidedAt: string;
}

export type WorkspaceTrustListResult =
  | { ok: true; folders: WorkspaceTrustListedFolder[] }
  | { ok: false; reason: "read_failed" };

export type WorkspaceTrustForgetResult =
  | { ok: true }
  | { ok: false; reason: "invalid" | "not_found" | "write_failed" };
