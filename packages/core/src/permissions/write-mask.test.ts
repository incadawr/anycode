import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { NodeFileSystemAdapter } from "../adapters/node/node-file-system.js";
import { resolveWorkspaceWriteFacts } from "../util/path-containment.js";
import { writeTool } from "../tools/index.js";
import { ModePermissionEngine } from "./engine.js";
import { RuleAwarePermissionEngine, SessionPermissionRules } from "./rules.js";
import { isValidWriteMask } from "./write-mask.js";

describe("absolute write masks", () => {
  it("rejects broad and relative masks", () => {
    for (const mask of ["/", "/**", "/Users/**", "/tmp/**", "/private/tmp/**", "~/a/**", "foo/**", `${homedir()}/**`]) {
      expect(isValidWriteMask(mask, homedir()), mask).toBe(false);
    }
    expect(isValidWriteMask("/private/tmp/project/**", homedir())).toBe(true);
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
      expect(await check(join(sibling, "new.txt"))).toBe("ask");
      expect(await check(join(allowed, "escape", "new.txt"))).toBe("ask");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
