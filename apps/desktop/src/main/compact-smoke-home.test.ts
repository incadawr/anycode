import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("compact smoke home isolation", () => {
  it("launches the smoke environment with an isolated host home despite ambient overrides", () => {
    const script = fileURLToPath(new URL("../../scripts/compact-submit-ui-smoke.mjs", import.meta.url));
    const child = spawnSync(process.execPath, [script, "--check-isolation"], {
      env: { ...process.env, HOME: "/owner", ANYCODE_COMMUNICATION_CONFIG: "/owner/communication.json", ANYCODE_PROFILE_HOME: "/owner", ANYCODE_MCP_IMPORT_HOME: "/owner", ANYCODE_SUBAGENTS_HOME: "/owner", ANYCODE_SKILLS_IMPORT_HOME: "/owner", ANYCODE_CODEX_PROFILES_HOME: "/owner" }, encoding: "utf8",
    });
    expect(child.status).toBe(0);
    expect(child.stdout).toContain("isolation verified");
  });
});
