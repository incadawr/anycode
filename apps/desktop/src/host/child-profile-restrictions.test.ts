import { describe, expect, it } from "vitest";
import { createDefaultToolRegistry, ModePermissionEngine, PERSONAS } from "@anycode/core";
import { restrictChildPermissions, restrictChildRegistry } from "./child-profile-restrictions.js";

describe("child profile restrictions", () => {
  it("limits explore tools regardless of the inherited mode", () => {
    const registry = createDefaultToolRegistry();
    restrictChildRegistry(registry, { tools: PERSONAS.explore.tools, readOnly: true });
    expect(registry.list()).toEqual([...PERSONAS.explore.tools]);
    for (const name of ["Write", "Edit", "Bash"]) expect(registry.has(name)).toBe(false);
    registry.register(createDefaultToolRegistry().get("Write")!);
    expect(registry.has("Write")).toBe(false);
  });

  it("enforces read-only writes and commands even in yolo mode", () => {
    const registry = createDefaultToolRegistry();
    const engine = restrictChildPermissions(new ModePermissionEngine(), { tools: ["Write", "Edit", "Bash"], readOnly: true });
    for (const [toolName, input] of [["Write", { file_path: "/tmp/a", content: "x" }], ["Edit", { file_path: "/tmp/a" }], ["Bash", { command: "touch /tmp/a" }]] as const) {
      expect(engine.check({ toolName, input, metadata: registry.getMetadata(toolName)!, mode: "yolo" }).decision).toBe("deny");
    }
  });

  it("applies the profile deny overlay to the inherited engine", () => {
    const registry = createDefaultToolRegistry();
    const engine = restrictChildPermissions(new ModePermissionEngine(), { tools: ["Write"], readOnly: false, permissions: { allow: [], deny: [{ toolName: "Write" }] } });
    expect(engine.check({ toolName: "Write", input: { file_path: "/tmp/a" }, metadata: registry.getMetadata("Write")!, mode: "yolo" }).decision).toBe("deny");
  });
});
