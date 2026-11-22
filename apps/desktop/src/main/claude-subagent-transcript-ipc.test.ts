import { describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
vi.mock("electron", () => ({ ipcMain: {} }));
import { findClaudeSubagentTranscript, readClaudeSubagentTranscript } from "./claude-subagent-transcript-ipc.js";

const SESSION = "17e9a91c-e601-4b56-9437-53736967a09c";
const jsonl = (text: string) => JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }) + "\n";

async function fixture(): Promise<{ root: string; dir: string }> {
  const root = await mkdtemp(join(tmpdir(), "subagent-transcript-"));
  const dir = join(root, "-proj", SESSION, "subagents");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "agent-aaa.meta.json"), JSON.stringify({ agentType: "Explore", toolUseId: "toolu_one" }));
  await writeFile(join(dir, "agent-aaa.jsonl"), jsonl("first") + jsonl("second"));
  await writeFile(join(dir, "agent-bbb.meta.json"), JSON.stringify({ toolUseId: "toolu_two" }));
  await writeFile(join(dir, "agent-bbb.jsonl"), jsonl("other"));
  return { root, dir };
}

describe("Claude subagent transcript read", () => {
  it("maps the card's tool call id to its agent file through the sibling meta.json", async () => {
    const { root, dir } = await fixture();
    try {
      expect(await findClaudeSubagentTranscript([root], SESSION, "toolu_one")).toBe(join(dir, "agent-aaa.jsonl"));
      expect(await findClaudeSubagentTranscript([root], SESSION, "toolu_two")).toBe(join(dir, "agent-bbb.jsonl"));
      expect(await findClaudeSubagentTranscript([root], SESSION, "toolu_missing")).toBeUndefined();
      expect(await findClaudeSubagentTranscript([root], "other-session", "toolu_one")).toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("returns parsed entries for a matching agent", async () => {
    const { root } = await fixture();
    try {
      const result = await readClaudeSubagentTranscript({ sessionRef: SESSION, toolCallId: "toolu_one" }, [root]);
      expect(result).toEqual({
        ok: true,
        droppedEntries: 0,
        truncatedHead: false,
        entries: [{ kind: "text", title: "", text: "first" }, { kind: "text", title: "", text: "second" }],
      });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("reads only the bounded tail of a huge file and drops the partial first line", async () => {
    const { root, dir } = await fixture();
    try {
      await writeFile(join(dir, "agent-aaa.jsonl"), jsonl("x".repeat(1_500_000)) + jsonl("middle") + jsonl("y".repeat(1_500_000)) + jsonl("last"));
      const result = await readClaudeSubagentTranscript({ sessionRef: SESSION, toolCallId: "toolu_one" }, [root]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.truncatedHead).toBe(true);
        expect(result.entries.at(-1)?.text).toBe("last");
        expect(result.entries.some((e) => e.text === "x".repeat(1_500_000))).toBe(false);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects malformed ids (path traversal) and reports unknown agents as not_found", async () => {
    const { root } = await fixture();
    try {
      expect(await readClaudeSubagentTranscript({ sessionRef: "../etc", toolCallId: "toolu_one" }, [root])).toEqual({ ok: false, reason: "unavailable" });
      expect(await readClaudeSubagentTranscript({ sessionRef: SESSION, toolCallId: "a/b" }, [root])).toEqual({ ok: false, reason: "unavailable" });
      expect(await readClaudeSubagentTranscript({ sessionRef: SESSION, toolCallId: "toolu_nope", extra: 1 }, [root])).toEqual({ ok: false, reason: "unavailable" });
      expect(await readClaudeSubagentTranscript({ sessionRef: SESSION, toolCallId: "toolu_nope" }, [root])).toEqual({ ok: false, reason: "not_found" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("does not follow a symlinked transcript file", async () => {
    const { root, dir } = await fixture();
    try {
      await rm(join(dir, "agent-aaa.jsonl"));
      const outside = join(root, "outside.jsonl");
      await writeFile(outside, jsonl("secret"));
      await symlink(outside, join(dir, "agent-aaa.jsonl"));
      expect(await readClaudeSubagentTranscript({ sessionRef: SESSION, toolCallId: "toolu_one" }, [root])).toEqual({ ok: false, reason: "unavailable" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
