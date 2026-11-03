import { ModePermissionEngine, ProfilePermissionEngine, SafeCommandPermissionEngine } from "@anycode/core";
import type { PermissionEngine, SessionProfileRestrictions, ToolRegistry } from "@anycode/core";

export function restrictChildRegistry(registry: ToolRegistry, restrictions: SessionProfileRestrictions | undefined): void {
  if (!restrictions) return;
  registry.restrictTo(restrictions.tools);
}

export function restrictChildPermissions(base: PermissionEngine, restrictions: SessionProfileRestrictions | undefined): PermissionEngine {
  if (!restrictions) return base;
  const overlay = restrictions.permissions ? new ProfilePermissionEngine(base, restrictions.permissions) : base;
  if (!restrictions.readOnly) return overlay;
  const readOnlyGate = new SafeCommandPermissionEngine(new ModePermissionEngine());
  return {
    check(request) {
      if (!request.metadata.readOnly && request.toolName !== "TodoWrite") {
        const ruling = readOnlyGate.check({ ...request, mode: "plan" });
        if (ruling.decision === "deny") return ruling;
        const inherited = overlay.check(request);
        return ruling.resolvedCommand !== undefined && inherited.decision === "allow"
          ? { ...inherited, resolvedCommand: ruling.resolvedCommand } : inherited;
      }
      return overlay.check(request);
    },
  };
}
