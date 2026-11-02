import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { NodeFileSystemAdapter } from "../adapters/node/node-file-system.js";
import { resolveWorkspaceWriteFacts } from "../util/path-containment.js";
import { writeTool } from "../tools/index.js";
import { ModePermissionEngine } from "./engine.js";
import { RuleAwarePermissionEngine, SessionPermissionRules } from "./rules.js";
import { resolveWriteMask } from "./write-mask-node.js";
import { isValidWriteMask } from "./write-mask.js";

describe("absolute write masks", () => {
  it("rejects broad and relative masks", () => {
    for (const mask of ["/", "/**", "/Users/**", "/tmp/**", "/private/tmp/**", "~/a/**", "foo/**", `${homedir()}/**`]) {
      expect(isValidWriteMask(mask, homedir()), mask).toBe(false);
    }
    expect(isValidWriteMask("/private/tmp/project/**", homedir())).toBe(true);
  });

  it("rejects filesystem aliases of broad directories", async () => {
    const dir = await mkdtemp(join(await realpath("/tmp"), "mask-alias-"));
    try {
      await symlink(homedir(), join(dir, "home"));
      await symlink(await realpath("/tmp"), join(dir, "tmp"));
      expect(resolveWriteMask(`${dir}/home/**`)).toBeUndefined();
      expect(resolveWriteMask(`${dir}/tmp/**`)).toBeUndefined();
      expect(resolveWriteMask(`/System/Volumes/Data${homedir()}/**`)).toBeUndefined();
      expect(resolveWriteMask("/System/Volumes/Data/private/tmp/**")).toBeUndefined();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("matches the resolved target within a chosen directory and rejects sibling and symlink escapes", async () => {
    const dir = await realpath(await mkdtemp(join(await realpath("/tmp"), "write-mask-")));
    try {
      const ws = join(dir, "workspace"), allowed = join(dir, "a"), sibling = join(dir, "abc");
      await Promise.all([mkdir(ws), mkdir(allowed), mkdir(sibling)]);
      await symlink(sibling, join(allowed, "escape"));
      const rules = new SessionPermissionRules();
      rules.add({ toolName: "Write", pattern: `${allowed}/**` });
      const engine = new RuleAwarePermissionEngine(new ModePermissionEngine(), rules);
      const check = async (target: string) => {
        const workspace = await resolveWorkspaceWriteFacts(new NodeFileSystemAdapter(), ws, target);
        const request = { toolName: "Write", input: { file_path: target, content: "x" }, metadata: writeTool.metadata, mode: "build" as const, workspace };
        expect(rules.matchesRequest(request)).toBe(engine.check(request).decision === "allow");
        return engine.check(request).decision;
      };
      expect(await check(join(allowed, "new.txt"))).toBe("allow");
      expect(await check(join(allowed, ".env"))).toBe("allow");
      rules.add({ toolName: "Edit", pattern: `${allowed.replace(/^\/private\/tmp\//, "/tmp/")}/**` });
      const aliasRequest = { toolName: "Edit", input: { file_path: join(allowed, "alias.txt") }, metadata: writeTool.metadata, mode: "build" as const, workspace: await resolveWorkspaceWriteFacts(new NodeFileSystemAdapter(), ws, join(allowed, "alias.txt")) };
      expect(engine.check(aliasRequest).decision).toBe("allow");
      expect(await check(join(sibling, "new.txt"))).toBe("ask");
      expect(await check(join(allowed, "escape", "new.txt"))).toBe("ask");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
