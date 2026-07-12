/**
 * Real-git e2e for the /status, /diff, /commit grain (design slice-5.4-cut.md
 * §2.7/§6-e2e). This is the risk-center proof: an actual `git` binary runs
 * against a real repository on disk (the hermetic pattern of
 * checkpoints/shadow-git.test.ts:471), driven through the real REPL via runCli
 * — the only place NodeGitAdapter, the deps.git wiring in main.ts, the slash
 * handlers in commands.ts, and the readline confirm prompter are ever proven to
 * cooperate against a live repo.
 *
 * Scenarios (design §6-e2e):
 *   (a) edits -> /status branch+counts, /diff ±lines, /commit msg -> y -> sha;
 *       `git log` confirms the commit, its message, and the repo's own identity.
 *   (b) /commit -> n -> cancelled; the repo is byte-identical (no stage, no

 *   (c) a non-git tmpdir -> all three commands refuse (deps.git.enabled=false).
 *   (d) separation cross-check: a shadow-git checkpoint capture (isolated

 *
 * The model is never invoked (slash commands never reach it), so an inert model
 * port stands in. Each test uses the shadow-git.test.ts per-test timeout (30s)
 * to stay clear of the two known node-execution flakes.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./main.js";
import { NodeExecutionAdapter } from "../adapters/node/node-execution.js";
import { NodeFileSystemAdapter } from "../adapters/node/node-file-system.js";
import { SqlitePersistenceAdapter } from "../adapters/node/sqlite-persistence.js";
import { ShadowGitCheckpoints } from "../checkpoints/shadow-git.js";
import type { ModelPort, ModelRequest } from "../ports/index.js";
import type { ModelStreamEvent } from "../types/events.js";

const TEST_TIMEOUT_MS = 30_000;
const AUTHOR_NAME = "Slice 5.4 Tester";
const AUTHOR_EMAIL = "slice54@example.test";

/** Never invoked (slash commands never reach the model); present to satisfy runCli's port. */
class InertModelPort implements ModelPort {
  streamText(_request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    return (async function* () {
      yield { type: "finish", finishReason: "stop", usage: {} } as ModelStreamEvent;
    })();
  }
}

const tempDirs: string[] = [];

function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Runs a git command in `cwd` (test setup/verification only — the SUT uses NodeGitAdapter). */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

/**
 * Initializes a real repo on branch `main` with a per-repo identity (never
 * --global) and one seed commit of `seed.txt`. `git branch -M main` after the
 * commit pins the branch name deterministically across git default-branch
 * configs, so /status's header is assertable.
 */
function initRepoWithSeed(): string {
  const ws = freshDir("anycode-git-e2e-ws-");
  git(ws, "-c", "init.defaultBranch=main", "init", "-q");
  git(ws, "config", "user.name", AUTHOR_NAME);
  git(ws, "config", "user.email", AUTHOR_EMAIL);
  git(ws, "config", "commit.gpgsign", "false");
  writeFileSync(join(ws, "seed.txt"), "line one\n");
  git(ws, "add", "-A");
  git(ws, "commit", "-m", "seed");
  git(ws, "branch", "-M", "main");
  return ws;
}

// ANYCODE_SETTINGS_PATH sibling to dbPath's own tmpdir keeps the boot-seed read
// (design slice-P7.5-cut.md §3.2) off the owner's real ~/.anycode/settings.json.
function makeEnv(dbPath: string): NodeJS.ProcessEnv {
  return {
    ANYCODE_API_KEY: "test-key",
    ANYCODE_MODEL: "test-model",
    ANYCODE_DB_PATH: dbPath,
    ANYCODE_SETTINGS_PATH: join(dirname(dbPath), "settings.json"),
  } as NodeJS.ProcessEnv;
}

function collectOutput(output: PassThrough): () => string {
  let text = "";
  output.on("data", (chunk: Buffer) => {
    text += chunk.toString("utf8");
  });
  return () => text;
}

