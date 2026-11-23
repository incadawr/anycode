import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { NodeExecutionAdapter } from "../adapters/node/node-execution.js";
import { NodeFileSystemAdapter } from "../adapters/node/node-file-system.js";
import { NodeHttpAdapter } from "../adapters/node/node-http.js";
import { executeToolCall, type DispatchContext } from "../dispatch/dispatcher.js";
import { InMemoryHookRunner } from "../dispatch/hook-runner.js";
import { DenyPermissionBroker, ModePermissionEngine } from "../permissions/index.js";
import { createDefaultToolRegistry } from "../tools/registry.js";
import { InMemoryTodoStore } from "../tools/todo-store.js";
import { buildSystemPrompt, renderToolDisciplineSection } from "./system.js";

// Fixed independently from Appendix A of the v2 design.
const descriptionHash = "50988640d41e036a3f711c061bdcffd783a54984d6ff95c16ad582716efd4c08";
const discipline = [
  "Use REPL when one tool call needs another's result. For example, search with Grep and read the matching files in one script.",
  "Return only what you need. Call standalone tools directly.",
].join("\n");

it("appendixABytesAndExamples", async () => {
  const registry = createDefaultToolRegistry({ codeMode: true });
  const description = registry.getMetadata("REPL")!.description;
  expect(createHash("sha256").update(description, "utf8").digest("hex")).toBe(descriptionHash);
  expect(renderToolDisciplineSection(registry.list()).split("\n\n").at(-1)).toBe(discipline);
  expect(buildSystemPrompt({ toolNames: registry.list() })).toContain("\n\n" + discipline);
  registry.restrictTo(["Read", "Edit", "Bash", "Glob", "Grep", "REPL"]);

  const cwd = await realpath(await mkdtemp(join(tmpdir(), "anycode-repl-appendix-")));
  try {
    await mkdir(join(cwd, "packages", "one"), { recursive: true });
    await writeFile(join(cwd, "package.json"), JSON.stringify({
      scripts: { test: "node retry.cjs" },
    }));
    await writeFile(join(cwd, "packages", "one", "package.json"), '{"name":"fixture-one"}');
    await writeFile(join(cwd, "retry.js"), "export const retryLimit = 3;\n");
    await writeFile(join(cwd, "retry.cjs"), "console.log('fixture test failure'); process.exitCode = 1;\n");
    const ctx: DispatchContext = {
      cwd, registry, mode: "yolo",
      hooks: new InMemoryHookRunner(),
      permissionEngine: new ModePermissionEngine(),
      permissionBroker: new DenyPermissionBroker(),
      ports: {
        fs: new NodeFileSystemAdapter(), exec: new NodeExecutionAdapter(),
        http: new NodeHttpAdapter(), todos: new InMemoryTodoStore(),
      },
    };
    const [editExample, listExample] = description.split("\n\n").slice(-2) as [string, string];
    const edit = await executeToolCall(ctx, { id: "edit", name: "REPL", input: { code: editExample } });
    expect(edit.status).toBe("success");
    expect(edit.modelText).toContain('"exitCode": 1');
    expect(edit.modelText).toContain("fixture test failure");
    expect(edit.modelText).toContain('effects: Edit retry.js (1); Bash "npm test -- retry" exit 1');
    expect(await readFile(join(cwd, "retry.js"), "utf8")).toBe("export const retryLimit = 5;\n");

    const list = await executeToolCall(ctx, { id: "list", name: "REPL", input: { code: listExample } });
    expect(list.status).toBe("success");
    expect(JSON.parse(list.modelText)).toEqual(["fixture-one"]);
    registry.restrictTo(["Read", "Edit", "Bash", "Glob", "Grep"]);
    expect(renderToolDisciplineSection(registry.list())).not.toContain(discipline);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 15_000);
