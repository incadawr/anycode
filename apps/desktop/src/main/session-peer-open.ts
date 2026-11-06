import { createSessionForAgent, type CreateSessionByAgentDeps } from "./create-session-by-agent.js";
import type { CreateSessionRequest } from "./communication-server.js";
import type { CreatorAdmissionPolicy } from "./communication-creation-admission.js";

/** Both main entrances share the creator's admission and reservation lifetime. */
export function createSessionPeerOpener(deps: CreateSessionByAgentDeps) {
  return (request: CreateSessionRequest, policy: Extract<CreatorAdmissionPolicy, { kind: "native" }>) =>
    createSessionForAgent(request, deps, policy);
}