/** Resolves once `needle` has landed in the REPL output (never a blind write). */
async function waitForText(getText: () => string, needle: string): Promise<void> {
  await vi.waitFor(() => {
    if (!getText().includes(needle)) {
      throw new Error(`still waiting for ${JSON.stringify(needle)}`);
    }
  });
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("git-foundation e2e — /status, /diff, /commit on a real repo (design slice-5.4-cut.md §6)", () => {
  it(
    "(a) edits: /status shows branch+counts, /diff shows ±lines, /commit -> y writes a real commit with the repo's identity",
    async () => {
      const workspace = initRepoWithSeed();
      const dbDir = freshDir("anycode-git-e2e-db-");
      const dbPath = join(dbDir, "anycode.sqlite");

      // A tracked modification (unstaged) + an untracked file: (+0 ~1 ?1).
      writeFileSync(join(workspace, "seed.txt"), "line one changed\n");
      writeFileSync(join(workspace, "extra.txt"), "brand new\n");

      const input = new PassThrough();
      const output = new PassThrough();
      const getText = collectOutput(output);

      const runPromise = runCli({
        argv: [],
        env: makeEnv(dbPath),
        input,
        output,
        modelPort: new InertModelPort(),
        cwd: workspace,
        interactive: true,
      });

      input.write("/status\n");
      await waitForText(getText, "[git] on main (+0 ~1 ?1)");
      expect(getText()).toContain("unstaged:");
      expect(getText()).toContain("M seed.txt");
      expect(getText()).toContain("untracked:");
      expect(getText()).toContain("? extra.txt");

      input.write("/diff\n");
      await waitForText(getText, "diff --git");
      expect(getText()).toContain("line one changed");

      input.write("/commit slice 5.4 landed\n");
      // renderCommitSummary: staged 0 + unstaged 1 + untracked 1 = 2 files.
      await waitForText(getText, "commit 2 files on main?");
      input.write("y\n");
      await waitForText(getText, "[commit] ");

      // The success line: 8-hex sha + the pre-commit file count (2).
      const commitLine = getText().match(/\[commit\] ([0-9a-f]{8}) \(2 files\)/);
      expect(commitLine).not.toBeNull();

      input.write("/quit\n");
      const exitCode = await runPromise;
      expect(exitCode).toBe(0);

      // The repo now holds the new commit: message, identity, and a clean tree.
      expect(git(workspace, "rev-list", "--count", "HEAD").trim()).toBe("2");
      expect(git(workspace, "log", "-1", "--pretty=%s").trim()).toBe("slice 5.4 landed");
      expect(git(workspace, "log", "-1", "--pretty=%an").trim()).toBe(AUTHOR_NAME);
      expect(git(workspace, "log", "-1", "--pretty=%ae").trim()).toBe(AUTHOR_EMAIL);
      expect(git(workspace, "status", "--porcelain").trim()).toBe("");
      // The reported sha matches the actual HEAD (first 8 chars).
      const headSha = git(workspace, "rev-parse", "HEAD").trim();
      expect(headSha.startsWith(commitLine![1]!)).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "(b) /commit -> n cancels: the repo is byte-identical — nothing staged, nothing committed (hazard e)",
    async () => {
      const workspace = initRepoWithSeed();
      const dbDir = freshDir("anycode-git-e2e-db-");
      const dbPath = join(dbDir, "anycode.sqlite");

      writeFileSync(join(workspace, "seed.txt"), "line one changed\n");

      const headBefore = git(workspace, "rev-parse", "HEAD").trim();
      const statusBefore = git(workspace, "status", "--porcelain=v2", "--branch");

      const input = new PassThrough();
      const output = new PassThrough();
      const getText = collectOutput(output);

      const runPromise = runCli({
        argv: [],
        env: makeEnv(dbPath),
        input,
        output,
        modelPort: new InertModelPort(),
        cwd: workspace,
        interactive: true,
      });

      input.write("/commit should not happen\n");
      await waitForText(getText, "commit 1 file on main?");
      input.write("n\n");
      await waitForText(getText, "[commit] cancelled");

      input.write("/quit\n");
      expect(await runPromise).toBe(0);

      // No commit created (HEAD unmoved), nothing staged (index untouched), and
      // the whole porcelain snapshot is byte-identical to before /commit.
      expect(git(workspace, "rev-parse", "HEAD").trim()).toBe(headBefore);
      expect(git(workspace, "rev-list", "--count", "HEAD").trim()).toBe("1");
      expect(git(workspace, "diff", "--cached", "--name-only").trim()).toBe("");
      expect(git(workspace, "status", "--porcelain=v2", "--branch")).toBe(statusBefore);
      expect(readFileSync(join(workspace, "seed.txt"), "utf8")).toBe("line one changed\n");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "(c) a non-git workspace: /status, /diff, /commit all refuse (deps.git.enabled=false)",
    async () => {
      const workspace = freshDir("anycode-git-e2e-nogit-");
      const dbDir = freshDir("anycode-git-e2e-db-");
      const dbPath = join(dbDir, "anycode.sqlite");
      expect(existsSync(join(workspace, ".git"))).toBe(false);

      const input = new PassThrough();
      const output = new PassThrough();
      const getText = collectOutput(output);

      const runPromise = runCli({
        argv: [],
        env: makeEnv(dbPath),
        input,
        output,
        modelPort: new InertModelPort(),
        cwd: workspace,
        interactive: true,
      });

      input.write("/status\n");
      await waitForText(getText, "[status] not a git repository");
      input.write("/diff\n");
      await waitForText(getText, "[diff] not a git repository");
      input.write("/commit anything\n");
      await waitForText(getText, "[commit] not a git repository");

      input.write("/quit\n");
      expect(await runPromise).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "(d) separation: a shadow-git checkpoint capture never pollutes the user repo /status reads (hazard b)",
    async () => {
      const workspace = initRepoWithSeed();
      const checkpointsRoot = freshDir("anycode-git-e2e-cproot-");
      const dbDir = freshDir("anycode-git-e2e-db-");
      const dbPath = join(dbDir, "anycode.sqlite");

      // A user-repo change the checkpointer will snapshot into its ISOLATED store.
      writeFileSync(join(workspace, "seed.txt"), "line one changed\n");
      writeFileSync(join(workspace, "extra.txt"), "brand new\n");

      const exec = new NodeExecutionAdapter();
      const fsPort = new NodeFileSystemAdapter();
      const store = new SqlitePersistenceAdapter(":memory:");
      try {
        await store.createSession({ id: "s1", workspace, model: "m", mode: "build" });
        const svc = new ShadowGitCheckpoints({
          exec,
          fs: fsPort,
          store,
          workspace,
          checkpointsRoot,
          sessionId: "s1",
        });
        const cp = await svc.capture({ userInput: "a turn", historySnapshot: [] });
        expect(cp.kind).toBe("created");
      } finally {
        await store.close();
      }

      // The checkpointer wrote to its isolated GIT_DIR under checkpointsRoot; the
      // user repo is pristine — still one commit, and its status shows ONLY the
      // real user changes (no checkpoint refs/commits leaked in).
      expect(git(workspace, "rev-list", "--count", "HEAD").trim()).toBe("1");

      const input = new PassThrough();
      const output = new PassThrough();
      const getText = collectOutput(output);

      const runPromise = runCli({
        argv: [],
        env: makeEnv(dbPath),
        input,
        output,
        modelPort: new InertModelPort(),
        cwd: workspace,
        interactive: true,
      });

      input.write("/status\n");
      // /status reads the USER repo: the shadow checkpoint is invisible to it.
      await waitForText(getText, "[git] on main (+0 ~1 ?1)");
      expect(getText()).toContain("M seed.txt");
      expect(getText()).toContain("? extra.txt");

      input.write("/quit\n");
      expect(await runPromise).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );
});
