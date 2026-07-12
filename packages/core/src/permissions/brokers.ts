/** Permission brokers: resolvers for "ask" rulings. */

import type { PermissionBroker, PermissionDecision, PermissionRequest } from "../types/permissions.js";

/**
 * Fail-closed default: denies every request with a reason naming the tool.
 * Wired whenever no interactive permission client is configured, so every
 * escalated "ask" resolves to deny.
 */
export class DenyPermissionBroker implements PermissionBroker {
  requestPermission(request: PermissionRequest): Promise<PermissionDecision> {
    return Promise.resolve({
      behavior: "deny",
      reason: `${request.toolName}: no interactive permission client configured`,
    });
  }
}

/** Test-only broker that allows everything. Never wire it in production paths. */
export class AllowAllPermissionBroker implements PermissionBroker {
  requestPermission(_request: PermissionRequest): Promise<PermissionDecision> {
    return Promise.resolve({ behavior: "allow" });
  }
}
