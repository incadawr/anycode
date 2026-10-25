/**
 * Workspace trust IPC channel names (Taskana 4736), value-only with ZERO
 * imports: the sandboxed preload imports these, and a preload that pulls in
 * any package (zod) fails to load, leaving the renderer without `window.anycode`.
 */

/** Renderer -> main invoke channel for the trust answer. */
export const WORKSPACE_TRUST_DECIDE_CHANNEL = "anycode:workspace-trust-decide";

/** Renderer -> main invoke channel for listing remembered trust decisions. */
export const WORKSPACE_TRUST_LIST_CHANNEL = "anycode:workspace-trust-list";

/** Renderer -> main invoke channel for forgetting ONE remembered decision. */
export const WORKSPACE_TRUST_FORGET_CHANNEL = "anycode:workspace-trust-forget";
