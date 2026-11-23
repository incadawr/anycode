import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { NodeFileSystemAdapter } from "../adapters/node/node-file-system.js";
import { buildSystemPrompt } from "../prompts/system.js";
import { loadCodeModeEnabled } from "./arch-map.js";
import { createDefaultToolRegistry } from "./registry.js";
import { toToolDeclarations } from "./to-model-tools.js";

it.each([undefined, { codeMode: false }])("offMatchesMasterBytes (%j)", options => {
  const registry = createDefaultToolRegistry(options);
  const prompt = buildSystemPrompt({
    toolNames: registry.list(),
    env: {
      workingDirectory: "/workspace/project",
      platform: "linux",
      date: "2026-07-04",
      modelId: "fixture-model",
      isGitRepo: true,
    },
  });
  const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
  // Prompt bytes are the 8c142da3013d019dd9717b854e6805ddcedd98c7 baseline.
  expect(sha256(prompt)).toBe("17db8be464ddef15210713883b91b42da2b972f54f1efdcb03cdc997aa99d787");
  // Declaration bytes with Code Mode off on next 532b8860b (Bash timeout hint). Earlier pin predated that description change.
  expect(sha256(JSON.stringify(toToolDeclarations(registry))))
    .toBe("7d63866544aca52be9ab6e98a7fdfd7040e30020f3acb155a52a34388cafcbb7");
});

it("uses strict environment values and reads only user settings", async () => {
  const fs = new NodeFileSystemAdapter();
  const userPath = "/home/test/.anycode/settings.json";
  const projectPath = "/workspace/project/.anycode/settings.json";
  const files = new Map([[projectPath, '{"tools":{"codeMode":true}}']]);
  const readFile = vi.spyOn(fs, "readFile").mockImplementation(async (path) => {
    const text = files.get(path);
    if (text === undefined) throw new Error("missing settings");
    return text;
  });
  const enabled = (override?: string) => loadCodeModeEnabled(fs, userPath, {
    ANYCODE_EXPERIMENTAL_CODE_MODE: override,
  });

  expect(await enabled()).toBe(false);
  expect(readFile.mock.calls).toEqual([[userPath]]);
  files.set(userPath, '{"tools":{"codeMode":false}}');
  expect(await enabled("1")).toBe(true);
  expect(await enabled()).toBe(false);
  files.set(userPath, '{"tools":{"codeMode":true}}');
  expect(await enabled("0")).toBe(false);
  expect(await enabled("true")).toBe(false);
  expect(await enabled("")).toBe(false);
  expect(await enabled()).toBe(true);
  files.set(userPath, '{"tools":{"codeMode":"true"}}');
  expect(await enabled()).toBe(false);
  files.set(userPath, "{bad-json");
  expect(await enabled()).toBe(false);
  expect(readFile.mock.calls.every(([path]) => path === userPath)).toBe(true);
});
