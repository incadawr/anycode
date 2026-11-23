import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  buildSystemPrompt,
  ConversationHistory,
  NodeFileSystemAdapter,
  SqlitePersistenceAdapter,
  WriteBehindHistorySink,
} from "@anycode/core";
import { createNativeBootRegistry, repairDanglingToolCalls } from "./boot.js";

it("rootOnlyAndRepairBeforeGenericPass", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "anycode-desktop-repl-boot-"));
  const persistence = new SqlitePersistenceAdapter(":memory:");
  try {
    await persistence.createSession({ id: "root", workspace, model: "fixture", mode: "build" });
    const meta = (await persistence.getRootSession("root"))!;
    const child = { parentSessionId: "parent", spawnToolCallId: "spawn", initialMode: "build" as const };
    const fs = new NodeFileSystemAdapter();
    const settings = join(workspace, "settings.json");
    await writeFile(settings, '{"tools":{"codeMode":true}}');
    for (const experimental of ["1", "0", undefined]) {
      const env = { ANYCODE_EXPERIMENTAL_CODE_MODE: experimental };
      const rootArgs = { resume: true };
      const root = await createNativeBootRegistry(fs, settings, env, rootArgs, meta);
      expect(root.has("REPL")).toBe(experimental !== "0");
      const childRegistry = await createNativeBootRegistry(fs, settings, env, { ...rootArgs, child }, meta);
      expect(childRegistry.has("REPL")).toBe(false);
      const resumedChild = await createNativeBootRegistry(fs, settings, env, rootArgs, {
        ...meta, parentSessionId: "parent",
      });
      expect(resumedChild.has("REPL")).toBe(false);

      const prompt = () => buildSystemPrompt({ toolNames: root.list() });
      const discipline = "Use REPL when one tool call";
      expect(prompt().includes(discipline)).toBe(experimental !== "0");
      root.restrictTo(["Read"]);
      expect(prompt()).not.toContain(discipline);
    }
    const unconfigured = await createNativeBootRegistry(fs, join(workspace, "missing"), {}, { resume: false }, meta);
    expect(unconfigured.has("REPL")).toBe(false);

    const sink = new WriteBehindHistorySink(persistence, meta.id);
    const beforeCrash = new ConversationHistory({ sink });
    beforeCrash.append({ role: "assistant", content: [
      { type: "tool_call", toolCallId: "complete", toolName: "REPL", input: { code: "return true" } },
      { type: "tool_call", toolCallId: "ordinary", toolName: "Read", input: { file_path: "note.txt" } },
      { type: "tool_call", toolCallId: "interrupted", toolName: "REPL", input: { code: "return false" } },
    ] }, { turnId: "turn-before-crash", step: 1 });
    beforeCrash.append({ role: "tool", content: [
      { type: "tool_result", toolCallId: "complete", toolName: "REPL", status: "success", text: "true" },
    ] });
    await beforeCrash.flushChecked();

    const resumed = new ConversationHistory({ initial: await persistence.loadHistory(meta.id), sink });
    expect(await repairDanglingToolCalls(resumed, sink)).toBe(2);
    const persisted = await persistence.loadHistory(meta.id);
    expect(persisted.slice(2)).toMatchObject([
      { turnId: "turn-before-crash", step: 1, message: { role: "tool", content: [{
        toolCallId: "interrupted", status: "cancelled", text: expect.stringContaining("Some actions may have completed"),
      }] } },
      { message: { role: "tool", content: [{
        toolCallId: "ordinary", status: "cancelled", text: "Tool Read was cancelled before it produced a result.",
      }] } },
    ]);
    const clean = new ConversationHistory({ initial: persisted, sink });
    expect(await repairDanglingToolCalls(clean, sink)).toBe(0);
    expect(await persistence.loadHistory(meta.id)).toEqual(persisted);
    expect(await repairDanglingToolCalls(new ConversationHistory(), sink)).toBe(0);
  } finally {
    await persistence.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

it("restores an interrupted REPL pair after reopening the SQLite file on a new connection", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "anycode-desktop-repl-reopen-"));
  const file = join(workspace, "history.sqlite");
  const first = new SqlitePersistenceAdapter(file);
  try {
    await first.createSession({ id: "root", workspace, model: "fixture", mode: "build" });
    const sink = new WriteBehindHistorySink(first, "root");
    const history = new ConversationHistory({ sink });
    history.append({ role: "assistant", content: [
      { type: "tool_call", toolCallId: "complete", toolName: "REPL", input: { code: "return true" } },
      { type: "tool_call", toolCallId: "ordinary", toolName: "Read", input: { file_path: "note.txt" } },
      { type: "tool_call", toolCallId: "interrupted", toolName: "REPL", input: { code: "return false" } },
    ] }, { turnId: "turn-before-crash", step: 1 });
    history.append({ role: "tool", content: [
      { type: "tool_result", toolCallId: "complete", toolName: "REPL", status: "success", text: "true" },
    ] });
    await history.flushChecked();
  } finally {
    await first.close();
  }

  const reopened = new SqlitePersistenceAdapter(file);
  try {
    const sink = new WriteBehindHistorySink(reopened, "root");
    const resumed = new ConversationHistory({ initial: await reopened.loadHistory("root"), sink });
    expect(await repairDanglingToolCalls(resumed, sink)).toBe(2);
  } finally {
    await reopened.close();
  }

  const fresh = new SqlitePersistenceAdapter(file);
  try {
    const persisted = await fresh.loadHistory("root");
    expect(JSON.stringify(persisted).match(/Some actions may have completed/g)).toHaveLength(1);
    expect(persisted.slice(2)).toMatchObject([
      { message: { role: "tool", content: [{ toolCallId: "interrupted", status: "cancelled" }] } },
      { message: { role: "tool", content: [{ toolCallId: "ordinary", status: "cancelled" }] } },
    ]);
    const clean = new ConversationHistory({ initial: persisted, sink: new WriteBehindHistorySink(fresh, "root") });
    expect(await repairDanglingToolCalls(clean, new WriteBehindHistorySink(fresh, "root"))).toBe(0);
  } finally {
    await fresh.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
