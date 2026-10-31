import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { runClaudeDoctor } from "./claude-doctor.js";
import { runCodexDoctor } from "./codex-doctor.js";

type Frame = Record<string, any>;
function startFixture(name: string, home: string) {
  const path = fileURLToPath(new URL(`../../scripts/compact-fixtures/${name}.mjs`, import.meta.url));
  const child: ChildProcessWithoutNullStreams = spawn(path, [], { env: { ...process.env, HOME: home } });
  const frames: Frame[] = [];
  createInterface({ input: child.stdout }).on("line", line => frames.push(JSON.parse(line) as Frame));
  return { child, frames, send: (frame: Frame) => child.stdin.write(`${JSON.stringify(frame)}\n`) };
}

describe("native engine smoke fixtures", () => {
  it("both fixtures pass the real engine readiness checks", async () => {
    const home = mkdtempSync(join(tmpdir(), "compact-doctor-fixture-"));
    const env = { HOME: home, PATH: process.env.PATH, CODEX_HOME: home };
    try {
      const claude = fileURLToPath(new URL("../../scripts/compact-fixtures/claude.mjs", import.meta.url));
      const codex = fileURLToPath(new URL("../../scripts/compact-fixtures/codex.mjs", import.meta.url));
      expect((await runClaudeDoctor(claude, { env, profileDir: home })).status).toBe("ready");
      expect((await runCodexDoctor(codex, { env })).status).toBe("ready");
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 15_000);

  it("Claude fixture handles initialization, compact and a controllably held turn", async () => {
    const home = mkdtempSync(join(tmpdir(), "compact-fixture-test-"));
    const f = startFixture("claude", home);
    try {
      f.send({ type: "control_request", request_id: "init", request: { subtype: "initialize" } });
      await vi.waitFor(() => expect(f.frames[0]?.response?.response?.account?.tokenSource).toBe("oauth"));
      f.send({ type: "user", message: { role: "user", content: "/compact" } });
      await vi.waitFor(() => expect(f.frames.some(frame => frame.type === "result")).toBe(true));
      f.send({ type: "user", message: { role: "user", content: "fixture: hold" } });
      await vi.waitFor(() => expect(readFileSync(join(home, "claude-frames.jsonl"), "utf8").trim().split("\n")).toHaveLength(2));
      expect(f.frames.filter(frame => frame.type === "result")).toHaveLength(1);
      writeFileSync(join(home, "release-claude"), "release");
      await vi.waitFor(() => expect(f.frames.filter(frame => frame.type === "result")).toHaveLength(2));
    } finally { f.child.kill(); rmSync(home, { recursive: true, force: true }); }
  });

  it("Codex fixture opens a thread and records the held turn", async () => {
    const home = mkdtempSync(join(tmpdir(), "compact-fixture-test-"));
    const f = startFixture("codex", home);
    try {
      f.send({ id: 1, method: "thread/start", params: {} });
      f.send({ id: 2, method: "turn/start", params: { threadId: "fixture-thread", input: [{ type: "text", text: "fixture: hold" }] } });
      await vi.waitFor(() => expect(f.frames.find(frame => frame.id === 2)?.result?.turn?.status).toBe("inProgress"));
      expect(f.frames.find(frame => frame.id === 1)?.result?.thread?.id).toBe("fixture-thread");
      expect(readFileSync(join(home, "codex-turns.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
    } finally { f.child.kill(); rmSync(home, { recursive: true, force: true }); }
  });
});


describe("Codex compact fixture lifecycle", () => {
  it("Codex fixture completes and interrupts native compact without creating chat turns", async () => {
    const home = mkdtempSync(join(tmpdir(), "compact-lifecycle-fixture-")); const f = startFixture("codex", home);
    try {
      f.send({ id: 1, method: "thread/compact/start", params: { threadId: "fixture-thread" } });
      await vi.waitFor(() => expect(f.frames.find(frame => frame.id === 1)?.result).toEqual({}));
      expect(f.frames.find(frame => frame.method === "turn/started")?.params.turn.id).toBe("fixture-compact-1");
      writeFileSync(join(home, "release-codex-compact-1"), "release");
      await vi.waitFor(() => expect(f.frames.find(frame => frame.method === "turn/completed")?.params.turn.status).toBe("completed"));
      expect(f.frames.find(frame => frame.method === "thread/tokenUsage/updated")?.params.tokenUsage.last.totalTokens).toBe(8000);
      expect(f.frames.find(frame => frame.method === "item/completed")?.params.item.type).toBe("contextCompaction");
      f.send({ id: 2, method: "thread/compact/start", params: { threadId: "fixture-thread" } });
      await vi.waitFor(() => expect(f.frames.find(frame => frame.id === 2)?.result).toEqual({}));
      f.send({ id: 3, method: "turn/interrupt", params: { threadId: "fixture-thread", turnId: "fixture-compact-2" } });
      await vi.waitFor(() => expect(f.frames.filter(frame => frame.method === "turn/completed").at(-1)?.params.turn.status).toBe("interrupted"));
      expect(f.frames.find(frame => frame.id === 3)?.result).toEqual({});
      expect(readFileSync(join(home, "codex-rpcs.jsonl"), "utf8")).not.toContain('"method":"turn/start"');
    } finally { f.child.kill(); rmSync(home, { recursive: true, force: true }); }
  });
});
