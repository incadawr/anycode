import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { claudeProjectFolderName, findClaudeSubagentTranscript, readClaudeSubagentTranscript } from "./subagent-transcript.js";

const SESSION = "17e9a91c-e601-4b56-9437-53736967a09c";
const jsonl = (text: string) => JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }) + "\n";

async function fixture(): Promise<{ root: string; dir: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "subagent-transcript-")));
  const dir = join(root, "-proj", SESSION, "subagents");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "agent-aaa.meta.json"), JSON.stringify({ agentType: "Explore", toolUseId: "toolu_one" }));
  await writeFile(join(dir, "agent-aaa.jsonl"), jsonl("first") + jsonl("second"));
  await writeFile(join(dir, "agent-bbb.meta.json"), JSON.stringify({ toolUseId: "toolu_two" }));
  await writeFile(join(dir, "agent-bbb.jsonl"), jsonl("other"));
  return { root, dir };
}

describe("Claude subagent transcript read (host)", () => {
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
      const result = await readClaudeSubagentTranscript({ sessionRef: SESSION, toolCallId: "toolu_one" }, { roots: [root] });
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
      const result = await readClaudeSubagentTranscript({ sessionRef: SESSION, toolCallId: "toolu_one" }, { roots: [root] });
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
      expect(await readClaudeSubagentTranscript({ sessionRef: "../etc", toolCallId: "toolu_one" }, { roots: [root] })).toEqual({ ok: false, reason: "unavailable" });
      expect(await readClaudeSubagentTranscript({ sessionRef: SESSION, toolCallId: "a/b" }, { roots: [root] })).toEqual({ ok: false, reason: "unavailable" });
      expect(await readClaudeSubagentTranscript({ sessionRef: SESSION, toolCallId: "toolu_nope", extra: 1 }, { roots: [root] })).toEqual({ ok: false, reason: "unavailable" });
      expect(await readClaudeSubagentTranscript({ sessionRef: SESSION, toolCallId: "toolu_nope" }, { roots: [root] })).toEqual({ ok: false, reason: "not_found" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("does not follow a symlinked transcript file", async () => {
    const { root, dir } = await fixture();
    try {
      await rm(join(dir, "agent-aaa.jsonl"));
      const outside = join(root, "outside.jsonl");
      await writeFile(outside, jsonl("secret"));
      await symlink(outside, join(dir, "agent-aaa.jsonl"));
      expect(await readClaudeSubagentTranscript({ sessionRef: SESSION, toolCallId: "toolu_one" }, { roots: [root] })).toEqual({ ok: false, reason: "unavailable" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("builds the project folder from the cwd (non-alphanumerics become '-') and prefers it over a scan", async () => {
    expect(claudeProjectFolderName("/private/tmp/anycode-fixed-smoke.QBv4Yc/project")).toBe("-private-tmp-anycode-fixed-smoke-QBv4Yc-project");
    const { root, dir } = await fixture();
    try {
      // The same tool id under another project must not be consulted when the cwd names the right one.
      const other = join(root, "-other", SESSION, "subagents");
      await mkdir(other, { recursive: true });
      await writeFile(join(other, "agent-zzz.meta.json"), JSON.stringify({ toolUseId: "toolu_one" }));
      await writeFile(join(other, "agent-zzz.jsonl"), jsonl("elsewhere"));
      expect(await findClaudeSubagentTranscript([root], SESSION, "toolu_one", "/proj")).toBe(join(dir, "agent-aaa.jsonl"));
      // A wrong cwd falls back to the scan, which now sees two matches and refuses.
      expect(await findClaudeSubagentTranscript([root], SESSION, "toolu_one", "/nowhere")).toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("de-duplicates roots by realpath and accepts a symlinked projects root", async () => {
    const { root } = await fixture();
    const holder = await mkdtemp(join(tmpdir(), "subagent-link-"));
    try {
      const link = join(holder, "projects");
      await symlink(root, link);
      const found = await findClaudeSubagentTranscript([root, link, root], SESSION, "toolu_one", "/proj");
      expect(found).toBeDefined();
      const result = await readClaudeSubagentTranscript({ sessionRef: SESSION, toolCallId: "toolu_one" }, { roots: [link, root] });
      expect(result.ok).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); await rm(holder, { recursive: true, force: true }); }
  });

  it("caches the resolved path per session and tool call", async () => {
    const { root, dir } = await fixture();
    try {
      const cache = new Map<string, string>();
      await readClaudeSubagentTranscript({ sessionRef: SESSION, toolCallId: "toolu_one" }, { roots: [root], cache });
      expect(cache.get(`${SESSION}\0toolu_one`)).toBe(join(dir, "agent-aaa.jsonl"));
      // Removing the meta no longer matters once cached.
      await rm(join(dir, "agent-aaa.meta.json"));
      const again = await readClaudeSubagentTranscript({ sessionRef: SESSION, toolCallId: "toolu_one" }, { roots: [root], cache });
      expect(again.ok).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("never labels the first entry of a mid-file tail window as the prompt", async () => {
    const { root, dir } = await fixture();
    try {
      const user = (text: string) => JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n";
      await writeFile(join(dir, "agent-aaa.jsonl"), user("the real prompt") + jsonl("x".repeat(2_200_000)) + user("follow up") + jsonl("done"));
      const result = await readClaudeSubagentTranscript({ sessionRef: SESSION, toolCallId: "toolu_one" }, { roots: [root] });
      expect(result.ok && result.truncatedHead).toBe(true);
      if (result.ok) expect(result.entries.map((e) => e.kind)).toEqual(["message", "text"]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
