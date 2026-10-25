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
