import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function createRolesSmokeDirs() {
  return {
    profile: mkdtempSync(join(tmpdir(), "anycode-roles-smoke-")),
    workspace: mkdtempSync(join(tmpdir(), "anycode-roles-workspace-")),
  };
}
