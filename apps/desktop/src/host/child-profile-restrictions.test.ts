import { describe, expect, it } from "vitest";
import { createDefaultToolRegistry, ModePermissionEngine, PERSONAS, sessionRestrictionsForPersona } from "@anycode/core";
import { restrictChildPermissions, restrictChildRegistry } from "./child-profile-restrictions.js";

describe("child profile restrictions", () => {
  it("leaves unrestricted sessions able to use existing and later-registered tools", () => {
    const registry = createDefaultToolRegistry();
    const restrictions = sessionRestrictionsForPersona(PERSONAS["general-purpose"], true);
    expect(restrictions).toBeNull();
    restrictChildRegistry(registry, restrictions ?? undefined);
    expect(registry.has("Skill")).toBe(true);
    const source = registry.get("Read")!;
    for (const name of ["BrowserOpen", "mcp__server__tool", "BashOutput"]) {
      registry.register({ ...source, metadata: { ...source.metadata, name } });
      expect(registry.has(name)).toBe(true);
    }
  });
  it("limits explore tools regardless of the inherited mode", () => {
    const registry = createDefaultToolRegistry();
    restrictChildRegistry(registry, { tools: PERSONAS.explore.tools, readOnly: true });
    expect(registry.list()).toEqual([...PERSONAS.explore.tools]);
    for (const name of ["Write", "Edit", "Bash"]) expect(registry.has(name)).toBe(false);
    registry.register(createDefaultToolRegistry().get("Write")!);
    expect(registry.has("Write")).toBe(false);
  });

  it("removes spawn tools from explicit child tool lists", () => {
    const registry = createDefaultToolRegistry();
    restrictChildRegistry(registry, { tools: ["Read", "Agent", "Workflow"], readOnly: false });
    expect(registry.list()).toEqual(["Read"]);
    registry.register(createDefaultToolRegistry().get("Agent")!);
    expect(registry.has("Agent")).toBe(false);
  });

  it("enforces read-only writes and commands even in yolo mode", () => {
    const registry = createDefaultToolRegistry();
    const engine = restrictChildPermissions(new ModePermissionEngine(), { tools: ["Write", "Edit", "Bash"], readOnly: true });
    for (const [toolName, input] of [["Write", { file_path: "/tmp/a", content: "x" }], ["Edit", { file_path: "/tmp/a" }], ["Bash", { command: "touch /tmp/a" }]] as const) {
      expect(engine.check({ toolName, input, metadata: registry.getMetadata(toolName)!, mode: "yolo" }).decision).toBe("deny");
    }
  });

  it("allows reviewer commands through the inherited permission engine", () => {
    const restrictions = sessionRestrictionsForPersona(PERSONAS.reviewer)!;
    expect(restrictions.readOnly).toBe(true);
    expect(restrictions.allowBash).toBe(true);
    const registry = createDefaultToolRegistry();
    restrictChildRegistry(registry, restrictions);
    expect(registry.has("Write")).toBe(false);
    const engine = restrictChildPermissions(new ModePermissionEngine(), restrictions);
    expect(engine.check({ toolName: "Bash", input: { command: "pnpm test" }, metadata: registry.getMetadata("Bash")!, mode: "yolo" }).decision).toBe("allow");
    expect(engine.check({ toolName: "Write", input: { file_path: "/tmp/a", content: "x" }, metadata: createDefaultToolRegistry().getMetadata("Write")!, mode: "yolo" }).decision).toBe("deny");
  });

  it("applies the profile deny overlay to the inherited engine", () => {
    const registry = createDefaultToolRegistry();
    const engine = restrictChildPermissions(new ModePermissionEngine(), { tools: ["Write"], readOnly: false, permissions: { allow: [], deny: [{ toolName: "Write" }] } });
    expect(engine.check({ toolName: "Write", input: { file_path: "/tmp/a" }, metadata: registry.getMetadata("Write")!, mode: "yolo" }).decision).toBe("deny");
  });
});
