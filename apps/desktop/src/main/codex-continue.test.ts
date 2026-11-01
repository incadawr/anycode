/** Synthetic copy fixtures and refusal-only continuation boundaries. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  copyCodexRolloutForThread,
  handleCodexContinueOnAccount,
  type CodexContinueDeps,
  registerCodexContinueIpc,
  CODEX_CONTINUE_CHANNEL,
} from "./codex-continue.js";

const THREAD_ID = "0199a1b2-3c4d-7e8f-9a0b-1c2d3e4f5a6b";
const ROLLOUT_RELATIVE = join("2026", "10", "30", `rollout-2026-10-30T10-00-00-${THREAD_ID}.jsonl`);
const ROLLOUT_TEXT = '{"type":"session_meta","payload":{"id":"' + THREAD_ID + '"}}\n';

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "anycode-codex-continue-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function seedRollout(sessionsDir: string, text = ROLLOUT_TEXT): Promise<string> {
  const path = join(sessionsDir, ROLLOUT_RELATIVE);
  await mkdir(join(sessionsDir, "2026", "10", "30"), { recursive: true });
  await writeFile(path, text);
  return path;
}

describe("copyCodexRolloutForThread", () => {
  it("copies the thread's rollout to the SAME relative path under the target home", async () => {
    const source = join(root, "account-a", "sessions");
    const target = join(root, "account-b", "sessions");
    const sourcePath = await seedRollout(source);

    const result = await copyCodexRolloutForThread({
      sourceSessionsDir: source,
      targetSessionsDir: target,
      threadId: THREAD_ID,
    });

    expect(result).toEqual({ ok: true, relativePath: ROLLOUT_RELATIVE, copied: true });
    const targetPath = join(target, ROLLOUT_RELATIVE);
    expect(await readFile(targetPath, "utf8")).toBe(ROLLOUT_TEXT);
    // The source is untouched (the exhausted tab keeps working).
    expect(await readFile(sourcePath, "utf8")).toBe(ROLLOUT_TEXT);
  });

  it("refuses when the thread has no rollout under the current account", async () => {
    await mkdir(join(root, "account-a", "sessions", "2026", "10", "30"), { recursive: true });
    const result = await copyCodexRolloutForThread({
      sourceSessionsDir: join(root, "account-a", "sessions"),
      targetSessionsDir: join(root, "account-b", "sessions"),
      threadId: THREAD_ID,
    });
    expect(result).toMatchObject({ ok: false, reason: "rollout_missing" });
  });

  it("never overwrites an existing rollout in the target home and reports it as already in place", async () => {
    const source = join(root, "account-a", "sessions");
    const target = join(root, "account-b", "sessions");
    await seedRollout(source);
    const existing = join(target, ROLLOUT_RELATIVE);
    await mkdir(join(target, "2026", "10", "30"), { recursive: true });
    await writeFile(existing, "OLDER-COPY");

    const result = await copyCodexRolloutForThread({
      sourceSessionsDir: source,
      targetSessionsDir: target,
      threadId: THREAD_ID,
    });

    expect(result).toEqual({ ok: true, relativePath: ROLLOUT_RELATIVE, copied: false });
    expect(await readFile(existing, "utf8")).toBe("OLDER-COPY");
  });

  it("copies the rollout only — a credential next to it is never copied (or read)", async () => {
    const source = join(root, "account-a", "sessions");
    const target = join(root, "account-b", "sessions");
    await seedRollout(source);
    await writeFile(join(root, "account-a", "auth.json"), '{"token":"secret"}');
    await mkdir(join(root, "account-b"), { recursive: true });
    await writeFile(join(root, "account-b", "auth.json"), '{"token":"other"}');

    await copyCodexRolloutForThread({ sourceSessionsDir: source, targetSessionsDir: target, threadId: THREAD_ID });

    expect(await readFile(join(root, "account-b", "auth.json"), "utf8")).toBe('{"token":"other"}');
  });

  it("refuses a thread id that is not a plain token (it is only ever used for matching, never as a path)", async () => {
    const result = await copyCodexRolloutForThread({
      sourceSessionsDir: join(root, "a"),
      targetSessionsDir: join(root, "b"),
      threadId: "../../etc/passwd",
    });
    expect(result).toMatchObject({ ok: false, reason: "rollout_missing" });
  });
});

describe("temporarily disabled continuation", () => {
  const refusal = {ok:false,reason:"temporarily_unavailable",detail:"Continuing this conversation on another account is temporarily unavailable. You can start a new session on another Codex account."};

  it("refuses the internal entry point without accessing any dependency or request field", async () => {
    const sentinel = new Proxy({}, {get: () => {throw new Error("dependency or request accessed");}});
    await expect(handleCodexContinueOnAccount(sentinel as CodexContinueDeps, sentinel as never)).resolves.toEqual(refusal);
  });

  it("registers the IPC handler and refuses every payload without reading it", () => {
    const handlers = new Map<string, () => unknown>();
    const handle = vi.fn((channel:string, listener:()=>unknown) => {handlers.set(channel,listener);});
    registerCodexContinueIpc({handle});
    expect(handle).toHaveBeenCalledOnce();
    const listener = handlers.get(CODEX_CONTINUE_CHANNEL);
    expect(listener).toBeDefined();
    const sentinel = new Proxy({}, {get: () => {throw new Error("payload accessed");}});
    for (const payload of [undefined,null,{},sentinel]) {
      expect(Reflect.apply(listener!, undefined, [sentinel,payload])).toEqual(refusal);
    }
  });
});
